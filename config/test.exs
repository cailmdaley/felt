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

# Fence the test run away from the developer's real ~/.shuttle/host. The
# hostname tier of `resolve_own_host_id/0` SEEDS that file, and the host tests
# clear SHUTTLE_HOST to exercise the lower tiers — so without a pinned path a
# resolve from any concurrent `async: true` test could rewrite this machine's
# canonical identity. Individual tests still override this with their own temp
# path; this only has to be somewhere harmless.
System.put_env(
  "SHUTTLE_HOST_FILE",
  Path.join(System.tmp_dir!(), "shuttle-test-host-#{System.unique_integer([:positive])}")
)

config :shuttle, ShuttleWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "testsecretkeybasetestsecretkeybasetestsecretkeybasetestsecretkeybase",
  server: false
