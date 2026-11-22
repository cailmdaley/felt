defmodule ShuttleWeb.SpaController do
  @moduledoc """
  Serve the Shuttle board at `GET /` and the pages (`GET /thread`, `GET /desk`,
  `GET /map`) from the bundle's `pages.html`. Static assets (`/assets`, `/fonts`, …) are
  served by `Plug.Static` in the endpoint; this controller handles the page
  documents.

  When the bundle is not built (a fresh checkout that hasn't run `npm run
  build`), respond 404 with the build hint rather than 500 — the API is still
  fully usable; only the served frontend is missing.
  """

  use Phoenix.Controller, formats: [:html]

  def index(conn, _params), do: page(conn, "index.html")

  # Trailing slashes would resolve the bundle's relative assets under the segment.
  def pages(%Plug.Conn{request_path: path} = conn, _params)
      when path in ["/thread/", "/desk/", "/map/"] do
    query = if conn.query_string == "", do: "", else: "?" <> conn.query_string
    redirect(conn, to: String.trim_trailing(path, "/") <> query)
  end

  def pages(conn, _params), do: page(conn, "pages.html")

  defp page(conn, file) do
    path = Path.join(ShuttleWeb.Assets.dist(), file)

    if Shuttle.FS.regular?(path) do
      conn
      |> put_resp_content_type("text/html")
      |> send_file(200, path)
    else
      conn
      |> put_resp_content_type("text/plain")
      |> send_resp(404, "Shuttle UI bundle not built — run: cd ui && npm run build")
    end
  end
end
