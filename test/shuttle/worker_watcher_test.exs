defmodule Shuttle.WorkerWatcherTest do
  use ExUnit.Case

  alias Shuttle.WorkerWatcher
  alias Shuttle.Dispatcher

  # ── Mock Runner ──

  defmodule MockRunner do
    @behaviour Shuttle.Runner

    use Agent

    def start_link(_ \\ []) do
      Agent.start_link(fn -> %{sessions: MapSet.new()} end, name: __MODULE__)
    end

    def reset, do: Agent.update(__MODULE__, fn _ -> %{sessions: MapSet.new()} end)

    def add_session(s),
      do: Agent.update(__MODULE__, &%{&1 | sessions: MapSet.put(&1.sessions, s)})

    def remove_session(s),
      do: Agent.update(__MODULE__, &%{&1 | sessions: MapSet.delete(&1.sessions, s)})

    @impl true
    def cmd("tmux", ["has-session", "-t", session], _opts) do
      sessions = Agent.get(__MODULE__, & &1.sessions)

      if tmux_session_exists?(sessions, session) do
        {"", 0}
      else
        {"can't find session", 1}
      end
    end

    def cmd(_, _, _), do: {"", 0}

    defp tmux_session_exists?(sessions, "=" <> session), do: MapSet.member?(sessions, session)

    defp tmux_session_exists?(sessions, session) do
      Enum.any?(sessions, &(&1 == session or String.starts_with?(&1, session <> "/")))
    end
  end

  # ── Flakey Runner ──
  # Like MockRunner but supports injecting N transient failures: the next N
  # `tmux has-session` calls return non-zero even if the session is alive.
  # Used to test that the watcher tolerates transient check failures without
  # prematurely declaring the worker dead.

  defmodule FlakeyRunner do
    @behaviour Shuttle.Runner

    use Agent

    def start_link(_ \\ []) do
      Agent.start_link(
        fn -> %{sessions: MapSet.new(), inject_failures: 0} end,
        name: __MODULE__
      )
    end

    def reset,
      do: Agent.update(__MODULE__, fn _ -> %{sessions: MapSet.new(), inject_failures: 0} end)

    def add_session(s),
      do: Agent.update(__MODULE__, &%{&1 | sessions: MapSet.put(&1.sessions, s)})

    def remove_session(s),
      do: Agent.update(__MODULE__, &%{&1 | sessions: MapSet.delete(&1.sessions, s)})

    # Make the next `n` tmux has-session calls return non-zero regardless
    # of session state. Once the counter is exhausted, normal behaviour resumes.
    def inject_failures(n),
      do: Agent.update(__MODULE__, &%{&1 | inject_failures: n})

    @impl true
    def cmd("tmux", ["has-session", "-t", session], _opts) do
      Agent.get_and_update(__MODULE__, fn state ->
        cond do
          state.inject_failures > 0 ->
            # Transient failure: return non-zero even if the session is alive.
            {{"transient tmux error", 1}, %{state | inject_failures: state.inject_failures - 1}}

          tmux_session_exists?(state.sessions, session) ->
            {{"", 0}, state}

          true ->
            {{"can't find session", 1}, state}
        end
      end)
    end

    def cmd(_, _, _), do: {"", 0}

    defp tmux_session_exists?(sessions, "=" <> session), do: MapSet.member?(sessions, session)

    defp tmux_session_exists?(sessions, session) do
      Enum.any?(sessions, &(&1 == session or String.starts_with?(&1, session <> "/")))
    end
  end

  # ── Setup ──

  setup do
    start_supervised!(MockRunner)
    start_supervised!(FlakeyRunner)
    MockRunner.reset()
    FlakeyRunner.reset()
    :ok
  end

  # Poll a condition until it holds (or the attempts run out). Used instead of a
  # fixed Process.sleep so timing assertions wait for the OBSERVABLE event (the
  # watcher actually dying / a log line landing) rather than guessing how long
  # heartbeat detection takes — which, under any scheduler jitter, overran the
  # old fixed margins. ~2s ceiling; returns as soon as the condition is true, so
  # passing tests pay nothing.
  defp wait_until(fun, attempts \\ 80)
  defp wait_until(fun, 0), do: fun.()

  defp wait_until(fun, attempts) do
    if fun.() do
      true
    else
      Process.sleep(25)
      wait_until(fun, attempts - 1)
    end
  end

  # ── Tests ──

  test "watcher children are temporary" do
    assert WorkerWatcher.child_spec([]).restart == :temporary
  end

  test "watcher detects session death and notifies poller" do
    session = Dispatcher.session_name("tests/haiku")
    MockRunner.add_session(session)

    {:ok, watcher} =
      WorkerWatcher.start_link(
        fiber_id: "tests/haiku",
        session: session,
        poller: self(),
        runner: MockRunner,
        heartbeat_interval_ms: 50
      )

    # Wait for a few heartbeats
    Process.sleep(120)

    # Session still alive — no exit message
    refute_receive {:worker_exited, _, _, _}, 50

    # Kill the session
    MockRunner.remove_session(session)
    Process.sleep(120)

    # Should receive exit notification
    assert_receive {:worker_exited, "tests/haiku", :normal_exit, false}, 1000

    # Watcher should have stopped
    assert wait_until(fn -> not Process.alive?(watcher) end)
  end

  test "watcher exits immediately if session does not exist on init" do
    assert {:error, :normal} =
             WorkerWatcher.start_link(
               fiber_id: "tests/missing",
               session: Dispatcher.session_name("tests/missing"),
               poller: self(),
               runner: MockRunner,
               heartbeat_interval_ms: 50
             )

    assert_receive {:worker_exited, "tests/missing", :session_not_found, _}, 1000
  end

  test "watcher can be stopped gracefully" do
    session = Dispatcher.session_name("tests/haiku")
    MockRunner.add_session(session)

    {:ok, watcher} =
      WorkerWatcher.start_link(
        fiber_id: "tests/haiku",
        session: session,
        poller: self(),
        runner: MockRunner,
        heartbeat_interval_ms: 50
      )

    assert Process.alive?(watcher)
    WorkerWatcher.stop(watcher)
    Process.sleep(50)
    assert wait_until(fn -> not Process.alive?(watcher) end)
  end

  # ── Flake robustness tests ─────────────────────────────────────────────────
  # Liveness is classified three ways by Shuttle.Tmux (see tmux_test.exs): exit 0
  # is :alive, tmux's own absence message ("can't find session") is :gone, and any
  # OTHER non-zero is :unknown. Only :gone counts toward death; :unknown is an
  # inconclusive read (server hiccup, PATH, fork-under-load) that must NEVER kill
  # a live worker — the false-kill that re-dispatches a healthy fiber and drives
  # the resume storm. FlakeyRunner's injected "transient tmux error" is :unknown;
  # removing the session yields "can't find session" → :gone.

  test "watcher survives transient tmux failures without declaring worker dead" do
    session = Dispatcher.session_name("tests/flaky")
    FlakeyRunner.add_session(session)

    {:ok, watcher} =
      WorkerWatcher.start_link(
        fiber_id: "tests/flaky",
        session: session,
        poller: self(),
        runner: FlakeyRunner,
        heartbeat_interval_ms: 50,
        # 3 consecutive failures required to declare the worker dead.
        max_consecutive_failures: 3
      )

    # Inject 2 transient failures — below the threshold of 3.
    # The session is still alive in FlakeyRunner.sessions.
    FlakeyRunner.inject_failures(2)

    # Wait for those 2 failures to be consumed (≥ 2 × 50ms heartbeats).
    Process.sleep(200)

    # Watcher should NOT have exited: 2 < max_consecutive_failures.
    refute_receive {:worker_exited, _, _, _}, 50
    assert Process.alive?(watcher)

    # Now truly remove the session (sustained failure).
    FlakeyRunner.remove_session(session)

    # Wait for max_consecutive_failures × heartbeat_interval to elapse.
    Process.sleep(300)

    # Now the watcher should declare the worker dead.
    assert_receive {:worker_exited, "tests/flaky", :normal_exit, false}, 1000
    assert wait_until(fn -> not Process.alive?(watcher) end)
  end

  test "inconclusive (:unknown) checks never declare death, even well past the threshold" do
    # The stronger guarantee: an inconclusive read is not a death signal AT ALL,
    # so far more than max_consecutive_failures of them in a row still can't kill
    # a live worker. Reverting Shuttle.Tmux's :unknown carve-out (treating any
    # non-zero as death) re-arms the false-kill-then-resume storm.
    session = Dispatcher.session_name("tests/inconclusive")
    FlakeyRunner.add_session(session)

    {:ok, watcher} =
      WorkerWatcher.start_link(
        fiber_id: "tests/inconclusive",
        session: session,
        poller: self(),
        runner: FlakeyRunner,
        heartbeat_interval_ms: 20,
        max_consecutive_failures: 3
      )

    # 12 inconclusive checks in a row — 4× the death threshold.
    FlakeyRunner.inject_failures(12)
    Process.sleep(400)

    refute_receive {:worker_exited, _, _, _}, 50
    assert Process.alive?(watcher)

    # A confirmed absence still kills it, proving death detection is intact.
    FlakeyRunner.remove_session(session)
    assert_receive {:worker_exited, "tests/inconclusive", :normal_exit, false}, 1000
    assert wait_until(fn -> not Process.alive?(watcher) end)
  end

  test "watcher resets failure counter after recovery" do
    session = Dispatcher.session_name("tests/recover")
    FlakeyRunner.add_session(session)

    {:ok, watcher} =
      WorkerWatcher.start_link(
        fiber_id: "tests/recover",
        session: session,
        poller: self(),
        runner: FlakeyRunner,
        heartbeat_interval_ms: 50,
        max_consecutive_failures: 3
      )

    # Inject 2 transient failures, then let it recover.
    FlakeyRunner.inject_failures(2)
    Process.sleep(250)

    # Still alive after 2 failures and recovery.
    refute_receive {:worker_exited, _, _, _}, 50
    assert Process.alive?(watcher)

    # Now inject 2 more failures — the counter must have reset to 0 after
    # the recovery, so 2 < 3 is still safe.
    FlakeyRunner.inject_failures(2)
    Process.sleep(250)

    refute_receive {:worker_exited, _, _, _}, 50
    assert Process.alive?(watcher)

    # Sustained failure: remove session so all future checks fail.
    FlakeyRunner.remove_session(session)
    Process.sleep(300)

    assert_receive {:worker_exited, "tests/recover", :normal_exit, false}, 1000
    assert wait_until(fn -> not Process.alive?(watcher) end)
  end

  # Regression: WorkerWatcher used to capture self() (a pid) at start time
  # via Poller.start_watcher's `poller: self()` opt. If the Poller's
  # supervisor restarted that process, the watcher's stored pid went stale,
  # `send/2` to a dead pid was silently dropped, and `state.running` ghosted
  # forever. The fix in Poller.init/1 captures the registered name (atom)
  # into State.self_ref and passes that as `:poller`; `send/2` resolves the
  # atom at delivery time. A corollary: when the registered name has no live
  # process (test teardown, crash-loop window), `send/2` raises ArgumentError
  # — the watcher must trap+log, not crash.
  # See [[ai-futures/shuttle/finding-ghost-workers-stuck-running]].
  test "watcher accepts a registered atom as :poller and delivers via name" do
    session = Dispatcher.session_name("tests/named-poller")
    MockRunner.add_session(session)

    # Register the test process under a unique name so send/2 can resolve it
    # by atom — mirroring how production passes Shuttle.Poller (the registered
    # name of the running daemon) rather than its pid.
    name = :"watcher_named_poller_#{System.unique_integer([:positive])}"
    Process.register(self(), name)

    {:ok, watcher} =
      WorkerWatcher.start_link(
        fiber_id: "tests/named-poller",
        session: session,
        poller: name,
        runner: MockRunner,
        heartbeat_interval_ms: 50
      )

    MockRunner.remove_session(session)
    Process.sleep(200)

    assert_receive {:worker_exited, "tests/named-poller", :normal_exit, false}, 1000
    assert wait_until(fn -> not Process.alive?(watcher) end)
  end

  test "watcher logs and continues when registered :poller name has no live process" do
    session = Dispatcher.session_name("tests/dead-poller")
    MockRunner.add_session(session)

    # Use an atom that is NOT registered to any process. send/2 to an
    # unregistered name raises ArgumentError; the watcher must trap and log.
    dead_name = :"unregistered_poller_#{System.unique_integer([:positive])}"

    {:ok, watcher} =
      WorkerWatcher.start_link(
        fiber_id: "tests/dead-poller",
        session: session,
        poller: dead_name,
        runner: MockRunner,
        heartbeat_interval_ms: 50
      )

    log =
      ExUnit.CaptureLog.capture_log(fn ->
        MockRunner.remove_session(session)
        # Wait for the watcher to actually finish (it logs the failed delivery
        # right before stopping), not a fixed sleep that can end before the
        # heartbeat-detection + log under load.
        wait_until(fn -> not Process.alive?(watcher) end)
      end)

    assert log =~ "could not deliver :worker_exited"
    assert log =~ "tests/dead-poller"
    # Watcher still stops normally; the failure is bounded to the send.
    assert wait_until(fn -> not Process.alive?(watcher) end)
  end
end
