# Dispatch internals

How the daemon decides what to run, and what the worker's prompt looks like.
The operator-facing lifecycle is in [Lifecycle](../shuttle/lifecycle.md).

## Planning, execution, and unavailable hosts

A fiber is a Git-synchronized document.
`shuttle.host` selects the daemon allowed to execute it; it doesn't own a draft's planning state.
Planning verbs ask the execution owner first, even when the local document is an open draft.
Only a definite pre-send failure, an absent/removed owner, or explicit CLI `--local` planning permits an offline planning write; a lost reply never does.
Offline planning never authorizes or stops execution.
The CLI re-reads and validates the document under its lock before writing, without holding that lock across an owner request.
The board uses the same CLI writer, including for remote or removed execution hosts.
An offline planning write explains why its owner could not arbitrate, that the document travels through Git, and that no execution request was sent.
It needs a local copy of the document; a cached remote card alone is not writable offline.

### States and evidence

Lifecycle state is `status`, `tempered`, and runtime evidence, rather than a single enum.
The board additionally projects dates, horizon, seats, and live owner observations into places.
`pinned` reads as `oneshot`; an absent host never grants execution to this daemon.

| State | Document and owner evidence | Offline planning |
|---|---|---|
| Draft, never launched | `status: open`; no dispatch or session identity | Yes |
| Resting | `status: open`, `horizon: stashed`; a future due date may wake its display, not arm execution | Yes, unless an unconcluded dispatch remains |
| Armed-waiting | `status: active`, no positively observed worker; includes boot-held work and waiting standing schedules | No; the owner may launch it |
| Running | Owner reports a worker, or a dispatch/session marker has no later clean handoff | No; a failed observation isn't proof of exit |
| Handed off | `runtime.handed_off_at` is strictly later than `dispatched_at`; status remains a separate gate | Only when status isn't `active` and no owner-observed worker remains |
| Awaiting review | `status: closed`, `tempered` absent | Yes if no unconcluded execution remains; closed alone doesn't prove exit |
| Tempered / discarded | `status: closed`, `tempered: true` / `false` | Same evidence rule as Awaiting review |
| Standing | `shuttle.kind: standing`, with a cron schedule; overlays every state above | Same evidence rule; accepting a run re-arms it |
| Unowned / removed host | Missing `shuttle.host`, or host absent from the fleet | Rest, Close and Discard remain available with unconcluded runtime; other planning changes require quiescence |

A runtime containing only planning/publication metadata isn't launch evidence.
A session identity without a dispatch timestamp is possible execution and refuses offline planning.
Invalid dispatch/handoff timestamps don't establish a clean exit.
A stale owner-observed worker remains unknown, not dead, and the board withholds offline lifecycle gestures for it.
The CLI cannot discover a worker launched since its archive copy; an offline edit describes local planning, not the owner's current execution.

### Verbs and gestures

**P** is a planning operation: ask the owner first, with a quiescent local-document fallback only when it cannot arbitrate.
The same operation on armed or possible execution is **E**: ask the execution owner.
**E** always stays owner-routed, even when the archive looks quiescent.
**F** changes owner-addressed file placement or execution identity and stays on the owner; it has no offline mirror fallback.
These classes, the state table above, and the transport table below specify each state × verb × availability combination.

| Verb or board gesture | Class and resulting state |
|---|---|
| `rest`, drop in Resting, snooze through `rest --until` | P/E; open + stashed, verdict cleared; an owner-side rest concludes and stops the run |
| `pause`, drop in Drafts from an open card | P/E; open, schedule preserved; owner-side pause stops a worker unless `--no-kill` |
| `close`, Close for review, drop in Awaiting review | P/E; closed, oneshot verdict cleared and standing verdict preserved; closing another fiber doesn't itself kill its worker |
| `close --tempered=false`, Discard | P/E; closed + false |
| `close --tempered=true`, oneshot Temper | P/E; closed + true |
| Standing Temper or `close --tempered=true` | E; the owner resolves acceptance, stamps its serviced occurrence and re-arms eligible work |
| `accept` | E; an untempered active/closed standing run re-arms; oneshots are refused and use `close --tempered=true` |
| `resume`, `reopen` without `--as-draft`, Launch, Resume, New session, drop in In flight | E; arm/dispatch through the existing owner lifecycle and arming gates |
| `reopen --as-draft`, closed card dropped in Drafts | P/E; open, verdict and closed-at cleared, never arms |
| `set-agent`, `set-model`, role/seat assignment, `reshape`, `set-outcome` | P/E; configuration/publication edit only; runtime identity preserved |
| Due/date drop, horizon, cold, tag changes on a quiescent constitution | P; the existing document-edit path stamps `updated-at` |
| Those document edits on armed or possibly live work | E; no offline fallback |
| Move/rename/reparent the document (`felt-nest`), uninstall, physical archive/removal | F; owner namespace/identity operation, not an offline planning exit |
| Archive as a board verdict | P/E; the corresponding closed + tempered/discarded transition, not a file move |

