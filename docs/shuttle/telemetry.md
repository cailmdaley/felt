# Telemetry and the ledgers

The Desk needs only fibers and tmux. The time views —
[Day, Week, Chronicle](board.md#day-week-chronicle-where-the-time-went) and the
Board canvas — need a record of what happened, and that record is three
append-only JSONL files in the daemon's state directory.

| File | Written by | Carries |
|---|---|---|
| `~/.shuttle/events.jsonl` | `felt hook event`, from your agent harness (the coding-agent CLI you're running — Claude Code, Codex, …) | one line per harness hook event |
| `~/.shuttle/sessions.jsonl` | the daemon, at dispatch / claim / resume | one line per session: which fiber it belonged to |
| `~/.shuttle/commits.jsonl` | the plugin's `PostToolUse` hook on `Bash` (`felt hook commit`) | one line per commit: sha, subject, repo, `--shortstat` counts, and the session that made it |

All three resolve against `$SHUTTLE_DATA_DIR` (default `~/.shuttle`), and each
has its own override: `SHUTTLE_EVENTS_FILE`, `SHUTTLE_SESSIONS_FILE`,
`SHUTTLE_COMMITS_FILE`.

They are host-local by design. Every file records what happened on the machine
that wrote it, and a hub reads a remote's copy over the tunnel rather than
syncing it — which is why every temporal endpoint is host-scoped with a
`/composite` sibling that fans in every host the hub aggregates (the
**fleet**).

## The event stream

The raw material. `felt hook event` appends one JSON line per harness hook
event; `Shuttle.Activity` folds those lines into a **per-minute histogram** —
one bucket per `{minute, tmux session, cwd, kind}` — which is what the time
views draw.

The eight hook types collapse into three kinds, plus one facet laid over them:

- **attention** — a human typed (`UserPromptSubmit`), unless the event carries
  `machine: true`, meaning the harness injected that prompt and nobody was
  present. The recorder makes that call — `felt hook event` prefix-matches the
  prompt text against `machinePromptPrefixes` (cmd/hook_event.go), where a new
  harness's wrapper is taught by adding its prefix. The daemon never sniffs
  prompt text to guess.
- **notify** — the agent asked for a human, at the onset of the ask.
- **agent** — everything else. Any hook type invented later lands here rather
  than disappearing.
- **reply** — a *facet*, not a fourth slice: a `stop` hook (one finished agent
  turn) emits both an `agent` bucket and a `reply` bucket for the same minute.
  It is what makes a conversation countable in messages — the `9 back` in the
  Week view's `you 14 · 9 back`. **Summing `n` across every bucket therefore
  counts each finished turn twice**; fold `agent` for effort, `reply` for
  message counts, never both.

The same stream feeds the in-flight idle ranking on the Desk and the
[sent-files trail](../concepts/companions.md#sent-files-shuttle-only) behind the
Board canvas.

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

It exists because that pairing used to be *inferred*: read the tmux session
name, pull the ULID out of it, hope the worker is still alive. The inference
disappears the moment the session ends, so nothing downstream could answer
"which sessions has this card had?" after the fact. The ledger makes the
association structural, and the line outlives the session.

Everything on the time views is joined through it. A minute that does not
resolve to a fiber the board carries is not drawn at all, so work started
outside Shuttle is invisible there.

## The commit ledger

`~/.shuttle/commits.jsonl` pairs a commit with the session that made it. It is
what retired parsing a fiber name out of a commit subject line, and it is what
lets the Chronicle narrate a stretch of days in prose and count lines changed.

The pairing is only knowable inside the session's own process tree, where the
daemon is not — so the plugin writes it from a `PostToolUse` hook on `Bash`,
whenever the command ran a `git commit`. `felt hook commit` reads the commit
back, dedupes against the tail of the ledger, and appends one line. Installing
the plugin (`felt setup claude`, `felt setup codex`) is all it takes.

The file stays absent on a host with no `~/.shuttle` — a felt user who does not
run Shuttle acquires nothing. There it is written, the commit strip fills, the
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

That is also the first thing to check when a time view is blank: the event
stream only grows once `~/.shuttle` exists, because `felt hook event` refuses to
create its own directory. Bootstrap step 3 creates it, so a bootstrapped host is
already enabled — a felt-only install is not.

## The endpoints

All but `/moment` are host-scoped with a `/composite` sibling that merges every
configured remote's cached feed, reporting per-origin freshness so a disconnected
host grays out rather than silently drawing an empty day. `/moment` has no
composite: a transcript is one file on one machine, so the request names that
machine with `host` and the serving daemon forwards it.

| Route | Reads | Serves |
|---|---|---|
| `/api/v1/activity` | events | per-minute buckets |
| `/api/v1/sessions` | session ledger | fiber↔session pairings |
| `/api/v1/commits` | commit ledger | commit↔session pairings |
| `/api/v1/sent-files/all` | events | `SendUserFile` pushes |
| `/api/v1/spend` | session ledger + transcripts | per-session and per-fiber token rollups |
| `/api/v1/moment` | the harness transcript | the words a session spoke in a window |

`/spend` is the one with no board consumer today: the time views derive their
minutes from activity buckets, not from token counts. It is a tested API
surface, reachable by hand.

For the design behind the joins, see the [Architecture
notes](https://github.com/cailmdaley/felt/blob/main/AGENTS.md).
