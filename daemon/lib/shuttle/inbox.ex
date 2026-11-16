defmodule Shuttle.Inbox.Corrupt do
  defexception [:message]
end

defmodule Shuttle.Inbox do
  @moduledoc """
  The boot step for thread capture: `shuttle inbox thread-state` establishes
  the capture window's baseline. A corrupt capture state (the CLI's exit
  status 3) raises `Shuttle.Inbox.Corrupt`, which holds boot; any other
  failure, a timeout included, raises a retryable error.
  """

  @corrupt 3
  # The step's own bound, apart from the shelled-command default. A timeout
  # retries.
  @timeout_ms 120_000

  def boot_baseline do
    case Shuttle.CLI.run(["inbox", "thread-state"],
           runner: Shuttle.Runner.Default,
           timeout_ms: @timeout_ms
         ) do
      {:ok, _} -> :ok
      {:command_error, @corrupt, output} -> raise Shuttle.Inbox.Corrupt, String.trim(output)
      error -> raise "thread capture baseline failed: #{inspect(error)}"
    end
  end
end
