defmodule Shuttle.Terminal.ReceiptsTest do
  use ExUnit.Case, async: true

  alias Shuttle.Terminal
  alias Shuttle.Terminal.{Receipts, Tmux}
  alias Shuttle.Test.Env

  @moduletag :tmp_dir

  # tmux and ps answer from the process dictionary; kills are recorded.
  defmodule Runner do
    # A rename takes the worker name off the session.
    def cmd("tmux", ["rename-session" | _] = args, _opts) do
      send(self(), {:tmux, args})
      Process.put(:tmux, {"can't find session", 1})
      {"", 0}
    end

    def cmd("tmux", _args, _opts), do: Process.get(:tmux, {"no server running", 1})

    def cmd("ps", ["-ww", "-o", "args=", "-p", pid], _opts) do
      send(self(), {:ps_pid, pid})
      Process.get({:ps_pid, pid}, {"", 1})
    end

    def cmd("ps", ["-o", "lstart=", "-p", pid], opts) do
      send(self(), {:ps_lstart, pid, Keyword.get(opts, :env)})
      Process.get({:ps_lstart, pid}, {"", 1})
    end

    def cmd("ps", _args, _opts) do
      send(self(), :ps_scan)
      Process.get(:ps_scan, {"ps timed out", :timeout})
    end

    def cmd("kill", args, _opts) do
      send(self(), {:kill, args})
      {"", 0}
    end
  end

  setup %{tmp_dir: dir} do
    Env.put_env("SHUTTLE_DATA_DIR", Path.join(dir, "data"))
    Env.put_app_env(:terminal_backend, Tmux)
    Env.put_app_env(:os_type, {:unix, :linux})
    Env.put_app_env(:proc_root, Path.join(dir, "proc"))
    Env.put_app_env(:worker_stop_ladder, [{nil, 50}, {"TERM", 50}, {"KILL", 50}])
    %{dir: dir}
  end

  defp launched(dir) do
    name = "leaf-#{System.unique_integer([:positive])}-shuttle"
    script = Path.join(dir, "shuttle-run-#{name}.#{System.unique_integer([:positive])}.sh")
    {:ok, _text} = Receipts.put(name, script, "#!/bin/bash\nset -e\nexit 0\n")
    {name, script}
  end

  defp started(name, pid), do: File.write!(Receipts.pid_path(name), "#{pid}\n")

  defp proc(dir, pid, cmdline) do
    path = Path.join([dir, "proc", Integer.to_string(pid)])
    File.mkdir_p!(path)
    File.write!(Path.join(path, "cmdline"), String.replace(cmdline, " ", <<0>>))
  end

  defp next_pid, do: System.unique_integer([:positive]) + 100_000

  test "the stamped script records its own pid first, before anything can fail", %{dir: dir} do
    name = "stamp-#{System.unique_integer([:positive])}-shuttle"
    script = Path.join(dir, "shuttle-run-#{name}.1.sh")
    {:ok, text} = Receipts.put(name, script, "#!/bin/bash\nset -e\nfalse\n")
    File.write!(script, text)
    {_, 1} = System.cmd("bash", [script])
    {pid, _} = Integer.parse(File.read!(Receipts.pid_path(name)))
    assert pid > 0
    assert ["#!/bin/bash", "printf" <> _, "set -e" | _] = String.split(text, "\n")
  end

  test "no receipt, or no pid recorded yet, defers to terminals and the scan", %{dir: dir} do
    assert Receipts.status(Runner, "unlaunched-shuttle") == :none
    {name, _} = launched(dir)
    assert Receipts.status(Runner, name) == :none
  end

  # The fir phantom: the worker exited, its terminal is unobservable and the
  # process table cannot be scanned. The receipt alone settles it.
  test "an exited run script is gone however uncertain the terminal and scan", %{dir: dir} do
    {name, _} = launched(dir)
    started(name, next_pid())
    Process.put(:tmux, {"tmux timed out", :timeout})

    assert Receipts.status(Runner, name) == :exited
    assert Terminal.status(Runner, name) == :gone
    refute_received :ps_scan
  end

  test "a running script is alive without a terminal or a scan, even with its file deleted",
       %{dir: dir} do
    {name, script} = launched(dir)
    pid = next_pid()
    started(name, pid)
    proc(dir, pid, "bash -l #{script}")
    refute File.exists?(script)

    assert Receipts.status(Runner, name) == :running
    assert Terminal.status(Runner, name) == :alive
    refute_received :ps_scan
  end

  test "a reused pid is not the worker", %{dir: dir} do
    {name, _} = launched(dir)
    pid = next_pid()
    started(name, pid)
    proc(dir, pid, "vim notes.md")
    assert Receipts.status(Runner, name) == :exited
  end

  test "off Linux one ps lookup of the recorded pid answers", %{dir: dir} do
    Env.put_app_env(:os_type, {:unix, :darwin})
    {name, script} = launched(dir)
    started(name, 77)
    Process.put({:ps_pid, "77"}, {"bash -l #{script}\n", 0})
    assert Receipts.status(Runner, name) == :running
    assert_received {:ps_pid, "77"}

    Process.put({:ps_pid, "77"}, {"", 1})
    assert Receipts.status(Runner, name) == :exited

    Process.put({:ps_pid, "77"}, {"", :timeout})
    assert Receipts.status(Runner, name) == :none
  end

  test "a pre-receipt launch whose script is gone is exited only once the scan fails",
       %{dir: dir} do
    name = "legacy-#{System.unique_integer([:positive])}-shuttle"
    script = Path.join(dir, "shuttle-run-#{name}.7.sh")
    File.write!(script, "exit 0\n")
    :ok = Terminal.LaunchAttempts.record(name, script)
    Process.put(:tmux, {"tmux timed out", :timeout})
    Process.put(:ps_scan, {"", 0})
    refute Receipts.legacy_exited?(name)

    File.rm!(script)
    assert Receipts.legacy_exited?(name)
    # A working scan with an uncertain terminal stays uncertain…
    assert Terminal.status(Runner, name) == :unknown
    # …and a failed one settles on the missing script.
    Process.put(:ps_scan, {"ps timed out", :timeout})
    assert Terminal.status(Runner, name) == :gone
  end

  test "a rename carries the receipt and clears the target's stale one", %{dir: dir} do
    {name, script} = launched(dir)
    pid = next_pid()
    started(name, pid)
    proc(dir, pid, "bash -l #{script}")
    {stale, _} = launched(dir)
    started(stale, next_pid())

    assert :ok = Receipts.move(name, stale)
    assert Receipts.status(Runner, stale) == :running
    assert Receipts.status(Runner, name) == :none

    assert :ok = Receipts.move("never-launched", stale)
    assert Receipts.status(Runner, stale) == :none
  end

  test "a stop signals the receipt's pid without a scan", %{dir: dir} do
    {name, script} = launched(dir)
    pid = next_pid()
    started(name, pid)
    proc(dir, pid, "bash -l #{script}")

    assert {message, 1} = Terminal.stop(Runner, name)
    assert message =~ "still running"
    p = Integer.to_string(pid)
    assert_received {:kill, ["-TERM", "--", "-" <> ^p, ^p]}
    assert_received {:kill, ["-KILL", "--", "-" <> ^p, ^p]}
    refute_received :ps_scan
  end

  # A claim names the harness process itself: that process gone, or its pid
  # reused by a younger process, ends the worker whatever its terminal shows.
  describe "a claimed process" do
    defp stat(dir, pid, start) do
      path = Path.join([dir, "proc", Integer.to_string(pid)])
      File.mkdir_p!(path)
      # /proc/<pid>/stat: pid (comm) state ppid … starttime is field 22.
      fields = Enum.map(4..21, fn _ -> "0" end) ++ [start, "7", "8"]
      File.write!(Path.join(path, "stat"), "#{pid} (claude code) S " <> Enum.join(fields, " "))
    end

    defp claimed(dir, pid, start) do
      name = "claimed-#{System.unique_integer([:positive])}-shuttle"
      stat(dir, pid, start)
      assert :ok = Receipts.claim(Runner, name, pid, "human-tab")
      name
    end

    test "is running while the pid lives with its birth, exited once gone or reborn", %{dir: dir} do
      pid = next_pid()
      name = claimed(dir, pid, "12345")

      assert {:ok, %{pid: ^pid, birth: "12345", released_as: "human-tab"}} =
               Receipts.process_receipt(name)

      assert Receipts.status(Runner, name) == :running
      assert Receipts.running_pid(Runner, name) == pid

      stat(dir, pid, "99999")
      assert Receipts.status(Runner, name) == :exited

      File.rm_rf!(Path.join([dir, "proc", Integer.to_string(pid)]))
      assert Receipts.status(Runner, name) == :exited
      assert Receipts.running_pid(Runner, name) == nil
    end

    test "a claim of a process that cannot be read records nothing", %{dir: dir} do
      name = "unclaimable-#{System.unique_integer([:positive])}-shuttle"
      assert {:error, :process_not_found} = Receipts.claim(Runner, name, next_pid(), "tab")
      assert Receipts.process_receipt(name) == :none
      assert Receipts.status(Runner, name) == :none
      File.mkdir_p!(Path.join([dir, "proc", "1"]))
    end

    test "off Linux ps answers in one fixed locale and zone", %{dir: _dir} do
      Env.put_app_env(:os_type, {:unix, :darwin})
      name = "mac-#{System.unique_integer([:positive])}-shuttle"
      Process.put({:ps_lstart, "77"}, {"Sat Nov 14 20:00:00 2026\n", 0})
      assert :ok = Receipts.claim(Runner, name, 77, "tab")
      assert_received {:ps_lstart, "77", [{"LC_ALL", "C"}, {"TZ", "UTC"}]}
      assert Receipts.status(Runner, name) == :running

      Process.put({:ps_lstart, "77"}, {"Sat Nov 14 21:00:00 2026\n", 0})
      assert Receipts.status(Runner, name) == :exited
      Process.put({:ps_lstart, "77"}, {"", 1})
      assert Receipts.status(Runner, name) == :exited
      Process.put({:ps_lstart, "77"}, {"", :timeout})
      assert Receipts.status(Runner, name) == :none
    end

    test "exited makes a present terminal gone; running keeps it alive", %{dir: dir} do
      pid = next_pid()
      name = claimed(dir, pid, "500")
      Process.put(:tmux, {"", 0})
      assert Terminal.status(Runner, name) == :alive

      File.rm_rf!(Path.join([dir, "proc", Integer.to_string(pid)]))
      assert Terminal.status(Runner, name) == :gone
      refute_received :ps_scan
    end

    test "a launch under the name replaces a claim's process receipt", %{dir: dir} do
      name = claimed(dir, next_pid(), "650")
      script = Path.join(dir, "shuttle-run-#{name}.2.sh")
      {:ok, _} = Receipts.put(name, script, "#!/bin/bash\n")
      assert Receipts.process_receipt(name) == :none
      assert Receipts.status(Runner, name) == :none
    end

    test "a rename carries the process receipt", %{dir: dir} do
      pid = next_pid()
      name = claimed(dir, pid, "600")
      assert :ok = Receipts.move(name, "renamed-shuttle")
      assert Receipts.process_receipt(name) == :none
      assert {:ok, %{pid: ^pid}} = Receipts.process_receipt("renamed-shuttle")
      assert Receipts.status(Runner, "renamed-shuttle") == :running
    end

    test "release gives an exited claim's tmux session back under its own name and forgets it",
         %{dir: dir} do
      pid = next_pid()
      name = claimed(dir, pid, "700")
      Process.put(:tmux, {"", 0})

      assert :ok = Terminal.release_exited(Runner, name)
      refute_received {:tmux, _}

      File.rm_rf!(Path.join([dir, "proc", Integer.to_string(pid)]))
      assert :ok = Terminal.release_exited(Runner, name)
      assert_received {:tmux, ["rename-session", "-t", "=" <> ^name, "human-tab"]}
      assert Receipts.process_receipt(name) == :none
      assert :ok = Terminal.release_exited(Runner, name)
      refute_received {:tmux, _}
    end

    test "a stop releases an exited claim instead of closing the human's terminal", %{dir: dir} do
      pid = next_pid()
      name = claimed(dir, pid, "800")
      File.rm_rf!(Path.join([dir, "proc", Integer.to_string(pid)]))
      Process.put(:tmux, {"", 0})

      assert {"", 0} = Terminal.stop(Runner, name)
      assert_received {:tmux, ["rename-session", "-t", "=" <> ^name, "human-tab"]}
      refute_received {:kill, _}
    end
  end

  # Every combination of what the daemon can observe about one worker: its
  # terminal, its launch receipt, and the process table. Liveness follows one
  # law, and a stop is prompt and reports stopped exactly when the worker is gone.
  describe "observation matrix" do
    @terminals %{
      present: {"", 0},
      absent: {"no server running", 1},
      unknown: {"tmux timed out", :timeout}
    }
    @receipts [:none, :running, :exited]
    @scans [:found, :empty, :failed]

    defp expected(terminal, receipt, scan) do
      cond do
        terminal == :present -> :alive
        receipt == :exited -> :gone
        receipt == :running -> :alive
        scan == :found -> :alive
        scan == :empty and terminal == :absent -> :gone
        true -> :unknown
      end
    end

    defp observe(dir, terminal, receipt, scan) do
      {name, script} = launched(dir)
      pid = next_pid()

      case receipt do
        :none ->
          :ok = Receipts.move("nothing", name)

        :running ->
          started(name, pid)
          proc(dir, pid, "bash -l #{script}")

        :exited ->
          started(name, pid)
      end

      Process.put(:tmux, @terminals[terminal])

      Process.put(
        :ps_scan,
        %{
          found: {"#{pid} 1 bash -l /tmp/shuttle-run-#{name}.9.sh\n", 0},
          empty: {"", 0},
          failed: {"ps timed out", :timeout}
        }[scan]
      )

      name
    end

    test "liveness follows the law in every combination", %{dir: dir} do
      for terminal <- Map.keys(@terminals), receipt <- @receipts, scan <- @scans do
        name = observe(dir, terminal, receipt, scan)

        assert Terminal.status(Runner, name) == expected(terminal, receipt, scan),
               inspect({terminal, receipt, scan})
      end
    end

    # A terminal that closed or holds nothing leaves a stop that succeeds unless
    # the worker is seen alive: an unobservable worker is let go, never waited
    # on. A terminal that cannot be reached closed nothing, so only a gone
    # worker is stopped.
    test "a stop with no terminal to show the worker is prompt and stops all but the living",
         %{dir: dir} do
      for terminal <- [:absent, :unknown], receipt <- @receipts, scan <- @scans do
        name = observe(dir, terminal, receipt, scan)
        liveness = expected(terminal, receipt, scan)

        stopped? =
          if terminal == :absent, do: liveness != :alive, else: liveness == :gone

        {micros, {_, code}} = :timer.tc(fn -> Terminal.stop(Runner, name) end)
        assert code == if(stopped?, do: 0, else: 1), inspect({terminal, receipt, scan})
        assert micros < 2_000_000, inspect({terminal, receipt, scan})
      end
    end
  end
end
