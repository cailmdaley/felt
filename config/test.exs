import Config

config :shuttle,
  env: :test,
  start_poller: false,
  # Tests boot pollers constantly; quarantining every one would park the very
  # dispatches the suite asserts on. Quarantine tests pass `boot_quarantine:
  # true` to Poller.start_link explicitly.
  boot_quarantine: false,
  start_waiting_tracker: false,
  start_remote_registry: false,
  start_remote_fiber_registry: false,
  remotes: []

# Test daemon identity. Resolved at Poller boot via SHUTTLE_HOST → the
# real :inet.gethostname(). We don't pin it here at the Application
# config layer any more — the previous pin (host: "local") leaked into
# escripts built with MIX_ENV=test and stamped "local" onto production
# daemons, then every fiber without an explicit host: silently failed
# the dispatch filter. Setting SHUTTLE_HOST during the test run keeps
# tests stable across machines without writing the value into the
# release artifact. Tests that need to exercise host-pin matching also
# pass explicit `own_host_id:` opts to `Poller.start_link`.
System.put_env("SHUTTLE_HOST", "test-host")

config :shuttle, ShuttleWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "testsecretkeybasetestsecretkeybasetestsecretkeybasetestsecretkeybase",
  server: false
