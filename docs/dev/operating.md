# Operating and debugging the daemon

## Quick start — operating without rebuilding

```bash
bin/shuttle snapshot                          # JSON snapshot of daemon state
bin/shuttle dispatch <fiber-id>               # one-shot dispatch
bin/shuttle release                           # release the boot quarantine (parked launches dispatch next tick)
bin/shuttle reset <remote>                    # reset a tripped remote circuit breaker (revive cascade resumes)

# felt shuttle — agent-facing CLI; offline; schema-validating
felt shuttle status                            # all fibers with shuttle: blocks
felt shuttle status --all                      # local + every configured remote
felt shuttle status --remote <name>            # single remote
felt shuttle ps                                # live tmux workers only
felt shuttle install <fiber> --project-dir "$PWD" [-m <agent-id>] [--disabled]
felt shuttle repeat <fiber> --schedule "0 9 * * 1-5" --tz Europe/Paris --project-dir "$PWD"
felt shuttle pin <fiber> --project-dir "$PWD"    # pinned, schedule-less perennial role
felt shuttle reshape <fiber> [kind] [-s <schedule>] [-z <tz>]  # change an existing block's kind/schedule in place
felt shuttle pause <fiber>                       # park in drafts + kill live worker; --no-kill preserves it
felt shuttle resume / accept / reopen <fiber>
felt shuttle set-agent <fiber> <agent-id> [--effort E] [--chrome]
felt shuttle dispatch <fiber>
felt shuttle handoff <fiber>                     # worker's clean-exit ritual: stamp
                                                #   shuttle.runtime.handed_off_at (→ next
                                                #   is fresh) + end own tmux session. The
                                                #   single final action; folds in kill $PPID.
felt shuttle snapshot
felt shuttle abort / attach <fiber>
felt shuttle validate-identity                # UID migration/cross-city validation
felt setup receipt --json                     # loaded plugins/skills/hooks/binary + daemon contract
```

## Inspecting state

```bash
felt shuttle status                      # offline walker view (independent of daemon)
bin/shuttle snapshot                     # raw JSON snapshot
make status                              # daemon-side view (ps + snapshot)
make logs                                # daemon stdout/stderr — ~/Library/Logs/shuttle.log
                                         # (macOS) / ~/.shuttle/shuttle.log (Linux)
tmux ls | grep '^shuttle-'               # live workers
curl -s http://127.0.0.1:4000/api/v1/agents | jq
curl -s http://127.0.0.1:4000/api/v1/state | jq
curl -s http://127.0.0.1:4000/api/v1/state/composite | jq
felt setup receipt --json | jq
felt shuttle validate-identity                # checks :4000/:4001/:4002/:4003 by default
```

Dispatch sanity ladder:

1. `felt shuttle status` shows the fiber with `KIND oneshot` and an
   active/idle state? → fiber is well-formed and the offline walker sees it.
2. `bin/shuttle snapshot` lists it under `eligible[]`? → daemon dispatched.
3. Fiber is `active` but sitting in `pending_launch`? → the daemon restarted
   and the boot quarantine is armed. `bin/shuttle release`. Check this before
   reaching for `make restart` — a restart *re-arms* the quarantine.
4. `felt shuttle` sees it but daemon doesn't → daemon binary is stale.
   `make restart` (then `bin/shuttle release`).
5. Daemon sees it but agent never appears → check the resolved agent's `cli`
   (`felt shuttle agents`) and that the wrapper is on `PATH`.

**"The terminal opens and closes instantly", or the card never moves and no
session exists.** The daemon preflights the resolved agent's wrapper before it
spawns anything: it probes `bash -lc 'type -t <wrapper>'`, because the run
script itself executes under `bash -l`. A wrapper that resolves to nothing
there — never installed, or a shell function your *zsh/fish* config defines and
your bash login profile does not — aborts the dispatch instead of spawning a
session that dies in under a second. The refusal names the wrapper and the fix
in the daemon log, in the snapshot's `blocked` row (so the board shows it), and
in the dispatch API's 422. A wrapper that exists only as a shell **alias** is
refused too — a non-interactive login bash does not expand aliases, so define it
as a function or an executable on `PATH`. (Which message you get for an alias
depends on your bash: 5.x reports `alias` and you get the alias-specific text;
3.2, still the system bash on macOS, exits non-zero instead and you get the
generic "did not resolve" text. Both refuse the dispatch.)

The same preflight refuses a fiber whose `project_dir` is not a directory on
this host — a checkout that lives on another machine. The autonomous path
already skipped those; this catches the force-dispatch path (Requeue,
drag-to-launch), which bypasses eligibility. After either refusal the daemon
parks that fiber for 5 minutes rather than re-probing a login shell every tick;
a force-dispatch skips the wait.

Every snapshot carries `poll_health`: `state` is `reading` or `idle`,
`stall_timeout_ms` is the configured watchdog bound (300 seconds by default),
and `stalls` plus `last_stalled_at` show whether a world read was reaped. Slow
store and remote discovery run in one supervised, unlinked task while the
poller continues serving its cached state. At the bound the task is killed, a
new cycle is scheduled, and any late token from the abandoned read is ignored.
Repeatedly increasing `stalls` means the daemon is alive but an input remains
wedged; inspect `~/.config/felt/stores.json` and remote tunnel health rather
than restarting the daemon to clear the symptom.
