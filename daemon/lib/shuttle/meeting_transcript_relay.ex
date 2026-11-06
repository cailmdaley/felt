defmodule Shuttle.Meeting.TranscriptRelay do
  @moduledoc "Durable transcript monitors for joined meetings, claimed captures and live voice."
  use Supervisor

  def start_link(opts \\ []) do
    server = Keyword.get(opts, :name, __MODULE__)
    Supervisor.start_link(__MODULE__, opts, name: Module.concat(server, Supervisor))
  end

  def start(row, fiber_id, origin, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(Module.concat(server, Coordinator), {:start, row, fiber_id, origin})
  end

  def targets_changed do
    GenServer.cast(Module.concat(__MODULE__, Coordinator), :targets_changed)
  end

  def status(launch, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(Module.concat(server, Coordinator), {:status, launch})
  end

  @impl true
  def init(opts) do
    server = Keyword.get(opts, :name, __MODULE__)

    children = [
      {DynamicSupervisor, strategy: :one_for_one, name: Module.concat(server, DynamicSupervisor)},
      {Shuttle.Meeting.TranscriptRelay.Coordinator,
       Keyword.merge(opts,
         name: Module.concat(server, Coordinator),
         directory:
           Keyword.get(
             opts,
             :directory,
             Path.join(Shuttle.data_dir(), "meeting-transcript-relays")
           ),
         dynamic: Module.concat(server, DynamicSupervisor)
       )}
    ]

    Supervisor.init(children, strategy: :one_for_all)
  end
end

defmodule Shuttle.Meeting.TranscriptRelay.Coordinator do
  @moduledoc false
  use GenServer

  def start_link(opts),
    do: GenServer.start_link(__MODULE__, opts, name: Keyword.fetch!(opts, :name))

  @impl true
  def init(opts) do
    Process.flag(:trap_exit, true)

    state = %{
      directory: Keyword.fetch!(opts, :directory),
      dynamic: Keyword.fetch!(opts, :dynamic),
      options: opts,
      workers: %{},
      deliver: Keyword.get(opts, :deliver, &Shuttle.Meeting.TranscriptRelay.Worker.deliver/1),
      lanes: %{},
      deliveries: %{}
    }

    {:ok, state, {:continue, :recover}}
  end

  @impl true
  def handle_continue(:recover, state) do
    files =
      case Shuttle.FS.ls(state.directory) do
        {:ok, files} -> files
        _ -> []
      end

    configs =
      for file <- files,
          String.ends_with?(file, ".json"),
          {:ok, bytes} <- [Shuttle.FS.read(Path.join(state.directory, file))],
          {:ok, %{"launch" => _} = config} <- [Jason.decode(bytes)],
          config["completed"] != true,
          do: config

    configs = Enum.sort_by(configs, &(&1["created_at"] || ""))

    # Reserve recovered batches before any worker can submit a new one.
    # Hash filenames and process scheduling don't define conversation order.
    state = Enum.reduce(configs, state, &reserve_batches/2)
    state = Enum.reduce(configs, state, fn config, acc -> elem(start_worker(acc, config), 1) end)

    {:noreply, state}
  end

  @impl true
  def handle_call({:start, row, fiber_id, origin}, _from, state) do
    transcript = value(row, :transcript)

    config = %{
      "launch" => value(row, :launch),
      "fiber_id" => fiber_id,
      "origin" => origin,
      "transcript" => transcript,
      "kind" => value(row, :kind) || "meeting",
      "title" => value(row, :title) || Path.basename(transcript || "meeting.txt", ".txt"),
      "created_at" => DateTime.to_iso8601(DateTime.utc_now()),
      "routes_path" => value(row, :routes_path),
      "offset" => 0,
      "json_offset" => 0,
      "route_offset" => 0,
      "routes" => [],
      "buffers" => [],
      "outbox" => [],
      "ended" => false
    }

    if Enum.all?([config["launch"], transcript], &(is_binary(&1) and &1 != "")) do
      {reply, state} = start_worker(state, config)
      {:reply, if(match?({:ok, _}, reply), do: :ok, else: reply), state}
    else
      {:reply, {:error, :invalid_meeting}, state}
    end
  end

  def handle_call({:status, launch}, _from, state) do
    status =
      case state.workers[launch] do
        {pid, _ref} ->
          try do
            GenServer.call(pid, :status)
          catch
            :exit, _ -> %{pending: nil, last: nil}
          end

        nil ->
          %{pending: nil, last: nil}
      end

    {:reply, status, state}
  end

  def handle_call({:deliver, message}, from, state) do
    key = {message.fiber_id, message.origin}
    queue = Map.get(state.lanes, key, [])

    queue =
      if Enum.any?(queue, fn {_, queued} -> queued.message_id == message.message_id end),
        do:
          Enum.map(queue, fn {owner, queued} ->
            if queued.message_id == message.message_id, do: {from, message}, else: {owner, queued}
          end),
        else: queue ++ [{from, message}]

    state = put_in(state.lanes[key], queue)
    busy = Enum.any?(state.deliveries, fn {_, {target, _}} -> target == key end)
    {:noreply, if(busy, do: state, else: launch_delivery(state, key))}
  end

  @impl true
  def handle_cast(:targets_changed, state) do
    Enum.each(state.workers, fn {_launch, {pid, _ref}} -> send(pid, :poll) end)
    {:noreply, state}
  end

  @impl true
  def handle_info({ref, result}, state) when is_reference(ref) do
    Process.demonitor(ref, [:flush])
    {:noreply, finish_delivery(state, ref, result)}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, state) do
    if Map.has_key?(state.deliveries, ref) do
      {:noreply,
       finish_delivery(state, ref, {503, %{error: "delivery task exited: #{inspect(reason)}"}})}
    else
      {:noreply,
       %{state | workers: Map.reject(state.workers, fn {_, {_, monitor}} -> monitor == ref end)}}
    end
  end

  def handle_info({:worker_started, launch, pid}, state) do
    case state.workers[launch] do
      {_, ref} -> Process.demonitor(ref, [:flush])
      nil -> :ok
    end

    {:noreply, put_in(state.workers[launch], {pid, Process.monitor(pid)})}
  end

  @impl true
  def terminate(_reason, state) do
    Enum.each(state.deliveries, fn {_ref, {_key, task}} -> Task.shutdown(task, :brutal_kill) end)
  end

  defp reserve_batches(config, state) do
    Enum.reduce(config["outbox"] || [], state, fn batch, acc ->
      message = Map.new(~w(fiber_id origin text message_id)a, &{&1, batch[Atom.to_string(&1)]})
      key = {message.fiber_id, message.origin}

      Map.update!(
        acc,
        :lanes,
        &Map.update(&1, key, [{nil, message}], fn lane -> lane ++ [{nil, message}] end)
      )
    end)
  end

  defp launch_delivery(state, key) do
    case state.lanes[key] do
      [{nil, _message} | _] ->
        state

      [{_from, message} | _] ->
        deliver = state.deliver
        task = Task.Supervisor.async_nolink(Shuttle.TaskSupervisor, fn -> deliver.(message) end)
        put_in(state.deliveries[task.ref], {key, task})
    end
  end

  defp finish_delivery(state, ref, result) do
    case Map.pop(state.deliveries, ref) do
      {nil, _} ->
        state

      {{key, _task}, deliveries} ->
        [{from, _} | rest] = state.lanes[key]
        GenServer.reply(from, result)
        state = %{state | deliveries: deliveries, lanes: Map.delete(state.lanes, key)}
        if rest == [], do: state, else: launch_delivery(put_in(state.lanes[key], rest), key)
    end
  end

  defp start_worker(state, config) do
    launch = config["launch"]

    case state.workers[launch] do
      {pid, _} ->
        {{:ok, pid}, state}

      nil ->
        digest = :crypto.hash(:sha256, launch) |> Base.encode16(case: :lower)
        path = Path.join(state.directory, digest <> ".json")

        with :ok <- Shuttle.FS.mkdir_p(state.directory),
             :ok <- ensure_config(path, config),
             false <- completed?(path),
             opts <- Keyword.merge(state.options, file: path, coordinator: self()),
             {:ok, pid} <-
               DynamicSupervisor.start_child(
                 state.dynamic,
                 {Shuttle.Meeting.TranscriptRelay.Worker, opts}
               ) do
          {{:ok, pid}, put_in(state.workers[launch], {pid, Process.monitor(pid)})}
        else
          true -> {{:ok, :completed}, state}
          {:error, reason} -> {{:error, reason}, state}
        end
    end
  end

  defp completed?(path) do
    with {:ok, bytes} <- Shuttle.FS.read(path),
         {:ok, %{"completed" => true}} <- Jason.decode(bytes),
         do: true,
         else: (_ -> false)
  end

  defp ensure_config(path, config) do
    if Shuttle.FS.exists?(path),
      do: :ok,
      else: Shuttle.FS.write_atomic(path, Jason.encode!(config) <> "\n")
  end

  defp value(row, key), do: Map.get(row, key) || Map.get(row, Atom.to_string(key))
end

defmodule Shuttle.Meeting.TranscriptRelay.Worker do
  @moduledoc false
  use GenServer
  alias Shuttle.FileTail

  @names ~r/\b(?:claude|cloud|clawed|klaud)\b/iu
  @stamp ~r/^\d{2}:\d{2}:\d{2}(?:-\d{2}:\d{2}:\d{2})?\s+/

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts)

  def child_spec(opts),
    do: %{
      id: {__MODULE__, Keyword.fetch!(opts, :file)},
      start: {__MODULE__, :start_link, [opts]},
      restart: :transient
    }

  @impl true
  def init(opts) do
    Process.flag(:trap_exit, true)
    file = Keyword.fetch!(opts, :file)
    {:ok, bytes} = Shuttle.FS.read(file)
    config = Jason.decode!(bytes) |> normalize()

    state = %{
      file: file,
      config: config,
      poll_ms: Keyword.get(opts, :poll_ms, 1_000),
      deliver: fn message ->
        GenServer.call(Keyword.fetch!(opts, :coordinator), {:deliver, message}, :infinity)
      end,
      observe:
        Keyword.get(
          opts,
          :observe,
          if(config["kind"] == "voice",
            do: &Shuttle.Meeting.voice_capture/0,
            else: &Shuttle.Meeting.show/0
          )
        ),
      thresholds: Keyword.get(opts, :thresholds, &Shuttle.Voice.Config.thresholds/1),
      claim: Keyword.get(opts, :claim, &claim/1),
      clock: Keyword.get(opts, :clock, fn -> System.system_time(:millisecond) end),
      tasks: %{},
      task_handles: %{},
      timer: nil
    }

    send(Keyword.fetch!(opts, :coordinator), {:worker_started, config["launch"], self()})
    send(self(), :poll)
    {:ok, state}
  end

  @impl true
  def handle_call(:status, _from, state) do
    buffer = List.first(state.config["buffers"])

    pending =
      if buffer,
        do: %{
          fiber_id: buffer["fiber_id"],
          words: buffer["words"],
          text: Enum.join(buffer["lines"], "\n")
        }

    {:reply, %{pending: pending, last: state.config["last"]}, state}
  end

  @impl true
  def handle_info(:poll, state) do
    if state.timer, do: Process.cancel_timer(state.timer)
    config = state.config
    next = config |> claim_target(state) |> read_routes() |> ingest(state) |> flush_due(state)
    state = persist!(%{state | config: next}) |> launch_deliveries()

    if state.config["ended"] and state.config["outbox"] == [] and map_size(state.tasks) == 0 do
      :ok =
        Shuttle.FS.write_atomic(
          state.file,
          Jason.encode!(%{"launch" => state.config["launch"], "completed" => true}) <> "\n"
        )

      {:stop, :normal, state}
    else
      timer = Process.send_after(self(), :poll, state.poll_ms)
      {:noreply, %{state | timer: timer}}
    end
  end

  def handle_info({ref, result}, state) when is_reference(ref) do
    Process.demonitor(ref, [:flush])
    {:noreply, complete(state, ref, result)}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, state) do
    {:noreply, complete(state, ref, {503, %{error: "delivery task exited: #{inspect(reason)}"}})}
  end

  @impl true
  def terminate(_reason, state) do
    Enum.each(state.task_handles, fn {_, task} -> Task.shutdown(task, :brutal_kill) end)
  end

  defp normalize(config) do
    defaults = %{
      "kind" => "meeting",
      "json_offset" => 0,
      "route_offset" => 0,
      "routes" => [],
      "buffers" => [],
      "outbox" => [],
      "ended" => false
    }

    config = Map.merge(defaults, config)
    # An in-flight meeting message keeps its original identity across recovery.
    case Map.pop(config, "pending") do
      {nil, config} ->
        config

      {pending, config} ->
        batch = Map.merge(pending, Map.take(config, ~w(fiber_id origin)))

        config
        |> Map.put("offset", pending["offset"])
        |> Map.put("outbox", [batch])
        |> Map.put("ended", pending["ended"])
    end
  end

  defp claim_target(
         %{"kind" => "meeting", "fiber_id" => nil, "launch" => expected} = config,
         state
       ) do
    case state.claim.(expected) do
      {fiber, origin} -> config |> Map.put("fiber_id", fiber) |> Map.put("origin", origin)
      nil -> config
    end
  end

  defp claim_target(config, _state), do: config

  def claim(launch) do
    fibers = Shuttle.Env.app(:meeting_fibers, &Shuttle.Meeting.served_fibers/0)

    Enum.find_value(fibers.(), fn fiber ->
      if get_in(fiber, ["shuttle", "runtime", "meeting"]) == launch,
        do: {fiber["uid"] || fiber["id"], get_in(fiber, ["shuttle", "host"])}
    end)
  end

  defp read_routes(%{"kind" => "voice", "routes_path" => path} = config) do
    case FileTail.advance(path, config["route_offset"]) do
      {:append, lines, offset} ->
        routes = config["routes"] ++ Enum.map(lines, &Jason.decode!/1)
        current = List.last(routes)

        config
        |> Map.put("routes", routes)
        |> Map.put("route_offset", offset)
        |> flush_other_targets(current)

      _ ->
        config
    end
  end

  defp read_routes(config), do: config

  defp flush_other_targets(config, target) do
    Enum.reduce(config["buffers"], config, fn buffer, acc ->
      if same_target?(buffer, target), do: acc, else: flush_buffer(acc, buffer)
    end)
  end

  defp ingest(%{"kind" => "meeting", "fiber_id" => nil} = config, _state), do: config
  defp ingest(%{"ended" => true} = config, _state), do: config

  defp ingest(config, state) do
    config = if config["kind"] == "voice", do: ingest_voice(config, state), else: config

    ingest_text(config, state)
  end

  defp json_pending?(%{"kind" => "voice"} = config) do
    case Shuttle.FS.stat(Path.rootname(config["transcript"]) <> ".jsonl") do
      {:ok, %{size: size}} -> size > config["json_offset"]
      _ -> false
    end
  end

  defp json_pending?(_config), do: false

  defp ingest_text(config, state) do
    case FileTail.advance(config["transcript"], config["offset"], max_bytes: 65_536) do
      {:append, lines, offset} ->
        config =
          Enum.reduce(lines, config, fn line, acc ->
            cond do
              acc["ended"] ->
                acc

              acc["kind"] != "voice" ->
                add_line(acc, acc, line, state)

              String.starts_with?(line, "# ended") ->
                Map.put(acc, "end_seen", line)

              String.starts_with?(line, "#") ->
                add_line(acc, List.last(acc["routes"]), line, state)

              true ->
                acc
            end
          end)

        Map.put(config, "offset", offset)

      {:reset, _} ->
        end_capture(config, "transcript file was replaced", state)

      :noop ->
        maybe_end(config, state)
    end
  end

  defp ingest_voice(config, state) do
    path = Path.rootname(config["transcript"]) <> ".jsonl"

    case FileTail.advance(path, config["json_offset"], max_bytes: 65_536) do
      {:append, lines, offset} ->
        next =
          Enum.reduce(lines, config, fn line, acc ->
            case Jason.decode(line) do
              {:ok, %{"wall" => wall, "text" => text, "speaker" => speaker} = row} ->
                case DateTime.from_iso8601(row["wall_start"] || wall) do
                  {:ok, at, _} ->
                    target =
                      Enum.find(
                        Enum.reverse(acc["routes"]),
                        &(DateTime.compare(at, parse_time!(&1["t"])) != :lt)
                      )

                    add_line(acc, target, "#{row["name"] || speaker} #{text}", state)

                  _ ->
                    Map.put(
                      acc,
                      "error",
                      "voice utterance needs an absolute wall_start timestamp: #{wall}"
                    )
                end

              _ ->
                acc
            end
          end)

        Map.put(next, "json_offset", offset)

      _ ->
        config
    end
  end

  defp parse_time!(value), do: elem(DateTime.from_iso8601(value), 1)

  defp add_line(config, nil, line, _state),
    do: if(String.starts_with?(line, "# ended"), do: Map.put(config, "ended", true), else: config)

  defp add_line(config, target, line, state) do
    target = Map.take(target, ~w(fiber_id origin))

    buffer =
      Enum.find(config["buffers"], &same_target?(&1, target)) ||
        Map.merge(target, %{"lines" => [], "words" => 0, "last_word_at" => nil})

    spoken = if String.starts_with?(line, "#"), do: "", else: Regex.replace(@stamp, line, "")
    words = length(String.split(spoken))

    buffer =
      buffer |> Map.update!("lines", &(&1 ++ [line])) |> Map.update!("words", &(&1 + words))

    buffer = if words > 0, do: Map.put(buffer, "last_word_at", state.clock.()), else: buffer

    config =
      Map.put(
        config,
        "buffers",
        Enum.reject(config["buffers"], &same_target?(&1, target)) ++ [buffer]
      )

    threshold = state.thresholds.(config["kind"])

    cond do
      String.starts_with?(line, "# ended") ->
        config |> Map.put("ended", true) |> flush_all()

      buffer["words"] >= threshold["words"] or Regex.match?(@names, spoken) ->
        flush_buffer(config, buffer)

      config["kind"] == "voice" and not same_target?(target, List.last(config["routes"])) ->
        flush_buffer(config, buffer)

      true ->
        config
    end
  end

  defp flush_due(config, state) do
    quiet = state.thresholds.(config["kind"])["quiet_seconds"] * 1_000

    Enum.reduce(config["buffers"], config, fn buffer, acc ->
      if buffer["last_word_at"] && state.clock.() - buffer["last_word_at"] >= quiet,
        do: flush_buffer(acc, buffer),
        else: acc
    end)
  end

  defp flush_all(config), do: Enum.reduce(config["buffers"], config, &flush_buffer(&2, &1))

  defp flush_buffer(config, buffer) do
    lines = buffer["lines"]

    header =
      if config["kind"] == "voice" do
        "Live voice:\n"
      else
        "Meeting transcript update (#{config["title"]}):\n"
      end

    id =
      :crypto.hash(
        :sha256,
        "#{config["launch"]}:#{Jason.encode!(buffer)}:#{config["sequence"] || 0}"
      )
      |> Base.url_encode64(padding: false)

    batch =
      buffer
      |> Map.take(~w(fiber_id origin))
      |> Map.merge(%{
        "text" => header <> Enum.join(lines, "\n") <> "\n",
        "message_id" => "meeting-" <> id
      })

    config
    |> Map.put("buffers", Enum.reject(config["buffers"], &same_target?(&1, buffer)))
    |> Map.update!("outbox", &(&1 ++ [batch]))
    |> Map.put("sequence", (config["sequence"] || 0) + 1)
  end

  defp same_target?(nil, _), do: false
  defp same_target?(_, nil), do: false
  defp same_target?(a, b), do: a["fiber_id"] == b["fiber_id"] and a["origin"] == b["origin"]

  defp maybe_end(config, state) do
    case state.observe.() do
      {:ok, %{meeting: %{launch: launch, state: phase, error: error}}} ->
        cond do
          launch != config["launch"] ->
            end_capture(config, "capture was replaced before completion", state)

          phase in ["failed", "ended"] ->
            end_capture(config, "capture #{phase}: #{error}", state)

          true ->
            config
        end

      {:ok, %{meeting: nil}} ->
        end_capture(config, "capture ended", state)

      _ ->
        config
    end
  end

  defp end_capture(config, reason, state) do
    # After observing the recorder's exit, drain once more: its last JSON row
    # may have landed between this tick's JSON read and the text footer.
    drained = if config["kind"] == "voice", do: ingest_voice(config, state), else: config
    target = if config["kind"] == "voice", do: List.last(config["routes"]), else: config

    cond do
      json_pending?(drained) and drained["json_offset"] > config["json_offset"] ->
        drained

      json_pending?(drained) ->
        # The recorder is gone and no complete row remains. Keep the broken
        # suffix on disk, but don't wait for a newline that cannot arrive.
        drained
        |> add_line(target, "# incomplete final voice JSON row retained in transcript", state)
        |> add_line(target, drained["end_seen"] || "# ended (#{reason})", state)

      true ->
        add_line(drained, target, drained["end_seen"] || "# ended (#{reason})", state)
    end
  end

  defp launch_deliveries(state) do
    busy = Map.values(state.tasks)

    candidates =
      if state.config["kind"] == "voice",
        do: Enum.uniq_by(state.config["outbox"], &{&1["fiber_id"], &1["origin"]}),
        else: Enum.take(state.config["outbox"], 1)

    Enum.reduce(candidates, state, fn batch, acc ->
      if batch["message_id"] in busy do
        acc
      else
        deliver = state.deliver

        task =
          Task.Supervisor.async_nolink(Shuttle.TaskSupervisor, fn ->
            deliver.(%{
              fiber_id: batch["fiber_id"],
              origin: batch["origin"],
              text: batch["text"],
              message_id: batch["message_id"]
            })
          end)

        %{
          acc
          | tasks: Map.put(acc.tasks, task.ref, batch["message_id"]),
            task_handles: Map.put(acc.task_handles, task.ref, task)
        }
      end
    end)
  end

  defp complete(state, ref, result) do
    case Map.pop(state.tasks, ref) do
      {nil, _} ->
        state

      {id, tasks} ->
        batch = Enum.find(state.config["outbox"], &(&1["message_id"] == id))

        delivered =
          case result do
            {status, outcome} when status in 200..299 ->
              outcome[:delivered] == true or outcome["delivered"] == true

            _ ->
              false
          end

        config =
          if delivered or state.config["kind"] == "voice" do
            last = %{
              "fiber_id" => batch["fiber_id"],
              "at" => DateTime.to_iso8601(DateTime.utc_now()),
              "status" => if(delivered, do: "delivered", else: "failed")
            }

            last = if delivered, do: last, else: Map.put(last, "detail", inspect(result))

            if state.config["kind"] == "voice" do
              :ok = Shuttle.FS.mkdir_p(Shuttle.data_dir())
              :ok = Shuttle.FS.write_atomic(Shuttle.Voice.last_path(), Jason.encode!(last))
            end

            state.config
            |> Map.put("outbox", Enum.reject(state.config["outbox"], &(&1["message_id"] == id)))
            |> Map.put("last", last)
          else
            state.config
          end

        persist!(%{
          state
          | config: config,
            tasks: tasks,
            task_handles: Map.delete(state.task_handles, ref)
        })
    end
  end

  defp persist!(state) do
    :ok = Shuttle.FS.write_atomic(state.file, Jason.encode!(state.config) <> "\n")
    state
  end

  def deliver(%{fiber_id: fiber_id, text: text, origin: origin, message_id: id}) do
    ShuttleWeb.DeliverController.route(fiber_id, text, origin, "shuttle", %{
      "daemon_sender" => true,
      "message_id" => id,
      "message_after_launch" => true
    })
  end
end
