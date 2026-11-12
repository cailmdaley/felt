defmodule Shuttle.PollerCycleTest do
  # The Poller: poll-cycle responsiveness, stall watchdogs and eligibility gates.
  use Shuttle.Test.PollerCase, async: true

  test "snapshot remains responsive while poll cycle is reading felt" do
    fiber = make_fiber("tests/slow-felt-read")
    MockRunner.set_fiber("tests/slow-felt-read", fiber)
    MockRunner.set_shuttle("tests/slow-felt-read", oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_slow_felt_snapshot,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # The cycle under test is held inside its listing until the snapshot has
    # been answered, so the snapshot can only have been served while that
    # same read was in flight.
    settle_poller!(poller)
    MockRunner.hold_ls()
    send(poller, :run_poll_cycle)
    assert_receive {:ls_held, reader}

    %{poll_token: token, poll_cycles: cycles} = :sys.get_state(poller, @state_timeout)
    assert is_map(Poller.snapshot(poller, 30_000))

    state = :sys.get_state(poller, @state_timeout)
    assert state.poll_check_in_progress
    assert state.poll_token == token
    assert state.poll_cycles == cycles

    send(reader, :release_ls)
    assert wait_until(fn -> :sys.get_state(poller, @state_timeout).poll_cycles > cycles end)
  end

  test "a completed poll cycle cancels its stall watchdog" do
    # A cycle's read is held to catch its watchdog armed; the watchdog itself
    # is far longer than the test, so a timer that reads as gone after the
    # cycle completes was cancelled, not expired. (An empty store skips its
    # listing, so the store carries a fiber to list.)
    fiber = make_fiber("tests/watchdog-completion", %{"status" => "closed"})
    MockRunner.set_fiber("tests/watchdog-completion", fiber)
    MockRunner.set_shuttle("tests/watchdog-completion", oneshot_shuttle(), "closed")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_stall_watchdog_completion,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        stall_timeout_ms: 600_000,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    cycles = :sys.get_state(poller, @state_timeout).poll_cycles
    MockRunner.hold_ls()
    send(poller, :run_poll_cycle)
    assert_receive {:ls_held, reader}

    watchdog = :sys.get_state(poller, @state_timeout).poll_stall_timer_ref
    assert is_integer(Process.read_timer(watchdog))

    send(reader, :release_ls)
    assert wait_until(fn -> :sys.get_state(poller, @state_timeout).poll_cycles > cycles end)
    assert Process.read_timer(watchdog) == false
    state = :sys.get_state(poller, @state_timeout)
    assert state.poll_check_in_progress == false
    assert state.poll_token == nil
    assert state.poll_task_pid == nil
    assert state.poll_stall_timer_ref == nil

    await_publication!(poller)
    health = Poller.snapshot(poller).poll_health
    assert health.state == "idle"
    assert health.stall_timeout_ms == 600_000
    assert health.full_scan_budget_ms == 10_000
    assert health.stall_timeout_ms < :sys.get_state(poller, @state_timeout).full_scan_timeout_ms
    assert health.discovery[MockRunner.felt_root()].mode == :full
    assert health.stalls == 0
    assert health.last_stalled_at == nil
  end

  test "repeated stalled reads advance the poller and supersede late replies" do
    fiber = make_fiber("tests/stalled-read")
    MockRunner.set_fiber("tests/stalled-read", fiber)
    MockRunner.set_shuttle("tests/stalled-read", oneshot_shuttle())
    MockRunner.set_ls_delay(2_000)
    Env.put_app_env(:cmd_timeout_ms, 1)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_stall_watchdog_repeated,
        runner: MockRunner,
        poll_interval_ms: 20,
        stall_timeout_ms: 30,
        full_scan_timeout_ms: 1,
        felt_stores: [MockRunner.felt_root()]
      )

    assert wait_until(fn -> is_pid(:sys.get_state(poller, @state_timeout).poll_task_pid) end)

    %{poll_task_pid: first_task, poll_token: abandoned_token} =
      :sys.get_state(poller, @state_timeout)

    assert wait_until(fn ->
             state = :sys.get_state(poller, @state_timeout)

             state.poll_stalls >= 1 and is_pid(state.poll_task_pid) and
               state.poll_task_pid != first_task
           end)

    assert wait_until(fn -> not Process.alive?(first_task) end)

    second_task = :sys.get_state(poller, @state_timeout).poll_task_pid

    assert wait_until(fn ->
             state = :sys.get_state(poller, @state_timeout)

             state.poll_stalls >= 2 and is_pid(state.poll_task_pid) and
               state.poll_task_pid != second_task
           end)

    assert wait_until(fn -> not Process.alive?(second_task) end)

    assert wait_until(fn -> Poller.snapshot(poller).poll_health.stalls >= 2 end)
    health = Poller.snapshot(poller).poll_health
    assert health.stalls >= 2
    assert is_binary(health.last_stalled_at)

    # Hold one cycle in flight for the rest of the test: its read outlasts the
    # test and its watchdog does not fire, so the current token cannot move
    # under the assertions. Every cycle that starts after the swap carries the
    # long watchdog; a different token than the one in flight at the swap is
    # such a cycle.
    MockRunner.set_ls_delay(60_000)
    :sys.replace_state(poller, &%{&1 | stall_timeout_ms: 600_000})
    token_at_swap = :sys.get_state(poller, @state_timeout).poll_token

    assert wait_until(fn ->
             state = :sys.get_state(poller, @state_timeout)
             is_pid(state.poll_task_pid) and state.poll_token not in [nil, token_at_swap]
           end)

    # Inject the first, abandoned cycle's reply. The current cycle remains
    # authoritative: its token stands and no cycle is counted as applied.
    %{poll_token: current_token, poll_cycles: cycles} = :sys.get_state(poller, @state_timeout)
    send(poller, {:poll_world, abandoned_token, {:error, :late_abandoned_cycle}})
    _ = Poller.snapshot(poller)
    state = :sys.get_state(poller, @state_timeout)
    assert state.poll_token == current_token
    assert state.poll_cycles == cycles
  end

  test "poller supervision shuts down an in-flight read with its owner" do
    fiber = make_fiber("tests/shutdown-stalled-read")
    MockRunner.set_fiber("tests/shutdown-stalled-read", fiber)
    MockRunner.set_shuttle("tests/shutdown-stalled-read", oneshot_shuttle())
    MockRunner.set_ls_delay(1_000)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_stall_watchdog_shutdown,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        stall_timeout_ms: 10_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert wait_until(fn -> is_pid(:sys.get_state(poller, @state_timeout).poll_task_pid) end)

    task_pid = :sys.get_state(poller, @state_timeout).poll_task_pid
    monitor = Process.monitor(poller)
    Process.exit(poller, :shutdown)

    assert_receive {:DOWN, ^monitor, :process, ^poller, :shutdown}
    assert wait_until(fn -> not Process.alive?(task_pid) end)
  end

  test "poller skips closed fibers" do
    fiber = make_fiber("tests/closed", %{"status" => "closed"})
    MockRunner.set_fiber("tests/closed", fiber)
    MockRunner.set_shuttle("tests/closed", oneshot_shuttle(), "closed")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_2,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    commands = MockRunner.commands()

    refute Enum.any?(commands, fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "poller skips draft fibers" do
    fiber = make_fiber("tests/draft", %{"tags" => ["constitution", "draft"], "status" => "open"})
    MockRunner.set_fiber("tests/draft", fiber)

    # Draft = shuttle block present but enabled: false; status open (not yet committed to In flight).
    MockRunner.set_shuttle("tests/draft", "enabled: false\nkind: oneshot\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_3,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    commands = MockRunner.commands()

    refute Enum.any?(commands, fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "a legacy kind:pinned active fiber dispatches as a oneshot" do
    # `pinned` is a retired kind read as oneshot (`Poller.block_kind/1`, the
    # CLI's `shuttle.NormalizeKind`): an armed one dispatches on the tick like
    # any oneshot, with no kind-specific gate.
    fiber = make_fiber("tests/legacy-pinned", %{"status" => "active"})
    MockRunner.set_fiber("tests/legacy-pinned", fiber)
    MockRunner.set_shuttle("tests/legacy-pinned", "kind: pinned\nagent: claude-opus\n", "active")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_legacy_pinned,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)
    _ = Poller.snapshot(poller)

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
           end),
           "an armed legacy pinned fiber must dispatch as a oneshot"
  end
end
