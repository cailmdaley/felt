defmodule Shuttle.DispatchIntegrationTest do
  # Dispatch through the real CLIs: launch, prompts and resuming a held session.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  # ── Tests ──────────────────────────────────────────────────────────────────

  @tag :tmp_dir
  @tag skip: is_nil(Shuttle.Rex.bin())
  @tag timeout: 60_000
  test "dispatch runs a stub agent in isolated Rex and stops without creating tmux sessions", %{
    host: host,
    tmp_dir: dir
  } do
    root = Shuttle.Test.IsolatedRex.start(dir)
    Shuttle.Test.Env.put_app_env(:terminal_backend, Shuttle.Terminal.Rex)
    socket = Path.join(root, "tmux.sock")
    Shuttle.Test.Env.put_app_env(:rex_test_tmux_socket, socket)
    wrapper = Path.join(root, "stub-agent")
    receipt = Path.join(root, "agent-started")

    File.write!(wrapper, """
    #!/bin/bash
    printf '%s\\n' "$REX_SESSION" "$REX_BLOCK" > '#{receipt}'
    exec sleep 30
    """)

    File.chmod!(wrapper, 0o755)
    registry = Path.join(root, "agents.json")

    File.write!(
      registry,
      Jason.encode!(%{
        "version" => 1,
        "builtins" => "restrict",
        "agents" => [%{"id" => "probe-agent", "cli" => "claude", "wrapper" => wrapper}]
      })
    )

    Shuttle.Test.Env.put_env("SHUTTLE_AGENTS_FILE", registry)

    write_fiber(host, "tests/rex-dispatch", """
    ---
    name: Isolated Rex dispatch
    status: active
    shuttle:
      kind: oneshot
      agent: probe-agent
    ---
    A stub worker on the isolated Rex server.
    """)

    before_tmux =
      RealRexRunner.cmd("tmux", ["ls", "-F", "\#{session_name}"], stderr_to_stdout: true)

    assert {:ok, name} =
             Dispatcher.dispatch("tests/rex-dispatch", runner: RealRexRunner, felt_store: host)

    assert name == FiberUid.session("tests/rex-dispatch")
    Shuttle.Test.IsolatedRex.await(fn -> File.exists?(receipt) end)
    assert ["session:" <> _, "block:" <> _] = String.split(File.read!(receipt), "\n", trim: true)
    assert {:ok, [%{"label" => "tests/rex-dispatch"}]} = Shuttle.Rex.sessions(RealRexRunner)

    assert {json, 0} =
             Shuttle.Runner.Default.cmd(
               Shuttle.Rex.bin(),
               Shuttle.Rex.flags() ++ ["ls", "--json"],
               stderr_to_stdout: true,
               input_eof: true
             )

    assert json =~ "tests/rex-dispatch"
    assert Shuttle.Terminal.status(RealRexRunner, name) == :alive

    assert {:ok, %{"session_id" => human}} =
             Shuttle.Rex.create(RealRexRunner, %{"label" => "probe-unowned"})

    for fiber <- ["tests/rex-dispatch/thread", "tests/rex-dispatch/thread/deep"] do
      write_fiber(
        host,
        fiber,
        "---\nname: Tree worker\nstatus: active\nshuttle:\n  kind: oneshot\n  agent: probe-agent\n---\nA tree thread.\n"
      )

      assert {:ok, _} = Dispatcher.dispatch(fiber, runner: RealRexRunner, felt_store: host)
    end

    assert {:ok, sessions} = Shuttle.Rex.sessions(RealRexRunner)

    assert [
             %{"session_id" => family, "label" => "tests/rex-dispatch"},
             %{"session_id" => ^human, "label" => "probe-unowned"}
           ] = sessions

    assert {:ok, windows} = Shuttle.Rex.windows(RealRexRunner, family)
    assert Enum.map(windows, & &1["label"]) == ["rex-dispatch", "└ thread", "\u2060\u2003└ deep"]

    assert {:ok, %{"bindings" => bindings}} = Shuttle.Terminal.RexBindings.read()

    for {worker, b} <- bindings do
      assert b["session_id"] == family
      assert {:ok, blocks} = Shuttle.Rex.blocks(RealRexRunner, b["session_id"])
      assert Enum.any?(blocks, &(&1["block_id"] == b["block_id"] and &1["label"] == worker))
    end

    assert {"", 0} = Shuttle.WorkerBackend.stop(RealRexRunner, name)
    assert Shuttle.Terminal.status(RealRexRunner, name) == :gone
    assert {:ok, sessions} = Shuttle.Rex.sessions(RealRexRunner)
    assert Enum.map(sessions, & &1["label"]) == ["tests/rex-dispatch", "probe-unowned"]
    assert {:ok, windows} = Shuttle.Rex.windows(RealRexRunner, family)
    assert Enum.map(windows, & &1["label"]) == ["└ thread", "\u2060\u2003└ deep"]

    for fiber <- ["tests/rex-dispatch/thread", "tests/rex-dispatch/thread/deep"] do
      assert {"", 0} = Shuttle.WorkerBackend.stop(RealRexRunner, FiberUid.session(fiber))
    end

    assert {:ok, [%{"session_id" => ^human, "label" => "probe-unowned"}]} =
             Shuttle.Rex.sessions(RealRexRunner)

    assert {:ok, _} = Shuttle.Rex.destroy(RealRexRunner, human)
    assert {:ok, []} = Shuttle.Rex.sessions(RealRexRunner)

    assert RealRexRunner.cmd("tmux", ["ls", "-F", "\#{session_name}"], stderr_to_stdout: true) ==
             before_tmux
  end

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

    assert {:ok, FiberUid.session("tests/fresh-oneshot")} ==
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
    assert script =~ "Felt store: #{host}"
    refute script =~ "read its current body and Status"

    # Fresh dispatch: no resume flag, no dismiss block.
    refute script =~ "--resume"
    refute script =~ "send-keys"

    # …and the pairing is recorded structurally, not left to be inferred from
    # the tmux name later. Claude's UUID is pre-specified at launch, so the
    # `dispatch` line lands synchronously here.
    assert [ledger] = read_ledger()
    assert ledger["fiber"] == "tests/fresh-oneshot"
    assert ledger["kind"] == "dispatch"
    assert ledger["harness"] == "claude-code"
    assert ledger["tmux"] == FiberUid.session("tests/fresh-oneshot")
    assert ledger["host"] == Shuttle.Poller.own_host_id()
    assert is_integer(ledger["at"])
    # The session UUID the dispatch generated, echoed into the run script.
    assert is_binary(ledger["session"]) and ledger["session"] != ""
    assert script =~ ledger["session"]
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
    IntegrationRunner.add_tmux_session(FiberUid.session("tests/running-fiber"))

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
    session = "c1a0e5e0-0000-4000-8000-000000000001"
    write_dispatch_marker(host, "tests/cli-resume-fixed", session, ago(120))
    write_transcript(session, 60)

    assert {:ok, _} =
             Dispatcher.dispatch("tests/cli-resume-fixed",
               runner: IntegrationRunner,
               felt_store: host
             )

    script = read_run_script()
    assert script =~ "--resume '#{session}'"
    # Claude's dismiss-warning block is present on resume.
    assert script =~ "send-keys"
    assert script =~ "sleep 2"
  end

  # An old transcript still resumes when it belongs to the dispatch.
  test "dirty death with an old transcript → resume",
       %{host: host} do
    write_fiber(host, "tests/cli-cold", """
    ---
    name: CLI cold
    status: active
    tags:
      - constitution
    shuttle:
      kind: oneshot
      agent: claude-sonnet
    ---
    A fiber whose worker died hours ago without a clean handoff.
    """)

    session = "c1a0e5e0-0000-4000-8000-000000000002"
    write_dispatch_marker(host, "tests/cli-cold", session, ago(4 * 3600))
    write_transcript(session, 3 * 3600)

    assert {:ok, _} =
             Dispatcher.dispatch("tests/cli-cold", runner: IntegrationRunner, felt_store: host)

    script = read_run_script()
    assert script =~ "--resume '#{session}'"
  end

  test "dirty death with no transcript on this host → fresh launch saying so", %{host: host} do
    write_fiber(host, "tests/cli-elsewhere", """
    ---
    name: CLI elsewhere
    status: active
    tags:
      - constitution
    shuttle:
      kind: oneshot
      agent: claude-sonnet
    ---
    A fiber whose worker's transcript is not on this host.
    """)

    session = "c1a0e5e0-0000-4000-8000-000000000004"
    write_dispatch_marker(host, "tests/cli-elsewhere", session)
    # An empty projects root: no harness here wrote this session.
    write_transcript("c1a0e5e0-0000-4000-8000-00000000ffff")

    assert {:ok, _} =
             Dispatcher.dispatch("tests/cli-elsewhere",
               runner: IntegrationRunner,
               felt_store: host
             )

    script = read_run_script()
    refute script =~ "--resume"

    assert script =~
             "Previous session: #{session} ended without a handoff (host outage, kill, or crash); " <>
               "its transcript is not on this host."
  end

  # Kanban resume: resume_mode=previous (a dispatch parameter) triggers
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

    # A resume is its own pairing moment: the same session, attached again, on a
    # new run. It is recorded as `resume` so a reader can tell a relaunch from a
    # first launch rather than seeing one dispatch and inferring the rest.
    assert [ledger] = read_ledger()
    assert ledger["kind"] == "resume"
    assert ledger["fiber"] == "tests/kanban-resume"
    assert ledger["session"] == "kanban-session-uuid-5678"
    assert ledger["harness"] == "claude-code"
    assert ledger["tmux"] == FiberUid.session("tests/kanban-resume")

    # Claude's resume warning dismiss block is present.
    assert script =~ "send-keys"
    assert script =~ "sleep 2"
    # The resume prompt is present (the script also carries a `|| <fresh>`
    # fallback whose full dispatch prompt is exercised in the deadlock test below).
    assert script =~ "Mode: resume"
    assert script =~ "Fiber: tests/kanban-resume"
    assert script =~ "Felt store: #{host}"
    refute script =~ "read its current body and Status"

    # F2: resuming is a dispatch boundary too — a fresh `dispatched_at` must be
    # stamped synchronously (same session id, since resuming doesn't change
    # session identity), or the continuation heuristic would compare a
    # subsequent clean-exit/died-mid-window against the PRIOR run's stamp.
    assert Enum.any?(IntegrationRunner.commands(), fn {cmd, args} ->
             cmd == "shuttle" and match?(["-C", _store, "mark-runtime" | _], args) and
               "--dispatched-at" in args and "--session" in args and
               "kanban-session-uuid-5678" in args
           end),
           "expected a fresh dispatched_at stamp carrying the resumed session id"
  end

  test "a resume is refused while a human resume of the same session is open", %{host: host} do
    write_fiber(host, "tests/human-open", """
    ---
    name: Human has it open
    status: active
    tags:
      - constitution
    shuttle:
      kind: oneshot
      agent: claude-sonnet
    ---
    A fiber whose previous session a person resumed from the card's History.
    """)

    write_dispatch_marker(host, "tests/human-open", "human-session-uuid-0001")
    IntegrationRunner.add_tmux_session(Shuttle.SessionResume.tmux_name("human-session-uuid-0001"))

    assert {:error, {:session_open_in_resume, message}} =
             Dispatcher.dispatch("tests/human-open",
               runner: IntegrationRunner,
               felt_store: host,
               resume_mode: "previous"
             )

    assert message =~ "resume-human-session-uuid-0001"
    # No second harness process on that transcript, and nothing recorded.
    refute Enum.any?(IntegrationRunner.commands(), &match?({"tmux", ["new-session" | _]}, &1))
    assert read_ledger() == []

    # A fresh dispatch is a different session, and is not held back.
    assert {:ok, _} =
             Dispatcher.dispatch("tests/human-open",
               runner: IntegrationRunner,
               felt_store: host,
               resume_mode: "fresh"
             )
  end

  describe "a resume onto a session a live process holds" do
    setup %{host: host} do
      write_fiber(host, "tests/held", """
      ---
      name: Held by an orphaned worker
      status: active
      tags:
        - constitution
      shuttle:
        kind: oneshot
        agent: claude-sonnet
      ---
      A fiber whose worker kept running after its tmux socket was deleted.
      """)

      write_dispatch_marker(host, "tests/held", "held-session-uuid-0002")
      :ok
    end

    defp resume_held(host),
      do:
        Dispatcher.dispatch("tests/held",
          runner: IntegrationRunner,
          felt_store: host,
          resume_mode: "previous"
        )

    defp spawned?,
      do: Enum.any?(IntegrationRunner.commands(), &match?({"tmux", ["new-session" | _]}, &1))

    test "is refused with the holding pid and the tmux server to signal", %{host: host} do
      IntegrationRunner.set_ps_results([
        {"""
           4430     1 /opt/homebrew/bin/tmux new-session -d -s shuttle-anchor
           8698  4430 bash -l /var/folders/T/shuttle-run-9859.sh
           8699  8698 claude --effort high --resume held-session-uuid-0002
         """, 0}
      ])

      assert {:error, {:transcript_held, message}} = resume_held(host)
      assert message =~ "pid 8699"
      assert message =~ "kill -USR1 4430"
      refute spawned?()
      assert read_ledger() == []
    end

    test "is refused when the scan cannot run", %{host: host} do
      # First scan: the already-running check (tmux: "can't find session")
      # finds no run script. Second: the transcript check cannot run.
      IntegrationRunner.set_ps_results([{"", 0}, {"ps: boom", 1}])

      assert {:error, {:transcript_held, message}} = resume_held(host)
      assert message =~ "could not check"
      refute spawned?()
    end

    test "proceeds when no process holds it", %{host: host} do
      assert {:ok, _} = resume_held(host)
      assert spawned?()
    end
  end
end
