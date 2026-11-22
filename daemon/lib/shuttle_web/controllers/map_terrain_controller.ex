defmodule ShuttleWeb.MapTerrainController do
  @moduledoc """
  `GET /api/v1/map/terrain` — serves the filtered Fleet Map terrain graph
  (`Shuttle.MapTerrain`).
  """

  use Phoenix.Controller, formats: [:json]

  def show(conn, _params) do
    case Shuttle.MapTerrain.fetch() do
      {:ok, payload} ->
        json(conn, payload)

      {:error, reason} ->
        conn
        |> put_status(:service_unavailable)
        |> json(%{error: "map_terrain_failed", reason: inspect(reason)})
    end
  end
end
