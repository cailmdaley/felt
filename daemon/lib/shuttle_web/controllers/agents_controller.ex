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

  **Owner-routed via `Shuttle.OriginRouter`** on `?origin=`. The registry is a
  per-host fact — the built-in layer travels with that host's felt binary and
  the user layer is a file in its home — so "which agents can this host run"
  can only be answered by that host. Without an origin it is this daemon's own
  registry, which is every existing caller's question.
  """

  use Phoenix.Controller, formats: [:json]

  import ShuttleWeb.RelayHelpers, only: [relay_bytes: 2]

  alias Shuttle.OriginRouter

  require Logger

  def show(conn, params) do
    case OriginRouter.route_host(Map.get(params, "origin")) do
      {:remote, remote} ->
        relay_bytes(conn, OriginRouter.forward_get(remote, "/api/v1/agents", params))

      :local ->
        json(conn, list_agents())

      # A registry is a per-host fact, so an origin this daemon cannot place has
      # no answer here. Degrading would serve THIS host's agents under another
      # machine's name, which is worse than an error on a picker.
      {:error, {:unknown_origin, origin}} ->
        conn |> put_status(400) |> json(%{error: OriginRouter.unknown_origin_message(origin)})
    end
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
