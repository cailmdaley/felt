# The event stream and the ledgers — internals

Operator-facing coverage lives in
[Installing the shuttle daemon](../shuttle/installation.md#the-event-stream-and-the-ledgers)
and [Telemetry](../shuttle/telemetry.md); this page is the writer/reader contract.

## Owning the event stream — `shuttle hook event`

shuttle derives per-minute activity, per-session waiting state and the
sent-files trail from its OWN agent hook-event stream. `shuttle hook event`
(`internal/shuttlecli/hook_event.go`) appends one JSON line per hook event to
`$SHUTTLE_EVENTS_FILE`, else `events.jsonl` under the data directory.
`Shuttle.EventStream` is its one reader, and `internal/shuttlecli/events.go` mirrors
`Shuttle.EventStream.default_events_file/0` so the writer and the reader cannot
drift.

**The data directory** is `$SHUTTLE_DATA_DIR`, else `~/.shuttle`; the variable
is trimmed and a leading `~` or `~/` expands to the home directory, for every
file shuttle keeps there (event stream, ledgers, mailboxes, the class-default
socket, daemon state). Go resolves it in `shuttle.DataDir`
(`internal/shuttle/datadir.go`), Elixir in `Shuttle.data_dir/0`, and
`daemon/test/fixtures/data_dir/cases.json` holds both to the same answers.

**One reader, four projections.** `Shuttle.EventStream` decodes each line once and feeds four pure projections held in memory: activity (`Shuttle.Activity`), sent files (`Shuttle.SentFiles`), turn state (`Shuttle.WaitingTracker`), and session succession (`Shuttle.SessionBinding`).
It seeds from `events.jsonl.1` then the live file in `init/1`, before the Poller starts, and afterwards reads only appended bytes.
A rename rotation, recognized by the live path's inode moving, continues every projection: the tail of the old file is drained, then the new one is read from its start.
An in-place shrink or an unaccountable replacement rebuilds the projections from both files, retaining known turn state and session bindings where the remaining files cannot supply newer evidence.
The byte mechanics live in `Shuttle.FileTail`.

**The writer is the binary; the plugin registers it.**
`claude-plugin/hooks/event.sh` is a one-line shim (`exec shuttle hook event`),
registered in `claude-plugin/hooks/hooks.json` for SessionStart,
UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop, Notification,
and SessionEnd. `.codex-plugin` points at the same file, so Codex sessions
feed the stream too. Install with `felt setup claude` / `felt setup codex`;
`scripts/bootstrap.sh` step 5 does both and then probes the writer. No `jq`,
`perl`, or `hostname` — the whole line is built in Go, which is what makes it
work on a bare remote login node.

**Writing is gated on `~/.shuttle` already existing** — the daemon's state
directory is the opt-in, and the hook never creates it, so an install without
daemon state grows no stream. `SHUTTLE_EVENTS_FILE` overrides the gate and
creates its parent; `SHUTTLE_EVENTS=off` disables recording. The live file rotates to
`.jsonl.1` past `SHUTTLE_EVENTS_MAX_BYTES` (64 MiB) — once, under a flock of
the `.lock` sidecar, however many hooks see it full at the same moment — and a
`toolInput` over 8 KiB is trimmed to its file paths plus `truncated: true` — otherwise every
`Write` parks a whole file body in the stream.

### Session identity and worker binding

Turn state is keyed by the harness's `sessionId`, never by `tmuxSession`.
Events with an empty or `unknown` session id contribute no turn state.
Interactive and nested sessions can have their own records, but only the session explicitly bound to a running worker contributes that worker's phase.
A pane name remains transport context for terminals, sent files, and activity; sharing a pane is not evidence of session ownership.

The worker's `shuttle.runtime.session_uuid` is the binding anchor.
Claude launches with a daemon-generated UUID supplied through `--session-id`, and resume and claim paths supply their known session id.
Fresh Codex and Pi launches use the dispatcher's transcript capture to learn their UUID; until capture succeeds, the worker has no hook-derived phase.
There is no first-hook or first-session-in-the-pane fallback.
The runtime timestamp falls back to the worker's liveness timestamp when no session state is available.
Codex app workers retain their App Server's native phase signal.

Hook lines can also carry `receiverPid` and `receiverBirth`: the harness process's PID and birth token, obtained from the process running the hook rather than from an inherited worker environment variable.
Pi supplies its own process id; Claude and Codex hooks resolve their nearest non-shell ancestor.
The process key includes the harness and birth token, so nested harnesses and reused PIDs are distinct.
Linux birth tokens include the kernel boot identity.
If receiver identity cannot be read, the event still records and direct session-id joins still work.

`Shuttle.SessionBinding` follows a session-id change only through an explicit `session_start` in the same receiver process.
An ordinary tool, stop, notification, or session end cannot change the binding.
An explicit resume in a new receiver process transfers the session's lineage and retires the predecessor receiver.
Hooks from a retired receiver cannot mutate the resumed session's turn state.
The Poller persists a verified successor to `shuttle.runtime.session_uuid` without changing `dispatched_at`, and records the session-to-fiber pairing in the session ledger.
Capture callbacks are serialized through the Poller and tied to the launch that requested them, so a delayed capture cannot overwrite a later worker's identity.
Bindings and turn state are retained for 48 hours of activity and are replayed from the hook stream at daemon boot.

### Turn state and outstanding work

Every hook line carries `type`, `sessionId`, `tmuxSession`, `timestamp`, and the
harness/origin ids. Two more are written only where the harness volunteers them,
and both exist so `WaitingTracker` can tell "this session is blocked on a human"
from "this session is watching its own shells":

- **`notificationKind`** — Claude Code's `notification_type` passed straight
  through. `idle_prompt` is the ~60s "nobody has typed" timer; `permission_prompt`
  and the `elicitation_*` kinds mean the agent really is blocked on a person.
  When absent, including on Codex notifications, a notification sets attention.
- **`backgroundTasks`** — how much work a `Stop` or `SubagentStop` reports
  still running. The harness sends its whole background-task registry, already
  filtered to running and pending entries, and every kind counts: an MCP
  monitor or an in-process teammate IS something the session is waiting on, and
  the hour bound below is what keeps a long-lived one from silencing a lane.
  Omitted when zero. The payload is decoded tolerantly — an unexpected shape
  counts zero rather than failing the line, because the writer's error path
  drops the whole event and a stream with no stops reads as a fleet that never
  finishes a turn.

Each session holds a turn (`open`, `closed`, or `ended`), a background-task count, a live-child count, a pending human request, and its real last-event timestamp.
The phase is derived from those facts: a pending request is `attention`; an open turn is `working`; a closed turn with recent outstanding work is `working`; otherwise the session is `waiting`.

- `session_start` opens the turn and clears counts and pending requests.
- `user_prompt_submit` opens the turn and clears background work and pending requests, preserving the Codex child count.
- `stop` closes the turn, restates the background count, and clears pending requests.
- Permission, elicitation, and untyped notifications set a pending request.
  `idle_prompt` closes the turn without clearing an existing request.
- Tool progress clears pending requests and opens the turn, except for Codex child activity on an already-closed parent turn with live children.
- `session_end` ends the turn and clears counts and pending requests.
  Only a new `session_start` can reopen it.
- Sent files and unrecognized event types do not change turn state.

The background count carries forward until a prompt, session start, session end, or another stop changes it.
An idle notification knows nothing about those shells on its own.
A pending permission request takes precedence even when background work is running.

Codex states no count on its `Stop`, but its spawned agents leave a trail on the
parent's own stream: each `spawn_agent` or `followup_task` call (`tool` on a
`post_tool_use` line) starts a child turn and each `SubagentStop` ends one, and
the children's tool calls land on the parent's session too. `WaitingTracker`
counts starts minus stops as the session's live children. A `stop` over live
children holds: the children's tool events refresh its time without turning it
back into a running turn, and the `SubagentStop` that brings the count to zero
is when the session becomes the human's move. A prompt does not clear this
count, since no later stop restates it; a session start or end does.
The count is scoped to the parent's `sessionId` and starts only through the parent's explicit spawn or follow-up tool events.
A child's events under a different session id never alter the parent merely because they share a pane.
Identified child-count events are deduplicated within the 48-hour replay window.
A duplicate spawn event is inert for both the child count and the foreground turn.
The hook stream supplies no individual child identity or live registry; an incomplete stream can therefore leave a stale count until the bound expires.
Pi exposes turn activity through the shared event stream but no child registry here; idle Pi workers fall back to Your turn.
Child activity does not clear a pending human request on a closed parent turn.
A child completion changes the outstanding count, not whether someone has answered the parent's permission prompt.

