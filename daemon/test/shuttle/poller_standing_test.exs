defmodule Shuttle.PollerStandingTest do
  # The Poller: standing roles: schedules, ad-hoc runs and lifecycle transitions.
  use Shuttle.Test.PollerCase, async: true

  test "poller does not dispatch a scheduled standing role before it is due" do
    fiber = make_fiber("tests/standing-sleeping", %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber("tests/standing-sleeping", fiber)

    # Slice 2: the dispatch gate is the cron schedule vs now (the stored
    # next_due_at no longer gates). A weekday-09:00 Paris schedule fires no tick
    # inside the poll window during a test run, so the role is not due. The future
    # next_due_at remains only to keep the display path (`due?`) reading
    # `scheduled`.
    MockRunner.set_shuttle(
      "tests/standing-sleeping",
      """
      enabled: true
      kind: standing
      schedule:
        kind: cron
        expr: "0 9 * * 1-5"
        timezone: Europe/Paris
      review:
        state: scheduled
      next_due_at: "2999-01-01T09:00:00+01:00"
      """
    )

    # Just serviced (a "worker dispatched" event at ~now): under the one due rule,
    # a role is due only once a scheduled occurrence elapses AFTER its last
    # service, so a freshly-serviced weekday-09:00 role is not due now. felt's
    # prev_due (the last weekday-09:00 tick) sits before this service; next_due is
    # the future tick → valid (so the snapshot reads "scheduled", not invalid).
    write_dispatch_marker("tests/standing-sleeping", "seed-recent")

    set_resolved_occurrences(
      "tests/standing-sleeping",
      ~U[2026-05-01 09:00:00Z],
      ~U[2999-01-01 09:00:00Z]
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_sleeping,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    assert [%{fiber_id: "tests/standing-sleeping", state: "scheduled"}] =
             Poller.snapshot(poller).standing_roles
  end

  test "poller surfaces a standing-role snapshot from the document (no runtime store)" do
    fiber_id = "tests/standing-lifecycle-persist"
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber(fiber_id, fiber)

    # The standing role is read straight from the document, with no runtime
    # store. Phase is schedule-derived; paused/retired are document facts
    # (status:open/closed), not stored.
    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
      """
    )

    # Recently serviced ⇒ not due now (so it stays scheduled, not running). felt
    # resolves a valid schedule (last tick before this service, next in the
    # future) so the snapshot reads a genuine valid-but-sleeping role, not an
    # invalid one.
    write_dispatch_marker(fiber_id, "seed-recent")
    set_resolved_occurrences(fiber_id, ~U[2026-05-01 09:00:00Z], ~U[2999-01-01 09:00:00Z])

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_lifecycle_persist,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    # The schedule-derived snapshot state is scheduled or due (cron + now), never
    # a review-derived "review"/"accepted".
    assert wait_until(fn ->
             match?([%{fiber_id: ^fiber_id}], Poller.snapshot(poller).standing_roles)
           end)

    assert [%{fiber_id: ^fiber_id, state: state}] = Poller.snapshot(poller).standing_roles
    assert state in ["scheduled", "due"]
  end

  # A status:active standing role dispatches off the cron schedule read straight
  # from the document, with no runtime overlay. An every-minute
  # schedule is reliably due now regardless of wall-clock.
  test "a status:active standing role dispatches off the cron schedule" do
    fiber_id = "tests/standing-wedge"
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "* * * * *"
        tz: Europe/Paris
      """
    )

    # An every-minute schedule's most recent tick is ~now; with no prior service
    # (last_serviced = created_at, old) that elapsed occurrence makes it due.
    now = DateTime.utc_now()
    set_resolved_occurrences(fiber_id, now, DateTime.add(now, 60, :second))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_wedge,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id, state: "running"}] = Poller.snapshot(poller).eligible
    end)
  end

  # A standing role whose last run concluded fires at the next occurrence after
  # that service, whatever else the document says — unless the human paused or
  # retired its schedule, or another host owns it. An outstanding ask does not
  # hold the schedule back.
  for scenario <- [
        :due,
        :quarantine,
        :not_yet_due,
        :asking,
        :stashed,
        :rested,
        :retired,
        :other_host
      ] do
    test "concluded standing schedule: #{scenario}" do
      check_concluded_standing_schedule(unquote(scenario))
    end
  end

  # Action resolution reads the document straight: a standing role has no
  # review, so its Awaiting review drop resolves to nothing, Temper ends the
  # current run of the armed role, and inFlight runs it now.
  test "actions read a standing role's document: no review, temper ends the run, inFlight runs it now" do
    fiber_id = "tests/standing-actions-overlay"
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      schedule:
        expr: "0 9 * * 1"
        tz: Europe/Paris
      """
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_actions_overlay,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    query_opts = [felt_stores: [MockRunner.felt_root()], runner: MockRunner]

    assert_eventually(fn ->
      {:ok, actions} = ActionQueries.actions_for(fiber_id, query_opts)
      ids = Enum.map(actions, &(Map.get(&1, :id) || Map.get(&1, "id")))
      assert "dispatch-ad-hoc" in ids
      assert "close-tempered" in ids
      refute "close-awaiting-review" in ids

      assert {:ok, %{id: "dispatch-ad-hoc"}} =
               ActionQueries.resolve_action(fiber_id, "inFlight", query_opts)

      assert {:ok, %{id: "close-tempered"}} =
               ActionQueries.resolve_action(fiber_id, "tempered", query_opts)

      assert {:error, :standing_unreviewed} =
               ActionQueries.resolve_action(fiber_id, "awaitingReview", query_opts)
    end)
  end

  # Resuming a paused standing role through the Poller arms the felt document
  # (status:active, run concluded) and that arm survives the next poll —
  # there is no runtime cache to clobber it. The document is the truth.
  test "resume through the Poller arms the document and survives the next poll" do
    fiber_id = "tests/standing-resume-sticks"

    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    # Paused is a document fact (status:open). resume arms it (status:active).
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"], "status" => "open"})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      schedule:
        expr: "0 9 * * 1"
        tz: Europe/Paris
      """,
      "open"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_resume_sticks,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, _output} = Poller.lifecycle_transition(poller, :resume, fiber_id)

    # The document is armed to status:active with its run concluded, so it
    # waits for its next tick.
    armed = File.read!("#{MockRunner.felt_dir()}/#{fiber_id}/standing-resume-sticks.md")
    assert armed =~ "status: active"
    assert armed =~ "handed_off_at:"

    sync_poll_cycle!(poller)

    # Still active after the poll — nothing clobbers the document back to paused.
    assert File.read!("#{MockRunner.felt_dir()}/#{fiber_id}/standing-resume-sticks.md") =~
             "status: active"
  end

  # Shuttle writes resume: the Poller shells `shuttle -C <owning store>
  # <verb> <slug> --local` between poll cycles,
  # then re-reads the fiber into its document cache so the board shows the
  # re-arm without waiting for the next poll.
  test "lifecycle_transition shells Shuttle's --local writer and refreshes the document cache" do
    fiber_id = "tests/standing-resume-refresh"
    store = MockRunner.felt_root()

    MockRunner.set_fiber(
      fiber_id,
      make_fiber(fiber_id, %{"tags" => ["constitution", "standing"], "status" => "open"})
    )

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      schedule:
        expr: "0 9 * * 1"
        tz: Europe/Paris
      """,
      "open"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_resume_refresh,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [store]
      )

    assert wait_until(fn -> :sys.get_state(poller, @state_timeout).document_cache_ready end)

    :sys.suspend(poller)
    transition = Task.async(fn -> Poller.lifecycle_transition(poller, :resume, fiber_id) end)
    Process.sleep(20)
    refute {"shuttle", ["-C", store, "resume", fiber_id, "--local"]} in MockRunner.commands()
    :sys.resume(poller)
    assert {:ok, _output} = Task.await(transition, @state_timeout)

    assert {"shuttle", ["-C", store, "resume", fiber_id, "--local"]} in MockRunner.commands()

    assert {:ok, body} = Poller.cached_fiber_documents(poller)

    assert %{fiber: %{"status" => "active"}} =
             Enum.find(body.fibers, &(&1.fiber["slug"] == fiber_id))
  end

  test "a resume that lands during a poll read is not clobbered when the poll completes" do
    # Regression for Symptom B of the poll-merge wedge: a standing-role `resume`
    # arms the felt document (status:active), but a poll Task already in flight
    # — snapshotted while the role was still the paused document — must not
    # revert the resume when it completes. The poll Task only reads; the
    # document is the single source of truth, so the resume stands.
    fiber_id = "tests/standing-resume-during-poll"

    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    # Paused is a document fact (status:open).
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"], "status" => "open"})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      schedule:
        expr: "0 9 * * 1"
        tz: Europe/Paris
      """,
      "open"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_resume_during_poll,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    doc_path = "#{MockRunner.felt_dir()}/#{fiber_id}/standing-resume-during-poll.md"

    # Hold the next poll inside its read-only felt walk; its snapshot still sees
    # the role as the paused document.
    settle_poller!(poller)
    cycles = :sys.get_state(poller, @state_timeout).poll_cycles
    MockRunner.hold_ls()
    send(poller, :run_poll_cycle)
    assert_receive {:ls_held, reader}

    # Resume while the poll is still reading (the GenServer stays responsive).
    assert {:ok, _output} = Poller.lifecycle_transition(poller, :resume, fiber_id)
    assert File.read!(doc_path) =~ "status: active"

    # The held poll completes and applies against current state.
    send(reader, :release_ls)
    assert wait_until(fn -> :sys.get_state(poller, @state_timeout).poll_cycles > cycles end)

    assert File.read!(doc_path) =~ "status: active",
           "a poll completing after the resume reverted it to paused"
  end

  test "direct ad-hoc dispatch creates an ad-hoc standing run before the schedule is due" do
    fiber_id = "tests/standing-force-now"
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      enabled: true
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
      review:
        state: scheduled
      next_due_at: "2999-01-01T09:00:00+01:00"
      """
    )

    # Recently serviced ⇒ the scheduler treats it as not-due, so a plain dispatch
    # is refused; only force/ad-hoc overrides (the point of this test).
    write_dispatch_marker(fiber_id, "seed-recent")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_force_now,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Enabled standing role whose schedule is far in the future: a plain
    # dispatch is refused as not-yet-due (force/ad_hoc overrides the schedule).
    assert {:error, {:not_eligible, :not_due_or_blocked}} =
             Poller.dispatch_fiber(poller, fiber_id, [])

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, force: true, ad_hoc: true)
    assert session == FiberUid.session(fiber_id)

    assert [%{fiber_id: ^fiber_id, state: "running", run_id: run_id}] =
             Poller.snapshot(poller).eligible

    assert String.starts_with?(run_id, "adhoc-")

    end_worker_session(poller, fiber_id)
    sync_poll_cycle!(poller)

    assert MockRunner.commands()
           |> Enum.filter(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)
           |> length() == 1
  end

  test "ad-hoc dispatch of a retired standing role reopens it and spawns" do
    # Every explicit dispatch carries `force` (the controller folds `force or
    # ad_hoc`; Shuttle.Transition passes both), and force IS the human's "go"
    # from the board (New session / Resume / drag) — so a retired role spawns,
    # reopened on the way (the arm itself is exercised in
    # dispatch_integration_test against a real store).
    fiber_id = "tests/standing-retired-adhoc"
    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    fiber =
      make_fiber(fiber_id, %{
        "status" => "closed",
        "tempered" => false,
        "closed-at" => "2026-05-24T10:00:00Z",
        "tags" => ["constitution", "standing"]
      })

    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
      """,
      "closed"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_retired_adhoc,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    # Forced ad_hoc (the human board action) reopens and dispatches the role.
    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, force: true, ad_hoc: true)

    assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "shuttle" and match?(["-C", _, "reopen", ^fiber_id | _], args)
           end)

    assert MockRunner.fiber(fiber_id)["status"] == "active"

    assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "actions/resolve read tmux-live running state, not a stale registry hit" do
    # :dispatch reconciles against tmux before reading state.running,
    # but :actions and :resolve_action used to read the registry raw. So in the
    # window after a worker's session dies (before the poll tick reconciles), a
    # drag→inFlight resolved to `pause` for a worker that no longer exists — and
    # invoke (which reconciles) then 409s. The read legs now derive `running?`
    # from a live tmux check (`live_running?`), matching the dispatch leg —
    # without the eviction side effects (those stay on the poll/dispatch path).
    fiber_id = "tests/reconcile-dead-session"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_reconcile_dead_session,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Let the initial poll auto-dispatch the eligible fiber and settle, so the
    # worker is in state.running and no further poll cycle is queued behind the
    # read legs below. (Driving dispatch via `force:` here instead would race
    # the initial poll's reconcile, which — landing after the kill — would
    # re-dispatch the fiber and re-create a live session.)
    session = FiberUid.session(fiber_id)
    assert wait_until(fn -> Poller.worker_status(poller, fiber_id) != nil end)

    query_opts = [felt_stores: [MockRunner.felt_root()], runner: MockRunner]

    # While the session is live, the running branch is read: inFlight → pause.
    assert {:ok, %{id: "pause"}} = ActionQueries.resolve_action(fiber_id, "inFlight", query_opts)

    # Kill the tmux session WITHOUT a poll tick or :worker_exited message.
    MockRunner.remove_tmux_session(session)

    # The read legs now see the session is gone (live tmux check), so the fiber
    # reads idle and inFlight resolves to a fresh dispatch (not pause). The
    # discriminator is the inFlight resolution — `pause` is in the idle
    # availability set too (drafts→pause), so we assert on resolve, not the set.
    assert {:ok, %{id: "dispatch-ad-hoc"}} =
             ActionQueries.resolve_action(fiber_id, "inFlight", query_opts)

    {:ok, actions} = ActionQueries.actions_for(fiber_id, query_opts)
    ids = Enum.map(actions, &(Map.get(&1, :id) || Map.get(&1, "id")))
    assert "dispatch-ad-hoc" in ids
  end

  test "forced non-ad-hoc standing dispatch keeps scheduled run context for resume" do
    fiber_id = "tests/standing-force-scheduled"
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      enabled: true
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
      review:
        state: scheduled
      next_due_at: "2999-01-01T09:00:00+01:00"
      """
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_force_scheduled,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    set_resolved_occurrences(fiber_id, ~U[2026-11-02 08:00:00Z], ~U[2026-11-09 08:00:00Z])
    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, force: true)

    assert [%{fiber_id: ^fiber_id, state: "running", run_id: run_id}] =
             Poller.snapshot(poller).eligible

    refute String.starts_with?(run_id, "adhoc-")
    assert run_id == "20261102T080000+0000"
  end

  test "forced standing dispatch honors just-filed resume intent before next scheduled window" do
    fiber_id = "tests/standing-force-resume-before-window"
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
      """
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_force_resume_before_window,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # The prior run's session id lives in the per-host dispatch marker; a forced
    # resume reads it from there. The resume directive (`resume_mode: "previous"`)
    # now rides the dispatch call as a transient parameter, not a
    # persisted felt review-comment — so there is no since-window to scope and the
    # "morning-post blocked for days" pathology cannot recur.
    write_dispatch_marker(fiber_id, "stored-standing-session-id")

    assert {:ok, _session} =
             Poller.dispatch_fiber(poller, fiber_id, force: true, resume_mode: "previous")

    script_path = new_session_scripts() |> List.last()
    assert script_path, "expected at least one new-session script"
    script = File.read!(script_path)

    assert script =~ "--resume"
    assert script =~ "stored-standing-session-id"
  end
end
