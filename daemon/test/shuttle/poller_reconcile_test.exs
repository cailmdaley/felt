defmodule Shuttle.PollerReconcileTest do
  # The Poller: reconciling closed, orphaned and dead workers.
  use Shuttle.Test.PollerCase, async: true

  for backend <- [Shuttle.Terminal.Tmux, Shuttle.Terminal.Rex] do
    @tag backend: backend
    @tag :review_server_absent
    test "closed reaping stops an unreachable #{inspect(backend)} worker through its process", %{
      backend: backend
    } do
      {state, session} = closed_reap_fixture(backend)

      case backend do
        Shuttle.Terminal.Tmux ->
          assert :ok = backend.close(ReapRunner, session)

        Shuttle.Terminal.Rex ->
          for method <- ["session.list", "session.list_blocks"],
              do: Shuttle.Test.FakeRex.reply(method, {"server is not running", 4})

          {:ok, bindings} = Shuttle.Terminal.RexBindings.read()
          sid = get_in(bindings, ["bindings", session, "session_id"])
          assert {:error, :server_absent} = Shuttle.Rex.blocks(ReapRunner, sid)
      end

      assert :absent = backend.probe(ReapRunner, session)
      MockRunner.set_ps_result({"812 1 bash -l /tmp/shuttle-run-#{session}.42.sh\n", 0})
      Env.put_app_env(:worker_stop_ladder, [{"TERM", 0}, {"KILL", 0}])

      assert {:ok, [^session]} = scan = Poller.list_shuttle_sessions(state)
      state = Shuttle.Poller.SessionReconciliation.reconcile_orphaned_sessions(state, scan, true)
      assert {"kill", ["-TERM", "--", "-812", "812"]} in MockRunner.commands()
      assert {:ok, []} = scan = Poller.list_shuttle_sessions(state)
      Shuttle.Poller.SessionReconciliation.reconcile_orphaned_sessions(state, scan, true)
      assert Enum.count(MockRunner.commands(), &match?({"kill", _}, &1)) == 1
    end

    @tag backend: backend
    @tag :review_runtime_key
    test "closing one of two #{inspect(backend)} rows sharing an address stops only its runtime key",
         %{backend: backend} do
      Env.put_app_env(:terminal_backend, backend)

      if backend == Shuttle.Terminal.Rex do
        Env.put_app_env(:fake_rex, start_supervised!(Shuttle.Test.FakeRex))
        Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
      end

      shared = "tests/shared-address"
      other = "tests/other-address"

      for {id, uid} <- [
            {shared, "01JZ00000000000000000000ZZ"},
            {other, "01JZ00000000000000000000AA"}
          ] do
        MockRunner.set_fiber(id, make_fiber(id, %{"uid" => uid}))

        MockRunner.set_shuttle(
          id,
          "kind: oneshot\nagent: claude-sonnet\nhost: test-host\n",
          "active"
        )
      end

      {:ok, poller} =
        start_poller!(
          runner: Shuttle.Test.PollerCase.PhantomRunner,
          own_host_id: "test-host",
          poll_interval_ms: 60_000,
          max_concurrent_workers: 0,
          felt_stores: [MockRunner.felt_root()]
        )

      assert {:ok, closing_session} =
               Poller.dispatch_fiber(poller, shared, force: true, ad_hoc: true)

      assert {:ok, open_session} = Poller.dispatch_fiber(poller, other, force: true, ad_hoc: true)
      closing_uid = MockRunner.fiber(shared)["uid"]
      open_uid = MockRunner.fiber(other)["uid"]
      MockRunner.set_fiber(shared, Map.put(MockRunner.fiber(shared), "status", "closed"))
      MockRunner.set_fiber(other, Map.put(MockRunner.fiber(other), "id", shared))

      :sys.replace_state(poller, fn state ->
        %{state | running: Map.update!(state.running, open_uid, &Map.put(&1, :fiber_id, shared))}
      end)

      sync_poll_cycle!(poller)
      state = :sys.get_state(poller)
      refute Map.has_key?(state.running, closing_uid)
      assert %{session: ^open_session, pid: watcher} = state.running[open_uid]
      assert Process.alive?(watcher)
      assert :alive = Shuttle.Terminal.status(Shuttle.Test.PollerCase.PhantomRunner, open_session)

      assert :gone =
               Shuttle.Terminal.status(Shuttle.Test.PollerCase.PhantomRunner, closing_session)

      assert get_in(MockRunner.fiber(shared), ["shuttle", "runtime", "handed_off_at"])
      refute get_in(MockRunner.fiber(other), ["shuttle", "runtime", "handed_off_at"])
      assert reap_stop_count(backend) == 1
    end

    @tag backend: backend
    @tag :review_unknown_inventory
    test "an unknown inventory defers closed #{inspect(backend)} teardown until a healthy scan",
         %{backend: backend} do
      Env.put_app_env(:terminal_backend, backend)

      if backend == Shuttle.Terminal.Rex do
        Env.put_app_env(:fake_rex, start_supervised!(Shuttle.Test.FakeRex))
        Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
      end

      Env.put_app_env(:worker_stop_ladder, [{"TERM", 0}])
      id = "tests/closed-unknown-inventory"
      MockRunner.set_fiber(id, make_fiber(id))

      MockRunner.set_shuttle(
        id,
        "kind: oneshot\nagent: claude-sonnet\nhost: test-host\n",
        "active"
      )

      {:ok, poller} =
        start_poller!(
          runner: Shuttle.Test.PollerCase.PhantomRunner,
          own_host_id: "test-host",
          poll_interval_ms: 60_000,
          max_concurrent_workers: 0,
          felt_stores: [MockRunner.felt_root()]
        )

      assert {:ok, session} = Poller.dispatch_fiber(poller, id, force: true, ad_hoc: true)
      %{pid: watcher} = Poller.worker_status(poller, id)
      MockRunner.set_fiber(id, Map.put(MockRunner.fiber(id), "status", "closed"))
      MockRunner.set_ps_result({"ps timed out", :timeout})
      sync_poll_cycle!(poller)
      assert reap_stop_count(backend) == 0
      assert %{pid: ^watcher, session: ^session} = Poller.worker_status(poller, id)
      refute get_in(MockRunner.fiber(id), ["shuttle", "runtime", "handed_off_at"])

      MockRunner.set_ps_result({"", 0})
      sync_poll_cycle!(poller)
      assert reap_stop_count(backend) == 1
      assert Poller.worker_status(poller, id) == nil
    end

    @tag backend: backend
    @tag :review_retired_inventory
    test "a closed fiber keeps its #{inspect(backend)} worker visible until teardown succeeds", %{
      backend: backend
    } do
      Env.put_app_env(:terminal_backend, backend)

      if backend == Shuttle.Terminal.Rex do
        Env.put_app_env(:fake_rex, start_supervised!(Shuttle.Test.FakeRex))
        Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
      end

      id = "tests/closed-stop-tracking"
      MockRunner.set_fiber(id, make_fiber(id))

      MockRunner.set_shuttle(
        id,
        "kind: oneshot\nagent: claude-sonnet\nhost: test-host\n",
        "active"
      )

      {:ok, poller} =
        start_poller!(
          runner: Shuttle.Test.PollerCase.PhantomRunner,
          own_host_id: "test-host",
          poll_interval_ms: 60_000,
          max_concurrent_workers: 0,
          felt_stores: [MockRunner.felt_root()]
        )

      assert {:ok, session} = Poller.dispatch_fiber(poller, id, force: true, ad_hoc: true)
      MockRunner.set_fiber(id, Map.put(MockRunner.fiber(id), "status", "closed"))

      if backend == Shuttle.Terminal.Rex,
        do: Shuttle.Test.FakeRex.reply("session.close_window", {"request timed out", :timeout}),
        else: MockRunner.set_kill_session_failure(true)

      sync_poll_cycle!(poller)
      assert %{session: ^session, pid: watcher} = Poller.worker_status(poller, id)
      assert Process.alive?(watcher)
      assert reap_stop_count(backend) == 1
      sync_poll_cycle!(poller)
      assert reap_stop_count(backend) == 1

      if backend == Shuttle.Terminal.Rex,
        do: Shuttle.Test.FakeRex.clear_reply("session.close_window"),
        else: MockRunner.set_kill_session_failure(false)

      :sys.replace_state(poller, fn state ->
        %{
          state
          | closed_session_retries: %{session => System.monotonic_time(:millisecond) - 60_001}
        }
      end)

      # Count stop requests at the backend boundary, including an already-absent
      # Rex address that needs no second close_window command.
      :erlang.trace_pattern({Shuttle.WorkerBackend, :stop, 2}, true, [:local])
      :erlang.trace(poller, true, [:call, {:tracer, self()}])
      on_exit(fn -> :erlang.trace_pattern({Shuttle.WorkerBackend, :stop, 2}, false, [:local]) end)
      sync_poll_cycle!(poller)
      ref = :erlang.trace_delivered(poller)
      assert_receive {:trace_delivered, ^poller, ^ref}
      :erlang.trace(poller, false, [:call])
      assert_received {:trace, ^poller, :call, {Shuttle.WorkerBackend, :stop, [_, ^session]}}
      refute_received {:trace, ^poller, :call, {Shuttle.WorkerBackend, :stop, [_, ^session]}}
      assert Poller.worker_status(poller, id) == nil
      assert reap_stop_count(backend) == 2
    end

    @tag backend: backend
    @tag :review_backoff
    test "closed reaping backs off a failing #{inspect(backend)} stop and retries after cooldown",
         %{backend: backend} do
      {state, session} = closed_reap_fixture(backend)

      if backend == Shuttle.Terminal.Rex,
        do: Shuttle.Test.FakeRex.reply("session.close_window", {"request timed out", :timeout}),
        else: MockRunner.set_kill_session_failure(true)

      fiber = MockRunner.fiber("tests/closed-reap")

      reap =
        &Shuttle.Poller.SessionReconciliation.reap_closed_session(&1, fiber["id"], fiber, session)

      state =
        Shuttle.Poller.SessionReconciliation.reconcile_orphaned_sessions(
          state,
          {:ok, [session]},
          true
        )

      state = reap.(state)
      assert [%{pid: watcher, session: ^session}] = Map.values(state.running)
      on_exit(fn -> if Process.alive?(watcher), do: Shuttle.WorkerWatcher.stop(watcher) end)
      assert reap_stop_count(backend) == 1

      state = %{
        state
        | closed_session_retries: %{session => System.monotonic_time(:millisecond) - 60_001}
      }

      if backend == Shuttle.Terminal.Rex,
        do: Shuttle.Test.FakeRex.clear_reply("session.close_window"),
        else: MockRunner.set_kill_session_failure(false)

      state = reap.(state)
      assert reap_stop_count(backend) == 2
      assert state.closed_session_retries == %{}
      assert :gone = Shuttle.Terminal.status(ReapRunner, session)
    end
  end

  # Startup adoption recognizes every live worker session by the
  # `<leaf>-<uid>-shuttle` name its fiber resolves to, whatever the fiber id
  # looks like and whatever else the listing prints. The boot quarantine is on,
  # so a fresh launch cannot stand in for adoption: the only way a row's fiber
  # shows running in its live session is the boot scan having recognized it.
  @adoptable_orphans [
    {"a fiber's worker", "tests/orphan", []},
    {"a uid-carrying fiber's worker under the uid-keyed session", "tests/orphan-uid",
     uid: "01KTHDNZS287ZSSG8X8V59XKWB"},
    {"uid workers when Shuttle listing warnings go to stderr", "life/french/daily-practice",
     uid: "01KTHDNZS287ZSSG8X8V59XKWB",
     shuttle: "kind: oneshot\nagent: claude-opus\n",
     ls_stderr_warning: true},
    {"a literal hyphenated fiber id", "ai-futures/shuttle/constitution-shuttle-standalone",
     shuttle: "enabled: true\nkind: oneshot\nagent: claude-sonnet\n"}
  ]

  for {{label, fiber_id, row}, index} <- Enum.with_index(@adoptable_orphans) do
    @fiber_id fiber_id
    @row row
    @index index
    test "poller adopts on startup #{label}" do
      fiber_id = @fiber_id
      uid = Keyword.get(@row, :uid, FiberUid.for(fiber_id))
      session = Dispatcher.session_name(fiber_id, uid)
      MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid}))
      MockRunner.set_shuttle(fiber_id, Keyword.get(@row, :shuttle, oneshot_shuttle()))
      MockRunner.set_ls_stderr_warning(Keyword.get(@row, :ls_stderr_warning, false))
      MockRunner.add_tmux_session(session)

      {:ok, poller} =
        start_poller!(
          name: :"test_poller_adopt_orphan_#{@index}",
          runner: MockRunner,
          poll_interval_ms: 60_000,
          felt_stores: [MockRunner.felt_root()],
          boot_quarantine: true
        )

      assert_eventually(fn ->
        snap = Poller.snapshot(poller)

        assert [%{fiber_id: ^fiber_id, state: "running", tmux_session: ^session}] =
                 snap.eligible

        assert snap.pending_launch == []
      end)

      refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
    end
  end

  test "a fiber without an intrinsic id is refused and shown blocked, naming the fix" do
    # Its worker would have no `<leaf>-<uid>-shuttle` name, so the poll's own
    # dispatch attempt is refused, and the board's `blocked` row says why and
    # what to run. A live session under the bare leaf is not a worker and is
    # not adopted in its place.
    fiber_id = "tests/no-uid"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => nil}))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())
    MockRunner.add_tmux_session("no-uid-shuttle")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_no_uid,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert_eventually(fn ->
      blocked = Enum.find(Poller.snapshot(poller).blocked, &(&1.fiber_id == fiber_id))
      assert blocked
      assert blocked.reason =~ "has no intrinsic id"
      assert blocked.reason =~ "felt backfill-ids"
    end)

    refute Enum.any?(Poller.snapshot(poller).eligible, &(&1.state == "running"))

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    # Once the fiber has an id (`felt backfill-ids`), an explicit dispatch
    # launches it, and the next poll drops the row recorded under its slug.
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())
    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, force: true)
    assert session == FiberUid.session(fiber_id)

    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      refute Enum.any?(Poller.snapshot(poller).blocked, &(&1.fiber_id == fiber_id))
    end)
  end

  test "poller adopts a live orphan session for an armed oneshot (no duplicate dispatch)" do
    # Regression for the daemon-restart-drops-all-adoptions bug. After a restart,
    # `candidate_session_lookup` must record the fiber_id for a session name seen
    # exactly once — every uid-keyed name is unique to one fiber. A `Map.update/4`
    # misuse inserted the default grouped sets VERBATIM (the update fun is not
    # applied to the default), so a single-occurrence session kept empty sets,
    # resolved to nil, and the live worker was never adopted.
    #
    # An armed oneshot (status:active dispatches) with a live worker must be
    # adopted as running — NOT duplicate-dispatched by the loop —
    # whether via `candidate_session_lookup` or the dispatch→:already_running
    # adopt. The field symptom this guards: operator/morning-post showing at-rest
    # on the board while a live worker existed.
    fiber_id = "tests/armed-orphan"
    uid = "01KTHDNZS287ZSSG8X8V59XKWD"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid, "status" => "active"}))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\n", "active")
    MockRunner.add_tmux_session(Dispatcher.session_name(fiber_id, uid))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_armed_orphan,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert_eventually(fn ->
      snap = Poller.snapshot(poller)

      assert Enum.any?(snap.eligible, &(&1.fiber_id == fiber_id and &1.state == "running")),
             "an armed oneshot with a live orphan session must be adopted as running"
    end)
  end

  # A status:active oneshot whose worker died while the daemon was down has no
  # live tmux session, so it is simply eligible again — the next poll re-dispatches
  # it. There is no separate
  # "resurrection" path or retry row to assert; the contract is that a fresh
  # session is spawned.
  test "poller re-dispatches a status:active oneshot whose worker died while the daemon was down" do
    fiber_id = "tests/orphan-dispatched-dead"

    MockRunner.set_shuttle(fiber_id, """
    kind: oneshot
    agent: claude-sonnet
    """)

    # A prior dispatch is recorded in the dispatch marker but no tmux session is alive.
    write_dispatch_marker(fiber_id, "577af64b-644a-4733-9e6a-f60d86b6941f")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_resurrect_orphan,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
           end)

    assert wait_until(
             fn ->
               Enum.any?(Poller.snapshot(poller).eligible, &(&1.fiber_id == fiber_id))
             end,
             1_000
           )
  end

  # A whole-loom sync can make the same constitution file readable on every
  # host, but it does not transfer execution ownership. The poll path keeps the
  # strict `shuttle.host` predicate on both ordinary eligibility and orphan
  # recovery, so this host must leave the synced copy alone.
  test "poller does not dispatch a synced fiber copy owned by another host" do
    fiber_id = "tests/orphan-foreign-host"

    MockRunner.set_shuttle(fiber_id, """
    kind: oneshot
    host: some-other-machine
    """)

    write_dispatch_marker(fiber_id, "577af64b-644a-4733-9e6a-f60d86b6941f")

    # own_host_id is the default "test-host", which does not equal
    # "some-other-machine".
    {:ok, poller} =
      start_poller!(
        name: :test_poller_resurrect_foreign_host,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    snap = Poller.snapshot(poller)
    assert snap.claimed_count == 0

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  # The project_dir disqualifier applies to the poll path: a checkout that does
  # not exist on this host means the worker can't run here, owned or not.
  test "poller does not dispatch an active oneshot whose declared project_dir is missing" do
    fiber_id = "tests/orphan-missing-project-dir"

    MockRunner.set_shuttle(fiber_id, """
    kind: oneshot
    host: test-host
    project_dir: /nonexistent/path/shuttle-orphan-missing
    """)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_resurrect_missing_project_dir,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    snap = Poller.snapshot(poller)
    assert snap.eligible == []
    assert snap.claimed_count == 0

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  # The poll path: an absent host: is unowned everywhere (no nil-wildcard).
  # This is the failure mode that, before the cutover, made the wrong daemon
  # grab single-host work. Distinct from the wrong-host case (host present but
  # mismatched) — here host is structurally absent.
  test "poller treats a host-less fiber as ineligible (absent host is unowned)" do
    fiber_id = "tests/host-absent"

    # Write the .md file directly (discovery walks files), bypassing the
    # factory's host injection so the block genuinely has no host: key —
    # exercising the literal "absent host" branch. The fiber is discovered
    # (it carries a shuttle block) but unowned, hence ineligible everywhere.
    dir_path = Path.join([MockRunner.felt_dir(), fiber_id <> ".md"])
    File.mkdir_p!(Path.dirname(dir_path))

    File.write!(dir_path, """
    ---
    status: active
    shuttle:
      enabled: true
      kind: oneshot
      agent: claude-sonnet
    ---
    body
    """)

    fiber = make_fiber(fiber_id)

    MockRunner.set_fiber(
      fiber_id,
      Map.put(fiber, "shuttle", %{
        "enabled" => true,
        "kind" => "oneshot",
        "agent" => "claude-sonnet"
      })
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_host_absent,
        runner: MockRunner,
        own_host_id: "test-host",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    snap = Poller.snapshot(poller)
    assert snap.eligible == []
    assert snap.claimed_count == 0

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  after
    File.rm_rf!(Path.join([MockRunner.felt_dir(), "tests/host-absent.md"]))
  end

  test "poller concludes a standing run whose worker died while the daemon was down" do
    # Dead-orphan handling on the tmux-scan substrate: a standing role whose run
    # is unconcluded but whose tmux session is gone never fired
    # handle_worker_exit (daemon was down across the exit), so the poll-scan
    # concludes the run at its dispatch instant — the role stays armed, and is
    # never re-dispatched off this observation.
    fiber_id = "tests/standing-dead-orphan"

    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    # A far-future schedule so the role is NOT cron-due — the only thing that
    # could touch it is the dead-orphan marker, not a scheduled dispatch.
    MockRunner.set_shuttle(fiber_id, """
    kind: standing
    agent: claude-sonnet
    schedule:
      expr: "0 9 1 1 *"
      tz: Europe/Paris
    """)

    # The marker discriminator: a dispatch marker with no handoff after it
    # marks this as a daemon-down-across-exit dead orphan.
    dispatched = DateTime.utc_now()
    write_dispatch_marker(fiber_id, "dead-session-uuid", dispatched)

    doc_path = "#{MockRunner.felt_dir()}/#{fiber_id}/standing-dead-orphan.md"

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_dead_orphan,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    assert wait_until(fn -> File.read!(doc_path) =~ "handed_off_at:" end)
    assert doc_status_and_handoff(doc_path) == {"active", dispatched}

    # No worker was spawned — the run was concluded, not dispatched.
    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "a second scheduled run that dies dirty is concluded despite its prior handoff" do
    # A dispatch retains the preceding run's handoff. The later dirty death is
    # still unconcluded, so recovery stamps it at its own dispatch instant.
    fiber_id = "tests/standing-inverted-markers"

    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    MockRunner.set_shuttle(fiber_id, """
    kind: standing
    agent: claude-sonnet
    schedule:
      expr: "0 9 1 1 *"
      tz: Europe/Paris
    """)

    # The preceding run's handoff is 94ms before this dispatch.
    dispatched = DateTime.utc_now()
    write_dispatch_marker(fiber_id, "inverted-session-uuid", dispatched)
    write_handoff_marker(fiber_id, DateTime.add(dispatched, -94, :millisecond))

    doc_path = "#{MockRunner.felt_dir()}/#{fiber_id}/standing-inverted-markers.md"

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_inverted,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    assert doc_status_and_handoff(doc_path) == {"active", dispatched}

    # No worker was spawned.
    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "poller leaves a scheduled standing role armed when a dead ADHOC extra-run is its last run" do
    # A force-dispatched ad-hoc extra-run that dies dirty (daemon down across
    # its exit) is concluded like a scheduled one: the role stays armed on its
    # cron cadence.
    fiber_id = "tests/standing-dead-adhoc"

    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    MockRunner.set_shuttle(fiber_id, """
    kind: standing
    agent: claude-sonnet
    schedule:
      expr: "0 9 1 1 *"
      tz: Europe/Paris
    """)

    # Plausible-but-orphaned markers (dispatched, NO handoff — a genuine dirty
    # death, not an inversion) carrying an ad-hoc run_id.
    dispatched = DateTime.utc_now()
    write_dispatch_marker(fiber_id, "dead-adhoc-uuid", dispatched)
    MockRunner.put_shuttle_fields(fiber_id, %{"run_id" => "adhoc-1751558400000"})

    doc_path = "#{MockRunner.felt_dir()}/#{fiber_id}/standing-dead-adhoc.md"

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_dead_adhoc,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    # The scheduled role stays armed, its ad-hoc run concluded.
    assert wait_until(fn -> File.read!(doc_path) =~ "handed_off_at:" end)
    assert doc_status_and_handoff(doc_path) == {"active", dispatched}

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "a wedged tmux ls does not conclude live standing runs" do
    # `tmux ls` timing out means the session list is UNKNOWN, not empty.
    # Reading it as "no sessions" would conclude every armed standing role's
    # run (a fiber WRITE) off a single wedged scan.
    # Uncertainty counts as present (Shuttle.Terminal): the dead-orphan pass must
    # skip the tick and let the next healthy scan decide.
    fiber_id = "tests/standing-tmux-wedged"

    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    # Same shape as the dead-orphan case — armed, dispatched, un-exited, not
    # cron-due — except tmux cannot answer.
    MockRunner.set_shuttle(fiber_id, """
    kind: standing
    agent: claude-sonnet
    schedule:
      expr: "0 9 1 1 *"
      tz: Europe/Paris
    """)

    write_dispatch_marker(fiber_id, "wedged-session-uuid")

    doc_path = "#{MockRunner.felt_dir()}/#{fiber_id}/standing-tmux-wedged.md"

    # MockRunner is reset per test, so the wedge does not bleed across tests.
    MockRunner.set_tmux_ls_timeout(true)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_tmux_wedged,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    # The role's document is untouched: still armed, its run unconcluded.
    assert File.read!(doc_path) =~ "status: active"
    refute File.read!(doc_path) =~ "handed_off_at:"
  end

  for backend <- [Shuttle.Terminal.Tmux, Shuttle.Terminal.Rex] do
    @tag backend: backend
    test "a partial #{inspect(backend)} inventory and failed ps cannot conclude an invisible standing worker",
         %{backend: backend} do
      Env.put_app_env(:terminal_backend, backend)

      if backend == Shuttle.Terminal.Rex do
        Env.put_app_env(:fake_rex, start_supervised!(Shuttle.Test.FakeRex))
        Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
      end

      runner = Shuttle.Test.PollerCase.PhantomRunner

      assert :ok =
               Shuttle.Terminal.launch(
                 runner,
                 "visible-01KTHDNZS287ZSSG8X8V59XKWB-shuttle",
                 MockRunner.felt_root(),
                 "true\n",
                 preflighted: true
               )

      id = "tests/standing-partial-inventory"
      Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

      MockRunner.set_shuttle(id, """
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "0 9 1 1 *"
        tz: Europe/Paris
      """)

      write_dispatch_marker(id, "invisible-conversation")
      MockRunner.set_ps_result({"ps timed out", :timeout})

      {:ok, poller} =
        start_poller!(
          runner: runner,
          poll_interval_ms: 60_000,
          max_concurrent_workers: 0,
          felt_stores: [MockRunner.felt_root()]
        )

      sync_poll_cycle!(poller)
      path = "#{MockRunner.felt_dir()}/#{id}/standing-partial-inventory.md"
      assert File.read!(path) =~ "status: active"
      refute File.read!(path) =~ "handed_off_at:"

      refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "shuttle" and "conclude-run" in args
             end)
    end
  end

  test "poller does not re-dispatch a closed oneshot whose worker is dead" do
    fiber_id = "tests/closed-with-session"

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: oneshot
      agent: claude-sonnet
      """,
      "closed"
    )

    write_dispatch_marker(fiber_id, "closed-uuid")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_closed_not_resurrected,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    # Closed is the don't-re-fire gate: no new session is spawned.
    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "poller clears stale running state when the tmux session disappears" do
    fiber_id = "tests/missing-running-session"

    {:ok, poller} =
      start_poller!(
        name: :test_poller_missing_running_session,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Absorb the boot cycle before the dead session exists, so the only cycle
    # that can observe it is the one this test drives.
    settle_poller!(poller)

    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, [])
    assert session == FiberUid.session(fiber_id)

    MockRunner.remove_tmux_session(session)

    # One cycle does the whole job, and `sync_poll_cycle!` makes it exactly one:
    # `reconcile` clears the dead-session running entry and records the orphan,
    # then the same cycle's dispatch pass finds the fiber eligible again and
    # re-dispatches it. The orphan is a per-cycle observation (see
    # `sync_poll_cycle!`), so bounding the cycle is what makes it assertable —
    # a second cycle would wipe it, having nothing left to observe.
    sync_poll_cycle!(poller)

    new_session_count =
      MockRunner.commands()
      |> Enum.count(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)

    # Whether the fiber is *currently* in `running` is a transient: the watcher
    # for the now-dead session fires a late `{:worker_exited}` that flips it
    # toward a retry, and the retry re-dispatches again — so "running right now"
    # flaps on watcher timing. The stable invariants are the orphan record and
    # the recovery dispatch, so assert those instead of catching the flap.
    assert new_session_count == 2

    snap = Poller.snapshot(poller)

    assert [
             %{
               fiber_id: ^fiber_id,
               tmux_session: ^session,
               reason: "missing_tmux_session"
             }
             | _
           ] = snap.orphans
  end

  test "poller re-adopts a live tmux worker on restart (running is tmux-derived)" do
    # Daemon state is derived and disposable. After a
    # restart the live tmux session is re-adopted by adopt_orphans, so the worker
    # is tracked again — running work survives because tmux owns the process.
    fiber_id = "tests/runtime-rehydrate-live"

    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_runtime_rehydrate_live_1,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, [])
    assert Enum.any?(Poller.snapshot(poller).eligible, &(&1.fiber_id == fiber_id))

    GenServer.stop(poller)

    # The tmux session is still alive (the MockRunner tracks it across the
    # GenServer restart) — the restarted poller re-adopts it from the tmux scan.
    # Its boot quarantine keeps a fresh dispatch from standing in for that.
    {:ok, restarted} =
      start_poller!(
        name: :test_poller_runtime_rehydrate_live_2,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true
      )

    assert wait_until(fn ->
             Poller.snapshot(restarted).eligible
             |> Enum.any?(&(&1.fiber_id == fiber_id and &1.tmux_session == session))
           end)
  end

  test "poller does not track a worker whose tmux session disappeared while daemon was down" do
    # There is no runtime store to rehydrate from: a restart re-scans tmux, and
    # a dead session is simply absent — nothing is tracked as running, and the
    # still-active fiber is re-dispatched fresh on the next poll.
    fiber_id = "tests/runtime-rehydrate-missing"

    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_runtime_rehydrate_missing_1,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, [])

    GenServer.stop(poller)
    MockRunner.remove_tmux_session(session)

    {:ok, restarted} =
      start_poller!(
        name: :test_poller_runtime_rehydrate_missing_2,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # The dead session is not adopted: the restarted poller has no running entry
    # for this fiber.
    state = :sys.get_state(restarted)
    refute Map.has_key?(state.running, fiber_id)
    refute Enum.any?(state.running, fn {_k, m} -> Map.get(m, :fiber_id) == fiber_id end)
  end

  test "poller clears stale parent running state when only a child session exists" do
    fiber_id = "tests/prefix-parent"

    {:ok, poller} =
      start_poller!(
        name: :test_poller_prefix_parent,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # The boot cycle runs before the fiber exists, so no poll re-dispatches it
    # behind the test's own calls once its session is gone.
    settle_poller!(poller)
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, [])
    MockRunner.remove_tmux_session(session)
    MockRunner.add_tmux_session(session <> "/child")

    assert {:ok, ^session} = Poller.dispatch_fiber(poller, fiber_id, [])

    assert Enum.any?(MockRunner.commands(), fn
             {"tmux", ["has-session", "-t", target]} -> target == "=" <> session
             _ -> false
           end)
  end
end
