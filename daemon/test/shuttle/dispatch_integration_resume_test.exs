defmodule Shuttle.DispatchIntegrationResumeTest do
  # Dispatch through the real CLIs: resume paths and session identity capture.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  # Regression for the launch deadlock: a resume whose target session is GONE
  # must not flap. The run script tries `--resume <id>`
  # and, on failure (claude exits non-zero with "No conversation found"), falls
  # back to a FRESH launch that REUSES the same id (`--session-id <id>`), so the
  # transcript is recreated under it and the next resume succeeds — self-healing.
  # Without this the worker dies in <1s and the daemon re-arms the same dead id on
  # every poll, so the fiber can never be launched. Harness-agnostic: it relies on
  # the resume exit code, not on knowing where any CLI stores transcripts.
  test "resume carries a fresh same-id fallback so a gone session can't deadlock", %{host: host} do
    write_fiber(host, "tests/resume-fallback", """
    ---
    name: Resume fallback fiber
    status: active
    tags:
      - constitution
    shuttle:
      kind: oneshot
      agent: claude-sonnet
    ---
    A fiber whose stored resume session may no longer be resumable.
    """)

    write_dispatch_marker(host, "tests/resume-fallback", "gone-session-uuid-9999")

    assert {:ok, _} =
             Dispatcher.dispatch("tests/resume-fallback",
               runner: IntegrationRunner,
               felt_store: host,
               resume_mode: "previous"
             )

    script = read_run_script()

    # Resume is attempted first...
    assert script =~ "--resume 'gone-session-uuid-9999'"
    # ...with a `|| <fresh>` fallback that reuses the SAME id, so the new session
    # is created under it and the next resume succeeds.
    assert script =~ "|| "
    assert script =~ "--session-id 'gone-session-uuid-9999'"
    # The resume command precedes the fresh fallback on the command line.
    resume_idx = :binary.match(script, "--resume 'gone-session-uuid-9999'") |> elem(0)
    fresh_idx = :binary.match(script, "--session-id 'gone-session-uuid-9999'") |> elem(0)
    assert resume_idx < fresh_idx
  end

  test "kanban resume uses the dispatch marker's session for a codex worker", %{
    host: host
  } do
    write_fiber(host, "tests/kanban-history-resume", """
    ---
    name: Kanban history resume fiber
    status: active
    tags:
      - constitution
    shuttle:
      enabled: true
      kind: oneshot
      agent: codex-sol
    ---
    A codex fiber resumed from its dispatch marker.
    """)

    write_dispatch_marker(
      host,
      "tests/kanban-history-resume",
      "40740310-2345-4e33-a1e4-7950db41ce10"
    )

    Shuttle.SessionLedger.record(
      fiber: "tests/kanban-history-resume",
      session: "40740310-2345-4e33-a1e4-7950db41ce10",
      harness: "codex",
      kind: :dispatch
    )

    assert {:ok, _} =
             Dispatcher.dispatch("tests/kanban-history-resume",
               runner: IntegrationRunner,
               felt_store: host,
               resume_mode: "previous"
             )

    script = read_run_script()
    assert script =~ "codex"
    refute script =~ "--remote"
    assert script =~ "resume '40740310-2345-4e33-a1e4-7950db41ce10'"
    assert script =~ "Mode: resume"
    [_, command] = Regex.run(~r/^(env -u TMUX -u TMUX_PANE codex .*)$/m, script)
    refute command =~ " || "
  end

  # The board Resume button posts user_message with resume_mode=previous.
  # pi takes that as a positional next-turn, not stdin (stdin would flip it
  # into print mode). Assert against the resume half of `resume || fresh` so
  # a fallback that happens to carry From User cannot hide a dropped prompt.
  test "kanban resume for a pi worker injects user_message as the next turn", %{
    host: host
  } do
    write_fiber(host, "tests/kanban-pi-resume-message", """
    ---
    name: Kanban pi resume with message
    status: active
    tags:
      - constitution
    shuttle:
      kind: oneshot
      agent: pi-kimi
    ---
    A pi fiber resumed from the board with a directive.
    """)

    write_dispatch_marker(
      host,
      "tests/kanban-pi-resume-message",
      "pi-resume-session-444"
    )

    assert {:ok, _} =
             Dispatcher.dispatch("tests/kanban-pi-resume-message",
               runner: IntegrationRunner,
               felt_store: host,
               resume_mode: "previous",
               user_message: "Fix the resume path so this actually lands."
             )

    script = read_run_script()

    [resume_half | _] =
      script
      |> String.replace(Dispatcher.passthrough_block(), "")
      |> String.split(" || ", parts: 2)

    assert resume_half =~ "pi"
    assert resume_half =~ "--session 'pi-resume-session-444'"
    assert resume_half =~ "Mode: resume"
    assert resume_half =~ "From User"
    assert resume_half =~ "Fix the resume path so this actually lands."
    refute resume_half =~ "<<<"
  end

  test "poller restoration quietly resumes a dirty conversation with ambiguous turn evidence", %{
    host: host
  } do
    write_fiber(host, "tests/poller-history-resume", """
    ---
    name: Poller history resume fiber
    status: active
    tags:
      - constitution
    shuttle:
      kind: oneshot
      agent: claude-sonnet
      host: test-host
    ---
    A fiber whose resume handle lives in the per-host dispatch marker.
    """)

    # Dispatch marker on file with no handoff after it (dirty death) — the
    # autonomous continuation resumes the marker's session, no directive needed.
    session = "c1a0e5e0-0000-4000-8000-000000000003"
    write_dispatch_marker(host, "tests/poller-history-resume", session)
    write_transcript(session)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_history_resume,
        runner: IntegrationRunner,
        poll_interval_ms: 600_000,
        felt_stores: [host]
      )

    assert {:ok, _} =
             Poller.dispatch_fiber(poller, "tests/poller-history-resume", [])

    script = read_run_script()
    assert script =~ "--resume '#{session}'"
    refute script =~ "Mode: resume"
    refute String.replace(script, Dispatcher.passthrough_block(), "") =~ " || "
  end

  # A human resuming a standing card's session from its History: the Poller
  # runs it as the card's worker, resuming exactly that session (not the
  # latest), with nothing injected and no fresh fallback, so the board, the
  # schedule and delivery all see it as the live worker. It runs where the
  # transcript was filed, even when the declared checkout has gone.
  test "a human-resumed session is the card's worker, on that very session", %{host: host} do
    write_fiber(host, "tests/human-resume", """
    ---
    name: Human resume
    status: active
    tags:
      - constitution
    shuttle:
      kind: standing
      agent: claude-sonnet
      host: test-host
      project_dir: #{Path.join(host, "moved-away")}
      schedule:
        expr: 0 15 * * *
        tz: Europe/Paris
    ---
    A standing card whose earlier run the human picks up again.
    """)

    picked = "c1a0e5e0-0000-4000-8000-0000000000a1"
    write_dispatch_marker(host, "tests/human-resume", "c1a0e5e0-0000-4000-8000-0000000000b2")
    write_handoff_marker(host, "tests/human-resume")
    write_transcript(picked)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_human_resume,
        runner: IntegrationRunner,
        poll_interval_ms: 600_000,
        felt_stores: [host]
      )

    assert {:ok, tmux} =
             Poller.dispatch_fiber(poller, "tests/human-resume",
               force: true,
               ad_hoc: true,
               resume_mode: "previous",
               resume_session: picked,
               work_dir: host
             )

    assert tmux =~ ~r/-shuttle$/
    script = read_run_script()
    assert script =~ "--resume '#{picked}'"
    refute script =~ "Mode: resume"
    refute script =~ "From User"
    refute String.replace(script, Dispatcher.passthrough_block(), "") =~ " || "
    refute script =~ ~r/claude[^\n]* -p /

    assert %{session_uuid: ^picked} = Poller.live_worker(poller, "tests/human-resume")

    assert get_in(read_frontmatter(host, "tests/human-resume"), [
             "shuttle",
             "runtime",
             "session_uuid"
           ]) ==
             picked
  end

  test "resume previous dispatch reaches each harness-specific resume command", %{host: host} do
    matrix = [
      {"claude-sonnet", "claude-session-111", ["claude", "--resume 'claude-session-111'", "<<<"],
       ["codex resume", "pi "]},
      {"pi-kimi", "pi-session-333", ["pi", "--session 'pi-session-333'", "Mode: resume"],
       ["--resume", "<<<"]}
    ]

    for {agent, session_id, expected, forbidden} <- matrix do
      IntegrationRunner.reset(host)
      id = "tests/resume-matrix/#{agent}"

      write_resume_fiber(host, id,
        agent: agent,
        session: session_id
      )

      assert {:ok, _} =
               Dispatcher.dispatch(id,
                 runner: IntegrationRunner,
                 felt_store: host,
                 resume_mode: "previous"
               )

      script = read_run_script()
      for needle <- expected, do: assert(script =~ needle)
      for needle <- forbidden, do: refute(script =~ needle)
    end
  end

  test "resume previous recovers the session id from the dispatch marker for every harness", %{
    host: host
  } do
    matrix = [
      {"claude-sonnet", "claude-history-session", "--resume 'claude-history-session'"},
      {"pi-kimi", "pi-history-session", "--session 'pi-history-session'"}
    ]

    for {agent, session_id, resume_fragment} <- matrix do
      IntegrationRunner.reset(host)
      id = "tests/history-resume-matrix/#{agent}"

      write_resume_fiber(host, id, agent: agent, session: session_id)

      assert {:ok, _} =
               Dispatcher.dispatch(id,
                 runner: IntegrationRunner,
                 felt_store: host,
                 resume_mode: "previous"
               )

      assert read_run_script() =~ resume_fragment
    end
  end

  test "Codex launch captures only its own rollout identity", %{
    host: host
  } do
    root = put_codex_sessions_root(Path.join(host, "codex-sessions"))
    session_dir = codex_day_dir(root, 0)

    work_dir = File.cwd!()
    timestamp = DateTime.utc_now() |> DateTime.add(30, :second) |> DateTime.to_iso8601()

    write_codex_session(
      session_dir,
      "rollout-2999-01-01T00-00-01-zzzz-newer-wrong.jsonl",
      "wrong-human-session",
      work_dir,
      timestamp,
      "Fiber: tests/some-other-fiber"
    )

    write_codex_session(
      session_dir,
      "rollout-2999-01-01T00-00-00-aaaa-worker.jsonl",
      "right-worker-session",
      work_dir,
      timestamp,
      "Fiber: tests/codex-capture"
    )

    write_fiber(host, "tests/codex-capture", """
    ---
    name: Codex capture test
    status: active
    tags:
      - constitution
    shuttle:
      kind: oneshot
      agent: codex-sol
      surface: cli
    ---
    A codex fiber whose session UUID should be captured from its own transcript.
    """)

    assert {:ok, terminal} =
             Dispatcher.dispatch("tests/codex-capture",
               runner: IntegrationRunner,
               felt_store: host,
               work_dir: work_dir
             )

    assert Dispatcher.shuttle_session?(terminal)
    assert read_run_script() =~ "codex"
    refute read_run_script() =~ "--remote"

    assert eventually(fn ->
             {output, 0} =
               IntegrationRunner.cmd("shuttle", ["show", "tests/codex-capture", "--json"], [])

             get_in(Jason.decode!(output), ["shuttle", "runtime", "session_uuid"]) ==
               "right-worker-session"
           end)
  end

  test "Codex launch identity is independent of local rollout day", %{
    host: host
  } do
    root = put_codex_sessions_root(Path.join(host, "codex-sessions"))
    tomorrow = Date.add(Shuttle.HarnessPaths.local_today(), 1)

    work_dir = File.cwd!()
    timestamp = DateTime.utc_now() |> DateTime.add(30, :second) |> DateTime.to_iso8601()

    write_codex_session(
      codex_day_dir(root, 1),
      "rollout-#{Date.to_iso8601(tomorrow)}T00-01-00-aaaa-worker.jsonl",
      "straddle-worker-session",
      work_dir,
      timestamp,
      "Fiber: tests/codex-straddle"
    )

    write_fiber(host, "tests/codex-straddle", """
    ---
    name: Codex straddle test
    status: active
    tags:
      - constitution
    shuttle:
      kind: oneshot
      agent: codex-sol
      surface: cli
    ---
    A codex fiber whose transcript lands after local midnight.
    """)

    assert {:ok, terminal} =
             Dispatcher.dispatch("tests/codex-straddle",
               runner: IntegrationRunner,
               felt_store: host,
               work_dir: work_dir
             )

    assert Dispatcher.shuttle_session?(terminal)

    assert eventually(fn ->
             {output, 0} =
               IntegrationRunner.cmd("shuttle", ["show", "tests/codex-straddle", "--json"], [])

             get_in(Jason.decode!(output), ["shuttle", "runtime", "session_uuid"]) ==
               "straddle-worker-session"
           end)
  end

  # The directory set is derived from the LOCAL civil day, never `Date.utc_today/0`.
  # West of UTC after 17:00 the two disagree and the UTC day names a directory
  # Codex has not created yet. Anchored on `:calendar.local_time/0` — the OS
  # zone, read without a TZ variable and without a time-zone database — rather
  # than on the function under test, so a UTC regression bites whenever the two
  # civil days differ.
  test "codex session dirs are the local civil day and its neighbours" do
    root = put_codex_sessions_root(Path.join(System.tmp_dir!(), "codex-sessions-shape"))
    {{year, month, day}, _time} = :calendar.local_time()
    local_today = Date.new!(year, month, day)

    assert Shuttle.HarnessPaths.local_today() == local_today

    expected =
      for offset <- [1, 0, -1] do
        d = Date.add(local_today, offset)

        Path.join([
          root,
          Integer.to_string(d.year),
          String.pad_leading(Integer.to_string(d.month), 2, "0"),
          String.pad_leading(Integer.to_string(d.day), 2, "0")
        ])
      end

    assert Shuttle.HarnessPaths.codex_session_dirs() == expected

    # The +/-1 window is what makes the fix robust independently of the zone
    # read: no two civil days on earth are more than a day apart, so even a
    # stale or UTC-valued "today" still names a directory inside this set.
    assert abs(Date.diff(local_today, Date.utc_today())) <= 1
  end

  # Interactivity is retired as a dispatch mode: the prompt never renders an
  # "Interactive Mode" block, and a legacy `interactive: true` still sitting in a
  # fiber is inert — the worker loads the skill-owned exit semantics and
  # honors any "wait for me" intent from the From User directive instead.
  test "dispatch prompt stays autonomous and renders no Interactive Mode block, even with a legacy interactive flag",
       %{host: host} do
    write_fiber(host, "tests/legacy-interactive-flag", """
    ---
    name: Legacy interactive flag
    status: active
    tags:
      - constitution
    shuttle:
      kind: oneshot
      agent: claude-sonnet
      interactive: true
    ---
    A fiber carrying a retired interactive flag.
    """)

    assert {:ok, _} =
             Dispatcher.dispatch("tests/legacy-interactive-flag",
               runner: IntegrationRunner,
               felt_store: host
             )

    script = read_run_script()
    refute script =~ "Interactive Mode"
    assert script =~ "Activate the felt and shuttle skills"
    assert script =~ "You are a Shuttle worker"
  end

  # A "talk to me first" directive rides the From User block — the worker reads
  # it at the top of context and waits, no dispatch-mode flag involved.
  test "a talk-first From User directive surfaces in the dispatch prompt", %{host: host} do
    write_fiber(host, "tests/talk-first", """
    ---
    name: Talk first
    status: active
    tags:
      - constitution
    shuttle:
      kind: oneshot
      agent: claude-sonnet
    ---
    A fiber whose dispatch should wait for the human.
    """)

    assert {:ok, _} =
             Dispatcher.dispatch("tests/talk-first",
               runner: IntegrationRunner,
               felt_store: host,
               user_message: "Wait for me before doing anything heavy — let's talk first."
             )

    script = read_run_script()
    assert script =~ "From User"
    assert script =~ "talk first"
  end

  # Resume mode requested but no session UUID: fail loudly. "New session" is
  # the explicit fresh path; Resume should never silently dispatch fresh.
  test "resume mode requested but no session UUID errors instead of dispatching fresh", %{
    host: host
  } do
    write_fiber(host, "tests/resume-no-uuid", """
    ---
    name: Resume no UUID
    status: active
    tags:
      - constitution
    shuttle:
      enabled: true
      kind: oneshot
      agent: claude-sonnet
    ---
    No session UUID in shuttle block.
    """)

    # resume_mode: "previous" requested, but no dispatch marker on this host → no
    # session id to resume.
    assert {:error, :missing_session_id} =
             Dispatcher.dispatch("tests/resume-no-uuid",
               runner: IntegrationRunner,
               felt_store: host,
               resume_mode: "previous"
             )
  end

  # The since-window machinery is GONE — resume_mode is now a transient dispatch
  # parameter, not a persisted directive that could go stale and block every
  # future scheduled run (the "morning-post stuck for 5 days" pathology cannot
  # recur). A scheduled standing run with NO resume_mode carried is always fresh,
  # even when a dispatch marker (a prior run's session) is on file.
  test "scheduled standing-run with no resume directive is always fresh",
       %{host: host} do
    write_fiber(host, "tests/standing-stale-resume", """
    ---
    name: Standing stale resume
    status: active
    tags:
      - constitution
    shuttle:
      enabled: true
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: 0 9 * * 1-5
        tz: Europe/Paris
    ---
    Standing role with a prior run's dispatch marker.
    """)

    # A prior run's dispatch marker (session on file) — but no resume directive is
    # carried on THIS dispatch, and standing roles never auto-resume → fresh.
    write_dispatch_marker(
      host,
      "tests/standing-stale-resume",
      "11111111-2222-3333-4444-555555555555"
    )

    assert {:ok, _} =
             Dispatcher.dispatch("tests/standing-stale-resume",
               runner: IntegrationRunner,
               felt_store: host,
               prompt_context: {:standing_run, "29990101T090000+0000"}
             )

    script = read_run_script()
    # Fresh path: no --resume flag, no dismiss block.
    refute script =~ "--resume"
    refute script =~ "send-keys"
  end

  # When resume_mode: "previous" IS carried but no dispatch marker holds a session
  # id, the fail-loud-on-missing-session contract holds (for standing as for
  # oneshot): "New session" is the explicit fresh path, Resume must never silently
  # start fresh.
  test "scheduled standing-run with resume_mode=previous but no marker fails loud",
       %{host: host} do
    write_fiber(host, "tests/standing-fresh-resume", """
    ---
    name: Standing fresh resume
    status: active
    tags:
      - constitution
    shuttle:
      enabled: true
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: 0 9 * * 1-5
        tz: Europe/Paris
    ---
    Standing role asked to resume with no session on file.
    """)

    assert {:error, :missing_session_id} =
             Dispatcher.dispatch("tests/standing-fresh-resume",
               runner: IntegrationRunner,
               felt_store: host,
               resume_mode: "previous",
               prompt_context: {:standing_run, "20200101T090000+0000"}
             )
  end

  test "poller dispatch API preserves missing session UUID errors", %{host: host} do
    write_fiber(host, "tests/poller-resume-no-uuid", """
    ---
    name: Poller resume no UUID
    status: active
    tags:
      - constitution
    shuttle:
      enabled: true
      kind: oneshot
      agent: claude-sonnet
      host: test-host
    ---
    No session UUID in shuttle block.
    """)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_resume_no_uuid,
        runner: IntegrationRunner,
        poll_interval_ms: 600_000,
        felt_stores: [host]
      )

    assert {:error, :missing_session_id} =
             Poller.dispatch_fiber(poller, "tests/poller-resume-no-uuid", resume_mode: "previous")

    refute Enum.any?(IntegrationRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and Enum.at(args, 0) == "new-session"
           end)

    # The dispatch failure surfaces in the snapshot's `blocked` list so the
    # kanban shows *why* the fiber isn't progressing. Before this, the only
    # signal was a warning log that scrolled by once every 30s.
    snap = Poller.snapshot(poller)

    assert [%{fiber_id: "tests/poller-resume-no-uuid", reason: "missing_session_id"} = entry] =
             snap.blocked

    assert entry.attempts == 1
    assert is_integer(entry.attempted_at)
    assert is_integer(entry.first_attempted_at)
  end

  # The poll cycle evicts dispatch_failures entries when the underlying fiber
  # is no longer discoverable (closed, paused, or had its shuttle block
  # removed). Without eviction, the snapshot would carry stale "blocked"
  # entries the user has no remaining handle on.
  test "blocked entry clears when fiber is closed", %{host: host} do
    write_fiber(host, "tests/blocked-then-closed", """
    ---
    name: Blocked then closed
    status: active
    tags:
      - constitution
    shuttle:
      enabled: true
      kind: oneshot
      agent: claude-sonnet
      host: test-host
    ---
    No session UUID; dispatch will block.
    """)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_blocked_then_closed,
        runner: IntegrationRunner,
        poll_interval_ms: 600_000,
        felt_stores: [host]
      )

    assert {:error, :missing_session_id} =
             Poller.dispatch_fiber(poller, "tests/blocked-then-closed", resume_mode: "previous")

    assert [%{fiber_id: "tests/blocked-then-closed"}] = Poller.snapshot(poller).blocked

    # Close the fiber. The next poll cycle's candidate set no longer
    # contains it, so the dispatch-failure entry should evict.
    {_out, 0} =
      System.cmd("felt", ["-C", host, "edit", "tests/blocked-then-closed", "--status", "closed"],
        stderr_to_stdout: true
      )

    # Re-trigger the poll INSIDE the wait: a single `:run_poll_cycle` is dropped
    # when the async boot poll is still in flight (the `poll_check_in_progress`
    # guard), so the eviction would never run. Sending one each iteration
    # guarantees a poll lands after the boot poll finishes, re-discovers the
    # now-closed fiber as a non-candidate, and evicts the stale blocked entry.
    assert eventually(fn ->
             send(poller, :run_poll_cycle)
             Poller.snapshot(poller).blocked == []
           end),
           "expected blocked entry to evict after fiber closed"
  end

  # Downtime recovery concludes a scheduled run whose worker died without
  # handing off, at its dispatch instant; a run that durably handed off is
  # already concluded and left as it stands. Both stay armed.
  test "downtime recovery concludes a dirty run at its dispatch and leaves a handed-off run",
       %{host: host} do
    # The dead worker's role — armed, no live session, with a dispatch marker and
    # NO handoff after it (the daemon-down case).
    write_fiber(host, "tests/standing-dead", """
    ---
    name: Standing dead-orphan
    status: active
    tags:
      - constitution
      - standing
    shuttle:
      kind: standing
      agent: claude-sonnet
      host: test-host
      schedule:
        expr: "0 8 1 1 *"
        tz: Europe/Paris
    ---
    A standing role whose worker died while the daemon was down.
    """)

    dispatched = ago(60)
    write_dispatch_marker(host, "tests/standing-dead", "dead-session-uuid", dispatched)

    write_fiber(host, "tests/standing-armed", """
    ---
    name: Standing armed (last run handed off)
    status: active
    tags:
      - constitution
      - standing
    shuttle:
      kind: standing
      agent: claude-sonnet
      host: test-host
      schedule:
        expr: "0 8 1 1 *"
        tz: Europe/Paris
    ---
    A standing role whose previous run completed; armed for the next tick.
    """)

    write_dispatch_marker(host, "tests/standing-armed", "completed-session-uuid", ago(60))
    write_handoff_marker(host, "tests/standing-armed")
    handed_off = File.read!(fiber_file(host, "tests/standing-armed"))

    # The conclusion resolves the fiber through FeltStores (SHUTTLE_STORES), not
    # the injected runner — point it at the temp store for the duration.
    Shuttle.Test.Env.put_env("SHUTTLE_STORES", host)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_integration_standing_dead_orphan,
        runner: IntegrationRunner,
        poll_interval_ms: 600_000,
        felt_stores: [host]
      )

    assert eventually(fn ->
             get_in(read_frontmatter(host, "tests/standing-dead"), [
               "shuttle",
               "runtime",
               "handed_off_at"
             ])
           end),
           "expected the dead standing run to be concluded"

    dead_fm = read_frontmatter(host, "tests/standing-dead")
    assert dead_fm["status"] == "active"
    refute Map.has_key?(dead_fm, "closed-at")

    assert_same_instant(
      get_in(dead_fm, ["shuttle", "runtime", "handed_off_at"]),
      DateTime.to_iso8601(dispatched)
    )

    sync_poll_cycle!(poller)
    assert File.read!(fiber_file(host, "tests/standing-armed")) == handed_off

    refute Enum.any?(IntegrationRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and "new-session" in args
           end)
  end
end
