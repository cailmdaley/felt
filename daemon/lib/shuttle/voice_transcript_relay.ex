defmodule Shuttle.Voice.TranscriptRelay do
  @moduledoc "Durable live-voice ingestion, routing and at-most-once delivery."
  use Supervisor

  def start_link(opts \\ []) do
    server = Keyword.get(opts, :name, __MODULE__)
    Supervisor.start_link(__MODULE__, opts, name: Module.concat(server, Supervisor))
  end

  def start(row, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    GenServer.call(Module.concat(server, Coordinator), {:start, row})
  catch
    :exit, reason -> {:error, reason}
  end

  def targets_changed do
    GenServer.cast(Module.concat(__MODULE__, Coordinator), :targets_changed)
  end

  def status(launch, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)
    timeout = Keyword.get(opts, :timeout, 5_000)

    case GenServer.call(Module.concat(server, Coordinator), {:status, launch}, timeout) do
      {:worker, pid} -> GenServer.call(pid, :status, timeout)
      {:status, status} -> status
    end
  catch
    :exit, {:timeout, _} -> :timeout
    :exit, _ -> %{pending: nil, pending_words: 0, last: nil, error: "relay unavailable"}
  end

  @doc """
  Drops the words `launch`'s relay holds but has not sent, returning how many.
  Batches already in the outbox still go; the transcript on disk keeps every
  word. In live voice the utterance in progress is dropped too: rows that began
  before the discard never enter a buffer.
  """
  def discard(launch, opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)

    case GenServer.call(Module.concat(server, Coordinator), {:status, launch}) do
      {:worker, pid} -> GenServer.call(pid, :discard)
      {:status, _} -> {:ok, 0}
    end
  catch
    :exit, reason -> {:error, reason}
  end

  @impl true
  def init(opts) do
    server = Keyword.get(opts, :name, __MODULE__)

    children = [
      {DynamicSupervisor, strategy: :one_for_one, name: Module.concat(server, DynamicSupervisor)},
      {Shuttle.Voice.TranscriptRelay.Coordinator,
       Keyword.merge(opts,
         name: Module.concat(server, Coordinator),
         directory:
           Keyword.get(
             opts,
             :directory,
             Path.join(Shuttle.data_dir(), "voice-transcript-relays")
           ),
         dynamic: Module.concat(server, DynamicSupervisor)
       )}
    ]

    Supervisor.init(children, strategy: :one_for_all)
  end
end

defmodule Shuttle.Voice.TranscriptRelay.Coordinator do
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
      errors: %{},
      deliver: Keyword.get(opts, :deliver, &Shuttle.Voice.TranscriptRelay.Worker.deliver/1),
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

    {configs, errors} =
      Enum.reduce(files, {[], %{}}, fn file, {configs, errors} ->
        if String.ends_with?(file, ".json") do
          case Shuttle.Voice.TranscriptRelay.Worker.load(Path.join(state.directory, file)) do
            {:ok, %{"completed" => true}} -> {configs, errors}
            {:ok, config} -> {[config | configs], errors}
            {:error, reason} -> {configs, Map.put(errors, Path.rootname(file), inspect(reason))}
          end
        else
          {configs, errors}
        end
      end)

    state = %{state | errors: errors}
    configs = Enum.sort_by(configs, &(&1["created_at"] || ""))

    # Reserve recovered batches before any worker can submit a new one.
    # Hash filenames and process scheduling don't define conversation order.
    state = Enum.reduce(configs, state, &reserve_batches/2)

    state =
      Enum.reduce(configs, state, fn config, acc ->
        case start_worker(acc, config) do
          {{:error, _}, acc} -> release_reservations(acc, config["outbox"])
          {_, acc} -> acc
        end
      end)

    {:noreply, state}
  end

  @impl true
  def handle_call({:start, row}, _from, state) do
    transcript = value(row, :transcript)

    config = %{
      "launch" => value(row, :launch),
      "transcript" => transcript,
      "created_at" => DateTime.to_iso8601(DateTime.utc_now()),
      "routes_path" => value(row, :routes_path),
      "started_at" => value(row, :started_at),
      "offset" => 0,
      "json_offset" => 0,
      "route_offset" => 0,
      "routes" => [],
      "buffers" => [],
      "outbox" => [],
      "ended" => false
    }

    cond do
      not Enum.all?([config["launch"], transcript], &(is_binary(&1) and &1 != "")) ->
        {:reply, {:error, :invalid_recording}, state}

      not valid_start?(config["started_at"]) ->
        {reply, state} = start_error(state, config["launch"], :capture_start_required)
        {:reply, reply, state}

      true ->
        {reply, state} = start_worker(state, config)
        {:reply, if(match?({:ok, _}, reply), do: :ok, else: reply), state}
    end
  end

  def handle_call({:status, launch}, _from, state) do
    reply =
      case state.workers[launch] do
        {pid, _ref} ->
          {:worker, pid}

        nil ->
          {:status,
           %{pending: nil, pending_words: 0, last: nil, error: state.errors[digest(launch)]}}
      end

    {:reply, reply, state}
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
  def handle_info({:EXIT, _source, _reason}, state), do: {:noreply, state}

  def handle_info({ref, result}, state) when is_reference(ref) do
    Process.demonitor(ref, [:flush])
    {:noreply, finish_delivery(state, ref, result)}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, state) do
    if Map.has_key?(state.deliveries, ref) do
      {:noreply, finish_delivery(state, ref, {:task_exit, reason})}
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

  def handle_info({:relay_error, outbox}, state) do
    {:noreply, release_reservations(state, outbox)}
  end

  @impl true
  def terminate(_reason, state) do
    Enum.each(state.deliveries, fn {_ref, {_key, task}} -> Task.shutdown(task, :brutal_kill) end)
  end

  # A quarantined relay keeps its durable outbox, but cannot hold a lane
  # with a reservation it will never attach a delivery request to.
  defp release_reservations(state, outbox) do
    ids = MapSet.new(outbox, & &1["message_id"])

    Enum.reduce(state.lanes, state, fn {key, lane}, acc ->
      remaining =
        Enum.reject(lane, fn {owner, message} ->
          is_nil(owner) and MapSet.member?(ids, message.message_id)
        end)

      cond do
        remaining == [] ->
          %{acc | lanes: Map.delete(acc.lanes, key)}

        remaining == lane ->
          acc

        true ->
          acc = put_in(acc.lanes[key], remaining)
          busy = Enum.any?(acc.deliveries, fn {_, {target, _}} -> target == key end)
          if busy, do: acc, else: launch_delivery(acc, key)
      end
    end)
  end

  defp reserve_batches(config, state) do
    Enum.reduce(config["outbox"] || [], state, fn batch, acc ->
      if batch["attempted"] do
        acc
      else
        message = Map.new(~w(fiber_id origin text message_id)a, &{&1, batch[Atom.to_string(&1)]})
        key = {message.fiber_id, message.origin}

        Map.update!(
          acc,
          :lanes,
          &Map.update(&1, key, [{nil, message}], fn lane -> lane ++ [{nil, message}] end)
        )
      end
    end)
  end

  defp launch_delivery(state, key) do
    case state.lanes[key] do
      [{nil, _message} | _] ->
        state

      [{_from, message} | _] ->
        deliver = state.deliver

        task =
          Task.Supervisor.async_nolink(Shuttle.TaskSupervisor, fn ->
            if String.trim(message.text) == "",
              do: {200, %{delivered: true}},
              else: deliver.(message)
          end)

        put_in(state.deliveries[task.ref], {key, task})
    end
  end

  defp finish_delivery(state, ref, result) do
    case Map.pop(state.deliveries, ref) do
      {nil, _} ->
        state

      {{key, _task}, deliveries} ->
        [{from, _message} | rest] = state.lanes[key]
        GenServer.reply(from, result)
        state = %{state | deliveries: deliveries, lanes: Map.delete(state.lanes, key)}
        if rest == [], do: state, else: launch_delivery(put_in(state.lanes[key], rest), key)
    end
  end

  defp start_worker(state, config) do
    do_start_worker(state, config)
  rescue
    error -> start_error(state, config["launch"], Exception.message(error))
  catch
    :exit, reason -> start_error(state, config["launch"], reason)
  end

  defp start_error(state, launch, reason),
    do: {{:error, reason}, put_in(state.errors[digest(launch)], inspect(reason))}

  defp do_start_worker(state, config) do
    launch = config["launch"]

    case state.workers[launch] do
      {pid, _} ->
        {{:ok, pid}, state}

      nil ->
        path = Path.join(state.directory, digest(launch) <> ".json")

        with :ok <- Shuttle.FS.mkdir_p(state.directory),
             :ok <- ensure_config(path, config),
             {:ok, saved} <- Shuttle.Voice.TranscriptRelay.Worker.load(path),
             false <- saved["completed"] == true,
             opts <- Keyword.merge(state.options, file: path, coordinator: self()),
             {:ok, pid} <-
               DynamicSupervisor.start_child(
                 state.dynamic,
                 {Shuttle.Voice.TranscriptRelay.Worker, opts}
               ) do
          state = %{state | errors: Map.delete(state.errors, digest(launch))}
          {{:ok, pid}, put_in(state.workers[launch], {pid, Process.monitor(pid)})}
        else
          true ->
            {{:ok, :completed}, %{state | errors: Map.delete(state.errors, digest(launch))}}

          {:error, reason} ->
            start_error(state, launch, reason)
        end
    end
  end

  defp digest(launch), do: :crypto.hash(:sha256, launch) |> Base.encode16(case: :lower)

  defp ensure_config(path, config) do
    if Shuttle.FS.exists?(path),
      do: :ok,
      else: Shuttle.FS.write_atomic(path, Jason.encode!(config) <> "\n")
  end

  defp valid_start?(value) when is_binary(value),
    do: match?({:ok, _, _}, DateTime.from_iso8601(value))

  defp valid_start?(_), do: false

  defp value(row, key) when is_map(row),
    do: Map.get(row, key) || Map.get(row, Atom.to_string(key))

  defp value(_, _), do: nil
