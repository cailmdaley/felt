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
  A pending record the routing inbox can never accept is logged and skipped,
  and a failure to clean up an imported outbox is logged; boot goes on.
  """

  require Logger

  @corrupt 3
  # The import's own bound, apart from the shelled-command default. A timeout
  # retries, and each attempt keeps the durable progress of the one before.
  @timeout_ms 120_000

  def boot_import do
    case Shuttle.CLI.run(["inbox", "thread-state"],
           runner: Shuttle.Runner.Default,
           timeout_ms: @timeout_ms
         ) do
      {:ok, output} -> log_report(output)
      {:command_error, @corrupt, output} -> raise Shuttle.Inbox.Corrupt, String.trim(output)
      error -> raise "thread inbox import failed: #{inspect(error)}"
    end
  end

  defp log_report(output) do
    report =
      case Jason.decode(output) do
        {:ok, report} when is_map(report) -> report
        _ -> %{}
      end

    for %{"id" => id, "error" => error} <- report["skipped"] || [],
        do: Logger.warning("Thread outbox import skipped #{id}: #{error}")

    with error when is_binary(error) <- report["cleanup_error"],
         do: Logger.warning("Removing the imported thread outbox failed: #{error}")

    :ok
  end
end