The board offers offline planning actions on stale drafts, resting cards, and completed work with clean-exit evidence.
Its Move menu omits In flight while the host is stale; stale planning cards remain draggable.
Trying an execution drop explains that launching needs the execution host.
A stale armed or possibly live card explains why lifecycle controls need reconnection rather than presenting an empty menu.
An offline standing run offers Discard and Rest, not Temper's implicit re-arm.
Missing/removed hosts don't make quiescent archive documents disappear from the composite board.

### Transport outcomes

| Operation class | Owner healthy | Owner unavailable before send | Owner lost mid-request | Owner has a newer version |
|---|---|---|---|---|
| P | Owner validates and applies its current document | Quiescent local copy only; explain Git synchronization and no execution request | Refuse without replay or mirror fallback; the owner may have applied it | Owner's current document wins while reachable; Git reconciles offline changes |
| E | Owner validates its current document and runtime; local planning copy isn't execution authority | Refuse; say no action request was sent and nothing was applied | Refuse without replay or mirror fallback; say the action may have been applied and inspect the owner before retrying | Owner's current state and execution gates win |
| F | Owner validates its current namespace and document | Refuse without local mutation | Preserve uncertainty; never repeat a placement/removal automatically | Owner's current namespace and identity win |

A stale feed does not prove that an owner cannot receive a request: attempt the guarded connection.
The mutation transport gives connection establishment at most two seconds, distinguishes a pre-send connection refusal from a lost reply, and sends a POST only once.
The board permits local planning fallback only while its owner feed is stale or absent.
Once sending starts, an error remains ambiguous even if the connection closes before the response.
An unknown/removed origin refuses execution before forwarding.
An unanswered local-daemon request also remains ambiguous; it is never a reason to fall back to a planning write.
The existing same-host offline lifecycle path remains available when no local daemon connection was made.

### Git reconciliation

Git reconciles the document; the syncing agent resolves textual conflicts from the work's context.
A merged `status: active` runs because someone explicitly armed it.

### Composite planning projection

