# Dispatch internals

How the daemon decides what to run, and what the worker's prompt looks like.
The operator-facing lifecycle is in [Lifecycle](../shuttle/lifecycle.md).

## How dispatch works

- **Poller** (`lib/shuttle/poller.ex`) owns the tick. It walks each
  configured felt store, pulls candidate metadata via `felt ls --json` and
  per-fiber detail via `felt show -j`, and considers a fiber eligible iff
  it carries a `shuttle:` block owned by this host (`shuttle.host` matches),
  its `project_dir` exists here, felt `status` is `active`, and it isn't
  already running/claimed (see `eligible?/2` in poller.ex).
- **A checkout is held by one worker at a time.** A fiber whose
  `shuttle.project_dir` matches that of a fiber currently running is ineligible
  with `{:project_dir_held, dir, holder}` ("checkout <dir> is held by
  <fiber>") — two workers in one clone clobber each other's uncommitted edits.
  The rule is kind-blind (standing and pinned roles included; it is about the
  filesystem) and, like every non-force gate, a force-dispatch bypasses it. The
  running worker's dir is read from `state.project_dir_index`, a
  runtime_key→project_dir map rebuilt from the candidate rows each poll, so an
  adopted orphan — whose metadata never carried a project_dir — is covered too.
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
- **Dispatcher** (`lib/shuttle/dispatcher.ex`) resolves the agent, spawns
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
