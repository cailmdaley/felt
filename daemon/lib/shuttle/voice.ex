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

  @doc """
  The one mic key: off turns following on unmuted, following flips its mute,
  and a meeting flips its pause.
  """
  def toggle(opts \\ []) do
    case GenServer.call(server(opts), :toggle) do
      {:pause, paused, launch} ->
        pause = Shuttle.Env.app(:voice_meeting_pause, &Meeting.pause/2)

        case pause.(paused, launch: launch) do
          {:ok, _} -> update(%{}, opts)
          {:error, {:stale_launch, _}} -> {:error, "a different meeting is recording now"}
          {:error, {_, message}} when is_binary(message) -> {:error, message}
          {:error, reason} -> {:error, inspect(reason)}
        end

      params ->
        update(params, opts)
    end
  end

  @doc """
  Drops the live recording's words said but not yet sent, returning the state
  with `discarded`, the number of words dropped.
  """
  def discard(opts \\ []) do
    with {:ok, words} <- GenServer.call(server(opts), :discard),
         do: {:ok, Map.put(show(opts), :discarded, words)}
  end

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
      cold: Keyword.get(opts, :cold, &cold?/1),
      discard: Keyword.get(opts, :discard, &Shuttle.Meeting.TranscriptRelay.discard/1),
      meeting: nil,
      launch: nil,
      observed_at: nil,
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
  def handle_call(:snapshot, _from, state),
    do: {:reply, state.snapshot |> put_mode(state.meeting) |> put_pending_words(state), state}

  def handle_call(:show, _from, state) do
    state = name_target(state)
    snapshot = live_drafts(state.snapshot, state)
    {:reply, %{snapshot | error: snapshot.error || state.focus_error}, state}
  end

  def handle_call(:toggle, _from, state) do
    plan =
      case put_mode(state.snapshot, state.meeting) do
        %{mode: "meeting", paused: paused} -> {:pause, not paused, state.launch}
        %{mode: "following", muted: muted} -> %{"muted" => not muted}
        %{mode: "off"} -> %{"enabled" => true, "muted" => false}
      end

    {:reply, plan, state}
  end

  def handle_call(:discard, _from, %{launch: nil} = state), do: {:reply, {:ok, 0}, state}

  def handle_call(:discard, _from, state) do
    case state.discard.(state.launch) do
      {:ok, words} ->
        {:reply, {:ok, words}, %{state | snapshot: %{state.snapshot | pending: nil}}}

      {:error, reason} ->
        {:reply, {:error, inspect(reason)}, state}
    end
  end

  def handle_call({:target, %{"fiber_id" => id} = params, received_at}, _from, state)
      when is_binary(id) and id != "" do
    origin = params["origin"]

    case route_check(state, origin) do
      :not_following ->
        {:reply, {:ok, put_mode(state.snapshot, state.meeting)}, state}

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

        target =
          if params["source"], do: Map.put(target, "source", params["source"]), else: target

        row = Map.put(target, "t", DateTime.to_iso8601(received_at))

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

    cond do
      invalid ->
        {:reply, {:error, "enabled and muted must be booleans"}, state}

      params["enabled"] == true and not is_nil(state.meeting) ->
        {:reply, {:error, "a meeting holds the microphone"}, state}

      true ->
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
    preview =
      if snapshot.enabled && not snapshot.muted && snapshot.state == "listening",
        do: snapshot.preview

    snapshot
    |> Map.put(:preview, preview)
    |> Map.put(:cold, not is_nil(snapshot.target) and state.cold.(snapshot.target))
    |> Map.put(:level, Meeting.mic_level(state.capture_opts))
    |> put_mode(state.meeting)
    |> put_pending_words(state)
  end

  # Words the live recording's relay holds unsent, read from the relay each time.
  defp put_pending_words(snapshot, %{launch: nil}), do: Map.put(snapshot, :pending_words, 0)

  defp put_pending_words(snapshot, state) do
    words =
      case state.monitor.(state.launch) do
        %{pending_words: words} -> words
        _ -> 0
      end

    Map.put(snapshot, :pending_words, words)
  end

  # Where spoken words go right now: a meeting joined to a card holds the mic
  # whether or not Follow me is on; otherwise Follow me routes to its target.
  defp put_mode(snapshot, %{destination: destination, paused: paused}),
    do: Map.merge(snapshot, %{mode: "meeting", destination: destination, paused: paused})

  defp put_mode(%{enabled: true, state: phase} = snapshot, nil) when phase != "yielded" do
    destination = snapshot.target && Map.take(snapshot.target, ~w(fiber_id name origin))
    Map.merge(snapshot, %{mode: "following", destination: destination, paused: snapshot.muted})
  end

  defp put_mode(snapshot, _meeting),
    do: Map.merge(snapshot, %{mode: "off", destination: nil, paused: false})

  # A recording other than voice that is not failed is a meeting in progress.
  defp meeting_view(%{kind: kind, state: phase} = row)
       when kind != "voice" and phase != "failed" do
    destination =
      if row[:fiber] do
        origin = row[:origin] || row[:mirror_host] || Shuttle.MeetingRouter.own_host()

        %{
          "fiber_id" => row.fiber,
          "name" => target_name(row.fiber, origin) || row[:title] || Path.basename(row.fiber),
          "origin" => origin
        }
      end

    %{destination: destination, paused: row[:paused] == true}
  end

  defp meeting_view(_row), do: nil

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
              :preview_pin,
              :meeting,
              :launch,
              :observed_at
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

    if not enabled and state.idle and key == state.idle_key and not meeting_due?(state) do
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

  # During a meeting, idle voice still observes the recorder every
  # @meeting_observe_ms, to see a recorder that died without a lifecycle write.
  @meeting_observe_ms 10_000
  defp meeting_due?(%{meeting: nil}), do: false
  defp meeting_due?(state), do: state.clock.() - state.observed_at >= @meeting_observe_ms

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
        meeting = meeting_view(row)
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
            meeting: meeting,
            launch: if(row && not match?({:error, _}, relay_result), do: row.launch),
            observed_at: now,
            idle: is_nil(row) or (not enabled and not voice),
            idle_key: key,
            capture_error: nil
        }

      {:error, reason} ->
        retry = if enabled and allowed, do: failed_retry(retry, now), else: retry

        %{
          state
          | retry: retry,
            meeting: nil,
            launch: nil,
            observed_at: now,
            idle: not enabled and elem(key, 0) == {:error, :enoent},
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
    fibers =
      Shuttle.Env.app(:meeting_fibers, fn ->
        Meeting.served_fibers(&Shuttle.RemoteFiberRegistry.cached_feeds/0)
      end)

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
