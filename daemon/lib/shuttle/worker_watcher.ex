defmodule Shuttle.WorkerWatcher do
  @moduledoc """
  Per-worker GenServer that observes a backend's ownership and liveness.

  Terminal workers use tmux liveness; app conversations use their durable
  ownership record. An idle app conversation remains assigned until a handoff,
  fiber closure or explicit stop releases it. Poller retires confirmed unloaded
  or missing threads; the watcher never reloads them. It reports confirmed absence to Poller;
  uncertainty never creates a replacement worker.
  """

  # A watcher is bound to one concrete backend worker. Once that session exits,
  # or the owning poller/test runner is gone, restarting the watcher only
  # replays stale notifications and can crash-loop the app-wide supervisor.
  use GenServer, restart: :temporary
  require Logger

  @default_heartbeat_interval_ms 5_000
  @default_max_consecutive_failures 3

  # ── Client ──

  @doc """
  Starts a watcher for the given fiber and backend worker.

  Options:
    * `:fiber_id` — required. The fiber being watched.
    * `:session` — required. The terminal session name or durable app worker reference.
    * `:poller` — required. The Poller to notify on exit: its registered name,
      or a pid.
    * `:runner` — module implementing `Shuttle.Runner` behavior. Defaults to `Shuttle.Runner.Default`.
    * `:heartbeat_interval_ms` — interval between backend liveness checks. Default 5_000.
    * `:max_consecutive_failures` — how many consecutive confirmed absences are
      tolerated before declaring the worker dead, so a transient tmux hiccup
      never reads as a death. Default 3, which means a truly dead session is
      detected within `3 × heartbeat_interval_ms`.
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  @doc """
  Stops the watcher gracefully.
  """
  @spec stop(GenServer.server()) :: :ok
  def stop(server) do
    GenServer.stop(server, :normal)
  end

  @doc "Rebind this observer without changing or stopping its backend worker."
  def migrate(server, fiber_id, session, uid, store) do
    GenServer.call(server, {:migrate, fiber_id, session, uid, store}, :infinity)
  end

  # ── Server ──

  @impl true
  def init(opts) do
    Shuttle.Env.adopt_callers(Keyword.get(opts, :callers, []))
    fiber_id = Keyword.fetch!(opts, :fiber_id)
    session = Keyword.fetch!(opts, :session)
    poller = Keyword.fetch!(opts, :poller)
    runner = Keyword.get(opts, :runner, Shuttle.Runner.Default)
    heartbeat_interval = Keyword.get(opts, :heartbeat_interval_ms, @default_heartbeat_interval_ms)

    max_consecutive_failures =
      Keyword.get(opts, :max_consecutive_failures, @default_max_consecutive_failures)

    state = %{
      fiber_id: fiber_id,
      session: session,
      poller: poller,
      runner: runner,
      heartbeat_interval_ms: heartbeat_interval,
      max_consecutive_failures: max_consecutive_failures,
      consecutive_failures: 0,
      heartbeat_timer_ref: nil,
      app_projection: app_worker_projection(Shuttle.AppWorkers.id(session))
    }

    # On init, check if the session exists. `:gone` (confirmed absent) is the
    # only result that exits immediately; `:unknown` (an inconclusive tmux error)
    # starts the heartbeat and re-checks rather than killing a possibly-live
    # worker on a single flaky read.
    case check_session(state) do
      :gone ->
        notify_poller(state, :session_not_found)
        {:stop, :normal}

      _alive_or_unknown ->
        ref = Process.send_after(self(), :heartbeat, heartbeat_interval)
        {:ok, %{state | heartbeat_timer_ref: ref}}
    end
  end

  @impl true
  def handle_call({:migrate, fiber_id, session, _uid, _store}, _from, state) do
    {:reply, :ok,
     %{
       state
       | fiber_id: fiber_id,
         session: session,
         consecutive_failures: 0,
         app_projection: app_worker_projection(Shuttle.AppWorkers.id(session))
     }}
  end

  @impl true
  def handle_info(:heartbeat, state) do
    state = observe_app(state)

    case check_session(state) do
      :alive ->
        ref = Process.send_after(self(), :heartbeat, state.heartbeat_interval_ms)

        {:noreply, %{state | heartbeat_timer_ref: ref, consecutive_failures: 0}}

      # Confirmed absent — count toward death. `max_consecutive_failures` strikes
      # of `:gone` in a row (a real, persistent absence) declares the worker dead.
      :gone ->
        failures = state.consecutive_failures + 1

        if failures >= state.max_consecutive_failures do
          Logger.info("Worker session ended: fiber_id=#{state.fiber_id} session=#{state.session}")
          notify_poller(state, :normal_exit)
          {:stop, :normal, state}
        else
          Logger.debug(
            "Heartbeat: session absent #{failures}/#{state.max_consecutive_failures} " <>
              "for #{state.fiber_id} — will retry"
          )

          ref = Process.send_after(self(), :heartbeat, state.heartbeat_interval_ms)
          {:noreply, %{state | heartbeat_timer_ref: ref, consecutive_failures: failures}}
        end

      # Inconclusive (tmux errored for a non-absence reason — server hiccup, PATH,
      # fork-under-load). NOT a death signal: hold the strike count where it is
      # (don't advance toward death, don't reset genuine progress) and re-check.
      # This is the load-bearing change against the false-kill-then-resume storm:
      # a live worker is never declared dead on a flaky `has-session`.
      :unknown ->
        Logger.debug(
          "Heartbeat: inconclusive tmux check for #{state.fiber_id} " <>
            "(#{state.consecutive_failures}/#{state.max_consecutive_failures} absences held) — will retry"
        )

        ref = Process.send_after(self(), :heartbeat, state.heartbeat_interval_ms)
        {:noreply, %{state | heartbeat_timer_ref: ref}}
    end
  end

  # ── Internal ──

  defp observe_app(state) do
    id = Shuttle.AppWorkers.id(state.session)

    case Shuttle.WorkerBackend.observe(state.session) do
      :missing ->
        notify_poller_message(state, {:app_worker_missing, state.fiber_id, state.session})

      _ ->
        :ok
    end

    projection = app_worker_projection(id)

    if state.app_projection != projection and projection != nil do
      notify_poller_message(state, {:app_worker_observed, state.fiber_id, state.session})
    end

    %{state | app_projection: projection}
  end

  defp app_worker_projection(id) when is_binary(id) do
    case Shuttle.AppWorkers.get(id) do
      {:ok, record} ->
        Map.take(record, [
          "launch_state",
          "remote_phase",
          "phase_changed_at",
          "surface",
          "terminal_tmux",
          "transcript_session_uuid",
          "project_id",
          "terminal_error",
          "backend_error"
        ])

      _ ->
        nil
    end
  end

  defp app_worker_projection(_), do: nil

  defp notify_poller_message(state, message) do
    send(state.poller, message)
  rescue
    ArgumentError -> :ok
  end

  defp check_session(state), do: Shuttle.WorkerBackend.session_status(state.runner, state.session)

  defp notify_poller(state, reason) do
    # state.poller is the Poller's registered name (atom) in production —
    # `send/2` resolves it at delivery time, so this survives a Poller
    # supervisor restart. When unresolved (crash-loop window, or test
    # tearing the poller down), `send/2` raises ArgumentError; we trap and
    # log so the watcher's exit notification isn't silently dropped — a
    # dropped one would leave the worker in `state.running` forever.
    try do
      send(state.poller, {:worker_exited, state.fiber_id, self(), state.session, reason})
    rescue
      ArgumentError ->
        Logger.error(
          "WorkerWatcher could not deliver :worker_exited for #{state.fiber_id}: " <>
            "poller #{inspect(state.poller)} not registered. " <>
            "state.running may ghost until next dispatch reconcile."
        )
    end
  end
end