**The suppression expires after an hour, and that bound is the whole safety
story.** Claude's carried background count is restated by the follow-up turn's stop rather than decremented on a child stop.
Codex's child count is decremented by `SubagentStop`. A
task that never returns has no such path, and left unbounded it would silence
its worker forever: a false "needs you" is noise a
person dismisses, a false "nothing to see" is a worker nobody looks at again.
Past the bound the session categorizes as if both counts were zero.

### Boot and incomplete histories

The daemon reconstructs session state from the retained raw event files; it does not migrate or copy a pane-keyed phase cache.
A worker with a known UUID can therefore recover its idle state immediately, including from event lines without receiver metadata.
A worker without a known UUID stays unattributed until dispatch capture or an explicit claim supplies it.
A session-id change without receiver evidence cannot be inferred safely from pane coincidence.
The same limit applies when the retained files no longer contain the anchor-to-successor relation and the continuation marker has not been updated.
Refreshing the installed harness hooks supplies receiver evidence for subsequent changes; the daemon does not rewrite old events.

`internal/shuttlecli/testdata/events_golden.jsonl` is the cross-language contract: written
byte-for-byte by `internal/shuttlecli/hook_event_test.go`, parsed by the Elixir projections in
`daemon/test/shuttle/events_parity_test.exs`. Each host's daemon follows its own
host's stream.

