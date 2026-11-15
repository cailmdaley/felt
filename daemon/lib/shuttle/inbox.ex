defmodule Shuttle.Inbox.Corrupt do
  defexception [:message]
end

defmodule Shuttle.Inbox do
  @moduledoc """
  The boot step for thread capture: `shuttle inbox thread-state` establishes
  the capture window and imports a thread outbox an older daemon left behind
  into the routing inbox. A corrupt outbox or state (the CLI's exit status 3)
  raises `Shuttle.Inbox.Corrupt`, which holds boot; any other failure,
  a timeout included, raises a retryable error, and the import repeats safely.
  """

  @corrupt 3
  # The import's own bound, apart from the shelled-command default. A timeout
  # retries, and each attempt keeps the durable progress of the one before.
  @timeout_ms 120_000

  def boot_import do
    case Shuttle.CLI.run(["inbox", "thread-state"],
           runner: Shuttle.Runner.Default,
           timeout_ms: @timeout_ms
         ) do
      {:ok, _} -> :ok
      {:command_error, @corrupt, output} -> raise Shuttle.Inbox.Corrupt, String.trim(output)
      error -> raise "thread inbox import failed: #{inspect(error)}"
    end
  end
end
