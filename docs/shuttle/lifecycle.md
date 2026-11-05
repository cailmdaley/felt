# Lifecycle

This page covers the span from "the daemon sees an armed fiber" to "a human
accepts the result."

## The worker loop

The daemon starts one worker per eligible fiber. A terminal worker is a tmux session named
`<slug-leaf>-<uid>-shuttle`, keyed by the fiber's intrinsic `id:` (a ULID),
running the agent CLI in `shuttle.project_dir`. A fiber without an id has no
worker name, so the daemon refuses to dispatch it and the board shows it
blocked; `felt backfill-ids` gives every fiber in a store one, and every felt
write stamps one on a fiber that lacks it. `shuttle session-name <fiber>`
prints the name. The daemon composes a deliberately thin
prompt: the fiber id, the felt store path, an exit contract, and an optional
per-dispatch "From User" directive.

It does **not** paste the constitution into the prompt. The worker reads the
fiber fresh from disk, so it picks up an edit you make mid-session instead of
freezing a stale snapshot.

From there the worker:

1. **Surveys** — reads the constitution, the previous `## Status` handoff, the
   `git log` in and around the project directory, and any sub-fibers.
2. **Works** — picks the highest-value slice itself. The constitution describes
   what "done" looks like; the worker sequences the steps.
3. **Writes back** — rewrites `outcome:`, rewrites `## Status`, corrects the
   spec if the session sharpened it, files findings as sub-fibers, commits.
4. **Exits** — with exactly one Shuttle lifecycle verb as its final action:
   `shuttle handoff <fiber>` to continue, `shuttle close <fiber>` to stop for
   review, or `shuttle rest <fiber>` to stop with nothing to review.


Workers should exit earlier than feels natural. A clean handoff at half a
context window beats pushing through a compaction. `## Status` plus the
constitution recovers most of a warm world-model on the next dispatch.

## Exit semantics

The worker asks four questions, in order. The answer sets `status`, and
`status` decides what happens next.

**1. Is the desired state realized?** Run `shuttle close <fiber>` and exit.
The card lands in Awaiting review.
A human accepts it or resumes it.
For a standing constitution with a dispatch on record, an occurrence after both its last service and close can supersede the unreviewed result and start fresh work.
A plain close preserves an existing standing verdict; `reopen` explicitly clears it.
A never-run closed standing draft stays closed.

Substantive work needs independent fresh-eyes review before the session that
produced it closes — a subagent reviewer in-session, or leave the fiber `active`
and let the next dispatch review it cold. Edits to the fiber's own surfaces
(spec, `## Status`, `outcome`, `tapestry.html`) count as handoff, not work
product, and never block a close.

**2. Blocked on something only a human can supply?** Run
`shuttle close <fiber>`, and lead the outcome with `Blocked: …` so the card
reads as a question.

**3. A session the human drove, now over, with nothing to review?** Run
`shuttle rest <fiber>`. It writes `status: open` and `horizon: stashed`, clears
any verdict, concludes the run and stops the worker: the card goes back to
Resting, its outcome the session's report, and starts again by hand. This is
how a hub or a seat — a constitution with no finish line — ends a session.
On the Desk's focused card or a constitution page, press **s** to open a small date popover.
Enter with an empty date rests undated; choosing a date rests until that day.
The same operation is `shuttle rest <fiber> --until YYYY-MM-DD` (or `--until ''` for no date).
It works in any state and stops a live worker through the owning daemon's serialized rest lifecycle.

**4. More work, not blocked?** Leave the fiber active and just hand off. The
daemon starts a fresh worker next eligible tick, and it lands on your `## Status`.
A standing run that has not been accepted is published for review on worker exit and waits for acceptance or a subsequent scheduled occurrence.
Acceptance keeps that run armed through its worker's handoff and exit.

### Close, handoff and rest

shuttle obeys the vocabulary literally. Know which word does what.

