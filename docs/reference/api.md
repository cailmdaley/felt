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
| **owner-routed** | The request carries an `origin`; the daemon runs it locally or forwards it to the daemon that *owns* the fiber. A fiber's files live on its owner's disk. An origin matching nothing degrades to local, where the fiber lookup is the arbiter. |
| **host-addressed** | Owner-routed, but an origin this daemon cannot place is **refused** rather than degraded. The subject is a host rather than a fiber — a config file, a store list, a tunnel job, a quarantine — and every host has one, so degrading would not fail: it would succeed on the wrong machine. |
| **host-scoped** | The route answers for *this* machine only, because what it reads (a transcript, an event stream, a ledger) lives on the machine that wrote it. |
| **fan-in** | A `/composite` sibling that merges this host's live read with each configured remote's cached read, reporting per-origin freshness. |

There is no shared routing plug: each controller decides for itself. The
per-controller `@moduledoc` says which, and is the thing to read when this table
is not enough.

## Write plane

| Route | Routing | Purpose |
|---|---|---|
| `POST /dispatch` | owner-routed | Launch a worker for a fiber now, bypassing the poll |
| `POST /transition` | owner-routed | The unified kanban write: move a fiber to a column, one call per drag |
| `POST /lifecycle` | owner-routed | Invoke a named lifecycle action on a fiber |
| `POST /kill` | owner-routed | Stop a CLI worker or interrupt and release an app conversation |
| `POST /claim` | owner-routed | Associate a tmux worker or a verified native app conversation with a fiber |
| `POST /capture` | owner-routed; meeting setup is local first | Launch a session from a free-text prompt; meeting mode starts local hark recording before routing the scribe capture |
| `POST /meeting/stop` | local | Stop the local hark capture or dismiss its failed tmux pane |
| `POST /inject` | local | Paste text into a live worker's tmux prompt without submitting it |
| `POST /felt-edit` | owner-routed | Shell `felt edit` on the owning host — felt keeps the validation |
| `POST /felt-nest` | owner-routed | Shell `felt nest` on the owning host |
| `POST /fiber/create` | owner-routed | Create a fiber |
| `POST /felt-stores` | host-addressed | Persist a daemon's registered felt stores (whole list; takes `expected_digest`) |
| `POST /projects` | host-addressed | Register a picker project and initialize its `.felt/` when needed, or set the whole list with `projects: [...]` (which takes `expected_digest`) |
| `POST /config/:id` | host-addressed | Replace one operator file's text, validated first by whoever owns its grammar |
| `POST /fleet/remotes` | host-addressed | Add, replace or remove one remote — shells `felt shuttle remotes add\|rm` |
| `POST /tunnels` | host-addressed | `install` or `preview` a host's supervised tunnel jobs — shells `felt shuttle tunnels install [--dry-run]` |
| `POST /choose-folder` | host-addressed | Open the named host's native folder picker and return the chosen path. Blocks for as long as the human takes, so the forward outlasts the dialog's own five-minute bound |
| `POST /attach` | **not** owner-routed | Open a worker's tmux session in kitty — the terminal opens where the human is, ssh-ing out for a remote worker |
| `POST /messages` | host-addressed | Deliver a durable, idempotent text message to an exact `shuttle://HOST/HARNESS/NATIVE_ID` address |
| `POST /messages/files` | host-addressed | Deliver a message with receiver-local attachment copies to an exact session address |

`POST /felt-edit` also accepts a `collaboration` object to replace a fiber's
optional role roster. It is an exact replacement map from role slugs to arrays
of collaborator slugs, for example
`{"vizier":["fable","astra"],"organizer":[]}`. An empty collaborator
array keeps a role-only entry. Send this separately from body, status, or
other document edits: the owner runs one locked
`felt shuttle assign --json-assignment` write. This changes the roster without
launching a worker or changing the execution agent. The roster stores readable
names, not copied profile bodies; workers synchronize their store and read
relevant role and collaborator content locally. The request's top-level
`origin` still routes the task edit. See
[Collaborators](../concepts/collaborators.md).

### Capture and meeting mode

