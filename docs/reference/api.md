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
| `POST /kill` | owner-routed | Hard-kill a fiber's live worker |
| `POST /claim` | owner-routed | Register an externally-spawned tmux session as a fiber's worker |
| `POST /capture` | owner-routed | Launch a session from a free-text prompt; it files the fiber and claims itself |
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
| `GET /file` | owner-routed | Raw bytes by absolute path — what makes `:::{embed}` and relative images work for a remote-owned fiber |
| `GET /file-info` | owner-routed | File existence, mtime, and size without downloading bytes — the live reader's change probe |
| `GET /transcript` | host-routed | Availability receipt for a native session transcript, including its authoritative path and digest |
| `GET /transcript/raw` | host-routed | Exact native JSONL bytes for a session — no parsing or normalization |
| `GET /astra` | owner-routed | Bake an `astra.yaml` to MyST mdast. **Maintainer-only**: needs `node` plus a built MySTRA checkout beside the repo on the owning host |

`/file` sits outside the JSON pipeline on purpose: it returns arbitrary content
types, so a strict `Accept: application/pdf` would otherwise 406 before the
controller ran.

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

A read serves a `digest` — a hash of the bytes as sent. Send it back as
`expected_digest` and the write is refused with a **409** if the file has moved
since, which matters because this board is reachable from two hubs and a phone
at once and an editor left open while a CLI writes the same file would
otherwise save its stale text back over the new one. The two whole-list
endpoints (`/felt-stores`, `/projects`) take the same key for the same reason.
Omit it entirely for last-write-wins, which is what a script wants. (A hash
rather than an mtime: POSIX mtime is second-granular, so a write landing in the
same second as the read is invisible to it, and that is exactly the
interleaving a fast tool produces.)

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
| `GET /version` | Daemon build stamp — the liveness probe, and what a deploy verifier watches (`git_short_sha` AND `booted_at` must both move) |
| `GET /state` | Full local state: running workers, retry queue, waiters |
| `GET /state/composite` | The same plus per-origin remote snapshots |
| `POST /quarantine/release` | Release the boot quarantine (host-addressed; `bin/shuttle release`) |
| `POST /remotes/:name/reset` | Reset a remote's tripped circuit breaker, forcing a cascade now rather than waiting out the trip cooldown — one reset buys exactly one cascade, and it 409s when the breaker is not tripped |

```bash
curl -s http://127.0.0.1:4000/api/v1/version | jq
curl -s http://127.0.0.1:4000/api/v1/agents  | jq
```

`GET /` outside `/api/v1` serves the board's `index.html`, or a 404 with a build
hint when `ui/dist` has never been built.
