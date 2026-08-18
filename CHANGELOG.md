# Changelog

All notable changes to felt are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — unreleased

This is the largest change in the project's history. Two things happened.
Shuttle — the Elixir orchestration daemon and its board UI — moved into
this repository and behind the `felt` binary. And felt went back to pure
markdown: the SQLite index and the history log are gone, and identity and
recency now live in the frontmatter.

The version was stamped 2026-07-30 and has not been cut; work landing since
is folded in here rather than into a separate Unreleased section.

> **Note.** The daemon now ships too. Every tagged release attaches
> `shuttle_<Os>_<arch>.tar.gz` for macOS and Linux, arm64 and x86_64, each an
> ERTS-bundled Mix release built and boot-tested on its own native runner —
> so a machine with neither Erlang nor Node can install a working daemon.
> `tmux` and `felt` itself remain prerequisites. The daemon path is
> macOS-primary and still rougher on Linux.

### Added

#### User-level configuration

- The agent registry now layers `~/.config/felt/agents.json` (or
  `$FELT_AGENTS_FILE`) over the shipped fleet: `claude-sonnet` (the
  default), `claude-opus`, `claude-haiku`, `claude-fable`; `codex-sol`,
  `codex-terra`, `codex-luna`, `codex`; `pi-sonnet`,
  `pi-kimi`,
  `pi-deepseek-pro`, `pi-deepseek-flash`. There is no reserved `human`
  record and no headless aliases. `builtins: "merge"` (default) folds by
  id, last wins wholesale; `"restrict"` drops the builtin layer, so the
  file becomes the whole registry for that host. `felt shuttle agents init`
  seeds the user file from the built-ins; `felt shuttle agents` shows each
  record's provenance. A malformed file fails loud with its path; a missing
  file is silent.
- Remote daemons live in `~/.config/felt/remotes.json`, managed by
  `felt shuttle remotes list|add|rm|path` and read at runtime by both the
  CLI (tunnels, `status --remote`) and the daemon. `config/dev.exs`
  carries no hostnames; `secret_key_base` is random per boot. The launchd
  tunnel label prefix is configurable via `launchd_label_prefix`. Shared
  fixtures keep the Go and Elixir readers in agreement, and a hygiene test
  fails on personal hostnames in `config/`, `lib/`, `cmd/`, `share/`.
- `felt hook event` writes the Shuttle activity stream (one JSONL line per
  harness event), registered through the plugin on seven events for both
  Claude Code and Codex. It writes only when the events file's parent
  directory exists (default `~/.shuttle/events.jsonl`); `SHUTTLE_EVENTS=off`
  disables it; files rotate at 64 MiB; oversized tool inputs are trimmed.
  No external dependencies — `jq` and `perl` are not required.

#### Shuttle, merged into felt

- The Shuttle daemon, its browser board UI, and its dispatch CLI now live
  in this repository. One repo, one checkout, one command surface.
- New `felt shuttle` command group, replacing the standalone `shuttle-ctl`
  binary. Lifecycle writes: `install`, `repeat`, `pin`, `uninstall`,
  `pause`, `resume`, `close`, `reopen`, `accept`, `set-outcome`,
  `set-model`, `set-agent`, `handoff`. Local reads: `status`, `ps`,
  `session-name`, `attach`. Daemon-HTTP verbs: `snapshot`, `dispatch`,
  `validate-identity`, `status --all` / `--remote`. Plus `agents`,
  `tunnels`, `contract`, `mark-runtime`, and `migrate-runtime`.
- The verbs are reimplemented on felt's own internals — resolve, read,
  mutate, validate, write. There is no second fiber-I/O layer.
- `shuttle:` is a first-class felt frontmatter facet with a real schema
  (`internal/shuttle`). It is validated on `add` and `edit`, and resolved
  additively in `show -j` and `ls --json`. Runtime keys nest under
  `shuttle.runtime`; `felt shuttle migrate-runtime` lifts the old flat
  keys into place.
- A numbered contract level (`felt shuttle contract`) with a boot-time
  handshake. The daemon refuses fresh launches when the CLI and the daemon
  disagree, so a stale binary cannot dispatch.

#### Session lineage in dispatch prompts

- Fresh dispatch prompts (oneshot and standing) carry a
  `Previous session: <uuid> (<harness>)` line naming the predecessor's
  on-disk transcript, read from the session ledger
  (`SessionLedger.latest_for_uid/2`; fallback: the runtime marker) before
  the new dispatch stamps its own. The shuttle skill's new
  `references/transcripts.md` carries validated jq recipes for reading a
  transcript surgically from its UUID — tails, keyword search, thinking —
  for both claude-code and codex formats.

#### The board grows a memory

