defmodule ShuttleWeb.AgentsController do
  @moduledoc """
  Agent-API endpoint: GET /api/v1/agents

  Returns the agent registry as a JSON array by shelling `felt shuttle agents
  --json` — felt owns the registry now; the daemon no longer embeds it. External
  consumers (the board's agent picker) fetch this instead of reading any
  registry file off disk.

  felt unavailable / unparseable degrades to an empty array with a 200 rather
  than a 500: the picker tolerates an empty list (it falls back to a free-text
  agent name) and the rest of the board must keep loading.
  """

  use Phoenix.Controller, formats: [:json]

  require Logger

  def show(conn, _params) do
    json(conn, list_agents())
  end

  defp list_agents do
    with {:ok, output} <- Shuttle.Felt.run(["shuttle", "agents", "--json"]),
         {:ok, records} when is_list(records) <- Jason.decode(output) do
      records
    else
      error ->
        Logger.warning("GET /api/v1/agents: felt shuttle agents failed: #{inspect(error)}")
        []
    end
  end
end
