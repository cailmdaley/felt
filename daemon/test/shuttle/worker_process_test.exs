defmodule Shuttle.WorkerProcessTest do
  use ExUnit.Case, async: true

  alias Shuttle.WorkerProcess

  defmodule PsRunner do
    def cmd("ps", _args, _opts), do: Process.get(:ps_result, {"", 0})

    def cmd("shuttle", ["process-identity", pid], _opts) do
      send(self(), {:identity_probe, pid})
      Process.get(:identity_result, {~s({"status":"unknown"}), 0})
    end
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

  @tag :tmp_dir
  test "fresh embedded argv is held by its local worker binding, not a predecessor or remote binding",
       %{tmp_dir: root} do
    alias Shuttle.Test.Env
    ledger = Path.join(root, "sessions.jsonl")
    Env.put_env("SHUTTLE_SESSIONS_FILE", ledger)
    tmux = "leaf-01KTHDNZS287ZSSG8X8V59XKW2-shuttle"

    table =
      WorkerProcess.parse(
        "812 700 bash -l /tmp/shuttle-run-#{tmux}.42.sh\n813 812 codex -m gpt-sol\n"
      )

    row = %{"session" => @uuid, "tmux" => tmux, "host" => Shuttle.Poller.own_host_id(), "at" => 1}
    File.write!(ledger, Jason.encode!(row) <> "\n")
    assert %{pid: 812} = WorkerProcess.holder(table, @uuid)
    File.write!(ledger, Jason.encode!(Map.put(row, "host", "other-host")) <> "\n")
    assert nil == WorkerProcess.holder(table, @uuid)

    File.write!(
      ledger,
      Jason.encode!(row) <>
        "\n" <> Jason.encode!(%{row | "session" => "another-session", "at" => 2}) <> "\n"
    )

    assert nil == WorkerProcess.holder(table, @uuid)
  end

  defp receiver(root, pid, start, extra \\ %{}) do
    Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", root)
    Shuttle.Test.Env.put_env("SHUTTLE_SESSIONS_FILE", Path.join(root, "sessions.jsonl"))
    key = :crypto.hash(:sha256, @uuid) |> Base.encode16(case: :lower)
    dir = Path.join([root, "mailboxes", "codex", key])
    File.mkdir_p!(dir)

    File.write!(
      Path.join(dir, "receiver.json"),
      Jason.encode!(
        Map.merge(
          %{
            "id" => @uuid,
            "host" => Shuttle.Poller.own_host_id(),
            "pid" => pid,
            "start" => start
          },
          extra
        )
      )
    )
  end

  @tag :tmp_dir
  test "hook receiver lifetime matches on both platforms; a reused PID is not the old holder", %{
    tmp_dir: root
  } do
    Process.put(:ps_result, {"813 1 codex -m gpt-sol\n", 0})

    for start <- ["123456", "1700000000.123456"] do
      receiver(root, 813, start)

      Process.put(
        :identity_result,
        {Jason.encode!(%{"status" => "present", "start" => start}), 0}
      )

      assert {:error, {:held, message}} = WorkerProcess.check_free(PsRunner, @uuid)
      assert message =~ "pid 813"
      assert_receive {:identity_probe, "813"}

      # An unrelated process now occupies the registered PID.
      Process.put(:ps_result, {"813 1 /usr/bin/sleep 60\n", 0})

      Process.put(
        :identity_result,
        {Jason.encode!(%{"status" => "present", "start" => start <> "9"}), 0}
      )

      assert :ok = WorkerProcess.check_free(PsRunner, @uuid)
      assert_receive {:identity_probe, "813"}
    end

    Process.put(:identity_result, {~s({"status":"gone"}), 0})
    assert :ok = WorkerProcess.check_free(PsRunner, @uuid)
    assert_receive {:identity_probe, "813"}
    assert nil == WorkerProcess.holder([], @uuid, PsRunner)
    refute_receive {:identity_probe, _}
  end

  @tag :tmp_dir
  test "unobservable or missing receiver lifetimes are explicitly unknown", %{tmp_dir: root} do
    Process.put(:ps_result, {"813 1 /usr/bin/sleep 60\n", 0})

    for start <- ["123456", "1700000000.123456"] do
      receiver(root, 813, start)

      for result <- [
            {~s({"status":"unknown"}), 0},
            {~s({"status":"present"}), 0},
            {~s({"status":"present","start":""}), 0},
            {"not json", 0},
            {"permission denied", 1},
            {"timed out", :timeout}
          ] do
        Process.put(:identity_result, result)
        assert {:error, {:unknown, _}} = WorkerProcess.check_free(PsRunner, @uuid)
        assert_receive {:identity_probe, "813"}
      end
    end

    for start <- [nil, ""] do
      receiver(root, 813, start)
      assert {:error, {:unknown, _}} = WorkerProcess.check_free(PsRunner, @uuid)
      refute_receive {:identity_probe, _}
    end

    receiver(root, 813, nil, %{"ended" => true})
    assert :ok = WorkerProcess.check_free(PsRunner, @uuid)
    refute_receive {:identity_probe, _}
  end

  @tag :tmp_dir
  test "unreadable or malformed receiver evidence cannot prove the holder gone", %{tmp_dir: root} do
    receiver(root, 813, "123456")
    key = :crypto.hash(:sha256, @uuid) |> Base.encode16(case: :lower)
    path = Path.join([root, "mailboxes", "codex", key, "receiver.json"])
    Process.put(:ps_result, {"813 1 codex -m fixture\n", 0})
    File.write!(path, "not json")
    assert {:error, {:unknown, _}} = WorkerProcess.check_free(PsRunner, @uuid)
    File.rm!(path)
    File.mkdir!(path)
    assert {:error, {:unknown, _}} = WorkerProcess.check_free(PsRunner, @uuid)
    refute_receive {:identity_probe, _}
  end

  @tag :tmp_dir
  test "explicit UUID and local run-script bindings do not depend on hook lifetime", %{
    tmp_dir: root
  } do
    receiver(root, 813, nil)
    Process.put(:ps_result, {"813 1 codex resume #{@uuid}\n", 0})
    assert {:error, {:held, _}} = WorkerProcess.check_free(PsRunner, @uuid)
    refute_receive {:identity_probe, _}

    tmux = "leaf-01KTHDNZS287ZSSG8X8V59XKW2-shuttle"
    row = %{"session" => @uuid, "tmux" => tmux, "host" => Shuttle.Poller.own_host_id(), "at" => 1}
    File.write!(Path.join(root, "sessions.jsonl"), Jason.encode!(row) <> "\n")
    Process.put(:ps_result, {"813 1 bash -l /tmp/shuttle-run-#{tmux}.42.sh\n", 0})
    assert {:error, {:held, _}} = WorkerProcess.check_free(PsRunner, @uuid)
    refute_receive {:identity_probe, _}
  end

  @tag :tmp_dir
  test "hook lifetime uses the real current-process kernel probe", %{tmp_dir: root} do
    pid = System.pid() |> String.to_integer()
    assert {:ok, output} = Shuttle.CLI.run(["process-identity", System.pid()])
    assert %{"status" => "present", "start" => start} = Jason.decode!(output)
    assert start != ""
    receiver(root, pid, start)

    assert %{pid: ^pid} =
             WorkerProcess.holder(WorkerProcess.parse("#{pid} 1 codex -m fixture\n"), @uuid)
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

  describe "which process is a worker" do
    @u "6d688234-9445-4d16-93d3-6bef110ea659"

    @workers """
      700     1 tmux new-session -d -s anchor
      710   700 bash -l /tmp/shuttle-run-#{@u}.3.sh
      711   710 claude --session-id #{@u}
      720   700 bash -l /tmp/shuttle-run-resume-#{@u}.4.sh
      721   720 claude --resume #{@u}
      730     1 /usr/libexec/gnome-terminal-server
      731   730 claude --resume #{@u}
      740   700 -zsh
      741   740 claude --model opus
      742   741 bash -c shuttle
      743   742 shuttle claim tests/b
    """

    test "a launch's run script makes its holder the worker; a History resume or a terminal of one's own does not" do
      procs = WorkerProcess.parse(@workers)
      by_pid = Map.new(procs, &{&1.pid, &1})
      assert %{pid: 710} = WorkerProcess.launch_root(procs, by_pid[711])
      assert WorkerProcess.launch_root(procs, by_pid[721]) == nil
      assert WorkerProcess.launch_root(procs, by_pid[731]) == nil
      assert %{pid: 710} = WorkerProcess.find(procs, %{uuid: @u, pane: nil}, PsRunner)

      # Without the launch, nothing holding the conversation is its worker.
      rest = Enum.reject(procs, &(&1.pid in [710, 711]))
      assert WorkerProcess.find(rest, %{uuid: @u, pane: nil}, PsRunner) == nil
    end

    test "a claimer is the harness its CLI runs under in that pane, never the pane's shell" do
      procs = WorkerProcess.parse(@workers)
      assert %{pid: 741} = WorkerProcess.claimer(procs, 743, 740)
      assert WorkerProcess.claimer(procs, 743, 710) == nil
      assert %{pid: 710} = WorkerProcess.claimer(procs, 711, 710)
    end
  end
end
