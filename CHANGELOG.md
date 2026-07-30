# Changelog

All notable changes to felt are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

This is the largest change in the project's history. Two things happened.
Shuttle — the Elixir orchestration daemon and its board UI — moved into
this repository and behind the `felt` binary. And felt went back to pure
markdown: the SQLite index and the history log are gone, and identity and
recency now live in the frontmatter.

> **Note.** The `felt shuttle` command group and the daemon are currently
> fleet-oriented. The agent registry is compiled into the binary, the tunnel
> verbs hardcode the maintainer's hosts, and the daemon and UI are not release
> artifacts — only the Go binary ships. Homebrew users get the verb tree; the
> daemon-HTTP verbs will fail with nothing listening on `:4000`. Treat it as
> readable prior art, not a product you can install.

### Added

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

#### Identity and recency in the files

- Fibers carry an intrinsic ULID `id`. `felt backfill-ids` mints ids for
  existing stores (`--dry-run` previews). Fibers resolve by UID as well as
  by slug.
- Recency is an `updated-at` frontmatter field (`updated_at` in JSON), so it
  survives clone, sync, and checkout instead of depending on file mtime. A
  new PostToolUse hook stamps it when an agent edits a fiber file directly.
- Session context lists five active-or-open fibers with a recency
  timestamp on each entry.

#### Smaller CLI additions

- `felt edit --set key=value` / `--unset key` writes and removes opaque
  top-level scalar frontmatter that felt does not parse natively.
- `felt check` flags fibers with a blank `name`.
- Fiber JSON carries the fiber's physical path, including in narrow field
  projections.

### Changed

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

### Removed

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
- The standing-role reconciler self-heals inverted markers instead of
  re-closing live work. Dead pinned roles park rather than relaunching in a
  loop.
- Force-dispatch reopens a closed fiber authoritatively, not on a
  best-effort basis.
- CI: several tests assumed macOS and failed on Linux.

#### Fleet operability

These entries concern the maintainer's own machines. They are listed for
completeness.

- Registered remotes: amundsen (`:4003`) and nibi (`:4004`).
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