- **Five views, not one.** The board is a hotkey row over five full pages:
  Desk (the kanban), Day (fibers as lanes over a 6am→6am axis), Week (past
  days as ink rasters), Chronicle (multi-day lifelines across calendar
  days), and Board (every file a worker sent, rendered on a canvas). The
  first four share one temporal cursor and a two-pigment grammar — solid
  for human steering, wash for agent work. `?view=day|week|chronicle|shelf`
  deep-links one.
- **The session ledger.** `~/.shuttle/sessions.jsonl`, written by the
  daemon at dispatch / claim / resume, records which fiber each harness
  session belonged to. It replaces inferring the pairing from a tmux
  session name, an inference that vanished when the session ended. Served
  as `GET /api/v1/sessions` with a `/composite` sibling.
- **Minute-bucketed activity telemetry.** `GET /api/v1/activity` folds the
  event stream into per-minute buckets keyed by `{minute, tmux session,
  cwd, kind}`, collapsing the eight hook types into attention / notify /
  agent. `GET /api/v1/moment` returns the words a session spoke inside a
  window, read from its transcript.
- **The commit ledger and LOC accounting.** `~/.shuttle/commits.jsonl`
  pairs each commit with the session that made it, carrying subject, repo
  and `--shortstat` counts, so the Chronicle narrates work and counts lines
  without parsing a fiber name out of a subject line. A `PostToolUse` hook
  writes it; **no such hook ships in this repo**, so the file stays absent
  on a stock install and the narration stays empty — there is no git-log
  fallback.
- **Cycles.** A fiber tagged `cycle` with `start:` and `due:` names a span
  of calendar time, drawn as a band over the Chronicle's day grid.
  Membership is derived, never assigned — a fiber belongs by its `due:`, by
  being in flight during the span, or by having been worked inside it.
  Drag across days to draw one, or press `+` to speak one.
- **Token spend.** `GET /api/v1/spend` joins the session ledger to
  transcript usage for per-session and per-fiber rollups. Neither join
  estimates: an unreadable transcript reports `found: false` with zeroed
  counters and still counts as a session.
- **Snooze on a drag horizon.** Dragging a card reveals a row of upcoming
  days plus a chip per upcoming cycle. A drop writes `due:` +
  `horizon: stashed`; the card returns to the desk on its due day.
- Every temporal feed is host-scoped with a `/composite` sibling that fans
  in each remote's cached read and reports per-origin freshness, so one
  board shows the whole fleet and a disconnected host grays out instead of
  drawing an empty day.

#### Identity and recency in the files

- Fibers carry an intrinsic ULID `id`. `felt backfill-ids` mints ids for
  existing stores (`--dry-run` previews). Fibers resolve by UID as well as
  by slug.
- Recency is an `updated-at` frontmatter field (`updated_at` in JSON), so it
  survives clone, sync, and checkout instead of depending on file mtime. A
  new PostToolUse hook stamps it when an agent edits a fiber file directly.
- Session context lists five active-or-open fibers with a recency
  timestamp on each entry.

#### Stores and views: verbs carry scope

A project whose `.felt` symlinks into a larger store (a loom) is a *view* on
that store, not a fence around it — and each verb now says plainly how far it
reaches, rather than the boundary being negotiated flag by flag.

- **`felt find <query>`** is the new verb whose job is finding: it always
  searches the whole enclosing store. Local hits print first under their local
  ids, then the rest of the store under a separator naming it, each by its
  full id there — ids that work as arguments right where you are. It takes
  ls's search-shaped flags (`-t`, `--body`, `-r`, `-e`, `--has-field`, `-s`,
  `-v`). The outer block is capped at 20 entries and closes with an exact
  count of the remainder; `--limit` sets another cap, `--limit 0` lifts it.
  (Long-only: ls's `-n` is `--recent`, and one letter meaning two things
  across two sibling search verbs is a trap.) `-j` emits one merged array,
  each fiber in the coordinates it was found in and carrying the `store` that
  holds it — uncapped and unsuppressed unless `--limit` is passed explicitly.
- **`felt ls` is always view-local.** Every flag filters this store's own
  listing and nothing else, so it stays fast. It no longer widens into the
  enclosing store when a filter is present, and `--local` is gone with the
  behavior it opted out of. In a substore, a filtered ls closes with one line
  naming `felt find` and the store it would search (text output only —
  `--json` is unchanged).
- **An id reaches anywhere.** Resolution now consults the enclosing store on
  every local miss, where before the probe was gated on the local basename
  rescue being about to fire — which made `felt show portolan/debug` resolve
  or not according to whether its slug happened to collide with a local one.
  Costs one walk of the outer id list, memoized, only on a miss.
- **`felt shuttle <verb>` crosses the boundary** like `rm` and `edit` already
  did, appending `(in <root>)` to its headline so a cross-store write is never
  silent.
- **`felt show --citations` / `--consumers`** additionally scan the enclosing
  store, so backlinks written from elsewhere in the loom appear under their
  full outer ids. Only those two selectors pay for it: the default `felt show`
  and `-d summary`'s back-ref block stay view-local, since the outer scan
  reads every body in the store.
