defmodule ShuttleWeb.SpaController do
  @moduledoc """
  Serve the Shuttle UI's pages: `index.html` at `GET /`, the board, and
  `phone.html` at `GET /phone` — the entries the daemon hosts so `shuttle` is
  one process yielding both the `:4000` API and its frontend. Static assets
  (`/assets`, `/fonts`, …) are served by `Plug.Static` in the endpoint; this
  only covers the page documents.

  When the bundle is not built (a fresh checkout that hasn't run `npm run
  build`), respond 404 with the build hint rather than 500 — the API is still
  fully usable; only the served frontend is missing.
  """

  use Phoenix.Controller, formats: [:html]

  def index(conn, _params), do: page(conn, "index.html")

  @doc "The phone page, `GET /phone`: the bundle's second entry, `phone.html`."
  def phone(conn, _params), do: page(conn, "phone.html")

  defp page(conn, file) do
    path = Path.join(ShuttleWeb.Assets.dist(), file)

    if File.regular?(path) do
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
