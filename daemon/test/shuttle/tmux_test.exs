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

  test "exit 0 is :alive" do
    assert Tmux.session_status(stub({"", 0}), "leaf-shuttle") == :alive
    refute_received {:ps_args, _}
  end

  test "tmux's absence messages with no live worker process classify as :gone" do
    for msg <- [
          "can't find session: leaf-shuttle",
          "no server running on /tmp/tmux-501/default",
          "no such session: leaf-shuttle",
          "error connecting to /tmp/tmux-501/default (No such file or directory)"
        ] do
      assert Tmux.session_status(stub({msg, 1}), "leaf-shuttle") == :gone,
             "expected :gone for #{inspect(msg)}"
    end

    assert_received {:ps_args, ["-ww", "-o", "pid=,ppid=,args=", "-U", _uid]}
  end

  test "absence while the session's run script still runs is :unknown (socket lost, worker alive)" do
    ps = """
      700     1 tmux new-session -d -s shuttle-anchor
      812   700 bash -l /tmp/shuttle-run-leaf-01ABC-shuttle.42.sh
      813   812 claude --resume 11111111-2222-3333-4444-555555555555
    """

    assert Tmux.session_status(stub(@absent, {ps, 0}), "leaf-01ABC-shuttle") == :unknown
    assert Tmux.present?(stub(@absent, {ps, 0}), "leaf-01ABC-shuttle")

    # Another session's run script does not vouch for this one.
    assert Tmux.session_status(stub(@absent, {ps, 0}), "other-shuttle") == :gone
    # Nor does a name that is merely a suffix of a live one.
    assert Tmux.session_status(stub(@absent, {ps, 0}), "01ABC-shuttle") == :gone
  end

  test "absence the process scan cannot check is :unknown" do
    assert Tmux.session_status(stub(@absent, {"ps: boom", 1}), "leaf-shuttle") == :unknown
    assert Tmux.session_status(stub(@absent, {"", :timeout}), "leaf-shuttle") == :unknown
  end

  test "a non-absence error classifies as :unknown (not a death signal)" do
    # tmux binary not found, a fork failure under load, a permissions error — any
    # non-zero whose output is NOT tmux's own absence message.
    assert Tmux.session_status(stub({"command not found: tmux", 127}), "leaf") == :unknown
    assert Tmux.session_status(stub({"", 1}), "leaf") == :unknown

    assert Tmux.session_status(stub({"fork: Resource temporarily unavailable", 1}), "leaf") ==
             :unknown
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
