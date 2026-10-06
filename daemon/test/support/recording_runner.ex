defmodule Shuttle.Test.RecordingRunner do
  @moduledoc """
  Records every CLI invocation and returns success — lets the writer tests
  assert the daemon shells the right `shuttle mark-runtime` command without
  executing either CLI.

  One Agent per test, registered in the test's scope (`Shuttle.Test.Env`), so
  the processes acting for the test record into the same list.
  """

  @behaviour Shuttle.Runner

  def start do
    pid =
      Shuttle.Test.Env.start_scoped!(
        %{id: __MODULE__, start: {Agent, :start_link, [fn -> [] end]}},
        __MODULE__
      )

    {:ok, pid}
  end

  @impl true
  def cmd(command, args, opts) do
    Agent.update(server(), &(&1 ++ [{command, args, opts}]))
    {"", 0}
  end

  def calls, do: Agent.get(server(), & &1)

  defp server, do: Shuttle.Test.Env.server!(__MODULE__)
end