`POST /capture` accepts `surface: "app"` for a Codex agent or `"cli"` for
terminal execution. It also accepts an optional `meeting: {mode: "call" | "room"}`
object. Meeting mode starts hark on the daemon that receives the request before
owner-routing the capture, so the local microphone records immediately while
the scribe runs beside the project. Meeting mode rejects `surface: "app"`,
allows `prompt` to be omitted, and replaces the prompt with the meeting's facts
(mode and transcript path, plus a pointer to the shuttle skill's
`references/meeting.md`) followed by the user's note. It removes `meeting` before forwarding, so the
owner handles an ordinary terminal capture. The transcript is mirrored to the
remote project host when `origin` names a configured remote with an SSH alias.
A successful capture response adds `meeting`; if capture fails after recording
starts, its status and error body also include `meeting` and `recording: true`.
Each meeting gets a transcript name no earlier recording used. The daemon watches
the new recording for a few seconds: if hark exits before it starts recording, the
scribe is not launched and the response is **503** with the failed `meeting` row
and `recording: false`. A recording that is still loading, or whose state tmux
can't report yet, counts as started (`state: "starting"`).

### Codex app conversations

Existing-fiber dispatch reads the persisted
`shuttle.surface`; omission preserves CLI execution. Model and effort remain
agent-registry choices. App execution requires the owning host's local Codex
App Server and reports an error if it cannot be reached.
An unavailable managed server returns HTTP 503 with
`reason: "app_server_unavailable"` and guidance to choose a configured remote
host or CLI execution. Shuttle does not start an independent app runtime or
silently change the selected surface.

Successful app capture, dispatch, and claim responses carry `surface: "app"`,
`project_id`, `thread_id`, `session_uuid`, `transcript_session_uuid`, and
`tmux_session: null`. For app workers, `session_uuid` is the resumable
conversation identity (the same value as `thread_id`);
`transcript_session_uuid` is the native transcript identity, which can differ
for a fork. Session ledgers use the transcript identity. CLI responses carry
`surface: "cli"` and their real `tmux_session`. A claim can attach an existing
native Codex conversation only after the connected App Server read-verifies its
exact id and active or idle state. The claim records ownership without starting,
resuming, naming, or interrupting a turn. An app conversation waiting
for the next phone reply remains assigned; its idle state does not authorize
another launch.

App responses and runtime rows can also carry `desktop_link`, the validated
`codex://threads/<thread_id>` desktop route. This is separate from a verified
phone `session_link`. The board uses native working, waiting, and attention
states without treating an idle conversation as released ownership.

A created conversation whose first turn could not be confirmed returns HTTP
502 with `reason: "app_launch_failed"`, its conversation id, and a recovery
`message`. Ownership remains reserved; inspect and resume that conversation
instead of creating a duplicate. Confirmed missing conversations are marked
blocked and can be explicitly stopped or replaced. A temporary connection
failure remains unknown.

To claim an app conversation, post `fiber_id`, `surface: "app"`, and
`session_uuid` to `/claim`. A Shuttle-created capture claims its durable record
directly; an existing native conversation is adopted only after exact
read-verification by this host's App Server. In either case it must not belong
to another fiber. CLI claims use `tmux_session`. The app dispatch prompt
supplies the claim information and the appropriate completion instructions.

`/attach` and `/inject` are terminal operations. An app conversation's UUID
is not a terminal name or a verified mobile URL. Phone conversation access
uses the host's Codex project listing until a direct app URL is available.

## Read plane

| Route | Routing | Purpose |
|---|---|---|
| `GET /fibers` | local | Every fiber this daemon's stores expose |
| `GET /fibers/composite` | fan-in | The cross-host board feed, with reconciled per-host liveness |
| `GET /fibers/*id` | owner-routed | One fiber by canonical id, body fetched from its owner |
| `GET /search` | local | Search constitution bodies in this daemon's configured stores |
| `GET /agents` | host-addressed | The effective agent registry (shells `felt shuttle agents --json`) — a per-host fact, since the built-in layer travels with that host's felt binary |
| `GET /felt-stores` | fleet-aggregating | The registered store list, this host's live and each remote's off the cached owner feed (`stores` block) |
| `GET /config` | host-addressed | Every operator file on a host: path, whether it exists, size, mtime, and any environment variable overriding it |
| `GET /config/:id` | host-addressed | One operator file's text and digest — `stores`, `projects`, `agents` or `remotes` — plus `entries` for the two path lists |
| `GET /fleet` | host-addressed | A host's fleet as rows: the normalized fleet file joined to live reachability and each remote's build |
| `GET /file` | owner-routed | Raw bytes by absolute path, with `ETag` / `Last-Modified` conditional GET for live HTML, markdown, and text readers |
| `GET /file-info` | owner-routed | File existence, mtime, and size without downloading bytes — metadata for browser-native artifact refreshes |
| `GET /transcript` | host-routed | Availability receipt for a native session transcript, including its authoritative path and digest |
| `GET /transcript/raw` | host-routed | Exact native JSONL bytes for a session — no parsing or normalization |
| `GET /peers` | fleet fan-in | Discover addressable live sessions; `?local=true` serves only this daemon's owner-local sessions |
| `GET /meeting` | local | Report hark availability and meeting state on this daemon's host |