Owner feeds remain owner-only and serve owner-addressed content and runtime.
The composite board also reads the local document cache, keyed by intrinsic UID.
When an owner feed is stale, a strictly newer local `updated_at` supplies planning fields (status/verdict subject to the execution rule, horizon, due, tags, next-launch configuration, and role/seat).
For a peer without `updated_at`, its reported `modified_at` is the comparison fallback.
Equal or missing version evidence doesn't replace an owner row.
Owner-observed armed status, possible execution, and live runtime win over an offline status/verdict edit.
The archive must match both intrinsic identity and execution host. The projection preserves owner file addresses, host, runtime, and non-planning content such as the name.
Healthy owner rows remain authoritative, and projected rows retain the owner's stale marking.
The composite's `local_planning` capability requires a quiescent local document and no possible execution in the owner row; cached remote-only cards do not promise offline saves.
A local-only row for a removed owner is marked stale too; it doesn't manufacture live host content or liveness.

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
  Workers use `<leaf>-<uid>-shuttle` names, parsed by `Shuttle.ULID.from_tmux/1`, on the selected terminal backend.
  Codex runs its interactive CLI; fresh conversation identity is captured from a rollout matching the launch time, project directory and fiber prompt.
  Resuming Codex uses the recorded native session UUID and never falls back to a fresh conversation.
  A fiber without a ULID `id:` is refused with `{:uid_missing, message}`, a preflight refusal like the others (the `blocked` row, the dispatch API's 422, the preflight cooldown).
- **Standing constitutions** — `shuttle.kind: standing` with a cron
  `schedule:`.
  Nothing due is stored: an armed (`active`, untempered) one is due when a cron occurrence has passed since it was last serviced — the latest of `shuttle.runtime.dispatched_at`, `handed_off_at`, `closed-at` and the fiber's creation (`StandingRoles.standing_role_due?/1`).
  Scheduled run IDs name that most recent occurrence (`prev_due`); manual dispatch is ad-hoc (`adhoc-<ms>`).
  The locked exit write checks the current owner, UID, run id, dispatch timestamp and human lifecycle state, preserving newer runs and human decisions.
  Recovery publishes a recorded scheduled handoff for review; ad-hoc and unrecorded absences do not supply that conclusion.
  Human resume and reopen, including from an open pause, record a rearm distinct from a worker handoff.
  Worker exit or an untempered close puts the run on Awaiting review without ending its schedule.
  At the next occurrence after both its last service and close, the owning Poller runs `reopen --occurrence` inside its serialized tick, even in boot quarantine.
  Under the document lock, the CLI checks current ownership, standing kind, closed status, absence of a verdict, a dispatch on record, and that the occurrence is still due.
  It atomically arms the document and cleans dirty markers with `handed_off_at = dispatched_at`, preserving the service anchor so the occurrence stays due and launches fresh.
  A capacity or backend wait leaves it armed; a failed re-arm is visible in the ordinary blocked state and retries on the failure cooldown.
  A changed state quietly skips the write.
  Until then it stays closed; `status: active` remains the dispatch gate.
  `shuttle accept`, `close --tempered=true` on a recorded run, or `resume` re-arms and concludes the run by stamping `handed_off_at` in the same write, resting it until the next tick.
  Without a dispatch on record, `close --tempered=true` records a verdict and leaves the fiber closed.
  Existing verdicts (true or false), never-run closed drafts, paused/rested constitutions and another host's fibers are never automatically re-armed.
  A stashed horizon alone does not stop a schedule; Rest pauses it by writing `status: open`.
  Plain close preserves a standing verdict; only an explicit reopen clears it.
- **A finished run is finished — there is no reopen.** When a oneshot's
  worker is gone, `Dispatcher.check_resume_intent/2` decides between resuming
  its transcript and starting fresh. A `handed_off_at` newer than
  `dispatched_at` (the worker's own `shuttle handoff`) means fresh. No
  newer handoff means the session died without handing off: a transcript on
  this host resumes `session_uuid`; a missing transcript starts fresh, with
  the prompt naming the cut-off session. A transcript last written before `dispatched_at` is not
  that dispatch's session — a codex/pi launch stamps `dispatched_at` at once
  but its own id only when the scrape backfills it, so the marker can still
  name the predecessor — and that dispatch goes plain fresh. The lookup is one resolve through
  `Shuttle.Transcript.path/2` and one stat, taken only on that no-handoff
  branch.
  A standing constitution starts fresh on the autonomous loop.

  A dirty-death restoration is separate from launching another turn. The daemon
  classifies the last durable hook-event state for the session: a `stop` with no
  later turn activity reopens the same Claude or Pi session with an empty prompt,
  and reattaches to the same Codex thread without starting a turn. A recorded
  working phase resumes with the normal continuation prompt. Missing or
  ambiguous turn evidence reopens quietly. This uses the durable event stream
  reconstructed at boot, so an idle conversation does not receive a message
  merely because its terminal or daemon died.

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

## Uncertain launch reservations

Before requesting a worker launch from a terminal backend, Shuttle writes a host-local reservation under `$SHUTTLE_DATA_DIR/terminals/launch-attempts/`.
The record carries the worker name, script path, UTC timestamp and uncertainty reason, plus any conversation UUID and prepared dispatch facts (fresh/resume intent, harness, dispatch timestamp, session UUID and standing run id).
Launches acquire both worker-name and known-conversation locks; a live process or unresolved acquisition can refuse a second opener of the same conversation.
Conversation scans skip atomic temporaries and log undecodable unrelated entries without imposing a host-wide hold.
Prepared facts can repair a missing runtime mirror only when the exact recorded script proves the live execution.
They are cleared only after the matching mirror and durable receiver registration succeed.
Rex also records an awaiting-binding intent before terminal creation; recovery requires matching server and script ownership before committing its session, window and block binding.
Read-only preparation failures retire the reservation; an unanswered create or new-window request, an unconfirmed cleanup, or a daemon crash keeps it.
A successful launch keeps its reservation to cover a failed runtime write.
The script's exit trap deletes the script, which permits retirement only when no prepared dispatch remains unmirrored.
Confirmed absence of every terminal backend and of the run-script process also permits retirement and retry under that condition.
An unmirrored prepared dispatch holds even after positive absence or script deletion: the work may already have run and exited.
It remains blocked through polling, restart, force and force-plus-fresh until repaired, definitely refused or explicitly released; terminal liveness can still report `gone`.
There is no TTL: a killed worker can leave its script behind, so age alone never authorizes another launch.
Reservations follow the full terminal worker name, not the fiber UID alone.
Before renaming a fiber with an outstanding reservation, stop or otherwise reconcile its old named worker; renaming does not transfer this launch ownership.

When visibility is uncertain, a reservation refuses dispatch with `launch_reserved`, not `already_running`.
The dispatch API returns HTTP 409 with the reservation and a message naming the worker, age, reason and release command.
The poller retains the refusal in `blocked` and the fiber's `dispatch_error`, so the board shows it even when no worker is tracked.
Plain force and force-plus-fresh do not release it.

After checking the owning host, an operator can explicitly accept possible duplication:

```bash
shuttle dispatch <fiber-id-or-uid> --release-launch-reservation
```

This owner-routed manual dispatch releases only the reservation and warns that a duplicate worker is possible.
It preserves the old script because its worker may still need it.
It does not bypass positively observed workers, other ownership evidence or transcript-holder checks.
The API equivalent is `POST /api/v1/dispatch` with `release_launch_reservation: true` and `force: true`.
Use `shuttle snapshot` to inspect held fibers through the existing `blocked` list.

## Codex terminal workers

Codex runs through the Codex CLI in the selected terminal backend, like Claude
Code and Pi. The daemon launches and observes the CLI process; the harness owns
the conversation and native session identity. Resume and message delivery use
the existing terminal session, and closing a viewer does not mean the worker
has exited. App Server APIs used by `felt setup codex` are transient hook-trust
operations and do not participate in Shuttle dispatch.

## Terminal backend and macOS ownership

The host's `terminal` setting selects tmux (default) or Rex for launches.
Rex groups workers into one session per constitution family, with one window (tab) per worker or viewer.
The family is the topmost constitution ancestor in the fiber tree at launch, or the fiber itself when it has none; the root needs no live worker.
The session label is the family's last two path segments.
Tabs sort by fiber path and display each leaf, with `└ ` and em-space indentation for constitution levels below the root, plus ` @host` for remote viewers.
A daemon-written binding from worker name to session, window and block IDs is authoritative; only the block label retains the worker name for recovery.
Launches and empty-session cleanup share a per-family lock.
Stop closes the worker's window and destroys an empty session only when Shuttle created it; human and label-recovered sessions are preserved.
Per-worker session bindings retain their addresses until their workers end, and refiling a live worker does not move it into another family.
Rex workers start under Rex Server; the daemon starts an absent Rex app and refuses dispatch if the server remains unavailable.
On Rex hosts, existing tmux workers remain observable and stoppable when tmux is installed.
Remote Control and Hark also use the selected backend. Rex launches keep their ownership, lifecycle receipts and output in Shuttle-owned files; they do not require a tmux server.

### tmux server ownership (macOS)

- **The daemon never roots the tmux server on macOS.** A worker's tmux session
  needs a tmux *server* to attach to, and if none
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
- **The terminal owns the fork.** When no tmux server exists on a tmux-primary host, the daemon asks Kitty to start an anchor session.
  The terminal's process tree owns the server and its privacy attribution.
- **A failed launcher is refused, never silently daemon-forked.** The `tmux_server_unavailable` refusal reaches the board through the normal preflight cooldown.
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
