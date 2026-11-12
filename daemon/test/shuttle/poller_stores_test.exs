defmodule Shuttle.PollerStoresTest do
  # The Poller: project directories, felt stores and dispatch call timeouts.
  #
  # The multi-store tests write real .felt/ directories rather than
  # MockRunner's in-memory store: store resolution is the Poller's cold path,
  # `FeltStores.store_for_fiber/2` over its configured `felt_stores`.
  use Shuttle.Test.PollerCase, async: true

  test "poller uses shuttle.project_dir as work_dir when it exists" do
    project_dir =
      Path.join(System.tmp_dir!(), "shuttle-test-proj-#{System.unique_integer([:positive])}")

    File.mkdir_p!(project_dir)

    fiber = make_fiber("tests/project-dir-fiber")
    MockRunner.set_fiber("tests/project-dir-fiber", fiber)

    MockRunner.set_shuttle("tests/project-dir-fiber", """
    enabled: true
    kind: oneshot
    project_dir: #{project_dir}
    """)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_project_dir,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    # The requested work directory follows tmux's -c option.
    assert_eventually(fn ->
      {_, args} =
        Enum.find(MockRunner.commands(), fn {cmd, args} ->
          cmd == "tmux" and hd(args) == "new-session"
        end)

      assert Enum.at(args, Enum.find_index(args, &(&1 == "-c")) + 1) == project_dir
    end)
  after
    File.rm_rf(Path.join(System.tmp_dir!(), "shuttle-test-proj-*"))
  end

  test "poller disqualifies (does not downgrade) a fiber whose declared project_dir is missing" do
    # A declared project_dir absent on this host means the checkout lives on
    # another machine. The pre-cutover behavior downgraded the worker cwd to a
    # felt store and dispatched anyway (native-desktop misdispatch root cause
    # #2); the cutover makes it *ineligible* — disqualify, don't downgrade.
    # host: test-host matches so the only disqualifier under test is the dir.
    fiber = make_fiber("tests/missing-project-dir")
    MockRunner.set_fiber("tests/missing-project-dir", fiber)

    MockRunner.set_shuttle("tests/missing-project-dir", """
    enabled: true
    kind: oneshot
    host: test-host
    project_dir: /nonexistent/path/shuttle-test-missing
    """)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_missing_project_dir,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    assert Poller.snapshot(poller).eligible == []
  end

  # Regression: a fiber with a shuttle: block but *no* constitution tag must be
  # discovered and dispatched. This is the core invariant from the cutover —
  # the block is the source of truth, not the tag.
  test "poller discovers and dispatches a fiber with shuttle block but no constitution tag" do
    fiber_id = "tests/untagged-shuttle"
    fiber = make_fiber(fiber_id, %{"tags" => []})
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_untagged_shuttle,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    send(poller, {:tick, Poller.snapshot(poller) |> Map.get(:tick_token)})

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
           end)

    assert wait_until(fn ->
             Poller.snapshot(poller).eligible
             |> Enum.any?(&(&1.fiber_id == fiber_id))
           end)
  end

  test "dispatch_fiber waits past the default GenServer timeout for slow successful dispatches" do
    # The worker-changing calls wait 30 s, well past GenServer's 5 s default...
    assert Poller.dispatch_call_timeout_ms() == 30_000

    {:ok, poller} =
      start_poller!(
        name: :test_poller_slow_dispatch,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # The fibers arrive after the boot cycle, so only these calls dispatch them.
    settle_poller!(poller)
    slow_id = "tests/slow-api-dispatch"
    MockRunner.set_fiber(slow_id, make_fiber(slow_id))
    MockRunner.set_shuttle(slow_id, oneshot_shuttle())
    late_id = "tests/late-api-dispatch"
    MockRunner.set_fiber(late_id, make_fiber(late_id))
    MockRunner.set_shuttle(late_id, oneshot_shuttle())

    # ...a slow spawn still answers...
    MockRunner.set_new_session_delay(300)
    assert {:ok, session} = Poller.dispatch_fiber(poller, slow_id, [])
    assert session == FiberUid.session(slow_id)
    assert Poller.snapshot(poller).eligible |> Enum.any?(&(&1.fiber_id == slow_id))

    # ...and the wait is that timeout, not GenServer's default: shrunk well
    # below a spawn's duration, the caller stops waiting first and is told the
    # launch is still queued.
    Shuttle.Test.Env.put_app_env(:dispatch_call_timeout_ms, 200)
    MockRunner.set_new_session_delay(2_000)

    started = System.monotonic_time(:millisecond)
    assert Poller.dispatch_fiber(poller, late_id, []) == {:error, :poller_busy}
    assert System.monotonic_time(:millisecond) - started < 2_000
  end

  test "every worker-changing call gives up at the configured dispatch timeout" do
    {:ok, poller} =
      start_poller!(
        name: :test_poller_call_timeouts,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    Shuttle.Test.Env.put_app_env(:dispatch_call_timeout_ms, 100)

    # A suspended Poller never answers, so each call gives up at the shrunk
    # 100 ms, not GenServer's 5 s default or the 30 s production value. The
    # calls that start or rearm work answer "still queued"; the others exit,
    # naming the timeout they waited.
    :sys.suspend(poller)

    exits = [
      claim_session: fn -> Poller.claim_session(poller, "tests/t", "s", []) end,
      kill_session: fn -> Poller.kill_session(poller, "tests/t") end,
      capture: fn -> Poller.capture(poller, "yap", []) end
    ]

    for {name, call} <- exits do
      task = Task.async(fn -> catch_exit(call.()) end)

      assert {:ok, {:timeout, {GenServer, :call, [_server, _msg, 100]}}} =
               Task.yield(task, 30_000),
             "#{name} did not give up at the configured timeout"
    end

    answers = [
      dispatch_fiber:
        {fn -> Poller.dispatch_fiber(poller, "tests/t", []) end,
         &match?({:error, :poller_busy}, &1)},
      lifecycle_transition:
        {fn -> Poller.lifecycle_transition(poller, :resume, "tests/t") end,
         &match?({:error, :timeout, _}, &1)}
    ]

    for {name, {call, expected?}} <- answers do
      task = Task.async(call)
      assert {:ok, result} = Task.yield(task, 30_000), "#{name} did not give up in time"
      assert expected?.(result), "#{name} answered #{inspect(result)}"
    end
  end

  test "cached owning store retains the enclosing namespace for writes" do
    {loom, project} = loom_project_symlink!()
    id = "ai-futures/portolan/kanban-modal"
    state = %Poller.State{felt_stores: [project], fiber_store_cache: %{id => project}}

    assert FeltStores.store_felt_realpath(Poller.owning_store(id, state)) ==
             FeltStores.store_felt_realpath(loom)
  end

  test "store_for_fiber finds a fiber in the first configured store" do
    host_a = multi_host_dir("a")

    host_b = multi_host_dir("b")

    write_fiber_file(host_a, "tests/fiber-in-a")

    assert {:ok, ^host_a} = FeltStores.store_for_fiber("tests/fiber-in-a", [host_a, host_b])
  end

  test "store_for_fiber finds a fiber in the second configured store" do
    host_a = multi_host_dir("a")

    host_b = multi_host_dir("b")

    write_fiber_file(host_b, "tests/fiber-in-b")

    assert {:ok, ^host_b} = FeltStores.store_for_fiber("tests/fiber-in-b", [host_a, host_b])
  end

  test "store_for_fiber returns :not_found for an unknown fiber" do
    host_a = multi_host_dir("a")
    File.mkdir_p!(Path.join(host_a, ".felt"))

    assert {:error, :not_found} = FeltStores.store_for_fiber("tests/no-such-fiber", [host_a])
  end

  test "first-configured host wins for ID collisions" do
    host_a = multi_host_dir("a")

    host_b = multi_host_dir("b")

    # Same fiber ID in both hosts
    write_fiber_file(host_a, "tests/collision-fiber")
    write_fiber_file(host_b, "tests/collision-fiber")

    # host_a is first-configured → wins
    assert {:ok, ^host_a} = FeltStores.store_for_fiber("tests/collision-fiber", [host_a, host_b])
  end

  test "subdirectory symlink: loom-walks-into-project subtree skipped" do
    # Mirrors loom→lightcone topology: physical .felt lives in host_b
    # (project-canonical, like lightcone). host_a (loom) symlinks INTO
    # host_b's tree at .felt/ai-futures/lightcone. Walking host_a should
    # NOT enumerate the symlinked subtree — host_b enumerates canonically.
    # This is load-bearing: if loom enumerates the lightcone fiber under
    # its loom-relative id, dispatch later runs `felt -C ~/loom show
    # ai-futures/lightcone/...` which fails (loom's index doesn't have
    # the entry) and dispatch silently never happens.
    host_a = multi_host_dir("loom")

    host_b = multi_host_dir("lightcone")

    File.mkdir_p!(Path.join(host_a, ".felt/ai-futures"))

    # The real fiber file is rooted in host_b's .felt/, accessible via the
    # project-canonical id `lightcone-ui/myst-as-ast/dual-branch`.
    write_fiber_file(host_b, "lightcone-ui/myst-as-ast/dual-branch")

    # host_a (loom) symlinks INTO host_b's tree, so the same physical file
    # is reachable as host_a/.felt/ai-futures/lightcone/lightcone-ui/.../dual-branch.md.
    File.ln_s!(
      Path.join(host_b, ".felt"),
      Path.join([host_a, ".felt", "ai-futures", "lightcone"])
    )

    {:ok, poller} =
      start_poller!(
        name: :test_subdir_symlink_skip,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [host_a, host_b]
      )

    # The fiber should resolve to host_b (canonical), not host_a (symlink view).
    assert {:ok, ^host_b} =
             FeltStores.store_for_fiber("lightcone-ui/myst-as-ast/dual-branch", [host_a, host_b])

    snap = Poller.snapshot(poller)
    candidate_ids = Enum.map(snap.eligible, & &1.fiber_id)

    refute "ai-futures/lightcone/lightcone-ui/myst-as-ast/dual-branch" in candidate_ids,
           "loom-relative symlink-aliased id leaked into eligible: #{inspect(candidate_ids)}"
  end

  test "host with symlinked .felt/ skipped entirely" do
    # Mirrors project-cities-on-loom topology: project's `.felt/` is a
    # symlink into loom's tree. Walking the project host should skip
    # everything — loom enumerates the same files canonically.
    {loom, project} = loom_project_symlink!()

    {:ok, poller} =
      start_poller!(
        name: :test_symlinked_felt_skipped,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [loom, project]
      )

    # The fiber resolves to loom (canonical), not project (symlinked .felt).
    assert {:ok, ^loom} =
             FeltStores.store_for_fiber("ai-futures/portolan/kanban-modal", [loom, project])

    snap = Poller.snapshot(poller)
    candidate_ids = Enum.map(snap.eligible, & &1.fiber_id)

    refute "kanban-modal" in candidate_ids,
           "project-symlink alias surfaced: #{inspect(candidate_ids)}"
  end

  test "store_for_fiber ignores the symlinked project view" do
    {loom, project} = loom_project_symlink!()

    assert {:ok, ^loom} =
             FeltStores.store_for_fiber("ai-futures/portolan/kanban-modal", [loom, project])
  end

  test "snapshot includes felt_stores list" do
    {:ok, poller} =
      start_poller!(
        name: :test_multi_host_snap,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp/host-one", "/tmp/host-two"]
      )

    snap = Poller.snapshot(poller)
    assert snap.felt_stores == ["/tmp/host-one", "/tmp/host-two"]
  end

  test "poller reads configured hosts from persisted registration" do
    config_path =
      Path.join(
        System.tmp_dir!(),
        "shuttle-felt-stores-poller-#{System.unique_integer([:positive])}.json"
      )

    Env.put_env("SHUTTLE_STORES_FILE", config_path)
    Env.delete_env("SHUTTLE_STORES")
    File.mkdir_p!(Path.dirname(config_path))

    File.write!(
      config_path,
      Jason.encode!(%{"version" => 1, "felt_stores" => ["/tmp/host-a", "/tmp/host-b"]})
    )

    on_exit(fn -> File.rm(config_path) end)

    {:ok, poller} =
      start_poller!(
        name: :test_registered_felt_stores,
        runner: MockRunner,
        poll_interval_ms: 60_000
      )

    assert Poller.snapshot(poller).felt_stores == ["/tmp/host-a", "/tmp/host-b"]
  end

  test "poller refreshes configured hosts when the persisted registration changes" do
    config_path =
      Path.join(
        System.tmp_dir!(),
        "shuttle-felt-stores-refresh-#{System.unique_integer([:positive])}.json"
      )

    Env.put_env("SHUTTLE_STORES_FILE", config_path)
    Env.delete_env("SHUTTLE_STORES")
    File.mkdir_p!(Path.dirname(config_path))
    File.write!(config_path, Jason.encode!(%{"version" => 1, "felt_stores" => ["/tmp/host-a"]}))

    on_exit(fn -> File.rm(config_path) end)

    {:ok, poller} =
      start_poller!(
        name: :test_refresh_registered_felt_stores,
        runner: MockRunner,
        poll_interval_ms: 60_000
      )

    assert Poller.snapshot(poller).felt_stores == ["/tmp/host-a"]

    File.write!(config_path, Jason.encode!(%{"version" => 1, "felt_stores" => ["/tmp/host-c"]}))
    Process.sleep(1_010)
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert Poller.snapshot(poller).felt_stores == ["/tmp/host-c"]
    end)
  end
end