`GET /peers` returns `{host, sessions, gaps}`. Fleet discovery queries each
configured daemon once with `local=true`; an offline, old, timed-out, or
malformed peer becomes an explicit `{host, error}` gap while successful peers
remain usable. Returned addresses use the configured routing alias:
`shuttle://HOST/HARNESS/NATIVE_ID`.

`POST /messages` accepts `{address, text, from, wake, message_id}`. Omitting
`wake` requests an active task turn; set `wake: false` explicitly for
context-only delivery. A failed wake remains a failure in the receipt and is
never silently downgraded to context-only delivery. The address selects the
owner strictly; an unknown host is refused rather than attempted locally. Its
receipt reports only submission state (`accepted`,
`context_added`, `submitted`, `queued`, `unknown`, or `rejected`), transport, and detail;
it does not claim that the recipient read or acted on the message. Reusing a
`message_id` with the same request returns the durable receipt, while reusing it
for changed content is rejected by the local felt adapter.

`POST /messages/files` accepts the same envelope plus one to eight
`attachments`, each `{name, data, sha256}`. `name` is a portable basename,
`data` is base64, and `sha256` is lowercase hexadecimal. Decoded attachments
may total at most 20 MiB. Successful receipts include
`files: [{name, path, sha256, size}]`, where each path names the receiver-local
copy. File-bearing envelopes are refused on `/messages`; this dedicated route
prevents an older daemon from silently dropping fields it does not recognize.

`GET /meeting` returns `{available, meeting}`. The row is `null` when this
daemon has no local meeting capture to report. Otherwise it carries
`state`, `title`, `started_at`, `last_line`, `transcript`, `mirror_host`,
`tmux_session`, and `error`. `mirror_host` is the configured remote name when
the transcript mirror's SSH alias matches a remote; otherwise it is the alias.
A `null` mirror host means the transcript is local.

`POST /capture` accepts `meeting: {mode: "call" | "room"}`. The daemon derives
the meeting title and transcript name from the first line of `prompt`, or uses
`Meeting` when no note is supplied. It starts hark in the local `hark-meeting`
tmux session, then continues the normal local or forwarded capture flow.
For a remote `origin`, hark writes locally and mirrors to
`~/.hark/meetings/<name>.txt` through that remote's configured SSH alias.
The capture agent receives the scribe message and the optional user note as its
prompt. `project_dir` remains required by the ordinary capture flow.

An unavailable hark executable returns **503**. An existing meeting in
`starting`, `loading`, `live`, or `stopping` returns **409** with its row.
Meeting mode rejects `surface: "app"` and an invalid mode with **422**.
If capture fails after hark starts, the capture's status and error body include
the meeting row and `recording: true`; the local recording continues.

`POST /meeting/stop` returns HTTP 202 with `{meeting}` or 404 when no meeting
exists. It sends at most one SIGINT to a live hark process, even while hark's
lifecycle file still reports `loading` or `live`. A `stopping` meeting is a
no-op; a `starting` or `failed` meeting dismisses its tmux session.

These meeting routes control this daemon's local recording and never use owner
routing. `POST /capture` starts that recording before it routes the scribe to
the capture's project owner.

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

## Temporal read plane

The feeds behind the board's time views. The five host-scoped feeds each have a
`/composite` fan-in sibling; `/sent-files` and `/moment` are the two exceptions,
noted below the table, and neither has one. See
[Telemetry and the ledgers](../shuttle/telemetry.md) for what writes the files
underneath.

| Route | Reads | Serves |
|---|---|---|
| `GET /activity` | `events.jsonl` | Per-minute activity buckets (`agent` and `reply` overlap — see Telemetry) |
| `GET /sessions` | `sessions.jsonl` | Which fiber each harness session belonged to |
| `GET /commits` | `commits.jsonl` | Which session made each commit, with `--shortstat` counts |
| `GET /sent-files/all` | `events.jsonl` | Every `SendUserFile` push on this host |
| `GET /sent-files` | `events.jsonl` | One fiber's sent-files trail, capped at 50 |
| `GET /spend` | ledger + transcripts | Per-session and per-fiber token rollups |
| `GET /moment` | the harness transcript | The words a session spoke inside a window |

