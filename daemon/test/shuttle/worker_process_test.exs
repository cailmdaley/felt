defmodule Shuttle.WorkerProcessTest do
  use ExUnit.Case, async: true

  alias Shuttle.WorkerProcess

  defmodule PsRunner do
    def cmd("ps", _args, _opts), do: Process.get(:ps_result, {"", 0})
  end

  @uuid "11111111-2222-3333-4444-555555555555"

  @table """
    700     1 /opt/homebrew/bin/tmux new-session -d -s shuttle-anchor
    812   700 bash -l /var/folders/T/shuttle-run-leaf-01KTHDNZS287ZSSG8X8V59XKW2-shuttle.42.sh
    813   812 claude --effort high --resume #{@uuid}
    900   700 bash -l /var/folders/T/shuttle-run-resume-#{@uuid}.7.sh
    950     1 bash -l /var/folders/T/shuttle-run-9859.sh
    951   950 claude --session-id=aaaaaaaa-0000-0000-0000-000000000000
    960     1 /usr/bin/tmux new-session -d -s dead-01KTHDNZS287ZSSG8X8V59XKW1-shuttle bash -l /tmp/shuttle-run-dead-01KTHDNZS287ZSSG8X8V59XKW1-shuttle.3.sh
    970   700 pi --model x Previous session: bbbbbbbb-0000-0000-0000-000000000000 (claude)
  """

  defp procs, do: WorkerProcess.parse(@table)

  test "script_path names the session, and the process table reads it back" do
    path = WorkerProcess.script_path("leaf-01KTHDNZS287ZSSG8X8V59XKW2-shuttle")
    assert String.starts_with?(path, System.tmp_dir!())

    assert Path.basename(path) =~
             ~r/^shuttle-run-leaf-01KTHDNZS287ZSSG8X8V59XKW2-shuttle\.\d+\.sh$/

    [proc] = WorkerProcess.parse("  5  1 bash -l #{path}\n")

    assert WorkerProcess.session_process([proc], "leaf-01KTHDNZS287ZSSG8X8V59XKW2-shuttle") ==
             proc

    assert WorkerProcess.sessions([proc]) == ["leaf-01KTHDNZS287ZSSG8X8V59XKW2-shuttle"]
  end

  test "sessions lists only shuttle worker sessions with a live run script" do
    # resume-<uuid> is not a worker session; an unnamed script names none.
    assert WorkerProcess.sessions(procs()) == ["leaf-01KTHDNZS287ZSSG8X8V59XKW2-shuttle"]
  end

  test "a tmux server keeping its forking client's argv is not a live worker" do
    assert WorkerProcess.session_process(procs(), "dead-01KTHDNZS287ZSSG8X8V59XKW1-shuttle") ==
             nil

    refute "dead-01KTHDNZS287ZSSG8X8V59XKW1-shuttle" in WorkerProcess.sessions(procs())
  end

  test "holder matches the uuid as a whole argv token, or a --flag=<uuid> token" do
    assert %{pid: 813} = WorkerProcess.holder(procs(), @uuid)
    assert %{pid: 951} = WorkerProcess.holder(procs(), "aaaaaaaa-0000-0000-0000-000000000000")
    assert WorkerProcess.holder(procs(), "11111111-2222") == nil
    # A uuid named inside a prompt argument does not hold the transcript.
    assert WorkerProcess.holder(procs(), "bbbbbbbb-0000-0000-0000-000000000000") == nil
  end

  test "tmux_server climbs the ppid chain to the tmux process" do
    assert WorkerProcess.tmux_server(procs(), WorkerProcess.holder(procs(), @uuid)) == 700

    orphan = WorkerProcess.holder(procs(), "aaaaaaaa-0000-0000-0000-000000000000")
    assert WorkerProcess.tmux_server(procs(), orphan) == nil

    # Linux procps shows a tmux server by its process title.
    linux = WorkerProcess.parse("  70  1 tmux: server\n  81  70 -bash\n  82  81 claude x\n")
    assert WorkerProcess.tmux_server(linux, List.last(linux)) == 70
  end

  test "check_free: held, free, and an unanswered scan" do
    Process.put(:ps_result, {@table, 0})
    assert {:error, {:held, message}} = WorkerProcess.check_free(PsRunner, @uuid)
    assert message =~ "pid 813"
    assert message =~ "kill -USR1 700"

    assert WorkerProcess.check_free(PsRunner, "bbbbbbbb-0000-0000-0000-000000000000") == :ok

    Process.put(:ps_result, {"ps: boom", 1})
    assert {:error, {:unknown, message}} = WorkerProcess.check_free(PsRunner, @uuid)
    assert message =~ "could not check"
  end
end
