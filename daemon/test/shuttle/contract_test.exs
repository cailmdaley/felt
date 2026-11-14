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
    {:verdict, result} = Shuttle.Contract.check(Level16Runner)
    refute result.ok
    assert result.reason =~ "context-mailbox put --from"
  end

  defmodule Level17Runner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["contract"], _opts), do: {"17\n", 0}
  end

  test "a CLI at level 17 cannot count what waits for a fiber's next worker" do
    {:verdict, result} = Shuttle.Contract.check(Level17Runner)
    refute result.ok
    assert result.reason =~ "context-mailbox pending"
  end

  defmodule Level18Runner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["contract"], _opts), do: {"18\n", 0}
  end

  test "a CLI at level 18 cannot verify a hook receiver's kernel lifetime" do
    {:verdict, result} = Shuttle.Contract.check(Level18Runner)
    refute result.ok
    assert result.reason =~ "process-identity PID"
  end

  defmodule Level29Runner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["contract"], _opts), do: {"29\n", 0}
  end

  test "an install without exact namespace verbs is refused before dispatch" do
    {:verdict, result} = Shuttle.Contract.check(Level29Runner)
    refute result.ok
    assert result.reason =~ "felt show --exact"
    assert result.reason =~ "felt add --namespace"
  end

  defmodule Level30Runner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["contract"], _opts), do: {"30\n", 0}
  end

  test "UID-less exact writes require a CLI that preserves resolved addresses" do
    {:verdict, result} = Shuttle.Contract.check(Level30Runner)
    refute result.ok
    assert result.reason =~ "UID-less"
  end

  test "the expected level covers the receiver-authority verbs" do
    assert Shuttle.Contract.expected_level() >= 15
  end

  test "a CLI below the expected level is told which daemon-shelled verbs it lacks" do
    {:verdict, result} = Shuttle.Contract.check(LevelRunner)
    refute result.ok
    assert result.observed == 14
    assert result.reason =~ "context-mailbox get/receiver/revoke/put/deliver"
    assert result.reason =~ "close --quiet"
  end

  defmodule EagainRunner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["contract"], _opts), do: :erlang.error(:eagain)
  end

  defmodule UnknownCommandRunner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["contract"], _opts), do: {"Error: unknown command \"contract\"\n", 1}
  end

  defmodule TimeoutRunner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["contract"], opts) do
      send(self(), {:timeout_ms, opts[:timeout_ms]})
      {"shuttle timed out", :timeout}
    end
  end

  defmodule MatchRunner do
    @behaviour Shuttle.Runner
    def cmd("shuttle", ["contract"], _opts),
      do: {"#{Shuttle.Contract.expected_level()}\n", 0}
  end

  test "a check that cannot spawn, exits nonzero or times out gives no verdict" do
    assert {:unavailable, eagain} = Shuttle.Contract.check(EagainRunner)
    assert eagain =~ "could not run"
    assert eagain =~ "eagain"

    assert {:unavailable, unknown} = Shuttle.Contract.check(UnknownCommandRunner)
    assert unknown =~ "exited 1"

    assert {:unavailable, timeout} = Shuttle.Contract.check(TimeoutRunner)
    assert timeout =~ ":timeout"
    assert_received {:timeout_ms, ms} when is_integer(ms) and ms < 60_000
  end

  test "a check that could not run keeps the previous verdict and says why" do
    level = Shuttle.Contract.expected_level()

    unchecked = Shuttle.Contract.refresh(Shuttle.Contract.unchecked(), EagainRunner)
    assert %{ok: true, observed: nil, reason: nil, error: error} = unchecked
    assert error =~ "eagain"

    matched = Shuttle.Contract.refresh(unchecked, MatchRunner)
    assert matched == %{expected: level, observed: level, ok: true, reason: nil, error: nil}

    skewed = Shuttle.Contract.refresh(matched, LevelRunner)
    assert %{ok: false, observed: 14, error: nil} = skewed

    held = Shuttle.Contract.refresh(skewed, EagainRunner)
    assert %{held | error: nil} == skewed
    assert held.error =~ "eagain"

    assert Shuttle.Contract.refresh(held, MatchRunner) == matched
  end
end
