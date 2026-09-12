# Dispatch internals

How the daemon decides what to run, and what the worker's prompt looks like.
The operator-facing lifecycle is in [Lifecycle](../shuttle/lifecycle.md).

## How dispatch works

- **Poller** (`daemon/lib/shuttle/poller.ex`) owns the tick. It walks each
  configured felt store, pulls candidate metadata via `felt ls --json` and
  per-fiber detail via `felt show -j`, and considers a fiber eligible iff
  it carries a `shuttle:` block owned by this host (`shuttle.host` matches),
  felt `status` is `active`, and it isn't already running/claimed (see
  `eligible?/2` in poller.ex).
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
  in one `project_dir` at once, and shuttle says nothing about it. An earlier
  rule refused the second with `:project_dir_held`, on the grounds that two
  workers in one clone clobber each other's uncommitted edits; it is gone,
  along with the symlink resolution that existed only to decide when two
  spellings named one directory. Coordinating concurrent work in a shared
  checkout is the operator's call, not the dispatcher's.
- **Configured stores** come from `FELT_STORES` (comma-separated env var) →
  persisted `~/.config/felt/stores.json`. There is no implicit default store
  and no legacy shuttle-named registry authority. `POST
  /api/v1/felt-stores` rewrites the persisted file.
- **Picker projects** are a separate list — `FELT_PROJECTS` → persisted
  `~/.config/felt/projects.json` (`Shuttle.Projects`) — and answer a different
  question: which checkouts a human can file INTO from the Stash/Capture forms.
  Kept out of the poll list on purpose, so polling never walks TCC-protected
  paths. Served at `origins.<host>.projects` of `GET /api/v1/felt-stores`. The
  file is hand-editable, but no longer hand-edit-only. Both forms show the
  destination as **host then project** (`ui/src/forms/ProjectPicker.tsx` —
  `HostPicker` and `ProjectPicker`, both plain `<select>`s, sized to match the
  agent and effort selects beside them). The host list is the origins of `GET
  /api/v1/felt-stores`, derived in `projectModel.ts` (`deriveHosts`) alongside
  the projects so the two can't disagree; it defaults to the LOCAL origin, and
  the project list is `projectsForHost` of the selection — one host's projects,
  no host suffix on the rows.

  The project half was briefly a bespoke filtering combobox, on the belief that
  a `<select>` could not carry a row acting as a button. It can, and the
  combobox's floating list — portalled into `<body>`, which is the PARENT of
  the forms' React root — never saw a click, because React 18 delegates at the
  root container the portalled nodes bubble past. The magic option is safe
  because it is a sentinel, not a state: `interpretProjectChange` maps its
  value to `{kind: 'add'}`, so `onChange` runs the add flow and restores the
  previous selection (controlled `value` untouched, plus a direct write back to
  the DOM node), and it sits alone in a leading `<optgroup>` so it never reads
  as a project. The placeholder shown when nothing is selected is `disabled`,
  so type-ahead and arrows cannot land there either.

  The project select's FIRST option is "Add a new project…", over `POST
  /api/v1/projects` (`{"path": …, "origin": …}` — initializes `<path>/.felt`
  when absent, exactly as `felt init` does, then appends the path; idempotent).
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
  (There was a third shape — an in-browser directory browser over `GET
  /api/v1/browse`. It is gone: once the host is chosen up front, walking a
  remote filesystem a click at a time bought nothing a pasted path doesn't.)
- **Dispatcher** (`daemon/lib/shuttle/dispatcher.ex`) resolves the agent, spawns
  the `<leaf>-<uid>-shuttle` tmux session.
- **Standing roles** — `shuttle.kind: standing` with a cron `schedule:`.
  Scheduled runs dispatch only when `next_due_at` is due AND `review.state`
  is `scheduled` or `accepted`. Manual dispatch is ad-hoc (`adhoc-...`
  run id) and preserves `next_due_at`; worker exit flips state to
  `awaiting`, and `felt shuttle accept` advances `next_due_at` only for
  scheduled runs.
- **A finished run is finished — there is no reopen.** When a worker's tmux
  session is gone, `Shuttle.Continuation` decides between resuming the
  transcript and starting fresh from one comparison: a `handed_off_at` newer
  than `dispatched_at` (the worker's own `felt shuttle handoff`) means fresh;
  no newer handoff means the session died mid-thought and its `session_uuid`
  is resumed. A clean handoff therefore *is* the end of that conversation: the
  next worker lands on the rewritten `## Status`, and `resume`/`reopen` on a
  closed or awaiting fiber re-arm the document for a fresh dispatch rather
  than reattaching. The only reattach window is while the run is live
  (`felt shuttle attach`); a worker that wants a human's word before it ends
  stays alive at the checkpoint instead of handing off (the pinned-role
  contract). This is the contract, not a gap.

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
  The parsing lives in `cmd/shuttle_tmux_origin.go` (the resource coalition is
  selected by name: `launchctl print` emits a `jetsam coalition` block with
  the same `name` key, and only the resource one is TCC's). `felt shuttle
  status` and `felt setup receipt` surface the classification so a daemon-born
  server reads as a one-line remedy: restart it from a terminal.
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

All prompt variants share this shape (`compose_prompt/3` in dispatcher.ex):

1. **Orientation paragraph** — what shuttle is, what the worker is here to
   do, how the practice loads. Per-prompt, not boilerplate. Goes first
   because in causal attention every downstream token sees the prefix.
2. **`Fiber: <id>`** (and `Run: <run-id>` for standing) — identity lines.
   Fresh dispatches also carry **`Previous session: <uuid> (<harness>)`**
   when the fiber has one — the predecessor's transcript pointer, read from
   the session ledger (`SessionLedger.latest_for_uid/2`, fallback: the
   runtime marker) *before* this dispatch stamps its own. Resume prompts
   never carry it (the resumed worker IS the previous session); the shuttle
   skill's `references/transcripts.md` carries the read recipes.
3. **`Felt store: <path>`** — the worker's absolute anchor. When
   `prompt_fiber_id`'s work_dir-local translation safe-fails, the id above
   is global and doesn't resolve from cwd; the store line makes the
   fallback mechanical (`felt -C <felt-store> show <id>`).
4. **`Exit Contract`** block — always present; one uniform contract for
   oneshot + standing (rewrite `## Status`, then `felt shuttle handoff`),
   three-case for pinned roles (stay alive while the human drives; handoff
   relaunches a fresh worker for autonomous arcs; close → awaiting review).
   A `Headless` block follows for print-mode agents (no human can attach).
5. **`From User`** — the user's directive, when one rides this dispatch. It
   is the `user_message` dispatch *parameter* (inlined into the prompt at
   launch and discarded), not a persisted felt event. The directive arrives
   *with* the dispatch.

The fiber's outcome and handoff prose are not inlined — they're already in
scope after `felt show <id>`, which renders the body's `## Status` block (the
worker's last-writer-wins handoff) along with the rest of the constitution. The
shuttle skill prescribes the worker reads it on arrival.
