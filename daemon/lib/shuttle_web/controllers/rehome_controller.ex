defmodule ShuttleWeb.RehomeController do
  @moduledoc """
  `POST /api/v1/rehome`: move a constitution to another host in the fleet.

  Delegates to `Shuttle.Rehome.handle/1`, which takes over on `target_host`
  authoritatively first (carrying the fiber document if needed and validating
  `project_dir` on the destination) and then releases `origin` best-effort
  (stopping any live worker and dropping its Rex place). Succeeds gracefully
  even when the previous host is down or unreachable.
  """

  use Phoenix.Controller, formats: [:json]

  def create(conn, params) do
    case Shuttle.Rehome.handle(params) do
      {:ok, body} ->
        json(conn, body)

      {:error, status, body} ->
        conn |> put_status(status) |> json(body)
    end
  end
end
