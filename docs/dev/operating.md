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

## Terminal Codex workers

Codex 0.162.1 supports a terminal TUI attached to the same App Server that Shuttle messages.
Both `surface: cli` and `surface: app` require that backend; terminal presentation does not provide an embedded fallback.
Shuttle ensures the dependency on every daemon host, including hosts with network-mounted home directories.
No separate operator bootstrap is required.
Install Codex 0.162.1 or a compatible binary on the host's login-shell `PATH`, keep its normal persistent authentication/configuration, and start Shuttle.
The dependency reconciles even while worker dispatch is held by boot quarantine; starting it creates no model turn.
When an assignment retires, Shuttle closes its terminal viewer even if a client is attached; the conversation remains in the App Server and `shuttle attach` can reopen it.

The default control endpoint is `/tmp/shuttle-codex-<euid>-<host-hash>/control.sock`, where `host-hash` is the first 16 lowercase SHA-256 hexadecimal characters of the actual OS hostname.
`HOME`, `CODEX_HOME`, `TMPDIR`, and `XDG_RUNTIME_DIR` don't change it.
`SHUTTLE_CODEX_SOCKET` selects an authoritative explicit endpoint for the daemon, native messaging, and terminal viewers.
Use a clean absolute socket path of at most 100 bytes inside a user-owned `0700` directory, without user-controlled symlink components.
The manager creates a missing endpoint root privately and refuses insecure precreated roots rather than changing their permissions.
`CODEX_HOME` remains persistent, defaulting to `~/.codex`; no credential copying or temporary-home migration is involved.

Inspect `codex_backend` in `GET /api/v1/version` for `state` (`starting`, `ready`, or `waiting`), `endpoint`, `error`, and `next_attempt_at`.
Daemon `ready` and Codex readiness are independent.
Before readiness, dispatch and capture answer HTTP 503 with `reason: "backend_not_ready"`, `waiting: true`, and `retryable: true`, without creating a conversation or queuing a hidden launch request.
An armed fiber retries on the ordinary poll once the backend is ready, without a five-minute preflight cooldown.
A capture has no fiber to retry; repeat it after readiness.
Existing owned conversations remain held with their exact identity when backend observations are uncertain.

The manager starts `command codex app-server --listen unix://PATH` in an endpoint-specific tmux session, without inherited worker identities or an interactive wrapper.
On macOS it uses the same terminal-owned tmux guard as worker dispatch and never falls back to an invisible daemon-born server.
Healthy existing servers are adopted without a PID change, and restarting Shuttle leaves the backend and its active turns alive.
Launch failures back off from 2 seconds to a 300-second cap.
A retained owned dead pane and successful process scan can authorize native locked recovery of a stale socket after hard death.
An unresponsive unowned socket, a missing socket with a live server holder, an uncertain process scan, or another manager still starting is a wait, not permission to launch a duplicate.
Never remove a socket merely because a connection timed out.
After reboot, Shuttle starts the absent dependency without releasing worker quarantine.

`codex app-server daemon version` describes Codex's own `CODEX_HOME/app-server-control` endpoint, not Shuttle's custom listener.
Use Shuttle's version health for this dependency.
If you already supervise a healthy server at the selected explicit endpoint, Shuttle adopts it and never restarts it or changes its configuration.
Its environment is shared by all clients, so configure tool credentials and other settings before starting it.
Per-agent environment overrides and unsupported arbitrary CLI flags are refused by managed dispatch and history resume.
The agent wrapper launches only the terminal viewer; it doesn't supply the environment in which the shared backend runs tools.

Managed conversation records pin the owning host and endpoint for both surfaces.
A changed default or override, another host with the same socket pathname, or an unrecorded owner blocks backend operations without releasing the assignment.
Restore the recorded backend, then retry; shared rollout files don't authorize changing the owner.
An existing record without ownership metadata requires deliberate operator reconciliation, not inferred migration.
A missing record is handled separately for an embedded CLI conversation, as described below.

`shuttle attach <fiber>` opens or recreates a terminal viewer of the existing owned thread, without starting a turn.
Closing that viewer leaves the conversation and its task assignment alive.
An idle conversation can be woken, and a running turn can be steered, through `shuttle message` using its fiber or exact address.
The TUI displays external messages and replies when showing that thread; a message does not force a user's terminal to switch from another selected thread.
`--context-only` adds context for the next model request without creating a visible user turn.

Embedded Codex conversations have three migration cases:

- A live managed embedded CLI worker stays in its existing tmux session and is adopted and watched until its process exits.
  Deploying doesn't load a second copy into the App Server.
  Its live hooks accept `--context-only`; a plain wake is rejected rather than pasted into its terminal or delivered to an App Server copy of the same ID.
  A hook-only conversation without a discovered native ID remains hook-only; Shuttle doesn't invent an ID.
- A stopped embedded conversation resumes automatically on the selected App Server when its exact native ID has a local Codex session-ledger row without an App Server `thread_id`.
  Both the current and rotated ledger files count.
  Before any native read or load, Shuttle checks for a live holder, including a UUID in argv, a worker-script binding for a fresh CLI whose argv has no UUID, and a registered hook receiver process.
  A failed process scan blocks the resume.
  The exact resumed ID receives a durable host-and-endpoint owner record; errors and mismatched acknowledgments never start a fresh conversation.
  Ordinary resume keeps the persisted developer instructions.