| You say | The worker does | Next |
|---|---|---|
| "hand off" | Continue with `shuttle handoff <fiber>` | Daemon redispatches when eligible; a standing run follows its schedule and review lifecycle |
| "close it out" | Run `shuttle close <fiber>`; it sets `status: closed` — never handoff | Card waits for review; an untempered standing run can re-arm at a subsequent occurrence |
| "put it to rest" | Run `shuttle rest <fiber>`; `status: open`, `horizon: stashed` | Card goes to Resting; no new worker |

Closing puts the work back on a human's desk. It claims nothing about
completion. A worker should never upgrade a close-out into a continuation
because the work looks unfinished — unfinished is often exactly why you want it
back.
For a standing responsibility, Rest (`status: open`) pauses the schedule and a verdict ends it.
A stashed horizon alone does neither.

### Tempered — human only

`tempered` carries the verdict, and a worker never sets it to `true`.

| `tempered` | Meaning |
|---|---|
| absent | Awaiting review |
| `true` | Accepted |
| `false` | Discarded — mooted or superseded |

Workers also never uninstall their own `shuttle:` block. Closing and
uninstalling are separate decisions, and the block stays as historical record.

### Resume vs fresh

Workers start fresh by default. Resuming a transcript happens in three cases:
you press Resume on the board; a oneshot died dirty and its transcript is on
this host; or you message a fiber whose worker died dirty and whose transcript
is on this host. A death counts as dirty when `handed_off_at` is missing or
older than `dispatched_at`. A transcript predating the dispatch belongs to a
predecessor and starts fresh; a missing transcript starts fresh with the cut-off
session named in the prompt. This rule applies to all terminal harnesses.

New session on the board always starts fresh. Scheduled and ad-hoc standing runs start fresh too. Daemon recovery restores
previously running oneshots as described below.

## The board

The daemon serves a board at `http://127.0.0.1:4000/`: one page, three full-page
views behind a hotkey row.

| Key | View | What it answers |
|---|---|---|
| `1` | **Desk** | What needs doing, and what is running right now — the kanban |
| `2` | **Chronicle** | What a stretch of weeks was about, under a strip of cycle bands |
| `3` | **Board** | Documents produced by the work, in an overview and reader |

The Board opens on a document overview and a reader for one fiber's channel.
The fiber page carries its controls inline, and its worker pill opens the conversation.
The board holds no state of its own. It views the same fibers the daemon polls,
plus tmux liveness and the host-local [ledgers](telemetry.md).

[The board](board.md) covers all three in depth — column and horizon rules, the
snooze gesture, Attach, how Chronicle fetches its record, and how to build the
bundle.

## Dispatch eligibility

A fiber dispatches if and only if all of these hold. The daemon evaluates them
in this order (`eligible?/2` and `dispatch_gates_pass?/3` in
`daemon/lib/shuttle/poller.ex`).

1. It lives in a felt store the daemon polls.
2. It carries a `shuttle:` block. That block alone defines "shuttle-managed";
   no tag predicate exists.
3. `shuttle.host` equals this daemon's own host id.
4. felt-native `status` is `active`.
5. No worker is already running or claimed for it.
6. The resume-loop circuit breaker is closed.
7. The boot quarantine is released.
8. `shuttle.project_dir`, when the block declares one, exists on this host. A
   block without one still dispatches, with the felt store as the worker's
   directory; felt's arming verbs refuse to arm such a block.

Configured stores come from `SHUTTLE_STORES` (comma-separated) or the persisted
registry at `~/.config/shuttle/stores.json`. shuttle assumes no default store.

### Pulsed oneshot constitutions

A oneshot constitution may carry `shuttle.pulse: 59m` to wake its own conversation at that interval.
The interval ranges from one minute to 24 hours.
An optional `window` with `start`, `end` and an IANA `tz` limits ticks to local wall time; the start is included, the end excluded, and overnight windows are allowed.
The first tick in each window starts a fresh session from the fiber, without spending a turn in the old conversation.
If the old session is busy, that reset waits for it to become idle.
Keep the fiber's Status current during the day; there is no goodbye turn.
Pulses apply to any oneshot constitution, including but not limited to seats.
The daemon resumes the same session after an exit, even when its transcript is cold, unless the session handed off; a handoff starts the successor from the fiber.
A busy session skips the tick and tries at the next interval, without interrupting or stacking turns.
Pause, rest and close stop pulses.
Pulse timing persists in daemon operational state across restarts, outside the fiber lifecycle.
Ticks do not create board events or review cards unless the worker chooses to write or post.
Claude and Codex support pulse; Pi has no idle-safe wake path.

