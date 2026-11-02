defmodule Shuttle.Test.FiberUidTest do
  use ExUnit.Case, async: true

  test "parallel test VMs have different worker identities" do
    helper = Path.expand("../support/fiber_uid.ex", __DIR__)

    {output, 0} =
      System.cmd("elixir", [
        "-pa",
        Path.dirname(to_string(:code.which(Shuttle.Dispatcher))),
        "-r",
        helper,
        "-e",
        ~s|IO.puts(Shuttle.Test.FiberUid.for("tests/shared-worker"))|
      ])

    other = String.trim(output)
    own = Shuttle.Test.FiberUid.for("tests/shared-worker")
    assert Shuttle.ULID.valid?(other)
    assert Shuttle.ULID.valid?(own)
    assert other != own
    assert Shuttle.Test.FiberUid.for("tests/shared-worker") == own
  end
end
