defmodule ShuttleWeb.Endpoint do
  @moduledoc """
  Phoenix endpoint serving the daemon's HTTP API and the static UI bundle.

  The UI HTTP-polls — there is no WebSocket/Channel transport.
  """

  use Phoenix.Endpoint, otp_app: :shuttle

  # Wrap Phoenix's error boundary as well as the ordinary endpoint pipeline.
  @before_compile ShuttleWeb.FileSecurityPlug

  plug(Plug.RequestId)
  # Per-request lines at debug: every board and hub polls several routes a
  # second, so at info they would be most of the log. Failures log themselves
  # (the peer gate's refusals, crash reports).
  plug(Plug.Telemetry, event_prefix: [:phoenix, :endpoint], log: :debug)
  plug(ShuttleWeb.PeerPlug)
  plug(ShuttleWeb.PeerGatePlug)

  # Serve the built Shuttle UI bundle so the daemon is one process (API + UI).
  # `only:` restricts to the bundle's first-segment dirs/files, so `/api/*`
  # and the bare `/` fall through to the router (which serves
  # `index.html` via SpaController). A missing bundle just 404s the asset — the
  # API stays fully usable.
  #
  # The build writes `.br` and `.gz` beside each compressible file, served to
  # clients that accept them. Every name under `assets/` carries its content
  # hash, so a browser keeps those for a year without asking again; the
  # unhashed files keep the default etag revalidation.
  plug(Plug.Static,
    at: "/",
    # MFA form: resolved per request, so the bundle location is a RUNTIME
    # decision (env override / release priv / checkout — see ShuttleWeb.Assets)
    # rather than a path baked at compile time on the build machine.
    from: {ShuttleWeb.Assets, :dist, []},
    only: ~w(assets),
    brotli: true,
    gzip: true,
    cache_control_for_etags: "public, max-age=31536000, immutable"
  )

  plug(Plug.Static,
    at: "/",
    from: {ShuttleWeb.Assets, :dist, []},
    only: ~w(fonts index.html favicon.ico apple-touch-icon.png manifest.webmanifest),
    brotli: true,
    gzip: true
  )

  # CORS must run before readiness can send a booting 503, so cross-origin
  # board clients receive the daemon's real status instead of a browser CORS
  # failure. Static assets above have already short-circuited this plug stack.
  plug(ShuttleWeb.CORSPlug)
  plug(ShuttleWeb.ReadinessPlug)

  # File-bearing routes get larger, route-specific JSON ceilings.
  # Plug.Parsers leaves an already-fetched body alone, so the ordinary parser
  # below retains its default 8 MB limit for every other endpoint.
  plug(ShuttleWeb.LargeBodyParser)

  plug(Plug.Parsers,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Phoenix.json_library()
  )

  plug(Plug.Head)
  plug(ShuttleWeb.Router)
end