- The board's **Resume previous** and a History row's **Resume** use that same migration boundary.
  Resume previous sends the managed worker's continuation prompt; History opens a human terminal viewer without a model turn.
  A History import retains its verified original fiber binding in the durable record, so later native ledger rows don't prevent Resume previous from assigning it back to that fiber.
  A clean handoff followed by an ordinary re-arm starts a fresh conversation by design; explicitly choosing Resume previous still selects the saved ID.

A runtime marker records an ID and timestamps, not the host that wrote them.
If the execution ledger is lost and only a marker and shared-HOME rollout remain, Shuttle cannot distinguish local embedded work from another host's conversation and refuses automatic ownership (`embedded_origin_unverified`).
An ended hook proves a local hook ran, but doesn't distinguish an embedded CLI from an App Server; it alone doesn't authorize migration.
A ledger row carrying an App Server `thread_id`, a corrupt owner record, or a record naming another host or endpoint also requires reconciliation rather than automatic rebinding.

To use the shared backend by hand, launch `codex --remote unix://PATH`, or `codex --remote unix://PATH resume THREAD_ID` for a saved conversation.
The explicit endpoint reports errors rather than silently launching embedded.
Shuttle does not paste into terminals or infer the reader from a pane's foreground process.

Shell wrappers need a separate context-injection check before adding `--remote`.
Most `-c` overrides disable Codex's implicit shared-daemon attachment, and the remote TUI forwards only supported per-thread settings.
In the default 0.162.1 configuration, a wrapper's `-c developer_instructions=…` is not forwarded by TUI start/resume.
Use the App Server's supported `thread/start` `developerInstructions` field, or deliberately move static instructions and dynamic session context to an appropriate server-side or launch-message source.
Do not assume a successful terminal connection preserved those instructions.

The dependency lifecycle probe is `cd daemon && mix test test/shuttle/codex_backend_real_test.exs --include integration --trace`.
It uses a private home, socket root, and tmux server, without copied credentials or model turns.
It checks absent-server launch, healthy adoption, unchanged PID across manager restart, recovery after `SIGKILL`, hostile-root refusal, and a missing socket with a live server holder.
The default daemon suite uses an inert dependency seam and never starts the operator's backend.

The token-free terminal integration test is `go test ./internal/messaging -run TestCodexRealTerminalAppServer -v`.
It runs a real Codex App Server and tmux TUI against a local Responses fixture, covering backend creation, idle wake, active steer, live terminal rendering, persistent context, deduplication, and same-thread viewer recreation.
It skips when Codex or tmux is absent, and under `go test -short`.

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

## Searching local transcripts

`shuttle transcript index` indexes complete JSONL messages from the configured Claude Code, Codex, and Pi roots into a private, rebuildable SQLite FTS5 cache.
Search ranks messages with BM25 and applies session, ledger-resolved fiber, age, project-prefix, and harness filters.
The daemon's supervised `Shuttle.TranscriptIndexer` starts a background scan five seconds after boot, then catches up five minutes after each completed pass.
It runs `nice -n 10 shuttle transcript index --json`, with a 30-minute command timeout and a task deadline five seconds beyond that.
Only one daemon-owned pass runs at a time; duplicate ticks during a pass are ignored.
Task crashes, command failures, timeouts, malformed receipts, and partial-scan errors are logged and retried at the next interval.
If the indexer restarts or the daemon stops, its in-flight task is killed and the command runner reaps the subprocess.

Indexing never holds daemon readiness, polling, dispatch, or the boot quarantine.
The board's search route uses `--no-index --include-self`, so a request doesn't initiate a corpus scan or exclude a transcript because the daemon inherited harness session environment.
Board searches have no harness caller whose session should be hidden.
While the first index is being built, the route preserves the CLI's actionable missing-index message in its JSON `detail`, which the board displays with the error.
For an offline or immediate build, run `shuttle transcript index` explicitly; add `--rebuild` to discard and rebuild the derived data.

Set `"transcript_index": false` in `~/.config/shuttle/host.json` (or `$SHUTTLE_HOST_CONFIG_FILE`) to opt out of daemon indexing.
Only literal JSON `false` disables it; an absent key defaults to enabled.
The indexer reads this setting before each pass, including while disabled, so a change takes effect at its next tick without restarting the daemon.
Opting out doesn't cancel a pass already running or prevent explicit CLI indexing.

Inspect `transcript_indexer` in `GET /api/v1/version`:

- `state` is `scheduled`, `running`, `idle`, `disabled`, or `unavailable`.
- `last_run_at` is the completion time of the last attempted scan, or `null` before one finishes.
- `duration_ms` is that attempt's elapsed time.
- `ok` and `error` report its outcome, including incomplete scans; both are `null` before the first attempt.

A running scan retains the previous outcome until it finishes.
An opted-out pass leaves the last scan's outcome intact and reports `state: "disabled"`.
If search keeps reporting a missing index, check this health report and daemon logs for a missing `shuttle`/`nice` executable, cache permissions, or a scan timeout.
Checkpoints track complete-line byte offsets, file identity, size, mtime, and bounded prefix/tail fingerprints; unchanged files need only a stat, while replaced or truncated files are reindexed.
Native transcripts are append-only: arbitrary edits inside a growing file that preserve both fingerprints require `--rebuild`.
User and assistant text is indexed in full, tool calls are capped at 2 KiB, and tool results at 4 KiB; images, reasoning, signatures, request mirrors, and bookkeeping are excluded.
The index contains transcript text, so keep its configured cache path private and treat it as sensitive local data.

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
   when a slot frees. There is no cap unless host.json sets
   `"max_concurrent_workers": <n>` (a restart applies it); `max_concurrent`
   is null on an uncapped host.
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
already skipped those; this catches the force-dispatch path (New session,
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