`/sent-files` is owner-routed like `/file` — one fiber's trail is read on the
host that owns the fiber; its LOCAL leg carries a weak `ETag` and honors
`If-None-Match` with a 304 (the forwarded remote leg does not, because
`OriginRouter.forward_get/4` carries no headers either way).
`/sent-files/all` is the host-scoped feed with the composite. `/moment` is host-*routed* rather than host-scoped: pass `host` to
name the machine that ran the session, or omit it and the daemon consults its
own session ledger. A transcript is one machine's file, not a feed to merge, so
there is deliberately no `/moment/composite`. `/spend` has no board consumer
today — the time views count minutes from activity buckets, not tokens.

The composite siblings are:

| Route | Reads | Serves |
|---|---|---|
| `GET /activity/composite` | local feed + remote caches | Cross-host activity buckets with per-origin freshness |
| `GET /sessions/composite` | local ledger + remote caches | Cross-host fiber/session pairings |
| `GET /commits/composite` | local ledger + remote caches | Cross-host commit narration and shortstat counts |
| `GET /spend/composite` | local transcripts + remote caches | Cross-host token rollups |
| `GET /sent-files/all/composite` | local feed + remote caches | Cross-host `SendUserFile` pushes |

## The operator files

`GET`/`POST /api/v1/config/:id` is a **text** plane over the four JSON files a
daemon reads from `~/.config/felt/` — `stores`, `projects`, `agents`,
`remotes`. It deliberately does not parse a file into a structure and
re-encode it: that round trip drops every key the structure does not know
about, and `remotes.json` carries several (`auth`, `ssh_flags`,
`tunnel.label`, per-entry timeouts) that no CLI flag can even express.

A write is refused unless the tool that really reads the file accepts it
first. The candidate goes to a temporary file, the owning reader is pointed at
it through its own path-override environment variable, and only a clean exit
commits:

| File | Validator |
|---|---|
| `remotes` | `felt shuttle remotes list --json` under `FELT_REMOTES_FILE` |
| `agents` | `felt shuttle agents --json` under `FELT_AGENTS_FILE` |
| `stores`, `projects` | shape-checked in the daemon — no CLI verb reads them |

A refusal is a 400 carrying that tool's own sentence verbatim. Empty text
removes the file, which is the same vocabulary the structured writers already
speak (saving an empty list deletes `stores.json`; dropping the last remote
deletes `remotes.json`).

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
check — felt off a supervised daemon's PATH, or wedged past its bound — so
nothing is known about what was sent and nothing the author retypes will help.
A 400 says "fix this"; a 503 says "ask again".

Reads are owner-routed as well as writes, which is unusual here and is the
point: a config file describes the daemon that reads it, and only that daemon
can see its own `~/.config/felt/`. A host whose daemon predates these routes
answers 404, and the board renders that as "deploy it to configure it from
here" rather than as a missing file.

## Operator routes

| Route | Purpose |
|---|---|
| `GET /version` | Daemon build stamp — the liveness probe, and what a deploy verifier watches (`git_short_sha` AND `booted_at` must both move); also carries `listen` (the resolved listen address), `host_class` (the declared trust class), `peer_gate` (`"uid"` for a shared-multi-user TCP listener, otherwise `"none"`), `peer_gate_uid` (the admitted integer uid or `null`), and `peer_gate_uid_source` (`"euid"`, `"env"`, or `null`) |
| `GET /state` | Full local state: running workers, retry queue, waiters |
| `GET /state/composite` | The same plus per-origin remote snapshots |
| `POST /quarantine/release` | Release the boot quarantine (host-addressed; `bin/shuttle release`) |
| `POST /remotes/:name/reset` | Reset a remote's tripped circuit breaker, forcing a cascade now rather than waiting out the trip cooldown — one reset buys exactly one cascade, and it 409s when the breaker is not tripped |

A TCP peer refused by the uid gate receives HTTP 403 before static assets
are served or a request body is parsed. Exposed hosts refuse TCP listeners at
boot; this response also describes the gate's defense-in-depth behavior if an
exposed TCP request reaches the plug:

```json
{"error":"peer_refused","reason":"uid 2000 is not the daemon's uid 1000"}
```

When `/proc` cannot resolve the peer, `reason` is
`"peer uid unresolved: no matching /proc TCP row"`. The `peer_gate` field on
`GET /version` reports whether this admission check is active for the daemon's
bound class and listener.

```bash
curl -s http://127.0.0.1:4000/api/v1/version | jq
curl -s http://127.0.0.1:4000/api/v1/agents  | jq
```

`GET /` outside `/api/v1` serves the board's `index.html`, or a 404 with a build
hint when `ui/dist` has never been built.
