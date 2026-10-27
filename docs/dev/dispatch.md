# Dispatch internals

How the daemon decides what to run, and what the worker's prompt looks like.
The operator-facing lifecycle is in [Lifecycle](../shuttle/lifecycle.md).

## How dispatch works

- **Poller** (`daemon/lib/shuttle/poller.ex`) owns the tick. It walks each
  configured felt store with one projected listing (`shuttle ls --json
  --has-field shuttle --json-field …`), and considers a fiber eligible iff it
  carries a `shuttle:` block owned by this host (`shuttle.host` matches), felt
  `status` is `active`, and it isn't already running/claimed (see `eligible?/2`
  in poller.ex). A listing that fails or times out degrades that store to its
  last-known rows for the tick; there is no broader fallback listing. A shuttle
  CLI too old for the projection flags shows up at boot as a contract skew.
- **Host identity is shuttle's.** The Poller takes `SHUTTLE_HOST` (trimmed) or
  asks `shuttle host --json` once at boot and freezes the answer; a shuttle CLI
  that cannot answer stops the daemon from booting. The host-file and hostname
  chain lives only in the Go CLI (`internal/shuttlecli/host.go`).
- **Eligibility is pure; the filesystem is the dispatch action's business.**
  `eligible?/2` reads fiber frontmatter and in-memory runtime maps and nothing
  else. Whether a `project_dir` exists is decided inside
  `do_dispatch_fiber/3` — for a fiber that has passed every pure gate and is
  about to have a worker spawned into that directory. The reason is TCC: a
  `project_dir` in a macOS file provider (iCloud Drive,
  `~/Library/CloudStorage`) answers every touch with an "access data from other
  apps" prompt that cannot be granted to a launchd-run daemon, so the cost of a
  touch is a dialog on someone's screen, not a syscall. A fiber the poller
  merely looks at each tick — parked, closed, or refused — is never touched,
  however long it sits there.
- **A missing `project_dir` refuses the dispatch.** Present-but-missing means
  the checkout lives on another machine, so the fiber is refused with
  `{:project_dir_missing, dir}` rather than having its worker silently
  downgraded to a felt store as its cwd. A force-dispatch skips the check like
  every other non-force gate. The refusal is recorded as a dispatch failure, so
  the fiber appears in the snapshot's `blocked` list with its reason instead of
  vanishing from the board, and a successful dispatch clears the row. It also
  rides the preflight cooldown (`@preflight_cooldown_ms`, 5 minutes): a
  directory that is absent — or that this daemon is denied, which is the same
  `File.dir?` answer — will not appear between two ticks, so it is retried once
  per window rather than once per tick.
- **Workers are NOT excluded from sharing a checkout.** Several workers may run
  in one `project_dir` at once, and shuttle says nothing about it. Coordinating
  concurrent work in a shared checkout is the operator's call, not the
  dispatcher's.
- **Configured stores** come from `SHUTTLE_STORES` (comma-separated env var) →
  persisted `~/.config/shuttle/stores.json`. There is no implicit default store.
  `POST /api/v1/felt-stores` rewrites the persisted file. Inside the daemon,
  `Shuttle.FeltStores` maps a fiber to the store that holds it
  (`store_for_fiber`, `resolve_fiber` → `%{store, fiber_id, path, uid}`).
