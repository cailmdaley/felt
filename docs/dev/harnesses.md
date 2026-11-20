# Harnesses

A harness is an agent CLI that Shuttle runs workers on: Claude Code (`claude`), Codex (`codex`), Pi (`pi`) and Google's Antigravity CLI (`agy`).
This page says what a harness adapter provides, what Shuttle assumes of every harness, and what each of the four can and cannot do.
Read it before adding a harness or changing how Shuttle launches, resumes, messages or reads one.

## What an adapter is

An adapter is two things: facts, which are data, and verbs, which are code.
Everything else Shuttle does (dispatch, lifecycle, the inbox, the board) stays harness-blind and asks the adapter.

### Facts

`internal/harness` holds one record per harness, the source of every harness fact.
Every resolved agent record carries its harness's record under `harness` (`shuttle ls --json`, `shuttle show -j`, `shuttle agents resolve --json`), and the daemon reads `identity` and `idle_signal` from the record it already has.
Where the daemon holds only a harness's name, or a record from a CLI that carries no `harness`, each Elixir module answers the facts the daemon needs by name (`identity/0`, `idle_signal?/0` and the rest under Verbs); the conformance test holds those answers in parity with `facts.json`. `Shuttle.HarnessPaths` holds the daemon's transcript roots, resolved from the same variables as `transcripts`.

| Fact | Meaning | Read by |
|---|---|---|
| `name` | The one canonical spelling: an agent record's `cli`, an address's harness, the transcript index's harness | everything |
| `ledger` | The spelling in session-ledger rows and event-stream lines; differs only for Claude Code (`claude-code`). Readers accept either spelling | ledger and stream writers |
| `binary` | The executable a record without a `wrapper` runs | the agent registry |
| `identity` | `assigned`: the daemon picks the conversation id and passes it at launch. `reported`: the harness names it after launch | dispatch, identity capture |
| `delivery` | `native`: the harness's own message socket. `extension`: a socket Shuttle's extension opens in the harness. `paste`: typed into the terminal, which queues it behind a running turn. `inject`: context added to a running turn by a hook, and a wake typed into the terminal as with `paste` | messaging, receipts, the terminal input route |
| `idle_signal` | The hooks say when the human's turn has come | pulse eligibility, idle-only wakes |
| `interrupts` | The transcript records the human interrupting a turn | `shuttle hook interrupted`, `Shuttle.InterruptWatcher` |
| `transcripts` | The transcript tree: Shuttle's override variable, then the harness's own home variable, then a default under the home directory | the transcript index, the daemon's transcript readers |

A fact earns its place by a call site that branches on it.
There is no capability negotiation and no optional quality level.

### Verbs

Each language has one place per harness for the code Shuttle calls.

In the daemon, `Shuttle.Harness` is a behaviour with one module per harness (`Shuttle.Harness.Claude`, `.Codex`, `.Pi`, `.Antigravity`):

- `launch_command/3` and `resume_command/4`: the shell command lines, rendered from a resolved agent record. `Shuttle.Agents` puts the record's env assignments in front and renders the flags every harness shares.
- `find_session/3`: for a harness whose identity is reported, the conversation a worker started, matched by working directory, start time and the dispatch prompt's `Fiber: <id>` line, the id whole (`Shuttle.Harness.names_fiber?/2`), so fiber `a/b` never binds the conversation of `a/b-review`.
- Transcript readers: `usage_entries/1` (context and cache figures), `turn_record/1` (interrupts), `tasks/3` (the worker's own task list), `transcript_cwd/1` (where a History resume runs), `transcript_root/1` and `transcript_globs/2` (where a conversation's file is).
- A few answers for sites that hold only a harness's name, such as a ledger row or a stream line: `identity/0`, `idle_signal?/0`, `interrupts?/0`, `takes_paste?/0`, `receiver_succession?/0`, `resume_fallback/0`. The conformance suite holds each one to the Go facts.

