defmodule Shuttle.RemoteRegistry do
  @moduledoc """
  Polls each configured remote Shuttle daemon's `GET /api/v1/state`
  endpoint, caches the snapshot per origin, and owns the cross-host
  recovery cascade when a remote stops answering.

  The laptop's local Shuttle daemon uses this registry to:

    * **Composite snapshot** — `Shuttle.Web.StateController` returns
      the local snapshot plus per-origin remote snapshots so the
      kanban frontend has cross-host visibility.

    * **Self-healing** — after N consecutive snapshot failures, the
      registry treats the origin as degraded and runs the recovery
      cascade: bounce the local launchd-managed tunnel, SSH-check the
      remote daemon, restart it when needed, then exponential backoff.

  Snapshot pull stays fire-and-forget HTTP polling: the remote daemon
  doesn't know it's being polled, no persistent connections, no auth
  state. Failures only mark the origin as stale or recovering; the
  registry never crashes.

  ## Configuration

      config :shuttle, :remotes, [
        %{name: "candide", url: "http://localhost:4001", poll_interval_ms: 5000}
      ]

  See `Shuttle.Remote` for the remote config shape.

  ## Test injection

  The HTTP transport is a behaviour (`Shuttle.RemoteRegistry.Client`)
  so tests can substitute a deterministic stub without spinning up a
  real Bandit endpoint or stubbing `:httpc`. Shell commands for tunnel
  bounce / SSH checks / remote restarts route through `Shuttle.Runner`
  for the same reason.
  """

  use GenServer
  require Logger

  alias Shuttle.Remote
  alias Shuttle.RegistryCommon
  alias Shuttle.Runner

  @pubsub_topic "shuttle:remotes"
  @default_failure_threshold 3
  @default_trip_threshold 3
  @default_bounce_wait_ms 5_000
  @default_restart_wait_ms 10_000
  @default_backoff_schedule_ms [30_000, 120_000, 600_000, 1_800_000]
  @ssh_connect_timeout_s 8

  # States where the recovery cascade is not actively driving the remote:
  # passive HTTP polling is the only activity. Everything else (:degraded,
  # :reviving, :unreachable) is mid-cascade — the state machine owns the
  # probes, so the passive poll stays out of the way.
  @cascade_inactive [:healthy, :tripped]

  # A tripped remote is known-dead; probing it at the healthy cadence
  # (default 5s, each up to a blocking request-timeout) wastes most of the
  # registry's duty cycle. Decimate to at most once a minute — plenty for
  # the auto-heal path (one successful probe resets the breaker).
  @default_tripped_poll_floor_ms 60_000

  defmodule Recovery do
    @moduledoc false
    defstruct state: :healthy,
              step: nil,
              consecutive_failures: 0,
              attempt: 0,
              backoff_index: 0,
              last_error: nil,
              last_action: nil,
              next_retry_at: nil,
              action_due_at: nil
  end

  defmodule State do
    @moduledoc false
    defstruct [
      :remotes,
      :client,
      :runner,
      :tick_timer_ref,
      :tick_interval_ms,
      :failure_threshold,
      :trip_threshold,
      :bounce_wait_ms,
      :restart_wait_ms,
      :backoff_schedule_ms,
      :tripped_poll_floor_ms,
      :user_uid,
      snapshots: %{}
    ]
  end

  # ── Client ──

  @doc """
  Starts the registry. Accepts:

    * `:remotes` — list of `%Shuttle.Remote{}` (or maps/keyword lists
      that `Shuttle.Remote.from_config/1` understands). Defaults to
      `Application.get_env(:shuttle, :remotes, [])`.
    * `:client` — module implementing `Shuttle.RemoteRegistry.Client`.
      Defaults to `Shuttle.RemoteRegistry.Client.Default` (`:httpc`).
    * `:runner` — module implementing `Shuttle.Runner`. Defaults to
      `Shuttle.Runner.Default`.
    * `:tick_interval_ms` — how often the registry tick runs. Each
      tick polls every remote whose `last_attempt_at` is older than
      its `poll_interval_ms`, unless that origin is in the recovery
      state machine. Defaults to 1_000.
    * `:failure_threshold` — consecutive snapshot failures before the
      recovery cascade starts. Defaults to 3.
    * `:trip_threshold` — full cascade attempts that may fail before
      the circuit breaker trips. Once tripped the registry keeps the
      cheap passive HTTP polling but takes no recovery actions until a
      probe succeeds or `reset_breaker/2` is called. Defaults to 3.
    * `:bounce_wait_ms` — wait after `launchctl kickstart` before the
      post-bounce probe. Defaults to 5_000.
    * `:restart_wait_ms` — wait after restarting the remote daemon
      before the probe. Defaults to 10_000.
    * `:backoff_schedule_ms` — retry schedule used in `:unreachable`.
      Defaults to `[30_000, 120_000, 600_000, 1_800_000]`.
    * `:tripped_poll_floor_ms` — minimum passive-poll interval once the
      breaker has tripped (the remote's own `poll_interval_ms` still
      wins when larger). Defaults to 60_000; tests set it low to keep
      driving tripped remotes deterministically.
    * `:user_uid` — override the local GUI UID used for `launchctl`
      labels (tests). Defaults to `$UID` / `id -u`.
    * `:auto_poll` — whether to schedule the registry's background
      polling tick. Defaults to `true`; tests can set `false` and drive
      the registry deterministically with `poll_now/1`.
    * `:name` — GenServer name. Defaults to `__MODULE__`.
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Returns the cached snapshot map for every configured remote, keyed
  by remote name. Each value carries `:snapshot`, `:last_polled_at`,
  `:stale`, `:last_error`, and `:recovery`.

  An empty map means no remotes are configured (or the registry isn't
  running — callers tolerate this for graceful degradation).
  """
  @spec snapshots() :: %{String.t() => map()}
  def snapshots, do: snapshots(__MODULE__)

  @spec snapshots(GenServer.server()) :: %{String.t() => map()}
  def snapshots(server) do
    snapshots(server, RegistryCommon.read_timeout_ms())
  end

  @spec snapshots(GenServer.server(), non_neg_integer()) :: %{String.t() => map()}
  def snapshots(server, timeout_ms) when is_integer(timeout_ms) and timeout_ms >= 0 do
    if RegistryCommon.registry_alive?(server) do
      GenServer.call(server, :snapshots, timeout_ms)
    else
      %{}
    end
  end

  @doc """
  Returns one cached snapshot or `nil` when the remote isn't
  configured.
  """
  @spec snapshot(String.t()) :: map() | nil
  def snapshot(name), do: snapshot(__MODULE__, name)

  @spec snapshot(GenServer.server(), String.t()) :: map() | nil
  def snapshot(server, name) do
    if RegistryCommon.registry_alive?(server) do
      GenServer.call(server, {:snapshot, name}, RegistryCommon.read_timeout_ms())
    else
      nil
    end
  end

  @doc """
  Forces a synchronous poll cycle. Returns when every remote has
  been handled once. Used by tests to deterministically drive the
  registry.
  """
  @spec poll_now() :: :ok
  def poll_now, do: poll_now(__MODULE__)

  @spec poll_now(GenServer.server()) :: :ok
  def poll_now(server) do
    GenServer.call(server, :poll_now)
  end

  @doc """
  Manually resets a tripped circuit breaker, flipping the remote back
  to `:degraded` so the recovery cascade runs once more. Because the
  attempt counter is preserved, another full-cascade failure re-trips
  immediately — one manual reset buys exactly one cascade.

  Operators reach this through `shuttle reset <remote>` (see
  `Shuttle.CLI`), which POSTs `/api/v1/remotes/:name/reset`
  (`ShuttleWeb.RemoteController`) on the running daemon — the daemon is
  an escript, so there is no console to call this from directly.

  Returns `{:error, :not_tripped}` when the remote isn't tripped and
  `{:error, :unknown_remote}` when the name isn't configured.
  """
  @spec reset_breaker(String.t()) :: :ok | {:error, :not_tripped | :unknown_remote}
  def reset_breaker(name), do: reset_breaker(__MODULE__, name)

  @spec reset_breaker(GenServer.server(), String.t()) ::
          :ok | {:error, :not_tripped | :unknown_remote}
  def reset_breaker(server, name) do
    GenServer.call(server, {:reset_breaker, name})
  end

  # ── Server ──

  @impl true
  def init(opts) do
    remotes =
      opts
      |> Keyword.get(:remotes, Application.get_env(:shuttle, :remotes, []))
      |> RegistryCommon.normalize_remotes()

    client = Keyword.get(opts, :client, Shuttle.RemoteRegistry.Client.Default)
    runner = Keyword.get(opts, :runner, Runner.Default)
    tick_interval_ms = Keyword.get(opts, :tick_interval_ms, 1_000)
    failure_threshold = Keyword.get(opts, :failure_threshold, @default_failure_threshold)
    trip_threshold = Keyword.get(opts, :trip_threshold, @default_trip_threshold)
    bounce_wait_ms = Keyword.get(opts, :bounce_wait_ms, @default_bounce_wait_ms)
    restart_wait_ms = Keyword.get(opts, :restart_wait_ms, @default_restart_wait_ms)

    tripped_poll_floor_ms =
      Keyword.get(opts, :tripped_poll_floor_ms, @default_tripped_poll_floor_ms)

    backoff_schedule_ms =
      Keyword.get(opts, :backoff_schedule_ms, @default_backoff_schedule_ms)

    user_uid = Keyword.get(opts, :user_uid, current_uid())
    auto_poll = Keyword.get(opts, :auto_poll, true)

    Logger.info(
      "RemoteRegistry: configured #{length(remotes)} remote(s): " <>
        inspect(Enum.map(remotes, & &1.name))
    )

    snapshots =
      Map.new(remotes, fn remote ->
        {remote.name, initial_entry(remote)}
      end)

    state = %State{
      remotes: remotes,
      client: client,
      runner: runner,
      tick_interval_ms: tick_interval_ms,
      failure_threshold: failure_threshold,
      trip_threshold: trip_threshold,
      bounce_wait_ms: bounce_wait_ms,
      restart_wait_ms: restart_wait_ms,
      backoff_schedule_ms: backoff_schedule_ms,
      tripped_poll_floor_ms: tripped_poll_floor_ms,
      user_uid: user_uid,
      snapshots: snapshots
    }

    state =
      if remotes == [] or not auto_poll do
        state
      else
        RegistryCommon.schedule_tick(state, 0)
      end

    {:ok, state}
  end

  @impl true
  def handle_call(:snapshots, _from, state) do
    {:reply, build_snapshots_view(state), state}
  end

  def handle_call({:snapshot, name}, _from, state) do
    {:reply, build_one_view(state, name), state}
  end

  def handle_call({:reset_breaker, name}, _from, state) do
    case Map.get(state.snapshots, name) do
      nil ->
        {:reply, {:error, :unknown_remote}, state}

      %{recovery: %Recovery{state: :tripped} = recovery} = entry ->
        Logger.info("RemoteRegistry: #{name} circuit breaker manually reset; re-running cascade")

        entry =
          with_recovery(entry, %{
            recovery
            | state: :degraded,
              step: :bounce_tunnel,
              action_due_at: DateTime.utc_now(),
              next_retry_at: nil,
              last_action: "circuit breaker manually reset; re-running recovery cascade"
          })

        {:reply, :ok, %{state | snapshots: Map.put(state.snapshots, name, entry)}}

      _entry ->
        {:reply, {:error, :not_tripped}, state}
    end
  end

  def handle_call(:poll_now, _from, state) do
    state = poll_all(state)
    {:reply, :ok, state}
  end

  @impl true
  def handle_info({:tick, _token}, state) do
    state = poll_all(state)
    state = RegistryCommon.schedule_tick(state, state.tick_interval_ms)
    broadcast(state)
    {:noreply, state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ── Polling ──

  defp poll_all(%State{remotes: remotes} = state) do
    now = DateTime.utc_now()
    now_ms = DateTime.to_unix(now, :millisecond)

    new_snapshots =
      Enum.reduce(remotes, state.snapshots, fn remote, acc ->
        prev = Map.get(acc, remote.name, initial_entry(remote))
        next = poll_remote(prev, state, now, now_ms)
        Map.put(acc, remote.name, next)
      end)

    %{state | snapshots: new_snapshots}
  end

  defp poll_remote(%{recovery: %Recovery{} = recovery} = entry, state, now, now_ms) do
    cond do
      recovery_action_due?(recovery, now) ->
        run_recovery_step(entry, state, now)

      should_poll?(entry, state, now_ms) ->
        normal_probe(entry, state.client, state, now)

      true ->
        entry
    end
  end

  # `should_poll?` gates the next attempt on `last_attempt_at` (we tried
  # recently — back off) rather than `last_polled_at` (last *success*).
  # That way a permanently-down remote is retried at the configured
  # cadence without burning every tick.
  # `:tripped` keeps the cheap passive polling — decimated to the
  # tripped-poll floor — so the registry still observes the remote and
  # auto-heals on a successful probe; only recovery *actions* stop.
  defp should_poll?(%{recovery: %Recovery{state: recovery_state}}, _state, _now_ms)
       when recovery_state not in @cascade_inactive,
       do: false

  defp should_poll?(
         %{
           recovery: %Recovery{state: recovery_state},
           remote: %Remote{} = remote,
           last_attempt_at: %DateTime{} = last
         },
         %State{} = state,
         now_ms
       ) do
    interval_ms =
      case recovery_state do
        :tripped -> max(remote.poll_interval_ms, state.tripped_poll_floor_ms)
        _ -> remote.poll_interval_ms
      end

    now_ms - DateTime.to_unix(last, :millisecond) >= interval_ms
  end

  defp should_poll?(_, _state, _now_ms), do: true

  defp normal_probe(%{remote: %Remote{} = remote} = entry, client, state, now) do
    case fetch_snapshot(remote, client) do
      {:ok, snapshot} ->
        success_entry(entry, snapshot, now)

      {:error, reason} ->
        Logger.debug("RemoteRegistry: poll failed for #{remote.name}: #{inspect(reason)}")
        normal_failure_entry(entry, reason, state.failure_threshold, now)
    end
  end

  defp run_recovery_step(
         %{remote: %Remote{} = remote, recovery: %Recovery{} = recovery} = entry,
         state,
         now
       ) do
    case recovery.step do
      :bounce_tunnel ->
        case bounce_tunnel(remote, state.runner, state.user_uid) do
          :ok ->
            Logger.info("RemoteRegistry: #{remote.name} tunnel bounce requested")

            with_recovery(entry, %{
              recovery
              | state: :reviving,
                step: :probe_after_bounce,
                action_due_at: add_ms(now, state.bounce_wait_ms),
                last_action: "bounced tunnel",
                next_retry_at: nil
            })

          {:error, reason} ->
            Logger.warning(
              "RemoteRegistry: #{remote.name} tunnel bounce failed: #{format_error(reason)}"
            )

            with_recovery(entry, %{
              recovery
              | state: :reviving,
                step: :ssh_check,
                action_due_at: now,
                last_error: reason,
                last_action: "tunnel bounce failed"
            })
        end

      :probe_after_bounce ->
        case fetch_snapshot(remote, state.client) do
          {:ok, snapshot} ->
            Logger.info("RemoteRegistry: #{remote.name} recovered after tunnel bounce")
            success_entry(entry, snapshot, now)

          {:error, reason} ->
            Logger.warning(
              "RemoteRegistry: #{remote.name} still unhealthy after tunnel bounce: #{format_error(reason)}"
            )

            with_recovery(
              failure_entry(entry, reason, now),
              %{
                recovery
                | state: :reviving,
                  step: :ssh_check,
                  action_due_at: now,
                  last_error: reason,
                  last_action: "probe after tunnel bounce failed",
                  next_retry_at: nil
              }
            )
        end

      :ssh_check ->
        case ssh_check(remote, state.runner) do
          {:ok, %{session_present: true, http_healthy: true}} ->
            Logger.info(
              "RemoteRegistry: #{remote.name} remote daemon is healthy over SSH; retrying tunnel bounce"
            )

            with_recovery(entry, %{
              recovery
              | state: :reviving,
                step: :bounce_tunnel,
                action_due_at: now,
                last_action: "remote daemon healthy; retrying tunnel bounce"
            })

          {:ok, %{session_present: false}} ->
            Logger.info("RemoteRegistry: #{remote.name} remote daemon session absent; restarting")

            with_recovery(entry, %{
              recovery
              | state: :reviving,
                step: :restart_remote,
                action_due_at: now,
                last_action: "remote daemon absent; restarting"
            })

          {:ok, %{session_present: true, http_healthy: false}} ->
            Logger.info(
              "RemoteRegistry: #{remote.name} remote daemon unhealthy over SSH; restarting"
            )

            with_recovery(entry, %{
              recovery
              | state: :reviving,
                step: :restart_remote,
                action_due_at: now,
                last_action: "remote daemon unhealthy; restarting"
            })

          {:error, reason} ->
            Logger.warning(
              "RemoteRegistry: #{remote.name} SSH health check failed: #{format_error(reason)}"
            )

            with_recovery(
              failure_entry(entry, reason, now),
              enter_unreachable(
                recovery,
                "ssh check failed",
                reason,
                state.backoff_schedule_ms,
                now
              )
            )
        end

      :restart_remote ->
        case restart_remote(remote, state.runner) do
          :ok ->
            Logger.info("RemoteRegistry: #{remote.name} remote daemon restart requested")

            with_recovery(entry, %{
              recovery
              | state: :reviving,
                step: :probe_after_restart,
                action_due_at: add_ms(now, state.restart_wait_ms),
                last_action: "restarted remote daemon",
                next_retry_at: nil
            })

          {:error, reason} ->
            Logger.warning(
              "RemoteRegistry: #{remote.name} remote restart failed: #{format_error(reason)}"
            )

            with_recovery(
              failure_entry(entry, reason, now),
              enter_unreachable(
                recovery,
                "remote restart failed",
                reason,
                state.backoff_schedule_ms,
                now
              )
            )
        end

      :probe_after_restart ->
        case fetch_snapshot(remote, state.client) do
          {:ok, snapshot} ->
            Logger.info("RemoteRegistry: #{remote.name} recovered after remote restart")
            success_entry(entry, snapshot, now)

          {:error, reason} ->
            Logger.warning(
              "RemoteRegistry: #{remote.name} still unhealthy after remote restart: #{format_error(reason)}"
            )

            with_recovery(
              failure_entry(entry, reason, now),
              enter_unreachable(
                recovery,
                "probe after remote restart failed",
                reason,
                state.backoff_schedule_ms,
                now
              )
            )
        end

      :backoff_probe ->
        case fetch_snapshot(remote, state.client) do
          {:ok, snapshot} ->
            Logger.info("RemoteRegistry: #{remote.name} recovered during backoff probe")
            success_entry(entry, snapshot, now)

          {:error, reason} when recovery.attempt >= state.trip_threshold ->
            # N full cascade attempts have failed: trip the breaker.
            # Reviving a chronically-unhealthy remote (tmux kill +
            # shuttle-launch over SSH) only adds load — fall back to
            # passive polling until a probe succeeds or an operator
            # calls `reset_breaker/2`.
            Logger.warning(
              "RemoteRegistry: #{remote.name} circuit tripped after #{recovery.attempt} revive attempts; passive polling only"
            )

            with_recovery(
              failure_entry(entry, reason, now),
              %{
                recovery
                | state: :tripped,
                  step: nil,
                  action_due_at: nil,
                  next_retry_at: nil,
                  last_error:
                    "circuit tripped after #{recovery.attempt} revive attempts; passive polling only",
                  last_action: "circuit breaker tripped"
              }
            )

          {:error, reason} ->
            Logger.warning(
              "RemoteRegistry: #{remote.name} backoff probe failed; restarting recovery cascade"
            )

            with_recovery(
              failure_entry(entry, reason, now),
              %{
                recovery
                | state: :degraded,
                  step: :bounce_tunnel,
                  action_due_at: now,
                  attempt: recovery.attempt + 1,
                  consecutive_failures: state.failure_threshold,
                  last_error: reason,
                  last_action: "backoff probe failed; restarting recovery cascade",
                  next_retry_at: nil
              }
            )
        end

      _ ->
        entry
    end
  end

  defp recovery_action_due?(%Recovery{state: state}, _now) when state in @cascade_inactive,
    do: false

  defp recovery_action_due?(
         %Recovery{step: :backoff_probe, next_retry_at: %DateTime{} = next},
         now
       ) do
    DateTime.compare(now, next) != :lt
  end

  defp recovery_action_due?(%Recovery{action_due_at: %DateTime{} = due}, now) do
    DateTime.compare(now, due) != :lt
  end

  defp recovery_action_due?(%Recovery{step: step, action_due_at: nil}, _now)
       when step in [:bounce_tunnel, :ssh_check, :restart_remote],
       do: true

  defp recovery_action_due?(_, _now), do: false

  defp fetch_snapshot(%Remote{} = remote, client) do
    url = Remote.state_url(remote)

    case client.get(url, remote.request_timeout_ms) do
      {:ok, body} ->
        case Jason.decode(body) do
          {:ok, snapshot} when is_map(snapshot) ->
            {:ok, snapshot}

          _ ->
            Logger.debug("RemoteRegistry: malformed JSON from #{remote.name}")
            {:error, :malformed_json}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp success_entry(%{remote: remote}, snapshot, now) do
    %{
      snapshot: snapshot,
      last_polled_at: now,
      last_attempt_at: now,
      stale: false,
      last_error: nil,
      remote: remote,
      recovery: %Recovery{}
    }
  end

  # While tripped, passive probe failures just refresh the entry — the
  # breaker's message stays put and no cascade restarts. (A successful
  # probe goes through `success_entry/3`, which resets the breaker.)
  defp normal_failure_entry(
         %{recovery: %Recovery{state: :tripped}} = entry,
         reason,
         _threshold,
         now
       ) do
    failure_entry(entry, reason, now)
  end

  defp normal_failure_entry(%{recovery: %Recovery{} = recovery} = entry, reason, threshold, now) do
    failures = recovery.consecutive_failures + 1

    recovery =
      if failures >= threshold do
        Logger.warning(
          "RemoteRegistry: #{entry.remote.name} degraded after #{failures} consecutive failures; starting recovery"
        )

        %{
          recovery
          | state: :degraded,
            step: :bounce_tunnel,
            action_due_at: now,
            next_retry_at: nil,
            attempt: recovery.attempt + 1,
            consecutive_failures: failures,
            last_error: reason,
            last_action: "failure threshold reached; starting recovery cascade"
        }
      else
        %{recovery | consecutive_failures: failures, last_error: reason}
      end

    with_recovery(failure_entry(entry, reason, now), recovery)
  end

  defp failure_entry(
         %{remote: remote, snapshot: snapshot, last_polled_at: last_polled_at} = entry,
         reason,
         now
       ) do
    %{
      snapshot: snapshot,
      last_polled_at: last_polled_at,
      last_attempt_at: now,
      stale: true,
      last_error: reason,
      remote: remote,
      recovery: Map.get(entry, :recovery, %Recovery{})
    }
  end

  defp enter_unreachable(%Recovery{} = recovery, action, reason, backoff_schedule_ms, now) do
    wait_ms = next_backoff_ms(recovery, backoff_schedule_ms)

    %{
      recovery
      | state: :unreachable,
        step: :backoff_probe,
        action_due_at: nil,
        next_retry_at: add_ms(now, wait_ms),
        backoff_index: recovery.backoff_index + 1,
        last_error: reason,
        last_action: action
    }
  end

  defp next_backoff_ms(%Recovery{backoff_index: index}, schedule)
       when is_list(schedule) and schedule != [] do
    Enum.at(schedule, index, List.last(schedule))
  end

  defp next_backoff_ms(_recovery, _schedule), do: List.last(@default_backoff_schedule_ms)

  defp with_recovery(entry, %Recovery{} = recovery), do: Map.put(entry, :recovery, recovery)

  defp add_ms(%DateTime{} = dt, ms) when is_integer(ms) do
    DateTime.add(dt, ms, :millisecond)
  end

  # ── Recovery commands ──

  defp bounce_tunnel(%Remote{name: name}, runner, user_uid) do
    label = tunnel_label(name)
    target = "gui/#{user_uid}/#{label}"

    case runner.cmd("launchctl", ["kickstart", "-k", target], stderr_to_stdout: true) do
      {_out, 0} -> :ok
      {out, code} -> {:error, {:launchctl_failed, code, trim_output(out)}}
    end
  end

  defp ssh_check(%Remote{name: name}, runner) do
    script =
      [
        ~s(if tmux has-session -t shuttle-daemon 2>/dev/null || tmux -S "$HOME/.shuttle/tmux.sock" has-session -t shuttle-daemon 2>/dev/null; then echo session=present; else echo session=absent; fi),
        ~s(if curl -sf --max-time 3 http://127.0.0.1:4000/api/v1/state >/dev/null; then echo http=healthy; else echo http=unhealthy; fi)
      ]
      |> Enum.join("; ")

    case runner.cmd("ssh", ssh_args(name, script), stderr_to_stdout: true) do
      {out, 0} ->
        {:ok,
         %{
           session_present: String.contains?(out, "session=present"),
           http_healthy: String.contains?(out, "http=healthy"),
           output: trim_output(out)
         }}

      {out, code} ->
        {:error, {:ssh_check_failed, code, trim_output(out)}}
    end
  end

  # shuttle-launch itself kills and recreates the default-socket
  # shuttle-daemon session (single source of truth for session teardown),
  # including the legacy alt-socket sweep (~/.shuttle/tmux.sock — see
  # "Legacy socket sweep" in bin/shuttle-launch), and resolves the repo
  # from the state file bootstrap.sh wrote (~/.shuttle/repo), so revival
  # needs no SHUTTLE_DIR here. This SSH script is just the invocation.
  #
  # Each revive here resets the respawn loop's own backoff (kill + recreate
  # starts a fresh `--loop` process, so its in-shell `backoff` var restarts
  # at 2s) — that's fine because `trip_threshold` bounds how many times this
  # cascade may fire before the breaker trips, so the two rate-limiters
  # compose: the loop absorbs fast local crashes, the breaker caps how many
  # cascades an unreachable remote gets before we stop hammering it.
  defp restart_remote(%Remote{name: name}, runner) do
    script = ~s("$HOME/.local/bin/shuttle-launch")

    case runner.cmd("ssh", ssh_args(name, script), stderr_to_stdout: true) do
      {_out, 0} -> :ok
      {out, code} -> {:error, {:ssh_restart_failed, code, trim_output(out)}}
    end
  end

  defp ssh_args(host, script) do
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=#{@ssh_connect_timeout_s}",
      host,
      script
    ]
  end

  defp tunnel_label(name), do: "com.cailmdaley.shuttle-tunnel-#{name}"

  defp current_uid do
    case System.get_env("UID") do
      uid when is_binary(uid) and uid != "" ->
        uid

      _ ->
        case System.cmd("id", ["-u"], stderr_to_stdout: true) do
          {out, 0} -> String.trim(out)
          _ -> "0"
        end
    end
  end

  defp trim_output(output) when is_binary(output) do
    output
    |> String.trim()
    |> case do
      "" -> nil
      value -> value
    end
  end

  defp format_error(nil), do: "unknown"
  defp format_error(reason) when is_binary(reason), do: reason
  defp format_error(reason) when is_atom(reason), do: Atom.to_string(reason)
  defp format_error(reason), do: inspect(reason)

  # ── Views ──

  defp build_snapshots_view(%State{} = state) do
    now = DateTime.utc_now()

    Map.new(state.snapshots, fn {name, entry} ->
      {name, view_entry(entry, now)}
    end)
  end

  defp build_one_view(%State{} = state, name) do
    case Map.get(state.snapshots, name) do
      nil -> nil
      entry -> view_entry(entry, DateTime.utc_now())
    end
  end

  defp view_entry(%{remote: remote} = entry, now) do
    %{
      snapshot: entry.snapshot,
      last_polled_at: entry.last_polled_at,
      stale: Remote.stale?(remote, entry.last_polled_at, now),
      last_error: entry.last_error,
      recovery: recovery_view(Map.get(entry, :recovery, %Recovery{}))
    }
  end

  defp recovery_view(%Recovery{} = recovery) do
    %{
      state: recovery.state,
      attempt: recovery.attempt,
      last_error: recovery.last_error,
      last_action: recovery.last_action,
      next_retry_at: recovery.next_retry_at
    }
  end

  defp broadcast(%State{} = state) do
    if Process.whereis(Shuttle.PubSub) do
      Phoenix.PubSub.broadcast(
        Shuttle.PubSub,
        @pubsub_topic,
        {:remote_snapshots, build_snapshots_view(state)}
      )
    end

    :ok
  end

  # ── Config normalization ──

  defp initial_entry(%Remote{} = remote) do
    %{
      snapshot: nil,
      last_polled_at: nil,
      last_attempt_at: nil,
      stale: true,
      last_error: nil,
      remote: remote,
      recovery: %Recovery{}
    }
  end
end

defmodule Shuttle.RemoteRegistry.Client do
  @moduledoc """
  Behaviour for remote daemon HTTP requests. Default implementation
  wraps `:httpc`; tests substitute a stub via the `:client` opt.

  `get/2` is the read transport the registries poll with. `post/4` is the
  write transport `Shuttle.Transition` forwards a cross-host transition with —
  it returns the remote's status so the local daemon can relay it verbatim,
  rather than collapsing every non-200 to `{:error, _}` the way `get/2` does.
  """

  @callback get(url :: String.t(), timeout_ms :: non_neg_integer()) ::
              {:ok, body :: String.t()} | {:error, term()}

  @callback get(
              url :: String.t(),
              req_headers :: [{String.t(), String.t()}],
              timeout_ms :: non_neg_integer()
            ) ::
              {:ok, status :: non_neg_integer(), resp_headers :: [{String.t(), String.t()}],
               body :: String.t()}
              | {:error, term()}

  @callback post(
              url :: String.t(),
              body :: String.t(),
              content_type :: String.t(),
              timeout_ms :: non_neg_integer()
            ) ::
              {:ok, status :: non_neg_integer(), body :: String.t()} | {:error, term()}

  @callback get_file(url :: String.t(), timeout_ms :: non_neg_integer()) ::
              {:ok, status :: non_neg_integer(), content_type :: String.t(), body :: binary()}
              | {:error, term()}

  # Only the write transport (Transition forwarding) needs post/4, and only the
  # file-bytes forward (`OriginRouter.forward_get/4`) needs get_file/2; the
  # read-only registry stubs implement get/2 alone. get/3 is the conditional-fetch
  # transport (`If-None-Match` → 304) the fiber feed uses; a client without it
  # falls back to unconditional get/2.
  @optional_callbacks post: 4, get_file: 2, get: 3
end

defmodule Shuttle.RemoteRegistry.Client.Default do
  @moduledoc false
  @behaviour Shuttle.RemoteRegistry.Client

  @impl true
  def get(url, timeout_ms) when is_binary(url) and is_integer(timeout_ms) do
    {:ok, _} = Application.ensure_all_started(:inets)
    {:ok, _} = Application.ensure_all_started(:ssl)

    request = {String.to_charlist(url), []}
    http_opts = [{:timeout, timeout_ms}, {:connect_timeout, timeout_ms}]

    # `body_format: :binary` returns the response body as a raw binary. Without
    # it, httpc returns a charlist of *bytes*, and `List.to_string/1` then reads
    # each byte as a Unicode codepoint and re-UTF-8-encodes it — double-encoding
    # every multibyte char (— × é …). ASCII survives (< 128), so the corruption
    # hides until a special character appears. Keep this binary-safe like get_file/2.
    case :httpc.request(:get, request, http_opts, body_format: :binary) do
      {:ok, {{_, 200, _}, _headers, body}} ->
        {:ok, body}

      {:ok, {{_, status, _}, _headers, _body}} ->
        {:error, {:http_status, status}}

      {:error, reason} ->
        {:error, reason}
    end
  rescue
    e -> {:error, {:exception, Exception.message(e)}}
  end

  # Conditional GET: send request headers (the fiber feed sends `If-None-Match`
  # with the last etag) and return the raw status + response headers so the
  # caller can treat 304 as "unchanged". Binary-safe like get/2.
  @impl true
  def get(url, req_headers, timeout_ms)
      when is_binary(url) and is_list(req_headers) and is_integer(timeout_ms) do
    {:ok, _} = Application.ensure_all_started(:inets)
    {:ok, _} = Application.ensure_all_started(:ssl)

    headers = Enum.map(req_headers, fn {k, v} -> {String.to_charlist(k), String.to_charlist(v)} end)
    request = {String.to_charlist(url), headers}
    http_opts = [{:timeout, timeout_ms}, {:connect_timeout, timeout_ms}]

    case :httpc.request(:get, request, http_opts, body_format: :binary) do
      {:ok, {{_, status, _}, resp_headers, body}} ->
        {:ok, status, normalize_headers(resp_headers), body}

      {:error, reason} ->
        {:error, reason}
    end
  rescue
    e -> {:error, {:exception, Exception.message(e)}}
  end

  # httpc returns header keys/values as charlists; normalize to lowercased-key
  # string tuples so the caller reads `etag` case-insensitively.
  defp normalize_headers(headers) do
    Enum.map(headers, fn {k, v} -> {k |> to_string() |> String.downcase(), to_string(v)} end)
  end

  @impl true
  def post(url, body, content_type, timeout_ms)
      when is_binary(url) and is_binary(body) and is_binary(content_type) and is_integer(timeout_ms) do
    {:ok, _} = Application.ensure_all_started(:inets)
    {:ok, _} = Application.ensure_all_started(:ssl)

    request =
      {String.to_charlist(url), [], String.to_charlist(content_type), body}

    http_opts = [{:timeout, timeout_ms}, {:connect_timeout, timeout_ms}]

    case :httpc.request(:post, request, http_opts, body_format: :binary) do
      {:ok, {{_, status, _}, _headers, resp_body}} ->
        {:ok, status, resp_body}

      {:error, reason} ->
        {:error, reason}
    end
  rescue
    e -> {:error, {:exception, Exception.message(e)}}
  end

  # Binary-safe file fetch used by `OriginRouter.forward_get/4`: `body_format:
  # :binary` keeps image/PDF bytes intact (unlike `get/2`, which is text-only),
  # and the response carries the remote's status + content-type so the local
  # daemon can relay them verbatim. Any non-200 (404, etc.) is relayed too —
  # the kanban shows the remote's own "file not found", not a tunnel error.
  @impl true
  def get_file(url, timeout_ms) when is_binary(url) and is_integer(timeout_ms) do
    {:ok, _} = Application.ensure_all_started(:inets)
    {:ok, _} = Application.ensure_all_started(:ssl)

    request = {String.to_charlist(url), []}
    http_opts = [{:timeout, timeout_ms}, {:connect_timeout, timeout_ms}]

    case :httpc.request(:get, request, http_opts, body_format: :binary) do
      {:ok, {{_, status, _}, headers, body}} ->
        {:ok, status, content_type_header(headers), body}

      {:error, reason} ->
        {:error, reason}
    end
  rescue
    e -> {:error, {:exception, Exception.message(e)}}
  end

  # httpc returns headers as charlist tuples; pull content-type (case-insensitive)
  # and fall back to octet-stream so the relayed response always has a type.
  defp content_type_header(headers) do
    Enum.find_value(headers, "application/octet-stream", fn {key, value} ->
      if String.downcase(to_string(key)) == "content-type", do: to_string(value)
    end)
  end
end
