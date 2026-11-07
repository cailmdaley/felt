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
| `POST /capture` | owner-routed | Launch an agent from a free-text prompt to file and claim a constitution |
| `GET /voice` | recorder-routed | Listen settings, source, launch, selected target, pending speech and last delivery |
| `GET /voice/audio` | recorder-addressed | Launch-bound phone PCM WebSocket, optionally relayed through a hub |
| `POST /voice/toggle` | recorder-routed | Start Listen unmuted when off; otherwise flip mic mute |
| `POST /voice/discard` | recorder-routed | Drop unsent buffered words and return the number discarded |
| `GET /voice/transcript` | recorder-addressed | Read the recorder-local day transcript as `{date, rows, recorder}`; filters `date`, `fiber`, `since` |
| `POST /voice` | recorder-routed | Update `{enabled?, muted?, follow?, system_audio?, source?, target?}`; returns voice state |
| `GET /voice/events` | recorder-routed for `target`, local for `focus` | The board's one live stream: server-sent `target` events, and with `rex=1` `focus` events `{fiber_id, origin, name}` when Rex's worker changes, voice on or off; every stream carries `open` events from `POST /board/open` |
| `POST /voice/target` | recorder-routed | Route following to `{fiber_id, origin?, name?}`, the board's view; returns voice state, unchanged unless following |
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
| `POST /attach` | **not** owner-routed | Open a worker or past-session viewer on the local display using Kitty or Rex; remote tmux uses SSH; brings the terminal forward. `{select_only: true}` is a click's: Rex moves to a window the conversation already has, creating none, launching or raising no app and resuming no session, and answers `{moved, session}` |
| `POST /sessions/resume` | local | Start (or find) a past session's terminal viewer; an active terminal Codex worker reuses its owned thread |
| `POST /sessions/prepare-terminal` | host-addressed | Prepare the terminal viewer of an owned Codex thread by fiber UID or recorded tmux name, without starting a turn |
| `POST /sessions/receiver` | host-addressed | Resolve the live native Codex process for `{session_uuid}` and return `{session_uuid, pid, process_start}` from a kernel lifetime probe; 404 means absent or stale, 503 means process state is unknown |
| `POST /messages` | host-addressed | Deliver a durable, idempotent text message to an exact `shuttle://HOST/HARNESS/NATIVE_ID` address |
| `POST /messages/files` | host-addressed | Deliver a message with receiver-local attachment copies to an exact session address |

### Day transcript

`GET /voice/transcript?recorder=<host>&date=YYYY-MM-DD&fiber=<id-or-slug>&since=HH:MM[:SS]` returns `{date, rows, recorder}` with `Cache-Control: no-store`.
All filters are optional: `date` defaults to today on the recorder, `fiber` matches an id or slug, and `since` is an inclusive recorder-local time.
Rows are `{t, speaker, text, fiber_id, origin, name, slug, launch}`; `t` is the spoken-start ISO 8601 timestamp and the four fiber fields are null when speech had no route.
`slug` is the resolved fiber path; transcript readers display its last segment.
The recorder appends every ingested utterance, including cold-dropped and discarded speech, to `<Shuttle.data_dir()>/transcripts/YYYY-MM-DD.jsonl`, using its local date.
Rows survive recording stops and launch changes.
An empty or absent day returns an empty `rows` list, not 404.
Invalid filters return 422, an unknown recorder 400, and an unreachable recorder 502; reads never fall back to another host.
`origin` does not select the recorder, and reading the transcript does not control capture.

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

### Capture

`POST /capture` accepts `{prompt, project_dir, agent?, effort?, chrome?, origin?}` and launches an agent through the selected terminal backend.
The prompt and project directory are required; the agent files a constitution and claims it through `/claim`.
A successful response includes `spawned: true`, `agent`, terminal coordinates, and `session_uuid` when the launch assigned a harness session.
Capture does not start or control recording.
To listen to a new topic, capture its card, then pin Listen to that card with `POST /voice`.

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
| `GET /transcript/usage` | host-routed | A session's latest context and cache facts, read from the transcript's tail |
| `GET /sessions/links` | host-routed | For a batch of sessions: transcript present, harness, and a bridged Claude session's claude.ai URL |
| `GET /peers` | fleet fan-in | Discover addressable live sessions; `?local=true` serves only this daemon's owner-local sessions |

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

Listen's recorder and the receiving worker's owner are separate addresses.
Use the `recorder` returned by `/voice` for subsequent polling, controls, transcript reads and phone audio.
A phone-source request without an explicit recorder probes reachable fleet daemons and prefers an available desktop-capable recorder; it defaults to this daemon when none qualifies.
Probes are addressed reads of `/voice`, bounded to 800 ms, and cannot recursively select another recorder.
All recorder control forwarding is one-hop and single-attempt; an uncertain response never causes a fallback start.

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

### Listen

