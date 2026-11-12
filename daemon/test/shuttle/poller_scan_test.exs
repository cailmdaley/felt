defmodule Shuttle.PollerScanTest do
  # The Poller: candidate ordering, adaptive discovery and failed-launch backoff.
  use Shuttle.Test.PollerCase, async: true

  # `created_at` is an INSTANT and the store holds mixed offsets — thousands of
  # `+02:00` and `+01:00` values from Paris, a growing tail of `-07:00` from
  # Berkeley, plus `Z`, `-05:00`, `-04:00`, `+03:00`. Lexicographic string order
  # resolves inside the time field long before it reaches the offset suffix, so
  # it orders by local wall clock instead of by instant. These two cases both
  # fail against the string comparator.
  describe "sort_candidates orders by instant, not by wall clock" do
    test "a later instant written at a western offset still sorts later" do
      # 16:00Z, then 16:30Z. As strings, "09:30" sorts below "18:00".
      paris = %{"id" => "paris", "created_at" => "2026-07-27T18:00:00+02:00"}
      berkeley = %{"id" => "berkeley", "created_at" => "2026-07-27T09:30:00-07:00"}

      assert Poller.sort_candidates([berkeley, paris]) == [paris, berkeley]
      assert Poller.sort_candidates([paris, berkeley]) == [paris, berkeley]
    end

    test "the same instant at two offsets ties, and the tie breaks on id" do
      # Both are 16:00Z. Correct order is by id; the string comparator puts the
      # "09:00" row first no matter what its id is.
      alpha = %{"id" => "alpha", "created_at" => "2026-07-27T18:00:00+02:00"}
      zulu = %{"id" => "zulu", "created_at" => "2026-07-27T09:00:00-07:00"}

      assert Poller.sort_candidates([zulu, alpha]) == [alpha, zulu]
    end

    test "a Z value compares against an offset value on the same axis" do
      # 16:00Z, then 16:05Z. As strings, "09:05" sorts below "16:00".
      utc = %{"id" => "a", "created_at" => "2026-07-27T16:00:00Z"}
      offset = %{"id" => "b", "created_at" => "2026-07-27T09:05:00-07:00"}

      assert Poller.sort_candidates([offset, utc]) == [utc, offset]
    end

    test "a missing or unparseable created_at keeps its head position" do
      missing = %{"id" => "missing"}
      junk = %{"id" => "junk", "created_at" => "not-a-timestamp"}
      real = %{"id" => "real", "created_at" => "2020-01-01T00:00:00Z"}

      assert Poller.sort_candidates([real, junk, missing]) == [junk, missing, real]
    end
  end

  @tag :adaptive_discovery
  test "fast stores keep doing a full projection each poll" do
    id = "tests/discovery-fast"
    MockRunner.set_fiber(id, make_fiber(id, %{"status" => "open"}))
    MockRunner.set_shuttle(id, "enabled: true\nhost: another-host\nkind: oneshot\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_fast,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    sync_poll_cycle!(poller)

    listings =
      Enum.filter(MockRunner.commands(), fn
        {"shuttle", args} -> "ls" in args and "--any" in args
        _ -> false
      end)

    assert length(listings) == 3
    assert Enum.count(listings, fn {_cmd, args} -> "--ids-from" in args end) == 1
    assert Poller.snapshot(poller).poll_health.discovery[MockRunner.felt_root()].mode == :full
  end

  @tag :adaptive_discovery
  test "slow stores use ids-from hot sets and refresh returned rows" do
    original = "tests/discovery-hot-original"
    MockRunner.set_fiber(original, make_fiber(original, %{"status" => "open"}))
    MockRunner.set_shuttle(original, "enabled: true\nhost: another-host\nkind: oneshot\n", "open")
    MockRunner.set_ls_delay(15)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_hot,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        full_scan_budget_ms: 1,
        full_scan_min_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    assert Poller.snapshot(poller).poll_health.discovery[MockRunner.felt_root()].mode == :hot

    sync_poll_cycle!(poller)

    assert Enum.any?(MockRunner.commands(), fn
             {"shuttle", args} -> "--ids-from" in args
             _ -> false
           end)

    known = :sys.get_state(poller, @state_timeout).last_known_listings[MockRunner.felt_root()]
    assert Enum.any?(known, &(Map.get(&1, "id") == original))

    MockRunner.set_shuttle(
      original,
      "enabled: true\nhost: another-host\nkind: oneshot\n",
      "active"
    )

    sync_poll_cycle!(poller)
    refreshed = :sys.get_state(poller, @state_timeout).last_known_listings[MockRunner.felt_root()]
    assert Enum.find(refreshed, &(Map.get(&1, "id") == original))["status"] == "active"

    :sys.replace_state(poller, fn state ->
      info = Map.fetch!(state.discovery, MockRunner.felt_root())

      %{
        state
        | discovery:
            Map.put(state.discovery, MockRunner.felt_root(), %{info | next_full_due_at: 0})
      }
    end)

    MockRunner.delete_fiber(original)
    sync_poll_cycle!(poller)
    settled = :sys.get_state(poller, @state_timeout).last_known_listings[MockRunner.felt_root()]
    refute Enum.any?(settled, &(Map.get(&1, "id") == original))

    {_command, args} =
      Enum.find(Enum.reverse(MockRunner.commands()), fn {cmd, args} ->
        cmd == "shuttle" and "--ids-from" in args
      end)

    ids_path = Enum.at(args, Enum.find_index(args, &(&1 == "--ids-from")) + 1)
    refute File.exists?(ids_path)
  end

  @tag :adaptive_discovery
  test "a missing hot address schedules a full scan that finds its moved fiber" do
    old = "tests/move-old"
    moved = "tests/move-new"
    uid = Shuttle.Test.FiberUid.for(old)
    MockRunner.set_fiber(old, make_fiber(old, %{"uid" => uid}))
    MockRunner.set_shuttle(old, "kind: oneshot\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_moved_hot,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        full_scan_budget_ms: 0,
        full_scan_min_interval_ms: 600_000,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    sync_poll_cycle!(poller)
    MockRunner.delete_fiber(old)
    MockRunner.set_fiber(moved, make_fiber(moved, %{"uid" => uid}))
    MockRunner.set_shuttle(moved, "kind: oneshot\n", "open")
    sync_poll_cycle!(poller)
    sync_poll_cycle!(poller)
    rows = :sys.get_state(poller, @state_timeout).last_known_listings[MockRunner.felt_root()]
    assert Enum.any?(rows, &(&1["id"] == moved))
    refute Enum.any?(rows, &(&1["id"] == old))
  end

  @tag :adaptive_discovery
  test "a timed-out full scan enters hot mode and waits until its next due time" do
    id = "tests/discovery-timeout"
    MockRunner.set_fiber(id, make_fiber(id, %{"status" => "open"}))
    MockRunner.set_shuttle(id, "enabled: true\nhost: another-host\nkind: oneshot\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_timeout,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        full_scan_timeout_ms: 50,
        full_scan_budget_ms: 1_000,
        full_scan_min_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)

    :sys.replace_state(poller, fn state ->
      slow = %{
        mode: :hot,
        last_full_duration_ms: 100,
        last_full_completed_at: System.system_time(:millisecond) - 60_000,
        next_full_due_at: 0
      }

      %{state | discovery: Map.put(state.discovery, MockRunner.felt_root(), slow)}
    end)

    MockRunner.set_listing_timeout(true)
    sync_poll_cycle!(poller)

    info = :sys.get_state(poller, @state_timeout).discovery[MockRunner.felt_root()]
    assert info.mode == :hot
    assert is_integer(info.next_full_due_at)
    assert info.next_full_due_at > System.system_time(:millisecond)

    MockRunner.set_listing_timeout(false)
    commands_before = length(MockRunner.commands())
    sync_poll_cycle!(poller)
    hot_success = Enum.drop(MockRunner.commands(), commands_before)
    assert Enum.any?(hot_success, fn {cmd, args} -> cmd == "shuttle" and "--ids-from" in args end)

    refute Enum.any?(hot_success, fn {cmd, args} ->
             cmd == "shuttle" and "ls" in args and "--ids-from" not in args
           end)

    commands_before = length(MockRunner.commands())
    sync_poll_cycle!(poller)
    following = Enum.drop(MockRunner.commands(), commands_before)
    assert Enum.any?(following, fn {cmd, args} -> cmd == "shuttle" and "--ids-from" in args end)

    refute Enum.any?(following, fn {cmd, args} ->
             cmd == "shuttle" and "ls" in args and "--ids-from" not in args
           end)
  end

  @tag :adaptive_discovery
  test "a document the daemon announces joins the hot set before the next full scan" do
    known = "tests/discovery-known"
    created = "tests/discovery-created"
    MockRunner.set_fiber(known, make_fiber(known, %{"status" => "open"}))
    MockRunner.set_shuttle(known, "enabled: true\nhost: another-host\nkind: oneshot\n", "open")
    MockRunner.set_ls_delay(15)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_announced,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        full_scan_budget_ms: 1,
        full_scan_min_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    sync_poll_cycle!(poller)
    store = MockRunner.felt_root()

    listed? = fn id ->
      :sys.get_state(poller, @state_timeout).last_known_listings[store]
      |> Enum.any?(&(Map.get(&1, "id") == id))
    end

    # Written after the full listing (a `POST /fiber/create`): a hot tick
    # alone never finds it.
    MockRunner.set_fiber(created, make_fiber(created, %{"status" => "active"}))

    MockRunner.set_shuttle(
      created,
      "enabled: true\nhost: another-host\nkind: oneshot\n",
      "active"
    )

    sync_poll_cycle!(poller)
    assert Poller.snapshot(poller).poll_health.discovery[store].mode == :hot
    refute listed?.(created)

    uid = Shuttle.Test.FiberUid.for(created)
    assert :ok = Poller.refresh_created_document(store, uid, poller)
    sync_poll_cycle!(poller)
    assert listed?.(created)
    assert Map.has_key?(:sys.get_state(poller, @state_timeout).announced_ids[store], created)

    # A full scan that starts after the announcement carries the id itself.
    :sys.replace_state(poller, fn state ->
      info = Map.fetch!(state.discovery, store)
      %{state | discovery: Map.put(state.discovery, store, %{info | next_full_due_at: 0})}
    end)

    sync_poll_cycle!(poller)
    assert listed?.(created)
    assert :sys.get_state(poller, @state_timeout).announced_ids == %{}
  end

  @tag :adaptive_discovery
  test "a rename returned by uid replaces the retained address on a hot tick" do
    original = "tests/discovery-rename-old"
    renamed = "tests/discovery-rename-new"
    uid = Shuttle.Test.FiberUid.for(original)
    MockRunner.set_fiber(original, make_fiber(original, %{"uid" => uid}))
    MockRunner.set_shuttle(original, "kind: oneshot\n", "open")
    MockRunner.set_ls_delay(15)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_rename,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        full_scan_budget_ms: 1,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    MockRunner.set_fiber(renamed, make_fiber(renamed, %{"uid" => uid}))
    MockRunner.set_shuttle(renamed, "kind: oneshot\n", "open")
    MockRunner.set_ids_from_alias(original, renamed)
    MockRunner.delete_fiber(original)

    sync_poll_cycle!(poller)

    rows = :sys.get_state(poller, @state_timeout).last_known_listings[MockRunner.felt_root()]
    assert Enum.any?(rows, &(&1["id"] == renamed and &1["uid"] == uid))
    refute Enum.any?(rows, &(&1["id"] == original))
  end

  @tag :adaptive_discovery
  test "a returned hot row owned by another store evicts its retained row" do
    id = "tests/discovery-moved"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\n", "open")
    MockRunner.set_ls_delay(15)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_foreign,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        full_scan_budget_ms: 1,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    assert Poller.snapshot(poller).poll_health.discovery[MockRunner.felt_root()].mode == :hot
    moved = Map.put(MockRunner.fiber(id), "path", "/tmp/foreign/.felt/moved.md")
    MockRunner.set_fiber(id, moved)
    assert MockRunner.fiber(id)["path"] == "/tmp/foreign/.felt/moved.md"
    before = length(MockRunner.commands())
    sync_poll_cycle!(poller)
    cycle_commands = Enum.drop(MockRunner.commands(), before)

    assert Enum.any?(cycle_commands, fn {cmd, args} ->
             cmd == "shuttle" and "--ids-from" in args
           end)

    rows = :sys.get_state(poller, @state_timeout).last_known_listings[MockRunner.felt_root()]
    refute Enum.any?(rows, &(&1["id"] == id))
  end

  @tag :adaptive_discovery
  test "a non-timeout full-listing error leaves a fast store in full mode" do
    id = "tests/discovery-fast-error"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_fast_error,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    before = :sys.get_state(poller, @state_timeout).discovery[MockRunner.felt_root()]
    MockRunner.set_listing_error(2)
    sync_poll_cycle!(poller)

    info = :sys.get_state(poller, @state_timeout).discovery[MockRunner.felt_root()]
    assert info.mode == :full

    assert Map.get(info, :last_full_timed_out, false) ==
             Map.get(before, :last_full_timed_out, false)

    assert info.last_full_duration_ms == before.last_full_duration_ms
    assert info.next_full_due_at == before.next_full_due_at
  end

  @tag :adaptive_discovery
  test "live orphan reconciliation uses the current poll listing without a second discovery" do
    id = "tests/discovery-live-orphan"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_live_reconcile,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    MockRunner.add_tmux_session(Shuttle.Test.FiberUid.session(id))
    before = length(MockRunner.commands())
    sync_poll_cycle!(poller)
    cycle_commands = Enum.drop(MockRunner.commands(), before)

    assert Enum.count(cycle_commands, fn
             {"shuttle", args} -> "--any" in args
             _ -> false
           end) == 1

    assert Poller.worker_status(poller, id)
  end

  @tag :adaptive_discovery
  test "boot adoption seeds its full listing for the first poll" do
    id = "tests/discovery-boot-seed"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\n", "open")
    MockRunner.add_tmux_session(Shuttle.Test.FiberUid.session(id))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_boot_seed,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)

    shuttle_ls =
      Enum.filter(MockRunner.commands(), fn
        {"shuttle", args} -> "--any" in args
        _ -> false
      end)

    assert Enum.count(shuttle_ls, fn {_cmd, args} -> "--ids-from" not in args end) == 1
    assert Enum.count(shuttle_ls, fn {_cmd, args} -> "--ids-from" in args end) == 1
  end

  @tag :adaptive_discovery
  test "a timed-out boot listing starts slow mode with a full retry in the poll task" do
    id = "tests/discovery-boot-timeout"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\n", "open")
    MockRunner.set_listing_timeout(true)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_boot_timeout,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        full_scan_timeout_ms: 120_000,
        full_scan_min_interval_ms: 60_000,
        stall_timeout_ms: 1,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)

    state = :sys.get_state(poller, @state_timeout)
    info = state.discovery[MockRunner.felt_root()]
    assert info.mode == :hot
    assert info.next_full_due_at <= System.system_time(:millisecond)
    assert state.stall_timeout_ms == 120_000 + 1_000

    listings =
      Enum.filter(MockRunner.commands(), fn
        {"shuttle", args} -> "--any" in args
        _ -> false
      end)

    assert length(listings) >= 2
    refute Enum.any?(listings, fn {_cmd, args} -> "--ids-from" in args end)
    assert Poller.snapshot(poller).poll_health.discovery[MockRunner.felt_root()].mode == :hot

    MockRunner.set_listing_timeout(false)
    commands_before = length(MockRunner.commands())
    sync_poll_cycle!(poller)
    retry = Enum.drop(MockRunner.commands(), commands_before)

    assert Enum.any?(retry, fn {cmd, args} -> cmd == "shuttle" and "--any" in args end)

    refute Enum.any?(retry, fn {cmd, args} ->
             cmd == "shuttle" and "--ids-from" in args
           end)
  end

  @tag :adaptive_discovery
  test "a fast full scan keeps the configured watchdog bound" do
    id = "tests/discovery-fast-watchdog"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_fast_watchdog,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        stall_timeout_ms: 300_000,
        full_scan_timeout_ms: 900_000,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    sync_poll_cycle!(poller)

    state = :sys.get_state(poller, @state_timeout)
    info = state.discovery[MockRunner.felt_root()]
    assert info.mode == :full
    assert info.last_full_duration_ms <= state.full_scan_budget_ms
    assert state.stall_timeout_ms == 300_000
  end

  @tag :adaptive_discovery
  test "a zero full-scan budget spaces scans at the configured minimum interval" do
    id = "tests/discovery-zero-budget"
    store = MockRunner.felt_root()
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\\n", "open")
    min_interval = 60_000

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_zero_budget,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        full_scan_budget_ms: 0,
        full_scan_min_interval_ms: min_interval,
        felt_stores: [store]
      )

    settle_poller!(poller)

    info = :sys.get_state(poller, @state_timeout).discovery[store]
    assert info.mode == :hot

    assert info.next_full_due_at + info.last_full_duration_ms ==
             info.last_full_completed_at + min_interval
  end

  @tag :adaptive_discovery
  test "a store that becomes due during a cycle stays hot until the next plan" do
    id = "tests/discovery-plan-fixed"
    store = MockRunner.felt_root()
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_plan_fixed,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [store]
      )

    settle_poller!(poller)

    state = :sys.get_state(poller, @state_timeout)
    info = Map.fetch!(state.discovery, store)

    info =
      info
      |> Map.put(:mode, :hot)
      |> Map.put(:last_full_duration_ms, state.full_scan_budget_ms + 1)
      |> Map.put(:next_full_due_at, 1)
      |> Map.put(:last_full_timed_out, false)
      |> Map.delete(:boot_seeded)

    state = %{state | discovery: Map.put(state.discovery, store, info)}

    :sys.replace_state(poller, fn _ -> state end)
    state = :sys.get_state(poller, @state_timeout)
    plan = Shuttle.Poller.Discovery.plan(state, [store], 0)
    assert plan[store] == :hot

    before = length(MockRunner.commands())
    Shuttle.Poller.Discovery.discover(state, plan)
    cycle_commands = Enum.drop(MockRunner.commands(), before)

    assert Enum.any?(cycle_commands, fn {cmd, args} ->
             cmd == "shuttle" and "--ids-from" in args
           end)

    refute Enum.any?(cycle_commands, fn {cmd, args} ->
             cmd == "shuttle" and "ls" in args and "--ids-from" not in args
           end)
  end

  @tag :adaptive_discovery
  test "a queued planning watchdog cannot reap the read phase" do
    id = "tests/discovery-phase-token"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_phase_token,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        stall_timeout_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    MockRunner.hold_ls()
    send(poller, :run_poll_cycle)
    assert_receive {:ls_held, reader}, 5_000

    state = :sys.get_state(poller, @state_timeout)
    assert state.poll_check_in_progress
    assert is_reference(state.poll_stall_phase_ref)
    phase_ref = state.poll_stall_phase_ref
    cycle_ref = state.poll_token
    task_pid = state.poll_task_pid

    try do
      send(poller, {:poll_stalled, cycle_ref, make_ref()})
      send(poller, {:poll_stalled, cycle_ref})
      after_stale_timeouts = :sys.get_state(poller, @state_timeout)

      assert after_stale_timeouts.poll_check_in_progress
      assert after_stale_timeouts.poll_stall_phase_ref == phase_ref
      assert after_stale_timeouts.poll_task_pid == task_pid
      assert Process.alive?(task_pid)
      assert after_stale_timeouts.poll_stalls == state.poll_stalls
    after
      send(reader, :release_ls)
    end

    settle_poller!(poller)
  end

  @tag :adaptive_discovery
  test "the watchdog bound follows stores added after init" do
    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_watchdog_grows,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        stall_timeout_ms: 1,
        full_scan_timeout_ms: 50_000,
        felt_stores: ["/tmp/store-a"]
      )

    settle_poller!(poller)

    :sys.replace_state(poller, fn state ->
      hot_store =
        Map.merge(Map.get(state.discovery, "/tmp/store-a", %{}), %{
          mode: :hot,
          last_full_duration_ms: state.full_scan_budget_ms + 1,
          next_full_due_at: System.system_time(:millisecond) + 60_000,
          last_full_timed_out: false
        })

      %{
        state
        | felt_stores: ["/tmp/store-a", "/tmp/store-b"],
          discovery: Map.put(state.discovery, "/tmp/store-a", hot_store)
      }
    end)

    sync_poll_cycle!(poller)
    state = :sys.get_state(poller, @state_timeout)
    assert state.stall_timeout_ms == 2 * 60_000 + 1_000
  end

  test "identical failed launches back off, then retry, while force bypasses the cooldown" do
    id = "tests/launch-backoff"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\nagent: claude-sonnet\n", "active")
    Env.put_app_env(:failed_launch_test_pid, self())

    {:ok, poller} =
      start_poller!(
        runner: FailedLaunchRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    await_boot_cycle!(poller)

    for _ <- 1..2 do
      assert {:error, _} = Poller.dispatch_fiber(poller, id, [])
      assert_receive :failed_launch_probe
    end

    assert [%{attempts: 2, reason: reason}] = Poller.snapshot(poller).blocked
    assert reason =~ "launch refused"
    assert {:ok, %{fibers: [entry]}} = Poller.cached_fiber_documents(poller)
    assert entry.dispatch_error == reason
    refute Map.has_key?(entry, :runtime)
    assert {:error, _} = Poller.dispatch_fiber(poller, id, [])
    refute_receive :failed_launch_probe, 50

    # Expire the remembered attempt, without sleeping through a five-minute wait.
    :sys.replace_state(poller, fn state ->
      failures =
        Map.new(state.dispatch_failures, fn {key, failure} ->
          {key, %{failure | attempted_at: DateTime.add(failure.attempted_at, -301, :second)}}
        end)

      %{state | dispatch_failures: failures}
    end)

    assert {:error, _} = Poller.dispatch_fiber(poller, id, [])
    assert_receive :failed_launch_probe
    assert [%{attempts: 3}] = Poller.snapshot(poller).blocked
    assert {:error, _} = Poller.dispatch_fiber(poller, id, force: true)
    assert_receive :failed_launch_probe
  end
end