- **`felt check` reports the shadowed-rescue case** at info level: where the
  enclosing store INFERS a ref's target — by its own scope and suffix rules,
  not from a path written out in full — AND a local basename rescue would
  have fired, both candidates are named instead of the loss being silent. A
  link written as a full outer id is someone naming the fiber they meant, and
  stays silent.

#### Smaller CLI additions

- `felt edit --set key=value` / `--unset key` writes and removes opaque
  top-level scalar frontmatter that felt does not parse natively.
- `felt check` flags fibers with a blank `name`.
- `felt shuttle reshape <fiber> [kind]` changes a block's kind or schedule
  in place, so most "rebuild it" cases no longer need an uninstall.
- Fiber JSON carries the fiber's physical path, including in narrow field
  projections.
- `felt ls <query>` collapses matches that sit under a matching ancestor into
  that ancestor, which carries a count of what it swallowed; `-v` lists every
  match flat. `--json` is unchanged — always the full, uncollapsed set.
- `felt tree -L <depth>` caps how deep the tree is drawn, marking each elided
  branch with the number of fibers below it.
- `felt show -d compact` and `-d summary` report the body's line count
  (`Body:     214 lines`), so a reader can decide whether the full body is
  worth paying for before paying for it.
- `felt check` counts a fiber it cannot parse as an error and reports it
  first. Malformed frontmatter — an unquoted outcome containing `: ` is the
  classic — used to be a stderr warning nothing counted, so a fiber could drop
  out of the assemblage entirely while `check` called four cosmetic things
  errors. It also names a fiber whose bytes iCloud has evicted, which produces
  the same symptom for a different reason.
- `felt init` says what it created and where, with an absolute path and the
  next two commands, instead of "Ensured .felt/ support files" — idempotency
  vocabulary at the one moment a fresh store most needs confirming.
- `felt uninstall` removes the marketplace it registered, not just the plugin,
  and its help says which parts of `setup` each agent's uninstall actually
  reverses. Claude's side previously left the registration behind while
  Codex's removed it: one command, two definitions of "removed".
- `shuttle install-agent` prints the board URL — the reason the daemon exists
  went unnamed by the command that starts it — and seeds `~/.shuttle/host` so
  the machine's identity is fixed before its first daemon boots.

### Changed

- **`felt setup codex` installs through Codex's own plugin commands.** Setup
  now runs `codex plugin marketplace add` followed by `codex plugin add`, and
  Codex materializes the plugin cache and writes its own
  `[plugins."felt@cailmdaley-felt"] enabled = true`. felt no longer edits
  `~/.codex/config.toml`, mirrors the plugin directory into Codex's cache by
  hand, or substitutes a GitHub ref when you pass a local `--source` — Codex
  accepts a directory marketplace directly, so local-checkout development
  installs the checkout itself. `--uninstall` runs `codex plugin remove` and
  `codex plugin marketplace remove`. Advancing a pinned tag on upgrade keeps
  working: because Codex binds a marketplace name to one source, setup drops
  and re-adds the registration when the ref moves. Requires a Codex with the
  native `plugin add` verb (verified on codex-cli 0.147.0).
- **A search no longer prints closed fibers.** A query, `-t`, or `--has-field`
  still widens past the open+active default so untracked fibers can match, but
  closed matches are counted in a trailing `(+N closed — add -s closed)` hint
  instead of burying the live ones. `-s closed` / `-s all` restore them, `-n`
  is exempt (it ranks by closed-at), and `--json` is untouched — the daemon
  poll, the hook, and the board still receive every status.
- **The PostToolUse recency stamp is rate-limited to once an hour per fiber.**
  Stamping `updated-at` on every direct fiber edit rewrote the file behind the
  agent's back, which the harness reports on each edit and which can stale a
  chained edit. A recency anchor (`updated-at`, else `created-at`) newer than
  an hour is already exact enough for session-start ranking, so the hook leaves
  the file alone.

- **The configured fleet ships by default.** The built-in registry is the
  full Claude / Codex / Pi set rather than a generic starter, so a fresh
  install resolves the agent ids the docs name.
- **The board admits two kinds of row and nothing else**: a fiber carrying
  a `shuttle:` block, and a cycle. A bare `due:` is a date, not a
  commitment the board can act on, so such a fiber is promoted rather than
  shown. The `soon` horizon and its timeline exile went with the change — a
  future `due:` alone never moves a card now.
- **Nothing on the temporal views is attributed by guessing.** Commit and
  session attribution reads the ledgers only; no `slug:` prefix parsing, no
  directory-name matching, no fallbacks.
- **`felt ls --body` is plain substring matching**, with `--body -r` for
  regex. It was FTS5 whole-word matching. Scripts that relied on word
  boundaries will now get more hits. This is a silent behavior change —
  check anything downstream that parses the output.
- Recency ranking uses `updated-at` only. Fibers that predate the
  backfill have no `updated-at` and sort last.
