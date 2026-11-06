defmodule Shuttle.Voice do
  @moduledoc "Owns the live voice switch, spoken-time route journal and recorder reconciliation."
  use GenServer
  alias Shuttle.{Meeting, Voice.Config}

  def start_link(opts \\ []),
    do: GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))

  def show(opts \\ []), do: GenServer.call(server(opts), :show)
  def update(params, opts \\ []), do: GenServer.call(server(opts), {:update, params}, 30_000)

  def target(params, opts \\ []),
    do: GenServer.call(server(opts), {:target, params, DateTime.utc_now()})

  defp server(opts), do: Keyword.get(opts, :server, Shuttle.Env.server(__MODULE__))
  def routes_path, do: Path.join(Shuttle.data_dir(), "voice-routes.jsonl")
  def last_path, do: Path.join(Shuttle.data_dir(), "voice-last.json")

  @impl true
  def init(opts) do
    Process.flag(:trap_exit, true)
    routes_path = Keyword.get(opts, :routes_path, routes_path())
    {lines, route_bytes, _} = Shuttle.FileTail.snapshot(routes_path)
    :ok = truncate_routes(routes_path, route_bytes)

    target =
      case List.last(lines) do
        nil -> nil
        line -> Jason.decode!(line) |> Map.take(~w(fiber_id origin name))
      end

    state = %{
      target: target,
      task: nil,
      queue: [],
      routes_path: routes_path,
      route_bytes: route_bytes,
      poll_ms: Keyword.get(opts, :poll_ms, 1_000),
      reconcile: Keyword.get(opts, :reconcile, &Meeting.reconcile_voice/2),
      capture_opts: Keyword.get(opts, :capture_opts, []),
      relay: Keyword.get(opts, :relay, &start_relay/2),
      monitor: Keyword.get(opts, :monitor, &monitor/1),
      snapshot: %{
        available: false,
        enabled: false,
        muted: Meeting.voice_muted?(),
        state: "off",
        target: target,
        pending: nil,
        last: read_last(),
        error: nil
      }
    }

    send(self(), :tick)
    {:ok, state}
  end

  @impl true
  def handle_call(:show, _from, state), do: {:reply, state.snapshot, state}

  def handle_call({:target, %{"fiber_id" => id} = params, received_at}, _from, state)
      when is_binary(id) and id != "" do
    origin = params["origin"]

    case Shuttle.OriginRouter.route_host(origin) do
      {:error, {:unknown_origin, host}} ->
        {:reply, {:error, Shuttle.OriginRouter.unknown_origin_message(host)}, state}

      _ ->
        target = %{
          "fiber_id" => id,
          "origin" => origin || Shuttle.MeetingRouter.own_host(),
          "name" => target_name(id, origin) || params["name"] || Path.basename(id)
        }

        row = Map.put(target, "t", DateTime.to_iso8601(received_at))

        case append_route(state.routes_path, state.route_bytes, row) do
          {:ok, route_bytes} ->
            Shuttle.Meeting.TranscriptRelay.targets_changed()

            state = %{
              state
              | target: target,
                route_bytes: route_bytes,
                snapshot: %{state.snapshot | target: target}
            }

            {:reply, {:ok, state.snapshot}, state}

          {:error, reason} ->
            {:reply, {:error, inspect(reason)}, state}
        end
    end
  end

  def handle_call({:target, _, _}, _from, state),
    do: {:reply, {:error, "fiber_id is required"}, state}

  def handle_call({:update, params}, from, state) do
    invalid =
      Enum.any?(~w(enabled muted), &(Map.has_key?(params, &1) and not is_boolean(params[&1])))

    if invalid do
      {:reply, {:error, "enabled and muted must be booleans"}, state}
    else
      {:noreply, enqueue(state, {params, from})}
    end
  end

  @impl true
  def handle_info(:tick, state) do
    Process.send_after(self(), :tick, state.poll_ms)
    {:noreply, if(state.task, do: state, else: enqueue(state, {%{}, nil}))}
  end

  def handle_info({ref, result}, %{task: {%Task{ref: ref}, from}} = state) do
    Process.demonitor(ref, [:flush])
    finish_task(state, from, result)
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, %{task: {%Task{ref: ref}, from}} = state),
    do: finish_task(state, from, {:error, "voice reconciliation exited: #{inspect(reason)}"})

  @impl true
  def terminate(_reason, %{task: {task, _}}), do: Task.shutdown(task, :brutal_kill)
  def terminate(_reason, _state), do: :ok

  defp finish_task(state, from, result) do
    {reply, snapshot} =
      case result do
        {:ok, snapshot} ->
          snapshot = %{snapshot | target: state.target}
          {{:ok, snapshot}, snapshot}

        {:error, reason} ->
          enabled =
            case Config.read() do
              {:ok, settings} -> settings["enabled"]
              _ -> state.snapshot.enabled
            end

          snapshot = %{
            state.snapshot
            | enabled: enabled,
              muted: Meeting.voice_muted?(state.capture_opts),
              state: "failed",
              error: inspect(reason)
          }

          {{:error, inspect(reason)}, snapshot}
      end

    if from, do: GenServer.reply(from, reply)
    state = %{state | task: nil, snapshot: snapshot}

    case state.queue do
      [] -> {:noreply, state}
      [next | rest] -> {:noreply, enqueue(%{state | queue: rest}, next)}
    end
  end

  defp enqueue(%{task: task} = state, operation) when not is_nil(task),
    do: %{state | queue: state.queue ++ [operation]}

  defp enqueue(state, {params, from}) do
    task =
      Task.Supervisor.async_nolink(Shuttle.TaskSupervisor, fn ->
        with :ok <-
               if(Map.has_key?(params, "enabled"),
                 do: Config.enable(params["enabled"]),
                 else: :ok
               ),
             :ok <-
               if(Map.has_key?(params, "muted"),
                 do: Meeting.mute_voice(params["muted"], state.capture_opts),
                 else: :ok
               ) do
          {:ok, reconcile(state).snapshot}
        end
      end)

    %{state | task: {task, from}}
  end

  defp reconcile(state) do
    state = %{
      state
      | snapshot: %{state.snapshot | muted: Meeting.voice_muted?(state.capture_opts)}
    }

    case Config.read() do
      {:ok, settings} ->
        state = %{state | snapshot: %{state.snapshot | enabled: settings["enabled"]}}
        reconcile(state, settings)

      {:error, reason} ->
        %{state | snapshot: %{state.snapshot | state: "failed", error: inspect(reason)}}
    end
  end

  defp reconcile(state, settings) do
    with {:ok, observed} <- state.reconcile.(settings["enabled"], state.capture_opts) do
      row = observed.meeting
      voice = not is_nil(row) and row[:kind] == "voice"
      if voice and is_binary(row[:transcript]), do: state.relay.(row, state.routes_path)
      status = if voice, do: state.monitor.(row.launch), else: %{pending: nil, last: nil}

      phase =
        cond do
          not settings["enabled"] -> "off"
          row && not voice -> "yielded"
          row && row.state == "failed" -> "failed"
          row && row.state == "live" -> "listening"
          true -> "starting"
        end

      snapshot = %{
        available: observed.available,
        enabled: settings["enabled"],
        muted: Meeting.voice_muted?(state.capture_opts),
        state: phase,
        target: state.target,
        pending: status.pending,
        last: status.last || read_last() || state.snapshot.last,
        error: if(voice, do: row[:error])
      }

      %{state | snapshot: snapshot}
    else
      {:error, reason} ->
        %{state | snapshot: %{state.snapshot | state: "failed", error: inspect(reason)}}
    end
  end

  defp target_name(id, origin) do
    fibers = Shuttle.Env.app(:meeting_fibers, &Meeting.served_fibers/0)

    Enum.find_value(fibers.(), fn fiber ->
      if id in [fiber["uid"], fiber["id"], fiber["slug"]] and
           (origin in [nil, ""] or get_in(fiber, ["shuttle", "host"]) == origin),
         do: fiber["name"]
    end)
  end

  defp start_relay(row, routes_path) do
    row = row |> Map.put(:kind, "voice") |> Map.put(:routes_path, routes_path)
    Shuttle.Meeting.TranscriptRelay.start(row, nil, nil)
  end

  defp monitor(launch), do: Shuttle.Meeting.TranscriptRelay.status(launch)

  defp read_last do
    with {:ok, bytes} <- Shuttle.FS.read(last_path()),
         {:ok, last} <- Jason.decode(bytes),
         do: last,
         else: (_ -> nil)
  end

  defp truncate_routes(path, offset) do
    case Shuttle.FS.open(path, [:read, :write, :binary]) do
      {:ok, fd} ->
        try do
          with {:ok, _} <- Shuttle.FS.position(fd, offset), do: Shuttle.FS.truncate(fd)
        after
          Shuttle.FS.close(fd)
        end

      {:error, :enoent} ->
        :ok

      error ->
        error
    end
  end

  defp append_route(path, offset, row) do
    bytes = Jason.encode!(row) <> "\n"

    with :ok <- Shuttle.FS.mkdir_p(Path.dirname(path)),
         {:ok, fd} <- Shuttle.FS.open(path, [:read, :write, :binary]) do
      try do
        with {:ok, _} <- Shuttle.FS.position(fd, offset),
             :ok <- Shuttle.FS.truncate(fd),
             :ok <- Shuttle.FS.write(fd, bytes),
             :ok <- Shuttle.FS.sync(fd),
             do: {:ok, offset + byte_size(bytes)}
      after
        Shuttle.FS.close(fd)
      end
    end
  end
end
