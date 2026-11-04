defmodule Shuttle.ContractTest do
  use ExUnit.Case, async: true

  defmodule LevelRunner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["contract"], _opts), do: {"14\n", 0}
  end

  defmodule Level16Runner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["contract"], _opts), do: {"16\n", 0}
  end

  test "a CLI at level 16 lacks the sender label on queued fiber context" do
    result = Shuttle.Contract.check(Level16Runner)
    refute result.ok
    assert result.reason =~ "context-mailbox put --from"
  end

  defmodule Level17Runner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["contract"], _opts), do: {"17\n", 0}
  end

  test "a CLI at level 17 cannot count what waits for a fiber's next worker" do
    result = Shuttle.Contract.check(Level17Runner)
    refute result.ok
    assert result.reason =~ "context-mailbox pending"
  end

  defmodule Level18Runner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["contract"], _opts), do: {"18\n", 0}
  end

  test "a CLI at level 18 cannot verify a hook receiver's kernel lifetime" do
    result = Shuttle.Contract.check(Level18Runner)
    refute result.ok
    assert result.reason =~ "process-identity PID"
  end

  defmodule Level29Runner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["contract"], _opts), do: {"29\n", 0}
  end

  test "an install without exact namespace verbs is refused before dispatch" do
    result = Shuttle.Contract.check(Level29Runner)
    refute result.ok
    assert result.reason =~ "felt show --exact"
    assert result.reason =~ "felt add --namespace"
  end

  defmodule Level30Runner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["contract"], _opts), do: {"30\n", 0}
  end

  test "UID-less exact writes require a CLI that preserves resolved addresses" do
    result = Shuttle.Contract.check(Level30Runner)
    refute result.ok
    assert result.reason =~ "UID-less"
  end

  test "the expected level covers the receiver-authority verbs" do
    assert Shuttle.Contract.expected_level() >= 15
  end

  test "a CLI below the expected level is told which daemon-shelled verbs it lacks" do
    result = Shuttle.Contract.check(LevelRunner)
    refute result.ok
    assert result.observed == 14
    assert result.reason =~ "context-mailbox get/receiver/revoke/put/deliver"
    assert result.reason =~ "close --quiet"
  end
end
