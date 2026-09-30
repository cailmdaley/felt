import Config

# Attachment bytes belong in the receiver's file store, never request logs.
config :phoenix, :filter_parameters, ["password", "attachments"]

# `Shuttle.Application.start/2` sets this again at runtime, so every boot path
# lands on the same DB; this line covers Mix/test contexts and the release's
# sys.config.
config :elixir, :time_zone_database, Tz.TimeZoneDatabase

# The :shuttle keys below are deliberately left unset here:
#
#   * `:host` — read nowhere. felt owns the identity chain
#     (cmd/shuttle_host.go); the daemon takes `SHUTTLE_HOST` or asks
#     `felt shuttle host --json` once at boot and freezes the answer
#     (`Shuttle.Poller.freeze_daemon_host_id!/1`). There is no app-config step
#     and no `"local"` default, because a literal "local" is a no-op filter
#     that lets remote and local daemons fight over the same fibers.
#   * `:boot_quarantine` — the default (true: restart is not dispatch
#     authority) lives in Shuttle.Poller's @default_boot_quarantine. Set the
#     key only to override (config/test.exs sets false so dispatch tests
#     exercise the tick directly).
#   * `:remotes` — the remote fleet resolves at runtime through
#     `Shuttle.Remotes.configured/0`: application config when set, else the
#     operator's `~/.config/shuttle/remotes.json`, else none. An unset key is
#     what lets the file speak; a `remotes: []` default here would shadow it
#     on every host and silently reduce the hub to a local-only board. `[]`
#     means "explicitly no remotes" — which is exactly what config/test.exs
#     sets, so the suite never reaches a real fleet file.
#   * the `start_*` child flags — each defaults to on in
#     `Shuttle.Application`; config/test.exs turns them off.

# Bandit keeps an HTTP/1 connection's process dictionary across keep-alive
# requests, which is where `ShuttleWeb.PeerPlug` remembers the connection's
# resolved peer uid (one /proc/net/tcp read per connection, not per request).
config :shuttle, ShuttleWeb.Endpoint,
  http: [http_1_options: [clear_process_dict: false]],
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [formats: [json: ShuttleWeb.ErrorJSON], layout: false]

config :logger, :console,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

import_config "#{config_env()}.exs"
