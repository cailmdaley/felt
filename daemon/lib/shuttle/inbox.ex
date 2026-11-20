defmodule Shuttle.Inbox.Corrupt do
  defexception [:message]
end

defmodule Shuttle.Inbox do
  @moduledoc """
  The inbox's boot steps. `shuttle inbox thread-state` establishes the thread
  capture window's baseline: a corrupt capture state (the CLI's exit status 3)
  raises `Shuttle.Inbox.Corrupt`, which holds boot; any other failure, a
  timeout included, raises a retryable error. `rekey/1` moves store-keyed
  fiber inboxes to their uid keys.
  """

  require Logger

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

  @doc """
  Moves every fiber inbox still keyed by a store's path to its `fiber:<uid>`
  key (`shuttle inbox rekey`), before boot recovery reads any receiver. A
  failure is logged and boot goes on: the inboxes it left stay where they were.
  """
  def rekey([]), do: :ok

  def rekey(stores) do
    case Shuttle.CLI.run(["inbox", "rekey" | stores], timeout_ms: @timeout_ms) do
      {:ok, output} ->
        case String.trim(output) do
          "0" -> :ok
          n -> Logger.info("Moved #{n} store-keyed fiber inboxes to their uid keys")
        end

      error ->
        Logger.warning("fiber inbox rekey failed: #{inspect(error)}")
    end

    :ok
  end
end
