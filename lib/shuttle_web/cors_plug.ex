defmodule ShuttleWeb.CORSPlug do
  @moduledoc """
  Hand-rolled CORS plug for the Shuttle API endpoints.

  The browser UI is served same-origin from :4000, so CORS only matters for
  the Vite dev server (and a legacy :3000 fallback) calling the daemon
  directly during development. Origin matching is allowlist-based on those
  localhost variants.

  Requests from non-allowed origins pass through without CORS headers
  (the browser will block them).

  OPTIONS preflight requests are answered immediately with 204 and halted
  so they never reach the router. CORS response headers are appended to
  all other requests from allowed origins.
  """

  @behaviour Plug

  import Plug.Conn

  @allowed_origins [
    # Dev server (Vite + legacy :3000 fallback).
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ]

  @allowed_methods "GET, POST, OPTIONS"
  @allowed_headers "Content-Type, Accept"
  @max_age "3600"

  @impl true
  def init(opts), do: opts

  @impl true
  def call(%Plug.Conn{method: "OPTIONS"} = conn, _opts) do
    conn
    |> put_cors_headers()
    |> send_resp(204, "")
    |> halt()
  end

  def call(conn, _opts) do
    put_cors_headers(conn)
  end

  defp put_cors_headers(conn) do
    origin = conn |> get_req_header("origin") |> List.first()

    if origin in @allowed_origins do
      conn
      |> put_resp_header("access-control-allow-origin", origin)
      |> put_resp_header("access-control-allow-methods", @allowed_methods)
      |> put_resp_header("access-control-allow-headers", @allowed_headers)
      |> put_resp_header("access-control-max-age", @max_age)
      |> put_resp_header("vary", "Origin")
    else
      conn
    end
  end
end