- The store-config vocabulary is de-loomed: the store registry lives at
  `~/.config/felt/stores.json`.
- Frontmatter marshalling preserves the order of extra fields, so
  tool-owned blocks stop churning the diff.
- `felt nest` / `felt unnest` preserve companion artifacts when moving a
  fiber subtree.
- Fiber resolution prefers an exact id over descendants, then falls back
  to a globally unique slug.
- `felt check`'s failure line dropped the always-zero warning count:
  `check failed: N error(s), 0 warning(s)` → `check failed: N error(s)`.
  Warnings (orphaned pins, for one) are still printed in the issue list;
  only the summary line stopped counting them.
- The board UI got a sky-over-board refresh: a timeline ribbon, pinned
  launcher chips, a Pinned band below the Now board, paginated days, and
  hover-lazy expansion.
- Board time handling is kind-aware. A `due:` date and a Codex session are
  civil days; `created_at` is an instant. A JavaScript suite runs under two
  pinned timezones to keep it that way.
- Board feeds are served from the poller document cache with etag/304 and
  a single tree walk per refresh. Staleness hysteresis tracks the last
  success, so one failed poll no longer flips the badge.
- The plugin bundles the shuttle skill alongside the felt skill. Both
  skills were rewritten against the current CLI.
- **The repo passes a stranger test on its prose, not just its code.**
  The maintainer's operator notes (~190 lines of hostnames, SSH rituals,
  per-host checkouts) moved out of AGENTS.md; the hygiene test now scans
  `ui/`, `bin/`, `share/`, every Markdown file, the Makefile, and
  `bootstrap.sh` for personal identifiers and paths, so they cannot creep
  back. `bin/shuttle-deploy` reads the fleet from
  `~/.config/felt/remotes.json` (a remote with a `checkout` key is a
  deploy target; `auth: "interactive"` marks hosts needing a live human
  credential). `make install-agent` requires `AGENT_FELT_STORES`
  explicitly instead of defaulting to a private store. The kitty
  window-raise is a no-op off macOS, and `~/.local/bin` joined the kitty
  binary candidates. The Elixir suite pins `FELT_REMOTES_FILE` alongside
  `FELT_AGENTS_FILE`, so a developer's own fleet config can no longer
  fail the label assertions.

### Removed

- The `features.plugin_hooks = true` write in `felt setup codex`. Codex runs
  plugin hooks without it. Note that Codex gates hooks on its own review
  instead: your next interactive session asks you to trust felt's hooks, and
  until you accept, the skills load but the hooks stay dormant.
- The legacy agent-registry mode. `builtins: "replace"` is gone; a file
  still carrying it now fails loudly rather than silently doing something
  else. Use `"restrict"`.
- The `claude-opus-chrome` convenience alias. Chrome stays an explicit axis
  on Claude agents (`felt shuttle set-agent … --chrome`), and
  `chrome_capable` remains a record field — only the alias agent is gone.
- The SQLite index cache (`.felt/index.db`) and the `felt index sync`
  command. felt is now pure markdown: citations, reverse data-flow
  consumers, and body search are computed from the markdown tree on
  demand, with no derived state on disk. Any leftover `.felt/index.db`
  file is inert and safe to delete.
- The whole history subsystem: the `history_events` table, the `felt
  history` command group, and hash-on-read `external_edit` detection.
  Editorial history is git's job. Recency is `updated-at`.
- `felt history append --edit-window-start` / `--edit-window-end` went with
  it. The flags only ever wrote `edit_window_start` / `edit_window_end`
  into the event payload; nothing read them back.
- The `ralph` skill is retired, and the plugin no longer advertises it.
- Inert daemon machinery: the reservation code path and the `/cache/bust`
  endpoint. The legacy felt-store registry and the obsolete human-due
  reader are also gone.
- Large internal cleanup (behavior-preserving, ~1,440 LOC net): the
  retired in-memory dependency-graph subsystem (`BuildGraph`, cycle
  detection, topological `ready`, mermaid/dot/text export — orphaned when
  the depends-on commands were dropped in 1.0.0), plus a batch of
  zero-caller helpers left by the Shuttle/ASTRA and pre-1.0.8 hook-wiring
  retirements. Several duplicated code paths (history tx/non-tx query
  twins, the ID scan-resolve scaffold, the `ls` field-alias tables, the
  native-frontmatter field list) were collapsed to single sources of truth.

### Fixed

- A per-fiber `flock` serializes every CLI read-modify-write verb. Two
  concurrent writers no longer race a fiber's frontmatter. The lock files
  (`*.md.lock`) are gitignored by `felt init`.
- Every shell-out to `felt` is bounded by a runner that reaps the OS
  process. A timeout now reports "world unknown" rather than "not found",
  so a slow host cannot look like a missing fiber.
- Dispatch markers stamp synchronously at each boundary. Async capture only
  backfills what is already true.
