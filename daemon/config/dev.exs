import Config

# The daemon's HTTP surface.
#
# Port and secret resolve at RUNTIME in `Shuttle.Application.configure_endpoint/0`,
# not here: a build bakes the EVALUATED config into the artifact (config/prod.exs
# → the release's sys.config), so anything machine-specific decided in a config
# file travels with the artifact to every host it lands on. This file keeps the
# same discipline as its prod sibling.
#
# The remote fleet is not configured here at all. It lives in
# `~/.config/felt/remotes.json` and is read at runtime by `Shuttle.Remotes` —
# the same file `felt shuttle remotes` edits and `felt shuttle tunnels` installs
# from.
config :shuttle, ShuttleWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}],
  check_origin: false,
  code_reloader: false,
  # Required for the daemon to actually bind the TCP port.
  # Phoenix won't start the HTTP server without this explicit flag.
  server: true
