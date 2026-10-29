defmodule Shuttle.TerminalTest do
  use ExUnit.Case, async: true

  alias Shuttle.Terminal
  alias Shuttle.Terminal.Tmux
  alias Shuttle.Test.Env

  # Terminal commands and process scans run synchronously in the caller.
  defmodule StubRunner do
    def cmd("tmux", args, _opts) do
      send(self(), {:tmux_args, args})

      case args do
        ["new-session" | _] -> Process.get(:launch_result, {"", 0})
        ["ls" | _] -> Process.get(:list_result, {"", 0})
        _ -> Process.get(:tmux_result, {"", 0})
      end
    end

    def cmd("ps", args, _opts) do
      send(self(), {:ps_args, args})
      Process.get(:ps_result, {"", 0})
    end

    # A signal ends the worker: later scans find no process.
    def cmd("kill", args, _opts) do
      send(self(), {:kill_args, args})
      Process.put(:ps_result, {"", 0})
      {"", 0}
    end
  end

  defmodule ConcurrentRunner do
    def cmd("ps", _args, _opts), do: {"", 0}

    def cmd("tmux", ["has-session", "-t", "=" <> name], _opts) do
      {state, _owner} = Shuttle.Env.app(:terminal_test_state)
      if Agent.get(state, &MapSet.member?(&1, name)), do: {"", 0}, else: {"can't find session", 1}
    end

    def cmd("tmux", ["new-session", "-d", "-s", name | rest], _opts) do
      {state, owner} = Shuttle.Env.app(:terminal_test_state)
      send(owner, {:launching, self(), name, List.last(rest)})

      receive do
        :finish_launch -> Agent.update(state, &MapSet.put(&1, name))
      end

      {"", 0}
    end
  end

  defp stub(result, ps \\ {"", 0}) do
    Process.put(:tmux_result, result)
    Process.put(:ps_result, ps)
    StubRunner
  end

  @absent {"no server running on /tmp/tmux-501/default", 1}

  @run_script_ps """
    700     1 tmux new-session -d -s shuttle-anchor
    812   700 bash -l /tmp/shuttle-run-leaf-01ABC-shuttle.42.sh
    813   812 claude --resume 11111111-2222-3333-4444-555555555555
  """

  @session_statuses [
    {{"", 0}, {"", 0}, "leaf-shuttle", :alive, false},
    {{"can't find session: leaf-shuttle", 1}, {"", 0}, "leaf-shuttle", :gone, true},
    {@absent, {"", 0}, "leaf-shuttle", :gone, true},
    {{"no such session: leaf-shuttle", 1}, {"", 0}, "leaf-shuttle", :gone, true},
    {{"error connecting to /tmp/tmux-501/default (No such file or directory)", 1}, {"", 0},
     "leaf-shuttle", :gone, true},
    # An unreachable live run script holds only its exact session name.
    {@absent, {@run_script_ps, 0}, "leaf-01ABC-shuttle", :unknown, true},
    {@absent, {@run_script_ps, 0}, "other-shuttle", :gone, true},
    {@absent, {@run_script_ps, 0}, "01ABC-shuttle", :gone, true},
    {@absent, {"ps: boom", 1}, "leaf-shuttle", :unknown, true},
    {@absent, {"", :timeout}, "leaf-shuttle", :unknown, true},
    {{"command not found: tmux", 127}, {"", 0}, "leaf", :unknown, false},
    {{"", 1}, {"", 0}, "leaf", :unknown, false},
    {{"fork: Resource temporarily unavailable", 1}, {"", 0}, "leaf", :unknown, false}
  ]

  test "status is :alive on success, :gone only for absence with no worker, else :unknown" do
    for {tmux, ps, session, expected, scans?} = row <- @session_statuses do
      assert Terminal.status(stub(tmux, ps), session) == expected, inspect(row)

      if scans?,
        do: assert_received({:ps_args, ["-ww", "-o", "pid=,ppid=,args=", "-U", _uid]}),
        else: refute_received({:ps_args, _})

      assert Terminal.present?(stub(tmux, ps), session) == (expected != :gone), inspect(row)
      flush_ps_args()
    end
  end

  defp flush_ps_args do
    receive do
      {:ps_args, _} -> flush_ps_args()
    after
      0 -> :ok
    end
  end

  test "present? treats :alive and :unknown as present, only :gone as absent" do
    assert Terminal.present?(stub({"", 0}), "leaf")
    assert Terminal.present?(stub({"some transient error", 1}), "leaf")
    refute Terminal.present?(stub({"can't find session: leaf", 1}), "leaf")
  end

  test "uses an exact-match target (= prefix) so a prefix sibling can't false-match" do
    Terminal.status(stub({"", 0}), "leaf-shuttle")
    assert_received {:tmux_args, ["has-session", "-t", "=leaf-shuttle"]}
  end

  test "tmux probes report backend evidence without consulting the process table" do
    assert Tmux.probe(stub(@absent, {@run_script_ps, 0}), "leaf-01ABC-shuttle") == :absent
    assert Tmux.probe(stub({"", 0}), "leaf") == :present
    assert Tmux.probe(stub({"timed out", :timeout}), "leaf") == :unknown
    refute_received {:ps_args, _}
  end

  test "the tmux backend is the primary, and locate requires positive presence" do
    assert Terminal.primary() == Tmux
    assert Terminal.backends() == [Tmux]
    assert Terminal.locate(stub({"", 0}), "leaf") == Tmux
    assert Terminal.locate(stub(@absent), "leaf") == nil
    assert Terminal.locate(stub({"uncertain", 1}), "leaf") == nil
    assert Terminal.status(stub(@absent), "leaf", backends: [Tmux]) == :gone
  end

  describe "stop/2" do
    @worker_ps """
      700     1 tmux new-session -d -s elsewhere
      812   700 bash -l /tmp/shuttle-run-leaf-01ABC-shuttle.42.sh
    """

    test "a worker tmux cannot reach is signalled directly and the stop succeeds" do
      runner = stub({"can't find session: leaf-01ABC-shuttle", 1}, {@worker_ps, 0})

      assert Terminal.stop(runner, "leaf-01ABC-shuttle") == {"", 0}
      assert_received {:tmux_args, ["kill-session", "-t", "leaf-01ABC-shuttle"]}
      assert_received {:kill_args, ["-TERM", "--", "-812", "812"]}
    end

    test "an absent session with no worker process stops without signalling" do
      assert Terminal.stop(stub(@absent), "leaf-shuttle") == {"", 0}
      refute_received {:kill_args, _}
    end

    test "a kill-session failure without an absence message is returned" do
      assert Terminal.stop(stub({"fork: Resource temporarily unavailable", 1}), "leaf") ==
               {"fork: Resource temporarily unavailable", 1}

      refute_received {:kill_args, _}
    end
  end

  describe "launch/5" do
    setup do
      Env.put_app_env(:os_type, {:unix, :linux})
      :ok
    end

    test "writes an executable script and launches bash -l at its tracked path" do
      name = "terminal-test-#{System.unique_integer([:positive])}"
      assert :ok = Terminal.launch(stub(@absent), name, "/tmp", "echo worker\n")

      assert_received {:tmux_args,
                       ["new-session", "-d", "-s", ^name, "-c", "/tmp", "bash", "-l", path]}

      on_exit(fn -> File.rm(path) end)
      assert File.read!(path) == "echo worker\n"
      assert {:ok, %{mode: mode}} = File.stat(path)
      assert Bitwise.band(mode, 0o777) == 0o755
      assert Path.basename(path) =~ "shuttle-run-#{name}."
    end

    test "a failed launch removes its script" do
      Process.put(:launch_result, {"fork failed", 1})
      name = "terminal-failure-#{System.unique_integer([:positive])}"

      assert {:error, "tmux failed: fork failed"} =
               Terminal.launch(stub(@absent), name, "/tmp", "echo worker\n")

      assert_received {:tmux_args, ["new-session", "-d", "-s", ^name | rest]}
      refute File.exists?(List.last(rest))
    end

    test "two launches of one name serialize through the successful creation" do
      state = start_supervised!({Agent, fn -> MapSet.new() end})
      Env.put_app_env(:terminal_test_state, {state, self()})
      name = "terminal-race-#{System.unique_integer([:positive])}"
      first = Task.async(fn -> Terminal.launch(ConcurrentRunner, name, "/tmp", "echo worker") end)
      assert_receive {:launching, pid, ^name, path}
      on_exit(fn -> File.rm(path) end)

      second =
        Task.async(fn -> Terminal.launch(ConcurrentRunner, name, "/tmp", "echo duplicate") end)

      refute_receive {:launching, _, ^name, _}, 100
      send(pid, :finish_launch)
      assert Task.await(first) == :ok
      assert Task.await(second) == {:error, :already_running}
      assert File.read!(path) == "echo worker"
    end

    test "different names do not share a launch lock" do
      state = start_supervised!({Agent, fn -> MapSet.new() end})
      Env.put_app_env(:terminal_test_state, {state, self()})
      names = for n <- 1..2, do: "terminal-parallel-#{n}-#{System.unique_integer([:positive])}"

      tasks =
        for name <- names,
            do: Task.async(fn -> Terminal.launch(ConcurrentRunner, name, "/tmp", "true") end)

      assert_receive {:launching, first, name1, path1}, 1_000
      assert_receive {:launching, second, name2, path2}, 1_000
      on_exit(fn -> Enum.each([path1, path2], &File.rm/1) end)
      assert Enum.sort([name1, name2]) == Enum.sort(names)
      send(first, :finish_launch)
      send(second, :finish_launch)
      assert Enum.map(tasks, &Task.await/1) == [:ok, :ok]
    end

    test "alive and unknown names refuse launch before writing a script" do
      for result <- [{"", 0}, {"fork failed", 1}] do
        assert {:error, :already_running} =
                 Terminal.launch(stub(result), "held", "/tmp", "echo duplicate")
      end

      refute_received {:tmux_args, ["new-session" | _]}
    end
  end

  test "worker listing holds on uncertainty and retains a positive list if ps fails" do
    Process.put(:list_result, {"no server running", 1})
    stub(@absent)
    assert Terminal.list_workers(StubRunner) == {:ok, []}
    Process.put(:ps_result, {"ps failed", 1})
    assert Terminal.list_workers(StubRunner) == {:error, :unknown}
    Process.put(:list_result, {"leaf-01KTHDNZS287ZSSG8X8V59XKWB-shuttle\nother\n", 0})

    assert Terminal.list_workers(StubRunner) ==
             {:ok, ["leaf-01KTHDNZS287ZSSG8X8V59XKWB-shuttle"]}

    assert Terminal.list(StubRunner, "other") == {:ok, ["other"]}
    Process.put(:list_result, {"timed out", :timeout})
    assert Terminal.list_workers(StubRunner) == {:error, :unknown}
  end

  test "rename is idempotent and preserves immutable tmux session IDs" do
    assert :ok = Terminal.rename(stub({"", 0}), "leaf", "leaf")
    refute_received {:tmux_args, ["rename-session" | _]}
    assert :ok = Tmux.rename(StubRunner, "old", "new")
    assert_received {:tmux_args, ["rename-session", "-t", "=old", "new"]}
    assert :ok = Tmux.rename(StubRunner, "$12", "new")
    assert_received {:tmux_args, ["rename-session", "-t", "$12", "new"]}
  end

  test "native references do not overlap tmux names or pane IDs" do
    assert Terminal.native_ref?("session:uuid")
    assert Terminal.native_ref?("block:uuid")
    refute Terminal.native_ref?("leaf-shuttle")
    refute Terminal.native_ref?("%3")
    refute Terminal.native_ref?(nil)
  end
end
