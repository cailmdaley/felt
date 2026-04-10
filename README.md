<p align="center">
  <img src=".github/banner.png" alt="felt" width="600">
</p>

<p align="center">
  <a href="https://github.com/cailmdaley/felt/actions/workflows/ci.yml"><img src="https://github.com/cailmdaley/felt/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

# felt

Directory-contained markdown fibers with YAML frontmatter, wikilinks, and optional ASTRA structure. A lightweight CLI for accumulating context — decisions, claims, tasks, questions, specs — and keeping it searchable and connected.

Fibers are the unit. Each one lives in its own directory under `.felt/`, with a `<slug>.md` file carrying YAML frontmatter plus plain markdown body content. Containment comes from the directory tree, narrative connections come from `[[wikilinks]]` in the body, and ASTRA inputs/outputs/decisions/insights can accrete in frontmatter as the work crystallizes. Closing a fiber with an outcome captures what was learned.

The source of truth is still the markdown tree in `.felt/`. Felt maintains a local SQLite cache at `.felt/index.db` for typed links, citations, tags, and FTS5 body search, but the cache is rebuildable from the files and carries no extra authoring burden. The format is plain markdown with YAML frontmatter and `[[wikilinks]]`, so a `.felt/` directory also opens as a valid Obsidian vault (see [Obsidian](#obsidian)).

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

Felt ships with hooks and skills for [Claude Code](https://claude.ai/claude-code) and [Codex](https://openai.com/index/codex/):

```bash
felt setup claude                 # hooks + skills for Claude Code
felt setup codex                  # shell wrapper + skills for Codex
```

The session hook prints active and recently touched fibers at the start of each conversation, giving the agent context about ongoing work. See [Agent Integration](#agent-integration) for details.

## Quick Start

```bash
felt init                                              # creates .felt/ support files
felt use-des-y3-weights "Use DES Y3 weights"           # file a decision
felt add covariance-estimation "Covariance estimation"
felt edit covariance-estimation -s closed -o "switched to jackknife — 10x faster, <2% bias"
felt export --format astra                             # emit astra.yaml from ASTRA frontmatter
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

Containment comes from the directory tree. Narrative connections live in `[[wikilinks]]` inside the body. ASTRA `inputs.from` references express data flow when a fiber becomes computationally formalized. Felt indexes both edge types in SQLite, so `felt show` can surface narrative back-references and reverse data-flow consumers, while `felt ls --body` uses FTS instead of hydrating every body file.

```bash
felt tree                               # containment hierarchy
felt show covariance-estimation         # body refs + citations + reverse consumers + ASTRA summary
felt ls "DES Y3"                        # search names, outcomes, ASTRA fields
felt ls --body "jackknife patches"      # FTS5 body search
```

### ASTRA Frontmatter

Fibers can carry optional ASTRA-compatible frontmatter alongside felt's native fields. Those fields are searchable through `felt ls` and exportable with `felt export --format astra`.

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
felt ls "BAO"                 # name, outcome, and ASTRA fields
felt check                    # broken refs/fragments, legacy format residue, ASTRA lint, formalization drift
felt export --format astra    # writes ./astra.yaml
```

### Progressive Disclosure

```bash
felt show <id>                    # full body + metadata
felt show <id> -d name            # name + tags only
felt show <id> -d compact         # metadata + outcome + ASTRA counts
felt show <id> -d summary         # compact + citations/consumers + lede + ASTRA summary
felt show <id> --body             # body + body start line for editing
felt show <id> --citations        # indexed narrative back-references only
felt show <id> --consumers        # indexed reverse data-flow consumers only
felt show <id> --decision cov     # one ASTRA decision as YAML/JSON
felt show <id> --inputs           # ASTRA inputs only
```

## Obsidian

A `.felt/` directory is a valid Obsidian vault. Open it in Obsidian for a GUI browser with backlinks, graph view, and full-text search; felt's `[[wikilinks]]` are the Obsidian format. ASTRA fields in YAML frontmatter (`decisions`, `inputs`, `outputs`, `insights`, `tempered`) are queryable with [Dataview](https://github.com/blacksmithgu/obsidian-dataview):

```dataview
TABLE status, outcome
FROM "."
WHERE tempered = true
```

Integration is rudimentary today and aspirational to improve. The basics work: the vault opens, wikilinks click through, frontmatter renders, and Dataview queries run over ASTRA fields. Known rough edges: fragment wikilinks to ASTRA elements (`[[slug#decision-name]]`) do not resolve because Obsidian expects headings, and the per-fiber directory nesting (`slug/slug.md`) means browsing is two clicks per fiber unless you install a Folder Note plugin.

Obsidian is not a dependency. The CLI and the `.felt/` tree are the source of truth; use them separately or together.

## Tapestry

Fibers tagged with `tapestry:<specName>` become nodes in a visual DAG that can be exported as a static site. Attaching evidence (metrics, figures) lets the viewer show what's fresh, stale, or missing.

```bash
# Create tapestry nodes
felt add bmodes "B-modes consistent with noise" -t tapestry:bmodes
felt add covariance "Covariance matrix" -t tapestry:covariance
felt show bmodes --body
# then edit .felt/bmodes/bmodes.md to add [[covariance]] in the body

# Evidence: results/tapestry/{specName}/evidence.json
# Written by your pipeline (e.g., Snakemake), not by hand
```

Evidence format:

```json
{
  "evidence": { "pte": 0.29, "chi2": 12.3, "dof": 10 },
  "output": { "figure": "bmodes.png" },
  "generated": "2026-01-15T00:09:04Z"
}
```

Export the DAG as a static site:

```bash
felt export --format tapestry                  # → ~/.felt/tapestries/data/{project}/
felt export --format tapestry --all-fibers     # include sidebar with all fibers
felt export --format tapestry --force          # re-copy all artifacts
```

Output goes to a clone of a [tapestry template repo](https://github.com/cailmdaley/tapestries) — a static viewer served via GitHub Pages. Each project writes its own `data/{name}/tapestry.json` + artifact images. The viewer is shared.

Staleness is computed automatically: if an upstream dependency's evidence is newer than yours, the node is marked stale.

## Agent Integration

Skills can also be managed independently:

```bash
felt setup skills                                # install skills to ~/.claude/skills
felt setup skills --target ~/.agents/skills      # install skills for Codex
felt setup skills --update                       # update skills (overwrites local changes)
felt setup skills --link <path>                  # symlink to source checkout (dev mode)
felt update                                      # update felt and refresh copied bundled skills
```

### Bundled Skills

| Skill | Purpose |
|-------|---------|
| **felt** | Filing fibers from conversation — session extraction, transcript processing, archiving |
| **constitution** | Drafting specs for autonomous iteration loops |
| **ralph** | Executing those loops — survey, contribute, exit |

## Commands

```bash
# Core
felt init                         felt add <slug> <name> [flags]
felt edit <id> [flags]            felt show <id> [-d level]
felt ls [query]                   felt check
felt migrate [--dry-run]          felt export [flags]
felt rm <id>
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

# felt export
-f, --format tapestry|astra       --out <path>

# global
-j, --json
```

## License

[MIT](LICENSE)