- **Picker projects** are a separate list — `SHUTTLE_PROJECTS` → persisted
  `~/.config/shuttle/projects.json` (`Shuttle.Projects`) — and answer a different
  question: which checkouts a human can file INTO from the Stash/Capture forms.
  Kept out of the poll list on purpose, so polling never walks TCC-protected
  paths. Served at `origins.<host>.projects` of `GET /api/v1/felt-stores`. The
  file is hand-editable, and the forms add to it too. Both forms show the
  destination as **host then project** (`ui/src/forms/ProjectPicker.tsx` —
  `HostPicker` and `ProjectPicker`, both plain `<select>`s, sized to match the
  agent and effort selects beside them). The host list is the origins of `GET
  /api/v1/felt-stores`, derived in `projectModel.ts` (`deriveHosts`) alongside
  the projects so the two can't disagree; it defaults to the LOCAL origin, and
  the project list is `projectsForHost` of the selection — one host's projects,
  no host suffix on the rows.

  The "add" row is a `<select>` option, not a custom combobox: a floating list
  portalled into `<body>` sits outside the React root and never sees React
  18's delegated clicks. The option is safe because it is a sentinel, not a
  state: `interpretProjectChange` maps its
  value to `{kind: 'add'}`, so `onChange` runs the add flow and restores the
  previous selection (controlled `value` untouched, plus a direct write back to
  the DOM node), and it sits alone in a leading `<optgroup>` so it never reads
  as a project. The placeholder shown when nothing is selected is `disabled`,
  so type-ahead and arrows cannot land there either.

  The project select's FIRST option is "Add a new project…", over `POST
  /api/v1/projects` (`{"path": …, "origin": …}` — runs `felt -C <path> init`,
  which creates `<path>/.felt` when absent, then appends the path; idempotent).
  With the host already settled, that has exactly two shapes: on the **local**
  host with a dialog, `POST /api/v1/choose-folder` raises the host's own
  (`Shuttle.FolderPicker` — Finder via `osascript`, else zenity, else kdialog)
  and answers `{ok: true, path}`, `{ok: false, cancelled: true}` on a
  dismissal, or 501 when the host has none; it blocks until the human answers
  (bounded at five minutes). On any **remote** host (whose dialog would open on
  a desktop nobody is at) or a local daemon with no dialog, the add row instead
  asks for the absolute path on that host and posts it straight to
  `/api/v1/projects`, showing the owning daemon's own 400 ("not a directory:
  …") inline. The UI picks between the two from the `native_folder_picker` flag
  on each origin of `GET /api/v1/felt-stores`. Both endpoints are owner-routed.
- **Dispatcher** (`daemon/lib/shuttle/dispatcher.ex`) resolves the agent and chooses its execution backend.
  Claude and Pi workers use `<leaf>-<uid>-shuttle` tmux sessions, parsed by `Shuttle.ULID.from_tmux/1`.
  Codex uses a durable `AppWorkers` record on either surface; terminal presentation opens a `codex-terminal-<thread-id>` viewer after the backend confirms the initial turn.
  Conversation identity is known before dispatch is published, without scraping a rollout or guessing which thread a terminal currently shows.
  A fiber without a ULID `id:` is refused with `{:uid_missing, message}`, a preflight refusal like the others (the `blocked` row, the dispatch API's 422, the preflight cooldown).
- **Standing constitutions** — `shuttle.kind: standing` with a cron
  `schedule:`. Nothing due is stored: an armed (`active`, untempered) one is due when a
  cron occurrence has passed since it was last serviced — the later of
  `shuttle.runtime.dispatched_at`, `handed_off_at` and the fiber's creation
  (`StandingRoles.standing_role_due?/1`). Manual dispatch is ad-hoc
  (`adhoc-<ms>` run id). Worker exit closes it into Awaiting review, and
  `shuttle accept` or `resume` re-arms it and stamps `handed_off_at` in
  the same write, so the just-served occurrence never fires again.
- **A finished run is finished — there is no reopen.** When a oneshot's
  worker is gone, `Dispatcher.check_resume_intent/2` decides between resuming
  its transcript and starting fresh. A `handed_off_at` newer than
  `dispatched_at` (the worker's own `shuttle handoff`) means fresh. No
  newer handoff means the session died without handing off, and then its
  transcript's age decides: last written within the warm window (45 minutes,
  `config :shuttle, :resume_warm_window_s`) → resume `session_uuid`; older, or
  not on this host → fresh, with the prompt naming the cut-off session and its
  transcript path. A transcript last written before `dispatched_at` is not
  that dispatch's session — a codex/pi launch stamps `dispatched_at` at once
  but its own id only when the scrape backfills it, so the marker can still
  name the predecessor — and that dispatch goes plain fresh. A resume replays
  the whole transcript into the model, which is cheap only while the
  harness's prompt cache still holds it, so a worker killed by a host outage
  hours ago costs less as a fresh worker reading `## Status` — whatever the
  transcript's size. The lookup is one resolve through
  `Shuttle.Transcript.path/2` and one stat, taken only on that no-handoff
  branch.
  A durably owned Codex conversation on either surface is exempt from the transcript check: it keeps its identity in the App Server, so it resumes whenever it did not hand off.
  A standing constitution starts fresh on the autonomous loop.

  `resume_mode` overrides the autonomous rule: `"previous"` (the board's
  Resume) resumes unconditionally; `"fresh"` (New session) never resumes but
  still names a cut-off session; `"continue"` (`Shuttle.Delivery`, a message
  to a fiber with no live worker) applies the same no-handoff rule to every
  kind of fiber, so a message after a clean handoff or to a cold session
  launches fresh carrying it.

  A clean handoff therefore *is* the end of that conversation: the next worker
  lands on the rewritten `## Status`, and `resume`/`reopen` on a closed or
  awaiting fiber re-arm the document for a fresh dispatch rather than
  reattaching. The only reattach window is while the run is live (`shuttle
  attach`); a worker that wants a human's word before it ends stays alive at
  the checkpoint instead of handing off. This is
  the contract, not a gap.

