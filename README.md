<p align="center">
  <img src=".github/banner.png" alt="felt" width="600">
</p>

<p align="center">
  <a href="https://github.com/cailmdaley/felt/actions/workflows/ci.yml"><img src="https://github.com/cailmdaley/felt/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

# felt

A CLI for the structured trail that builds up around work — decisions made, alternatives rejected, claims under test, tasks open, fragments waiting to consolidate. Each entry is a *fiber*: a directory under `.felt/` with a `<slug>.md` file inside, carrying YAML frontmatter and a plain-markdown body.

The directory tree gives hierarchy. `[[wikilinks]]` in bodies give narrative cross-references. YAML frontmatter holds structure (status, tags, decisions with excluded alternatives, inputs, insights), accreting as a fiber crystallizes. A rebuildable SQLite index at `.felt/index.db` makes the lot queryable — FTS5 over bodies, narrative back-references, reverse data-flow consumers — but plain markdown is the source of truth and the cache carries no extra authoring burden.

Felt round-trips arbitrary YAML, so tool-owned namespaces (`shuttle:`, or anything else a downstream tool wants to attach) survive edits unchanged. A `.felt/` directory opens as a valid Obsidian vault out of the box (see [Obsidian](#obsidian)). The binary is a single static Go executable; no daemon, no required configuration.

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

### Agent setup

Felt ships as a [Claude Code plugin](https://docs.claude.com/en/docs/claude-code/plugins) and a Codex skill bundle:

```bash
felt setup claude                 # registers cailmdaley/felt marketplace, installs the plugin
felt setup codex                  # symlinks skills into ~/.agents/skills, configures Codex hooks
```

`setup claude` registers the felt marketplace from GitHub directly — Claude Code clones it, no local checkout required. Tagged felt binaries pin the plugin to the matching tag so the binary and the plugin stay aligned. `setup codex` reuses that clone for its own hook setup, so just running the two commands above is enough.

The plugin bundles two skills (`felt`, `ralph`), a SessionStart hook that lists active and recently touched fibers, and a PreToolUse hook that gates the first non-Skill tool call until the felt skill has been activated. See [Agent Integration](#agent-integration) for details.

## Quick Start

```bash
felt init                                              # creates .felt/ support files
felt add use-des-y3-weights "Use DES Y3 weights"       # file a decision
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

IDs are slug paths such as `covariance-estimation` or `bao-analysis/damping-prior`. Bare slugs resolve when globally unique, so `felt show damping-prior` and `felt show bao-analysis/damping-prior` both work when unambiguous.

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

For backward compatibility, felt also extracts `[tag]` prefixes from the slug argument:

```bash
felt add "[pure-eb] covariance-estimation" "Covariance estimation"
```

### Relationships

Containment comes from the directory tree. Narrative connections live in `[[wikilinks]]` inside the body. Structured `inputs.from` references express data flow when a fiber becomes computationally formalized. Felt indexes both edge types in SQLite, so `felt show` can surface narrative back-references and reverse data-flow consumers, while `felt ls --body` uses FTS instead of hydrating every body file.

```bash
felt tree                               # containment hierarchy
felt show covariance-estimation         # body refs + citations + reverse consumers + frontmatter summary
felt ls "DES Y3"                        # search names, outcomes, structured fields
felt ls --body "jackknife patches"      # FTS5 body search
```

### Structured Frontmatter

Fibers can carry structured frontmatter — decisions with excluded alternatives, inputs and outputs with recipes, insights backed by evidence — alongside felt's native fields. These accrete as work crystallizes and are searchable through `felt ls`. Felt round-trips them opaquely; downstream tools project meaning onto them.

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
felt ls "BAO"                 # name, outcome, and structured fields
felt check                    # broken refs/fragments, legacy format residue, formalization drift
```

### History

Each fiber carries an append-only event log — editorial summaries, reviews, mechanical add/edit/rm, and external_edit detection — for chronological handoff across sessions and tools.

```bash
felt history <id>                              # editorial chain (newest first)
felt history <id> --last 1                     # what the previous session left
felt history <id> --mechanical                 # + add/edit/rm/external_edit
felt history append <id> --summary "..."       # log session continuity
```

### Progressive Disclosure

```bash
felt show <id>                    # full body + metadata
felt show <id> -d name            # name + tags only
felt show <id> -d compact         # metadata + outcome + frontmatter counts
felt show <id> -d summary         # compact + citations/consumers + lede + frontmatter summary
felt show <id> --body             # body + body start line for editing
felt show <id> --citations        # indexed narrative back-references only
felt show <id> --consumers        # indexed reverse data-flow consumers only
felt show <id> --decision cov     # one structured decision as YAML/JSON
felt show <id> --inputs           # structured inputs only
```

## Obsidian

A `.felt/` directory is a valid Obsidian vault. Open it in Obsidian for a GUI browser with backlinks, graph view, and full-text search; felt's `[[wikilinks]]` are the Obsidian format. Structured frontmatter fields (`decisions`, `inputs`, `outputs`, `insights`, `tempered`) are queryable with [Dataview](https://github.com/blacksmithgu/obsidian-dataview):

```dataview
TABLE status, outcome
FROM "."
WHERE tempered = true
```

Integration is rudimentary today and aspirational to improve. The basics work: the vault opens, wikilinks click through, frontmatter renders, and Dataview queries run over the structured fields. Known rough edges: fragment wikilinks to nested elements (`[[slug#decision-name]]`) do not resolve because Obsidian expects headings, and the per-fiber directory nesting (`slug/slug.md`) means browsing is two clicks per fiber unless you install a Folder Note plugin.

Obsidian is not a dependency. The CLI and the `.felt/` tree are the source of truth; use them separately or together.

## Agent Integration

`felt setup claude` registers the felt plugin marketplace from GitHub and installs the `felt` plugin via Claude Code's CLI:

```
claude plugin marketplace add cailmdaley/felt#v<version>
claude plugin install felt@cailmdaley-felt
```

Tagged felt binaries pin to their matching git tag; `dev` builds track the default branch. Claude Code clones the marketplace to `~/.claude/plugins/marketplaces/cailmdaley-felt/`, so no local checkout of felt is required. Pass `--source <path>` for development against an unreleased checkout.

The plugin bundles two skills (`felt`, `ralph`), SessionStart/PreToolUse hooks, and a launcher script for ralph loops.

For Codex (no plugin manifest support), `felt setup codex` symlinks the same skills into `~/.agents/skills/` and configures Codex's `hooks.json` to invoke the same hook scripts the plugin uses. It reuses Claude Code's marketplace clone, so running `felt setup claude` first means `setup codex` works without `--source`.

Skills can also be linked into other locations independently:

```bash
felt setup skills                                # links felt and ralph to ~/.claude/skills
felt setup skills --target ~/.agents/skills      # link skills elsewhere
felt setup skills --source <path>                # use a specific plugin directory as source
```

### Bundled Skills

| Skill | Purpose |
|-------|---------|
| **felt** | Filing fibers — formalizing as you work, crafting decisions and constitutions, mining at session end, maintenance passes, transcript processing |
| **ralph** | Executing autonomous iteration loops over a constitution — launch script + in-loop protocol |

### Hooks

| Hook | Behavior |
|------|----------|
| **SessionStart** | Prints an "activate the felt skill first" directive plus active and recently touched fibers from the project's `.felt/` |
| **PreToolUse** | Gates the first non-Skill tool call until the felt skill has been activated (so the agent loads the practice — philosophy, references — not just the cheatsheet). Sibling skill activation (shuttle, ralph) doesn't satisfy the gate; only `felt` does. Codex sessions are exempt. |

## Commands

```bash
# Core
felt init                         felt add <slug> <name> [flags]
felt edit <id> [flags]            felt show <id> [-d level]
felt ls [query]                   felt check
felt history <id>                 felt history append <id> --summary "..."
felt tree                         felt nest|unnest <id>
felt migrate [--dry-run]          felt rm <id>
felt setup claude|codex|skills    felt update
```

### Flags

```bash
# felt add
-b, --body "text"                 -s, --status open|active|closed
-t, --tag <tag>                   -D, --due 2024-03-15
-o, --outcome "text"

# felt edit
--name "text"                     --tag <tag>
--untag <tag>                     --body "text"
--outcome "text"
--decision <id> --label "text"    --rationale "text"
--default <option-id>             --option 'id:label[:excluded[:reason]]'
--input 'id[:type[:from[:description]]]'
--insight 'id:claim'

# felt ls
--body
-e, --exact                       -r, --regex

# felt history
--last <N>                        --kind <type>
--mechanical                      --json

# global
-j, --json
```

## Inspirations

Felt borrows from several projects exploring how to give AI coding agents structured, persistent context:

- **[Zettelkasten](https://en.wikipedia.org/wiki/Zettelkasten)** — Niklas Luhmann's slip-box method, the ancestor of modern linked-note knowledge management. Emergent structure from connections rather than prescribed hierarchy. Felt's combination of directory containment, `[[wikilinks]]`, and ASTRA data-flow comes from this lineage, with Obsidian as the practical modern embodiment the vault format mirrors.
- **[Beads](https://github.com/steveyegge/beads)** — Steve Yegge's graph-based, git-backed issue tracker designed as agent memory. The core conviction — that coding agents need structured persistent memory they can query, not just scratch files — is load-bearing for felt. Beads leans on Go, SQLite, and JSONL; felt leans on plain markdown with a rebuildable cache.
- **[Dots](https://github.com/joelreymont/dots)** — Joel Reymont's minimalist counterpart to Beads (200 KB of Zig, plain markdown in `.dots/`, no database). The "the directory tree is already the source of truth" stance runs through felt too — the SQLite cache at `.felt/index.db` is strictly a rebuildable index, not storage.
- **[Ralph Wiggum](https://github.com/ghuntley/how-to-ralph-wiggum)** — Geoffrey Huntley's autonomous iteration technique: feed the agent the same spec on a loop until the work is done. Felt's `ralph` skill, the `constitute` activity, and the `constitute.md` reference (pointers not snapshots, desired state, living document) all come from this idea.
- **[Ouroboros](https://github.com/Q00/ouroboros)** — Q00's specification-first AI coding workflow. The Double Diamond rhythm (Wonder → Ontology, Design → Delivery), the stance personas, and the qualitative ambiguity self-check in the `crafting.md` reference are adapted from Ouroboros's interview phase — with the numerical ambiguity scoring, immutable seed specs, and ontology-convergence stopping criterion explicitly rejected as the wrong shape for scientific work.

## License

[MIT](LICENSE)