- Ownership resolution fails loudly when it cannot resolve its own host,
  instead of quietly attributing work to the wrong one.
- The PATH baked into the supervisor is captured from a scrubbed environment
  and backstopped by `felt`'s own directory. A login shell prepends to the
  PATH it inherits, so an `install-agent` run from inside a coding-agent
  session — for shuttle, the common case — used to bake that session's
  ephemeral entries into launchd forever. Each capture attempt is now bounded
  by a watchdog, and whatever it produces, the directory the running `felt`
  came from is appended if missing (its absence is what yields `:enoent` →
  500 on the composite API).
- The generated launchd plist and systemd unit stop describing a checkout.
  Their headers explained the file as something `make install-agent` wrote in
  `~/dev/shuttle`, which is not true of a release tarball — the install path
  the docs recommend — and the `FELT_STORES` comment described the
  maintainer's own store as though it were a fact about the reader's.
- A machine's identity is now fixed the first time it is needed. The CLI and
  the daemon each fell back to the OS hostname, which is not one value: Go
  keeps the DNS suffix where Erlang strips it, and DHCP rewrites it outright.
  A Mac that called itself `studio-air.home` to the CLI and
  `studio-macbook-air` to the daemon armed fibers no daemon would ever
  dispatch, silently. The hostname is now normalized (lowercased, cut at the
  first `.`) and written to `~/.shuttle/host` on first use, so both sides read
  one durable name. The mismatch error also stopped calling the CLI a daemon
  and now points at whichever source actually decided the identity. If your
  machine's hostname carried uppercase or a DNS suffix, normalization changes
  what it resolves to — check the `host:` on fibers armed before this release
  and update any that still hold the old raw name, or they will sit
  undispatched. `felt check` now warns when it finds one.
- A store the daemon cannot walk no longer takes the board down with it. The
  symlink-substore expansion behind the store list is a raw filesystem walk
  with no timeout, and it used to run in whichever process asked — including
  the request processes serving `/api/v1/fibers/composite` and
  `/api/v1/felt-stores`. Point the daemon at a store macOS guards (iCloud
  Drive, `~/Library/CloudStorage`) and the first walk raises a consent dialog;
  until someone clicks it, every endpoint queued behind it. On the first
  install by someone other than the author that meant responses at 17, 27 and
  32 seconds and one 503 at 95 — which is simply how long the dialog sat
  unanswered behind another window. The walk now runs in a background task and
  reads answer from cache: a store that cannot be walked degrades the
  *freshness* of the store list, never the *availability* of the endpoint
  reading it. The same bound covers the two `project_dir` stats the poller
  makes on its own process, and the post-mutation document re-read now defers
  its reply rather than holding the poller's mailbox for the length of a
  `felt show`. A slow walk also says so: the log names the store holding
  things up and what usually causes it, and the daemon snapshot and
  `/api/v1/felt-stores` carry the same scan report.
- …and the layer under that: the daemon's filesystem calls no longer go
  through the OTP file server. `File.ls/1`, `File.dir?/1`, `File.stat/1` and
  friends are client calls into `:file_server_2`, a single process shared by
  the whole VM, so one call parked on an unanswered consent dialog blocked
  *every* filesystem call in the daemon — including the ones inside the
  background task that was supposed to contain it, and including
  `System.find_executable/1`, which is how the daemon locates `felt` and
  `tmux` before every shell-out. The store walk, path realpathing, the bounded
  `project_dir` probe, executable resolution and the file-serving read
  endpoints now use `Shuttle.RawFS`, which bypasses the file server. Those
  calls are dispatched to the VM's dirty IO schedulers instead — ten of them,
  so a parked probe is cheap but not free, which is why the store scan now
  holds its single-flight lock until the scanner answers *or dies* rather than
  expiring it on a timer: re-probing a store nobody has clicked through
  accumulates parked walks, and the tenth one wedges the VM. A scan already
  out longer than the caller's patience is no longer waited on at all.
- The standing-role reconciler self-heals inverted markers instead of
  re-closing live work. Dead pinned roles park rather than relaunching in a
  loop.
- Force-dispatch reopens a closed fiber authoritatively, not on a
  best-effort basis.
- CI: several tests assumed macOS and failed on Linux.
- Plugin hooks survive a GUI `PATH`, and the Codex hook root falls back
  correctly — a session launched outside a shell no longer loses them.
- A draft installed with `felt shuttle install --disabled` keeps the
  working directory it was given.
- Dispatch preflights the agent wrapper, so a missing CLI fails loudly at
  launch instead of producing a dead worker.
- A Linux host can be the hub, not only a worker, and `bootstrap.sh` exits
  0 on a successful Linux run.
- Resting cards keep the date they were given, and an active card with a
  stale resting horizon is parked rather than left half-placed.
- The temporal fetch memo no longer outlives the poll, so views update
  within one tick.

#### Fleet operability

These entries concern the maintainer's own machines. They are listed for
completeness.