## Codex conversation ownership and terminal viewers

Both Codex presentations use the App Server selected by `SHUTTLE_CODEX_SOCKET`, or `/tmp/shuttle-codex-<euid>-<host-hash>/control.sock`, with the first 16 lowercase SHA-256 hexadecimal characters of the actual OS hostname.
`CODEX_HOME` stays persistent and doesn't select this control path.
`Shuttle.CodexBackend` ensures the dependency asynchronously, even under worker boot quarantine, and adopts a healthy existing server without changing it.
It never creates a project, thread, or model turn merely to establish readiness.
Dispatch and capture preflight the cached health before creating a conversation; a non-ready backend returns retryable `backend_not_ready` waiting responses.
The Poller shows the wait with zero failed attempts and retries on the ordinary poll, without the five-minute preflight cooldown.
An explicit request isn't queued for an unbounded future launch, and a capture must be repeated after readiness.
The backend's endpoint-specific tmux session survives Shuttle restarts; owned dead panes and healthy process observations authorize native locked stale recovery, never live-server replacement.
`GET /api/v1/version` exposes its independent `codex_backend` health.
Terminal dispatch preflights its wrapper and tmux before creating a conversation.
The backend owns the thread, configured model and effort, initial turn, and task assignment.
A terminal viewer only renders and accepts human input for that conversation.
Native messages address the thread through `thread/read`, `turn/steer`, `turn/start`, and `thread/inject_items` on that same server.
There is no terminal-paste transport.

The durable record precedes the initial turn.
A failed or ambiguous turn start preserves that identity and its pending prompt rather than launching fresh.
The initial turn must be confirmed before attaching a viewer because an empty thread has no resumable rollout.
Viewer failure leaves the conversation owned; `shuttle attach <fiber>` prepares the same viewer again without sending a prompt.
Idle turns, closed viewers, and server transport errors never become worker-death evidence.
Restart recovery adopts the durable conversation, not a second CLI execution.
`WorkerProcess.holder` still protects historical embedded transcripts and non-Codex CLI resumes; it does not serialize viewers of an already-owned App Server conversation.

