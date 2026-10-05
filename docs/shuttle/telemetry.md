# Telemetry and the ledgers

The Desk needs only fibers and tmux. [Chronicle](board.md#chronicle-where-the-time-went)
and the Board's receipt ribbon and folios need a record of what happened, and
that record is three append-only JSONL files in the daemon's state directory.

| File | Written by | Carries |
|---|---|---|
| `~/.shuttle/events.jsonl` | `shuttle hook event`, from your agent harness (the coding-agent CLI you're running — Claude Code, Codex, …) | one line per harness hook event |
| `~/.shuttle/sessions.jsonl` | the daemon, at dispatch / claim / resume | one line per session: which fiber it belonged to |
| `~/.shuttle/commits.jsonl` | the plugin's `PostToolUse` hook on `Bash` (`shuttle hook commit`) | one line per commit: sha, subject, repo, `--shortstat` counts, and the session that made it |

All three resolve against `$SHUTTLE_DATA_DIR` (default `~/.shuttle`; the value
is trimmed and a leading `~` expands to your home), and each has its own
override: `SHUTTLE_EVENTS_FILE`, `SHUTTLE_SESSIONS_FILE`,
`SHUTTLE_COMMITS_FILE` (trimmed, blank counting as unset, otherwise taken as
written).

They are host-local by design. Every file records what happened on the machine
that wrote it, and a hub reads a remote's copy over the tunnel rather than
syncing it — which is why every temporal endpoint is host-scoped with a
`/composite` sibling that fans in every host the hub aggregates (the
**fleet**).

## The event stream

The raw material. `shuttle hook event` appends one JSON line per harness hook
event; `Shuttle.Activity` folds those lines into a **per-minute histogram** —
one bucket per `{minute, tmux session, cwd, kind}` — which is what Chronicle
draws.

The eight hook types collapse into three kinds, plus one facet laid over them:

- **attention** — a human typed (`UserPromptSubmit`), unless the event carries
  `machine: true`, meaning the harness injected that prompt and nobody was
  present. The recorder makes that call — `shuttle hook event` prefix-matches the prompt
  text against `machinePromptPrefixes` (internal/shuttlecli/hook_event.go), where a new
  harness's wrapper is taught by adding its prefix. The daemon never sniffs
  prompt text to guess.
- **notify** — the agent asked for a human, at the onset of the ask.
- **agent** — everything else. Any hook type invented later lands here rather
  than disappearing.
- **reply** — a *facet*, not a fourth slice: a `stop` hook (one finished agent
  turn) emits both an `agent` bucket and a `reply` bucket for the same minute.
  It is what makes a conversation countable in messages — the `9 back` in a
  cycle's era face, `you 14 · 9 back`. **Summing `n` across every bucket therefore
  counts each finished turn twice**; fold `agent` for effort, `reply` for
  message counts, never both.

The same stream feeds the in-flight idle ranking on the Desk and the
[Board's document receipts](../concepts/companions.md#sent-files-shuttle-only).

See [The event stream and the
ledgers](installation.md#the-event-stream-and-the-ledgers) for how it is
installed, and for the rotation and truncation rules.

## The session ledger

`~/.shuttle/sessions.jsonl` pairs a fiber with the harness session dispatched
against it — one line per session, not per event:

```json
{"fiber":"work/paper/edits","uid":"01KTS…","session":"0883ade1-…",
 "harness":"claude-code","host":"hub-mac","tmux":"edits-01KTS…-shuttle",
 "at":1786203000000,"kind":"dispatch"}
```

Nothing installs this — the daemon writes it itself, at each moment it
certainly knows the pairing (`kind` names which: `dispatch`, `claim`, or
`resume`).

The alternative is inference — read the tmux session name, pull the ULID out
of it, hope the worker is still alive — and that disappears the moment the
session ends, so nothing downstream could answer "which sessions has this card
had?" after the fact. The ledger makes the association structural, and the
line outlives the session.

Everything on Chronicle is joined through it. A minute that does not
resolve to a fiber the board carries is not drawn at all, so work started
outside shuttle is invisible there.

## The commit ledger

`~/.shuttle/commits.jsonl` pairs a commit with the session that made it. It is
what retired parsing a fiber name out of a commit subject line, and it is what
lets the Chronicle narrate a stretch of days in prose and count lines changed.

The pairing is only knowable inside the session's own process tree, where the
daemon is not — so the plugin writes it from a `PostToolUse` hook on `Bash`,
whenever the command ran a `git commit`. `shuttle hook commit` reads the commit
back, dedupes against the tail of the ledger, and appends one line. Installing
the plugin (`felt setup claude`, `felt setup codex`) is all it takes.

The file stays absent on a host with no `~/.shuttle` — a felt user who does not
run shuttle acquires nothing. There it is written, the commit strip fills, the
Chronicle narrates per fiber, and a [cycle](cycles.md)'s look back has a trail
to read. There is no git log fallback: only recorded, joined commits count, so
commits made outside an agent session do not appear.

To grow one yourself, append a line per commit with at least:

```json
{"at":1786203000000,"kind":"commit","sha":"79def80…",
 "subject":"desk: cycle lens","repo":"~/dev/felt",
 "files":3,"insertions":42,"deletions":7,
 "session":"0883ade1-…","tmux":"edits-01KTS…-shuttle","cwd":"~/dev/felt"}
```

`at` and `sha` are the two the reader requires. `session` is the join key: it
must be the harness session UUID, the same value the session ledger records. A
malformed line is skipped, never raised.

## When a ledger is missing

Every temporal feed is optional, and every failure path resolves to an empty
result rather than an error. A view with nothing to draw says so and moves on;
it does not break, and neither does the rest of the board.

That is also the first thing to check when Chronicle is blank: the event
stream only grows once `~/.shuttle` exists, because `shuttle hook event` refuses to
create its own directory. Bootstrap step 3 creates it, so a bootstrapped host is
already enabled — a CLI-only install is not.

## The endpoints

Every feed is host-scoped with a `/composite` sibling that merges this host's
read with every configured remote's, reporting per-origin freshness so a
disconnected host grays out rather than silently drawing an empty day.

| Route | Reads | Serves |
|---|---|---|
| `/api/v1/activity` | events | per-minute buckets |
| `/api/v1/sessions` | session ledger | fiber↔session pairings |
| `/api/v1/commits` | commit ledger | commit↔session pairings |
| `/api/v1/sent-files/all` | events | `SendUserFile` pushes |

**Nothing is fetched until someone looks.** A hub does not poll its remotes'
feeds in the background. A composite request is what asks each remote for its
copy of that feed, and a remote asked within the last minute is served from
the hub's cache instead. Each remote's last good answer is kept on disk under
`$SHUTTLE_DATA_DIR/remote-temporal/`, so an unreachable host keeps
contributing what it last said, and is marked stale once that answer is more
than ten minutes old. The hub asks for a remote's
activity over a trailing 14-day window whose end is quantized, so an unchanged
events file answers `304`.

**Every route answers `304` when its inputs have not moved.** `/activity`'s
validator is its window, quantized to the minute, plus the `{mtime, size}` of
the events file and its rotated sibling; the ledgers validate on their files.
A composite's validator adds each remote's cached copy of the feed.

The `304` is a bandwidth saving, not a cost model. A validator over
`events.jsonl` moves every few seconds on a busy host, so no route over it
relies on one: `Shuttle.EventStream` reads `events.jsonl.1` and `events.jsonl`
once at boot and holds three projections in memory — the activity fold, the
sent-file events and each session's last event — then reads only what has been
appended since its last poll, following a rotation by the file's inode. That is
what makes a request cost a `stat` and an in-memory read rather than a full
re-stream. A sent file therefore stays on the trail through one rotation and
leaves it with the second.

For the writer/reader contract behind the joins, see [The event stream and the
ledgers — internals](../dev/event-stream.md).