- Registered two additional remotes (`:4003`, `:4004`).
- Multiplexed tunnels for 2FA hosts, supervised by a socket-gated loop
  instead of autossh.
- `bin/shuttle-deploy` gained a fleet verb and `--handshake`.
- `bin/shuttle-launch` is a tracked respawner with exponential backoff
  (2s → 300s), and the daemon log is size-rotated.
- A boot quarantine holds *fresh* dispatch after a daemon restart while
  auto-resuming in-flight work. `bin/shuttle release` lifts it, as does
  clicking the held badge on the board.
- Deploy verification reports `booted_at` alongside `git_sha`, because a
  compile-time sha can lie about what is actually running.

## [1.0.9] — 2026-05-18

### Added

- `felt init` now writes a store-owned `.felt/.gitignore` for felt's
  generated index and sync coordination files, without overwriting an
  existing user-edited ignore file.

### Fixed

- `felt setup claude` and `felt setup codex` on an existing install
  used `marketplace update`, which only re-fetches the marketplace's
  current pinned ref — so a `brew upgrade felt` from v1.0.7 → v1.0.8
  left the marketplace ref pinned at v1.0.7, plugin update saw no
  version diff, and the installed plugin stayed at the old content.
  Both setup paths now `marketplace add` with the current binary's ref
  (idempotent re-register for directory sources; ref-advance for git
  sources), then `plugin install`/`update` to apply. This is the path
  that actually moves users forward.

## [1.0.8] — 2026-05-17

### Fixed

- `felt ls -j` (and `felt check -j`, `felt tree -j`'s roots, projected
  listings) previously returned literal `null` instead of `[]` when no
  fibers matched. The SessionStart hook tripped over this for users with
  no active fibers: the pre-13d5d35 hook checked only for `[]`, so
  brew-upgrading the binary against an unrefreshed plugin started failing
  every session. `outputJSON` now normalizes nil slices to empty slices
  via reflection — every listing endpoint emits `[]` for empty results,
  and consumers never have to handle two shapes.

### Changed

- Plugin hooks (`claude-plugin/hooks/{session,remind}.sh`) are now thin
  shims that `exec felt hook <event>`. Hook behavior — find-root, fiber
  listing, SessionStart envelope, PreToolUse deny gate — lives in the
  binary as `felt hook session` and `felt hook pretool`. The plugin only
  needs refreshing when skill content changes. jq is no longer required
  by the hooks.

- Binary and integrations now update in lockstep so they can't drift:
  - `felt update` refreshes the Claude Code plugin (`marketplace update`
    + `plugin update`) after swapping the binary, and also re-runs
    `felt setup codex` if Codex integration is currently installed. One
    command, every layer current.
  - The homebrew formula has a `post_install` step that runs `felt setup
    claude` (and `felt setup codex` if Codex integration is detected),
    so `brew upgrade felt` keeps every integration in sync too. Skipped
    silently if the respective CLI isn't installed.
  - `felt setup claude` is now fully idempotent — if the marketplace is
    already registered, it takes the update path instead of erroring on
    duplicate add.

- Codex integration is now a real plugin via Codex's plugin marketplace
  rather than direct `~/.codex/hooks.json` wiring. Same plugin layout
  serves both agents: a new `.codex-plugin/plugin.json` sits next to the
  existing `.claude-plugin/plugin.json` inside `claude-plugin/`, both
  pointing at the same `hooks/` and `skills/` directories. Codex's
  marketplace install picks up the plugin from the felt repo's existing
  Claude-style `.claude-plugin/marketplace.json` (Codex reads it as a
  legacy-compat format). `felt setup codex` now:
  - Runs `codex plugin marketplace add <source>` to register the felt
    marketplace,
  - Auto-flips `features.plugin_hooks = true` in `~/.codex/config.toml`
    so Codex actually runs the bundled hooks (off by default in Codex),
  - Enables `[plugins."felt@cailmdaley-felt"]`,
  - Prunes any direct hook entries from `~/.codex/hooks.json` and any
    `~/.agents/skills/{felt,ralph}` symlinks left over from the pre-1.0.8
    direct-wiring model — Codex now sources both hooks and skills via the
    plugin.

  Existing Codex users will see the cleanup happen automatically on the
  next `felt setup codex` (or `felt update`, which calls it).

## [1.0.5] — 2026-05-04

### Fixed

- `depends-on:` (the legacy hyphen form) was previously listed in
  `knownFrontmatterKeys` without a corresponding struct field, so it was
  silently absorbed at parse time and never surfaced anywhere — including
  in JSON output. Lands in `ExtraFields` now like any other unknown key,
  so `felt show --json` and `felt ls --json` round-trip the dependency
  edges. The migrate command's destructive normalization
  (`normalizeLegacyFrontmatter` strips `depends-on` from disk on `felt
  migrate`) is unaffected — it operates on the raw YAML node, not the
  parsed Felt.