A shared backend inherits its server's environment.
Per-worker agent `env` and unsupported arbitrary `extra_flags` are refused; supported approval presets, model, and effort are expressed through thread/turn protocol fields.
The worker prompt identifies the App Server backend even with terminal presentation, so worker tools do not mistake the viewer's tmux context for their own execution environment.
See [operating](operating.md#terminal-codex-workers) for starting the dependency and handling hook-only sessions.

## Managed Codex context and registry compatibility

Managed Codex creates conversations with native `thread/start.developerInstructions` on both `cli` and `app` surfaces.
It does not depend on a terminal wrapper forwarding CLI config or on a worker inheriting the daemon's session identity.
The developer instruction text joins these producers, in this order, separated by blank lines:

1. The daemon user's optional `~/.codex/WAKE.md`.
2. `felt session` run in the worker's project directory.
   This is the read-only plaintext producer behind `felt hook session`'s `hookSpecificOutput.additionalContext` envelope; the JSON envelope itself is not an instruction.
3. The resolved agent record's optional `developer_instructions` string.
4. The optional `developer_instructions` dispatch/capture keyword option.

The context command runs directly, without a login shell, with a 15-second deadline and inherited `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `TMUX`, `TMUX_PANE`, `SHUTTLE_FIBER_PATH`, and `SHUTTLE_SESSION_ID` unset.
Its cwd selects the project's felt view; the launch prompt separately names the owning felt store and the felt/shuttle skills.
It neither runs a session-registration hook nor starts a model turn to retrieve instructions.
A missing WAKE file is allowed; an unreadable WAKE file or failed context command refuses launch instead of silently losing context.

This combined text **replaces**, rather than appends to, config-level `developer_instructions`, matching a wrapper's explicit `--config developer_instructions=...` override.
Agent and dispatch text are both retained, with dispatch text last; Shuttle does not interpret or resolve contradictory prose.
Project `AGENTS.md`, server configuration other than this explicit override, and native server requirements still load through Codex.
On resume without an explicit dispatch instruction, Shuttle omits `developerInstructions` so Codex retains the conversation's persisted native context, including its original agent and dispatch instructions.
An explicit dispatch instruction on resume rebuilds the same four-part context with the current agent record and supplies it through `thread/resume.developerInstructions`.
Codex applies resume overrides when loading a thread; for a loaded thread with subscribers or a running turn, Codex preserves its existing native context and can ignore these overrides.
Shuttle does not unload or replace an observed conversation to force a context change.
A view-only TUI attach supplies no context override.

The Go registry owns `developer_instructions` on base agent records and projects it through both `shuttle agents resolve --json` and `shuttle show --json`; the daemon consumes that resolved field.
For example, a custom record can carry `"developer_instructions": "Keep the verification evidence."` alongside `"extra_flags": "--approve-for-me"`.
The shipped `codex-terra`, `codex-sol`, `codex-luna`, and `codex-astra` records use models `gpt-terra`, `gpt-sol`, `gpt-luna`, and `gpt-astra`, default efforts `medium`, `low`, `max`, and `medium`, and `--approve-for-me`.
Model families resolve through the Go CLI's model catalog; effort overrides remain registry-owned.
The managed renderer maps `--approve-for-me` and `--not-so-yolo` to `approvalPolicy: on-request`, `approvalsReviewer: auto_review`, and `sandbox: workspace-write`.
It maps `--dangerously-bypass-approvals-and-sandbox` to `approvalPolicy: never` and `sandbox: danger-full-access`.
An absent preset leaves the server's permission configuration untouched.

Arbitrary `extra_flags` are **refused before creating or resuming a thread**, not silently ignored or executed through a shell.
Only an empty value or one complete approval preset above is accepted.
Examples refused include `--resume <id>`, `--session <id>`, `--model other`, `-c model=other`, and `--config developer_instructions=...`, including any of these appended to an approval preset.
A custom record containing `--approve-for-me -c developer_instructions=...` must move its instruction text to `developer_instructions`; Shuttle does not parse shell quoting, interpolate variables, or translate arbitrary CLI config.
Use the structured `model`, `effort`, and `developer_instructions` fields instead.
Per-worker agent `env` is also refused because tools execute in the shared server's environment; configure that environment on the server itself.

## tmux server ownership (macOS)

- **The daemon never roots the tmux server on macOS.** A worker's tmux session
  (`Dispatcher.spawn_tmux/4`) needs a tmux *server* to attach to, and if none
  exists, `tmux new-session` forks one as a child of whatever invoked it. Under
  launchd that invoker is the daemon's own beam executable, and macOS TCC
  charges every file access in a process tree to the tree's *responsible
  process* — not the process that actually opened the file, the executable the
  tree descends from. A daemon-forked server makes beam.smp the responsible
  process for every worker, every shell the worker opens, and every tool the
  worker runs, so each one raises its own "wants to access data from other
  apps" prompt, and the daemon binary has no way to hold the grant those
  prompts ask for (launchd-run processes don't keep TCC grants across
  restarts the way a terminal-launched one does). The plist template header
  documents the same fact for the daemon's own working directory; this is the
  same rule applied to everything the daemon spawns downstream of it.
- **The fix is to have the user's own terminal own the fork.** The daemon
  already remote-controls kitty (`Shuttle.Kitty`, `kitty @ launch`) to open
  worker windows; a `--type=background` launch runs a command as kitty's
  child with no window at all. Before a dispatch or capture that finds no
  tmux server present, the daemon asks kitty to start one this way — an
  anchor session (`shuttle-anchor`, deliberately not `-shuttle`-suffixed, so
  nothing that scans session names for workers picks it up) that holds the
  server alive with nothing running in it. The fork chain is then kitty → tmux,
  and kitty is what TCC charges — a normal, terminal-launched process that can
  hold its own grants.
- **If kitty is unreachable, dispatch is refused, never silently
  daemon-forked.** No live tmux server and no kitty remote-control socket
  means the daemon has no way to start one without becoming its ancestor, so
  it declines with `{:tmux_server_unavailable, message}` instead. The refusal
  rides the same preflight-cooldown and blocked-row machinery as every other
  dispatch refusal (`Poller.record_dispatch_failure`, the snapshot's `blocked`
  list, the 422 shape on `/api/v1/dispatch` and `/api/v1/capture`) — a human
  sees it on the board rather than a worker quietly inheriting a bad
  responsible process.
- **Attribution: how a running server is told apart from a daemon-forked
  one.** The kernel is asked, rather than the argv guessed at. `launchctl
  procinfo <pid>` names the responsible process outright but **requires root**
  (`This subcommand requires root privileges: procinfo`), so it is not usable
  at runtime; `launchctl print pid/<pid>` needs **no privileges** and prints
  the process's **resource coalition**, whose `name` is the launchd label or
  app bundle that rooted the tree — the same attribution TCC charges file
  access to. So: the server pid comes from `tmux display-message -p
  '#{pid}'`, and its resource-coalition name decides the origin —
  `io.shuttle.daemon` (the daemon's own launchd label) is `daemon_born`, any
  other name is `user_born` and is reported verbatim, an unparsable answer is
  `unknown`, and no server at all is `absent`. Only `daemon_born` is a defect.
  The parsing lives in `internal/shuttlecli/tmux_origin.go` (the resource coalition is
  selected by name: `launchctl print` emits a `jetsam coalition` block with
  the same `name` key, and only the resource one is TCC's). `shuttle status`
  and `shuttle doctor` surface the classification so a daemon-born server
  reads as a one-line remedy: restart it from a terminal.
- **A present server is hardened, not just accepted.** tmux's `exit-empty`
  makes a server exit as soon as it holds no sessions, and the window between
  `tmux ls` answering "present" and the dispatcher's `new-session` is real: a
  human closing their last session in that window would leave `new-session` to
  fork a fresh, daemon-rooted server. So on darwin a present server also gets
  `tmux set-option -s exit-empty off` — idempotent, and unlike `new-session` it
  never forks a server of its own (with none running it just fails to connect,
  verified), though it is only run when a server is present or was just
  started.
- **Non-darwin hosts are unaffected.** Every remote in this fleet is Linux,
  where TCC doesn't exist and a daemon-forked tmux server was never a problem;
  the check above is gated on `os_type` and is a no-op everywhere but macOS.

## Dispatch prompt structure

Prompt rendering lives in `Shuttle.Dispatcher`.

Launch messages open with `You are a Shuttle worker. Activate the felt and
shuttle skills.` and carry only what this dispatch knows and the skill cannot:

- `Fiber:` — the fiber's id relative to the store root — and `Felt store:`,
  so `felt -C <store> show <id>` resolves it whatever the worker's project
  view is.
- `Surface: app` and `Headless: true`, only when the conversation is not an
  attachable terminal session.
- `Mode: resume` on a resumed session, which may have slept for any length of
  time.
- Standing run ID and scheduled/ad-hoc mode when applicable.
- On fresh launches, `Previous session: <uuid> (<harness>)` when there was
  one. When the previous session ended without a handoff and is not resumed,
  the line says so and gives its transcript path.
- `From User:` followed by the exact user message, when nonblank.

Facts the fiber already holds — its kind, role, and seat — stay in the fiber. Roles live in the same store the prompt names.

Syncing the store, reading the fiber and its `## Status`, the exit contract
(close, ask, or just end the turn; standing runs hand off), what to do with a
predecessor's transcript, and reading role charters are static instructions,
so they live in the shuttle skill's Survey step rather than in every prompt.

Capture launches point to the shuttle skill's `references/capture.md` and carry
JSON install metadata and the exact claim endpoint/body. That reference owns the
open → install → claim → activate ordering and surface-specific claim behavior.
Worker loop, headless handling, and handoff instructions live only in the skill.
No decorative rules, constitution snapshots, or duplicated exit contracts are
inlined. Previous transcripts support understanding; they do not supply missing
instructions. Fresh and resumed workers read the current constitution and Status.

Deploy prompt changes together with the corresponding skill generation: the
worker must be able to load every reference named by its launch message before
that daemon build starts dispatching.
