# Pin the agent registry for the whole suite: keep it off whatever
# ~/.config/felt/agents.json the developer has. The fixture carries the same
# records as the built-in layer, so the effective registry is the shipped one.
System.put_env("FELT_AGENTS_FILE", Path.expand("fixtures/agents.json", __DIR__))

# Pin the remote fleet the same way: an absent file means no remotes and all
# defaults. Without this pin, any developer whose ~/.config/felt/remotes.json
# sets fleet-wide options (e.g. `launchd_label_prefix`) fails the label
# assertions in RemoteRegistryTest. Tests that want a fleet write their own
# file and set FELT_REMOTES_FILE themselves.
System.put_env("FELT_REMOTES_FILE", Path.expand("fixtures/remotes/absent.json", __DIR__))

# Pin the session ledger away from the developer's real ~/.shuttle. The
# dispatch and claim paths append to it unconditionally, so without this the
# suite would write junk pairings into the machine's actual ledger. Tests that
# assert on ledger contents set their own SHUTTLE_SESSIONS_FILE.
System.put_env(
  "SHUTTLE_SESSIONS_FILE",
  Path.join(System.tmp_dir!(), "shuttle-test-sessions-#{System.system_time(:nanosecond)}.jsonl")
)

ExUnit.start(exclude: [:integration])
