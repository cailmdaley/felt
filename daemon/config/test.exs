import Config

config :shuttle,
  start_poller: false,
  # Tests boot pollers constantly; quarantining every one would park the very
  # dispatches the suite asserts on. Quarantine tests pass `boot_quarantine:
  # true` to Poller.start_link explicitly.
  boot_quarantine: false,
  # Same discipline: the event stream is started explicitly by the tests that
  # exercise it, against a tmp fixture rather than the developer's stream.
  start_event_stream: false,
  # Left off in the suite so no test run can copytruncate the developer's real
  # ~/Library/Logs/shuttle.log. log_rotator_test starts its own against tmp_dir.
  start_log_rotator: false,
  # Discovery would read this machine's real tailnet; the suite drives
  # Shuttle.TailnetPeers with injected status and probes instead.
  start_tailnet_peers: false,
  start_tailnet_dial: false,
  start_remote_registry: false,
  start_remote_fiber_registry: false,
  start_remote_temporal_registry: false,
  remotes: [],
  # The same shield one level down: `false` means "explicitly no proxy", so no
  # test can pick up the developer's real fleet proxy and try to CONNECT
  # through it.
  https_proxy: false,
  # And the same for the userspace tailscaled socket under $HOME: no test may
  # dial through the developer's real LocalAPI by default.
  tailscale_home: false,
  tailnet_dial_test_cacerts_enabled: true

# Test daemon identity. Application start freezes SHUTTLE_HOST when it is set
# and asks `shuttle host --json` otherwise, so pinning it keeps the suite
# independent of the operator's host config and stable across machines. Nothing is pinned at
# the Application config layer, where a value would ride into any artifact
# built with MIX_ENV=test. Tests that exercise host-pin matching pass explicit
# `own_host_id:` opts to `Poller.start_link`.
System.put_env("SHUTTLE_HOST", "test-host")

# Fence the test run away from the developer's real ~/.shuttle/host. Shuttle's
# hostname tier seeds that file, and the identity tests clear SHUTTLE_HOST —
# so without a pinned path, a Shuttle process from any concurrent test could
# rewrite this machine's canonical identity. This only has to be somewhere
# harmless.
System.put_env(
  "SHUTTLE_HOST_FILE",
  Path.join(System.tmp_dir!(), "shuttle-test-host-#{System.unique_integer([:positive])}")
)

config :shuttle, ShuttleWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "testsecretkeybasetestsecretkeybasetestsecretkeybasetestsecretkeybase",
  server: false

# Keep the developer's ~/.config/shuttle/host.json and SHUTTLE_LISTEN out of the
# suite: an absent file is a single-user host, so the test endpoint resolves
# to tcp://127.0.0.1:4002 on every machine. Host tests point SHUTTLE_HOST_CONFIG_FILE at
# their own files.
System.put_env(
  "SHUTTLE_HOST_CONFIG_FILE",
  Path.join(
    System.tmp_dir!(),
    "shuttle-test-host-json-#{System.unique_integer([:positive])}.json"
  )
)

System.delete_env("SHUTTLE_LISTEN")
