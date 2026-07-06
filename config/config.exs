import Config

# NOTE: escript boot does NOT load this compile-time config (see
# Shuttle.Application.start/2, which also sets the DB at runtime). This line
# covers Mix/test contexts; the runtime call covers the daemon escript.
config :elixir, :time_zone_database, Tz.TimeZoneDatabase

config :shuttle,
  env: config_env(),
  # `:host` is intentionally left unset here. Per-daemon identity resolves at
  # runtime in `Shuttle.Poller.resolve_own_host_id/0`: SHUTTLE_HOST env var →
  # explicit app config (e.g. config/test.exs) → :inet.gethostname() →
  # "local". The historical literal "local" default was a no-op filter that
  # let remote and local daemons fight over the same fibers.
  start_poller: true,
  # `:boot_quarantine` is intentionally left unset here: the default (true —
  # restart is not dispatch authority) lives in one place,
  # Shuttle.Poller's @default_boot_quarantine. Set the key only to override
  # (config/test.exs sets false so dispatch tests exercise the tick directly).
  start_remote_registry: true,
  # Sibling of the remote registry: polls each remote's owner-only `/fibers`
  # feed and caches it for the local daemon's composite cross-host board. Kept
  # separate so a slow/failing fiber feed never perturbs the health-probe
  # recovery cascade. See Shuttle.RemoteFiberRegistry.
  start_remote_fiber_registry: true,
  # Per-host snapshots from remote Shuttle daemons reachable via
  # SSH tunnels. Each entry: %{name: String, url: String,
  # poll_interval_ms: pos_integer (default 5000), request_timeout_ms:
  # pos_integer (default 2000), stale_multiplier: pos_integer (default
  # 4 ⇒ 20s grace at the 5s poll interval)}. Staleness is purely
  # time-since-last-success, so this grace is the hysteresis: 20s
  # tolerates a single 8s-timeout blip (and most double-blips) without
  # flashing the "waiting on <host>" badge, while still surfacing a
  # genuine outage within ~20s. Empty by default — local-only setups
  # pay nothing.
  #
  # Example, after running `felt shuttle tunnels install`:
  #
  #   remotes: [
  #     %{name: "candide", url: "http://localhost:4001"}
  #   ]
  remotes: []

config :shuttle, ShuttleWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [formats: [json: ShuttleWeb.ErrorJSON], layout: false],
  pubsub_server: Shuttle.PubSub

config :logger, :console,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

import_config "#{config_env()}.exs"