**The circuit breaker** (7) exists because a worker that dies on startup would
otherwise be relaunched forever. Five consecutive worker deaths, each under 90
seconds, pause autonomous dispatch for that fiber for ten minutes and surface it
as `blocked`. A healthy run or a force-dispatch clears it.

## Boot quarantine

On every start, the daemon parks fresh autonomous work in `pending_launch`.
Previously-running oneshot workers restore from their durable continuation markers without a release.
A finished or ambiguous turn reopens its conversation quietly; an interrupted turn receives a continuation prompt.
Restoration preserves the conversation regardless of transcript age.
Oneshot seats follow the same rule.
Standing cron runs retain their close-to-review lifecycle when their worker dies; a due occurrence carries its own authorization and passes through the quarantine.
CLI/daemon contract and reconciliation holds remain independent gates.

The guard exists because a daemon that restarts repeatedly (an overloaded
machine crash-looping, for example) would otherwise treat every restart as
license to relaunch every armed, workerless fiber it can see — a burst of
redundant, token-burning launches on each crash.

Quarantine has no timeout; explicit release uses the command below or the host-addressed API.
The fast-bounce exception below can release it automatically.

```bash
shuttle daemon release
```

A human force-dispatch bypasses the quarantine without clearing it.

### The one automatic exit: a proven fast bounce

Every restart someone asked for holds: a deploy, `make restart`, `make stop`, a
supervisor restart (`systemctl --user restart`, `launchctl kickstart -k`). Those
all stop the daemon with SIGTERM, and a SIGTERM'd daemon touches a stop marker,
`$SHUTTLE_DATA_DIR/heartbeat.stopped`, first thing on the way down. `make stop`,
`shuttle daemon stop`, `shuttle daemon install` and `bin/shuttle-deploy` touch
it themselves before they signal — in the `data_dir` that `shuttle host
--json` reports, so they apply the daemon's own trim and `~` rule — and so does
re-running `bin/shuttle-launch`, whose tmux `kill-session` SIGHUPs the daemon
with no shutdown at all. The next boot sees the marker and holds.

The exception is a daemon killed *hard* — a kernel CPU-rlimit SIGKILL on a
capped cluster login node, say — and respawned seconds later. Its workers may
survive or need restoration; a fresh-work hold would stop new work until
someone noticed. A hard kill runs no shutdown code and touches no
marker. Only such a host needs the exception, so it is off unless the host opts
in, in `~/.config/shuttle/host.json` (or `$SHUTTLE_HOST_CONFIG_FILE`):

```json
{"class": "shared-multi-user", "quarantine_auto_release": true, "full_scan_budget_ms": 0}
```

`full_scan_budget_ms` is an optional non-negative integer read once at daemon boot.
It overrides the 10,000 ms default that selects adaptive discovery: after a full listing, a scan slower than this budget puts the store in hot mode until its next scheduled full scan.
Set it to `0` to keep the store hot after its first full listing; full scans still run at `full_scan_min_interval_ms` cadence.
The effective value is reported in `poll_health`.
This is useful on shared login nodes where repeated full scans should be paced even when a scan happens to finish quickly.

