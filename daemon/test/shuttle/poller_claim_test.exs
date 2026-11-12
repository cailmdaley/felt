defmodule Shuttle.PollerClaimTest do
  # The Poller: launch reservations, prepared launches, claims and capture.
  use Shuttle.Test.PollerCase, async: true

  @tag :reservation_visibility
  test "an uncertain attempt is visible, survives restart, and needs explicit operator release" do
    id = "tests/reservation-operator"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\nagent: claude-sonnet\n", "active")
    session = FiberUid.session(id)
    script = Shuttle.WorkerProcess.script_path(session)
    File.write!(script, "sleep 1000\n")
    on_exit(fn -> File.rm(script) end)
    assert :ok = Shuttle.Terminal.LaunchAttempts.record(session, script)
    MockRunner.set_ps_result({"ps timed out", :timeout})

    opts = [
      runner: MockRunner,
      felt_stores: [MockRunner.felt_root()],
      boot_quarantine: true,
      poll_interval_ms: 600_000
    ]

    {:ok, poller} = start_poller!(opts)
    await_boot_cycle!(poller)
    GenServer.stop(poller)
    {:ok, poller} = start_poller!(opts)
    await_boot_cycle!(poller)
    assert :ok = Poller.release_boot_quarantine(poller)
    sync_poll_cycle!(poller)
    assert Enum.any?(Poller.snapshot(poller).blocked, &(&1.fiber_id == id))

    for mode <- [nil, "fresh"] do
      assert {:error, {:launch_reserved, reservation}} =
               Poller.dispatch_fiber(poller, id, force: true, resume_mode: mode)

      assert reservation["worker"] == session
      assert reservation["age_seconds"] >= 0
      assert {:ok, _, _} = DateTime.from_iso8601(reservation["recorded_at"])

      assert {409, %{reason: "launch_reserved", message: message}} =
               ShuttleWeb.DispatchReply.render(id, {:error, {:launch_reserved, reservation}})

      assert message =~ "--release-launch-reservation"
      assert message =~ "duplicate"

      assert Enum.any?(Poller.snapshot(poller).blocked, fn row ->
               row.fiber_id == id and row.reason =~ session and row.reason =~ "duplicate"
             end)
    end

    assert Poller.worker_status(poller, id) == nil
    assert new_session_scripts() == []

    assert {:ok, ^session} =
             Poller.dispatch_fiber(poller, id, force: true, release_launch_reservation: true)

    assert [_] = new_session_scripts()
    assert File.exists?(script)
  end

  @tag :reservation_cooldown
  test "an aging durable hold accumulates failures and stops probing during cooldown" do
    id = "tests/reservation-cooldown"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\nagent: claude-sonnet\n", "active")
    session = FiberUid.session(id)
    script = Shuttle.WorkerProcess.script_path(session)
    File.write!(script, "sleep 1000\n")
    on_exit(fn -> File.rm(script) end)
    assert :ok = Shuttle.Terminal.LaunchAttempts.record(session, script)
    MockRunner.set_ps_result({"ps timed out", :timeout})
    Env.put_app_env(:held_launch_test_pid, self())

    {:ok, poller} =
      start_poller!(
        runner: HeldLaunchRunner,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: false,
        max_concurrent_workers: 0,
        poll_interval_ms: 600_000
      )

    await_boot_cycle!(poller)
    flush_held_launch_probes()
    assert {:error, {:launch_reserved, info}} = Poller.dispatch_fiber(poller, id, [])
    assert_receive :held_launch_probe
    state = :sys.get_state(poller, @state_timeout)
    [{key, first}] = Map.to_list(state.dispatch_failures)

    # Cross an age boundary without waiting on the wall clock. All durable
    # reservation facts stay unchanged; only the remembered display age differs.
    :sys.replace_state(poller, fn state ->
      reason = {:launch_reserved, Map.put(info, "age_seconds", info["age_seconds"] - 1)}
      put_in(state.dispatch_failures[key].reason, reason)
    end)

    assert {:error, {:launch_reserved, _}} = Poller.dispatch_fiber(poller, id, [])
    assert_receive :held_launch_probe
    assert [%{attempts: 2, reason: message}] = Poller.snapshot(poller).blocked
    assert message =~ ~r/\(\d+s old\)/
    assert message =~ "duplicate"
    state = :sys.get_state(poller, @state_timeout)
    assert state.dispatch_failures[key].first_attempted_at == first.first_attempted_at
    flush_held_launch_probes()

    :sys.replace_state(poller, &%{&1 | max_concurrent_workers: 1})
    sync_poll_cycle!(poller)
    refute_receive :held_launch_probe, 50
    assert [%{attempts: 2}] = Poller.snapshot(poller).blocked
    assert Poller.worker_status(poller, id) == nil
    assert new_session_scripts() == []
  end

  @tag :reservation_visibility
  test "a crash after reserving self-heals on confirmed absence" do
    id = "tests/reservation-crash"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\nagent: claude-sonnet\n", "active")
    session = FiberUid.session(id)
    script = Shuttle.WorkerProcess.script_path(session)
    File.write!(script, "sleep 1000\n")
    on_exit(fn -> File.rm(script) end)
    assert :ok = Shuttle.Terminal.LaunchAttempts.record(session, script)
    MockRunner.set_ps_result({"ps timed out", :timeout})

    {:ok, poller} =
      start_poller!(
        runner: MockRunner,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true,
        poll_interval_ms: 600_000
      )

    await_boot_cycle!(poller)
    assert {:error, {:launch_reserved, _}} = Poller.dispatch_fiber(poller, id, force: true)
    MockRunner.set_ps_result({"", 0})
    assert {:ok, ^session} = Poller.dispatch_fiber(poller, id, force: true)
    refute File.exists?(script)
    assert [_] = new_session_scripts()
  end

  @tag :unobserved_cut
  test "a forced fresh request cannot mark an unobserved worker as handed off" do
    id = "tests/fresh-held"
    MockRunner.set_fiber(id, make_fiber(id))

    MockRunner.set_shuttle(
      id,
      "kind: oneshot\nagent: claude-sonnet\nruntime:\n  dispatched_at: 2026-11-04T00:00:00Z\n  session_uuid: held-uuid\n",
      "active"
    )

    MockRunner.set_ps_result({"ps timed out", :timeout})
    original = get_in(MockRunner.fiber(id), ["shuttle", "runtime"])

    {:ok, poller} =
      start_poller!(
        runner: MockRunner,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true,
        poll_interval_ms: 600_000
      )

    await_boot_cycle!(poller)

    assert {:error, :already_running} =
             Poller.dispatch_fiber(poller, id, force: true, resume_mode: "fresh")

    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime"]) == original
    assert Poller.worker_status(poller, id) == nil
    assert new_session_scripts() == []

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             (cmd == "shuttle" and "mark-runtime" in args) or
               (cmd == "tmux" and hd(args) == "kill-session")
           end)
  end

  @tag :claim_evidence
  test "claim cannot replace an untracked worker whose prior launch is currently unobservable" do
    id = "tests/claim-held"
    MockRunner.set_fiber(id, make_fiber(id))

    MockRunner.set_shuttle(
      id,
      "kind: oneshot\nagent: claude-sonnet\nruntime:\n  dispatched_at: 2026-11-04T00:00:00Z\n  session_uuid: held-uuid\n",
      "active"
    )

    MockRunner.add_tmux_session("capture-claimant")
    MockRunner.set_ps_result({"ps timed out", :timeout})
    original = get_in(MockRunner.fiber(id), ["shuttle", "runtime"])

    {:ok, poller} =
      start_poller!(
        runner: MockRunner,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true,
        poll_interval_ms: 600_000
      )

    await_boot_cycle!(poller)

    assert {:error, :already_running} =
             Poller.claim_session(poller, id, "capture-claimant", session_uuid: "second-uuid")

    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime"]) == original
    assert Poller.worker_status(poller, id) == nil

    refute Enum.any?(MockRunner.commands(), fn {command, args} ->
             command == "tmux" and hd(args) == "rename-session"
           end)
  end

  @tag :claim_evidence
  test "a never-launched fiber remains claimable when ps is unobservable" do
    id = "tests/claim-unlaunched"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\nagent: claude-sonnet\n", "active")
    MockRunner.add_tmux_session("capture-claimant")
    MockRunner.set_ps_result({"ps timed out", :timeout})

    {:ok, poller} =
      start_poller!(
        runner: MockRunner,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true,
        poll_interval_ms: 600_000
      )

    await_boot_cycle!(poller)

    assert {:ok, %{session: session}} =
             Poller.claim_session(poller, id, "capture-claimant", session_uuid: "claimed-uuid")

    assert session == FiberUid.session(id)
    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) == "claimed-uuid"
  end

  test "claimed standing worker exit observes its claim dispatch stamp" do
    id = "tests/claim-standing"
    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    MockRunner.set_shuttle(
      id,
      "kind: standing\nhost: test-host\nagent: claude-sonnet\nruntime:\n  dispatched_at: 2026-01-02T00:00:00Z\n  run_id: adhoc-123\n",
      "active"
    )

    MockRunner.add_tmux_session("capture-standing")

    {:ok, poller} =
      start_poller!(
        runner: MockRunner,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true,
        poll_interval_ms: 600_000
      )

    await_boot_cycle!(poller)

    assert {:ok, _} =
             Poller.claim_session(poller, id, "capture-standing",
               session_uuid: "claimed-standing-uuid"
             )

    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"]) !=
             "2026-01-02T00:00:00Z"

    notify_worker_exit(poller, id)
    :sys.get_state(poller, @state_timeout)
    fiber = MockRunner.fiber(id)
    assert fiber["status"] == "active"
    assert get_in(fiber, ["shuttle", "runtime", "thread_exit_verb"]) == "handed off"
  end

  test "watcher exit cannot conclude a newer dispatch than its observation" do
    id = "tests/superseded-standing"
    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    MockRunner.set_shuttle(
      id,
      "kind: standing\nhost: test-host\nagent: claude-sonnet\nruntime:\n  run_id: adhoc-123\n",
      "active"
    )

    MockRunner.add_tmux_session("capture-superseded")

    {:ok, poller} =
      start_poller!(
        runner: MockRunner,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true,
        poll_interval_ms: 600_000
      )

    await_boot_cycle!(poller)

    assert {:ok, _} =
             Poller.claim_session(poller, id, "capture-superseded", session_uuid: "old-run")

    assert {:ok, _} =
             Shuttle.CLI.run([
               "-C",
               MockRunner.felt_root(),
               "mark-runtime",
               id,
               "--dispatched-at",
               "2099-01-01T00:00:00Z",
               "--run-id",
               "scheduled-new"
             ])

    path = MockRunner.fiber(id)["path"]
    before = File.read!(path)
    notify_worker_exit(poller, id)
    :sys.get_state(poller, @state_timeout)
    assert File.read!(path) == before
    assert MockRunner.fiber(id)["status"] == "active"
  end

  @tag :prepared_launch
  test "adoption completes the dispatch boundary and UUID after a crash immediately after spawn" do
    id = "tests/prepared-launch"
    root = MockRunner.felt_root()
    MockRunner.set_fiber(id, make_fiber(id))

    MockRunner.set_shuttle(
      id,
      "kind: oneshot\nhost: test-host\nagent: claude-sonnet\nproject_dir: #{root}\n",
      "active"
    )

    assert catch_throw(
             Dispatcher.dispatch(id,
               runner: CrashAfterCreateRunner,
               felt_store: root,
               prompt_context: {:standing_run, "run-crashed"}
             )
           ) == :daemon_died_after_create

    {"tmux", args} =
      Enum.find(MockRunner.commands(), fn {cmd, args} ->
        cmd == "tmux" and hd(args) == "new-session"
      end)

    script = List.last(args)
    [_, uuid] = Regex.run(~r/--session-id '([^']+)'/, File.read!(script))
    MockRunner.set_ps_result({"812 1 bash -l #{script}\n", 0})
    refute get_in(MockRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"])
    {:ok, poller} = start_poller!(runner: MockRunner, felt_stores: [root])
    await_boot_cycle!(poller)
    assert Poller.session_uuid(poller, id) == uuid
    runtime = get_in(MockRunner.fiber(id), ["shuttle", "runtime"])
    assert is_binary(runtime["dispatched_at"])
    assert runtime["run_id"] == "run-crashed"

    assert Enum.any?(
             Shuttle.SessionLedger.read_since(0),
             &(&1["session"] == uuid and &1["fiber"] == id)
           )
  end

  @tag :prepared_launch
  test "prepared pending capture reconstructs its boundary before acquiring Pi identity" do
    id = "tests/prepared-pi"
    root = MockRunner.felt_root()
    Env.put_env("SHUTTLE_PI_SESSIONS_DIR", Path.join(root, "pi-sessions"))
    MockRunner.set_fiber(id, make_fiber(id))

    MockRunner.set_shuttle(
      id,
      "kind: oneshot\nhost: test-host\nagent: pi-luna\nproject_dir: #{root}\n",
      "active"
    )

    assert catch_throw(
             Dispatcher.dispatch(id,
               runner: CrashAfterCreateRunner,
               felt_store: root,
               work_dir: root
             )
           ) == :daemon_died_after_create

    {"tmux", args} =
      Enum.find(MockRunner.commands(), fn {cmd, args} ->
        cmd == "tmux" and hd(args) == "new-session"
      end)

    script = List.last(args)
    session = FiberUid.session(id)

    assert {:ok, %{"dispatch" => %{"dispatched_at" => boundary, "session_uuid" => nil}}} =
             Shuttle.Terminal.LaunchAttempts.get(session)

    MockRunner.set_ps_result({"812 1 bash -l #{script}\n", 0})
    path = Path.join(Shuttle.HarnessPaths.pi_sessions_dir(root), "session.jsonl")
    File.mkdir_p!(Path.dirname(path))

    File.write!(
      path,
      Jason.encode!(%{
        "type" => "session",
        "id" => "prepared-pi-uuid",
        "cwd" => root,
        "timestamp" => boundary
      }) <> "\n" <> Jason.encode!(%{"text" => "Fiber: #{id}"}) <> "\n"
    )

    {:ok, poller} = start_poller!(runner: MockRunner, felt_stores: [root])
    await_boot_cycle!(poller)
    assert_eventually(fn -> assert Poller.session_uuid(poller, id) == "prepared-pi-uuid" end)
    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"]) == boundary
  end

  @tag :prepared_launch
  test "prepared recovery preserves context when a custom CLI has no known harness" do
    id = "tests/prepared-custom"
    root = MockRunner.felt_root()
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\nhost: other-host\n", "open")
    {:ok, poller} = start_poller!(runner: MockRunner, felt_stores: [root])
    await_boot_cycle!(poller)
    state = :sys.get_state(poller)
    session = FiberUid.session(id)
    script = Path.join(root, "shuttle-run-#{session}.42.sh")
    File.write!(script, "sleep 300")

    facts = %{
      "intent" => "fresh",
      "session_uuid" => nil,
      "dispatched_at" => DateTime.to_iso8601(DateTime.utc_now()),
      "harness" => Shuttle.SessionLedger.harness_for_cli("aider")
    }

    assert :ok = Shuttle.Terminal.LaunchAttempts.record(session, script, %{"dispatch" => facts})
    MockRunner.add_tmux_session(session)
    MockRunner.set_ps_result({"812 1 bash -l #{script}\n", 0})
    worker = %{session: session, context_harness: "custom-context", session_uuid: nil}

    assert {_, recovered} =
             Poller.recover_prepared_worker(state, id, MockRunner.fiber(id), worker)

    assert recovered.context_harness == "custom-context"
    assert recovered.session_uuid == nil
  end

  @tag :prepared_launch
  test "prepared metadata cannot be applied to a successor with the same terminal name" do
    id = "tests/prepared-successor"
    root = MockRunner.felt_root()
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\nhost: test-host\nagent: claude-sonnet\n", "active")

    assert catch_throw(Dispatcher.dispatch(id, runner: CrashAfterCreateRunner, felt_store: root)) ==
             :daemon_died_after_create

    session = FiberUid.session(id)
    MockRunner.remove_tmux_session(session)
    MockRunner.add_tmux_session(session)
    MockRunner.set_ps_result({"812 1 bash -l /tmp/shuttle-run-#{session}.999.sh\n", 0})
    {:ok, poller} = start_poller!(runner: MockRunner, felt_stores: [root])
    await_boot_cycle!(poller)
    assert Poller.session_uuid(poller, id) == nil
    refute get_in(MockRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"])
  end

  @tag :claim_execution
  test "a predecessor claim retry cannot fill a successor's pending identity" do
    id = "tests/stale-claim"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\nhost: test-host\n", "open")
    MockRunner.add_tmux_session("capture-predecessor")
    {:ok, poller} = start_poller!(runner: MockRunner, felt_stores: [MockRunner.felt_root()])
    await_boot_cycle!(poller)

    assert {:ok, %{session: canonical}} =
             Poller.claim_session(poller, id, "capture-predecessor", session_uuid: "old-uuid")

    assert {:ok, _} =
             Poller.claim_session(poller, id, "capture-predecessor", session_uuid: "old-uuid")

    MockRunner.remove_tmux_session(canonical)
    sync_poll_cycle!(poller)
    MockRunner.add_tmux_session("capture-successor")
    assert {:ok, _} = Poller.claim_session(poller, id, "capture-successor", [])
    assert Poller.session_uuid(poller, id) == nil

    assert {:error, :already_running} =
             Poller.claim_session(poller, id, "capture-predecessor", session_uuid: "old-uuid")

    assert Poller.session_uuid(poller, id) == nil
    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) != "old-uuid"

    assert {:error, :already_running} =
             Poller.claim_session(poller, id, "capture-successor", session_uuid: "unproved-uuid")

    assert {:ok, _} = Poller.claim_session(poller, id, "capture-successor", [])
    MockRunner.remove_tmux_session(canonical)
    MockRunner.add_tmux_session(canonical)
    assert {:error, :already_running} = Poller.claim_session(poller, id, "capture-successor", [])
  end

  @tag :terminal_identity
  test "a claim interrupted after alias persistence completes its source rename on retry" do
    id = "tests/interrupted-claim"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\nhost: test-host\n", "open")
    MockRunner.add_tmux_session("capture-interrupted")
    MockRunner.set_ps_result({"812 1 bash -l /tmp/shuttle-run-capture-interrupted.42.sh\n", 0})
    canonical = FiberUid.session(id)
    # The surviving files are the checkpoint at which the daemon loses execution.
    assert catch_throw(
             (fn ->
                aliases =
                  Shuttle.WorkerProcess.claim_aliases(
                    MockRunner,
                    "capture-interrupted",
                    canonical
                  )

                :ok = Shuttle.WorkerProcess.write_migration_aliases(aliases)
                throw(:crashed_before_rename)
              end).()
           ) == :crashed_before_rename

    {:ok, poller} = start_poller!(runner: MockRunner, felt_stores: [MockRunner.felt_root()])
    await_boot_cycle!(poller)

    assert {:ok, %{session: ^canonical}} =
             Poller.claim_session(poller, id, "capture-interrupted",
               session_uuid: "interrupted-uuid"
             )

    assert :present = Shuttle.Terminal.Tmux.probe(MockRunner, canonical)
    assert :absent = Shuttle.Terminal.Tmux.probe(MockRunner, "capture-interrupted")
    assert Poller.session_uuid(poller, id) == "interrupted-uuid"

    assert {:ok, _} =
             Poller.claim_session(poller, id, "capture-interrupted",
               session_uuid: "interrupted-uuid"
             )
  end

  @tag :terminal_identity
  test "claim binds the immutable capture script for liveness" do
    id = "tests/claim-process-alias"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\nhost: test-host\n", "open")
    MockRunner.add_tmux_session("capture-alias")
    MockRunner.set_ps_result({"812 1 bash -l /tmp/shuttle-run-capture-alias.42.sh\n", 0})
    {:ok, poller} = start_poller!(runner: MockRunner, felt_stores: [MockRunner.felt_root()])
    await_boot_cycle!(poller)

    assert {:ok, %{session: canonical}} = Poller.claim_session(poller, id, "capture-alias", [])
    MockRunner.remove_tmux_session(canonical)
    assert Shuttle.Terminal.status(MockRunner, canonical) == :alive
    assert {:ok, names} = Shuttle.Terminal.list_workers(MockRunner)
    assert canonical in names

    successor =
      Shuttle.WorkerProcess.parse("813 1 bash -l /tmp/shuttle-run-capture-alias.43.sh\n")

    assert Shuttle.WorkerProcess.session_process(successor, canonical) == nil
  end

  test "claim registers a live external session: rename, runtime, exit handling" do
    id = "tests/claim-me"
    MockRunner.set_fiber(id, make_fiber(id, %{"uid" => "01KTHDNZS287ZSSG8X8V59XKC1"}))
    MockRunner.set_shuttle(id, oneshot_shuttle())
    MockRunner.add_tmux_session("capture-abc123")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_claim,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, %{session: session}} =
             Poller.claim_session(poller, id, "capture-abc123", session_uuid: "uuid-claim-1")

    # Renamed to the canonical worker name — indistinguishable from a dispatch.
    assert session == "claim-me-01KTHDNZS287ZSSG8X8V59XKC1-shuttle"

    assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "rename-session"
           end)

    snap = Poller.snapshot(poller)
    assert Enum.any?(snap.eligible, &(&1.fiber_id == id))

    # The claim shells `shuttle mark-runtime` to stamp the session UUID into
    # `shuttle.runtime`. Shuttle owns that nested write; the command path and
    # its YAML update are covered by the CLI suite.
    assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "shuttle" and match?(["-C", _store, "mark-runtime" | _], args) and
               "--session" in args and "uuid-claim-1" in args
           end)

    # …and the same fact structurally: a claim is the moment this host learns
    # that an externally-spawned session belongs to this fiber. Recorded under
    # the CANONICAL tmux name, so the ledger matches what everything downstream
    # sees rather than the pre-rename capture name.
    assert [ledger] = Shuttle.SessionLedger.read_since(0)
    assert ledger["kind"] == "claim"
    assert ledger["fiber"] == id
    assert ledger["uid"] == "01KTHDNZS287ZSSG8X8V59XKC1"
    assert ledger["session"] == "uuid-claim-1"
    assert ledger["tmux"] == session
    assert ledger["host"] == Shuttle.Poller.own_host_id()
    refute Map.has_key?(ledger, "agent")

    new_sessions_before =
      Enum.count(MockRunner.commands(), fn {cmd, args} ->
        cmd == "tmux" and hd(args) == "new-session" and Enum.at(args, 3) == session
      end)

    # Exit handling works exactly as for a dispatched active oneshot: the dead
    # session is noticed by reconciliation, the stale running entry clears, and
    # the same poll tick retries the active fiber under its canonical name.
    MockRunner.remove_tmux_session(session)
    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             Enum.count(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session" and Enum.at(args, 3) == session
             end) > new_sessions_before and
               Enum.any?(Poller.snapshot(poller).eligible, &(&1.fiber_id == id))
           end)
  end

  test "claim ledger records an explicit agent but never infers the fiber recipe" do
    id = "tests/claim-explicit-agent"
    MockRunner.set_fiber(id, make_fiber(id, %{"uid" => "01KTHDNZS287ZSSG8X8V59XKC2"}))
    MockRunner.set_shuttle(id, oneshot_shuttle())
    MockRunner.add_tmux_session("capture-explicit-agent")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_claim_explicit_agent,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, %{agent_id: "codex-external"}} =
             Poller.claim_session(poller, id, "capture-explicit-agent",
               agent: "codex-external",
               session_uuid: "uuid-claim-explicit-agent"
             )

    assert [ledger] = Shuttle.SessionLedger.read_since(0)
    assert ledger["kind"] == "claim"
    assert ledger["agent"] == "codex-external"
  end

  test "claim refuses unknown fibers, dead sessions, and double claims" do
    id = "tests/claim-guards"
    MockRunner.set_fiber(id, make_fiber(id, %{"uid" => "01KTHDNZS287ZSSG8X8V59XKC3"}))
    # Foreign documents cannot authorize a local claim. The explicit claim
    # waits until the document is assigned to this host.
    MockRunner.set_shuttle(id, "enabled: true\nkind: oneshot\nhost: other-host\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_claim_guards,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Session not live in tmux.
    assert {:error, :session_not_found} =
             Poller.claim_session(poller, id, "capture-dead", [])

    # Fiber unknown.
    MockRunner.add_tmux_session("capture-live01")

    assert {:error, :not_found} =
             Poller.claim_session(poller, "tests/no-such-fiber", "capture-live01", [])

    # A fiber without an intrinsic id has no worker name to rename the session to.
    no_uid = "tests/claim-no-uid"
    MockRunner.set_fiber(no_uid, make_fiber(no_uid, %{"uid" => nil}))
    MockRunner.set_shuttle(no_uid, "enabled: true\nkind: oneshot\nhost: other-host\n")

    assert {:error, :uid_missing} =
             Poller.claim_session(poller, no_uid, "capture-live01", [])

    assert {:error, :foreign_host} = Poller.claim_session(poller, id, "capture-live01", [])
    MockRunner.set_shuttle(id, "enabled: true\nkind: oneshot\nhost: test-host\n")

    # First claim wins; a different session claiming the same fiber is refused.
    assert {:ok, %{session: canonical}} = Poller.claim_session(poller, id, "capture-live01", [])
    MockRunner.add_tmux_session("capture-live02")
    assert {:error, :already_running} = Poller.claim_session(poller, id, "capture-live02", [])

    # Idempotent retry: re-claiming with the original (now-renamed-away) name
    # or with the canonical name returns the registered session, not an error —
    # a lost claim response must be retryable with the same body.
    assert {:ok, %{session: ^canonical}} = Poller.claim_session(poller, id, "capture-live01", [])
    assert {:ok, %{session: ^canonical}} = Poller.claim_session(poller, id, canonical, [])
  end

  test "claim refuses closed fibers" do
    id = "tests/claim-closed"
    MockRunner.set_fiber(id, make_fiber(id, %{"status" => "closed"}))
    MockRunner.set_shuttle(id, oneshot_shuttle(), "closed")
    MockRunner.add_tmux_session("capture-closed1")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_claim_closed,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:error, :closed} = Poller.claim_session(poller, id, "capture-closed1", [])
  end

  test "claim refuses a fiber with no installed shuttle block" do
    id = "tests/claim-uninstalled"
    MockRunner.set_fiber(id, make_fiber(id, %{"status" => "open"}))
    MockRunner.add_tmux_session("capture-uninstalled1")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_claim_uninstalled,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:error, :not_installed} =
             Poller.claim_session(poller, id, "capture-uninstalled1", session_uuid: "uuid-early")

    # Nothing registered, renamed, or stamped: a retry after install claims cleanly.
    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             (cmd == "tmux" and hd(args) == "rename-session") or
               (cmd == "shuttle" and match?(["-C", _store, "mark-runtime" | _], args))
           end)

    assert Shuttle.SessionLedger.read_since(0) == []

    MockRunner.set_shuttle(id, "enabled: true\nkind: oneshot\nhost: test-host\n", "open")

    assert {:ok, _} =
             Poller.claim_session(poller, id, "capture-uninstalled1", session_uuid: "uuid-early")

    assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "shuttle" and match?(["-C", _store, "mark-runtime" | _], args) and
               "uuid-early" in args
           end)
  end

  # ── Capture (spawn-without-constitution) ──

  test "capture spawns a tmux session from a free-text prompt" do
    {:ok, poller} =
      start_poller!(
        name: :test_poller_capture,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, %{session: "capture-" <> _ = session, agent_id: "claude-opus"}} =
             Poller.capture(poller, "build me a thing", work_dir: "/tmp")

    # Right tmux command: detached session under the capture name, rooted in
    # the requested project dir — the last free boundary before a real agent.
    assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session" and
               Enum.at(args, Enum.find_index(args, &(&1 == "-s")) + 1) == session and
               Enum.at(args, Enum.find_index(args, &(&1 == "-c")) + 1) == "/tmp"
           end)

    # Pre-claim, the capture session is invisible to the shuttle-session
    # machinery (not `-shuttle`-suffixed): a poll does not adopt or kill it.
    sync_poll_cycle!(poller)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "kill-session" and Enum.at(args, 2) =~ "capture-"
           end)
  end
end