## [1.0.4] — 2026-05-04

### Changed

- `felt show --json` now includes tool-owned frontmatter namespaces (any
  top-level YAML keys felt does not parse — `shuttle`, `tempered`,
  `depends_on`, project-defined namespaces, etc.) as flat top-level JSON
  keys. Previously these were silently omitted, forcing programmatic
  consumers to fall back on `--field <key>` per-key reads. The lossy JSON
  output had concretely bitten the shuttle daemon's dispatcher: every
  fiber declaring `shuttle.agent: claude-opus` (or any non-default agent)
  silently downgraded to claude-sonnet because `fetch_fiber` got an
  empty `shuttle` map back. JSON now mirrors the round-trip-the-bytes
  contract felt already promises elsewhere. Backward-compatible: existing
  consumers that ignore unknown keys are unaffected.

## 1.0.3 — 2026-05-03

### Changed

- `felt ls <query>` now matches against the fiber's id (slug) in addition
  to its name, outcome, and structured frontmatter. Substring queries match
  any part of the full id, so `felt ls "dj-rico"` returns `dj-rico-contract`
  even when the fiber's name is "dj rico contract". Regex queries (`-r`) are
  also applied to the id. Exact queries (`-e`) accept either the full id or
  the id's basename (last path segment), enabling `felt ls -e "my-fiber"` to
  resolve `project/my-fiber` by basename.
- Help text for `felt ls --help` updated to document id/slug matching.

## [1.0.2] — 2026-05-03

### Fixed

- `felt setup codex` now dedupes felt hooks by path-suffix instead of
  exact-string match, so re-running setup with a different `--source`
  no longer leaves stale entries alongside the new ones in `hooks.json`.
  Reports clearly which case applies: "already installed" when nothing
  changed, "Updated" when the path moved (with the previous path
  shown), or "Removed N duplicate(s)" when stale entries were pruned.
- `felt setup codex --uninstall` no longer requires `--source` — felt
  hooks are identified by path suffix, so stale entries can be cleaned
  up even after the original checkout is gone.
- The SessionStart hook (`session.sh`) bails gracefully when `jq` is
  not installed, emitting the activate-felt directive plus a hint about
  installing `jq` for the fiber listing. Previously it would fail
  mid-pipeline with a noisy error. The PreToolUse hook already handled
  this case.

## [1.0.1] — 2026-05-03

### Changed

- `felt setup claude` no longer requires a local checkout. With no
  `--source`, it registers `cailmdaley/felt` directly from GitHub —
  Claude Code clones the marketplace itself. Tagged felt binaries pin
  the plugin to the matching tag (e.g. `cailmdaley/felt#v1.0.1`); `dev`
  builds track the default branch. Brew and curl users can run `felt
  setup claude` and have it just work.
- `felt setup codex` falls back to Claude Code's marketplace clone at
  `~/.claude/plugins/marketplaces/cailmdaley-felt/` when no `--source`
  is given, so a fresh `setup claude` followed by `setup codex` wires up
  both integrations without a manual checkout.

### Documentation

- README rewrite: opens by naming what felt is and defining "fiber" on
  first concrete use, drops the empty "lightweight" claim in favour of
  the concrete things that are true (single static binary, no daemon,
  rebuildable cache, plain-markdown source of truth), and names the
  audience early.

## [1.0.0] — 2026-05-03

The 1.0 release consolidates the directory-fiber pivot, an FTS5/SQLite
index, a per-fiber append-only history log, and a Claude Code plugin
marketplace install path. Plain markdown with YAML frontmatter remains
the source of truth — `.felt/index.db` is a rebuildable cache.

### Added

#### Directory-based fiber storage

- Each fiber lives in its own directory at `.felt/<path>/<slug>/<slug>.md`.
  Containment is the directory tree; nested IDs use paths
  (e.g. `bao-analysis/damping-prior`).
- Bare root fibers (`.felt/<slug>.md`) are recognised as entry-point
  fibers so a project's main narrative can sit at the root without a
  wrapping directory.
- Scoped resolution: `felt show second-fiber` walks up from the current
  fiber's containing directory before falling back to a global search,
  with exact-basename matches preferred over prefix matches.
- `felt nest <child> <parent>` and `felt unnest <id>` reshape the tree
  while rewriting `inputs.from` references.
- Symlinked walk roots are resolved once and visited tracking prevents
  cycles, so `.felt/` can safely symlink subtrees from elsewhere
  (e.g. the `loom` monorepo pattern).

#### SQLite index + FTS5 body search

- `.felt/index.db` indexes typed links, citations, tags, ASTRA
  summaries, and full-text body content. Rebuildable from the markdown
  tree at any time; no separate authoring path.
- `felt ls --body "query"` runs FTS5 search against fiber bodies.
- `felt show --citations` and `--consumers` surface narrative
  back-references and computational data-flow consumers via the index.
