# Daemon HTTP API

The shuttle daemon binds `127.0.0.1:4000` and serves its whole surface under
`/api/v1`. This page is the route inventory.

!!! warning "An operator surface, not a stability contract"
    These routes exist so the board and the operator tooling can talk to the
    daemon. The shape moves with the board — a route added, renamed or removed
    is paired with a bundle rebuild, not with a deprecation window. Script
    against it for your own machine; do not build a product on it.

    `daemon/lib/shuttle_web/router.ex` is the authority, and it carries per-route
    rationale comments this page does not repeat.

## How a route is routed

Three patterns, and knowing which one a route follows explains most of its
behaviour on a multi-host setup.

| Pattern | Meaning |
|---|---|
| **owner-routed** | The request carries an `origin`; the daemon runs it locally or forwards it to the daemon that *owns* the fiber. A fiber's files live on its owner's disk. An explicit unknown origin returns 400 naming the origin before any local lookup, read or write. An absent origin means local. |
| **host-addressed** | Uses the same fail-closed origin rule as owner-routed requests. The subject is a host rather than a fiber — a config file, a store list, a tunnel job, a quarantine — and every host has one, so degrading would not fail: it would succeed on the wrong machine. |
| **host-scoped** | The route answers for *this* machine only, because what it reads (a transcript, an event stream, a ledger) lives on the machine that wrote it. |
| **fan-in** | A `/composite` sibling that merges this host's live read with each configured remote's cached read, reporting per-origin freshness. |

There is no shared routing plug: each controller decides for itself. The
per-controller `@moduledoc` says which, and is the thing to read when this table
is not enough.

`GET /api/v1/debug/profile?seconds=N` is host-scoped and peer-gated; it blocks for 1–300 seconds (default 30), returns OS CPU, VM microstates, process reductions and layered file/port-call attribution, and rejects concurrent profiles with 409. Add `&mode=cpu` for a bounded 1–10 second window (default 10) with selected function counters and route, peer, status, and duration HTTP counts. Function rows include uninstrumented callees and exclude separately instrumented callees; they do not cover total VM CPU. Its `forwarded_for_untrusted` value is an untrusted proxy assertion. Profiler work contributes to the measurement window, so exclude that window from steady-rate comparisons.

`GET /api/v1/state` serves the Poller's latest published snapshot without waiting
for its mailbox. It returns a generation ETag; a matching `If-None-Match`
returns 304 with no body. `X-State-Age-Ms` reports how old the published view
was when served, including when the Poller is busy. State changes are
coalesced for up to one second while the Poller is available; successful
lifecycle and worker actions publish before answering. Terminal worker state is
observed on the five-second watcher cadence, then published within the
one-second coalescing window. A missing publication
during startup or Poller restart returns 503 with `ready: false`. The
`/api/v1/version` response includes cumulative `poller_publication` counters
(`publish_count`, `encode_us`, `total_publish_us`, and `state_request_count`),
plus the latest generation, incarnation and age, for measuring publication rate
and cost between reads. The timing counters measure elapsed wall time, not CPU
time.

## Write plane