## The two ledgers

Beside the event stream sit two append-only ledgers, both read by the temporal
views as **join rung 0** — the structural pairing that replaces an inference.

- `~/.shuttle/sessions.jsonl` (`daemon/lib/shuttle/session_ledger.ex`) pairs a fiber
  with the harness session dispatched against it. **The daemon writes it**, at
  dispatch / claim / resume.
  Rows can also carry the `collaboration` assignment and the selected `agent`
  and configured `model` at that event. These are historical snapshots: a later
  reassignment or registry edit must not change them. A configured model can be
  a provider alias; it does not prove which concrete checkpoint served the
  request. Records lacking this information remain unattributed on those axes.
  The session provenance response preserves the snapshots on individual events
  as well as its current row, so a resumed session's assignment changes remain
  visible. Collaborator identity is separate from both the work's fiber UID and
  the execution model.
- `~/.shuttle/commits.jsonl` (`daemon/lib/shuttle/commit_ledger.ex`) pairs a commit
  with the session that made it: one line per commit carrying `sha`, `subject`,
  `repo`, the `--shortstat` counts, and `session` / `tmux` / `cwd`. It replaces
  parsing a fiber name out of a commit subject. **The hook writes it** —
  `shuttle hook commit`, which the plugin runs on `PostToolUse` for a Bash call
  (`claude-plugin/hooks/commit.sh`), appending a line when the call ran a `git
  commit` — because the pairing is only knowable inside the session's own
  process tree. The daemon is a reader only. Coverage is therefore partial:
  commits made outside an agent session, or before the plugin was installed,
  are absent — and there is **no fallback**. Only recorded, joined commits are
  ever drawn, so a day with no ledger has no prose rather than a guessed one.

Both are served host-scoped (`/api/v1/sessions`, `/api/v1/commits`) with a
cross-host `/composite` sibling. `Shuttle.RemoteTemporalRegistry` fetches a
remote's copy when a composite asks for it, never on a timer.
