defmodule Shuttle.ContractTest do
  use ExUnit.Case, async: true

  defmodule LevelRunner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["contract"], _opts), do: {"14\n", 0}
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
