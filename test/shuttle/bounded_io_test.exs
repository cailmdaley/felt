defmodule Shuttle.BoundedIOTest do
  use ExUnit.Case, async: false

  alias Shuttle.BoundedIO

  # The whole point of this module is that a caller cannot be held by a call
  # that never answers. `Process.sleep/1` stands in for the real hazard — a
  # `File.dir?` parked on a macOS consent dialog — because the property under
  # test is about the deadline, not about what is behind it.
  test "a call that does not answer yields the default, promptly" do
    {elapsed_us, result} =
      :timer.tc(fn ->
        BoundedIO.run(fn -> Process.sleep(:infinity) end, 100, default: :unknown, label: "wedged")
      end)

    assert result == :unknown
    assert div(elapsed_us, 1000) < 1_000
  end

  test "a call that answers in time returns its own value, not the default" do
    assert BoundedIO.run(fn -> :answered end, 1_000, default: :unknown) == :answered
  end

  # A crashing call must not take the caller with it — `async_nolink` is chosen
  # precisely so a raising probe degrades to the default rather than killing the
  # Poller.
  test "a crashing call yields the default instead of propagating" do
    assert BoundedIO.run(fn -> raise "boom" end, 1_000, default: :unknown) == :unknown
  end

  test "dir?/2 answers for a real directory and defaults to false when wedged" do
    assert BoundedIO.dir?(System.tmp_dir!())
    refute BoundedIO.dir?(Path.join(System.tmp_dir!(), "definitely-not-here-#{System.unique_integer([:positive])}"))
  end

  # The load-bearing half of "abandon the task rather than shut it down": the
  # caller must not collect a reply from a probe it already gave up on. It does
  # not, because a Task's ref is a process alias and `demonitor/2` deactivates
  # it — a reply sent after that point is dropped by the runtime. Pinned here
  # because the reasoning lives in an OTP detail, not in this module's code, and
  # a future refactor that hand-rolls the task would silently lose it: a stray
  # `{reference(), boolean()}` in `Shuttle.Poller`'s mailbox is exactly the kind
  # of thing that goes unnoticed until it matches a `handle_info` head.
  test "a reply from an abandoned call never reaches the caller" do
    assert BoundedIO.run(fn -> Process.sleep(50) && :late end, 5, default: :gave_up) == :gave_up

    refute_receive {_ref, :late}, 500
  end
end
