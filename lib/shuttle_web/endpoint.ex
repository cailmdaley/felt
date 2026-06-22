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
  plug Plug.Static,
    at: "/",
    from: ShuttleWeb.Assets.dist(),
    only: ~w(assets fonts index.html paper.html favicon.ico)

  plug Plug.Parsers,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Phoenix.json_library()

  plug ShuttleWeb.CORSPlug
  plug Plug.MethodOverride
  plug Plug.Head
  plug ShuttleWeb.Router
end
