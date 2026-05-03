# Changelog

All notable changes to felt are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