`GET /voice` returns `{available, sources, enabled, muted, follow, system_audio, words, quiet_seconds, pinned_quiet_seconds, source, launch, state, mode, destination, paused, target, cold, pending, pending_words, preview, level, last, error, recorder}`.
`recorder=<host>` selects the recording daemon independently of the worker's `origin`; without it, the receiving daemon answers locally.
`sources` is `[]` without hark, `["desktop", "phone"]` on macOS, and `["phone"]` on other hosts.
`source` is `desktop` or `phone`; `launch` is the active recorder's `voice-…` identity or null.
`state` is `off`, `starting`, `listening`, or `failed`.
`mode` is `off` when disabled, otherwise `following` or `pinned` according to `follow`.
`target` is `{fiber_id, origin, name, slug, pinned, source?}` or null; the optional source names the view that selected it, such as `board` or `rex`.
`destination` is `{fiber_id, origin, name}` while enabled and null otherwise.
`paused` reflects mic `muted` while enabled and is false when off.
`cold` says whether the target lacks a live owner-published worker; an idle live worker is warm, while an unreadable owner is cold.
`pending` is `{fiber_id, words, text}` or null, and `pending_words` totals finalized unsent words across buffers, excluding speaker labels.
`preview` is `{fiber_id, origin, text}` or null, pinned to the target where the in-progress partial began; it is display-only and clears when muted, disabled, empty or stopped.
`level` is `{mic, at}` or null, the latest microphone peak in dBFS and its ISO 8601 arrival time, absent after one second without a meter update.
`last` is `{fiber_id, origin?, text?, at, status, detail?}` or null, with status `delivered`, `unconfirmed` or `failed`.
`enabled` is persisted intent even when capture fails; invalid settings fail off with a visible configuration error.

`POST /voice` accepts `{enabled?, muted?, follow?, system_audio?, words?, quiet_seconds?, pinned_quiet_seconds?, source?, target?, recorder?}` and returns the same state.
The four switch fields must be booleans, and `source`, when supplied, must be `desktop` or `phone`.
A pin is one request: `{follow: false, target: {fiber_id, origin?, name?}}`.
`target` requires `follow: false`; omitting it when turning follow off retains the current target.
A pin can be set while disabled and survives daemon restarts through the route journal and persisted follow setting.
While pinned, `POST /voice/target` and Rex view changes remember the view but do not move the target.
`{follow: true}` resumes following the latest view seen while listening.
Invalid input and control failures return 422; unknown recorder addresses return 400, and unconfirmed remote controls 502.

`{enabled: true, source: "phone"}` starts the same recorder with `hark --voice --phone`.
Without an explicit recorder it prefers a reachable desktop-capable fleet recorder, while an explicit `recorder` pins the request.
Desktop starts use `hark --voice`, adding `--system-audio` when the setting is on.
The desktop recorder retains system audio as its echo-cancellation reference even when system transcription is off.
`system_audio` toggles live through hark's `system-paused` flag file and persists across launches.
Phone audio has no system track; it retains the desktop preference without applying a system gate.
Changing source replaces the recorder after stopping the old launch.
`source` is a runtime choice, not a `voice.json` setting; a surviving phone launch is adopted after daemon restart.

`POST /voice/toggle` starts Listen unmuted with the desktop source on a desktop-capable host when disabled; otherwise it flips mic mute without changing follow or pin.
Any enable without an explicit source selects desktop on a desktop-capable host; stopping Listen clears the phone source.
`POST /voice/discard` drops unsent buffered words and returns the state plus `discarded`, the number dropped.
Already-submitted batches still go, and utterances begun before discard stay in the day transcript but do not enter a buffer.
Mic mute sets hark's `paused` flag file and survives recorder restarts.
There is one retained terminal launch, `hark-voice`, and no scheduled recorder restart.
Crash retries wait 1, 2, 4 and 8 seconds; five failures latch until enabled is toggled off and on.
Thirty stable seconds reset that budget; a daemon restart starts a fresh budget.
Disabled idle ticks inspect lifecycle files without shelling out; boot always observes retained captures and stops an orphan when disabled.

`POST /voice/target` accepts `{fiber_id, origin?, name?, recorder?}` from the view, returning voice state.
While following, whichever of Rex and the board had focus last sets the target.
Routes append `{t, fiber_id, origin, name, slug, pinned, source?}` to `<Shuttle.data_dir()>/voice-routes.jsonl` with recorder UTC receipt time.
Each utterance takes the route at its spoken start (`wall_start`, falling back to `wall`), not recognition completion.
A switch flushes the old target's buffer; a late utterance still uses its spoken-time target and follow/pin setting.
An unreadable or malformed journal fails off with a visible error.
No route means no delivery; the day transcript still keeps the speech.

`voice.json`, exposed by the config API as `voice`, defaults to:

```json
{"enabled": false, "follow": true, "system_audio": false, "words": 200, "quiet_seconds": 15, "pinned_quiet_seconds": 120}
```

`words` must be a positive integer and both quiet intervals positive numbers of seconds.
The relay polls every 250 ms and flushes on the word limit, a closing `send`, target switch, capture end, or quiet since the last spoken end.
Following uses `quiet_seconds`; pinned listening uses `pinned_quiet_seconds`.
A nonempty fresh Hark partial holds quiet-triggered delivery until the utterance finishes.
Hark reads the same file through `--settings`.
Only the listed top-level settings participate; nested settings do not affect thresholds.
`{enabled: false}` repairs an invalid file with disabled defaults.

