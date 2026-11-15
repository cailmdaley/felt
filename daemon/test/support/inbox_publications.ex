defmodule Shuttle.Test.InboxPublications do
  @moduledoc "The routing inbox, read and written through the real inbox CLI."

  def pending do
    {:ok, output} =
      Shuttle.CLI.run(["inbox", "routes"],
        runner: Shuttle.Runner.Default,
        stderr_to_stdout: false
      )

    for row <- Jason.decode!(output), do: {row["id"], row["record"]}
  end

  def capture(records) do
    input = Jason.encode!(for {id, record} <- records, do: %{id: id, record: record})

    {:ok, _} =
      Shuttle.CLI.run(["inbox", "thread-put"],
        runner: Shuttle.Runner.Default,
        input: input,
        input_eof: true
      )

    :ok
  end

  def settle(id) do
    {:ok, _} =
      Shuttle.CLI.run(["inbox", "settle", id, "forwarded"], runner: Shuttle.Runner.Default)

    :ok
  end

  def baseline do
    {:ok, output} =
      Shuttle.CLI.run(["inbox", "thread-state"],
        runner: Shuttle.Runner.Default,
        stderr_to_stdout: false
      )

    Jason.decode!(output)["baseline"]
  end

  @doc "The routing inbox's directory under `data`."
  def routing_dir(data) do
    Path.join([
      data,
      "mailboxes",
      "fiber",
      :crypto.hash(:sha256, "threads") |> Base.encode16(case: :lower)
    ])
  end
end