In the CLIs, Go's package layering puts the verbs beside their callers: the `felt` binary may not import Shuttle or messaging packages, so one interface cannot hold install, transcript parsing and delivery.
Each package keeps one table keyed by the harness's name:

- `internal/messaging`: `adapters()`, each with `discover` (the sessions this host can reach) and `send`.
- `internal/transcriptindex`: `formats`, each saying which files under the root hold conversations, which conversation a file holds, and how to read one line for `shuttle find` and `shuttle show`.
- `internal/feltcli`: `pluginHarnesses`, each saying how `felt setup <harness>` installs the hooks and skills from the promoted plugin generation, how a harness that already carries felt follows a new generation, and how the setup receipt finds and verifies felt there.

Some behaviour belongs to one harness and stays outside the adapters, as that harness's extra rather than part of the contract:

- Claude's Remote Control (`Shuttle.RemoteControl`).
- Codex's hook trust (`internal/feltcli/codex_hook_trust.go`).
- In `Shuttle.Dispatcher`: Codex refuses a headless agent (`preflight_terminal/3`); a Codex worker's developer instructions merge the record's with the dispatch's; a quiet Claude resume runs interactive; and a Claude resume presses Enter to dismiss the resume warning.
- In `Shuttle.Poller`: a pulse to Claude holds a durable reservation until a later idle event, since Claude's native inbox can race a new turn.

### Hooks

Every harness's hooks reach Shuttle in one shape, Claude Code's hook payload (`hook_event_name`, `session_id`, `cwd`, `transcript_path`, `prompt`, `tool_name`, `tool_input`, `background_tasks`).
`shuttle hook event` records it on the host's event stream, registers the session's mailbox, records the turn state and offers queued messages; the daemon's `Shuttle.WaitingTracker` folds the stream into working, waiting and attention.
Every harness's hooks name the harness, so the handler never guesses it.
Claude Code and Codex run the same `event.sh`, which passes their payloads through; the plugin's `hooks.json` gives it `claude` as its argument, the Codex bundle's copy gives it `codex`, and it hands the name to `shuttle hook event` as `SHUTTLE_HOOK_HARNESS`.
A payload that names no harness comes from a shim installed before shims named one, which a running conversation keeps until it restarts and Codex's plugin cache keeps until `felt setup codex`; the handler infers its harness from the transcript path and Codex's payload fields.
Pi's extension sends the same shape with an explicit `harness`; its `Stop` is Pi's `agent_settled`, after any retry, compaction retry or queued follow-up, since `agent_end` can be followed by more of the same run.
Antigravity's shim runs `shuttle hook antigravity`, which translates agy's camelCase payload into this shape with `harness: "antigravity"` and answers in agy's shape.

The events Shuttle relies on:

| Event | Means |
|---|---|
| `SessionStart` | A conversation started; for a reported identity, its id |
| `UserPromptSubmit` | The human (or Shuttle, for a machine prompt) started a turn |
| `PreToolUse`, `PostToolUse` | The worker is working |
| `Stop` | The turn ended; a non-empty `background_tasks` means work it started is still running, so the turn stays open |
| `SessionEnd` | The conversation ended |

### The calling session

A `shuttle` command run by a worker acts for the harness session running it: a bare `close`, `rest` or `handoff` closes that session's fiber, and `message`, `send-file`, `claim`, `migrate`, `thread` and `find` attribute their work to it.
`currentSession` in `internal/shuttlecli/messaging.go` is the one place that finds it.
Harnesses nest, and a child process inherits every parent's exported session id (agy's `ANTIGRAVITY_CONVERSATION_ID` reaches a Claude or Codex process started inside agy), so the environment cannot say which harness is nearest.
Process ancestry can: each session's hooks register a receiver with the harness's process id, and the nearest live one among the caller's ancestors wins.
The environment decides only when ancestry names no one, or two receivers share the nearest process (one Codex app server for many threads).
Pi's own marker, `AI_AGENT=pi` with `PI_SESSION_ID`, outranks another harness found by ancestry, since a Pi that registered no receiver is invisible there; a Codex or agy session started inside Pi therefore reads as its Pi parent.
Each harness sets its own variable for its children, so when ancestry finds a harness whose exported id differs, that id is a nearer session of the same harness that registered nothing (its hooks off or untrusted), and it is the caller; it has no binding of its own, so a bare `close` refuses instead of closing the parent's fiber.
`shuttle message` alone keeps the registered receiver as its sender, since that is what a reply reaches.
What stays out of reach is an unregistered session under a registered session of another harness, a Codex without hooks inside a Claude worker say: the environment cannot place it, and ancestry names the parent.
A hook binds the session its payload names, not the caller's, since it fires before its session has registered.