| Route | Routing | Purpose |
|---|---|---|
| `POST /dispatch` | owner-routed | Launch a worker for a fiber now, bypassing the poll |
| `POST /transition` | owner-routed | The unified kanban write: move a fiber to a column, one call per drag |
| `POST /lifecycle` | owner-routed | Invoke a named lifecycle action on a fiber — see [below](#lifecycle-actions) |
| `POST /kill` | owner-routed | Stop a CLI worker or interrupt and release an app conversation |
| `POST /claim` | owner-routed | Associate a terminal worker or a verified native app conversation with a fiber |
| `POST /migrate` | local owner | Move a live worker from one installed fiber to another on the same host, without ending its conversation |
| `POST /capture` | recorder-routed meeting; owner-routed agent | Launch a session from a free-text prompt; meeting mode starts hark on the selected recorder before routing the scribe capture |
| `POST /meeting/join` | recorder-routed; delivery owner-routed | Record on the selected recorder and join the meeting to an existing constitution's worker |
| `POST /meeting/start` | recorder-routed | Record on the selected recorder, mirrored toward `origin`, with no agent; answers the transcript's path on `origin` |
| `POST /meeting/system-audio` | recorder-addressed | Enable or mute system transcription in an unpaused live desktop meeting with `{recorder?, launch, enabled}` |
| `POST /meeting/pause` | recorder-addressed | Pause or resume both desktop tracks with `{recorder?, launch, paused}` |
| `GET /voice` | recorder-routed | Live microphone state, selected target, pending speech and last delivery |
| `GET /voice/transcript` | recorder-addressed | Resolve the current following transcript as `{path, launch, recorder}` for the file reader; no capture control |
| `POST /voice` | recorder-routed | Persist `{enabled?}` and control `{muted?}`; returns voice state |
| `POST /voice/target` | recorder-routed | Append a timestamped speech destination `{fiber_id, origin?}` |
| `POST /voice/draft` | recorder-routed | Edit held speech through a displayed checkpoint `{id, after, through, text}` |
| `POST /voice/release` | recorder-routed | Consume a displayed checkpoint `{id, after, through}` before a composer send |
| `POST /meeting/stop` | recorder-addressed | Stop the addressed recording or dismiss its failed tmux pane |
| `POST /attachments` | owner-routed | Store files attached in the board's composer on the fiber's host and return their paths |
| `POST /deliver` | owner-routed | Put text in front of a fiber's worker: message a live session, else resume (or dispatch, if it never ran) with the text as From User. With `context_only` and a `message_id` it queues the text in the fiber's context mailbox instead; adding `unless_live` answers 409 `{live: true}` while a worker is live, else queues for the next worker (`status: queued_for_next_worker`) |
| `POST /felt-edit` | owner-routed | Shell `felt edit` on the owning host — felt keeps the validation |
| `POST /felt-nest` | owner-routed | Shell `felt nest` on the owning host |
| `POST /fiber/create` | owner-routed | Create a fiber |
| `POST /project-dir/resolve` | host-addressed | Validate `{path, origin?}` on the named host with `shuttle resolve-dir`; return `{path}` with the expanded absolute directory, or 422 for an invalid directory. Does not create or arm a fiber |
| `POST /felt-stores` | host-addressed | Persist a daemon's registered felt stores (whole list; takes `expected_digest`) |
| `POST /projects` | host-addressed | Register a picker project and initialize its `.felt/` when needed, or set the whole list with `projects: [...]` (which takes `expected_digest`) |
| `POST /config/:id` | host-addressed | Replace one operator file's text, validated first by whoever owns its grammar |
| `POST /agents/effort` | host-addressed | `{id, effort}` sets one agent's default effort, `effort: null` resets it — shells `shuttle agents effort <id> <level>\|--reset` |
| `POST /fleet/remotes` | host-addressed | Add, replace or remove one remote — shells `shuttle remotes add\|rm` |
| `POST /tunnels` | host-addressed | `install` or `preview` a host's supervised tunnel jobs — shells `shuttle tunnels install [--dry-run]` |
| `POST /choose-folder` | host-addressed | Open the named host's native folder picker and return the chosen path. Blocks for as long as the human takes, so the forward outlasts the dialog's own five-minute bound |
| `POST /attach` | **not** owner-routed | Open a worker or past-session viewer on the local display using Kitty or Rex; remote tmux uses SSH, and remote Rex opening is unsupported |
| `POST /sessions/resume` | local | Start (or find) a past session's terminal viewer; an active terminal Codex worker reuses its owned thread |
| `POST /sessions/prepare-terminal` | host-addressed | Prepare the terminal viewer of an owned Codex thread by fiber UID or recorded tmux name, without starting a turn |
| `POST /sessions/receiver` | host-addressed | Resolve the live native Codex process for `{session_uuid}` and return `{session_uuid, pid, process_start}` from a kernel lifetime probe; 404 means absent or stale, 503 means process state is unknown |
| `POST /messages` | host-addressed | Deliver a durable, idempotent text message to an exact `shuttle://HOST/HARNESS/NATIVE_ID` address |
| `POST /messages/files` | host-addressed | Deliver a message with receiver-local attachment copies to an exact session address |

### Following transcript

`GET /voice/transcript?recorder=<host>` resolves hark's current following transcript on the selected recorder.
An absent recorder means this daemon; `origin` names the speech recipient and does not select the recorder.
The response is `{path, launch, recorder}` with `Cache-Control: no-store`.
Open `path` through `/file?path=<path>&origin=<recorder>` so the reader fetches the recorder's bytes, not the target card's files.
The resolver only accepts the launch's regular `.txt` file inside hark's `voice` directory and refuses symlinks at the directory or file.
It returns 404 when no transcript is available, 400 for an unknown recorder, and 502 when that recorder cannot be reached; it never falls back to another host.
Resolving the transcript does not start, stop, or reconcile audio capture.

### Fiber creation

`POST /fiber/create` takes `{id, name, body?, frontmatter?, origin?, uid?}`.
The owning daemon addresses `id` in its configured namespaces, without requiring the immediate parent document to exist.
The nearest existing ancestor determines the physical namespace and local address, including through linked project stores.
A project whose `.felt` points into a subtree uses the enclosing store's namespace, so the project prefix is not added again.
It validates an armed constitution's `project_dir` on that host and stamps its `shuttle.host`.
Without an existing ancestor, creation prefers the cwd's namespace when that namespace is polled, then the primary store. The worker cwd does not create or register a store.
The owner resolves and checks the intended physical destination before writing and checks the resulting path before confirming; a path outside every polled store is refused.
Transferred UIDs already present on the owner are refused; unreadable matching UID candidates are resolution failures, not permission to transfer.
The response is `{id, path, uid, host, status}` after an exact read-back; `id` echoes the requested namespace address and `path` identifies the physical destination.
Before cross-host creation or `resume --project-dir`, the CLI reads the owner's live `/version?origin=<owner>` and requires `contract_level >= 31`.
`GET /version` publishes `contract_level` even while the daemon is booting; with `origin`, it forwards to that owner.
`path` is the owner's Markdown filename, `uid` is the intrinsic fiber identity, and `host` and `status` confirm the owning host and persisted status.
A resumed local draft is retained unless the response confirms the requested identity and armed status.
A supplied `uid` preserves an existing document's identity during transfer.
Metadata injection uses a locked source-digest check.
A concurrent edit is retained and reported as a create error; the initially created fiber remains present, so inspect it before retrying.
An unavailable owner fails the request, and a duplicate document is refused rather than overwritten.

### Lifecycle actions

`POST /lifecycle` takes `{fiber, action, origin?}` plus the action's own
fields, and runs the matching `shuttle <action>` on the owning host:
`install`, `repeat`, `reshape`, `pause`, `rest`, `resume`, `accept`, `close`, `reopen`,
`set-model`, `set-agent`, `role`, `seat`, `set-outcome` or
`uninstall`.
Lifecycle requests can carry `fiber_path`, an exact namespace path verified against the requested UID before a full UID search.
A stale or mismatched hint falls back to UID resolution; it never changes the requested identity. Hint read errors and timeouts are resolution failures, not stale hints.
The writer reads the resolved address directly, without convenient lookup or remote fallback. UID-less documents retain exact path addressing even if the file disappears between resolution and the write.
An authoritative miss returns 404 with `{error_code: "fiber_not_found", host, fiber, error}`.
Ambiguous identities and resolution failures are not misses and never authorize a draft transfer.
The `role` action takes `role: <role-slug>`, or `clear: true` to remove both role and seat.
An optional `new_name: "Office name"` passes `--new "Office name"` to the CLI to create a missing charter in the shared namespace.
Existing charters are preserved, and without `new_name` the charter must already exist.
The `seat` action sets `shuttle.seat: true` and requires an assigned role; `clear: true` removes the seat field.
`accept`, `resume`, `role`, `seat` and `rest` run the Shuttle CLI's write verb (`shuttle <verb> <fiber> --local`) inside the
owning daemon's Poller, serialized with its state changes — a rest then stops
any live worker through its backend — which then refreshes
that fiber's document cache; a poll read in flight sees the old document or
the new one, whose status and `handed_off_at` land in one atomic write. The
outcome is always kept. A success is 200 with the Shuttle CLI's output as
text. A Shuttle refusal is 422 with `shuttle exited <status>: <message>`; an
unknown action or a missing field is 400.

Lifecycle requests, dispatch requests (including remote `reopen`), and `GET /fibers/*id` return 404 when the owning daemon lacks the document.
The error names the host and fiber identifier.
Lifecycle identifiers are intrinsic ULIDs or exact enclosing-store-relative paths; an absent path never falls back to its last segment.
The CLI forwards the ULID when the fiber has one.
`resume` accepts `project_dir` in the same serialized write that arms the constitution.
No request runs Git or `felt sync`; remote creation writes the document through `POST /fiber/create`.

`GET /api/v1/version` includes `terminal`, the local host's configured `tmux` or `rex` backend.
For Rex terminal claims, `tmux_session` and `tmux_pane` carry the native `session:` and `block:` references respectively.

### Worker migration

`POST /migrate` takes `{from, to, session_id?, tmux_pane?, rest?, disabled?}`.
Both fibers must be installed on the receiving daemon's host, and the destination must have no live worker.
The daemon serializes the move with polling, writes both runtime blocks through `LifecycleStore`, and moves the watcher, session binding and durable worker assignment.
For tmux workers it renames the session without replacing its pane or process; Codex conversations keep their native thread identity.
The destination becomes active with the moved `session_uuid` and a new `dispatched_at`.
The source loses its session identity and stays active for a fresh worker from `## Status`; `rest: true` leaves it open with `horizon: stashed`, and `disabled: true` leaves it open in Drafts.
The two options are mutually exclusive.

A durable migration journal pins the session identity, backend and before/after values of touched fields before the backend moves.
Recovery finishes or reverses interrupted moves before ordinary adoption and dispatch.
Journals live in `$SHUTTLE_DATA_DIR/migrations/<sha256(host-id)>/` (the data directory defaults to `~/.shuttle`); only the daemon's frozen host identity may replay them.
Other hosts' namespaces and flat journals are logged and ignored, never used to hold unrelated launches.
Matching flat journals are relocated into their owner's namespace before replay.
Changing `~/.shuttle/host` does not transfer pending migrations: finish recovery before changing the identity, or restore the old identity and restart to recover.
Do not rename a namespace or edit a journal's host to adopt it; backend ownership and installed fiber anchors must agree with the original owner.
Fiber changes use both documents' advisory locks and preserve their current bodies and untouched fields; the journal never stores historical bodies.
An unresolved migration holds every launch, including force-dispatch, cron and previously observed workers.
Restore the recorded backend or reconcile conflicting fiber fields, then restart the daemon to retry recovery; keep the journal and surviving worker intact.
Tmux intent captures the native session UUID and the tmux session ID, creation time, pane IDs and pane PIDs before any rename.
Replay verifies the captured panes at the source or destination, then addresses a rename by the captured tmux ID rather than the reusable name.
A replacement conversation causes `backend_identity_mismatch`; the journal is durably marked `unresolvable` with that reason, and restart holds launches rather than retrying the replacement.
A journal without captured tmux identity requires operator reconciliation; recovery never invents identity from a reused name.
Recovery validates the complete journal schema before executing any pending move.
Invalid JSON, unsupported versions and incomplete or wrongly typed records hold launches without crashing startup; the hold names the file and invalid field.
`GET /api/v1/version` exposes `reconciliation_hold`, and `shuttle doctor` reports it even when the CLI contract matches.
`shuttle daemon release` cannot clear a reconciliation hold.

To clear an invalid journal, stop the daemon and back up the named file outside the migrations directory.
Inspect both fibers, the session ledger and the native backend to determine which fiber owns the surviving conversation; repair its assignment and runtime fields consistently without stopping that conversation.
Restore a valid journal from backup to let recovery finish, or, only after manually reconciling those resources, move the invalid or unresolvable file outside the migrations directory.
For an identity mismatch, preserve the replacement conversation and reconcile the original resource separately; never clear the marker merely to retry against the replacement.
Restart the daemon, confirm that `shuttle doctor` no longer reports the hold, then release the boot quarantine.
Removing a journal alone is not recovery: it discards the evidence that prevents duplicate launches.

Success returns `{ok: true, from, to, session_uuid}`.
A retry identifying the same session and destination succeeds without moving it again.
Refusals carry a `reason` and a corrective message, including `not_installed`, `already_running`, `other_host`, and `same_fiber`.
Ordinary refusals return 422; incomplete rollback or unresolved recovery returns 503 because the assignment needs inspection rather than a blind retry.
Messages to the destination follow the moved session; messages to the source wait for its next worker.
Messages to the exact session address keep reaching the same conversation.
No conversation context is copied or merged.

### Capture and meeting mode

`POST /capture` accepts an optional `meeting: {mode: "call" | "phone"}` object
and an optional `recorder` host id. Workers run through the selected terminal
backend, including Codex CLI workers.
Meeting mode starts hark on the selected recorder before owner-routing the capture, so recording and the scribe can run on different hosts.
Meeting mode allows `prompt` to be omitted and replaces the prompt with the meeting's facts
(mode and transcript path, plus a pointer to the shuttle skill's
`references/meeting.md`) followed by the user's note.
The capture scribe infers the meeting's identity, participants, and filing location from the transcript and felt tree; it doesn't require a title before recording.
It replaces `meeting` with
`meeting_launch`, the recording's launch id, before forwarding, so the owner
handles an ordinary terminal capture whose supplied `Claim` body carries
`meeting: <launch id>`. The transcript is mirrored to the
remote project host when `origin` names a configured remote with an SSH alias.
A successful terminal capture answers with `session_uuid` when the launch
assigned the harness session. A successful meeting capture adds `meeting`; if capture fails after recording
starts, its status and error body also include `meeting` and `recording: true`.
Each meeting gets a transcript name no earlier recording used. The daemon watches
the new recording for a few seconds: if hark exits before it starts recording, the
scribe is not launched and the response is **503** with the failed `meeting` row
and `recording: false`. A recording that is still loading, or whose state tmux
can't report yet, counts as started (`state: "starting"`).

### Codex terminal workers

Codex workers use the Codex CLI through the owning host's selected terminal
backend. Capture, dispatch and claim responses include the worker's native
session identity and terminal coordinates. The stored `shuttle.surface` field
is ignored by execution and may remain in older fiber documents.

`/attach` prepares an existing terminal worker session on its owning host.
It does not start a model turn. A missing or uncertain terminal session is
reported without creating a replacement conversation. Historical sessions
resume through the harness and the host's session ledger.

## Remote Control status

`GET /api/v1/remote_control` is host-scoped and returns this daemon's last reconciled Claude Remote Control status.
Reading it does not trigger reconciliation or start a host.
The daemon reads host.json's `remote_control` configuration every 30 seconds; the host runs independently of the worker boot quarantine.

| Field | Meaning |
|---|---|
| `state` | `disabled`, `running`, `waiting`, `starting`, or `error` |
| `dir`, `args` | Configured absolute directory and literal extra arguments; `null` and `[]` while disabled |
| `pid` | tmux pane PID, or `null` when not observed running |
| `started_at` | Session creation time, retained across daemon adoption, or `null` |
| `restarts` | Successful starts during this daemon lifetime, including its first launch; adoption doesn't increment it |
| `last_exit` | `null` or `{status, at, screen}`; status is an exit code or `null` when unknown, and screen is up to 20 nonempty lines |
| `next_attempt_at` | Retry time, or `null` |
| `message` | Diagnostic text, or `null` |

Timestamps use UTC ISO 8601.
A dead pane's own death timestamp measures lifetime even when the daemon adopts it later.
A missing session without that timestamp counts as a short failure.
Uncertain tmux or process observations hold instead of authorizing a launch.
`shuttle remote-control [--json]` reads this endpoint using the local daemon transport.

## Read plane

| Route | Routing | Purpose |
|---|---|---|
| `GET /fibers` | local | Every fiber this daemon's stores expose |
| `GET /fibers/composite` | fan-in | The cross-host board feed, with reconciled per-host liveness |
| `GET /fibers/*id` | owner-routed | One fiber by canonical id, body fetched from its owner |
| `GET /search` | local | Search constitution bodies in this daemon's configured stores |
| `GET /transcripts/search` | local | Full-text search over every transcript on this host, grouped by session (best message plus `matches` count; `limit` counts sessions) — shells `shuttle transcript search --json` (`q`, repeatable `session`, `fiber`, `since`, `harness`, `limit`, optional `per_message=true` for individual rows) |
| `GET /roles` | local | Shared role charters as an array of `{slug, name, outcome}`; shells `shuttle roles --json` in configured stores, deduplicates by slug, and sorts by slug. CLI failures or malformed responses contribute no roles (200, empty array when none are available). Role charters are synchronized documents, not owner-routed host state |
| `GET /remote_control` | host-scoped | Reconciled Claude Remote Control host status, last exit screen, and retry time; see [status fields](#remote-control-status) |
| `GET /agents` | host-addressed | The effective agent registry (shells `shuttle agents --json`) — a per-host fact, since the built-in layer travels with that host's shuttle binary |
| `GET /felt-stores` | fleet-aggregating | The registered store list, this host's live and each remote's off the cached owner feed (`stores` block) |
| `GET /config` | host-addressed | Every operator file on a host: path, whether it exists, size, mtime, and any environment variable overriding it |
| `GET /config/:id` | host-addressed | One operator file's text and digest — `stores`, `projects`, `agents`, `remotes` or `host` — plus `entries` for the two path lists |
| `GET /fleet` | host-addressed | A host's fleet as rows: the normalized fleet file and its discovered tailnet peers (each row's `source` says which), joined to live reachability and each remote's build |
| `GET /file` | owner-routed | Raw bytes by absolute path, with `ETag` / `Last-Modified` conditional GET; HTML, XHTML and SVG carry a CSP sandbox without `allow-same-origin` |
| `GET /file-assets/:origin/*path` | owner-routed | The same raw bytes under a path-shaped URL, so HTML reports resolve sibling images, CSS, and scripts; no CORS access for opaque origins |
| `GET /file-info` | owner-routed | File existence, mtime, and size without downloading bytes — metadata for browser-native artifact refreshes |
| `GET /transcript` | host-routed | Availability receipt for a native session transcript, including its authoritative path and digest |
| `GET /transcript/raw` | host-routed | Exact native JSONL bytes for a session — no parsing or normalization |
| `GET /transcript/stream` | host-routed | Follow complete transcript records as server-sent events |
| `GET /transcript/messages` | host-routed | Exact Shuttle message envelopes recorded for a receiving conversation |
| `GET /sessions/links` | host-routed | For a batch of sessions: transcript present, harness, and a bridged Claude session's claude.ai URL |
| `GET /peers` | fleet fan-in | Discover addressable live sessions; `?local=true` serves only this daemon's owner-local sessions |
| `GET /meeting` | host-addressed | Report the selected host's hark availability, supported meeting modes and meeting state |
| `GET /meeting/audio` | recorder-addressed | WebSocket: relay a phone's microphone through the serving hub to the selected recorder |

`GET /fibers/composite` and `/state/composite` return a weak `ETag` and
`Cache-Control: no-cache`. Their validators exclude the volatile `generated_at`
field: a 304 means the fiber/state content is semantically unchanged. The board
keeps its existing copy and tracks poll time itself; remote-origin freshness
continues to describe the body that would have been returned.

`GET /fibers?fields=index` returns the local wikilink and parent-picker index: only `id`, optional `slug`, and `name` inside each `fiber` row.
The first request shares one live listing with concurrent callers.
Warm requests return a pre-encoded in-memory response; after 30 seconds, the next request starts one background refresh and returns the cached response immediately.
Store-registry changes become visible through that refresh, and a failed refresh retains the last successful response with a 30-second retry interval.
A strong `ETag` hashes the response bytes; matching `If-None-Match` returns 304 with an empty body.
Full metadata and `body=true` listings without `fields=index` stay live.
`shuttle=true` without bodies takes precedence and serves the poller's owner feed, independently of the all-fiber index cache.

Each constitution entry in the owner's Desk feed has `orchestrator`: the wire id of its nearest strict ancestor carrying a `shuttle:` block and no tempered or discarded verdict, or null for a top-level constitution.
The relation skips intervening ordinary fibers and retains ancestors owned by another host, even though those ancestors do not appear in this owner's rows.
Containment uses canonical slugs within each felt store; existing fiber, path, report and runtime fields remain unchanged.

An owned constitution entry with no live worker carries `pending_results` while something waits for its next worker: the number of thread results and messages in its context mailbox, plus results addressed to it still in the owner's outbox. The field is absent when nothing waits or a worker is live.
The owner counts after each poll's delivery pass, so a count trails a new arrival by up to one poll; the composite carries each remote owner's count unchanged.
`GET /threads/*id` carries the same count on the orchestrator (`pending_results`) and on each thread this host owns.
Thread lifecycle state comes from each owner's document feed, including fibers
absent from the local archive. Each node and the root carry `stale`,
`host_unreachable` and `owner_cache_state`. An unreachable owner's archive
fallback is stale and retains its last recorded state. A reachable owner with
an incomplete (`cold` or `partial`) cache reports `Unknown` rather than inferring
live state from an archive copy; `host_unreachable` stays false.

The owner feed's live-worker `runtime` carries `tasks` beside its existing `phase` and session fields.
Each task has `{id, subject, status, activeForm}`; `activeForm` is null when the harness supplies none.
The asynchronous daemon poll reads Claude Code's session task directory in numeric id order and follows Codex's native transcript for the latest valid `update_plan`.
Missing or malformed task records yield no tasks; a worker without a checklist has `tasks: []`.
The snapshot's running-worker rows carry the same checklist, and the owner feed performs no harness filesystem reads while serving a request.

`GET /meeting?recorder=<host>` returns `{available, modes, recorder, meeting}` from the addressed daemon.
`origin=<host>` also supports host-addressed reads.
A meeting's optional `handoff` receipt retains its intended `kind` (`capture`, `fiber`, or `record`), `target` (project directory or fiber), `origin`, and full agent `prompt` for manual recovery.
The recorder saves this host-local, launch-keyed receipt before launching hark, under its Hark directory's `handoffs/<launch>.json`.
Reads expose a pending delivery as `status: "unconfirmed"`; completed requests report `reported-success` or `reported-failure`, while intentional recording without a scribe reports `record-only`.
Reported success describes the delivery response, not whether a worker followed the transcript.
The board warns on unconfirmed or failed delivery; inspect the intended worker before manually sending the saved prompt, because an interrupted request may already have delivered it.
The daemon never automatically replays a handoff.
`modes` lists the recording inputs that host supports: `call` (its microphone and system audio) or `phone` (streamed phone microphone).
Without hark, the list is empty.
`GET /meeting?prefer=phone` asks the serving daemon to select a reachable remote recorder advertising `available: true` and `call`; it uses the local recorder if no remote qualifies.
Capability probes belong to the daemon and have short bounded deadlines; the browser never probes remote hosts.
Capture and Join offer one Meeting toggle: desktop uses `call`, and mobile uses `phone`.
The toggle is disabled when the selected recorder lacks the device's required mode; desktop never falls back to `phone`.
A remote Mac still records in `phone` mode when the microphone is on the phone.
The board's host picker chooses the scribe host, not the recorder, and the controls name the selected recorder.
The preview recorder is advisory for a new phone start: Capture and Join omit an explicit recorder so the daemon checks reachability again before recording.
The returned meeting's recorder is authoritative.
An active recording pins polling and Stop to that recorder instead of selecting again.

Each origin in `GET /felt-stores` also reports `browser_capable`.
It is true only for a macOS daemon whose user has an active GUI session.
Capture and Stash offer `--chrome` only when both the selected host and selected agent support it.

`GET /peers` returns `{host, sessions, gaps}`. Fleet discovery queries each
configured daemon once with `local=true`; an offline, old, timed-out, or
malformed peer becomes an explicit `{host, error}` gap while successful peers
remain usable. A session row includes `fiber` and `fiber_uid` when its host
knows the pairing. Returned addresses
use the configured routing alias and canonical harness name:
`shuttle://HOST/HARNESS/NATIVE_ID`, where `HARNESS` is
`claude`, `codex`, or `pi`.

`POST /messages` accepts `{address, text, from, wake, message_id}` with a full
`shuttle://` address. The parser accepts known ledger or registry spellings,
such as `claude-code`, and normalizes the routed address and receipt to the
canonical harness name. The CLI also resolves unique native session IDs and
fiber paths, slugs, or UIDs before calling this endpoint. Omitting `wake`
requests an active task turn; set `wake: false` explicitly for context-only
delivery. The CLI's default also sends `context_if_busy: true`, which lets a
busy Claude receiver with a native endpoint and sender return address queue context for `UserPromptSubmit` or `PostToolUse`.
A full queue, oversized message, or missing return address uses native delivery instead.
`context_if_busy` must be a boolean and requires `wake: true`.
Unassigned mail falls back after 30 seconds or as soon as the receiver isn't working.
Queued receipts trigger serialized recovery; pending mail gets one-second checks, with a boot pass and a one-minute safety sweep.
Queue age and the hook/native claim survive daemon restart.
A forced wake without that field never silently becomes context-only delivery. The address selects the
owner strictly; an unknown host is refused rather than attempted locally. Its
receipt reports the furthest observed submission stage (`accepted`,
`context_added`, `submitted`, `queued`, `subscribed`, `unknown`, or `rejected`), transport, and detail;
it does not claim that the recipient acted on the message. For Claude-native
delivery, `queued` means the receiver queues it behind its current turn,
`submitted` means the transcript shows it admitted as a user turn, and `accepted`
means a correlated real assistant reply appears. Hook-mailbox `queued` is
context-only and starts no turn. With `wake: true`, Claude-native
`queued`/`submitted` receipts are valid; `context_if_busy: true` also permits a
Claude-hook `queued` receipt, and `context_added` once the main-thread hook writes it as context.
A retry with the same message ID returns that confirmation or the native fallback receipt.
Native admission alone never means a model reply.
Fallback waits briefly for admission or refusal rather than observing a model response.
Preflight failures return mail to the hook queue and retry at most three times.
A terminal failure, exited receiver or ambiguous interrupted write produces a durable failure notice to the sender's session return address.
Claude's native approval policy applies to fallback; Shuttle cannot start a turn that Claude holds for approval.
The routing hint isn't part of the message's retry identity, so adding or stripping it across a mixed-version fleet doesn't cause an ID conflict.

`from` names the sender, as given; a request without one reads `[from external]`.
Messages produced inside the daemon are `from: shuttle`.

`notify_when_idle: true` subscribes `from`, which must be a `shuttle://`
address, to one idle notice from the receiver; `notify_wake: true` makes that
notice wake the subscriber. With it, `text` may be empty: the receipt is then
`subscribed` and nothing is delivered. Every receipt for such a request carries
`idle: {state, signal, detail}`, with `state` `watching` or `unsupported`. See
`shuttle message --notify-when-idle` in the CLI reference.

A processed delivery returns HTTP 200 for any receipt status, including
`rejected` and `unknown`. HTTP 400 corresponds to `invalid_address`,
`wrong_host`, `invalid_request`, `unsupported_harness`, and `preflight_failed`
(which releases the message ID), even when Felt supplies a rejection receipt.
A `message_id_conflict` returns 409. Other rejected receipts—including
`session_unavailable`, `session_not_found`, `wake_required`, and `wake_refused`—
return 200. HTTP 5xx means Felt did not provide a valid receipt or the owner
could not be reached; the daemon may include a synthetic `unknown` receipt.

Reusing a `message_id` with the same request returns its durable receipt. A
concurrent identical request waits until the owner's recorded observation
deadline plus 1.5 seconds, capped by the request deadline. If it remains in
progress or its owner stops before saving a result, felt returns `unknown`
without resending. A later retry of a completed Claude-native `queued`,
`submitted`, or `unknown` receipt rechecks the transcript for up to two seconds
from its saved offset and upgrades the receipt if it finds later evidence; it
never sends to the receiver again. Receipts without a saved offset remain
unchanged. Reusing the ID for changed content is rejected by the local felt
adapter.

`POST /messages/files` accepts the same envelope plus one to eight
`attachments`, each `{name, data, sha256}`. `name` is a portable basename,
`data` is base64, and `sha256` is lowercase hexadecimal. Decoded attachments
may total at most 20 MiB. Successful receipts include
`files: [{name, path, sha256, size}]`, where each path names the receiver-local
copy. File-bearing envelopes are refused on `/messages`; this dedicated route
prevents an older daemon from silently dropping fields it does not recognize.

### Live voice

`GET /voice` returns `{available, enabled, muted, state, target, cold, held, pending, preview, last, error, recorder}`.
An optional `recorder` selects the recording daemon, independently of the receiving worker's `origin`.
Without it, the receiving daemon is the recorder.
`state` is `off`, `starting`, `listening`, `yielded` (a meeting owns the microphone), or `failed`.
`target` is `{fiber_id, origin, name}` or `null`.
`cold` says whether the selected target is dormant or has been idle for at least `cold_minutes`.
A working target is warm regardless of the age of its last event; unknown or stale owner activity is cold.
`held` is a list of `{id, fiber_id, origin, after, through, text, segments}` drafts, retained across target switches, mute, recorder replacement and daemon restart.
`after` is the last consumed segment (initially 0); it advances when an earlier prefix is released while later speech remains, even if `through` is unchanged.
`segments` contains the current `{through, text}` pieces in order; their text concatenates to `text`.
Editing a displayed prefix coalesces its segments at that prefix's ending checkpoint, preserving later segments.
A composer appends only segments beyond its displayed checkpoint, so an edit response lost before more speech arrives cannot make repeated words disappear through ambiguous string-prefix matching.
`through` identifies the last finalized speech segment included in that draft.
`pending` is `{fiber_id, words, text}` or `null`, holding finalized warm speech before a delivery trigger.
`preview` is `{fiber_id, origin, text}` or `null`, displaying raw in-progress words from hark's atomically replaced `<stem>.partial` on the current target.
Missing or empty partials, mute, disabled voice and recorder exit clear the preview.
Preview words never enter the relay, held drafts or delivery; only final transcript rows fill the composer.
`last` is `{fiber_id, at, status, detail?}` or `null`, with `status` `delivered`, `unconfirmed` or `failed`.
`enabled` reports the persisted intent even if recording fails. Invalid or unreadable `voice.json` fails off: `enabled: false`, `state: "failed"`, and `error` describes the configuration failure while the daemon stops any live voice recorder.

`POST /voice` accepts `{enabled?, muted?, recorder?}` and returns the same state.
Both control fields must be booleans; invalid input returns **422**.
Enabling persists to `voice.json`; muting uses `hark pause` and survives recorder restarts.
The daemon keeps one retained `hark --voice` running while enabled and adopts it after daemon restarts.
Crash retries wait 1, 2, 4 and 8 seconds; five failures latch `failed` until enabled is toggled off and on. A recorder stable for 30 seconds resets the failure budget. This retry budget belongs to the running daemon; a daemon restart starts a fresh budget.
There is no scheduled recorder restart.
Every meeting start stops live voice and verifies the recorder has exited before opening another capture; voice returns after the meeting ends or fails, with the same PID-exit verification before replacement.
Voice captures are hidden from `/meeting`, its stop, pause and system-audio controls, including stale-launch errors.
Disabled, idle voice checks lifecycle-file changes without polling the terminal; startup always observes retained captures so an orphan voice recorder is stopped.

`POST /voice/target` accepts `{fiber_id, origin?, recorder?}` and durably appends `{t, fiber_id, origin, name}` to `voice-routes.jsonl` under the daemon's data directory.
`t` is the recorder's UTC receipt time, not the time reconciliation finishes.
Use a durable fiber UID so renaming doesn't change the destination.
Each utterance uses the route in force at its spoken-start timestamp (`wall` in hark's JSONL), even if recognition completes after a target switch.
A target switch flushes warm pending words to the old target immediately; cold speech stays with its card.
No selected target means no delivery; the recording still retains the words.
An unreadable or malformed route journal, or a failed recovery truncation, leaves voice failed off with a visible `error`; repair the journal and restart the daemon before recording or selecting a target.

`voice.json` is an operator file exposed by the config API as id `voice`, beside `host`.
It defaults to:

```json
{"enabled": false, "words": 200, "quiet_seconds": 15, "cold_minutes": 5}
```

The word limit is a positive integer; the quiet interval is a positive number of seconds.
Both apply to voice and meetings.
For existing nested settings, each top-level value takes precedence, followed by `voice`, then `meeting`, then the default.
Saving Listening settings replaces the nested `voice` and `meeting` objects with the shared top-level values, preserving other top-level fields.
`cold_minutes` is the positive number of minutes after which a worker is cold.
`POST /voice` with `enabled: false` can repair an invalid operator file by replacing it with disabled defaults. Valid files retain their thresholds and unknown keys.
The daemon's shared monitor checks once a second and flushes on the word limit, a name (`claude`, `cloud`, `clawed`, `claw`, `klaud`, `clot`, `clock`, `clod`, `claud`), or quiet since the last spoken line.
Name detection is always on.
Comments travel with the next batch and `# ended` closes the monitor.
An incomplete final voice JSON row is retained on disk and reported in a closing comment rather than held open indefinitely.
The monitor persists read offsets, buffers and stable message IDs before delivery, so restart recovery doesn't replay confirmed speech.

Cold speech doesn't deliver on word count, quiet, switching target or capture end.
It fills an editable range in that card's composer without replacing typed text or moving the cursor.
`POST /voice/draft` replaces only the held prefix through its checkpoint, preserving any later speech.
Both mutations include the displayed `after` boundary and return 409 if another delivery has consumed any of that displayed prefix; later appends do not invalidate it.
`POST /voice/release` consumes that prefix before Send, Resume or New session delivers the box's edited text.
A consumed checkpoint returns **409**, so a button cannot repeat a name-triggered delivery.
Saying a name consumes everything held through that utterance and uses the default delivery verb: paste to a live worker, resume a dormant conversation, or start a never-run card.
The owning daemon resolves resume versus first start from its current document, independently of recorder caches.
A failed or interrupted name delivery retains the resolved edited text in durable recovery state and exposes it in `last.detail` for an explicit retry; it never automatically resubmits an uncertain attempt.
A worker warmed through any path gets ordinary triggers on its next speech.

Voice batches contain speaker-labelled paragraphs, joining consecutive lines by one speaker, with no header or timestamp.
Live workers take them as terminal input through `/deliver` with `live_input: true`; dormant targets receive the same text as their launch directive.
A prior conversation uses `resume_mode: "previous"`; a never-run card starts fresh.
Registered batches stay ordered per destination, while different destinations can proceed independently.
A failed voice delivery is recorded in `last` and dropped from the delivery queue; it isn't retried indefinitely, and its words remain in the transcript.
A **202** response with `delivered: null` is unconfirmed, not sent.
`last` reports `status: "unconfirmed"` and explains that the message may have arrived and the transcript retains the words.
The relay does not automatically replay an unconfirmed voice batch, since doing so could duplicate speech already delivered.
Only an explicit `delivered: false` or a non-2xx response is a failed send.
Meeting batches retain their stable IDs and retry definite failures.

### Meetings

`GET /meeting` without a selector reports local capabilities and recording state, so daemon capability probes cannot recursively select another recorder.
The answer includes `{available, modes, recorder, meeting}`.
Use `recorder=<host>` for an explicit read, or `prefer=phone` for capability-based selection.
Hark exposes no capability-reporting CLI protocol, and its help includes device flags even on Linux.
The daemon therefore derives `modes` from hark availability and the OS: macOS offers call/phone; other hosts offer phone.
The row is `null` when the addressed daemon has no meeting capture to report. Otherwise it carries
`state`, `title`, `started_at`, `tail`, `transcript`, `mirror_host`,
`fiber`, `joined`, `phone`, `launch`, `recorder`, `tmux_session`, and `error`.
`recorder` names the daemon that owns the recording, independently of the agent's owner. `phone` is
true when the meeting takes its audio from a phone (`mode: "phone"`), so a page
can offer to connect one; `launch` is the recording's launch id, which a phone's
audio socket binds to. `tail` is the
transcript's last spoken lines (at most 30, oldest first, `#` lines left out),
read from the end of the file on each request, so the route stays cheap to
poll. `fiber` names the fiber whose card the meeting rides on. For a joined
meeting (`joined: true`) it is the constitution. For a capture meeting it is
`null` until the scribe claims, then the fiber whose `shuttle.runtime.meeting`
equals the recording's launch id, looked up on each request across this
daemon's fibers and the remote feeds it polls. The scribe's host never has to
reach this daemon, and a renamed fiber is still found. `mirror_host` is the configured remote name when
the transcript mirror's SSH alias matches a remote; otherwise it is the alias.
A `null` mirror host means the transcript is local.

`POST /capture` accepts `meeting: {mode: "call" | "phone"}`.
`call` records this machine's microphone and system audio, including in-person meetings with silent system audio.
`phone` records a phone's microphone streamed in over `GET /meeting/audio` (hark `--phone`).
The daemon derives
the meeting title and transcript name from the first line of `prompt`, or uses
`Meeting` when no note is supplied.
It starts hark in the selected recorder's `hark-meeting` terminal launch, then continues the ordinary owner-routed capture flow.
A `phone` start without an explicit `recorder` uses capability-based selection; other modes default to the receiving daemon.
The `origin` remains the agent's owner when the request crosses to a recorder, including when the owner is the requesting hub.
For a remote `origin`, hark writes locally and mirrors to
`~/.hark/meetings/<name>.txt` through that remote's configured SSH alias.
The capture agent receives the scribe message and the optional user note as its
prompt. `project_dir` remains required by the ordinary capture flow.

An unavailable hark executable returns **503**. An existing meeting in
`starting`, `loading`, `live`, or `stopping` returns **409** with its row.
Meeting mode rejects an invalid mode or a mode unsupported by the recorder with **422**.
If capture fails after hark starts, the capture's status and error body include
the meeting row and `recording: true`; recording continues on its recorder.
The capture transcript monitor starts only after successful scribe dispatch, including a forwarded owner's `spawned: true` response. If monitor startup fails, the successful capture response and recording are preserved; `meeting.relay_error` reports the monitor failure.
A transport failure after forwarding a start returns `recording_unknown: true` and the recorder address.
The hub never retries or falls back to another recorder after attempting that write: the first recorder may already be recording.
Capture and Join hold further starts after an ambiguous answer and instruct the operator to inspect the recorder before starting another meeting.

`POST /meeting/join` accepts `{fiber_id, origin?, recorder?, meeting: {mode, system_audio?}, note?, resume_mode?}`. It
starts hark exactly as meeting capture does, mirrored toward `origin`, and names
the recording after the note's first line or, with no note, the fiber's leaf.
The meeting message (the same facts as a meeting capture's, plus a line saying
the meeting joins this constitution) and the note go to the fiber's worker
through `/deliver` on its owner. `resume_mode` selects the session as it does
for `/dispatch`: `previous` messages a live worker or resumes a dormant one, and
`fresh` starts a new session, cutting a live worker. The answer is `{meeting, delivery}`, where
`delivery` is `/deliver`'s body; if delivery fails after hark starts, it carries
the delivery's status with `recording: true` and `error`, and the recording
continues.
Shuttle also sends transcript batches and the end marker to the worker while hark records.
Capture meetings use the same monitor after the scribe claims its fiber, beginning at the transcript's first line.
Neither board flow needs `shuttle follow`.
Start errors are the same as meeting capture's.

`POST /meeting/start` accepts `{origin?, recorder?, meeting: {mode, system_audio?}, note?}`
and records without any agent: no capture is routed and nothing goes to
`/deliver`. It is for a caller that follows the transcript itself, such as a
session the daemon did not launch (`shuttle meeting start`, then
`shuttle follow`). It selects the recorder and starts hark exactly as Join
does, mirrored toward `origin`, which defaults to the receiving daemon, and
names the recording after the note's first line or `Meeting`. The answer is
`{meeting, recorder, origin, transcript}`: `transcript` is the path a follower
reads on `origin`. When the recorder is the origin it is the local transcript.
Otherwise the recorder can only name the mirror as
`~/.hark/meetings/<name>.txt`, and the origin's own daemon expands that `~` as
the answer passes back through it, so a caller asking its local daemon always
gets an absolute path. A path on an `origin` other than the answering daemon
stays `~/`-relative. Start errors are the same as meeting capture's, including
`recording_unknown` after an unconfirmed forwarded start.

`POST /dispatch` accepts `{fiber_id, force?, ad_hoc?, resume_mode?,
user_message?, project_dir?, release_launch_reservation?, existing_only?}` (plus `origin` to forward).
With `existing_only: true`, only a `previous` message to a live worker is allowed.
A missing worker returns 422 `no_live_worker` without arming, reopening or launching anything.
The change reader uses this form; start authority stays with the composer.
A forced start
(`force` or `ad_hoc`) never runs a worker in the felt store. Every check runs
before a session is cut or a document written: the owning daemon needs a
`project_dir` that is a directory on its host. It then arms the fiber in one
write — re-arming a closed or parked role, or reopening a closed fiber with
`shuttle reopen` — cuts any open session for a fresh start, and spawns. A start
that cannot arm its fiber answers **422** `{dispatched: false, reason:
"arm_refused", fiber_id, host, message, needs?}`: `message` is the refusal (the
Shuttle CLI's own words when the CLI refused), `host` is the owning daemon,
where any command the message names has to run, and `needs: "project_dir"`
says the directory is the problem: the block has none, or the one declared or
confirmed is not a directory there. Resend with `project_dir`, a directory a
human confirmed: the daemon resolves it with `shuttle resolve-dir`, then saves
it and arms the fiber in the same write (`shuttle reopen --project-dir`), and
the worker starts in the directory the CLI saved.

`POST /deliver` accepts `{fiber_id, text, from?}` (plus `origin` to forward). A
fiber with a live worker receives `text` through session messaging at
`shuttle://<host>/<harness>/<session_uuid>`, woken, and the answer is
`{delivered, delivery: "message", receipt}`. Otherwise the owner force-dispatches
it with `text` as the From User: `delivery: "resume"` continues its previous
conversation, `delivery: "dispatch"` starts one when it has none. These answer
with `/dispatch`'s body and statuses plus `delivered` and `delivery`.
With `message_after_launch: true`, the owner instead starts the dormant worker without the text in its launch prompt, waits up to 30 s for its native conversation address, then sends the text as a message using `message_id`.
This keeps transcript-batch deduplication identical for live and dormant workers.
An address timeout returns **503** rather than claiming delivery.

`POST /attachments` accepts `{fiber, attachments: [{name, mime?, data,
sha256}]}` (plus `origin` to forward), with `data` base64 and `sha256` the hex
digest of the decoded bytes. The owning daemon resolves `fiber` in its own
stores (**404** when it does not own it, **504** when felt timed out) and writes
each file to `<data dir>/attachments/<fiber uid>/<first 16 hex of
sha256>.<ext>` (`ext` from an image `mime`, else the name's own short alphanumeric extension, else `bin`; 0600, in a 0700 directory; the data dir is `$SHUTTLE_DATA_DIR`,
default `~/.shuttle`). The name is content-addressed, so re-sending a file
returns the same path. The answer is `{files: [{name, path, sha256, size}]}` in
request order, `path` absolute on the owning host. The batch is all or nothing,
and **400** `{error}` names the first broken rule: any file type is accepted, but a
`mime` of `image/png`, `image/jpeg`, `image/gif` or `image/webp` must be backed by
the bytes' signature; each file is at most 10 MB; at most 8 per request and 25 MB in
total; `data` decodes; `sha256` matches. The route's JSON body ceiling is sized
to that total, each socket read may take up to 120 s, and a forward allows
120 s. Files are kept 30 days: every successful store removes files under
`attachments/` whose mtime is older than that, and fiber directories left
empty, without following links. Re-sending a file refreshes its mtime. The board's composer uploads here
before it sends a directive and appends one `[Image: <path>]` line per image and one `[File: <path>]` line per other file.

Desktop meeting requests accept `meeting.system_audio` (boolean, default `true`).
Set it to `false` to start with only mic transcription.
`POST /meeting/system-audio` accepts `{recorder?, launch, enabled}` and changes system transcription during the addressed live desktop meeting.
The raw system reference remains available for mic echo cancellation.
A stale launch returns 409; phone meetings reject this control.
The meeting row reports `system_audio` from hark’s lifecycle state.

`POST /meeting/pause` accepts `{recorder?, launch, paused}` with a boolean `paused` and a nonempty launch id.
It returns HTTP 200 with `{recorder, meeting}`; the meeting keeps `state: "live"` and reports `paused` separately.
Pause mutes both mic and system transcription through hark's two manual pause flags; Resume restores the system-audio choice from before Pause.
The restore choice is stored locally with the launch id, so repeated requests and daemon restarts preserve Mic only.
`GET /meeting` and control replies derive `meeting.paused` from both flags, not from the saved restore choice or the last request.
This reports the manual gate, not an acknowledgement from the audio thread; hark polls the flags and may finish transcribing audio heard before the pause.
A stale launch returns **409**, invalid input or a non-live, phone or voice capture returns **422**, and a failed hark command returns **503**.
System-audio changes are refused while paused.
Recorder selection and one-hop forwarding match Stop: control addresses the recorder, not the worker's owner, and never falls back to another host.

`POST /meeting/stop` accepts `{recorder, launch}` and returns HTTP 202 with `{meeting}` or 404 when no meeting exists.
The recorder checks the launch identity inside the same lock as Stop; a stale control cannot stop a replacement recording.
An unknown recorder is refused rather than falling through to the hub's local meeting.
It sends at most one SIGINT to a live hark process, even while hark's
lifecycle file still reports `loading` or `live`. A `stopping` meeting is a
no-op; a `starting` or `failed` meeting dismisses its tmux session.

`GET /meeting/audio?recorder=<host>&launch=<id>` upgrades on the serving hub and feeds the addressed `phone` recording.
For a remote recorder, the hub opens that daemon's `/meeting/audio` WebSocket and relays binary audio, status text and closure; the phone only connects to the hub.
The recorder's socket validates `launch`, and an explicit one-hop route prevents recursive relay.
A disconnected or slow relay closes rather than buffering or replaying microphone audio.
The page sends
binary frames of raw s16le 16 kHz mono PCM, which the daemon writes unchanged
into hark's Unix socket, the path `meeting.json` names as `phone`. Nothing is
buffered: hark places phone audio on its own wall clock and pads gaps with
silence, so audio replayed late would be counted twice and shift every later
timestamp. Until hark's socket accepts a connection (it binds once the models
load), frames are discarded and the daemon retries every half second. hark
takes one sender; a new connection replaces the old one. The daemon answers in
small JSON text frames: `{"state":"waiting","reason"}` while there is no socket
yet (audio is dropped), `{"state":"connected"}` once audio reaches hark, and
before closing, `{"state":"refused","reason"}` (close code 4404: no meeting, a
different meeting than `launch`, or one recording this machine's microphone),
`{"state":"ended","reason"}` (4410: the meeting stopped, failed, or gave way to
another), or `{"state":"replaced","reason"}` (4409: hark took another sender).
The frame carries the full reason; the close frame's reason is cut, on a
character boundary, to the 123 bytes a close frame holds. Without `launch` the
socket feeds whichever phone meeting is live. Every meeting state upgrades, so
the page can read why; a request that is not a WebSocket upgrade gets **426**.
Browsers open WebSockets cross-site without CORS, so the upgrade takes the same
origin rule as a write: no `Origin`, an allowlisted dev origin, or the page's
own; any other origin gets **403**. An idle socket closes after a minute.

Recorder routing and agent ownership are separate.
`POST /capture` and `POST /meeting/join` select recording first, preserve the agent's `origin`, and route the scribe or delivery to that owner after hark starts.
Show, Stop and audio carry the recorder address; changing the project host never moves a live recording.
Recorder forwarding terminates after one hop, while ordinary agent forwarding strips `origin` at its owner.

`/file` sits outside the JSON pipeline on purpose: it returns arbitrary content
types, so a strict `Accept: application/pdf` would otherwise 406 before the
controller ran. A 200 response carries a weak content-digest `ETag`
(`W/"sha256-<hex>"`) and `Last-Modified`; only a matching `If-None-Match`
returns a bodyless 304, because a whole-second timestamp can't see a
same-second rewrite. Owner-routed reads forward these validators and relay the
owner's cache headers, including a remote 304. The board sends `If-None-Match`
only with a digest `ETag`; an owner that offers none is read in full and the
board compares a content fingerprint, leaving unchanged views untouched.

`/transcript` accepts `session=<uuid>` and an optional `host=<name>`. Its JSON
receipt carries `availability` (`available_local`, `available_remote`,
`transcript_missing`, `host_unreachable`, or the fleet-level
`identity_pending` state), `host`, `harness`, `source_path`, `byte_count`, and
`sha256`. `/transcript/raw` serves the authoritative JSONL bytes unchanged and
adds `X-Transcript-Byte-Count` and `X-Transcript-SHA256` headers. Agents should
use ordinary `jq`/`rg` recipes on that file; Shuttle deliberately does not
define a transcript reader or search language.

`/transcript/stream` accepts `session`, optional `host`, and a non-negative byte `offset` (default 0).
Each server-sent event carries complete JSONL records in `data` lines and an `id` equal to the byte offset after its last record; partial trailing lines wait for completion.
The stream sends comment keepalives while idle and ends with an `event: reset` if the file shrinks, is replaced, or disappears; clients should reread from offset 0 after a reset.
A hub relay sends `event: error` with `{"error":"upstream_error"}` or `{"error":"upstream_idle"}` before closing on upstream failure or silence; clients should retry with backoff from the last committed event id.
An upstream response that ends normally closes without an error event.
When a remote owner does not support streaming, the hub returns 501 `stream_unsupported`; clients can fall back to polling `/transcript/raw`.

`/transcript/messages` accepts `session=<uuid>` and optional `host=<name>` with the same routing as transcript reads.
It returns `{"messages":[{"id":"…","envelope":"[from …]\\n…","thread":true}],"cursor":"…"}` from the host's private message records.
Pass the opaque `cursor` back as `since=<cursor>` to read changes; merge responses by message ID.
Evidence is retained for fourteen days.
The optional `thread` flag marks a lifecycle notice from the daemon, whose message id starts `thread-`.
Each `envelope` includes its complete body, so a quoted message header cannot create a second attributed row.
An envelope carries no message ID; two messages with the same sender and text have equal envelopes and separate records.
Missing evidence returns an empty array; an unreadable store returns 503.
Evidence establishes the delivered envelope, while the native record's origin establishes whether the record is eligible for message attribution.
Ordinary human prompt records retain their prompt boundary even when their text copies a recorded envelope.

`/sessions/links` accepts `sessions=<uuid>,<uuid>,…` (at most 50) and an
optional `host=<name>`, and answers `{host, links}` with one entry per session
in request order: `session`, `availability` (`resolving`, `available_local`,
`transcript_missing` or `host_unreachable`), `harness` and `url` — a Claude
Code transcript's last `remote_session_change` bridge URL, and only when that
is a `https://claude.ai/` address. A cold lookup returns `resolving` while the
supervised resolver works outside the request path; the board retries pending
entries while History stays open. Claude transcripts are read once for their
observed baseline and then only for appended bytes. A remote's answer is
re-checked by the daemon that relays it: entries for sessions not asked about
are dropped, and a URL of any other shape is nulled. It is a sibling of
`/transcript` because that receipt hashes the whole file.

## Temporal read plane

The feeds behind Chronicle and the Board's document overview and reader. The
four host-scoped feeds each have a `/composite` fan-in sibling; `/sent-files`
is owner-routed instead and has none. See [Telemetry and the
ledgers](../shuttle/telemetry.md) for what writes the files underneath.

| Route | Reads | Serves |
|---|---|---|
| `GET /activity` | `events.jsonl` | Per-minute activity buckets (`agent` and `reply` overlap — see Telemetry) |
| `GET /sessions` | `sessions.jsonl` | Which fiber each harness session belonged to; Codex App rows may carry a separate `thread_id`; `uid=` narrows to one fiber |
| `GET /commits` | `commits.jsonl` | Which session made each commit, with `--shortstat` counts |
| `GET /sent-files/all` | `events.jsonl` | Every `SendUserFile` push on this host |
| `GET /sent-files` | `events.jsonl` | One fiber's sent-files trail, capped at 50 |
| `GET /board` | `events.jsonl` | Host-local board records since `since_ms`, oldest first; ETag/304 supported |
| `GET /board/family` | local and remote board feeds | Current family board, resolved against constitution containment |

`/activity` takes `from_ms` and `to_ms` and answers
`{host, from_ms, to_ms, buckets}`. It rounds the window inward to whole minutes
(buckets are minute-stamped, so the answer is the same), and its weak `ETag` is
that window plus the `{mtime, size}` of `events.jsonl` and its rotated sibling
— a repeat request over an unchanged file is a `304`. As with the sent-files
routes below, that validator almost never matches on a busy host and is not
what keeps the route cheap: `Shuttle.EventStream` holds the histogram in
memory, folded once from both files and then only over appended bytes, and a
request reads its window out of that.

`/board/family` accepts `fiber=<id|slug|uid>` or `session=<harness>:<id>` (required unless `all=true`), `since_ms`, and optional `viewer=<uid>` for delivery marking.
It returns `{family, viewer, records}`; records are deduplicated by id and carry `member`, `to_member`, `actor`, and `delivered`.
A record is delivered when the viewer is its subject, actor or recipient, or is the orchestrator of a thread's ask, close, handoff, rest or unblock.
An externally cleared ask about the viewer is not delivered.
The default window is 24 hours, or six hours for `all=true`, limited to up to 14 days and bounded by the two retained event files.
Remote records carry `received_at`, the viewer daemon's first receipt time, preserved across refreshes and restarts.
The family view filters and orders remote records by that time, so a delayed host or a skewed writer clock cannot hide an arrival behind the viewer's cursor.
Remote records are served from the last cached feed while a due refresh runs asynchronously.
Hook digests request the retained window and deduplicate record IDs; an unresolved viewer leaves its cursor unchanged.

`/sent-files` is owner-routed like `/file` — one fiber's trail is read on the
host that owns the fiber; its LOCAL leg carries a weak `ETag` and honors
`If-None-Match` with a 304 (the forwarded remote leg does not, because
`OriginRouter.forward_get/4` carries no headers either way).
`/sent-files/all` is the host-scoped feed with the composite.

`/sent-files` takes `uid` (required; 400 without it) and `origin`. Its `ETag`
covers the `events.jsonl` pair and the session ledger. The trail is whatever
`events.jsonl.1` and `events.jsonl` hold, so a send survives one rotation and is
gone after the second.

`POST /sent-files/clear` takes `{uid, origin, path?}` and returns `{ok: true}` after appending a `sent_files_cleared` event on the selected stream host.
`uid` must be a canonical fiber ULID; a missing or invalid UID or an unknown `origin` returns 400.
When supplied, `path` must be a nonempty absolute string or the request returns 400 before writing or forwarding.
The path is an exact `fullPath` from the sent-files response and is forwarded unchanged, without expansion or normalization on either host.
The route forwards through `OriginRouter` for a remote origin, relays the owner's response, and returns 502 if forwarding fails.
A local writer refusal returns 422; an unavailable CLI returns 503.
Without `path`, both sent-files read surfaces hide sends at or before the latest whole-fiber clear timestamp for that UID.
With `path`, only that file is hidden, including when it shares a send event with other files.
Each file uses the latest of its path-specific and whole-fiber cutoffs; later resends remain visible.
Artifact files and body embeds are untouched.
A successful forwarded clear invalidates the remote sent-files cache so a composite refetch bypasses its freshness gate.

Neither route is defended by the 304, and neither needs to be: `events.jsonl`
is the live hook stream for every session on the host and moves every few
seconds, so a conditional request on a busy host essentially never hits. What
makes both routes cheap is `Shuttle.EventStream`, which holds the parsed
sent-file events in memory and reads only the bytes appended since its last
poll. A request costs one `stat`; the files are read once, at boot.

The composite siblings are:

| Route | Reads | Serves |
|---|---|---|
| `GET /activity/composite` | local feed + remote caches | Cross-host activity buckets with per-origin freshness |
| `GET /sessions/composite` | local ledger + remote caches | Cross-host fiber/session pairings; `uid=` narrows to one fiber |
| `GET /commits/composite` | local ledger + remote caches | Cross-host commit narration and shortstat counts |
| `GET /sent-files/all/composite` | local feed + remote caches | Cross-host `SendUserFile` pushes |

The board reads only these composites; the single-host routes are what a hub
asks each peer for. A composite asks each remote for that feed when it is
requested, not on a timer: a remote already asked within the last minute is served from the
hub's cache, and one that does not answer within five seconds is served from
its last good copy (kept on disk under `remote-temporal/<feed>/`). `origins`
marks a remote `stale` once its last success for that feed is more than ten
minutes old. Each composite carries a
weak `ETag` over its local inputs and every remote's cached copy, and answers
`304` when none of them has moved.

## The operator files

`GET`/`POST /api/v1/config/:id` is a **text** plane over the five JSON files a
daemon reads from `~/.config/shuttle/` — `stores`, `projects`, `agents`,
`remotes`, `host`. It deliberately does not parse a file into a structure and
re-encode it: that round trip drops every key the structure does not know
about, and `remotes.json` carries several (`auth`, `ssh_flags`,
`tunnel.label`, per-entry timeouts) that no CLI flag can even express.

A write is refused unless the tool that really reads the file accepts it
first. The candidate goes to a temporary file, the owning reader is pointed at
it through its own path-override environment variable, and only a clean exit
commits:

| File | Validator |
|---|---|
| `remotes` | `shuttle remotes list --configured --json` under `SHUTTLE_REMOTES_FILE` |
| `agents` | `shuttle agents --json` under `SHUTTLE_AGENTS_FILE` |
| `host` | `shuttle host --json` under `SHUTTLE_HOST_CONFIG_FILE` |
| `stores`, `projects` | shape-checked in the daemon — no felt verb validates them |

A refusal is a 400 carrying that tool's own sentence verbatim. Empty text
removes the file, which is the same vocabulary the structured writers already
speak for stores (saving an empty list deletes `stores.json`).
Dropping the last configured remote retains `remotes.json` and its discovery and transport policy.

A read serves a `digest` — a hash of the bytes as sent, and of *those* bytes
rather than of a second read of the file. Send it back as `expected_digest` and
the write is refused with a **409** carrying `conflict: true` if the file has
moved since, which matters because this board is reachable from two hubs and a
phone at once and an editor left open while a CLI writes the same file would
otherwise save its stale text back over the new one. The two whole-list
endpoints (`/felt-stores`, `/projects`) take the same key and answer the same
409. Omit it entirely for last-write-wins, which is what a script wants. (A
hash rather than an mtime: POSIX mtime is second-granular, so a write landing
in the same second as the read is invisible to it, and that is exactly the
interleaving a fast tool produces.)

409 is its own status because a client branches on it: a conflict is the one
refusal with a recovery move attached — show me what it says now — and an
affordance keyed to a status survives a rewording of the sentence.

A **503** is not a refusal of the bytes. It means the host could not RUN the
check — `felt` or `shuttle` is missing from a supervised daemon's PATH, or a
CLI timed out — so nothing is known about what was sent and nothing the author
retypes will help.
A 400 says "fix this"; a 503 says "ask again".

Reads are owner-routed as well as writes, which is unusual here and is the
point: a config file describes the daemon that reads it, and only that daemon
can see its own `~/.config/shuttle/`. A host whose daemon predates these routes
answers 404, and the board renders that as "deploy it to configure it from
here" rather than as a missing file.

## Operator routes

| Route | Purpose |
|---|---|
| `GET /version` | Daemon build stamp and liveness probe, including `ready` and boot duration; deploy verifiers require matching `git_short_sha`, fresh `booted_at`, canonical `release_path`, `ready: true`, `contract.ok: true`, explicit `reconciliation_hold: null` and a nonempty `incarnation`; also carries `host` (the frozen host id this daemon dispatches under, by which other daemons' discovery names it), `listen`, `host_class`, peer-gate mode/uid/source, `tailnet_dial` (with `socket_source`: `configured`, `default`, `system` or `none`, and `default_socket_refused` when an untrusted default socket was passed over), and `discovery` (this daemon's tailnet peer discovery: `enabled`, `state` of `pending`/`ok`/`unavailable`/`disabled`, `via` of `cli`/`localapi`, `error`, `last_run_at`, the `peers` found with `name`, `url`, `dns_name` and `last_seen_at`, and the nodes `rejected` with a `reason`) |
| `GET /state` | Full local state: running workers, blocked and `pending_launch` rows, standing constitutions, boot quarantine, contract check and `poll_health` |
| `GET /state/composite` | The same plus per-origin remote snapshots |
| `POST /quarantine/release` | Release the boot quarantine (host-addressed; `shuttle daemon release`); optional `expected: {incarnation, release_path}` binds authorization to a verified daemon, with HTTP 409 `incarnation_mismatch` if it changed |
| `POST /remotes/:name/reset` | Restart recovery for a tripped, degraded or unreachable remote; one reset buys one attempt, and it 409s when no recovery action is waiting |

`release_path` is the absolute root of the release the running VM booted from, or `"unknown"` when running under Mix.
It describes the current process, not the release selected for the next boot in `~/.shuttle/repo`.
`shuttle daemon status` includes this field even when it prints the state response.

The endpoint binds before synchronous store resolution, orphan adoption,
event-stream seeding, and Tailnet bridge reconciliation finish. Until every
application child has started, `/version` returns HTTP 200 with `ready: false`
and a boot duration. Routes that depend on initialized state return HTTP 503
with `{"error":"booting","ready":false,...}` and no `Retry-After` header.
The liveness-safe exceptions are the board shell `GET /`, static assets (served
before the gate), `GET`/`HEAD /version`, `GET /peers`, `GET /sessions`, and
`POST /messages` plus `/messages/files`. Session discovery and direct message
delivery do not call into the initializing Poller. Remote message delivery can
still return its explicit `no_bridge` result before this host's Tailnet bridge
has initialized. `shuttle daemon status` reports a bound listener as alive while
booting, and the launcher polls every five seconds until it is ready or stops
answering.

A TailnetDial bridge is `ready` when its private listener is bound and no
dial/relay failure is recorded. Upstream reachability is observed on actual
requests, not by a synthetic probe. A recorded request error clears when a
later dial succeeds; a relay error from that request can set the status back
to `error`.

A TCP peer refused by the uid gate receives HTTP 403 before static assets
are served or a request body is parsed. Exposed hosts refuse TCP listeners at
boot; this response also describes the gate's defense-in-depth behavior if an
exposed TCP request reaches the plug:

```json
{"error":"peer_refused","reason":"uid 2000 is not the daemon's uid 1000"}
```

When `/proc` cannot resolve the peer, `reason` is
`"peer uid unresolved: no matching /proc TCP row"`. When the connection's row
has no owning socket — the client closed it, usually after timing out, before
the daemon read the request — `reason` is `"peer closed its connection before
the daemon read the request (its /proc TCP row has no owning socket)"`. The
`shuttle` CLI reports a refusal as `daemon at <url> refused this connection
(403 peer_refused): <reason>`. The `peer_gate` field on
`GET /version` reports whether this admission check is active for the daemon's
bound class and listener.

```bash
curl -s http://127.0.0.1:4000/api/v1/version | jq
curl -s http://127.0.0.1:4000/api/v1/agents  | jq
```

`GET /` outside `/api/v1` serves the board's `index.html`, or a 404 with a build hint when `ui/dist` has never been built.
`GET /phone` redirects to `/`.
Capture starts a `phone` meeting with an optional prompt; the scribe infers the meeting and where to file it from the transcript.
On a mobile viewport, Capture defaults to Meeting with phone audio and no mode selector, and remembers the scribe host and project from the last meeting start.
Desktop Capture defaults to an ordinary idea; enabling Meeting uses the recorder's first supported mode and shows a selector only when several modes are available.
The Start tap opens the microphone, then binds its audio session to the returned meeting's launch id at `GET /api/v1/meeting/audio`.
The live card offers Connect mic when this tab isn't streaming, a level meter, Restore mic after an interruption, and Stop.
Keep the screen on and the browser in front; on iOS, screen lock stops the microphone.
The tab requests a screen wake lock to prevent auto-lock where supported.
A background-interruption warning retains the time the tab went hidden even when timers were suspended; Restore mic may ask for permission again.

Audio is sent only while hark listens, and the card says when it doesn't: "Loading models — speech isn't captured until Listening" while hark loads, "Reconnecting — audio lost since HH:MM:SS" after a drop.
Nothing is queued for later, and an open socket more than about 2 s behind drops audio rather than queueing it.
Browsers grant the microphone only in a secure context, so reach the board from a phone through an HTTPS front such as `tailscale serve`.

### POST /api/v1/thread-signals/current

Checks a queued thread lifecycle notice against the thread owner's fresh fiber.
The request carries `message_id`, `text`, and optional `signal` with `uid`, `verb`, `stamp`, and `owner`.
The response is `{current: true|false}`.
A cleared or replaced ask, a rearmed close, or an unreviewed close superseded by a human verdict returns false.
A reviewed close has a distinct quiet notice naming the verdict.
Unreachable owners and failed reads return 503, so the mailbox retains the notice for retry.
Existing notices without structured signal metadata are checked by their lifecycle message ID and the thread address in their text.
Mailbox delivery validates notices before emitting them and durably acknowledges each successful direct delivery independently.
