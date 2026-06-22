defmodule ShuttleWeb.ReserveController do
  @moduledoc """
  Agent-API endpoint: POST /api/v1/reserve

  Requests a resource reservation (e.g. GPU slot on candide).
  First-come-first-served with expiration.
  """

  use Phoenix.Controller, formats: [:json]

  def create(conn, params) do
    resource = Map.get(params, "resource")
    host = Map.get(params, "host", Shuttle.Poller.own_host_id())
    duration_ms = Map.get(params, "duration_ms", 3_600_000)
    fiber_id = Map.get(params, "fiber_id")

    if is_nil(resource) or is_nil(fiber_id) do
      conn
      |> put_status(400)
      |> json(%{error: "resource and fiber_id are required"})
    else
      case Shuttle.Poller.reserve_resource(resource, host, duration_ms, fiber_id) do
        {:ok, :reserved} ->
          json(conn, %{
            reserved: true,
            resource: resource,
            host: host,
            fiber_id: fiber_id,
            duration_ms: duration_ms
          })

        {:error, reason} ->
          conn
          |> put_status(409)
          |> json(%{reserved: false, reason: reason})
      end
    end
  end

end
