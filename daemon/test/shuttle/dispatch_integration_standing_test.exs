defmodule Shuttle.DispatchIntegrationStandingTest do
  # Dispatch through the real CLIs: standing roles, downtime recovery and change discovery.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  # The board's "New session" / "Resume" / drag-to-inFlight buttons force-dispatch
  # (force+ad_hoc). On a retired standing role the forced path reopens the doc
  # to status:active AS it spawns — one snappy action, no waiting on the 15s
  # poll, no running worker on a retired card.
  test "forced ad-hoc dispatch arms a retired standing role to active", %{host: host} do
    write_fiber(host, "tests/standing-retired-start", """
    ---
    name: Standing retired, force-dispatched
    status: closed
    tempered: false
    closed-at: "#{DateTime.to_iso8601(DateTime.utc_now())}"
    tags:
      - constitution
      - standing
    shuttle:
      kind: standing
      agent: claude-sonnet
      host: test-host
      project_dir: #{host}
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
    ---
    A retired standing role; the human clicks New session.
    """)

    Shuttle.Test.Env.put_env("SHUTTLE_STORES", host)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_force_rearm,
        runner: IntegrationRunner,
        poll_interval_ms: 600_000,
        felt_stores: [host]
      )

    # Let the first poll warm the document cache (card status comes from here).
    assert eventually(fn ->
             case Poller.cached_fiber_documents(poller) do
               {:ok, body} ->
                 Enum.any?(
                   body.fibers,
                   &(get_in(&1, [:fiber, "slug"]) == "tests/standing-retired-start")
                 )

               _ ->
                 false
             end
           end),
           "expected the document cache to warm with the retired role"

    assert {:ok, _session} =
             Poller.dispatch_fiber(poller, "tests/standing-retired-start",
               force: true,
               ad_hoc: true
             )

    # …and the doc is armed: status:active, closed-at and verdict cleared.
    fm = read_frontmatter(host, "tests/standing-retired-start")
    assert fm["status"] == "active"
    refute Map.has_key?(fm, "closed-at")
    refute Map.has_key?(fm, "tempered")

    # SNAPPY-NOW: the kanban's post-dispatch refetch reads card status from the
    # cached document feed. The shared post-mutation refresh (which the dispatch
    # endpoint calls right after Poller.dispatch_fiber) must make it report
    # active WITHOUT another poll. No send(:run_poll_cycle).
    assert :ok = Poller.refresh_document(poller, "tests/standing-retired-start")
    assert {:ok, body} = Poller.cached_fiber_documents(poller)

    entry =
      Enum.find(body.fibers, &(get_in(&1, [:fiber, "slug"]) == "tests/standing-retired-start"))

    assert entry, "the armed role should still be in the owned feed"
    assert entry.fiber["status"] == "active"
    refute Map.has_key?(entry.fiber, "closed-at")
    refute Map.has_key?(entry.fiber, "tempered")
  end

  # Resuming a paused standing role arms it (status:active) for its NEXT tick —
  # it must NOT re-fire the occurrence its last run served. The schedule is a
  # daily tick at the minute the test starts, not `* * * * *`: the just-served
  # tick sits inside the due-window exactly as an every-minute one would, but no
  # further tick can elapse between resume and the poll. The handed_off_at stamp
  # Shuttle writes with the arm keeps it at rest. Also asserts resume keeps the
  # prior run's outcome.
  test "resume arms a paused standing role without re-firing the just-served tick", %{
    host: host
  } do
    served = DateTime.shift_zone!(DateTime.utc_now(), "Europe/Paris")

    write_fiber(host, "tests/standing-resume-rest", """
    ---
    name: Standing resume-and-rest
    status: open
    horizon: stashed
    outcome: "prior run digest — kept across resume"
    tags:
      - constitution
      - standing
    shuttle:
      kind: standing
      agent: claude-sonnet
      host: test-host
      project_dir: #{host}
      schedule:
        expr: "#{served.minute} #{served.hour} * * *"
        tz: Europe/Paris
    ---
    A paused standing role; the human resumes its schedule.
    """)

    # The last run dispatched long before this minute's occurrence, and never
    # handed off: without the arm's stamp, the occurrence would be due.
    write_dispatch_marker(host, "tests/standing-resume-rest", "resume-rest-uuid", ago(86_000))

    Shuttle.Test.Env.put_env("SHUTTLE_STORES", host)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_resume_rest,
        runner: IntegrationRunner,
        poll_interval_ms: 600_000,
        felt_stores: [host]
      )

    assert eventually(fn ->
             case Poller.cached_fiber_documents(poller) do
               {:ok, body} ->
                 Enum.any?(
                   body.fibers,
                   &(get_in(&1, [:fiber, "slug"]) == "tests/standing-resume-rest")
                 )

               _ ->
                 false
             end
           end),
           "expected the document cache to warm with the paused role"

    assert {:ok, _} = Poller.lifecycle_transition(poller, :resume, "tests/standing-resume-rest")

    fm = read_frontmatter(host, "tests/standing-resume-rest")
    assert fm["status"] == "active"
    assert is_binary(get_in(fm, ["shuttle", "runtime", "handed_off_at"]))
    assert fm["outcome"] == "prior run digest — kept across resume"

    # Now poll: the just-served tick must NOT re-fire. Clear recorded commands
    # so the assertion isolates this poll cycle's dispatch behavior.
    IntegrationRunner.reset(host)
    session = FiberUid.session("tests/standing-resume-rest")
    sync_poll_cycle!(poller)

    refute Enum.any?(IntegrationRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and Enum.any?(args, &(&1 == session))
           end),
           "a freshly-resumed standing role must rest until its next tick"

    assert read_frontmatter(host, "tests/standing-resume-rest")["status"] == "active"
  end

  test "a scalar shuttle field remains an ordinary fiber without stopping dispatch", %{host: host} do
    write_fiber(host, "tests/malformed", """
    ---
    name: Malformed
    status: active
    due: 2026-12-01
    shuttle: oops
    ---
    Body.
    """)

    write_fiber(host, "tests/valid", """
    ---
    name: Valid
    status: active
    shuttle:
      kind: oneshot
      host: test-host
      project_dir: #{host}
    ---
    Work.
    """)

    {:ok, poller} =
      start_poller!(runner: IntegrationRunner, poll_interval_ms: 600_000, felt_stores: [host])

    await_boot_cycle!(poller)

    assert eventually(fn ->
             Enum.any?(IntegrationRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and "new-session" in args
             end)
           end)

    assert {:ok, %{fibers: [%{fiber: fiber}]}} =
             Shuttle.FiberDocuments.get("tests/malformed", felt_stores: [host])

    assert fiber["name"] == "Malformed"
    refute Map.has_key?(fiber, "shuttle")

    assert {:ok, %{fibers: entries}} = Poller.cached_fiber_documents(poller)
    assert %{fiber: cached} = Enum.find(entries, &(&1.fiber["name"] == "Malformed"))
    refute Map.has_key?(cached, "shuttle")

    assert {:ok, %{fibers: [%{fiber: shown}]}} =
             Shuttle.FiberDocuments.get_shuttle("tests/malformed", felt_stores: [host])

    refute Map.has_key?(shown, "shuttle")

    assert {:ok, _, _, frontmatter, _} =
             Shuttle.FiberDoc.read_path(fiber_file(host, "tests/malformed"))

    refute Map.has_key?(frontmatter, "shuttle")
    assert File.read!(fiber_file(host, "tests/malformed")) =~ "shuttle: oops"
    assert Process.alive?(poller)
  end

  @tag :standing_fresh_recovery
  test "a scheduled occurrence after a dead ad-hoc run starts fresh in quarantine", %{host: host} do
    id = seed_due_standing(host)
    {_, 0} = IntegrationRunner.cmd("shuttle", ["mark-runtime", id, "--run-id", "adhoc-dead"], [])

    {:ok, poller} =
      start_poller!(
        runner: IntegrationRunner,
        boot_quarantine: true,
        poll_interval_ms: 600_000,
        felt_stores: [host]
      )

    await_boot_cycle!(poller)
    script = read_run_script()
    assert script =~ "Run:"
    refute script =~ "--resume"
    assert :sys.get_state(poller).boot_quarantine
    runtime = read_frontmatter(host, id)["shuttle"]["runtime"]
    refute runtime["run_id"] =~ "adhoc-"
    sync_poll_cycle!(poller)

    assert Enum.count(IntegrationRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and "new-session" in args
           end) == 1
  end

  # A worker that hands off concludes its own run; its exit, observed or not,
  # changes nothing, and the role rests until its next tick.
  for observed <- [true, false] do
    test "a standing worker that hands off stays armed through its exit, observed #{observed}",
         %{host: host} do
      check_standing_handoff_exit(host, unquote(observed))
    end
  end

  for clean <- [false, true] do
    @tag :standing_downtime_gap
    test "an occurrence during downtime is served exactly once after a #{if clean, do: "clean", else: "dirty"} exit",
         %{host: host} do
      id = seed_due_standing(host, older_handoff: true)

      if unquote(clean), do: write_handoff_marker(host, id, ago(120))

      {:ok, poller} =
        start_poller!(
          runner: IntegrationRunner,
          boot_quarantine: true,
          max_concurrent_workers: 0,
          poll_interval_ms: 600_000,
          felt_stores: [host]
        )

      for _ <- 1..3, do: sync_poll_cycle!(poller)
      assert read_frontmatter(host, id)["status"] == "active"
      :sys.replace_state(poller, &%{&1 | max_concurrent_workers: 1})
      sync_poll_cycle!(poller)
      assert read_run_script() =~ "Run:"
      refute read_run_script() =~ "--resume"

      state = :sys.get_state(poller)
      %{pid: watcher, session: session} = state.running[Poller.running_key(state, id)]
      IntegrationRunner.remove_tmux_session(session)
      send(poller, {:worker_exited, id, watcher, session, :normal_exit})
      :sys.get_state(poller)
      for _ <- 1..3, do: sync_poll_cycle!(poller)

      fm = read_frontmatter(host, id)
      assert fm["status"] == "active"
      assert get_in(fm, ["shuttle", "runtime", "thread_exit_verb"]) == "handed off"

      assert Enum.count(IntegrationRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and "new-session" in args
             end) == 1
    end
  end

  test "a launch failure leaves the blocked feed when a standing constitution is retired", %{
    host: host
  } do
    id = seed_due_standing(host)
    path = fiber_file(host, id)

    File.write!(
      path,
      Regex.replace(
        ~r/^ +project_dir: .*$/m,
        File.read!(path),
        ~s(    project_dir: "#{host}/missing-checkout")
      )
    )

    {:ok, poller} =
      start_poller!(runner: IntegrationRunner, poll_interval_ms: 600_000, felt_stores: [host])

    sync_poll_cycle!(poller)
    assert eventually(fn -> match?([%{attempts: 1}], Poller.snapshot(poller).blocked) end)
    {_, 0} = IntegrationRunner.cmd("shuttle", ["close", id, "--tempered=false", "--local"], [])
    for _ <- 1..3, do: sync_poll_cycle!(poller)
    assert read_frontmatter(host, id)["status"] == "closed"
    assert eventually(fn -> Poller.snapshot(poller).blocked == [] end)
  end

  test "reopening a retired standing constitution concludes its run and waits for its next tick",
       %{host: host} do
    id = seed_due_standing(host)
    {_, 0} = IntegrationRunner.cmd("shuttle", ["close", id, "--tempered=false", "--local"], [])
    {_, 0} = IntegrationRunner.cmd("shuttle", ["reopen", id, "--local"], [])
    fm = read_frontmatter(host, id)
    assert fm["status"] == "active"
    assert is_binary(get_in(fm, ["shuttle", "runtime", "handed_off_at"]))

    {:ok, poller} =
      start_poller!(runner: IntegrationRunner, poll_interval_ms: 600_000, felt_stores: [host])

    for _ <- 1..3, do: sync_poll_cycle!(poller)
    assert read_frontmatter(host, id)["status"] == "active"

    refute Enum.any?(IntegrationRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and "new-session" in args
           end)
  end

  test "a stale active row cannot erase a discard through the dead-role pass", %{host: host} do
    id = seed_due_standing(host)

    {:ok, poller} =
      start_poller!(
        runner: IntegrationRunner,
        max_concurrent_workers: 0,
        poll_interval_ms: 600_000,
        felt_stores: [host]
      )

    state = :sys.get_state(poller)

    stale = %{
      "id" => id,
      "uid" => FiberUid.for(id),
      "status" => "active",
      "shuttle" => %{
        "kind" => "standing",
        "host" => "test-host",
        "runtime" => %{
          "dispatched_at" => DateTime.to_iso8601(DateTime.add(DateTime.utc_now(), -30, :second))
        }
      }
    }

    {_, 0} = IntegrationRunner.cmd("shuttle", ["close", id, "--tempered=false", "--local"], [])
    retired = File.read!(fiber_file(host, id))
    Shuttle.Poller.StandingRoles.reconcile_dead_standing_roles(state, [stale], {:ok, []})
    assert File.read!(fiber_file(host, id)) == retired
    assert read_frontmatter(host, id)["tempered"] == false
  end

  @tag :standing_stale_dead_row
  test "a stale dead-role row cannot conclude a newer untracked run", %{host: host} do
    id = seed_due_standing(host)
    path = fiber_file(host, id)
    File.write!(path, String.replace(File.read!(path), "status: active", "status: open"))

    {:ok, poller} =
      start_poller!(
        runner: IntegrationRunner,
        max_concurrent_workers: 0,
        poll_interval_ms: 600_000,
        felt_stores: [host]
      )

    await_boot_cycle!(poller)
    state = :sys.get_state(poller)
    assert state.running == %{}
    File.write!(path, String.replace(File.read!(path), "status: open", "status: active"))

    {_, 0} =
      IntegrationRunner.cmd("shuttle", ["mark-runtime", id, "--run-id", "scheduled-old"], [])

    {json, 0} = IntegrationRunner.cmd("shuttle", ["show", id, "--json"], [])
    stale = Jason.decode!(json)
    write_dispatch_marker(host, id, "successor-uuid")

    {_, 0} =
      IntegrationRunner.cmd("shuttle", ["mark-runtime", id, "--run-id", "scheduled-new"], [])

    before = File.read!(path)

    Shuttle.Poller.StandingRoles.reconcile_dead_standing_roles(state, [stale], {:ok, []})
    assert File.read!(path) == before

    {json, 0} = IntegrationRunner.cmd("shuttle", ["show", id, "--json"], [])

    Shuttle.Poller.StandingRoles.reconcile_dead_standing_roles(
      state,
      [Jason.decode!(json)],
      {:ok, []}
    )

    fm = read_frontmatter(host, id)
    assert fm["status"] == "active"
    assert is_binary(get_in(fm, ["shuttle", "runtime", "handed_off_at"]))
  end

  test "an active stashed standing schedule stays armed and stashed through an exit", %{
    host: host
  } do
    id = seed_due_standing(host)
    path = fiber_file(host, id)

    File.write!(
      path,
      String.replace(File.read!(path), "status: active", "status: active\nhorizon: stashed")
    )

    assert {:ok, "concluded" <> _} = Shuttle.LifecycleStore.conclude(id)
    fm = read_frontmatter(host, id)
    assert fm["status"] == "active"
    assert fm["horizon"] == "stashed"
    assert is_binary(get_in(fm, ["shuttle", "runtime", "handed_off_at"]))
  end

  test "a retired standing constitution is neither dispatched nor concluded", %{host: host} do
    id = seed_due_standing(host)
    {_, 0} = IntegrationRunner.cmd("shuttle", ["close", id, "--tempered=false", "--local"], [])
    retired = File.read!(fiber_file(host, id))

    {:ok, poller} =
      start_poller!(runner: IntegrationRunner, poll_interval_ms: 600_000, felt_stores: [host])

    for _ <- 1..3, do: sync_poll_cycle!(poller)
    assert File.read!(fiber_file(host, id)) == retired

    refute Enum.any?(IntegrationRunner.commands(), fn {cmd, args} ->
             (cmd == "tmux" and "new-session" in args) or
               (cmd == "shuttle" and "conclude-run" in args)
           end)
  end

  # refresh_document/2 is the shared post-mutation seam every board action calls.
  # It must re-read ANY field change off disk (not just status) and evict a fiber
  # that no longer resolves — so the kanban refetch never snaps a card back to
  # stale cached state while waiting on the poll.
  test "refresh_document re-reads an out-of-band doc change and evicts a vanished fiber",
       %{host: host} do
    write_fiber(host, "tests/refresh-seam", """
    ---
    name: Refresh seam fiber
    status: active
    outcome: original outcome
    tags:
      - constitution
    shuttle:
      kind: oneshot
      agent: claude-sonnet
      host: test-host
    ---
    A fiber whose doc changes out of band.
    """)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_refresh_seam,
        runner: IntegrationRunner,
        poll_interval_ms: 600_000,
        felt_stores: [host]
      )

    assert eventually(fn ->
             case Poller.cached_fiber_documents(poller) do
               {:ok, body} ->
                 Enum.any?(body.fibers, &(get_in(&1, [:fiber, "slug"]) == "tests/refresh-seam"))

               _ ->
                 false
             end
           end),
           "expected the document cache to warm"

    # Warming the cache runs a poll that DISPATCHES this status:active fiber,
    # which shells `shuttle mark-runtime` SYNCHRONOUSLY (before dispatch
    # returns) to stamp the dispatch fields (`shuttle mark-runtime` owns the
    # nested runtime update; `dispatched_at` must exist when the tmux session
    # launches). `eventually` here just waits out the poll
    # cycle itself, not the mark-runtime write, before mutating out of band so
    # the two writes are serialized rather than racing.
    assert eventually(fn ->
             Enum.any?(IntegrationRunner.commands(), fn {cmd, args} ->
               cmd == "shuttle" and match?(["-C", _store, "mark-runtime" | _], args) and
                 "--dispatched-at" in args
             end)
           end),
           "expected the dispatch stamp command to be issued"

    # Mutate a NON-status field out of band, then refresh — no poll cycle.
    write_fiber(host, "tests/refresh-seam", """
    ---
    name: Refresh seam fiber
    status: active
    outcome: changed outcome
    tags:
      - constitution
    shuttle:
      kind: oneshot
      agent: claude-sonnet
      host: test-host
    ---
    A fiber whose doc changes out of band.
    """)

    assert :ok = Poller.refresh_document(poller, "tests/refresh-seam")
    assert {:ok, body} = Poller.cached_fiber_documents(poller)
    entry = Enum.find(body.fibers, &(get_in(&1, [:fiber, "slug"]) == "tests/refresh-seam"))
    assert entry.fiber["outcome"] == "changed outcome"

    # Delete the fiber on disk; refresh evicts it from the feed (no poll).
    File.rm_rf!(Path.join([host, ".felt", "tests", "refresh-seam"]))
    assert :ok = Poller.refresh_document(poller, "tests/refresh-seam")
    assert {:ok, body} = Poller.cached_fiber_documents(poller)
    refute Enum.any?(body.fibers, &(get_in(&1, [:fiber, "slug"]) == "tests/refresh-seam"))
  end

  # resume_mode=fresh explicitly requests a new session — UNCONDITIONALLY, winning
  # over the dirty-death marker heuristic (a dispatch marker with no handoff would
  # otherwise resume). "New session" always means a new session.
  test "resume_mode=fresh takes fresh path even with a resumable dispatch marker", %{host: host} do
    write_fiber(host, "tests/resume-mode-fresh", """
    ---
    name: Resume mode fresh
    status: active
    tags:
      - constitution
    shuttle:
      enabled: true
      kind: oneshot
      agent: claude-sonnet
    ---
    A dispatch marker exists, but resume_mode explicitly says fresh.
    """)

    # Dispatch marker with no handoff after it → dirty-death state the heuristic
    # would resume; resume_mode: "fresh" must override it.
    write_dispatch_marker(host, "tests/resume-mode-fresh", "should-not-be-resumed-uuid")

    assert {:ok, _} =
             Dispatcher.dispatch("tests/resume-mode-fresh",
               runner: IntegrationRunner,
               felt_store: host,
               resume_mode: "fresh"
             )

    script = read_run_script()
    refute script =~ "--resume"
    refute script =~ "send-keys"
  end

  # ── Standing role dispatch ─────────────────────────────────────────────────

  # Standing role with prompt_context: {:standing_run, run_id} uses
  # render_standing_run_prompt: "scheduled run of this standing role", run id,
  # and the awaiting-review framing — NOT the fresh-dispatch orientation.
  test "standing role dispatch embeds run-id and standing framing in prompt", %{host: host} do
    write_fiber(host, "tests/standing-dispatch", """
    ---
    name: Standing dispatch test
    status: active
    tags:
      - constitution
    shuttle:
      enabled: true
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "0 9 * * 1-5"
      review:
        state: scheduled
      next_due_at: "2026-05-01T09:00:00Z"
    ---
    A standing role fiber.
    """)

    assert {:ok, _} =
             Dispatcher.dispatch("tests/standing-dispatch",
               runner: IntegrationRunner,
               felt_store: host,
               prompt_context: {:standing_run, "run-2026-05-07"}
             )

    script = read_run_script()
    # Standing-role framing.
    assert script =~ "Run mode: scheduled"
    assert script =~ "Fiber: tests/standing-dispatch"
    assert script =~ "run-2026-05-07"
    assert script =~ "Felt store: #{host}"
    refute script =~ "read its current body and Status"
    # NOT the fresh-dispatch orientation paragraph.
    refute script =~ "The orchestration system Shuttle dispatched you on this fiber"
  end

  # ── User message block ─────────────────────────────────────────────────────

  # The user's directive rides the dispatch call as the `:user_message` parameter
  # and surfaces as the "From User" block in the prompt, so the worker
  # sees it at the top of context. It is transient — inlined at launch, never
  # persisted — so there is no "consumed by a prior run" suppression to compute.
  test "the user_message dispatch parameter surfaces as a From User block",
       %{host: host} do
    write_fiber(host, "tests/user-message", """
    ---
    name: User message fiber
    status: active
    tags:
      - constitution
    shuttle:
      enabled: true
      kind: oneshot
      agent: claude-sonnet
    ---
    A fiber with a user directive.
    """)

    assert {:ok, _} =
             Dispatcher.dispatch("tests/user-message",
               runner: IntegrationRunner,
               felt_store: host,
               user_message: "Focus on the authentication layer first"
             )

    script = read_run_script()
    assert script =~ "From User"
    assert script =~ "Focus on the authentication layer first"
  end

  # No `:user_message` carried suppresses the From User block. The common case
  # for a fresh constitution dispatched with no directive.
  test "no user_message suppresses the From User block", %{host: host} do
    write_fiber(host, "tests/no-review-comment", """
    ---
    name: No review comment fiber
    status: active
    tags:
      - constitution
    shuttle:
      enabled: true
      kind: oneshot
      agent: claude-sonnet
    ---
    A fresh fiber with no directive.
    """)

    assert {:ok, _} =
             Dispatcher.dispatch("tests/no-review-comment",
               runner: IntegrationRunner,
               felt_store: host
             )

    script = read_run_script()
    refute script =~ "From User"
  end

  @tag :change_discovery
  test "a slow ordinary poll cannot overwrite a newer incremental edit or deletion", %{host: host} do
    gate = start_supervised!({Agent, fn -> false end})
    Shuttle.Test.Env.put_app_env(:discovery_listing_gate, {gate, self()})

    content = fn label ->
      "---\nname: #{label}\nstatus: open\nshuttle:\n  host: test-host\n  kind: oneshot\n---\nBody.\n"
    end

    write_fiber(host, "edited", content.("Original"))
    write_fiber(host, "deleted", content.("Delete me"))

    {:ok, poller} =
      start_poller!(
        runner: PausedListingRunner,
        own_host_id: "test-host",
        felt_stores: [host],
        max_concurrent_workers: 0,
        poll_interval_ms: 600_000,
        full_scan_budget_ms: 0,
        change_interval_ms: 20
      )

    await_boot_cycle!(poller)
    assert eventually(fn -> Map.has_key?(:sys.get_state(poller).change_indexes, host) end)
    cycles = :sys.get_state(poller).poll_cycles
    Agent.update(gate, fn _ -> true end)
    send(poller, :run_poll_cycle)
    assert_receive {:listing_observed, reader}
    write_fiber(host, "edited", content.("Changed"))
    File.rm_rf!(Path.join([host, ".felt", "deleted"]))

    current? = fn ->
      {:ok, body} = Poller.cached_fiber_documents(poller)
      rows = Map.new(body.fibers, &{&1.fiber["slug"], &1.fiber["name"]})
      rows == %{"edited" => "Changed"}
    end

    assert eventually(current?)
    send(reader, :continue_listing)
    assert eventually(fn -> :sys.get_state(poller).poll_cycles > cycles end)
    assert current?.()
  end

  @tag :change_discovery
  test "a serialized document refresh supersedes an in-flight incremental read", %{host: host} do
    gate = start_supervised!({Agent, fn -> false end})
    Shuttle.Test.Env.put_app_env(:discovery_listing_gate, {gate, self()})

    content = fn label ->
      "---\nname: #{label}\nstatus: open\nshuttle:\n  host: test-host\n  kind: oneshot\n---\nBody.\n"
    end

    write_fiber(host, "edited", content.("Original"))

    {:ok, poller} =
      start_poller!(
        runner: PausedListingRunner,
        own_host_id: "test-host",
        felt_stores: [host],
        max_concurrent_workers: 0,
        poll_interval_ms: 600_000,
        full_scan_budget_ms: 0,
        change_interval_ms: 20
      )

    await_boot_cycle!(poller)
    assert eventually(fn -> Map.has_key?(:sys.get_state(poller).change_indexes, host) end)
    Agent.update(gate, fn _ -> true end)
    write_fiber(host, "edited", content.("Read by task"))
    assert_receive {:listing_observed, reader}
    write_fiber(host, "edited", content.("Serialized"))
    assert :ok = Poller.refresh_document(poller, "edited")
    send(reader, :continue_listing)
    assert eventually(fn -> :sys.get_state(poller).change_task == nil end)

    assert {:ok, %{fibers: [%{fiber: %{"name" => "Serialized"}}]}} =
             Poller.cached_fiber_documents(poller)

    assert eventually(fn ->
             rows = :sys.get_state(poller).last_known_listings[host]
             Enum.any?(rows, &(&1["name"] == "Serialized"))
           end)
  end

  @tag :change_discovery
  test "a hot store discovers out-of-band creation, block edits, moves and deletion without a poll",
       %{host: host} do
    write_fiber(host, "plain", "---\nname: Plain\nstatus: open\n---\nA plain fiber.\n")

    {:ok, poller} =
      start_poller!(
        runner: IntegrationRunner,
        felt_stores: [host],
        max_concurrent_workers: 0,
        poll_interval_ms: 600_000,
        full_scan_budget_ms: 0,
        change_interval_ms: 20
      )

    await_boot_cycle!(poller)
    assert eventually(fn -> Map.has_key?(:sys.get_state(poller).change_indexes, host) end)
    own_host = :sys.get_state(poller).own_host_id
    cycles = :sys.get_state(poller).poll_cycles

    rows = fn ->
      {:ok, body} = Poller.cached_fiber_documents(poller)
      Map.new(body.fibers, &{&1.fiber["slug"], &1.fiber})
    end

    write_fiber(
      host,
      "created",
      "---\nid: 01JZ0000000000000000000000\nname: Created\nstatus: open\nshuttle:\n  host: #{own_host}\n  kind: oneshot\n---\nCreated outside Shuttle.\n"
    )

    assert eventually(fn -> rows.()["created"] != nil end)

    write_fiber(
      host,
      "plain",
      "---\nname: Plain\nstatus: open\noutcome: added by hand\nshuttle:\n  host: #{own_host}\n  kind: oneshot\n---\nA plain fiber.\n"
    )

    assert eventually(fn -> get_in(rows.(), ["plain", "outcome"]) == "added by hand" end)
    # Same-size changes must reach the cache too.
    path = Path.join([host, ".felt", "plain", "plain.md"])
    File.write!(path, String.replace(File.read!(path), "added by hand", "edited by pen"))
    assert eventually(fn -> get_in(rows.(), ["plain", "outcome"]) == "edited by pen" end)
    File.rename!(Path.join([host, ".felt", "created"]), Path.join([host, ".felt", "moved"]))

    File.rename!(
      Path.join([host, ".felt", "moved", "created.md"]),
      Path.join([host, ".felt", "moved", "moved.md"])
    )

    assert eventually(fn ->
             Map.has_key?(rows.(), "moved") and not Map.has_key?(rows.(), "created")
           end)

    File.rm_rf!(Path.join([host, ".felt", "moved"]))
    assert eventually(fn -> not Map.has_key?(rows.(), "moved") end)
    File.write!(path, "---\nname: Plain\nstatus: open\n---\nBlock removed by hand.\n")
    assert eventually(fn -> not Map.has_key?(rows.(), "plain") end)
    assert :sys.get_state(poller).poll_cycles == cycles
  end
end