An independent incremental pass detects local filesystem changes, including standalone felt writes, hand-edited frontmatter, and files brought in by Git.
It checks native nanosecond timestamps, size, type and inode for known physical directories and canonical fiber files, enumerates changed directories, and reads changed addresses through Shuttle's ordinary listing.
Eight concurrent metadata readers bound the filesystem work; symlink mounts belong to their physical store.
Each pass starts five seconds after the preceding pass finishes, independently of the ordinary poll and its full-scan cadence.
A slow full scan cannot overwrite newer incremental edits, moves or deletions, and serialized lifecycle writes supersede reads already in flight.
A failed pass retains its previous index and retries; filesystem cache visibility and server load still bound how soon a change can be observed.
Per-store durations, indexed path counts and failures appear in `poll_health.incremental_discovery`.
The daemon never invokes Git.

A document the daemon writes or re-reads, or a local Shuttle CLI write, also joins the hot set promptly.
A hot read that misses a known address brings the next full scan forward.
Full scans audit the store in addition to incremental discovery.

On any other host a SIGKILL is an out-of-memory kill or a person's `kill -9`,
and holding is the right answer. With the key absent or anything but `true`,
every boot holds and logs `automatic release is off for this host`.

On every host the daemon rewrites `$SHUTTLE_DATA_DIR/heartbeat.json` (default
`~/.shuttle/heartbeat.json`) every 10 seconds, and at once when the hold is
released: the time of the write, when this incarnation booted, its host id, listener identity (`listen`), the
machine's node name and the daemon's OS pid, whether it was still held, the
workers it has live, and a short ring of recent boot times. On an opted-in host
the next boot reads the file before adoption and judges it after adoption. The
hold lifts by itself only when all of these hold:

