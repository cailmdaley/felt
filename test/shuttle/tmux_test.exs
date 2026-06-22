defmodule Shuttle.TmuxTest do
  use ExUnit.Case, async: true

  alias Shuttle.Tmux

  # `Tmux` calls `runner.cmd/3` synchronously in the calling process, so a stub
  # backed by the process dictionary is the whole harness: `stub/1` stows the
  # result this test wants, and `cmd/3` (same process) reads it and echoes the
  # args back for the exact-match assertion.
  defmodule StubRunner do
    def cmd("tmux", args, _opts) do
      send(self(), {:tmux_args, args})
      Process.get(:tmux_result, {"", 0})
    end
  end

  defp stub(result) do
    Process.put(:tmux_result, result)
    StubRunner
  end

  test "exit 0 is :alive" do
    assert Tmux.session_status(stub({"", 0}), "leaf-shuttle") == :alive
  end

  test "tmux's absence messages classify as :gone" do
    for msg <- [
          "can't find session: leaf-shuttle",
          "no server running on /tmp/tmux-501/default",
          "no such session: leaf-shuttle",
          "error connecting to /tmp/tmux-501/default (No such file or directory)"
        ] do
      assert Tmux.session_status(stub({msg, 1}), "leaf-shuttle") == :gone,
             "expected :gone for #{inspect(msg)}"
    end
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
end
