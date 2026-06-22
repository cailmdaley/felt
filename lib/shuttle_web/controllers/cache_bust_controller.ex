defmodule ShuttleWeb.CacheBustController do
  @moduledoc """
  Agent-API endpoint: POST /api/v1/cache/bust

  Evicts a fiber's resolved felt-store from the Poller's cache. Use after
  a fiber moves between configured hosts.

  Request body: %{"fiber_id" => string}
  Returns:      200  %{ok: true, fiber_id: string}
                400  %{error: "fiber_id required"}
  """

  use Phoenix.Controller, formats: [:json]

  def create(conn, %{"fiber_id" => fiber_id}) when is_binary(fiber_id) and fiber_id != "" do
    :ok = Shuttle.Poller.bust_fiber_host_cache(fiber_id)
    json(conn, %{ok: true, fiber_id: fiber_id})
  end

  def create(conn, _params) do
    conn
    |> put_status(400)
    |> json(%{error: "fiber_id required"})
  end
end
