defmodule Shuttle.Voice do
  @moduledoc "Owns the live voice switch, spoken-time route journal and recorder reconciliation."
  use GenServer
  alias Shuttle.{Meeting, Voice.Config}

  def start_link(opts \\ []),
    do: GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))

  def show(opts \\ []), do: GenServer.call(server(opts), :show)

  @doc "The switch, state and target alone, cheap enough to read on every Rex poll."
  def snapshot(opts \\ []), do: GenServer.call(server(opts), :snapshot)

  @doc "Delivers `{:voice_target, target}` to the calling process on every new route."
  def subscribe, do: Registry.register(__MODULE__.Streams, :target, nil)
  def cold?(target), do: Shuttle.Voice.Target.cold?(target)
  def update(params, opts \\ []), do: GenServer.call(server(opts), {:update, params}, 30_000)

  @doc "Route to `params` while Follow me is on and no recording holds the mic; otherwise a no-op."
  def target(params, opts \\ []),
    do: GenServer.call(server(opts), {:target, params, DateTime.utc_now()})

  def focus_error(message, opts \\ []),
    do: GenServer.cast(server(opts), {:focus_error, message})

  defp server(opts), do: Keyword.get(opts, :server, Shuttle.Env.server(__MODULE__))
  def routes_path, do: Path.join(Shuttle.data_dir(), "voice-routes.jsonl")
  def last_path, do: Path.join(Shuttle.data_dir(), "voice-last.json")

  @impl true
  def init(opts) do
    Process.flag(:trap_exit, true)
    routes_path = Keyword.get(opts, :routes_path, routes_path())
    {target, route_bytes, route_error} = restore_routes(routes_path)

    state = %{
      target: target,
      task: nil,
      retry: new_retry(),
      configured_enabled: nil,
      idle_key: nil,
      idle: false,
      preview_pin: nil,
      capture_error: nil,
      focus_error: nil,
      route_error: route_error,
      clock: Keyword.get(opts, :clock, fn -> System.monotonic_time(:millisecond) end),
      queue: [],
      routes_path: routes_path,
      route_bytes: route_bytes,
      poll_ms: Keyword.get(opts, :poll_ms, 1_000),
      reconcile: Keyword.get(opts, :reconcile, &Meeting.reconcile_voice/2),
      capture_opts: Keyword.get(opts, :capture_opts, []),
      relay: Keyword.get(opts, :relay, &start_relay/2),
      monitor: Keyword.get(opts, :monitor, &monitor/1),
      held: Keyword.get(opts, :held, &Shuttle.Meeting.TranscriptRelay.held/0),
      recovery: Keyword.get(opts, :recovery, &Shuttle.Meeting.TranscriptRelay.recovery/0),
      cold: Keyword.get(opts, :cold, &cold?/1),
      snapshot: %{
        available: false,
        enabled: false,
        muted: Meeting.voice_muted?(Keyword.get(opts, :capture_opts, [])),
        state: if(route_error, do: "failed", else: "off"),
        target: target,
        pending: nil,
        preview: nil,
        last: read_last(),
        error: route_error
      }
    }

    send(self(), :tick)
    {:ok, state}
  end

  @impl true
  def handle_call(:snapshot, _from, state), do: {:reply, state.snapshot, state}

  def handle_call(:show, _from, state) do
    state = name_target(state)
    snapshot = live_drafts(state.snapshot, state)
    {:reply, %{snapshot | error: snapshot.error || state.focus_error}, state}
  end

  def handle_call({:target, %{"fiber_id" => id} = params, received_at}, _from, state)
      when is_binary(id) and id != "" do
    origin = params["origin"]

    case route_check(state, origin) do
      :not_following ->
        {:reply, {:ok, state.snapshot}, state}

      {:error, {:routes, reason}} ->
        {:reply, {:error, reason}, state}

      {:error, {:unknown_origin, host}} ->
        {:reply, {:error, Shuttle.OriginRouter.unknown_origin_message(host)}, state}

      _ ->
        target = %{
          "fiber_id" => id,
          "origin" => origin || Shuttle.MeetingRouter.own_host(),
          "name" =>
            target_name(id, origin) || params["name"] || known_name(state.target, id) ||
              Path.basename(id)
        }

        row = Map.put(target, "t", DateTime.to_iso8601(received_at))
        row = if params["source"], do: Map.put(row, "source", params["source"]), else: row

        case append_route(state.routes_path, state.route_bytes, row) do
          {:ok, route_bytes} ->
            Shuttle.Meeting.TranscriptRelay.targets_changed()

            Registry.dispatch(__MODULE__.Streams, :target, fn entries ->
              for {pid, _} <- entries, do: send(pid, {:voice_target, target})
            end)

            state = %{
              state
              | target: target,
                route_bytes: route_bytes,
                snapshot: %{state.snapshot | target: target}
            }

            {:reply, {:ok, live_drafts(state.snapshot, state)}, state}

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

  defp route_check(%{route_error: reason}, _origin) when not is_nil(reason),
    do: {:error, {:routes, reason}}

  defp route_check(state, origin) do
    if following?(state), do: Shuttle.OriginRouter.route_host(origin), else: :not_following
  end

  defp following?(state) do
    state.snapshot.enabled and state.snapshot.state != "yielded" and
      match?({:ok, %{"enabled" => true}}, Config.read())
  end

  defp live_drafts(snapshot, state) do
    snapshot =
      case state.held.() do
        {:error, reason} -> Map.merge(snapshot, %{held: [], state: "failed", error: reason})
        held -> Map.put(snapshot, :held, held)
      end

    preview =
      if snapshot.enabled && not snapshot.muted && snapshot.state == "listening",
        do: snapshot.preview

    snapshot
    |> Map.put(:last, recovery_last(snapshot.last, state.recovery.()))
    |> Map.put(:preview, preview)
    |> Map.put(:cold, not is_nil(snapshot.target) and state.cold.(snapshot.target))
    |> Map.put(:level, Meeting.mic_level(state.capture_opts))
  end

  defp recovery_last(last, nil), do: last
  defp recovery_last(nil, recovery), do: recovery

  defp recovery_last(last, recovery) do
    if recovery["at"] > (last["at"] || last[:at] || "") or
         (recovery["fiber_id"] == (last["fiber_id"] || last[:fiber_id]) and
            (last["status"] || last[:status]) != "delivered"), do: recovery, else: last
  end

  @impl true
  def handle_cast({:focus_error, message}, state), do: {:noreply, %{state | focus_error: message}}

  @impl true
  def handle_info(:tick, state) do
    Process.send_after(self(), :tick, state.poll_ms)
    {:noreply, if(state.task, do: state, else: enqueue(state, {%{}, nil}))}
  end

  def handle_info({ref, result}, %{task: {%Task{ref: ref}, from}} = state) do
    Process.demonitor(ref, [:flush])
    finish_task(state, from, result)
  end

  def handle_info(
        {:DOWN, ref, :process, _pid, {:timeout, _}},
        %{task: {%Task{ref: ref}, from}} = state
      ),
      do: finish_task(state, from, :timeout)

  def handle_info({:DOWN, ref, :process, _pid, reason}, %{task: {%Task{ref: ref}, from}} = state),
    do: finish_task(state, from, {:error, "voice reconciliation exited: #{inspect(reason)}"})

  @impl true
  def terminate(_reason, %{task: {task, _}}), do: Task.shutdown(task, :brutal_kill)
  def terminate(_reason, _state), do: :ok

  defp finish_task(state, from, result) do
    state =
      case result do
        {:ok, next} ->
          Map.merge(
            state,
            Map.take(next, [
              :retry,
              :configured_enabled,
              :idle,
              :idle_key,
              :capture_error,
              :preview_pin
            ])
          )

        _ ->
          state
      end

    {reply, snapshot} =
      case result do
        {:ok, next} ->
          snapshot = %{next.snapshot | target: state.target}
          {{:ok, snapshot}, snapshot}

        :timeout ->
          {{:error, "voice reconciliation timed out"}, state.snapshot}

        {:error, reason} ->
          enabled =
            case Config.read() do
              {:ok, settings} -> settings["enabled"]
              _ -> false
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

    reply =
      case reply do
        {:ok, snapshot} -> {:ok, live_drafts(snapshot, state)}
        error -> error
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
          {:ok, reconcile(state)}
        end
      end)

    %{state | task: {task, from}}
  end

  defp reconcile(state) do
    case Config.read() do
      {:ok, settings} ->
        enabled = settings["enabled"]

        state =
          if state.configured_enabled != enabled,
            do: %{state | retry: new_retry(), configured_enabled: enabled, idle: false},
            else: state

        if state.route_error do
          fail_off(state, state.route_error)
        else
          reconcile_capture(state, enabled)
        end

      {:error, reason} ->
        fail_off(state, "invalid voice settings: #{inspect(reason)}")
    end
  end

  defp fail_off(state, reason) do
    next = reconcile_capture(state, false)
    stop_error = if next.snapshot.state == "failed", do: next.snapshot.error
    error = if stop_error, do: "#{reason}; recorder: #{stop_error}", else: reason
    %{next | snapshot: %{next.snapshot | enabled: false, state: "failed", error: error}}
  end

  defp reconcile_capture(state, enabled) do
    key = Meeting.voice_observation_key(state.capture_opts)

    state = %{
      state
      | snapshot: %{
          state.snapshot
          | muted: Meeting.voice_muted?(state.capture_opts),
            preview: nil,
            last: read_last() || state.snapshot.last
        }
    }

    if not enabled and state.idle and key == state.idle_key do
      %{
        state
        | snapshot: %{
            state.snapshot
            | enabled: false,
              state: if(state.capture_error, do: "failed", else: "off"),
              error: state.capture_error
          }
      }
    else
      observe_capture(state, enabled, key)
    end
  end

  defp observe_capture(state, enabled, key) do
    now = state.clock.()
    retry = state.retry
    allowed = not retry.latched and (is_nil(retry.at) or now >= retry.at)

    opts =
      Keyword.merge(state.capture_opts,
        voice_start: allowed,
        restart_voice: allowed and not is_nil(retry.at)
      )

    case state.reconcile.(enabled, opts) do
      {:ok, observed} ->
        row = observed.meeting
        voice = not is_nil(row) and row[:kind] == "voice"
        retry = track_retry(retry, row, now)

        relay_result =
          if voice and row.state != "failed" and is_binary(row[:transcript]),
            do: state.relay.(row, state.routes_path),
            else: :ok

        status =
          case relay_result do
            {:error, reason} ->
              %{pending: nil, last: nil, error: inspect(reason)}

            _ when voice ->
              case state.monitor.(row.launch) do
                :timeout -> Map.take(state.snapshot, [:pending, :last, :error])
                status -> status
              end

            _ ->
              %{pending: nil, last: nil}
          end

        relay_error = Map.get(status, :error)

        phase =
          cond do
            not enabled -> "off"
            row && not voice -> "yielded"
            row && row.state == "failed" -> "failed"
            retry.latched or not is_nil(retry.at) -> "failed"
            relay_error -> "failed"
            row && row.state == "live" -> "listening"
            true -> "starting"
          end

        error =
          cond do
            retry.latched -> "voice repeatedly crashed; toggle enabled off and on to retry"
            voice && row[:error] -> row[:error]
            not is_nil(retry.at) and is_nil(row) -> state.snapshot.error
            true -> relay_error
          end

        words =
          if voice && enabled && row.state == "live" &&
               not Meeting.voice_muted?(state.capture_opts),
             do: read_preview(row[:transcript])

        preview_pin = pin_preview(state.preview_pin, words, row, state.target)

        snapshot = %{
          available: observed.available,
          enabled: enabled,
          muted: Meeting.voice_muted?(state.capture_opts),
          state: phase,
          target: state.target,
          pending: status.pending,
          preview:
            if(words && preview_pin && preview_pin.target,
              do: Map.merge(Map.take(preview_pin.target, ~w(fiber_id origin)), words)
            ),
          last: status.last || read_last() || state.snapshot.last,
          error: error
        }

        %{
          state
          | snapshot: snapshot,
            retry: retry,
            preview_pin: preview_pin,
            idle: is_nil(row) or (not enabled and not voice),
            idle_key: key,
            capture_error: nil
        }

      {:error, reason} ->
        retry = if enabled and allowed, do: failed_retry(retry, now), else: retry

        %{
          state
          | retry: retry,
            idle: not enabled and key == {:error, :enoent},
            idle_key: key,
            capture_error: inspect(reason),
            snapshot: %{
              state.snapshot
              | enabled: enabled,
                muted: Meeting.voice_muted?(state.capture_opts),
                state: "failed",
                error:
                  if(retry.latched,
                    do:
                      "voice repeatedly failed; toggle enabled off and on to retry: #{inspect(reason)}",
                    else: inspect(reason)
                  )
            }
        }
    end
  end

  # A preview belongs to the line in progress: the worker in view when its first
  # words appeared, until the transcript gains a finished line.
  defp pin_preview(_pin, nil, _row, _target), do: nil

  defp pin_preview(pin, _words, row, target) do
    finished = finished_size(row[:transcript])

    if pin && pin.finished == finished,
      do: pin,
      else: %{target: target, finished: finished}
  end

  defp finished_size(path) do
    case Shuttle.FS.stat(path) do
      {:ok, %{size: size}} -> size
      _ -> nil
    end
  end

  defp read_preview(path) when is_binary(path) do
    case Shuttle.FS.read(Path.rootname(path) <> ".partial") do
      {:ok, text} -> if String.trim(text) != "", do: %{"text" => String.trim(text)}
      _ -> nil
    end
  end

  defp read_preview(_), do: nil

  defp new_retry,
    do: %{failures: 0, at: nil, latched: false, launch: nil, started: nil, failed: nil}

  defp track_retry(%{latched: true} = retry, _row, _now), do: retry

  defp track_retry(retry, %{kind: "voice", state: "failed", launch: launch}, now) do
    if retry.failed == launch do
      retry
    else
      retry =
        if retry.launch == launch and not is_nil(retry.started) and now - retry.started >= 30_000,
          do: new_retry(),
          else: retry

      %{failed_retry(retry, now) | failed: launch}
    end
  end

  defp track_retry(retry, %{kind: "voice", launch: launch}, now) do
    cond do
      retry.launch != launch -> %{retry | launch: launch, started: now, at: nil}
      now - retry.started >= 30_000 -> %{new_retry() | launch: launch, started: now}
      true -> retry
    end
  end

  defp track_retry(retry, _row, _now), do: retry

  defp failed_retry(retry, now) do
    failures = min(retry.failures + 1, 5)
    delay = min(1_000 * Integer.pow(2, failures - 1), 30_000)
    %{retry | failures: failures, at: now + delay, latched: failures >= 5}
  end

  defp restore_routes(path) do
    case Shuttle.FS.read(path) do
      {:ok, contents} -> restore_readable_routes(path, contents)
      {:error, :enoent} -> {nil, 0, nil}
      {:error, reason} -> {nil, 0, "voice route recovery failed: #{inspect(reason)}"}
    end
  end

  defp restore_readable_routes(path, contents) do
    bytes =
      case :binary.matches(contents, "\n") do
        [] -> 0
        matches -> elem(List.last(matches), 0) + 1
      end

    lines = contents |> binary_part(0, bytes) |> String.split("\n", trim: true)

    decoded =
      Enum.reduce_while(lines, {:ok, nil}, fn line, _ ->
        case Jason.decode(line) do
          {:ok, %{"fiber_id" => id} = row} when is_binary(id) and id != "" ->
            {:cont, {:ok, Map.take(row, ~w(fiber_id origin name))}}

          _ ->
            {:halt, {:error, "invalid voice route journal"}}
        end
      end)

    with {:ok, target} <- decoded,
         :ok <- truncate_routes(path, bytes) do
      {target, bytes, nil}
    else
      {:error, reason} -> {nil, bytes, "voice route recovery failed: #{inspect(reason)}"}
    end
  end

  # A target named only by its id (a served-fiber lookup that missed when it
  # was set, or a journal row written so) is named again once the fiber is served.
  defp name_target(%{target: %{"fiber_id" => id} = target} = state) do
    with true <- target["name"] in [nil, "", id, Path.basename(id)],
         name when is_binary(name) <- target_name(id, target["origin"]) do
      target = Map.put(target, "name", name)
      %{state | target: target, snapshot: %{state.snapshot | target: target}}
    else
      _ -> state
    end
  end

  defp name_target(state), do: state

  defp known_name(%{"fiber_id" => id, "name" => name}, id) when is_binary(name) and name != "",
    do: if(name in [id, Path.basename(id)], do: nil, else: name)

  defp known_name(_target, _id), do: nil

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