- File-backed views (`show <id>`) skip the index sync to stay fast and
  read-only-friendly.
- Hardened against `SQLITE_BUSY` contention under concurrent access.

#### Per-fiber append-only history log

- `felt history <id>` shows an editorial chain of summary events
  (newest first), plus mechanical `add`/`edit`/`rm`/`external_edit`
  events when `--mechanical` is passed.
- `felt history append <id> --summary "…"` records session continuity.
- `--kind <type>` typed events for downstream tools
  (e.g. `review-comment`).
- `--last 1` returns just the most recent event for handoff.

#### Claude Code plugin marketplace install

- `felt setup claude` registers the felt repository as a Claude Code
  plugin marketplace and installs the `felt` plugin via the official
  CLI (`claude plugin marketplace add` + `claude plugin install`).
  Idempotent — re-running is safe.
- The plugin bundles two skills (`felt`, `ralph`), a `SessionStart`
  hook that lists active and recently-touched fibers, and a
  `PreToolUse` hook that gates the first non-skill tool call until the
  felt skill has been activated.
- `--source <checkout>` or `$FELT_PLUGIN_DIR` selects which felt
  checkout to register; `--uninstall` removes the plugin.
- `felt setup codex` symlinks the same skills into `~/.agents/skills/`
  and configures Codex's `hooks.json` against the plugin's
  `session.sh` / `remind.sh` scripts.

#### CLI surface

- `felt check` lints fibers for broken refs, frontmatter issues,
  wikilinks inside code spans, absolute-path link targets, ASTRA
  reference fragments, and legacy-format residue.
- `felt edit` shorthand for one-level ASTRA structure: `--decision`
  with `--label`/`--rationale`/`--default`/`--option`, plus `--input`
  and `--insight`. `--option` accepts `\:` escapes.
- `felt show` targeted views: `--body`, `--decisions`, `--decision`,
  `--inputs`, `--outputs`, `--insights`, `--field <key>` for
  shell-friendly raw frontmatter extraction. `-d full` includes all
  ASTRA slices.
- `felt ls` emits `entry_point: true` for bare `.felt/<slug>.md` root
  fibers.
- `felt tree` shows containment hierarchy.
- `felt -C <dir>` runs felt as if started in `<dir>`.
- Tool-owned frontmatter (e.g. `shuttle:`) round-trips cleanly via
  `ExtraFields` preservation — felt doesn't parse or enforce, just
  preserves.

#### Migration

- `felt migrate` normalises legacy flat fibers into directory format,
  rewrites pre-existing `inputs` references, renames `title` →`name`,
  strips legacy MyST anchors, and removes obsolete `depends-on` keys.
- `--dry-run` previews all changes before writing.

### Changed

- The relationship model is now: directory containment for hierarchy,
  `[[wikilinks]]` in bodies for narrative cross-references, and ASTRA
  `inputs.from` for computational data flow. The older `tapestry:*` and
  `tier:*` tag conventions and the `depends-on` link-graph are retired.
- Fiber `name` replaces the legacy `title` field. Bodies are plain
  markdown (no MyST anchors required).
- Status is opt-in: `felt add <slug> "name"` creates a statusless
  fiber. `felt ls` defaults to tracked (open + active); add filters
  widen to all statuses.
- `setup codex` now points hooks at the plugin's shell scripts
  directly, rather than `felt hook session` / `felt hook remind` CLI
  subcommands.

### Removed

- `internal/tapestry`, ASTRA runtime types, and Shuttle coupling moved
  out of the felt core.
- Public CLI: `tapestry`, `tag`, `untag`, `link`, `unlink`, `comment`,
  `upstream`, `downstream`, `graph`, `ready`, `prime`, `path`, and
  `export` are removed (most absorbed into `edit` / `show` / `ls` or
  retired with the depends-on graph).
- Async Stop "conscience" hook retired in favour of the channel-nudge
  approach.

### Fixed

- `felt add` preserves explicit slug length instead of silently
  truncating.
- Setup heals broken skill symlinks before re-installing.
- `felt check` ignores wikilinks inside fenced code blocks and code
  spans.
- Session hook detects Claude Code sessions by transcript path rather
  than relying on environment presence.

[1.0.0]: https://github.com/cailmdaley/felt/releases/tag/v1.0.0
[1.0.1]: https://github.com/cailmdaley/felt/releases/tag/v1.0.1
[1.0.2]: https://github.com/cailmdaley/felt/releases/tag/v1.0.2
[1.0.4]: https://github.com/cailmdaley/felt/releases/tag/v1.0.4
[1.0.5]: https://github.com/cailmdaley/felt/releases/tag/v1.0.5
[1.0.8]: https://github.com/cailmdaley/felt/releases/tag/v1.0.8
[1.0.9]: https://github.com/cailmdaley/felt/releases/tag/v1.0.9
[1.1.0]: https://github.com/cailmdaley/felt/releases/tag/v1.1.0
