defmodule Shuttle.Test.InboxPublications do
  @moduledoc "Thread fixtures read and written through the real inbox CLI."

  def pending(owner) do
    {:ok, output} = Shuttle.CLI.run(["inbox", "routes", owner], runner: Shuttle.Runner.Default)
    for row <- Jason.decode!(output), do: {row["id"], Map.delete(row["record"], "inbox_address")}
  end

  def capture(records) do
    for {id, record} <- records do
      {:ok, _} =
        Shuttle.CLI.run(["inbox", "thread-put", id, Jason.encode!(record)],
          runner: Shuttle.Runner.Default
        )
    end

    :ok
  end

  def settle(owner, id) do
    {:ok, output} = Shuttle.CLI.run(["inbox", "routes", owner], runner: Shuttle.Runner.Default)
    row = Enum.find(Jason.decode!(output), &(&1["id"] == id))

    {:ok, _} =
      Shuttle.CLI.run(["inbox", "settle", row["address"], id, "forwarded"],
        runner: Shuttle.Runner.Default
      )

    :ok
  end
end
