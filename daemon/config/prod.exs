import Config

# The release build environment. Values here are compile-time defaults only —
# everything machine-specific (port, secret, server flag) is resolved at boot
# by `Shuttle.Application.configure_endpoint/0`, exactly as in dev, so a
# release artifact built in CI carries nothing host-specific.
config :shuttle, ShuttleWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}],
  check_origin: false,
  code_reloader: false,
  # Required for the daemon to actually bind the TCP port.
  server: true
