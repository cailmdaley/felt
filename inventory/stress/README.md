# Daemon suite under CPU contention

`scripts/stress-daemon-tests.sh RUNS BURNERS [-- mix test args]` on an
11-core Mac, with other worktrees' suites also running (load average 30-90).
Each directory holds the script's summary (per-run seed, wall time, failure
count, and the per-test tally) and `failures.txt` (every failing run's seed
and failure blocks). Full run logs are not committed.

| dir | tree | runs × burners | scope | clean runs |
|---|---|---|---|---|
| `before/` | cc88f3a9 | 20 × 16 | whole suite | 15/20 |
| `after/` | 6fb38c03 | 20 × 16 | whole suite | 19/20 |
| `client-before/` | 6fb38c03 | 30 × 16 | `remote_registry_client_test.exs` | 30/30 |
| `client-after/` | 1e0a3655 | 30 × 16 | `remote_registry_client_test.exs` | 30/30 |

`after/`'s one failure (a 2 s httpc timeout in RemoteRegistry.ClientTest) is
fixed in 1e0a3655. Run alone, that file did not reproduce it before or after
the fix: it needs the whole suite's concurrency.
