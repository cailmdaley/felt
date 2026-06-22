defmodule ShuttleWeb.FiberHostController do
  @moduledoc """
  Agent-API endpoint: GET /api/v1/fiber/host?id=<fiber_id>

  Resolves the felt store for a fiber. Since fiber IDs contain slashes, the
  fiber ID is passed as a query parameter rather than a path segment.

  Used by external callers so they can route their own felt operations to the
  right index without re-implementing resolution.

  Returns:
    200  %{fiber_id: string, felt_store: string, resolved_at: iso8601}
    404  %{error: string, fiber_id: string}  — not found in any configured host
    400  %{error: string}                    — missing id parameter
  """

  use Phoenix.Controller, formats: [:json]

  def show(conn, %{"id" => fiber_id}) when is_binary(fiber_id) and fiber_id != "" do
    case Shuttle.Poller.resolve_fiber_host(fiber_id) do
      {:ok, host} ->
        json(conn, %{
          fiber_id: fiber_id,
          felt_store: host,
          resolved_at: DateTime.to_iso8601(DateTime.utc_now())
        })

      {:error, :not_found} ->
        conn
        |> put_status(404)
        |> json(%{
          error: "fiber not found in any configured felt store",
          fiber_id: fiber_id
        })
    end
  end

  def show(conn, _params) do
    conn
    |> put_status(400)
    |> json(%{error: "id query parameter is required"})
  end
end
