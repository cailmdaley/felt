defmodule Shuttle.Inbox.Corrupt do
  defexception [:message]
end

defmodule Shuttle.Inbox do
  @moduledoc "Boot import and durable thread capture policy owned by the inbox CLI."

  def boot_import do
    thread_state()
    :ok
  end

  def thread_state do
    case Shuttle.CLI.run(["inbox", "thread-state"],
           runner: Shuttle.Runner.Default,
           timeout_ms: 30_000
         ) do
      {:ok, output} -> Jason.decode!(output)
      error -> raise Shuttle.Inbox.Corrupt, "thread inbox import failed: #{inspect(error)}"
    end
  end
end
