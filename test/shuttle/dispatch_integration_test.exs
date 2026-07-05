defmodule Shuttle.DispatchIntegrationTest do
  use ExUnit.Case, async: false

  alias Shuttle.{Dispatcher, Poller}

  # ── Integration Runner ─────────────────────────────────────────────────────
  # Passes `felt` commands to the real felt CLI (with -C felt_store).
  # Intercepts `tmux` calls with an in-memory session set.
  # Named Agent so it can be injected as a module reference into Dispatcher.

  defmodule IntegrationRunner do
    @behaviour Shuttle.Runner

    use Agent

    def start_link(_ \\ []) do
      Agent.start_link(
        fn -> %{felt_store: "", commands: [], tmux_sessions: MapSet.new()} end,
        name: __MODULE__
      )
    end

    def reset(felt_store) do
      Agent.update(__MODULE__, fn _ ->
        %{felt_store: felt_store, commands: [], tmux_sessions: MapSet.new()}
      end)
    end

    def add_tmux_session(session),
      do: Agent.update(__MODULE__, &%{&1 | tmux_sessions: MapSet.put(&1.tmux_sessions, session)})

    def remove_tmux_session(session),
      do:
        Agent.update(__MODULE__, &%{&1 | tmux_sessions: MapSet.delete(&1.tmux_sessions, session)})

    def commands, do: Agent.get(__MODULE__, & &1.commands)
    def tmux_sessions, do: Agent.get(__MODULE__, & &1.tmux_sessions)

    @impl true
    def cmd("felt", args, opts) do
      felt_store = Agent.get(__MODULE__, & &1.felt_store)

      Agent.update(__MODULE__, fn s ->
        %{s | commands: s.commands ++ [{"felt", args}]}
      end)

      # Always use -C felt_store so the real felt finds our temp directory,
      # regardless of working directory. Drop :cd — redundant when -C is set.
      System.cmd("felt", ["-C", felt_store | args], Keyword.drop(opts, [:cd]))
    end

    def cmd("tmux", ["has-session", "-t", session], _opts) do
      Agent.update(__MODULE__, fn s ->
        %{s | commands: s.commands ++ [{"tmux", ["has-session", "-t", session]}]}
      end)

      sessions = Agent.get(__MODULE__, & &1.tmux_sessions)
      if tmux_session_exists?(sessions, session), do: {"", 0}, else: {"can't find session", 1}
    end

    def cmd("tmux", ["new-session" | _] = args, _opts) do
      # args = ["new-session", "-d", "-s", session, "-c", work_dir, "bash", "-l", script_path]
      session = Enum.at(args, 3)

      Agent.update(__MODULE__, fn s ->
        %{
          s
          | commands: s.commands ++ [{"tmux", args}],
            tmux_sessions: MapSet.put(s.tmux_sessions, session)
        }
      end)

      {"", 0}
    end

    def cmd(cmd, args, _opts) do
      Agent.update(__MODULE__, fn s -> %{s | commands: s.commands ++ [{cmd, args}]} end)
      {"", 0}
    end

    defp tmux_session_exists?(sessions, "=" <> session), do: MapSet.member?(sessions, session)

    defp tmux_session_exists?(sessions, session) do
      Enum.any?(sessions, &(&1 == session or String.starts_with?(&1, session <> "/")))
    end
  end

  # ── Setup ──────────────────────────────────────────────────────────────────

  setup do
    start_supervised!(IntegrationRunner)
    host = mk_tmp_felt_store()
    IntegrationRunner.reset(host)

    # Isolate the per-host runtime markers (dispatch / handoff / re-arm) under a
    # throwaway SHUTTLE_DATA_DIR — the substrate that replaced felt history. The
    # dispatcher writes the dispatch marker keyed by the fiber's runtime key (the
    # slug for these uid-less test fibers); resume reads it back.
    prev_data_dir = System.get_env("SHUTTLE_DATA_DIR")

    data_dir =
      Path.join(System.tmp_dir!(), "shuttle-int-markers-#{System.unique_integer([:positive])}")

    File.mkdir_p!(data_dir)
    System.put_env("SHUTTLE_DATA_DIR", data_dir)

    on_exit(fn ->
      File.rm_rf!(host)

      if prev_data_dir,
        do: System.put_env("SHUTTLE_DATA_DIR", prev_data_dir),
        else: System.delete_env("SHUTTLE_DATA_DIR")

      File.rm_rf!(data_dir)
    end)

    {:ok, host: host}
  end

  # ── Continuation helpers (the felt-history replacement) ──

  # Mirror the dispatcher's at-spawn stamp: `session_uuid` + `dispatched_at` into
  # the fiber's `shuttle:` block (the real .md under `host`). `at` lets a test
  # order a later handoff against it. The fiber must already exist (write_fiber).
  defp write_dispatch_marker(host, id, session_id, at \\ DateTime.utc_now()) do
    :ok =
      Shuttle.FiberDoc.edit_path(fiber_md_path(host, id), [
        {:put_nested, "shuttle", "session_uuid", session_id},
        {:put_nested, "shuttle", "dispatched_at", DateTime.to_iso8601(at)}
      ])
  end

  # Mirror the worker's `felt shuttle handoff`: stamp `shuttle.handed_off_at` in
  # RFC3339 UTC — the clean-exit signal the daemon compares against dispatched_at.
  defp write_handoff_marker(host, id, at \\ DateTime.utc_now()) do
    :ok =
      Shuttle.FiberDoc.edit_path(fiber_md_path(host, id), [
        {:put_nested, "shuttle", "handed_off_at", DateTime.to_iso8601(at)}
      ])
  end

  # The fiber's on-disk `.md`: host/.felt/<id segments>/<basename>.md (mirrors
  # write_fiber / read_frontmatter).
  defp fiber_md_path(host, id) do
    parts = String.split(id, "/")
    Path.join([host, ".felt"] ++ parts ++ ["#{List.last(parts)}.md"])
  end

  # Start a Poller under ExUnit's per-test supervisor so it is torn down at test
  # end rather than leaking as a zombie ticker (Poller.start_link links to the
  # test process, but a :normal test exit doesn't kill linked processes). Returns
  # {:ok, pid} so existing `{:ok, poller} = ...` call sites are unchanged. See the
  # same helper + rationale in poller_test.exs.
  defp start_poller!(opts) do
    pid =
      start_supervised!(%{
        id: make_ref(),
        start: {Poller, :start_link, [opts]},
        restart: :temporary
      })

    {:ok, pid}
  end

  # ── Tests ──────────────────────────────────────────────────────────────────

  # Fresh oneshot dispatch — fiber on disk, run-script verified byte-level.
  # Exercises the full path: disk read via real felt, agent resolution,
  # tmux invocation, run-script construction.
  test "fresh dispatch reads fiber from disk and embeds fiber id in run-script", %{host: host} do
    write_fiber(host, "tests/fresh-oneshot", """
    ---
    name: Fresh oneshot test
    status: active
    tags:
      - constitution
    shuttle:
      enabled: true
      kind: oneshot
      agent: claude-sonnet
    ---
    A fresh oneshot fiber.
    """)

    assert {:ok, "fresh-oneshot-shuttle"} =
             Dispatcher.dispatch("tests/fresh-oneshot",
               runner: IntegrationRunner,
               felt_store: host
             )

    script = read_run_script()

    # Banner: fiber id and agent embedded.
    assert script =~ "Shuttle worker — tests/fresh-oneshot"
    assert script =~ "agent=claude-sonnet"

    # Claude fresh dispatch: here-string syntax, fiber ID in prompt.
    assert script =~ "claude"
    assert script =~ "<<<"
    assert script =~ "Fiber: tests/fresh-oneshot"

    # Fresh dispatch: no resume flag, no dismiss block.
    refute script =~ "--resume"
    refute script =~ "send-keys"
  end

  # Closed fiber is refused before any tmux interaction.
  test "closed fiber is refused with :closed", %{host: host} do
    write_fiber(host, "tests/closed-fiber", """
    ---
    name: Closed fiber
    status: closed
    tags:
      - constitution
    shuttle:
      enabled: false
      kind: oneshot
    ---
    A closed fiber.
    """)

    assert {:error, :closed} =
             Dispatcher.dispatch("tests/closed-fiber",
               runner: IntegrationRunner,
               felt_store: host
             )

    # No tmux invocation.
    refute Enum.any?(IntegrationRunner.commands(), fn {cmd, _} -> cmd == "tmux" end)
  end

  # Already-running fiber is refused when its tmux session exists.
  test "already-running fiber is refused with :already_running", %{host: host} do
    write_fiber(host, "tests/running-fiber", """
    ---
    name: Running fiber
    status: active
    tags:
      - constitution
    shuttle:
      enabled: true
      kind: oneshot
      agent: claude-sonnet
    ---
    A running fiber.
    """)

    # Pre-seed the tmux session to simulate a live worker.
    IntegrationRunner.add_tmux_session(Dispatcher.session_name("tests/running-fiber"))

    assert {:error, :already_running} =
             Dispatcher.dispatch("tests/running-fiber",
               runner: IntegrationRunner,
               felt_store: host
             )
  end

  # Unknown fiber is refused cleanly.
  test "unknown fiber is refused with :not_found", %{host: host} do
    assert {:error, :not_found} =
             Dispatcher.dispatch("tests/does-not-exist",
               runner: IntegrationRunner,
               felt_store: host
             )
  end

  # ── Resume path tests ──────────────────────────────────────────────────────

  # A clean handoff marker after the dispatch → the prior session closed cleanly →
  # the next dispatch starts FRESH (no --resume), even though a dispatch marker
  # with a session id is on file. This is the autonomous loop's fresh half.
  test "clean handoff → dispatcher takes fresh path despite a stored session",
       %{host: host} do
    write_fiber(host, "tests/cli-resume-no-event", """
    ---
    name: CLI resume no event
    status: active
    tags:
      - constitution
    shuttle:
      enabled: true
      kind: oneshot
      agent: claude-sonnet
    ---
    A fiber whose prior session closed cleanly.
    """)

    # Dispatch marker (the session id), then a handoff marker after it → clean
    # close → the dispatcher takes the fresh path.
    write_dispatch_marker(
      host,
      "tests/cli-resume-no-event",
      "test-session-uuid-abcd",
      DateTime.add(DateTime.utc_now(), -60, :second)
    )

    write_handoff_marker(host, "tests/cli-resume-no-event")

    assert {:ok, _} =
             Dispatcher.dispatch("tests/cli-resume-no-event",
               runner: IntegrationRunner,
               felt_store: host
             )

    script = read_run_script()
    # Takes fresh path: no --resume flag, no dismiss block.
    refute script =~ "--resume"
    refute script =~ "send-keys"
  end

  # The autonomous resume half: a dispatch marker with NO handoff after it (the
  # worker died mid-thought) → the dispatcher resumes the marker's session.
  test "dirty death (no handoff marker) → --resume in run-script", %{host: host} do
    write_fiber(host, "tests/cli-resume-fixed", """
    ---
    name: CLI resume fixed
    status: active
    tags:
      - constitution
    shuttle:
      kind: oneshot
      agent: claude-sonnet
    ---
    A fiber whose worker died without a clean handoff.
    """)

    # The prior session id lives ONLY in the dispatch marker (the daemon wrote it
    # at spawn; the worker never knew its own UUID). No handoff after it → resume.
    write_dispatch_marker(host, "tests/cli-resume-fixed", "cli-resume-session-uuid")

    assert {:ok, _} =
             Dispatcher.dispatch("tests/cli-resume-fixed",
               runner: IntegrationRunner,
               felt_store: host
             )

    script = read_run_script()
    assert script =~ "--resume 'cli-resume-session-uuid'"
    # Claude's dismiss-warning block is present on resume.
    assert script =~ "send-keys"
    assert script =~ "sleep 2"
  end

  # Kanban resume: resume_mode=previous (a dispatch parameter, STORE 3) triggers
  # claude --resume against the dispatch marker's session.
  test "kanban resume: resume_mode=previous param triggers --resume", %{host: host} do
    write_fiber(host, "tests/kanban-resume", """
    ---
    name: Kanban resume fiber
    status: active
    tags:
      - constitution
    shuttle:
      kind: oneshot
      agent: claude-sonnet
    ---
    A fiber that the kanban resumes.
    """)

    # The prior session id lives in the dispatch marker.
    write_dispatch_marker(host, "tests/kanban-resume", "kanban-session-uuid-5678")

    # Kanban passes resume_mode: "previous" on the dispatch call (no felt event).
    assert {:ok, _} =
             Dispatcher.dispatch("tests/kanban-resume",
               runner: IntegrationRunner,
               felt_store: host,
               resume_mode: "previous"
             )

    script = read_run_script()
    assert script =~ "--resume 'kanban-session-uuid-5678'"
    # Claude's resume warning dismiss block is present.
    assert script =~ "send-keys"
    assert script =~ "sleep 2"
    # The resume prompt is present (the script also carries a `|| <fresh>`
    # fallback whose full dispatch prompt is exercised in the deadlock test below).
    assert script =~ "Shuttle resumed your previous session"
    assert script =~ "Fiber: tests/kanban-resume"

    # F2: resuming is a dispatch boundary too — a fresh `dispatched_at` must be
    # stamped synchronously (same session id, since resuming doesn't change
    # session identity), or the continuation heuristic would compare a
    # subsequent clean-exit/died-mid-window against the PRIOR run's stamp.
    assert Enum.any?(IntegrationRunner.commands(), fn {cmd, args} ->
             cmd == "felt" and match?(["shuttle", "mark-runtime" | _], args) and
               "--dispatched-at" in args and "--session" in args and
               "kanban-session-uuid-5678" in args
           end),
           "expected a fresh dispatched_at stamp carrying the resumed session id"
  end

  # Regression for the launch deadlock (the CNRS own-words fiber): a resume whose
  # target session is GONE must not flap. The run script tries `--resume <id>`
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
      agent: codex
    ---
    A codex fiber resumed from its dispatch marker.
    """)

    write_dispatch_marker(
      host,
      "tests/kanban-history-resume",
      "40740310-2345-4e33-a1e4-7950db41ce10"
    )

    assert {:ok, _} =
             Dispatcher.dispatch("tests/kanban-history-resume",
               runner: IntegrationRunner,
               felt_store: host,
               resume_mode: "previous"
             )

    script = read_run_script()
    assert script =~ "codex"
    assert script =~ "resume '40740310-2345-4e33-a1e4-7950db41ce10'"
    assert script =~ "Shuttle resumed your previous session"
  end

  test "poller continuation resumes the dispatch marker's session on a dirty death", %{
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
    write_dispatch_marker(host, "tests/poller-history-resume", "history-resume-session-uuid")

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
    assert script =~ "--resume 'history-resume-session-uuid'"
    assert script =~ "Shuttle resumed your previous session"
  end

  test "resume previous dispatch reaches each harness-specific resume command", %{host: host} do
    matrix = [
      {"claude-sonnet", "claude-session-111", ["claude", "--resume 'claude-session-111'", "<<<"],
       ["codex resume", "pi "]},
      {"codex", "codex-session-222",
       ["codex", "resume 'codex-session-222'", "Shuttle resumed your previous session"],
       ["--resume", "--session"]},
      {"pi-kimi", "pi-session-333", ["pi", "--session 'pi-session-333'"],
       ["--resume", "Shuttle resumed your previous session"]}
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
      {"codex", "codex-history-session", "resume 'codex-history-session'"},
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

  test "codex session capture ignores newer non-worker session in same cwd", %{host: host} do
    session_dir = Path.join(host, "codex-sessions")
    File.mkdir_p!(session_dir)

    previous_dir = System.get_env("SHUTTLE_CODEX_SESSIONS_DIR")
    System.put_env("SHUTTLE_CODEX_SESSIONS_DIR", session_dir)

    on_exit(fn ->
      if previous_dir do
        System.put_env("SHUTTLE_CODEX_SESSIONS_DIR", previous_dir)
      else
        System.delete_env("SHUTTLE_CODEX_SESSIONS_DIR")
      end
    end)

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
      agent: codex
    ---
    A codex fiber whose session UUID should be captured from its own transcript.
    """)

    assert {:ok, "codex-capture-shuttle"} =
             Dispatcher.dispatch("tests/codex-capture",
               runner: IntegrationRunner,
               felt_store: host,
               work_dir: work_dir
             )

    # F2: dispatched_at is the dispatch-boundary ground truth and must exist
    # the moment the tmux session launches — codex/pi doesn't know its session
    # UUID yet at that instant, but the marker is stamped SYNCHRONOUSLY before
    # `dispatch/1` returns regardless, carrying `--dispatched-at` with no
    # `--session` (there is nothing to backfill into yet).
    assert Enum.any?(IntegrationRunner.commands(), fn {cmd, args} ->
             cmd == "felt" and match?(["shuttle", "mark-runtime" | _], args) and
               "--dispatched-at" in args and "--session" not in args
           end),
           "expected dispatched_at to be stamped synchronously before dispatch returned"

    # The captured worker session id is BACKFILLED into that already-stamped
    # marker via `felt shuttle mark-runtime --session` (felt owns the nesting —
    # Stage 5) so resume can recover it; the wrong (human) session is ignored.
    # The daemon's contract is the verb it shells — felt's own suite + the
    # lockstep round-trip cover that mark-runtime nests under shuttle.runtime.
    assert eventually(fn ->
             Enum.any?(IntegrationRunner.commands(), fn {cmd, args} ->
               cmd == "felt" and match?(["shuttle", "mark-runtime" | _], args) and
                 "--session" in args and "right-worker-session" in args and
                 "--dispatched-at" not in args
             end)
           end)
  end

  # Interactivity is retired as a dispatch mode: the prompt never renders an
  # "Interactive Mode" block, and a legacy `interactive: true` still sitting in a
  # fiber is inert — the worker reads the always-autonomous exit contract and
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
    assert script =~ "Exit Contract"
    assert script =~ "autonomous Shuttle worker"
  end

  # A "talk to me first" directive rides the From User block (the channel the
  # kanban "wait for me" affordance prepends to) — the worker reads it at the top
  # of context and waits, no dispatch-mode flag involved.
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

  # Standing dead-orphan reconciler on the tmux-scan substrate. A standing worker
  # that exits while the daemon is DOWN never fires handle_worker_exit, so the
  # armed document would re-fire. On poll, the daemon scans tmux: an armed
  # standing role with no live session whose dispatch marker has NO handoff (and
  # no re-arm) after it (the daemon-down-across-exit case) is marked awaiting
  # (status:closed). The marker discriminator replaces the felt-history one. A
  # role whose last run already handed off (the daily-practice "armed,
  # not-yet-due" shape) is left armed, proven by the sibling.
  test "a standing role with an un-exited dispatch is marked awaiting; one whose run handed off is left armed",
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
        expr: "0 8 * * *"
        tz: Europe/Paris
    ---
    A standing role whose worker died while the daemon was down.
    """)

    write_dispatch_marker(host, "tests/standing-dead", "dead-session-uuid")

    # The control — armed, whose last run already handed off cleanly (a handoff
    # marker after its dispatch). Must be left untouched: the run completed, this
    # is the next cycle's armed-and-waiting shape.
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
        expr: "0 8 * * *"
        tz: Europe/Paris
    ---
    A standing role whose previous run completed; armed for the next tick.
    """)

    write_dispatch_marker(
      host,
      "tests/standing-armed",
      "completed-session-uuid",
      DateTime.add(DateTime.utc_now(), -60, :second)
    )

    write_handoff_marker(host, "tests/standing-armed")

    # mark_awaiting resolves the fiber through FeltStores (FELT_STORES), not the
    # injected runner — point it at the temp store for the duration.
    prev_loom = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", host)

    try do
      {:ok, _poller} =
        start_poller!(
          name: :test_poller_standing_dead_orphan,
          runner: IntegrationRunner,
          poll_interval_ms: 600_000,
          felt_stores: [host]
        )

      # The dead role flips to awaiting (status:closed, untempered, closed-at).
      assert eventually(fn ->
               fm = read_frontmatter(host, "tests/standing-dead")
               fm["status"] == "closed"
             end),
             "expected the dead standing role to be marked awaiting (status:closed)"

      dead_fm = read_frontmatter(host, "tests/standing-dead")
      refute Map.has_key?(dead_fm, "tempered")
      assert is_binary(dead_fm["closed-at"])

      # The control role, whose last run exited, stays armed — the reconciler does
      # not regress a role whose run already completed.
      assert read_frontmatter(host, "tests/standing-armed")["status"] == "active"
    after
      if prev_loom,
        do: System.put_env("FELT_STORES", prev_loom),
        else: System.delete_env("FELT_STORES")
    end
  end

  # A standing role whose worker died without a clean handoff but which a human
  # then ACCEPTED must be left armed — the human's accept stamps a handoff marker
  # (the accept concludes the run) newer than the dispatch, which supersedes the
  # dead-orphan inference. Regression for the real morning-post / weekly-arxiv
  # oscillation: interactive/ad-hoc runs the daemon didn't observe exiting left a
  # dispatch marker with no handoff, so the dead-orphan reconciler re-closed the
  # role to awaiting on every restart/reconcile, undoing each accept. The handoff
  # marker is durable across a restart (the in-memory rearmed_at map is not).
  #
  # The CONTROL role (dispatch, no handoff, NO accept) flips to awaiting in the
  # same poll — proving the reconciler actually ran this cycle, so the accepted
  # role staying active is the fix at work, not a reconcile that never fired.
  test "an accepted standing role is left armed despite a dirty death",
       %{host: host} do
    for {slug, accept?} <- [
          {"standing-accepted-freeform", true},
          {"standing-dead-freeform", false}
        ] do
      write_fiber(host, "tests/#{slug}", """
      ---
      name: #{slug}
      status: active
      tags:
        - constitution
        - standing
      shuttle:
        kind: standing
        agent: claude-sonnet
        host: test-host
        schedule:
          expr: "0 8 * * *"
          tz: Europe/Paris
      ---
      A standing role whose worker died without a clean handoff.
      """)

      # Dispatch with NO handoff after it (dirty death).
      write_dispatch_marker(
        host,
        "tests/#{slug}",
        "#{slug}-uuid",
        DateTime.add(DateTime.utc_now(), -60, :second)
      )

      # Only the fix-target role gets the human accept (which stamps a handoff
      # marker, newer than the dispatch) after the death.
      if accept?, do: write_handoff_marker(host, "tests/#{slug}")
    end

    prev_loom = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", host)

    try do
      {:ok, _poller} =
        start_poller!(
          name: :test_poller_accepted_freeform,
          runner: IntegrationRunner,
          poll_interval_ms: 600_000,
          felt_stores: [host]
        )

      # CONTROL: a dispatched-and-exited-but-never-accepted role flips to awaiting
      # — this proves the dead-orphan reconciler ran on this candidate set.
      assert eventually(fn ->
               read_frontmatter(host, "tests/standing-dead-freeform")["status"] == "closed"
             end),
             "expected the un-accepted control role to be marked awaiting (proves reconcile ran)"

      # FIX: the accepted role — same free-form exit, plus a human accept — stays
      # armed. The accept supersedes the dead-orphan inference.
      fm = read_frontmatter(host, "tests/standing-accepted-freeform")

      assert fm["status"] == "active",
             "an accepted role must stay armed, not be re-marked awaiting by the dead-orphan reconciler"

      refute Map.has_key?(fm, "closed-at")
    after
      if prev_loom,
        do: System.put_env("FELT_STORES", prev_loom),
        else: System.delete_env("FELT_STORES")
    end
  end

  # The board's "New session" / "Resume" / drag-to-inFlight buttons force-dispatch
  # (force+ad_hoc) an awaiting standing role. The forced path must re-arm the doc
  # to status:active AS it spawns — one snappy action, no waiting on the 15s poll,
  # no running-worker-on-an-awaiting-card incoherence. Regression for the kanban
  # "New session refused with awaiting_review" bug.
  test "forced ad-hoc dispatch re-arms an awaiting standing role to active", %{host: host} do
    write_fiber(host, "tests/standing-awaiting-rearm", """
    ---
    name: Standing awaiting, force-dispatched
    status: closed
    closed-at: "2026-05-24T10:00:00Z"
    tags:
      - constitution
      - standing
    shuttle:
      kind: standing
      agent: claude-sonnet
      host: test-host
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
    ---
    A standing role awaiting review; the human clicks New session.
    """)

    prev_loom = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", host)

    try do
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
                     &(get_in(&1, [:fiber, "id"]) == "tests/standing-awaiting-rearm")
                   )

                 _ ->
                   false
               end
             end),
             "expected the document cache to warm with the awaiting role"

      # The forced board action bypasses the awaiting gate and spawns.
      assert {:ok, _session} =
               Poller.dispatch_fiber(poller, "tests/standing-awaiting-rearm",
                 force: true,
                 ad_hoc: true
               )

      # …and the doc is re-armed: status:active, closed-at cleared, untempered.
      fm = read_frontmatter(host, "tests/standing-awaiting-rearm")
      assert fm["status"] == "active"
      refute Map.has_key?(fm, "closed-at")
      refute Map.has_key?(fm, "tempered")

      # SNAPPY-NOW: the kanban's post-dispatch refetch reads card status from the
      # cached document feed. The shared post-mutation refresh (which the dispatch
      # endpoint calls right after Poller.dispatch_fiber) must make it report
      # active WITHOUT another poll — otherwise the card sits in "Awaiting review"
      # until the next tick even though the worker is live. No send(:run_poll_cycle).
      assert :ok = Poller.refresh_document(poller, "tests/standing-awaiting-rearm")
      assert {:ok, body} = Poller.cached_fiber_documents(poller)

      entry =
        Enum.find(body.fibers, &(get_in(&1, [:fiber, "id"]) == "tests/standing-awaiting-rearm"))

      assert entry, "re-armed role should still be in the owned feed"
      assert entry.fiber["status"] == "active"
      refute Map.has_key?(entry.fiber, "closed-at")
      refute Map.has_key?(entry.fiber, "tempered")
    after
      if prev_loom,
        do: System.put_env("FELT_STORES", prev_loom),
        else: System.delete_env("FELT_STORES")
    end
  end

  # Accepting an awaiting standing role re-arms it (status:active) for its NEXT
  # tick — it must NOT re-fire the occurrence that just ran. Regression for the
  # standing-role "temper oscillation": before the fix, accept flipped
  # closed→active while the just-served cron tick was still inside the ~90s
  # backward due-window, so the next poll re-dispatched it and the card popped
  # straight back to awaiting review. An every-minute schedule (always a tick in
  # the window) is the sharpest probe; the poller's rearm-instant clamp keeps it
  # at rest. Also asserts the second half of the fix: accept preserves the prior
  # run's outcome (no longer blanks it).
  test "accept re-arms a standing role without re-firing the just-served tick", %{host: host} do
    write_fiber(host, "tests/standing-temper-rest", """
    ---
    name: Standing temper-and-rest
    status: closed
    closed-at: "2026-05-24T10:00:00Z"
    outcome: "prior run digest — kept across accept"
    tags:
      - constitution
      - standing
    shuttle:
      kind: standing
      agent: claude-sonnet
      host: test-host
      schedule:
        expr: "* * * * *"
        tz: Europe/Paris
    ---
    A standing role awaiting review; the human drags it to tempered (accept).
    """)

    prev_loom = System.get_env("FELT_STORES")
    System.put_env("FELT_STORES", host)

    try do
      {:ok, poller} =
        start_poller!(
          name: :test_poller_temper_rest,
          runner: IntegrationRunner,
          poll_interval_ms: 600_000,
          felt_stores: [host]
        )

      assert eventually(fn ->
               case Poller.cached_fiber_documents(poller) do
                 {:ok, body} ->
                   Enum.any?(
                     body.fibers,
                     &(get_in(&1, [:fiber, "id"]) == "tests/standing-temper-rest")
                   )

                 _ ->
                   false
               end
             end),
             "expected the document cache to warm with the awaiting role"

      # The kanban drag-to-tempered on a standing awaiting role resolves to accept.
      assert {:ok, _} =
               Poller.lifecycle_transition(poller, :accept, "tests/standing-temper-rest", [])

      # Re-armed AND the prior outcome survives (accept no longer blanks it).
      fm = read_frontmatter(host, "tests/standing-temper-rest")
      assert fm["status"] == "active"
      refute Map.has_key?(fm, "tempered")
      refute Map.has_key?(fm, "closed-at")
      assert fm["outcome"] == "prior run digest — kept across accept"

      # Now poll: the just-served tick must NOT re-fire. Clear recorded commands
      # so the assertion isolates this poll cycle's dispatch behavior.
      IntegrationRunner.reset(host)
      session = Dispatcher.session_name("tests/standing-temper-rest")
      send(poller, :run_poll_cycle)
      Process.sleep(150)

      refute Enum.any?(IntegrationRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and Enum.any?(args, &(&1 == session))
             end),
             "a freshly-accepted standing role must rest until its next tick, not re-fire the served one"

      # It stays armed-and-resting (active), not re-fired back to awaiting.
      assert read_frontmatter(host, "tests/standing-temper-rest")["status"] == "active"
    after
      if prev_loom,
        do: System.put_env("FELT_STORES", prev_loom),
        else: System.delete_env("FELT_STORES")
    end
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
                 Enum.any?(body.fibers, &(get_in(&1, [:fiber, "id"]) == "tests/refresh-seam"))

               _ ->
                 false
             end
           end),
           "expected the document cache to warm"

    # Warming the cache runs a poll that DISPATCHES this status:active fiber,
    # which shells `felt shuttle mark-runtime` SYNCHRONOUSLY (before dispatch
    # returns) to stamp the dispatch fields (felt owns the runtime nesting —
    # Stage 5; the sync stamp is F2 — `dispatched_at` must exist the moment
    # the tmux session launches). `eventually` here just waits out the poll
    # cycle itself, not the mark-runtime write, before mutating out of band so
    # the two writes are serialized rather than racing.
    assert eventually(fn ->
             Enum.any?(IntegrationRunner.commands(), fn {cmd, args} ->
               cmd == "felt" and match?(["shuttle", "mark-runtime" | _], args) and
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
    entry = Enum.find(body.fibers, &(get_in(&1, [:fiber, "id"]) == "tests/refresh-seam"))
    assert entry.fiber["outcome"] == "changed outcome"

    # Delete the fiber on disk; refresh evicts it from the feed (no poll).
    File.rm_rf!(Path.join([host, ".felt", "tests", "refresh-seam"]))
    assert :ok = Poller.refresh_document(poller, "tests/refresh-seam")
    assert {:ok, body} = Poller.cached_fiber_documents(poller)
    refute Enum.any?(body.fibers, &(get_in(&1, [:fiber, "id"]) == "tests/refresh-seam"))
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
    assert script =~ "scheduled run of this standing role"
    assert script =~ "one due occurrence"
    assert script =~ "Fiber: tests/standing-dispatch"
    assert script =~ "run-2026-05-07"
    # NOT the fresh-dispatch orientation paragraph.
    refute script =~ "The orchestration system Shuttle dispatched you on this fiber"
  end

  # ── User message block ─────────────────────────────────────────────────────

  # The user's directive rides the dispatch call as the `:user_message` parameter
  # (STORE 3) and surfaces as the "From User" block in the prompt, so the worker
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

  # ── Helpers ────────────────────────────────────────────────────────────────

  # Mirror of Go lifecycle_test.go's withTempHost: creates a temp directory
  # with a .felt/ subdirectory so `felt -C <host> show <id>` can find fibers.
  defp mk_tmp_felt_store do
    host =
      Path.join(System.tmp_dir!(), "shuttle-inttest-#{System.unique_integer([:positive])}")

    File.mkdir_p!(Path.join(host, ".felt"))
    host
  end

  # Mirror of Go lifecycle_test.go's writeFiber: writes a fiber markdown file
  # at host/.felt/<id segments>/<basename>.md so `felt show --json` can find it.
  defp write_fiber(host, id, content) do
    parts = String.split(id, "/")
    basename = List.last(parts)
    dir = Path.join([host, ".felt"] ++ parts)
    File.mkdir_p!(dir)
    File.write!(Path.join(dir, "#{basename}.md"), String.trim(content) <> "\n")
  end

  # Reads back a fiber's frontmatter from disk (host/.felt/<id>/<basename>.md),
  # the surface a daemon write like mark_awaiting lands on.
  defp read_frontmatter(host, id) do
    parts = String.split(id, "/")
    basename = List.last(parts)
    path = Path.join([host, ".felt"] ++ parts ++ ["#{basename}.md"])
    [_, fm, _] = File.read!(path) |> String.split("---", parts: 3)
    YamlElixir.read_from_string!(fm)
  end

  defp write_resume_fiber(host, id, opts) do
    agent = Keyword.fetch!(opts, :agent)
    session = Keyword.get(opts, :session)

    write_fiber(host, id, """
    ---
    name: Resume matrix #{agent}
    status: active
    tags:
      - constitution
    shuttle:
      kind: oneshot
      agent: #{agent}
    ---
    A fiber used by the resume matrix.
    """)

    # The session id lives in the per-host dispatch marker (the only structured
    # session-id home). Keyed by the fiber's runtime key (slug for these fibers).
    if session, do: write_dispatch_marker(host, id, session)
  end

  defp write_codex_session(session_dir, filename, uuid, cwd, timestamp, prompt) do
    session_meta =
      Jason.encode!(%{
        "timestamp" => timestamp,
        "type" => "session_meta",
        "payload" => %{
          "id" => uuid,
          "timestamp" => timestamp,
          "cwd" => cwd
        }
      })

    user_turn =
      Jason.encode!(%{
        "timestamp" => timestamp,
        "type" => "response_item",
        "payload" => %{
          "type" => "message",
          "role" => "user",
          "content" => [%{"type" => "input_text", "text" => prompt}]
        }
      })

    File.write!(Path.join(session_dir, filename), session_meta <> "\n" <> user_turn <> "\n")
  end

  defp eventually(fun, attempts \\ 40)

  defp eventually(fun, attempts) when attempts > 0 do
    if fun.() do
      true
    else
      Process.sleep(50)
      eventually(fun, attempts - 1)
    end
  end

  defp eventually(_fun, 0), do: false

  # Finds the tmux new-session command recorded by IntegrationRunner and reads
  # the run-script tempfile that was passed to `bash -l`. The script contains
  # the agent command, banners, and (for resume) the dismiss block.
  defp read_run_script do
    {_, args} =
      IntegrationRunner.commands()
      |> Enum.find(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)

    File.read!(List.last(args))
  end
end
