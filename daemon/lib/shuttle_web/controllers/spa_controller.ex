defmodule ShuttleWeb.SpaController do
  @moduledoc """
  Serve the Shuttle UI's `index.html` at `GET /` — the single-page entry the
  daemon hosts so `shuttle` is one process yielding both the `:4000` API and its
  frontend. Static assets (`/assets`, `/fonts`, …) are served by `Plug.Static`
  in the endpoint; this only covers the bare-root document.

  When the bundle is not built (a fresh checkout that hasn't run `npm run
  build`), respond 404 with the build hint rather than 500 — the API is still
  fully usable; only the served frontend is missing.
  """

  use Phoenix.Controller, formats: [:html]

  def index(conn, _params) do
    index_path = Path.join(ShuttleWeb.Assets.dist(), "index.html")

    if File.regular?(index_path) do
      conn
      |> put_resp_content_type("text/html")
      |> send_file(200, index_path)
    else
      conn
      |> put_resp_content_type("text/plain")
      |> send_resp(404, "Shuttle UI bundle not built — run: cd ui && npm run build")
    end
  end
end
