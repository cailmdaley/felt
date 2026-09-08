defmodule Shuttle.Test.RecordingRunner do
  @moduledoc """
  Records every felt invocation and returns success — lets the writer tests
  assert the daemon shells the right `felt shuttle mark-runtime` command
  (Stage 5: felt owns the runtime nesting; the daemon's contract is the verb it
  issues) without running felt.

  Globally named, and `start/0` resets an already-running Agent, so use it only
  from NON-async tests.
  """

  @behaviour Shuttle.Runner

  def start do
    case Agent.start_link(fn -> [] end, name: __MODULE__) do
      {:ok, pid} -> {:ok, pid}
      {:error, {:already_started, pid}} -> Agent.update(pid, fn _ -> [] end) && {:ok, pid}
    end
  end

  @impl true
  def cmd(command, args, opts) do
    Agent.update(__MODULE__, &(&1 ++ [{command, args, opts}]))
    {"", 0}
  end

  def calls, do: Agent.get(__MODULE__, & &1)
end
