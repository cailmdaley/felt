defmodule ShuttleWeb.Endpoint do
  @moduledoc """
  Phoenix endpoint serving the daemon's HTTP API and the static UI bundle.

  The UI HTTP-polls — there is no WebSocket/Channel transport.
  """

  use Phoenix.Endpoint, otp_app: :shuttle

  plug Plug.RequestId
  plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]

  # Serve the built Shuttle UI bundle so the daemon is one process (API + UI).
  # `only:` restricts to the bundle's first-segment dirs/files, so `/api/*`,
  # `/socket`, and the bare `/` fall through to the router (which serves
  # `index.html` via SpaController). A missing bundle just 404s the asset — the
  # API stays fully usable.
  #
  # The list must name every file the bundle emits at the top level, or the
  # daemon refuses to serve a file it ships: `shuttle-icon.png` is requested
  # twice by index.html (rel=icon, rel=apple-touch-icon) and 404'd in production
  # until it was named here. Dev hides this — vite serves `public/` unfiltered.
  #
  # It is coupled to a non-obvious fact: vite's `base: ''` makes dist/index.html
  # reference `./shuttle-icon.png` RELATIVELY, which resolves to the first path
  # segment only because the board is served solely at `/`. Add a catch-all SPA
  # route for client-side subpaths and the relative href resolves under that
  # subpath, missing this allowlist again.
  plug Plug.Static,
    at: "/",
    from: ShuttleWeb.Assets.dist(),
    only: ~w(assets fonts index.html paper.html favicon.ico shuttle-icon.png)

  plug Plug.Parsers,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Phoenix.json_library()

  plug ShuttleWeb.CORSPlug
  plug Plug.MethodOverride
  plug Plug.Head
  plug ShuttleWeb.Router
end
