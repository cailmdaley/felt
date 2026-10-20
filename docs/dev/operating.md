# Operating and debugging the daemon

## Quick start — operating without rebuilding

```bash
# shuttle — local daemon lifecycle
shuttle daemon start [--force]                   # run the Mix release in the foreground
shuttle daemon stop                              # stop it and mark the shutdown intentional
shuttle daemon status                            # state JSON; exit 2 when down
shuttle daemon release                           # release the boot quarantine
shuttle daemon reset <remote>                    # reset a tripped remote circuit breaker
shuttle daemon install                           # install the keep-alive supervisor
shuttle daemon uninstall                         # remove the keep-alive supervisor
shuttle doctor                                   # host, listener, daemon-contract diagnostics

# shuttle — orchestration CLI; schema-validating
shuttle status                            # fibers with shuttle: blocks (closed hidden; --closed)
shuttle status --all                      # local + every configured remote
shuttle status --remote <name>            # single remote
shuttle ps                                # live tmux workers only
shuttle install <fiber> --project-dir "$PWD" [-m <agent-id>] [--disabled]
shuttle repeat <fiber> --schedule "0 9 * * 1-5" --tz Europe/Paris --project-dir "$PWD"
shuttle reshape <fiber> [kind] [-s <schedule>] [-z <tz>]  # change an existing block's kind/schedule in place
shuttle pause <fiber>                       # park in drafts + kill live worker; --no-kill preserves it
shuttle rest <fiber>                        # put down in Resting without review; stops a live worker
shuttle resume / accept / reopen <fiber>
shuttle set-agent <fiber> <agent-id> [--effort E] [--chrome]
shuttle snapshot                            # the daemon's state snapshot
shuttle dispatch <fiber> [--ad-hoc]         # dispatch now
shuttle handoff <fiber>                     # worker's clean-exit ritual: stamp
                                                #   shuttle.runtime.handed_off_at (→ next
                                                #   is fresh) + end own tmux session. The
                                                #   single final action; folds in kill $PPID.
shuttle attach <fiber>
shuttle validate-identity                # fiber UID invariants across daemon feeds
felt setup receipt --json                     # Felt binary and loaded plugin generations
```

## Remote Control host

`shuttle remote-control` reads this daemon's managed Claude Remote Control status; `--json` returns the complete snapshot from `GET /api/v1/remote_control`.
Configure its folder and literal arguments through host.json's `remote_control` object, as described in [installation](../shuttle/installation.md#claude-remote-control-host).
Changes take effect within 30 seconds without restarting the daemon.
Removing the key stops the managed tmux session `shuttle-remote-control`; a daemon restart leaves it alive and adopts it.
The boot quarantine doesn't hold this host.

For `waiting` or `error`, inspect `message`, `last_exit.screen`, and `next_attempt_at` before intervening.
Authentication errors and a folder already served by another host appear in the retained screen.
A short failure doubles the retry delay from 2 seconds to a 300-second cap.
Uncertain tmux visibility holds rather than launching a duplicate; the missing-socket recovery below applies to this host too.

## Message identity and handoffs

A delivered message header keeps the sending session in `from` and shows a worker's fiber separately as `reply to <fiber>` (`reply_to` in JSON).
The sending CLI checks the daemon-exported `SHUTTLE_FIBER_PATH` against the caller's native session, then falls back to the local session ledger.
An inherited dispatch path does not make a nested, unrelated session the fiber's worker.
Native adapters and hook offers share the header formatter in `internal/messaging`; Claude's native wire `from` remains its UDS policy-receipt endpoint, while the content header carries the sender and fiber labels.
The daemon validates and retains `reply_to` through local request-json frames and remote routing.
Deduplication includes a nonempty reply target and preserves fingerprints for requests that omit it.

Registration and `SessionEnd` each atomically replace one owner/identity-scoped `receiver.json` state record with a live receiver or an ended state.
Concurrent transitions cannot erase both states; the last atomic publication wins.
A separate `ended.json` marker is also recognized when `receiver.json` is absent.
The mailbox layer reports ended, never registered, or a registered receiver process that is no longer running, without interpreting fibers.
Directory existence alone is not end evidence: native endpoint registration also creates that directory.
The owner-local CLI enriches rejected or unknown session receipts from its rotated and live session ledger when another worker holds the fiber.
Rows are stably ordered by timestamp, with live rows after rotated rows at equal timestamps.
Successor addresses use the normal fiber resolver's runtime and peer evidence, including Codex CLI workers without `thread_id`.
If an exact successor address cannot be established, the receipt still names the recorded successor session and advises the fiber target, without guessing an address.
This enrichment survives daemon routing and never changes the explicit recipient.
If a marker or ledger pairing is absent, preserve uncertainty rather than inferring an end or successor.

