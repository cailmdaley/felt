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
  start_remote_registry: true,
  # Sibling of the remote registry: polls each remote's owner-only `/fibers`
  # feed and caches it for the local daemon's composite cross-host board. Kept
  # separate so a slow/failing fiber feed never perturbs the health-probe
  # recovery cascade. See Shuttle.RemoteFiberRegistry.
  start_remote_fiber_registry: true,
  # Per-host periodic publish-only loom git-sync (Shuttle.LoomSync). Keeps an
  # idle host's loom from freezing — it stopped pulling once Stop/SessionEnd
  # hooks were the only trigger. Interval/script via SHUTTLE_LOOM_SYNC_* env.
  start_loom_sync: true,
  # Per-host snapshots from remote Shuttle daemons reachable via
  # SSH tunnels. Each entry: %{name: String, url: String,
  # poll_interval_ms: pos_integer (default 5000), request_timeout_ms:
  # pos_integer (default 2000), stale_multiplier: pos_integer (default
  # 2)}. Empty by default — local-only setups pay nothing.
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
