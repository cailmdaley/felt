defmodule Shuttle.DispatchIntegrationSessionResumeTest do
  # A human resuming one of a card's past sessions (`Shuttle.SessionResume`)
  # through the Poller's real forced dispatch and the real CLIs: the resumed
  # session is the card's worker, and the card keeps its lifecycle before,
  # during and after it.
  use Shuttle.Test.DispatchIntegrationCase, async: true

  # The wrapper probe fails, so the dispatcher refuses the launch at preflight.
  defmodule NoWrapperRunner do
    @behaviour Shuttle.Runner
    alias Shuttle.Test.DispatchIntegrationCase.IntegrationRunner

    def cmd("bash", ["-lc", "type -t -- " <> _] = args, _opts) do
      IntegrationRunner.cmd("bash", args, [])
      {"", 1}
    end

    def cmd(command, args, opts), do: IntegrationRunner.cmd(command, args, opts)
  end

  # Lists the live tmux sessions, so a restarted Poller finds the worker.
  defmodule ListingRunner do
    @behaviour Shuttle.Runner
    alias Shuttle.Test.DispatchIntegrationCase.IntegrationRunner

    def cmd("tmux", ["ls" | _], _opts),
      do: {Enum.join(IntegrationRunner.tmux_sessions(), "\n"), 0}

    def cmd(command, args, opts), do: IntegrationRunner.cmd(command, args, opts)
  end

  # Refuses the launch's runtime marker, so the card keeps its pre-close
  # `dispatched_at` while the resumed worker runs; lists live sessions for a
  # restarted Poller.
  defmodule NoMarkerRunner do
    @behaviour Shuttle.Runner

    def cmd("shuttle", args, opts) do
      if "mark-runtime" in args and "--dispatched-at" in args,
        do: {"refused", 1},
        else: ListingRunner.cmd("shuttle", args, opts)
    end

    def cmd(command, args, opts), do: ListingRunner.cmd(command, args, opts)
  end

  @picked "c1a0e5e0-0000-4000-8000-0000000000a1"
  @closed_at "2026-01-05T10:00:00+01:00"

  defp schedule_now do
    now = DateTime.utc_now()
    "expr: \"#{now.minute} #{now.hour} * * *\"\n    tz: UTC"
  end

  defp standing(host, id, status_lines) do
    write_fiber(host, id, """
    ---
    name: Resumed standing
    #{status_lines}
    tags:
      - constitution
    shuttle:
      kind: standing
      agent: claude-sonnet
      host: test-host
      project_dir: "#{host}"
      schedule:
        #{schedule_now()}
    ---
    A standing card whose old run the human picks up again.
    """)
  end

  defp oneshot(host, id) do
    write_fiber(host, id, """
    ---
    name: Resumed oneshot
    status: closed
    closed-at: #{@closed_at}
    tags:
      - constitution
    shuttle:
      kind: oneshot
      agent: claude-sonnet
      host: test-host
      project_dir: "#{host}"
    ---
    A closed oneshot whose conversation the human picks up again.
    """)
  end

  defp lifecycle(host, id),
    do: Map.take(read_frontmatter(host, id), ["status", "horizon", "tempered", "closed-at"])

  defp start!(host) do
    Shuttle.Test.Env.put_env("SHUTTLE_STORES", host)
    write_transcript(@picked)

    {:ok, poller} =
      start_poller!(runner: IntegrationRunner, poll_interval_ms: 600_000, felt_stores: [host])

    poller
  end

  defp resume(poller, id, work_dir) do
    Poller.dispatch_fiber(poller, id,
      force: true,
      ad_hoc: true,
      resume_mode: "previous",
      resume_session: @picked,
      work_dir: work_dir
    )
  end

  defp reopens,
    do: for({"shuttle", args} <- IntegrationRunner.commands(), "reopen" in args, do: args)

  defp launches,
    do:
      Enum.count(IntegrationRunner.commands(), fn {cmd, args} ->
        cmd == "tmux" and "new-session" in args
      end)

  # Resume, hold the worker through a poll, end it, and poll again: the card's
  # lifecycle never moves and nothing launches after the human leaves.
  defp check_resume_keeps_lifecycle(host, id) do
    poller = start!(host)
    before = lifecycle(host, id)

    assert {:ok, tmux} = resume(poller, id, host)
    assert read_run_script() =~ "--resume '#{@picked}'"
    assert reopens() == []
    assert lifecycle(host, id) == before
    assert get_in(read_frontmatter(host, id), ["shuttle", "runtime", "session_uuid"]) == @picked

    # The worker survives a poll: a closed card's closure does not end it.
    sync_poll_cycle!(poller)
    assert %{session_uuid: @picked, session: ^tmux} = Poller.live_worker(poller, id)
    refute Enum.any?(IntegrationRunner.commands(), &match?({"tmux", ["kill-session" | _]}, &1))

    state = :sys.get_state(poller)
    %{pid: watcher, session: session} = state.running[Poller.running_key(state, id)]
    IntegrationRunner.remove_tmux_session(session)
    send(poller, {:worker_exited, id, watcher, session, :normal_exit})
    :sys.get_state(poller)
    for _ <- 1..3, do: sync_poll_cycle!(poller)

    assert Poller.live_worker(poller, id) == nil
    assert lifecycle(host, id) == before
    assert reopens() == []
    assert launches() == 1
  end

  test "a retired standing card's session resumes without its schedule coming back", %{
    host: host
  } do
    id = "tests/retired-standing"
    standing(host, id, "status: closed\nclosed-at: #{@closed_at}\ntempered: true")
    check_resume_keeps_lifecycle(host, id)
  end

  test "a paused standing card's session resumes without its schedule coming back", %{
    host: host
  } do
    id = "tests/paused-standing"
    standing(host, id, "status: open\nhorizon: stashed")
    check_resume_keeps_lifecycle(host, id)
  end

  test "a closed oneshot's session resumes without arming the card", %{host: host} do
    id = "tests/closed-oneshot"
    oneshot(host, id)
    check_resume_keeps_lifecycle(host, id)
  end

  test "a resumed worker on a closed card is in flight and outlives a daemon restart", %{
    host: host
  } do
    id = "tests/closed-oneshot-board"
    oneshot(host, id)
    poller = start!(host)

    assert {:ok, tmux} = resume(poller, id, host)
    {:ok, fiber} = Poller.fetch_fiber_full(id, :sys.get_state(poller))
    assert Shuttle.Lifecycle.launched_after_close?(fiber)
    assert Shuttle.Lifecycle.column(fiber, true) == "in_flight"
    assert Shuttle.Lifecycle.column(fiber, false) == "awaiting_review"

    GenServer.stop(poller)

    {:ok, restarted} =
      start_poller!(runner: ListingRunner, poll_interval_ms: 600_000, felt_stores: [host])

    sync_poll_cycle!(restarted)
    assert %{session: ^tmux, session_uuid: @picked} = Poller.live_worker(restarted, id)
    refute Enum.any?(IntegrationRunner.commands(), &match?({"tmux", ["kill-session" | _]}, &1))
    assert read_frontmatter(host, id)["status"] == "closed"
  end

  test "a resume refused before launch leaves the card as it was", %{host: host} do
    id = "tests/refused-oneshot"
    oneshot(host, id)
    poller = start!(host)
    before = File.read!(fiber_file(host, id))

    assert {:error, {:arm_refused, %{message: message}}} =
             resume(poller, id, Path.join(host, "gone"))

    assert message =~ "is not a directory"
    assert File.read!(fiber_file(host, id)) == before
    assert reopens() == []
    assert launches() == 0
  end

  test "a resume the dispatcher refuses at preflight leaves the card as it was", %{host: host} do
    id = "tests/refused-standing"
    standing(host, id, "status: open\nhorizon: stashed")
    Shuttle.Test.Env.put_env("SHUTTLE_STORES", host)
    write_transcript(@picked)

    {:ok, poller} =
      start_poller!(runner: NoWrapperRunner, poll_interval_ms: 600_000, felt_stores: [host])

    before = File.read!(fiber_file(host, id))

    assert {:error, {:wrapper_unresolved, _}} = resume(poller, id, host)
    assert File.read!(fiber_file(host, id)) == before
    assert reopens() == []
    assert launches() == 0
  end

  test "a resumed worker whose launch marker failed outlives its card's closure", %{host: host} do
    id = "tests/unmarked-oneshot"
    oneshot(host, id)

    {:ok, _} =
      Shuttle.CLI.run_lifecycle("mark-runtime", id, ["--dispatched-at", "2026-01-05T08:00:00Z"],
        runner: IntegrationRunner,
        felt_store: host
      )

    Shuttle.Test.Env.put_env("SHUTTLE_STORES", host)
    write_transcript(@picked)

    {:ok, poller} =
      start_poller!(runner: NoMarkerRunner, poll_interval_ms: 600_000, felt_stores: [host])

    assert {:ok, tmux} = resume(poller, id, host)

    assert get_in(read_frontmatter(host, id), ["shuttle", "runtime", "dispatched_at"]) ==
             "2026-01-05T08:00:00Z"

    sync_poll_cycle!(poller)
    assert %{session: ^tmux} = Poller.live_worker(poller, id)

    # A restarted Poller judges it by its own launch record, not the lagging
    # document stamp.
    GenServer.stop(poller)

    {:ok, restarted} =
      start_poller!(runner: NoMarkerRunner, poll_interval_ms: 600_000, felt_stores: [host])

    sync_poll_cycle!(restarted)
    assert %{session: ^tmux} = Poller.live_worker(restarted, id)
    refute Enum.any?(IntegrationRunner.commands(), &match?({"tmux", ["kill-session" | _]}, &1))
  end
end