end

defmodule Shuttle.Voice.TranscriptRelay.Worker do
  @moduledoc false
  use GenServer
  alias Shuttle.FileTail

  @closing ~r/[\s,;:]*\bsend[.!?]*\s*$/iu
  @partial_stale_seconds 60

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
    {:ok, config} = load(file)

    state = %{
      file: file,
      config: config,
      persisted: config,
      error: nil,
      coordinator: Keyword.fetch!(opts, :coordinator),
      poll_ms: Keyword.get(opts, :poll_ms, 250),
      deliver: fn message ->
        GenServer.call(Keyword.fetch!(opts, :coordinator), {:deliver, message}, :infinity)
      end,
      observe: Keyword.get(opts, :observe, &Shuttle.Recorder.show/0),
      thresholds: Keyword.get(opts, :thresholds, &Shuttle.Voice.Config.thresholds/0),
      follow:
        Keyword.get(opts, :follow, fn ->
          case Shuttle.Voice.Config.read() do
            {:ok, config} -> config["follow"]
            _ -> true
          end
        end),
      cold: Keyword.get(opts, :cold, &Shuttle.Voice.cold?/1),
      clock: Keyword.get(opts, :clock, fn -> System.system_time(:millisecond) end),
      tasks: %{},
      task_handles: %{},
      timer: nil
    }

    state = recover_attempted(state)
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

    {:reply,
     %{
       pending: pending,
       pending_words: pending_words(state.config),
       last: state.config["last"],
       error: state.error
     }, state}
  end

  def handle_call(:discard, _from, state) do
    words = pending_words(state.config)

    config =
      state.config
      |> Map.put("buffers", [])
      |> Map.put("discarded_at", DateTime.to_iso8601(DateTime.utc_now()))

    {:reply, {:ok, words}, persist!(%{state | config: config})}
  end

  @impl true
  def handle_info(:poll, %{error: error} = state) when not is_nil(error),
    do: {:noreply, state}

  def handle_info(:poll, state) do
    protect(state, fn -> poll(state) end)
  end

  def handle_info({:EXIT, _source, _reason}, state), do: {:noreply, state}

  def handle_info({ref, result}, state) when is_reference(ref) do
    Process.demonitor(ref, [:flush])
    protect(state, fn -> {:noreply, complete(state, ref, result)} end)
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, state) do
    protect(state, fn ->
      {:noreply, complete(state, ref, {:task_exit, reason})}
    end)
  end

  @impl true
  def terminate(_reason, state) do
    Enum.each(state.task_handles, fn {_, task} -> Task.shutdown(task, :brutal_kill) end)
  end

  defp pending_words(config), do: config["buffers"] |> Enum.map(& &1["words"]) |> Enum.sum()

  defp poll(state) do
    if state.timer, do: Process.cancel_timer(state.timer)
    config = state.config

    next =
      config
      |> read_routes(state)
      |> ingest(state)
      |> flush_due(state)

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

  # A bad durable document is a relay error, not a supervisor restart loop.
  def load(path) do
    with {:ok, bytes} <- Shuttle.FS.read(path),
         {:ok, config} <- Jason.decode(bytes) do
      config = normalize(config)
      validate!(config)
      {:ok, config}
    end
  rescue
    error -> {:error, Exception.message(error)}
  end

  defp validate!(%{"launch" => launch, "completed" => true}) when is_binary(launch), do: :ok

  defp validate!(config) do
    true = is_binary(config["launch"]) and config["launch"] != ""
    true = is_binary(config["transcript"])

    for key <- ~w(offset json_offset route_offset) do
      true = is_integer(config[key]) and config[key] >= 0
    end

    for key <- ~w(routes buffers outbox), do: true = is_list(config[key])
    Enum.each(config["routes"], &validate_route!/1)

    Enum.each(config["buffers"], fn buffer ->
      true = is_binary(buffer["fiber_id"])
      true = is_list(buffer["lines"]) and Enum.all?(buffer["lines"], &is_binary/1)
      true = is_integer(buffer["words"])
    end)

    Enum.each(config["outbox"], fn batch ->
      true = Enum.all?(~w(fiber_id text message_id), &is_binary(batch[&1]))
    end)

    :ok
  end

  defp protect(state, operation) do
    operation.()
  rescue
    error -> degrade(state, Exception.message(error))
  catch
    :exit, reason -> degrade(state, inspect(reason))
  end

  defp degrade(state, error) do
    send(state.coordinator, {:relay_error, state.config["outbox"]})
    {:noreply, %{state | error: error}}
  end

  defp normalize(config) do
    config =
      Map.merge(
        %{
          "json_offset" => 0,
          "route_offset" => 0,
          "routes" => [],
          "buffers" => [],
          "outbox" => [],
          "ended" => false
        },
        config
      )

    Map.update!(config, "routes", &bound_routes(&1, config["started_at"]))
  end

  defp read_routes(%{"ended" => true} = config, _state), do: config

  defp read_routes(%{"routes_path" => path} = config, state) do
    case FileTail.advance(path, config["route_offset"], max_bytes: 65_536) do
      {:append, lines, offset} ->
        routes =
          Enum.reduce(lines, config["routes"], fn line, routes ->
            route = Jason.decode!(line)
            validate_route!(route)
            bound_routes(routes ++ [route], config["started_at"])
          end)

        current = List.last(routes)

        config
        |> Map.put("routes", routes)
        |> Map.put("route_offset", offset)
        |> flush_other_targets(current, state)
        |> read_routes(state)

      _ ->
        config
    end
  end

  defp read_routes(config, _state), do: config

  # Keep the route at capture start and every switch within this capture.
  # Earlier global history cannot own an utterance from this recorder.
  defp bound_routes(routes, nil), do: routes

  defp bound_routes(routes, started_at) do
    at = parse_time!(started_at)

    {before, during} =
      Enum.split_while(routes, &(DateTime.compare(parse_time!(&1["t"]), at) == :lt))

    Enum.take(before, -1) ++ during
  end

  defp validate_route!(route) do
    true = is_map(route) and is_binary(route["fiber_id"])
    %DateTime{} = parse_time!(route["t"])
    :ok
  end

  defp flush_other_targets(config, target, state) do
    Enum.reduce(config["buffers"], config, fn buffer, acc ->
      if same_target?(buffer, target), do: acc, else: flush_buffer(acc, buffer, state)
    end)
  end

  defp ingest(%{"ended" => true} = config, _state), do: config

  defp ingest(config, state) do
    config = ingest_voice(config, state)
    ingest_text(config, state)
  end

  defp json_pending?(config) do
    case Shuttle.FS.stat(Path.rootname(config["transcript"]) <> ".jsonl") do
      {:ok, %{size: size}} -> size > config["json_offset"]
      _ -> false
    end
  end

  defp ingest_text(config, state) do
    case FileTail.advance(config["transcript"], config["offset"], max_bytes: 65_536) do
      {:append, lines, offset} ->
        config =
          Enum.reduce(lines, config, fn line, acc ->
            cond do
              acc["ended"] ->
                acc

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
          Enum.reduce(lines, Map.put(config, "ingested", []), fn line, acc ->
            case Jason.decode(line) do
              {:ok, %{"wall" => wall, "text" => text, "speaker" => speaker} = row}
              when is_binary(wall) and is_binary(text) and is_binary(speaker) ->
                case DateTime.from_iso8601(row["wall_start"] || wall) do
                  {:ok, at, _} ->
                    add_voice_row(acc, at, row, text, speaker, state)

                  _ ->
                    raise ArgumentError,
                          "voice utterance needs an absolute wall_start timestamp"
                end

              {:ok, %{"wall" => wall} = row}
              when is_binary(wall) and not is_map_key(row, "text") ->
                acc

              _ ->
                raise ArgumentError, "malformed voice transcript row"
            end
          end)

        :ok = Shuttle.Voice.Transcript.append(next["ingested"])
        next |> Map.delete("ingested") |> Map.put("json_offset", offset)

      _ ->
        config
    end
  end

  defp discarded?(%{"discarded_at" => cut}, at) when is_binary(cut),
    do: DateTime.compare(at, parse_time!(cut)) == :lt

  defp discarded?(_config, _at), do: false

  defp add_voice_row(config, at, row, text, speaker, state) do
    target =
      Enum.find(
        Enum.reverse(config["routes"]),
        &(DateTime.compare(at, parse_time!(&1["t"])) != :lt)
      )

    name = row["name"] || speaker

    entry = %{
      "t" => row["wall_start"] || row["wall"],
      "speaker" => name,
      "text" => text,
      "fiber_id" => target && target["fiber_id"],
      "origin" => target && target["origin"],
      "name" => target && target["name"],
      "launch" => config["launch"]
    }

    config = Map.update!(config, "ingested", &(&1 ++ [entry]))

    if discarded?(config, at) do
      config
    else
      add_line(config, target, "#{name} #{text}", state, %{
        speaker: name,
        text: text,
        t: entry["t"],
        silent_ms: voice_silence(at, row)
      })
    end
  end

  defp parse_time!(value) do
    {:ok, at, _} = DateTime.from_iso8601(value)
    at
  end

  defp add_line(config, target, line, state, voice \\ nil)

  defp add_line(config, _target, "#" <> _ = line, state, nil) do
    if String.starts_with?(line, "# ended"),
      do: config |> Map.put("ended", true) |> flush_all(state),
      else: config
  end

  defp add_line(config, nil, line, _state, _voice),
    do: if(String.starts_with?(line, "# ended"), do: Map.put(config, "ended", true), else: config)

  defp add_line(config, target, line, state, voice) do
    target = Map.take(target, ~w(fiber_id origin))

    buffer =
      Enum.find(config["buffers"], &same_target?(&1, target)) ||
        Map.merge(target, %{"lines" => [], "words" => 0, "last_word_at" => nil})

    spoken = line
    words = length(String.split(spoken))

    buffer =
      if voice do
        rows = Map.get(buffer, "voice_rows") || voice_rows(buffer["lines"])

        Map.put(
          buffer,
          "voice_rows",
          rows ++ [%{"speaker" => voice.speaker, "text" => voice.text, "t" => voice.t}]
        )
      else
        buffer
      end

    buffer =
      buffer |> Map.update!("lines", &(&1 ++ [line])) |> Map.update!("words", &(&1 + words))

    buffer =
      if words > 0,
        do: Map.put(buffer, "last_word_at", state.clock.() - voice.silent_ms),
        else: buffer

    config =
      Map.put(
        config,
        "buffers",
        Enum.reject(config["buffers"], &same_target?(&1, target)) ++ [buffer]
      )

    threshold = state.thresholds.()

    cond do
      String.starts_with?(line, "# ended") ->
        config |> Map.put("ended", true) |> flush_all(state)

      Regex.match?(@closing, spoken) ->
        make_batch(config, buffer)

      buffer["words"] >= threshold["words"] ->
        flush_buffer(config, buffer, state)

      not same_target?(target, List.last(config["routes"])) ->
        flush_buffer(config, buffer, state)

      true ->
        config
    end
  end

  # Quiet counts from the last spoken word, so time spent finishing the text is
  # part of the wait. Speech still running holds the batch together.
  defp flush_due(config, state) do
    quiet = state.thresholds.()["quiet_seconds"] * 1_000
    speaking = speaking?(config)

    Enum.reduce(config["buffers"], config, fn buffer, acc ->
      if (not speaking and buffer["last_word_at"]) &&
           state.clock.() - buffer["last_word_at"] >= quiet,
         do: flush_buffer(acc, buffer, state),
         else: acc
    end)
  end

  defp voice_silence(at, %{"start" => start, "end" => finish}) do
    ended = DateTime.to_unix(at, :millisecond) + round((finish - start) * 1_000)
    max(System.system_time(:millisecond) - ended, 0)
  end

  defp voice_silence(_at, _row), do: 0

  defp speaking?(config) do
    path = Path.rootname(config["transcript"]) <> ".partial"

    with {:ok, %{mtime: mtime}} <- Shuttle.FS.stat(path, time: :posix),
         true <- System.os_time(:second) - mtime < @partial_stale_seconds,
         {:ok, text} <- Shuttle.FS.read(path) do
      String.trim(text) != ""
    else
      _ -> false
    end
  end

  defp flush_all(config, state),
    do: Enum.reduce(config["buffers"], config, &flush_buffer(&2, &1, state))

  defp flush_buffer(config, buffer, state)

  defp flush_buffer(config, %{"words" => 0} = buffer, _state),
    do: Map.put(config, "buffers", Enum.reject(config["buffers"], &same_target?(&1, buffer)))

  # Waking a worker is deliberate: speech to a target with no live worker
  # becomes a batch only when it ended with "send" (a batch made at once by
  # `@closing`), and is otherwise dropped here. The transcript keeps the words.
  defp flush_buffer(config, buffer, state) do
    if state.follow.() and state.cold.(buffer),
      do: Map.put(config, "buffers", Enum.reject(config["buffers"], &same_target?(&1, buffer))),
      else: make_batch(config, buffer)
  end

  defp make_batch(config, buffer) do
    lines = buffer["lines"]

    id =
      :crypto.hash(
        :sha256,
        "#{config["launch"]}:#{Jason.encode!(buffer)}:#{config["sequence"] || 0}"
      )
      |> Base.url_encode64(padding: false)

    rendered = render_lines(lines, buffer["voice_rows"])
    config = Map.put(config, "buffers", Enum.reject(config["buffers"], &same_target?(&1, buffer)))

    # A batch that was only "send" has nothing left to deliver.
    if String.trim(rendered) == "" do
      config
    else
      batch =
        buffer
        |> Map.take(~w(fiber_id origin))
        |> Map.merge(%{
          "text" =>
            rendered <>
              "\n— shuttle transcript --since " <>
              Shuttle.Voice.Transcript.local_time(hd(buffer["voice_rows"])["t"]) <>
              recorder_flag(buffer["origin"]) <> "\n",
          "message_id" => "voice-" <> id
        })

      config
      |> Map.update!("outbox", &(&1 ++ [batch]))
      |> Map.put("sequence", (config["sequence"] || 0) + 1)
    end
  end

  defp render_lines(lines, rows) do
    rows = unsend(rows || voice_rows(lines))

    {paragraphs, _} =
      Enum.reduce(rows, {[], nil}, fn %{"speaker" => speaker, "text" => text},
                                      {paragraphs, previous} ->
        cond do
          speaker == previous -> {List.update_at(paragraphs, -1, &(&1 <> " " <> text)), speaker}
          true -> {paragraphs ++ [speaker <> ": " <> text], speaker}
        end
      end)

    Enum.join(paragraphs, "\n")
  end

  # A batch that "send" closed reaches the worker without that final word.
  defp unsend(rows) do
    case List.pop_at(rows, -1) do
      {%{"text" => text} = last, rest} ->
        case String.trim(Regex.replace(@closing, text, "")) do
          "" -> rest
          text -> rest ++ [%{last | "text" => text}]
        end

      {nil, rest} ->
        rest
    end
  end

  defp voice_rows(lines) do
    for line <- lines,
        not String.starts_with?(line, "#"),
        [speaker, text] <- [String.split(line, " ", parts: 2)],
        do: %{"speaker" => speaker, "text" => text}
  end

  # A worker on another host reads the transcript from this recorder, not its own.
  defp recorder_flag(origin) do
    own = Shuttle.RecorderRouter.own_host()
    if origin in [nil, own], do: "", else: " --recorder " <> own
  end

  defp same_target?(nil, _), do: false
  defp same_target?(_, nil), do: false
  defp same_target?(a, b), do: a["fiber_id"] == b["fiber_id"] and a["origin"] == b["origin"]

  defp maybe_end(config, state) do
    case state.observe.() do
      {:ok, %{capture: %{launch: launch, state: phase, error: error}}} ->
        cond do
          launch != config["launch"] ->
            end_capture(config, "capture was replaced before completion", state)

          phase in ["failed", "ended"] ->
            end_capture(config, "capture #{phase}: #{error}", state)

          true ->
            config
        end

      {:ok, %{capture: nil}} ->
        end_capture(config, "capture ended", state)

      _ ->
        config
    end
  end

  defp end_capture(config, reason, state) do
    # After observing the recorder's exit, drain once more: its last JSON row
    # may have landed between this tick's JSON read and the text footer.
    drained = ingest_voice(config, state)

    target = List.last(config["routes"])

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

    candidates = Enum.uniq_by(state.config["outbox"], &{&1["fiber_id"], &1["origin"]})

    Enum.reduce(candidates, state, fn batch, acc ->
      if batch["message_id"] in busy do
        acc
      else
        acc = mark_attempted(acc, batch)
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

  # Persist before the side effect: a crash can lose a batch, but cannot paste it twice.
  defp mark_attempted(state, batch) do
    outbox =
      Enum.map(state.config["outbox"], fn item ->
        if item["message_id"] == batch["message_id"],
          do: Map.put(item, "attempted", true),
          else: item
      end)

    persist!(%{state | config: Map.put(state.config, "outbox", outbox)})
  end

  defp recover_attempted(state) do
    {attempted, remaining} = Enum.split_with(state.config["outbox"], & &1["attempted"])

    case List.last(attempted) do
      nil ->
        state

      batch ->
        last = %{
          "fiber_id" => batch["fiber_id"],
          "at" => DateTime.to_iso8601(DateTime.utc_now()),
          "status" => "unconfirmed",
          "detail" => "The message may have arrived. The transcript retains the words."
        }

        :ok = Shuttle.FS.mkdir_p(Shuttle.data_dir())
        :ok = Shuttle.FS.write_atomic(Shuttle.Voice.last_path(), Jason.encode!(last))
        config = state.config |> Map.put("outbox", remaining) |> Map.put("last", last)
        persist!(%{state | config: config})
    end
  end

  defp complete(state, ref, result) do
    case Map.pop(state.tasks, ref) do
      {nil, _} ->
        state

      {id, tasks} ->
        batch = Enum.find(state.config["outbox"], &(&1["message_id"] == id))

        outcome =
          if match?({:task_exit, _}, result),
            do: :unconfirmed,
            else: delivery_outcome(result)

        last = %{
          "fiber_id" => batch["fiber_id"],
          "at" => DateTime.to_iso8601(DateTime.utc_now()),
          "status" => Atom.to_string(outcome),
          "origin" => batch["origin"],
          "text" => batch["text"]
        }

        last =
          case outcome do
            :delivered ->
              last

            :unconfirmed ->
              Map.put(
                last,
                "detail",
                "The message may have arrived. The transcript retains the words."
              )

            :failed ->
              Map.put(last, "detail", inspect(result))
          end

        :ok = Shuttle.FS.mkdir_p(Shuttle.data_dir())
        :ok = Shuttle.FS.write_atomic(Shuttle.Voice.last_path(), Jason.encode!(last))

        config =
          state.config
          |> Map.put("outbox", Enum.reject(state.config["outbox"], &(&1["message_id"] == id)))
          |> Map.put("last", last)

        persist!(%{
          state
          | config: config,
            tasks: tasks,
            task_handles: Map.delete(state.task_handles, ref)
        })
    end
  end

  def delivery_outcome({status, body}) when status in 200..299 do
    case Map.fetch(body, :delivered) do
      {:ok, true} ->
        :delivered

      {:ok, nil} ->
        :unconfirmed

      {:ok, false} ->
        :failed

      :error ->
        case Map.fetch(body, "delivered") do
          {:ok, true} -> :delivered
          {:ok, nil} -> :unconfirmed
          _ -> :failed
        end
    end
  end

  def delivery_outcome(_), do: :failed

  defp persist!(%{config: config, persisted: config} = state), do: state

  defp persist!(state) do
    :ok = Shuttle.FS.write_atomic(state.file, Jason.encode!(state.config) <> "\n")
    %{state | persisted: state.config}
  end

  def deliver(%{fiber_id: fiber_id, text: text, origin: origin, message_id: id}) do
    ShuttleWeb.DeliverController.route(fiber_id, text, origin, "shuttle", %{
      "message_id" => id,
      "message_after_launch" => false,
      "live_input" => true
    })
  end
end
