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

Fibers are plain markdown in git, so a fiber's chronology is its file's `git log` — there is no separate event log to maintain. The current handoff state lives in the body itself (the `outcome`, and a `## Status` section where a fiber keeps one), travelling with the file across machines and tools.

```bash
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

The plugin bundles the `felt` skill, a SessionStart hook that lists active and recently touched fibers, and a PreToolUse hook that gates the first non-Skill tool call until the felt skill has been activated.

### Bundled skills

| Skill | Purpose |
|-------|---------|
| **felt** | Filing fibers, drafting constitutions, mining sessions, maintenance passes, transcript processing |

## Commands

```bash
# Core
felt init                         felt add <slug> <name> [flags]
felt edit <id> [flags]            felt show <id> [-d level]
felt ls [query]                   felt check
felt shuttle <verb>               # agent dispatch (status, ps, install, …)
felt tree                         felt nest|unnest <id>
felt migrate [--dry-run]          felt rm <id>
felt index sync                   felt session
felt backfill-ids [--dry-run]     # owner-only intrinsic id migration
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
- **[Ralph Wiggum](https://github.com/ghuntley/how-to-ralph-wiggum)** — Geoffrey Huntley's autonomous iteration technique: feed the agent the same spec on a loop until the work is done. It shaped how a `shuttle` constitution gets driven — a fresh worker redispatched against the fiber until its desired state holds — rather than any skill felt itself bundles.
- **[Ouroboros](https://github.com/Q00/ouroboros)** — Q00's specification-first AI coding workflow. The Double Diamond rhythm (Wonder → Ontology, Design → Delivery) in the bundled writing references is adapted from this lineage.

## Shuttle

The same repo ships **Shuttle**: an OTP dispatcher that polls the felt tree and
launches one tmux worker per eligible fiber — a fiber carrying a `shuttle:`
frontmatter block whose status is `open` or `active`. It serves a kanban board at
`http://127.0.0.1:4000/` for watching and steering those autonomous workers.
Workers stay attachable (`tmux attach -t shuttle-<fiber-id>`); the daemon
supervises the watcher, not the worker.

Stand it up from source with the bootstrap (`./bootstrap.sh` or `make install`),
which builds+installs the felt CLI, builds the daemon, places the board bundle,
and installs the keep-alive. See **[AGENTS.md](AGENTS.md)** for the full
operator and contributor guide.

## License

The felt CLI and the board UI are licensed under the [MIT License](LICENSE).
The Shuttle daemon (`lib/`) contains code derived from OpenAI's Symphony under
the [Apache License 2.0](LICENSE-APACHE), preserved in `NOTICE` and
`LICENSE-APACHE`.