Following drops ordinary batches for a cold target; a final `send` clause starts or resumes its worker.
`send` must stand alone at the start of an utterance or after sentence punctuation, a comma, semicolon or colon; “did you send?” does not trigger delivery.
Pinned listening delivers every batch and starts a cold worker without a trigger.
Names have no routing or delivery meaning.
The owner decides resume versus first launch from its current document.
Speaker-labelled paragraphs merge adjacent utterances by the same speaker, without a header, and omit a final `send`.
A bare `send` delivers nothing.
Each delivered batch ends with `— shuttle transcript --since HH:MM:SS`, using its first spoken time on the recorder, followed by ` --recorder HOST` when the target's origin is another host.
The `/voice/transcript` endpoint reads the corresponding day rows.
Live workers take terminal input through `/deliver` with `live_input: true`; cold workers receive the same text as their launch directive, with `message_after_launch: false`.
Batches stay ordered per destination; different destinations proceed independently.
The relay checkpoints attempts before delivery and never automatically replays them, including definite failures.
A 202 with `delivered: null` or an interrupted delivery is unconfirmed; `last` explains that the words remain in the transcript.

### Worker delivery

`POST /dispatch` accepts `{fiber_id, force?, ad_hoc?, resume_mode?,
user_message?, project_dir?, release_launch_reservation?, existing_only?}` (plus `origin` to forward).
With `existing_only: true`, only a `previous` message to a live worker is allowed.
A missing worker returns 422 `no_live_worker` without arming, reopening or launching anything.
The change reader uses this form.
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

### Phone audio

`GET /voice/audio?recorder=<host>&launch=<voice-launch>` upgrades to a phone PCM WebSocket on the serving hub.
`launch` is required for local and remote connections; missing launch returns 409.
The hub relays one hop to the addressed recorder's `/voice/audio`, and that recorder validates the voice launch before feeding hark's Unix socket.
Binary frames are raw signed 16-bit little-endian 16 kHz mono PCM.
No audio is replayed: frames are dropped until hark's socket accepts, and the daemon retries connection every 500 ms while models load.
Hark places audio on its own wall clock and pads gaps with silence; a new sender replaces the old one.
Status text frames are `{"state":"waiting","reason":…}`, `{"state":"connected"}`, or a terminal status before closure.
Terminal states are `refused` (4404: absent, different launch or desktop source), `ended` (4410: stopped or failed), and `replaced` (4409: another sender).
Close reasons are clipped to 123 bytes at a character boundary; the status frame contains the full reason.
A non-upgrade request returns 426; a disallowed browser Origin returns 403.
An idle socket closes after one minute.
Remote connection/send deadlines are bounded, closure propagates both ways, and slow or disconnected relays close rather than queue audio.

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

`/transcript/usage` accepts the same parameters and reads at most the file's
last 16 MiB, so it stays cheap on a huge transcript, and it needs no live
worker. It answers `{context?, window?, cached?, cache_warm_until?, cache_ttl?, hit_share?,
at}`: `context` is the latest turn's prompt tokens, absent after a compaction
that records no count until the next measured turn; `window` is the context
window, which only Codex records; `cached` is the tokens that turn read from
the prompt cache; `cache_warm_until` is an estimate that only Claude's native
usage establishes, and it may already be past; `cache_ttl` is the lifetime in
milliseconds of the entry behind that estimate; `hit_share` is the share of
context tokens read from the cache over the turns in the tail. Times are epoch
milliseconds. A session with nothing to report answers 404 with the `/transcript`
receipt, `availability` being `transcript_missing` or `usage_missing`; an
unreachable owner answers 503 with `host_unreachable`.

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
| `POST /board/open` | every board in the fleet | `{fiber_id, origin?, page}` asks every board on a `/voice/events` stream to show that fiber's `constitution`, `tapestry` or `files` page; `origin` defaults to this host. The daemon tells its own boards and passes the request, marked `forwarded: true`, to every other daemon in the fleet, which tells only its own |

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
The phone enables Listen with `source: "phone"`, then binds its microphone stream to the returned `recorder` and `launch` at `/api/v1/voice/audio`.
A secure context such as a tailnet HTTPS front is required for browser microphone access.
iOS screen lock or backgrounding can interrupt the microphone; the transport never queues missed audio for later.

### POST /api/v1/thread-signals/current

Checks a queued thread lifecycle notice against the thread owner's fresh fiber.
The request carries `message_id`, `text`, and optional `signal` with `uid`, `verb`, `stamp`, and `owner`.
The response is `{current: true|false}`.
A cleared or replaced ask, a rearmed close, or an unreviewed close superseded by a human verdict returns false.
A reviewed close has a distinct quiet notice naming the verdict.
Unreachable owners and failed reads return 503, so the mailbox retains the notice for retry.
Existing notices without structured signal metadata are checked by their lifecycle message ID and the thread address in their text.
Mailbox delivery validates notices before emitting them and durably acknowledges each successful direct delivery independently.
