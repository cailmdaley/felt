import Config

# NOTE: escript boot does NOT load this compile-time config (see
# Shuttle.Application.start/2, which also sets the DB at runtime). This line
# covers Mix/test contexts; the runtime call covers the daemon escript.
config :elixir, :time_zone_database, Tz.TimeZoneDatabase

config :shuttle,
  # `:host` is intentionally left unset here — the key is read nowhere. Each
  # daemon's identity resolves at runtime in
  # `Shuttle.Poller.resolve_own_host_id/0`, which documents the chain; there is
  # no app-config step and no `"local"` default, because a literal "local" is a
  # no-op filter that lets remote and local daemons fight over the same fibers.
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
  start_remote_fiber_registry: true

# `:remotes` is intentionally left unset here — the same move `:host` makes
# above, for the same reason. The remote fleet resolves at runtime through
# `Shuttle.Remotes.configured/0`: application config when set, else the
# operator's `~/.config/felt/remotes.json`, else none. An `unset` key is what
# lets the file speak; a `remotes: []` default here would shadow it on every
# host and silently reduce the hub to a local-only board.
#
# `[]` therefore means "explicitly no remotes" — which is exactly what
# config/test.exs sets, so the suite never reaches a real fleet file.

config :shuttle, ShuttleWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [formats: [json: ShuttleWeb.ErrorJSON], layout: false]

config :logger, :console,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

import_config "#{config_env()}.exs"
