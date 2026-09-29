# Operating and debugging the daemon

## Quick start — operating without rebuilding

```bash
# bin/shuttle — daemon lifecycle
bin/shuttle status                            # state JSON (a version receipt while booting); exit 2 when down
bin/shuttle release                           # release the boot quarantine (parked launches dispatch next tick)
bin/shuttle reset <remote>                    # reset a tripped remote circuit breaker (revive cascade resumes)

# felt shuttle — agent-facing CLI; schema-validating
felt shuttle status                            # fibers with shuttle: blocks (closed hidden; --closed)
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
felt shuttle snapshot                            # the daemon's state snapshot
felt shuttle dispatch <fiber> [--ad-hoc]         # dispatch now
felt shuttle handoff <fiber>                     # worker's clean-exit ritual: stamp
                                                #   shuttle.runtime.handed_off_at (→ next
                                                #   is fresh) + end own tmux session. The
                                                #   single final action; folds in kill $PPID.
felt shuttle attach <fiber>
felt shuttle validate-identity                # fiber UID invariants across daemon feeds
felt setup receipt --json                     # loaded plugins/skills/hooks/binary + daemon contract
```

## Inspecting state

```bash
felt shuttle status                      # offline walker view (independent of daemon)
felt shuttle snapshot                    # raw JSON snapshot
make status                              # daemon-side view (ps + snapshot)
make logs                                # daemon stdout/stderr — ~/Library/Logs/shuttle.log
                                         # (macOS) / ~/.shuttle/shuttle.log (Linux)
tmux ls | grep -- '-shuttle:'            # live workers (<leaf>-<uid>-shuttle)
curl -s http://127.0.0.1:4000/api/v1/agents | jq
curl -s http://127.0.0.1:4000/api/v1/state | jq
curl -s http://127.0.0.1:4000/api/v1/state/composite | jq
felt setup receipt --json | jq
felt shuttle validate-identity           # the local daemon plus every configured remote
```

Dispatch sanity ladder:

1. `felt shuttle status` shows the fiber with `KIND oneshot` and an
   active/idle state? → fiber is well-formed and the offline walker sees it.
2. `felt shuttle snapshot` lists it under `eligible[]`? → daemon dispatched.
3. Fiber is `active` but sitting in `pending_launch`? → the daemon restarted
   and the boot quarantine is armed. `bin/shuttle release`. Check this before
   reaching for `make restart` — a restart *re-arms* the quarantine. (On a host
   that opted in with host.json `"quarantine_auto_release": true`, a released
   daemon killed hard and back within seconds, workers intact, releases itself;
   the boot log line `boot quarantine auto-released (…)` or `boot quarantine
   held (…)` says which happened and why.)
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
`stall_timeout_ms` is the watchdog bound (300 seconds),
and `stalls` plus `last_stalled_at` show whether a world read was reaped. Slow
store and remote discovery run in one supervised, unlinked task while the
poller continues serving its cached state. At the bound the task is killed, a
new cycle is scheduled, and any late token from the abandoned read is ignored.
Repeatedly increasing `stalls` means the daemon is alive but an input remains
wedged; inspect `~/.config/felt/stores.json` and remote tunnel health rather
than restarting the daemon to clear the symptom.

## A worker tmux cannot see

tmux reaches its server through a socket file, `/tmp/tmux-<uid>/default`
(under `TMUX_TMPDIR` when set). If something deletes that file while the server
runs — a `/tmp` cleaner, a careless `rm` — every tmux command answers "no server
running" although every worker under the server is still alive. The daemon
does not read that as death:

- **Every session's run script names it.** A worker runs as
  `bash -l <tmp>/shuttle-run-<session>.<n>.sh`, and that bash lives as long as
  the worker. When tmux says a session is absent, the daemon scans its own
  uid's processes (`ps -ww -o pid=,ppid=,args= -U <uid>`); a live run script
  makes the session `:unknown` — held as present, never struck dead — and the
  poller's session listing includes it. A scan that cannot run is uncertainty
  too, never evidence of death.
- **No resume onto a held transcript.** Before resuming a fiber onto harness
  session `<uuid>` (the dispatcher, or a History row's resume), the daemon
  refuses if any process carries `<uuid>` in its argv. The poller parks the
  fiber as blocked with a message naming the pid.

The log line `tmux cannot see session …` (at most every ten minutes per
session) or the blocked message names the worker and, when it can, the orphaned
tmux server's pid. To restore the view, make the server recreate its socket:

```bash
kill -USR1 <tmux server pid>    # tmux recreates the socket when the path is free
tmux ls                         # the sessions are back
```

If another tmux server has since claimed the socket path (a later `tmux
new-session` started one there), `USR1` cannot reclaim it: stop the new server,
or finish the orphaned workers by stopping their processes. A blocked resume
proceeds once no process holds the session.

## Remedying a daemon-born tmux server (macOS)

`felt setup receipt` (or `felt shuttle status`) prints a one-liner when the
current tmux server is daemon-born (see dispatch.md, "tmux server ownership")
— it means the server's fork chain roots at the daemon's beam executable, so
macOS charges every worker's file access to that binary rather than to a
process that can hold the TCC grant. The fix is a restart, done from a
terminal, not from the daemon:

1. **Confirm no worker is live first** — `felt shuttle ps` or `tmux ls`. A
   session inside the bad server is still a running worker; killing the
   server under it ends that session mid-thought.
2. **Kill the server**, not just a session: `tmux kill-server` (with the
   right `TMUX_TMPDIR`/socket if you run more than one). This drops every
   session on it, including the daemon's anchor.
3. **Start a fresh one from kitty**, by hand: `tmux new-session -d -s
   shuttle-anchor`, or just open a kitty window (kitty's own default session
   creation forks the server the same way). The point is that kitty — a
   terminal you launched yourself — is now the responsible process, so it can
   hold whatever TCC grants its children need.
4. **Dispatch resumes normally** on the next tick. A worker whose session
   died in step 2 is not lost: `Shuttle.Continuation` resumes it from its
   transcript on the next dispatch, the same as any other tmux session that
   ends between ticks (see dispatch.md, "A finished run is finished").

Doing this while a worker is live is the only way to actually lose work here
— the daemon itself never restarts a tmux server on its own, so this is
always a deliberate, by-hand action.