1. the heartbeat has a matching listener identity and was written by this host id on this machine (a `$HOME` shared across login nodes can hold another node's heartbeat), by a different daemon process (a restart inside the running daemon is not a hard kill);
2. no stop marker is as new as that incarnation's boot;
3. that incarnation had been released: an unreleased hold survives hard kills,
   so a daemon that booted held after an outage or a deploy stays held;
4. the heartbeat is less than 60 seconds old, and newer than the machine's own
   boot;
5. the previous incarnation ran at least 90 seconds, and the daemon has booted
   at most 3 times in the last 10 minutes, counting this boot.

Anything else holds: a graceful stop, a stale heartbeat (a real outage), a crash
loop, a missing or malformed file, a boot whose tmux scan failed, or a CLI/daemon
contract skew — which has no release path at all, automatic or manual. The
daemon log records the verdict and its reason either way.

## CLI verbs

`felt` owns fiber content and generic frontmatter. It preserves `shuttle:` as
opaque data; it does not validate the block or write Shuttle lifecycle state.
`shuttle` owns the block's schema, resolved reads, host/fleet configuration,
and lifecycle. Its local writes validate before touching disk; status, snapshot,
and dispatch can also ask the local daemon. The
[CLI reference](../reference/cli.md#shuttle-dispatch-layer) lists the commands.

```bash
shuttle check                         # validate Shuttle blocks in a store
shuttle ls --has-field shuttle        # fiber listing with resolved Shuttle data
shuttle show <fiber>                  # read one fiber with its resolved facet
shuttle status [<fiber>]              # offline eligibility and dispatch state
shuttle snapshot                      # local daemon snapshot
shuttle dispatch <fiber> [--ad-hoc]   # ask the daemon to dispatch

shuttle daemon start [--force]        # start the local Mix release
shuttle daemon stop                   # stop it and record an intentional stop
shuttle daemon status                 # state JSON; exit 2 when the daemon is down
shuttle daemon release                # clear the boot quarantine
shuttle daemon reset <remote>         # reset a remote's circuit breaker
shuttle daemon install                # install the per-user keep-alive
shuttle daemon uninstall              # remove the per-user keep-alive
shuttle doctor                        # diagnose host, listener, and daemon contract
shuttle version                       # daemon version, or local Mix release version
```

The daemon uses `felt` for fiber content and generic writes, and `shuttle` for
resolved reads and Shuttle-owned operations. `shuttle daemon status`,
`release`, and `reset` contact the local daemon over HTTP; `start` and `stop`
manage the local release, while `install` and `uninstall` manage the
[keep-alive](installation.md#keep-alive).

The daemon also speaks HTTP under `/api/v1`, in four groups: a **write plane**
(`dispatch`, `transition`, `kill`, `lifecycle`, `felt-edit`, …), a **read
plane** (`fibers`, `agents`, `felt-stores`, …), a **temporal read plane** the
board's time views live on (`activity`, `sessions`, `commits`,
`sent-files/all`, each with a `/composite` sibling that fans in every host a
hub aggregates — the fleet), and
**operator routes** (`state`, `version`, the manual gate releases). The [API
reference](../reference/api.md) tabulates them.

```bash
curl -s http://127.0.0.1:4000/api/v1/agents | jq
```

## When to uninstall

Closing a fiber leaves its block in place, and that is deliberate. Uninstall
earns its keep in three cases:

1. **Mistake recovery** — wrong slug, immediate undo.
2. **Full rebuild** — though `shuttle reshape` covers most of the "change the kind or schedule" case in place, without a rebuild.
3. **Archiving** — a closed fiber's card leaves the board entirely.

To move a constitution between hosts, keep its block and follow [Moving a constitution between hosts](#moving-a-constitution-between-hosts).

Never uninstall to end a worker session. Use the ordinary exit — `shuttle handoff` to continue, `shuttle close` to stop for review, `shuttle rest` to put it down.

## Moving a constitution between hosts

A host move is an ordered procedure, not an atomic handover.
`shuttle.host` selects an owner; it is not a fleet-wide lease, and Git replication does not stop terminal-owned work.
Use a store containing the constitution and a CLI that can route to both owners.

1. Run `shuttle rest <fiber>` through the current owner and wait for confirmed success.
   This disarms the document and stops its live worker.
   Obtain the owner's rested document before editing an archive copy.
2. On that disarmed document, set `shuttle.host` to the destination's host id and `shuttle.project_dir` to the destination's absolute worker directory.
   Keep `status: open` and preserve the intrinsic `id:` UID.
3. Run `shuttle resume <fiber>` through the destination.
   If the destination authoritatively reports the draft missing, the CLI transfers it through the create API, preserving its UID.
   It removes the local draft only after the response confirms the identity, owner, armed status and destination path.
   A separate Git sync is unnecessary for that path; if the destination already has a copy, synchronize the disarmed document there before resuming it.
   A duplicate UID is refused rather than overwritten.
4. Confirm the destination's persisted document and execution state, then commit and sync the archive so every copy records the destination owner.
   A normal resume can remain pending in the destination's boot quarantine.

If a create or resume response is lost, inspect the destination before retrying: the document may already be armed.
A failure between steps needs inspection; do not assume the transfer rolled back.

### Unreachable old owner

Daemon downtime does not prove its terminal worker has stopped.
Before takeover, have a human confirm that the old execution is gone, or explicitly accept the risk of duplicate execution.
Keep the local document disarmed (`status: open`), then follow steps 2–4.
Reconcile the old owner's copy and any surviving worker before it returns to service.
Do not use `uninstall` followed by `install` as a transfer: uninstall leaves the worker running.
The board can collapse rows sharing a UID, so one visible card does not prove there is only one execution.

## Diagnosing a missing card

Most "my card isn't showing" reduces to "no block installed yet." Check in this
order: is the fiber in a store the daemon polls, does `shuttle status` show
a block, is `status: active`, does `shuttle.host` match, and is the quarantine
released?

For multi-host setups, remote fibers reach the board over an SSH tunnel from the
owning daemon — never via git sync. A git mirror may replicate a remote fiber's
files locally. That replication is incidental; treat any behaviour that depends
on it as a bug. If a remote card is missing, debug the tunnel, not the git
state.

!!! note "Remotes come from one config file"
    `~/.config/shuttle/remotes.json` lists every remote daemon: its name, its
    local forwarded port, and how to reach it. The CLI and the daemon both read
    it at runtime. Manage it with `shuttle remotes list|add|rm|path`. A
    single-machine setup needs no such file — see [Configuring
    remotes](installation.md#configuring-remotes).
