<p align="center">
  <img src=".github/banner.png" alt="felt" width="600">
</p>

<p align="center">
  <a href="https://github.com/cailmdaley/felt/actions/workflows/ci.yml"><img src="https://github.com/cailmdaley/felt/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

# felt

A CLI for the durable trail that builds up around work. Each entry is a *fiber*: a directory under `.felt/` with a `<slug>.md` file inside, carrying YAML frontmatter and a plain-markdown body.

The directory tree gives hierarchy. `[[wikilinks]]` in bodies give narrative cross-references. Native metadata stays small (`name`, `status`, tags, timestamps, `outcome`, `due`, `description`). Any other top-level YAML keys are preserved opaquely so downstream tools can own their own schema without felt claiming it.

A rebuildable SQLite index at `.felt/index.db` caches narrative back-references, reverse data-flow consumers, history lookups, and search rows, but plain markdown is the source of truth and the cache carries no extra authoring burden.

Felt is designed to be persistent memory for AI coding agents as much as for you. The bundled [Claude Code plugin](#agent-integration) and Codex hooks make `.felt/` the substrate agents reach for between sessions.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | sh
```

Installs to `~/.local/bin` by default (or `/usr/local/bin` if writable). Override with `FELT_INSTALL_DIR`.

Also available via Homebrew (`brew install cailmdaley/tap/felt`) or from source (`go install github.com/cailmdaley/felt@latest`).

Update to the latest release:

```bash
felt update
```

## Quick Start

```bash
felt init                                              # creates .felt/ support files
felt add use-des-y3-weights "Use DES Y3 weights"       # file a decision / task / note
felt add covariance-estimation "Covariance estimation"
felt edit covariance-estimation -s closed -o "switched to jackknife — 10x faster, <2% bias"
felt history covariance-estimation                     # append-only event log per fiber
```

A fiber can be anything: a task, a decision, a research claim, a question, a spec. The body carries detail, wikilinks cite related fibers, and the outcome captures the conclusion.

```bash
felt show covariance-estimation        # inspect one fiber
felt tree                              # containment hierarchy
felt ls -s all "jackknife"             # search across everything
```

## Fibers

A fiber is stored as `.felt/<path>/<slug>.md`. For example:

```yaml
---
id: 01KTC9C1G1CBJ84H6WB92J8A13
name: Covariance estimation
status: closed
tags: [pure-eb, methods]
created-at: 2026-01-15T10:30:00Z
closed-at: 2026-01-16T14:20:00Z
outcome: "Jackknife covariance, 10x faster than analytic, <2% bias at all scales"
---

Tried analytic first — too slow for the number of bins we need.
Jackknife on 150 patches gives stable diagonal + off-diagonal.

See also [[use-des-y3-weights]].
```

The CLI address is a slug path such as `covariance-estimation` or `bao-analysis/damping-prior`. Bare slugs resolve when globally unique, so `felt show damping-prior` and `felt show bao-analysis/damping-prior` both work when unambiguous.

The frontmatter `id` is a ULID minted once at `felt add` and preserved across moves. JSON keeps the slug address at `id` for compatibility and exposes the intrinsic frontmatter value as `uid`.

### Status

Status is opt-in. Most fibers don't need it. Add `-s open` when something needs tracking.

```
· untracked    just a fiber
○ open         tracked, not started
◐ active       in progress
● closed       done — outcome captured
```

### Tags

```bash
felt add fix-bug "Fix bug" -t pure-eb -t urgent
felt edit covariance-estimation --tag note
felt ls -t pure-eb                        # filter by tag
felt ls -t tapestry:                      # prefix match
```

For backward compatibility, felt also extracts `[tag]` prefixes from the slug argument.

### Relationships

Containment comes from the directory tree. Narrative connections live in `[[wikilinks]]` inside the body. Some projects also use conventions like `inputs.from` to express data flow; when present, felt indexes reverse consumers without treating the rest of that frontmatter as a felt-owned schema.

```bash
felt tree                               # containment hierarchy
felt show covariance-estimation         # body refs + citations + reverse consumers
felt ls "DES Y3"                        # search names, outcomes, frontmatter text, and ids
felt ls --body "jackknife patches"      # body search
```

### Additional YAML fields

Fibers can carry any top-level YAML keys alongside felt's native metadata. felt preserves them on read/edit/write, exposes them in JSON, and lets you inspect a single key with `felt show --field <key>`.

```yaml
---
name: BAO Damping Prior
outcome: Informative Gaussian priors confirmed.
inputs:
  - id: clustering_data
    type: data
    from: parent.desi_dr1_vac
decisions:
  damping_prior:
    label: BAO Damping Prior
    default: gaussian
    options:
      gaussian:
        label: Informative Gaussian
---
```

```bash
felt ls "BAO"                         # name, outcome, frontmatter text, and id
felt show bao/damping-prior --field decisions
felt show bao/damping-prior --json    # extra top-level keys included in JSON
```

**Important boundary:** felt does not validate or edit those schemas directly. If a project wants `decisions`, `insights`, `shuttle`, or anything else to mean something specific, that project owns the contract.

### History

Each fiber carries an append-only event log — editorial notes, reviews, mechanical add/edit, and external_edit detection — for chronological handoff across sessions and tools.

```bash
felt history <id>                              # editorial chain (newest first)
felt history <id> --last 1                     # what the previous session left
felt history <id> --mechanical                 # + add/edit/external_edit
felt history append <id> --summary "..."       # log session continuity
felt index sync                                 # refresh the rebuildable SQLite cache
```

### Progressive disclosure

```bash
felt show <id>                    # full body + metadata
felt show <id> -d name            # name + tags only
felt show <id> -d compact         # metadata + outcome + additional YAML field keys
felt show <id> -d summary         # compact + citations/consumers + lede
felt show <id> --body             # body + body start line for editing
felt show <id> --citations        # narrative back-references only
felt show <id> --consumers        # reverse data-flow consumers only
felt show <id> --field shuttle    # one raw frontmatter field
felt index sync                   # explicit SQLite cache refresh
```

## Obsidian

A `.felt/` directory is a valid Obsidian vault. Open it in Obsidian for a GUI browser with backlinks, graph view, and full-text search; felt's `[[wikilinks]]` are the Obsidian format.

Because felt treats non-native frontmatter opaquely, Dataview can still query whatever your project stores there. Example:

```dataview
TABLE status, outcome
FROM "."
WHERE shuttle.enabled = true
```

Obsidian is not a dependency. The CLI and the `.felt/` tree are the source of truth; use them separately or together.

## Agent integration

Felt ships as a [Claude Code plugin](https://docs.claude.com/en/docs/claude-code/plugins) and a Codex skill bundle:

```bash
felt setup claude                 # registers cailmdaley/felt marketplace, installs the plugin
felt setup codex                  # symlinks skills into ~/.agents/skills, configures Codex hooks
```

The plugin bundles two skills (`felt`, `ralph`), a SessionStart hook that lists active and recently touched fibers, and a PreToolUse hook that gates the first non-Skill tool call until the felt skill has been activated.

### Bundled skills

| Skill | Purpose |
|-------|---------|
| **felt** | Filing fibers, drafting constitutions, mining sessions, maintenance passes, transcript processing |
| **ralph** | Executing autonomous iteration loops over a constitution |

## Commands

```bash
# Core
felt init                         felt add <slug> <name> [flags]
felt edit <id> [flags]            felt show <id> [-d level]
felt ls [query]                   felt check
felt history <id>                 felt history append <id> --summary "..."
felt tree                         felt nest|unnest <id>
felt migrate [--dry-run]          felt rm <id>
felt index sync                   felt session
felt setup claude|codex|skills    felt update
```

### Common flags

```bash
# felt add
-b, --body "text"                 -s, --status open|active|closed
-t, --tag <tag>                   -D, --due 2024-03-15
-o, --outcome "text"

# felt edit
--name "text"                     --tag <tag>
--untag <tag>                     --body "text"
--outcome "text"                 --status open|active|closed

# felt show
-d, --detail name|compact|summary|full
--body                            --citations
--consumers                       --field <key>

# global
-j, --json
```

## Inspirations

Felt borrows from several projects exploring how to give AI coding agents structured, persistent context:

- **[Zettelkasten](https://en.wikipedia.org/wiki/Zettelkasten)** — Niklas Luhmann's slip-box method, the ancestor of modern linked-note knowledge management. Emergent structure from connections rather than prescribed hierarchy.
- **[Beads](https://github.com/steveyegge/beads)** — Steve Yegge's graph-based, git-backed issue tracker designed as agent memory. The core conviction — that coding agents need structured persistent memory they can query, not just scratch files — is load-bearing for felt.
- **[Dots](https://github.com/joelreymont/dots)** — Joel Reymont's minimalist counterpart to Beads. The directory tree as source-of-truth stance runs through felt too — the SQLite cache at `.felt/index.db` is strictly a rebuildable index, not storage.
- **[Ralph Wiggum](https://github.com/ghuntley/how-to-ralph-wiggum)** — Geoffrey Huntley's autonomous iteration technique: feed the agent the same spec on a loop until the work is done.
- **[Ouroboros](https://github.com/Q00/ouroboros)** — Q00's specification-first AI coding workflow. The Double Diamond rhythm (Wonder → Ontology, Design → Delivery) in the bundled writing references is adapted from this lineage.

## License

[MIT](LICENSE)
