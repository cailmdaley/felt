# The event stream and the ledgers — internals

Operator-facing coverage lives in
[Installing the shuttle daemon](../shuttle/installation.md#the-event-stream-and-the-ledgers)
and [Telemetry](../shuttle/telemetry.md); this page is the writer/reader contract.

## Owning the event stream — `felt hook event`

shuttle derives per-session activity (`WaitingTracker`) and the sent-files trail
(`SentFiles`) from its OWN agent hook-event stream. `felt hook event`
(`cmd/hook_event.go`) appends one JSON line per hook event to
`$SHUTTLE_EVENTS_FILE` (default `~/.shuttle/events.jsonl`, dir
`$SHUTTLE_DATA_DIR`). The readers read ONLY this path, and
`cmd/shuttle_events.go` mirrors `WaitingTracker.default_events_file/0` so the
writer and the readers cannot drift.

**The writer is the binary; the plugin registers it.**
`claude-plugin/hooks/event.sh` is a one-line shim (`exec felt hook event`), wired
in `claude-plugin/hooks/hooks.json` on SessionStart, UserPromptSubmit,
PreToolUse, Stop, SubagentStop, Notification, and SessionEnd. `.codex-plugin`
points at the same file, so Codex sessions feed the stream too. Install with
`felt setup claude` / `felt setup codex`; `bootstrap.sh` step 5 does both and
then probes the writer. No `jq`, `perl`, or `hostname` — the whole line is built
in Go, which is what makes it work on a bare remote login node.

**Writing is gated on `~/.shuttle` already existing** — the daemon's state
directory is the opt-in, and the hook never creates it, so a felt-only install
grows no stream. `SHUTTLE_EVENTS_FILE` overrides the gate (and creates its
parent); `SHUTTLE_EVENTS=off` disables recording. The live file rotates to
`.jsonl.1` past `SHUTTLE_EVENTS_MAX_BYTES` (64 MiB), and a `toolInput` over
8 KiB is trimmed to its file paths plus `truncated: true` — otherwise every
`Write` parks a whole file body in the stream.

### The two fields that keep a busy worker out of the attention column

Every hook line carries `type`, `sessionId`, `tmuxSession`, `timestamp`, and the
harness/origin ids. Two more are written only where the harness volunteers them,
and both exist so `WaitingTracker` can tell "this session is blocked on a human"
from "this session is watching its own shells":

- **`notificationKind`** — Claude Code's `notification_type` passed straight
  through. `idle_prompt` is the ~60s "nobody has typed" timer; `permission_prompt`
  and the `elicitation_*` kinds mean the agent really is blocked on a person.
  Absent on Codex and on any line written before this existed, in which case a
  notification is attention, exactly as it always was.
- **`backgroundTasks`** — how much work a `Stop` or `SubagentStop` reports
  still running. The harness sends its whole background-task registry, already
  filtered to running and pending entries, and every kind counts: an MCP
  monitor or an in-process teammate IS something the session is waiting on, and
  the hour bound below is what keeps a long-lived one from silencing a lane.
  Omitted when zero. The payload is decoded tolerantly — an unexpected shape
  counts zero rather than failing the line, because the writer's error path
  drops the whole event and a stream with no stops reads as a fleet that never
  finishes a turn.

`WaitingTracker` remembers the count on the session and carries it forward until
a prompt or a session start clears it, because the idle `notification` that
arrives a minute after the stop knows nothing about those shells on its own. A
session sitting on `bg > 0` categorizes as `working`, not `waiting` or
`attention` — nobody is being asked for anything. A permission prompt overrides
that: the human is the blocker there, running shells or not.

**The suppression expires after an hour, and that bound is the whole safety
story.** Nothing decrements the count when a task finishes — work that ends
triggers a follow-up turn whose stop restates it, which is the ordinary path. A
task that never returns has no such path, and left unbounded it would silence
its worker forever: a false "needs you" is noise a
person dismisses, a false "nothing to see" is a worker nobody looks at again.
Past the bound the session categorizes as if the count were zero.

`cmd/testdata/events_golden.jsonl` is the cross-language contract: written
byte-for-byte by `cmd/hook_event_test.go`, parsed by both Elixir readers in
`test/shuttle/events_parity_test.exs`. Each host's daemon tails its own host's
`~/.shuttle/events.jsonl`.

## The two ledgers

Beside the event stream sit two append-only ledgers, both read by the temporal
views as **join rung 0** — the structural pairing that replaces an inference.

- `~/.shuttle/sessions.jsonl` (`lib/shuttle/session_ledger.ex`) pairs a fiber
  with the harness session dispatched against it. **The daemon writes it**, at
  dispatch / claim / resume.
- `~/.shuttle/commits.jsonl` (`lib/shuttle/commit_ledger.ex`) pairs a commit
  with the session that made it: one line per commit carrying `sha`, `subject`,
  `repo`, the `--shortstat` counts, and `session` / `tmux` / `cwd`. It replaces
  parsing a fiber name out of a commit subject. **The hook writes it** —
  `~/loom/hooks/shuttle-hook.sh` on `PostToolUse` for a Bash call that ran a
  `git commit` — because the pairing is only knowable inside the session's own
  process tree. The daemon is a reader only. Coverage is therefore partial:
  commits made before the hook, outside a session, or on a host whose events
  come from the `felt hook event` writer instead are absent — and there is **no
  fallback**. Only recorded, joined commits are ever drawn, so a day before the
  hook has no prose rather than a guessed one. Note too that the writer ships
  outside this repo, so a public adopter's commit ledger stays empty until they
  write their own.

Both are served host-scoped (`/api/v1/sessions`, `/api/v1/commits`) with a
cross-host `/composite` sibling fed by `Shuttle.RemoteTemporalRegistry`.
