defmodule Shuttle.Test.RecordingRunner do
  @moduledoc """
  Records every CLI invocation and returns success — lets the writer tests
  assert the daemon shells the right `shuttle mark-runtime` command without
  executing either CLI.

  ExUnit supervises the globally named Agent and waits for its shutdown before
  the next test starts. Use it only from non-async tests.
  """

  @behaviour Shuttle.Runner

  def start do
    ExUnit.Callbacks.start_supervised(%{
      id: __MODULE__,
      start: {Agent, :start_link, [fn -> [] end, [name: __MODULE__]]}
    })
  end

  @impl true
  def cmd(command, args, opts) do
    Agent.update(__MODULE__, &(&1 ++ [{command, args, opts}]))
    {"", 0}
  end

  def calls, do: Agent.get(__MODULE__, & &1)
end