### Conformance

`daemon/test/fixtures/harnesses/` is the fixture set both suites run against every adapter:

- `facts.json`: the Go table as it marshals. `internal/harness` regenerates it (`UPDATE_HARNESS_FACTS=1 go test ./internal/harness`) and fails when it is stale; the daemon's `harness_conformance_test.exs` checks that every harness in it has one module, answering as the table does.
- `<harness>/commands.json`: a fixed resolved agent record and the launch, headless launch, resume and quiet resume command lines it renders.
- `<harness>/transcript.jsonl`: a recorded transcript. The Go transcript index must find every role in it (`TestNativeFixturesRolesAndSkippedPayloads`), and every daemon reader must take every record.
- `<harness>/usage*.jsonl`: field-selected usage records the daemon's `transcript_usage_test.exs` reads.
- `antigravity/hooks/`: agy's hook payloads from one recorded session, replayed through `shuttle hook antigravity` (`TestAntigravityHooksReplayAsShuttleEvents`).
- `claude/hooks/`, `codex/hooks/`: Claude Code's and Codex's hook payloads from one recorded session each, replayed through `shuttle hook event` with the shim's harness name and without it (`TestRecordedClaudeAndCodexHooksRecordTheirHarness`).

Real binaries are not in the suite.
A new harness's live behaviour is checked once by hand, and what it cannot do is written in its section below.

## Adding a harness

1. Probe the CLI: launch with a first prompt, resume, how its id is learned, what its hooks send and what they read back, its transcript's shape and place.
2. Add its record to `internal/harness` and regenerate `facts.json`.
3. Add its daemon module, its messaging adapter, its transcript format and its `felt setup` verb.
4. Record its fixtures, and add its registry agents to `internal/shuttle/agents.builtin.json`.
5. Write its section here, gaps included.

## Claude Code

- **Launch**: `claude --session-id <uuid> <flags> <<< '<prompt>'`; the prompt is on stdin, effort is `--effort`, `--chrome` and headless `-p` are Claude-only. A worker that may be a login-shell function runs as the script's command word.
- **Identity**: assigned. The daemon generates the UUID and records it before the worker starts.
- **Resume**: `--resume <uuid>`; a failed resume falls back to a fresh conversation under the same id. The daemon presses Enter two seconds in to dismiss Claude's resume warning.
- **Delivery**: native, through `CLAUDE_CODE_MESSAGING_SOCKET`; a busy session takes a message as a queued command. Hooks offer queued context on `UserPromptSubmit` and `PostToolUse`.
- **Transcript**: `$CLAUDE_CONFIG_DIR/projects/<slug>/<uuid>.jsonl`; task lists in the tasks root beside it.
- **Instructions**: `CLAUDE.md`, the plugin's skills.
- **Installed by**: `felt setup claude`, through Claude Code's plugin marketplace.

## Codex

