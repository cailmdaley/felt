import Config

config :shuttle,
  start_poller: false,
  # Tests boot pollers constantly; quarantining every one would park the very
  # dispatches the suite asserts on. Quarantine tests pass `boot_quarantine:
  # true` to Poller.start_link explicitly.
  boot_quarantine: false,
  start_waiting_tracker: false,
  start_remote_registry: false,
  start_remote_fiber_registry: false,
  start_remote_temporal_registry: false,
  remotes: []

# Test daemon identity. Resolved at Poller boot by
# `Shuttle.Poller.resolve_own_host_id/0`, which owns the precedence order. We
# don't pin `host:` at the Application config layer: the previous pin
# (host: "local") leaked into daemon artifacts built with MIX_ENV=test and
# stamped "local" onto production daemons, after which every fiber without an
# explicit host: silently failed the dispatch filter. Setting SHUTTLE_HOST for
# the test run keeps tests stable across machines without writing the value
# into the release artifact. Tests that exercise host-pin matching pass explicit
# `own_host_id:` opts to `Poller.start_link`.
System.put_env("SHUTTLE_HOST", "test-host")

config :shuttle, ShuttleWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "testsecretkeybasetestsecretkeybasetestsecretkeybasetestsecretkeybase",
  server: false