## Inspecting state

```bash
shuttle status                      # offline walker view (independent of daemon)
shuttle snapshot                    # raw JSON snapshot
make status                              # daemon-side view (ps + snapshot)
make logs                                # daemon stdout/stderr — ~/Library/Logs/shuttle.log
                                         # (macOS) / ~/.shuttle/shuttle.log (Linux)
tmux ls | grep -- '-shuttle:'            # live workers (<leaf>-<uid>-shuttle)
curl -s http://127.0.0.1:4000/api/v1/agents | jq
curl -s http://127.0.0.1:4000/api/v1/state | jq
curl -s http://127.0.0.1:4000/api/v1/state/composite | jq
felt setup receipt --json | jq                # Felt binary and plugin state
shuttle doctor                                 # Shuttle binary, host, listener, daemon contract
shuttle validate-identity           # the local daemon plus every configured remote
```

Dispatch sanity ladder:

1. `shuttle status` shows the fiber with `KIND oneshot` and an
   active/idle state? → fiber is well-formed and the offline walker sees it.
2. `shuttle snapshot` lists it under `eligible[]`? → daemon dispatched.
3. Fiber is `active` but sitting in `pending_launch`? → the daemon restarted
   and the boot quarantine is armed. `shuttle daemon release`. Check this before
   reaching for `make restart` — a restart *re-arms* the quarantine. (On a host
   that opted in with host.json `"quarantine_auto_release": true`, a released
   daemon killed hard and back within seconds, workers intact, releases itself;
   the boot log line `boot quarantine auto-released (…)` or `boot quarantine
   held (…)` says which happened and why.)
4. Fiber is `active` and armed, but in neither `eligible[]` nor
   `pending_launch`, and the snapshot's `claimed_count` equals
   `max_concurrent`? → the host is at its worker cap and the fiber launches
   when a slot frees. The cap defaults to 10; raise it per host with host.json
   `"max_concurrent_workers": <n>` and a restart.
5. `shuttle` sees it but daemon doesn't → daemon binary is stale.
   `make restart` (then `shuttle daemon release`).
6. Daemon sees it but agent never appears → check the resolved agent's `cli`
   (`shuttle agents`) and that the wrapper is on `PATH`.

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

**The card sits blocked with "has no intrinsic id".** A worker's tmux session
is `<leaf>-<uid>-shuttle`, so a fiber whose frontmatter carries no `id:` (a
file made by hand and never backfilled) has no worker name, and the daemon
refuses it before anything else. Run `felt backfill-ids` in its store, or add
an `id:` ULID by hand; any felt write to the fiber also stamps one. The refusal
parks the fiber like the ones below, so a force-dispatch launches it at once.

The same preflight refuses a fiber whose `project_dir` is not a directory on
this host — a checkout that lives on another machine. The autonomous path
already skipped those; this catches the force-dispatch path (Requeue,
drag-to-launch), which bypasses eligibility. After either refusal the daemon
parks that fiber for 5 minutes rather than re-probing a login shell every tick;
a force-dispatch skips the wait.

Every snapshot carries `poll_health`: `state` is `reading` or `idle`,
`stall_timeout_ms` is the watchdog bound (300 seconds),
`full_scan_budget_ms` is the effective per-host discovery budget, and `stalls`
plus `last_stalled_at` show whether a world read was reaped. Slow
store and remote discovery run in one supervised, unlinked task while the
poller continues serving its cached state. At the bound the task is killed, a
new cycle is scheduled, and any late token from the abandoned read is ignored.
Repeatedly increasing `stalls` means the daemon is alive but an input remains
wedged; inspect `~/.config/shuttle/stores.json` and remote tunnel health rather
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

`shuttle doctor` (or `shuttle status`) prints a one-liner when the current
tmux server is daemon-born (see dispatch.md, "tmux server ownership")
— it means the server's fork chain roots at the daemon's beam executable, so
macOS charges every worker's file access to that binary rather than to a
process that can hold the TCC grant. The fix is a restart, done from a
terminal, not from the daemon:

1. **Confirm no worker is live first** — `shuttle ps` or `tmux ls`. A
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