- **Launch**: `env -u TMUX -u TMUX_PANE codex <flags> '<prompt>'`; effort is `-c model_reasoning_effort`, a record's developer instructions are `-c developer_instructions`.
- **Identity**: reported, by the rollout file under the date-fanned sessions root.
- **Resume**: `codex resume <uuid> ['<prompt>']`, with no fresh fallback.
- **Delivery**: paste. A wake is typed into the terminal, which queues it behind a running turn; hooks offer queued context on `SessionStart`, `UserPromptSubmit` and the tool events.
- **Transcript**: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*<uuid>.jsonl`; the task list is the latest `update_plan` call.
- **Instructions**: `AGENTS.md`, the launch prompt, the `felt-skills` bundle.
- **Installed by**: `felt setup codex`, two generated plugin bundles, with the hooks trusted through Codex's app server.

## Pi

- **Launch**: `pi <flags> '<prompt>'`, never on stdin, which switches Pi to print mode; effort is a `:level` suffix on the model.
- **Identity**: reported, by the session file in the working directory's folder under the sessions root.
- **Resume**: `--session <uuid>`; a failed resume starts fresh and the identity is captured again.
- **Delivery**: extension. Shuttle's Pi extension opens a socket that steers a busy turn and follows up an idle one. An idle-only wake (a pulse) carries `idleOnly`, and the extension refuses it as busy unless Pi has settled (`ctx.isIdle()`); a Confer job, which has no such check, refuses every idle-only wake.
- **Turns**: the extension reports `SessionStart`, `UserPromptSubmit` (before each run starts), the tool events, `Stop` on `agent_settled`, and `SessionEnd`. Pi has no background-task registry, so its `Stop` carries no `background_tasks`.
- **Transcript**: `$PI_CODING_AGENT_DIR/sessions/--<cwd>--/…<uuid>.jsonl`, with `PI_CODING_AGENT_DIR` defaulting to `~/.pi/agent`.
- **Instructions**: the launch prompt, the package's skills.
- **Installed by**: `felt setup pi`, which registers the promoted plugin generation itself as a local package with `pi install`; later promotions change what it loads in place.

## Antigravity

Observed on agy 1.5.13.

- **Launch**: `agy <flags> --settings '<json>' -i '<prompt>'`. Effort is the model slug's suffix (`--model gemini-4-neon-high`; `agy models` lists the slugs, and no bare family runs, so every agent declares a default effort). `--settings` applies to this session only and is never saved: `{"altScreenMode":"never","trustedWorkspaces":["<project_dir>"],"artifactReviewPolicy":"always-proceed"}` skips the first-run screen and trust questions. The registry's agents add `--dangerously-skip-permissions` and `AGY_CLI_DISABLE_AUTO_UPDATE=true` from their record; agy's default command sandbox denies the Shuttle state directory and the daemon's port. A record's `extra_flags` can add `--agent <name>`, and a login-shell wrapper that adds one applies to workers as it does to the operator's own sessions, as Claude's and Pi's wrappers do.
- **Identity**: reported, by the SessionStart hook. agy fires it under `-i`, before the first model call, with `conversationId`, `transcriptPath` and `cwd`; `shuttle hook antigravity` writes it to the event stream, and `Shuttle.Harness.Antigravity.find_session/3` matches it to the worker. agy exports `ANTIGRAVITY_CONVERSATION_ID` to its hooks and commands, which is how a worker's own `shuttle` calls know their session when ancestry names none (see [The calling session](#the-calling-session)). It and nine other `ANTIGRAVITY_*` variables reach every descendant, so the daemon's launch scripts clear the whole family before a worker starts.
- **Resume**: `--conversation <id> [-i '<prompt>']` keeps the history; without `-i` it opens interactively. No fresh fallback.
- **Delivery**: inject. A `PreInvocation` hook, which runs before every model call, prints queued context as `{"injectSteps":[{"systemMessage":{"systemMessage":"…"}}]}`, and it reaches a turn already running. A wake is typed into the terminal, which queues it behind a running turn, as Codex's does. A conversation resumed without a prompt fires no hook until its next turn, so the daemon finds its receiver by the `--conversation <id>` process in the worker's terminal, as it finds Codex's by `resume <id>`.
- **Turns**: a `PreInvocation` with `invocationNum` 0 starts a turn. `Stop` with `fullyIdle: false` leaves a background command running, and agy wakes itself when it ends, starting a turn that repeats the last input; `shuttle hook antigravity` remembers a digest of each conversation's last input and its last Stop, so that turn does not read as a prompt. That turn state sits under the Shuttle state directory, written only where the directory exists; agy reports no session end, so each SessionStart removes states idle for a week. Only `Stop` with `fullyIdle: true` is the human's turn.
- **Tool hooks print nothing**: agy reads a `PreToolUse` hook's JSON as a decision, and `{}` denies the tool, so the tool events run `hooks/agy.sh tool`, which discards whatever shuttle prints. The shim gives shuttle five seconds; `hooks.json` gives each hook ten (agy's `timeout` is in seconds, default 30).
- **Transcript**: `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl`, one step per line (`source`, `type`, `created_at`, `content`, `tool_calls`, and on model steps `input_tokens` and `cache_read_tokens`). The human's text sits inside `<USER_REQUEST>`. `transcript.jsonl` beside it truncates long fields, so readers take it only when the full one is missing.
- **Instructions**: agy reads `AGENTS.md` and `GEMINI.md`, not `CLAUDE.md`. Workers get theirs from the launch prompt and the plugin's felt and shuttle skills.
- **Installed by**: `felt setup antigravity`, which copies the promoted generation's agy plugin to `~/.gemini/config/plugins/felt/`: `plugin.json` and `hooks.json` at its root, `hooks/agy.sh` and the `hooks/shuttle-bin.sh` it sources, and `skills/`. agy loads any plugin directory there with a `plugin.json` at its next start, with no `agy plugin install`; hooks run with the plugin directory as their working directory and `PLUGIN_ROOT` set. The receipt reads `agy plugin list --json`.

## Gaps

What each harness cannot do, as Shuttle runs it today:

- **Claude Code**: its harness name is spelled two ways, `claude` and `claude-code` in ledgers, on the event stream and in the daemon's session links. The readers that branch on it accept both, through `harness.Normalize` and `Shuttle.Harness.normalize/1`: Go's session bindings and hook handler, the daemon's session bindings, board family, waiting tracker, resume guard (`Dispatcher.effective_resume_intent/3`) and relayed session links; the board only displays it. Writing `claude` everywhere waits on every host running a build whose readers accept both, since a host on an older build that reads another host's rows (a board's session links relayed between daemons) drops a `claude` row's Remote Control link; persisted rows keep `claude-code`, so readers keep the alias after the writers switch.
- **Codex**: no fresh fallback on a failed resume; no Remote Control.
- **Pi**: no interrupt reading, though `agent_settled` carries `aborted` when the human cancels with Escape; no task list; its transcript root does not follow `PI_CODING_AGENT_SESSION_DIR` or the `sessionDir` setting, which move Pi's sessions out of its agent directory.
- **Antigravity**:
  - Its conversation id cannot be assigned at launch, and SessionStart does not fire on resume.
  - No interrupt detection. On agy 1.5.13, Escape fires no hook: five cancels, two while the model streamed text and three during or just after a tool call, brought no `Stop` (and, in the two watched for it, no `PostInvocation`), so a cancelled turn stays working on the event stream until the next prompt. `USER_CANCELED`, which agy documents as a `Stop` `terminationReason`, was not observed. The only traces are agy's own: the transcript recorded an `ERROR_MESSAGE` "The stream was interrupted" for the two mid-stream cancels and nothing for the other three, and agy's debug log (`~/.gemini/antigravity-cli/log/cli-<start>.log`) wrote `Cancel requested for cascade <conversation id>` for all five. Neither is read: the first misses cancels during tools, the second is an unversioned debug log.
  - No Remote Control, no task list, no context-budget handoff nudge, and no skill-activation gate.
  - Its transcript records no working directory, so `shuttle find` hits carry no project, and a History resume needs the session start still on the event stream.
