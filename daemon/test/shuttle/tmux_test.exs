defmodule Shuttle.TmuxTest do
  use ExUnit.Case, async: true

  alias Shuttle.Tmux

  # `Tmux` calls `runner.cmd/3` synchronously in the calling process, so a stub
  # backed by the process dictionary is the whole harness: `stub/2` stows the
  # tmux result this test wants (and the process scan's), and `cmd/3` (same
  # process) reads it and echoes the args back for the exact-match assertion.
  # The process scan defaults to "no processes".
  defmodule StubRunner do
    def cmd("tmux", args, _opts) do
      send(self(), {:tmux_args, args})
      Process.get(:tmux_result, {"", 0})
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

  defp stub(result, ps \\ {"", 0}) do
    Process.put(:tmux_result, result)
    Process.put(:ps_result, ps)
    StubRunner
  end

  @absent {"no server running on /tmp/tmux-501/default", 1}

  # tmux's output and exit, the process scan's, the session asked about, the
  # status, and whether the process table was consulted. Only tmux's own
  # absence messages consult it; any other failure (tmux not found, a fork
  # failure under load, a permissions error) is not a death signal.
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
    # The socket is lost but the session's run script still runs; another
    # session's run script, or a live name that merely ends with this one,
    # does not vouch for it.
    {@absent, {@run_script_ps, 0}, "leaf-01ABC-shuttle", :unknown, true},
    {@absent, {@run_script_ps, 0}, "other-shuttle", :gone, true},
    {@absent, {@run_script_ps, 0}, "01ABC-shuttle", :gone, true},
    # Absence the process scan cannot check.
    {@absent, {"ps: boom", 1}, "leaf-shuttle", :unknown, true},
    {@absent, {"", :timeout}, "leaf-shuttle", :unknown, true},
    {{"command not found: tmux", 127}, {"", 0}, "leaf", :unknown, false},
    {{"", 1}, {"", 0}, "leaf", :unknown, false},
    {{"fork: Resource temporarily unavailable", 1}, {"", 0}, "leaf", :unknown, false}
  ]

  test "session_status is :alive on success, :gone only for absence with no worker, else :unknown" do
    for {tmux, ps, session, expected, scans?} = row <- @session_statuses do
      assert Tmux.session_status(stub(tmux, ps), session) == expected, inspect(row)

      if scans?,
        do: assert_received({:ps_args, ["-ww", "-o", "pid=,ppid=,args=", "-U", _uid]}),
        else: refute_received({:ps_args, _})

      assert Tmux.present?(stub(tmux, ps), session) == (expected != :gone), inspect(row)
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
    assert Tmux.present?(stub({"", 0}), "leaf")
    assert Tmux.present?(stub({"some transient error", 1}), "leaf")
    refute Tmux.present?(stub({"can't find session: leaf", 1}), "leaf")
  end

  test "uses an exact-match target (= prefix) so a prefix sibling can't false-match" do
    Tmux.session_status(stub({"", 0}), "leaf-shuttle")
    assert_received {:tmux_args, ["has-session", "-t", "=leaf-shuttle"]}
  end

  describe "stop/2" do
    @worker_ps """
      700     1 tmux new-session -d -s elsewhere
      812   700 bash -l /tmp/shuttle-run-leaf-01ABC-shuttle.42.sh
    """

    test "a worker tmux cannot reach is signalled directly and the stop succeeds" do
      runner = stub({"can't find session: leaf-01ABC-shuttle", 1}, {@worker_ps, 0})

      assert Tmux.stop(runner, "leaf-01ABC-shuttle") == {"", 0}
      assert_received {:tmux_args, ["kill-session", "-t", "leaf-01ABC-shuttle"]}
      assert_received {:kill_args, ["-TERM", "--", "-812", "812"]}
    end

    test "an absent session with no worker process stops without signalling" do
      assert Tmux.stop(stub(@absent), "leaf-shuttle") == {"", 0}
      refute_received {:kill_args, _}
    end

    test "a kill-session failure without an absence message is returned as-is" do
      assert Tmux.stop(stub({"fork: Resource temporarily unavailable", 1}), "leaf") ==
               {"fork: Resource temporarily unavailable", 1}

      refute_received {:kill_args, _}
    end
  end
end
