# Pin the agent registry for the whole suite: keep it off whatever
# ~/.config/shuttle/agents.json the developer has. The fixture carries the same
# records as the built-in layer, so the effective registry is the shipped one.
System.put_env("SHUTTLE_AGENTS_FILE", Path.expand("fixtures/agents.json", __DIR__))

# Pin the remote fleet the same way: an absent file means no remotes and all
# defaults. Without this pin, any developer whose ~/.config/shuttle/remotes.json
# sets fleet-wide options (e.g. `launchd_label_prefix`) fails the label
# assertions in RemoteRegistryTest. Tests that want a fleet write their own
# file and set SHUTTLE_REMOTES_FILE themselves.
System.put_env("SHUTTLE_REMOTES_FILE", Path.expand("fixtures/remotes/absent.json", __DIR__))

# Pin the store registry away from the developer's real one: a fresh tmp
# path and no SHUTTLE_STORES mean no configured stores. Without this pin, a
# dispatch that names no store resolves the developer's real
# ~/.config/shuttle/stores.json and walks that tree for symlinked substores,
# which takes seconds on a large store, on the caller's process. Tests that
# want configured stores set SHUTTLE_STORES or SHUTTLE_STORES_FILE.
System.delete_env("SHUTTLE_STORES")

stores_file =
  Path.join(System.tmp_dir!(), "shuttle-test-stores-#{System.system_time(:nanosecond)}.json")

System.put_env("SHUTTLE_STORES_FILE", stores_file)

# Pin the session ledger away from the developer's real ~/.shuttle. The
# dispatch and claim paths append to it unconditionally, so without this the
# suite would write junk pairings into the machine's actual ledger. Tests that
# assert on ledger contents set their own SHUTTLE_SESSIONS_FILE.
System.put_env(
  "SHUTTLE_SESSIONS_FILE",
  Path.join(System.tmp_dir!(), "shuttle-test-sessions-#{System.system_time(:nanosecond)}.jsonl")
)

# Where test Pollers write the daemon's own liveness heartbeat unless a test
# passes `daemon_heartbeat_file:` itself: away from the real ~/.shuttle, for the
# same reason as the session ledger (every Poller boot writes it). The daemon
# derives the path from SHUTTLE_DATA_DIR alone, so test Pollers get it as an
# opt (`Shuttle.Test.PollerHelpers.start_poller!/1`).
Application.put_env(
  :shuttle,
  :test_daemon_heartbeat_file,
  Path.join(System.tmp_dir!(), "shuttle-test-heartbeat-#{System.system_time(:nanosecond)}.json")
)

Application.put_env(
  :shuttle,
  :app_workers_dir,
  Path.join(System.tmp_dir!(), "shuttle-test-app-workers-#{System.system_time(:nanosecond)}")
)

exclude = if :os.type() == {:unix, :linux}, do: [:integration], else: [:integration, :linux]
ExUnit.start(exclude: exclude)

# A test that saves stores without its own SHUTTLE_STORES_FILE writes the
# suite-wide registry; remove it with the run.
ExUnit.after_suite(fn _ -> File.rm(stores_file) end)
