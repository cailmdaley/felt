defmodule Shuttle.PollerDispatchTest do
  # The Poller: dispatch, launch evidence, force-dispatch and continuation.
  use Shuttle.Test.PollerCase, async: true

  test "a worker's run script is named for its tmux session" do
    fiber_id = "tests/script-named"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n", "active")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_script_named,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, force: true)
    script = new_session_scripts() |> List.last() |> Path.basename()
    assert script =~ ~r/^shuttle-run-#{Regex.escape(session)}\.\d+\.sh$/
  end

  @tag :launch_attempt
  test "a failed runtime write cannot lose a successful launch across a poller restart" do
    id = "tests/lost-runtime-marker"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\nagent: claude-sonnet\n", "active")
    Env.put_app_env(:phantom_runtime_write_fails, true)

    opts = [
      runner: PhantomRunner,
      felt_stores: [MockRunner.felt_root()],
      boot_quarantine: true,
      poll_interval_ms: 600_000
    ]

    {:ok, poller} = start_poller!(opts)
    await_boot_cycle!(poller)
    assert {:ok, session} = Poller.dispatch_fiber(poller, id, force: true)
    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"]) == nil
    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) == nil
    GenServer.stop(poller)
    MockRunner.remove_tmux_session(session)
    MockRunner.set_ps_result({"ps timed out", :timeout})
    {:ok, restarted} = start_poller!(opts)
    await_boot_cycle!(restarted)
    assert {:error, {:launch_reserved, _}} = Poller.dispatch_fiber(restarted, id, force: true)
    assert length(new_session_scripts()) == 1
    assert Poller.worker_status(restarted, id) == nil
  end

  describe "launch evidence on a Rex host with an unavailable process scan" do
    @describetag :phantom

    setup do
      alias Shuttle.Test.FakeRex
      Env.put_app_env(:fake_rex, start_supervised!(FakeRex))
      Env.put_app_env(:terminal_backend, Shuttle.Terminal.Rex)
      Env.put_app_env(:os_type, {:unix, :linux})
      Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
      FakeRex.reply("whoami", {"server is not running", 4})
      FakeRex.reply("session.list", {"server is not running", 4})

      Env.put_app_env(:fake_rex_hook, fn
        "server.start" -> FakeRex.clear_reply("session.list")
        _ -> :ok
      end)

      MockRunner.set_ps_result({"ps timed out", :timeout})
      id = "tests/never-launched"
      MockRunner.set_fiber(id, make_fiber(id))
      MockRunner.set_shuttle(id, "kind: oneshot\nagent: claude-sonnet\n", "active")
      {:ok, fiber_id: id}
    end

    @tag :launch_attempt
    test "a timed-out Rex create cannot launch a second worker during uncertain observation", %{
      fiber_id: id
    } do
      alias Shuttle.Test.FakeRex
      session = FiberUid.session(id)

      opts = [
        runner: PhantomRunner,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true,
        poll_interval_ms: 600_000
      ]

      {:ok, poller} = start_poller!(opts)
      await_boot_cycle!(poller)
      counter = :counters.new(1, [])

      Env.put_app_env(:fake_rex_hook, fn
        "server.start" ->
          FakeRex.clear_reply("session.list")

        "session.create" ->
          :counters.add(counter, 1, 1)

          if :counters.get(counter, 1) == 1 do
            FakeRex.sessions(%{
              "session:hidden" => %{
                label: session,
                blocks: [%{"block_id" => "block:hidden", "label" => session}]
              }
            })

            FakeRex.reply("session.create", {"request timed out", :timeout})
          else
            FakeRex.clear_reply("session.create")
          end

        _ ->
          :ok
      end)

      MockRunner.set_ps_result({"", 0})
      assert {:error, {:unknown, _}} = Poller.dispatch_fiber(poller, id, force: true)
      assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"]) == nil
      assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) == nil
      MockRunner.set_ps_result({"ps timed out", :timeout})
      FakeRex.reply("session.list_blocks", {"request timed out", :timeout})
      assert {:error, {:launch_reserved, _}} = Poller.dispatch_fiber(poller, id, force: true)
      assert :counters.get(counter, 1) == 1
      assert Poller.worker_status(poller, id) == nil

      [{_, _, launch_opts}] =
        Enum.filter(FakeRex.calls(), fn {_, args, _} -> "session.create" in args end)

      [window] = Jason.decode!(launch_opts[:input])["initial_windows"]
      ["bash", "-l", script] = window["layout"]["block"]["options"]["command"]
      assert File.exists?(script)

      GenServer.stop(poller)
      {:ok, restarted} = start_poller!(opts)
      await_boot_cycle!(restarted)
      assert {:error, {:launch_reserved, _}} = Poller.dispatch_fiber(restarted, id, force: true)
      assert :counters.get(counter, 1) == 1
      assert File.exists?(script)
    end

    for automatic? <- [false, true] do
      test "a never-launched fiber launches with automatic=#{automatic?}", %{fiber_id: id} do
        {:ok, poller} =
          start_poller!(
            runner: PhantomRunner,
            felt_stores: [MockRunner.felt_root()],
            boot_quarantine: true,
            poll_interval_ms: 600_000
          )

        await_boot_cycle!(poller)
        assert Poller.worker_status(poller, id) == nil
        assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) == nil
        assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"]) == nil

        if unquote(automatic?) do
          assert :ok = Poller.release_boot_quarantine(poller)
          sync_poll_cycle!(poller)
        else
          assert {:ok, _} = Poller.dispatch_fiber(poller, id, force: true)
        end

        assert %{session: session} = Poller.worker_status(poller, id)
        assert session == FiberUid.session(id)
        assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"])
        assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"])

        assert Enum.count(Shuttle.Test.FakeRex.calls(), fn {_, args, _} ->
                 "session.create" in args
               end) == 1
      end
    end

    test "a positively adopted worker without a UUID remains tracked when observation times out",
         %{fiber_id: id} do
      session = FiberUid.session(id)
      MockRunner.set_ps_result({"812 1 bash -l /tmp/shuttle-run-#{session}.1.sh\n", 0})

      {:ok, poller} =
        start_poller!(
          runner: PhantomRunner,
          felt_stores: [MockRunner.felt_root()],
          boot_quarantine: true,
          poll_interval_ms: 600_000
        )

      await_boot_cycle!(poller)
      assert %{pid: watcher, session: ^session} = Poller.worker_status(poller, id)
      assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) == nil
      assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"]) == nil
      MockRunner.set_ps_result({"ps timed out", :timeout})
      sync_poll_cycle!(poller)
      assert %{pid: ^watcher} = Poller.worker_status(poller, id)
      assert {:error, :already_running} = Poller.dispatch_fiber(poller, id, force: true)

      refute Enum.any?(Shuttle.Test.FakeRex.calls(), fn {_, args, _} ->
               "session.create" in args
             end)
    end

    for runtime <- ["  dispatched_at: 2026-11-04T00:00:00Z\n", "  session_uuid: held-uuid\n"] do
      test "unknown liveness with #{String.trim(runtime)} blocks without adopting", %{
        fiber_id: id
      } do
        MockRunner.set_shuttle(
          id,
          "kind: oneshot\nagent: claude-sonnet\nruntime:\n" <> unquote(runtime),
          "active"
        )

        opts = [
          runner: PhantomRunner,
          felt_stores: [MockRunner.felt_root()],
          boot_quarantine: true,
          poll_interval_ms: 600_000
        ]

        {:ok, poller} = start_poller!(opts)
        await_boot_cycle!(poller)
        assert :ok = Poller.release_boot_quarantine(poller)
        sync_poll_cycle!(poller)
        assert Poller.worker_status(poller, id) == nil
        assert {:error, :already_running} = Poller.dispatch_fiber(poller, id, force: true)
        assert Poller.worker_status(poller, id) == nil
        assert :sys.get_state(poller).was_running == MapSet.new()

        GenServer.stop(poller)
        {:ok, restarted} = start_poller!(opts)
        await_boot_cycle!(restarted)
        assert {:error, :already_running} = Poller.dispatch_fiber(restarted, id, force: true)
        assert Poller.worker_status(restarted, id) == nil

        refute Enum.any?(Shuttle.Test.FakeRex.calls(), fn {_, args, _} ->
                 "session.create" in args or "session.new_window" in args
               end)
      end
    end
  end

  describe "a resume onto a transcript a live process tmux cannot see still holds" do
    setup do
      fiber_id = "tests/transcript-held"
      MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))
      MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n", "active")
      write_dispatch_marker(fiber_id, "held-session-uuid-0001")

      {:ok, poller} =
        start_poller!(
          name: :test_poller_transcript_held,
          runner: MockRunner,
          poll_interval_ms: 60_000,
          max_concurrent_workers: 0,
          felt_stores: [MockRunner.felt_root()]
        )

      %{fiber_id: fiber_id, poller: poller}
    end

    test "is refused and parks the fiber blocked with what is true and what to do", ctx do
      # The pre-socket-loss worker: an old-style run script under an orphaned
      # tmux server, its claude still holding the session.
      MockRunner.set_ps_result(
        {"""
           700     1 tmux new-session -d -s shuttle-anchor
           812   700 bash -l /tmp/shuttle-run-9859.sh
           813   812 claude --resume held-session-uuid-0001
         """, 0}
      )

      assert {:error, {:transcript_held, message}} =
               Poller.dispatch_fiber(ctx.poller, ctx.fiber_id,
                 force: true,
                 resume_mode: "previous"
               )

      assert message =~ "pid 813"
      assert message =~ "kill -USR1 700"
      assert new_session_scripts() == []

      blocked = Enum.find(Poller.snapshot(ctx.poller).blocked, &(&1.fiber_id == ctx.fiber_id))
      assert blocked.reason == message

      # Once that process is gone, the resume proceeds.
      MockRunner.set_ps_result({"", 0})

      assert {:ok, _} =
               Poller.dispatch_fiber(ctx.poller, ctx.fiber_id,
                 force: true,
                 resume_mode: "previous"
               )

      assert File.read!(List.last(new_session_scripts())) =~ "held-session-uuid-0001"
    end

    test "is held back when the process scan cannot run", ctx do
      # Uncertainty counts as present: with tmux answering "can't find session"
      # and no process scan, the fiber's own session may still be running, so
      # dispatch holds as already running without adopting an unobserved worker.
      MockRunner.set_ps_result({"ps: boom", 1})

      assert {:error, :already_running} =
               Poller.dispatch_fiber(ctx.poller, ctx.fiber_id,
                 force: true,
                 resume_mode: "previous"
               )

      assert new_session_scripts() == []
    end
  end

  describe "list_shuttle_sessions/1" do
    @live_script """
      700     1 tmux: server
      812   700 bash -l /tmp/shuttle-run-orphan-01KTHDNZS287ZSSG8X8V59XKW1-shuttle.3.sh
      900   700 bash -l /tmp/shuttle-run-resume-held-uuid.4.sh
    """

    test "unites tmux's listing with sessions whose run script still runs" do
      MockRunner.add_tmux_session("visible-01KTHDNZS287ZSSG8X8V59XKW2-shuttle")
      MockRunner.set_ps_result({@live_script, 0})

      assert {:ok, sessions} = Poller.list_shuttle_sessions(%{runner: MockRunner})

      assert Enum.sort(sessions) == [
               "orphan-01KTHDNZS287ZSSG8X8V59XKW1-shuttle",
               "visible-01KTHDNZS287ZSSG8X8V59XKW2-shuttle"
             ]
    end

    test "a server tmux cannot reach still lists its live workers" do
      MockRunner.set_tmux_server_missing(true)
      MockRunner.set_ps_result({@live_script, 0})

      assert Poller.list_shuttle_sessions(%{runner: MockRunner}) ==
               {:ok, ["orphan-01KTHDNZS287ZSSG8X8V59XKW1-shuttle"]}
    end

    test "tmux absence the process scan cannot check is partial, not empty" do
      MockRunner.set_tmux_server_missing(true)
      MockRunner.set_ps_result({"ps: boom", 1})
      assert Poller.list_shuttle_sessions(%{runner: MockRunner}) == {:partial, []}

      MockRunner.set_ps_result({"", 0})
      assert Poller.list_shuttle_sessions(%{runner: MockRunner}) == {:ok, []}
    end
  end

  test "force-dispatch runs a closed fiber while leaving its status untouched" do
    # Manual "New session" / "Resume" buttons on a closed kanban card must
    # spawn a worker even though the fiber is closed (composted/tempered).
    # The Poller's force path bypasses the status check; the Dispatcher's
    # check_not_closed honors `force: true`. Status itself is *not* reopened
    # — closed fibers stay closed; the worker just runs against the current
    # outcome.
    fiber_id = "tests/closed-force"
    fiber = make_fiber(fiber_id, %{"status" => "closed"})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      "enabled: true\nkind: oneshot\nagent: claude-sonnet\n",
      "closed"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_force_closed,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Without force, a closed fiber is not eligible — and the reason now names
    # the cause (closed) so the kanban can say "reopen it first".
    assert {:error, {:not_eligible, :closed}} = Poller.dispatch_fiber(poller, fiber_id, [])
    # With force, the same fiber dispatches.
    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, force: true)
    assert session == FiberUid.session(fiber_id)
  end

  test "force-dispatch runs a draft fiber (status: open)" do
    # A draft (status: open) is not auto-dispatched because status is the sole
    # gate, but it remains available for explicit manual launch —
    # the click is the override.
    fiber_id = "tests/disabled-force"
    fiber = make_fiber(fiber_id, %{"status" => "open"})
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_force_disabled,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert wait_until(fn ->
             get_in(Poller.snapshot(poller), [:document_cache, "entries"]) == 1
           end)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: oneshot
      agent: claude-sonnet
      ask:
        text: Which cut?
        at: "2026-06-01T12:00:00Z"
      """,
      "open"
    )

    Poller.refresh_document(poller, fiber_id)

    assert {:error, {:not_eligible, :disabled}} = Poller.dispatch_fiber(poller, fiber_id, [])
    assert MockRunner.fiber(fiber_id)["shuttle"]["ask"] != nil
    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, force: true)
    refute Map.has_key?(MockRunner.fiber(fiber_id)["shuttle"], "ask")

    assert {"shuttle", ["-C", MockRunner.felt_root(), "ask", fiber_id, "--clear"]} in MockRunner.commands()

    assert {:ok, documents} = Poller.cached_fiber_documents(poller)
    assert [%{fiber: refreshed}] = documents.fibers
    refute get_in(refreshed, ["shuttle", "ask"])
  end

  test "force-dispatch still refuses fibers pinned to a different host" do
    # Host is a real hardware constraint — we can't conjure a worker on
    # another machine. Force relaxes intent, not topology.
    fiber_id = "tests/wrong-host-force"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      "enabled: true\nkind: oneshot\nagent: claude-sonnet\nhost: some-other-machine\n"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_force_wrong_host,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # The refusal now NAMES the cause: the fiber is homed elsewhere, carrying
    # both its declared host and this daemon's own id. The kanban surfaces this
    # as "homed on <host>, can only run there" instead of the misleading
    # "disabled, not yet due, or closed" — the Bug-3 fix.
    assert {:error, {:not_eligible, {:homed_elsewhere, "some-other-machine", "test-host"}}} =
             Poller.dispatch_fiber(poller, fiber_id, force: true)
  end

  test "poller dispatches a due standing role with run context and does not hot-loop after exit" do
    # Uses new-format "kind: standing" (vs legacy "mode: standing") to test backward compat.
    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())
    fiber = make_fiber("tests/standing-due", %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber("tests/standing-due", fiber)

    # Slice 2: due-ness is computed from the cron schedule + now, not a stored
    # next_due_at. `* * * * *` fires every minute, so a tick always lands inside
    # the poll window → the role is due now, deterministically.
    MockRunner.set_shuttle(
      "tests/standing-due",
      """
      enabled: true
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "* * * * *"
        tz: Europe/Paris
      review:
        state: scheduled
      """
    )

    # `* * * * *`'s most recent tick is ~now; with no prior service it is due.
    now = DateTime.utc_now()
    set_resolved_occurrences("tests/standing-due", now, DateTime.add(now, 60, :second))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_due,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert [%{fiber_id: "tests/standing-due", state: "running", run_id: run_id}] =
               Poller.snapshot(poller).eligible

      assert is_binary(run_id)
    end)

    # The exit concludes the run (handed_off_at = now) and leaves the role
    # armed. With an every-minute cron, that stamp is the ONLY thing keeping
    # the occurrence it served from re-firing on the next poll.
    end_worker_session(poller, "tests/standing-due")
    sync_poll_cycle!(poller)

    assert MockRunner.commands()
           |> Enum.filter(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)
           |> length() == 1

    concluded = MockRunner.fiber("tests/standing-due")
    assert concluded["status"] == "active"
    assert is_binary(get_in(concluded, ["shuttle", "runtime", "handed_off_at"]))
    refute Shuttle.Poller.StandingRoles.standing_role_due?(concluded)
  end

  # Slice 4: a stale stored next_due_at no longer fires the role — due-ness is
  # cron-computed against the poll window (the morning-post-drift rule). A role
  # whose only past tick fell outside the window is not dispatched, and its
  # snapshot is a valid schedule-derived state (no review/accepted validation).
  test "poller does not dispatch a standing role whose stored next_due is stale" do
    fiber = make_fiber("tests/standing-stale", %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber("tests/standing-stale", fiber)

    MockRunner.set_shuttle(
      "tests/standing-stale",
      """
      enabled: true
      kind: standing
      schedule:
        kind: cron
        expr: "0 9 * * 1-5"
        timezone: Europe/Paris
      next_due_at: "2000-01-03T09:00:00+01:00"
      """
    )

    # Recently serviced ⇒ not due now (what gates is "has an occurrence elapsed
    # since last service"). Shuttle's prev_due (the last real tick) sits before
    # this service; next_due is the future tick → valid (validation_errors
    # empty) but not due. Shuttle's resolved occurrences provide the schedule
    # times.
    write_dispatch_marker("tests/standing-stale", "seed-recent")
    write_handoff_marker("tests/standing-stale")

    set_resolved_occurrences(
      "tests/standing-stale",
      ~U[2026-05-01 09:00:00Z],
      ~U[2999-01-01 09:00:00Z]
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_stale,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    MockRunner.set_ls_delay(100)
    sync_poll_cycle!(poller)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    assert [%{fiber_id: "tests/standing-stale", state: state, validation_errors: []}] =
             Poller.snapshot(poller).standing_roles

    assert state in ["scheduled", "due"]
  end

  # Slice 4: the snapshot state is schedule-derived (scheduled/due/dormant/
  # running), never a review-derived "review"/"accepted". Paused/retired are
  # document facts the kanban classifier reads from status.
  test "snapshot standing state is schedule-derived, not review-derived" do
    sleeping = make_fiber("tests/standing-review", %{"tags" => ["constitution", "standing"]})

    paused =
      make_fiber("tests/standing-accepted", %{
        "status" => "open",
        "tags" => ["constitution", "standing"]
      })

    MockRunner.set_fiber("tests/standing-review", sleeping)
    MockRunner.set_fiber("tests/standing-accepted", paused)

    # A leftover review block is ignored because no review axis exists; the role reads
    # scheduled (its next weekday-09:00 tick is in the future).
    MockRunner.set_shuttle(
      "tests/standing-review",
      """
      kind: standing
      schedule:
        kind: cron
        expr: "0 9 * * 1-5"
        timezone: Europe/Paris
      """
    )

    # Recently serviced ⇒ not due ⇒ stays "scheduled" (not dispatched/"running").
    # Shuttle resolves a valid schedule (prev before service, next in the future) so
    # the snapshot reads a genuine "valid but sleeping", not an invalid role.
    write_dispatch_marker("tests/standing-review", "seed-recent")

    set_resolved_occurrences(
      "tests/standing-review",
      ~U[2026-05-01 09:00:00Z],
      ~U[2999-01-01 09:00:00Z]
    )

    # A draft role (status: open) still reads scheduled in the schedule-derived
    # snapshot — paused/draft is a document fact (status), surfaced by the kanban
    # classifier from the document, not a StandingRole phase.
    MockRunner.set_shuttle(
      "tests/standing-accepted",
      """
      kind: standing
      schedule:
        kind: cron
        expr: "0 9 * * 1-5"
        timezone: Europe/Paris
      """,
      "open"
    )

    # A draft (status: open) still resolves a valid schedule; its last tick is in
    # the past (outside the 90s display window) so it reads "scheduled".
    set_resolved_occurrences(
      "tests/standing-accepted",
      ~U[2026-05-01 09:00:00Z],
      ~U[2999-01-01 09:00:00Z]
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_snapshot_states,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             length(Poller.snapshot(poller).standing_roles) == 2
           end)

    roles = Poller.snapshot(poller).standing_roles
    assert Enum.find(roles, &(&1.fiber_id == "tests/standing-review")).state == "scheduled"
    assert Enum.find(roles, &(&1.fiber_id == "tests/standing-accepted")).state == "scheduled"
  end

  test "poller skips untracked fibers" do
    fiber = make_fiber("tests/untracked", %{"status" => "untracked"})
    MockRunner.set_fiber("tests/untracked", fiber)
    MockRunner.set_shuttle("tests/untracked", oneshot_shuttle(), "untracked")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_untracked,
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

  test "poller does not double-dispatch" do
    fiber = make_fiber("tests/haiku-dedup")
    MockRunner.set_fiber("tests/haiku-dedup", fiber)
    MockRunner.set_shuttle("tests/haiku-dedup", oneshot_shuttle())
    MockRunner.add_tmux_session(FiberUid.session("tests/haiku-dedup"))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_6,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    # Should not create a new session
    new_session_count =
      MockRunner.commands()
      |> Enum.filter(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)
      |> length()

    assert new_session_count == 0
  end

  test "poller re-dispatches a still-active oneshot after its worker exits (retry collapsed into poll loop)" do
    # Retries run through the poll loop: when a multi-session oneshot worker
    # exits but its document is still status:active, the claim is
    # released and the next poll re-picks it (status:active + no live session →
    # eligible) and starts a fresh session.
    fiber = make_fiber("tests/haiku-retry")
    MockRunner.set_fiber("tests/haiku-retry", fiber)
    MockRunner.set_shuttle("tests/haiku-retry", oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_7,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Dispatch
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      snap1 = Poller.snapshot(poller)
      assert length(snap1.eligible) == 1
    end)

    # Simulate worker exit (tmux session dies). The claim is released; the fiber
    # is no longer running, and the snapshot carries no retry queue.
    end_worker_session(poller, "tests/haiku-retry")

    assert_eventually(fn ->
      snap2 = Poller.snapshot(poller)
      assert length(snap2.eligible) == 0
      refute Map.has_key?(snap2, :retrying)
    end)

    # The next poll re-dispatches it: a second new-session call.
    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             MockRunner.commands()
             |> Enum.count(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)
             |> Kernel.==(2)
           end)
  end

  test "running snapshot keys the in-memory registry and rows by intrinsic uid" do
    fiber_id = "tests/running-uid-keyed"
    uid = "01KTCA2CWXBSNHETE66MXKPVE7"

    fiber = make_fiber(fiber_id, %{"uid" => uid})
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_running_uid_keyed,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, [])

    # The in-memory running registry is keyed by uid.
    state = :sys.get_state(poller, @state_timeout)
    assert Map.has_key?(state.running, uid)
    refute Map.has_key?(state.running, fiber_id)

    # Slice 7: no separate `:runtime` index. The live worker rides the
    # `eligible` row, which carries both the intrinsic uid (the join key) and the
    # felt address (the display/CLI handle).
    snap = Poller.snapshot(poller)
    refute Map.has_key?(snap, :runtime)

    assert [%{fiber_id: ^fiber_id, uid: ^uid, state: "running"}] = snap.eligible
  end

  test "force-dispatch honors resume_mode: previous dispatch param (unified resume path)" do
    # The old kanban-modal flow had two separate paths: "New session"
    # (ad-hoc, force-fresh) and "Resume" (a special accept-then-dispatch
    # dance via shuttle resume). Under unified force semantics, BOTH
    # buttons carry resume_mode on the dispatch call and dispatch with
    # force: true. resolve_resume_intent honors the carried resume_mode
    # regardless of dispatch context (oneshot, standing scheduled, standing
    # ad-hoc).
    fiber_id = "tests/force-resume-unified"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: oneshot
      agent: claude-sonnet
      """
    )

    # The prior session id lives in the per-host dispatch marker the daemon wrote
    # at spawn (the only structured session-id home). resume_mode rides the
    # dispatch call, not a persisted review-comment.
    write_dispatch_marker(fiber_id, "stored-session-id")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_force_resume_unified,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # An explicit force-dispatch carrying resume_mode: "previous" produces a
    # --resume invocation against the dispatch marker's session id, not a fresh
    # new-session.
    _ = Poller.dispatch_fiber(poller, fiber_id, force: true, resume_mode: "previous")

    assert wait_until(fn -> new_session_scripts() != [] end)

    script = new_session_scripts() |> List.last() |> File.read!()

    assert script =~ "--resume"
    assert script =~ "stored-session-id"
  end

  test "poller continuation RESUMES a oneshot that died without a handoff marker" do
    # The resume-on-no-handoff fix. A multi-session oneshot's autonomous
    # continuation: a dispatch marker (with the session id) is on file but there
    # is NO worker-authored handoff marker after it — so the previous session
    # died mid-thought (the remote-machine kill case), and the dispatch must
    # RESUME the transcript rather than loop a fresh, context-less worker.
    fiber_id = "tests/continuation-died"

    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n")

    session = "d1ed0000-0000-4000-8000-000000000001"
    write_dispatch_marker(fiber_id, session)
    write_transcript(session)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_continuation_died,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)
    assert wait_until(fn -> new_session_scripts() != [] end)

    script = new_session_scripts() |> List.last() |> File.read!()
    assert script =~ "--resume"
    assert script =~ session
  end

  test "poller continuation re-dispatches FRESH when the worker left a clean handoff" do
    # The clean-close half: a handoff marker written at or after the last dispatch
    # marks an intentional handoff, so the continuation starts fresh and the next
    # worker reads the `## Status` block (the intentional loop, unchanged).
    fiber_id = "tests/continuation-handoff"

    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n")

    # Back-date the dispatch so the handoff (now) is unambiguously >= dispatch.
    write_dispatch_marker(
      fiber_id,
      "old-session-id",
      DateTime.add(DateTime.utc_now(), -60, :second)
    )

    write_handoff_marker(fiber_id)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_continuation_handoff,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)
    assert wait_until(fn -> new_session_scripts() != [] end)

    script = new_session_scripts() |> List.last() |> File.read!()
    assert script =~ "Fiber: #{fiber_id}"
    refute script =~ "--resume"
    # Fresh means a new transcript, not amnesia: the prompt may NAME the
    # predecessor's session (the lineage line, 3ffc8dc) — what it must never
    # do is resume it.
    assert script =~ "Previous session: old-session-id"
  end

  test "poller releases claim when worker exits and fiber is closed" do
    # Use a fiber ID unique to this test — shared names (like "tests/haiku") can
    # collide with sessions left over from other tests' Pollers/Watchers.
    fiber = make_fiber("tests/haiku-close")
    MockRunner.set_fiber("tests/haiku-close", fiber)
    MockRunner.set_shuttle("tests/haiku-close", oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_8,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Wait for dispatch to install the watcher before closing the fixture.
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert %{pid: watcher} = Poller.worker_status(poller, "tests/haiku-close")
      assert is_pid(watcher)
      assert Poller.snapshot(poller).claimed_count == 1
    end)

    %{pid: watcher, session: session} = Poller.worker_status(poller, "tests/haiku-close")

    # Close the fiber
    MockRunner.set_fiber("tests/haiku-close", %{fiber | "status" => "closed"})
    MockRunner.remove_tmux_session(session)
    send(poller, {:worker_exited, "tests/haiku-close", watcher, session, :normal_exit})

    assert_eventually(fn ->
      snap = Poller.snapshot(poller)
      assert snap.claimed_count == 0
    end)
  end

  test "reconciling a closed fiber with a still-running worker stamps the clean-exit handoff marker" do
    # closed-implies-handoff: a fiber flipping to status:closed while its
    # worker is still running IS the worker's deliberate exit — a crash never
    # changes status, so closed is deliberate by construction. The reaper must
    # stamp handed_off_at exactly as the worker's own `shuttle handoff`
    # would, so the exit reads back as clean (fresh redispatch), never a dirty
    # death (resume).
    fiber_id = "tests/closed-implies-handoff"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_closed_implies_handoff,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Wait for the autonomous tick to dispatch and install the watcher.
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert %{pid: watcher} = Poller.worker_status(poller, fiber_id)
      assert is_pid(watcher)
    end)

    dispatched_fiber = MockRunner.fiber(fiber_id)
    dispatched_at = get_in(dispatched_fiber, ["shuttle", "runtime", "dispatched_at"])
    assert is_binary(dispatched_at)
    refute get_in(dispatched_fiber, ["shuttle", "runtime", "handed_off_at"])

    # The worker's own deliberate exit: status flips to closed while the tmux
    # session (and the daemon's watcher) are still alive. No `shuttle
    # handoff` call — closed itself is now the deliberate-exit signal.
    MockRunner.set_fiber(fiber_id, Map.put(dispatched_fiber, "status", "closed"))

    sync_poll_cycle!(poller)

    # Reaping stamps the clean exit before stale-session cleanup. Wait on the
    # stamp rather than terminal teardown: it is the durable continuation fact.
    assert wait_until(fn ->
             get_in(MockRunner.fiber(fiber_id), ["shuttle", "runtime", "handed_off_at"]) != nil
           end)

    closed_fiber = MockRunner.fiber(fiber_id)
    handed_off_at = get_in(closed_fiber, ["shuttle", "runtime", "handed_off_at"])
    assert is_binary(handed_off_at)

    {:ok, dispatched_dt, _} = DateTime.from_iso8601(dispatched_at)
    {:ok, handed_off_dt, _} = DateTime.from_iso8601(handed_off_at)
    assert DateTime.compare(handed_off_dt, dispatched_dt) != :lt

    assert Shuttle.Continuation.clean_handoff_since_dispatch?(closed_fiber)

    assert Enum.any?(MockRunner.commands(), fn
             {"shuttle", args} -> "mark-runtime" in args and "--handed-off-at" in args
             _ -> false
           end)
  end
end
