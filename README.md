<p align="center">
  <img src=".github/banner.png" alt="felt" width="600">
</p>

<p align="center">
  <a href="https://github.com/cailmdaley/felt/actions/workflows/ci.yml"><img src="https://github.com/cailmdaley/felt/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

# felt

Linked markdown fibers in a directed graph. A lightweight CLI for accumulating context — decisions, claims, tasks, questions, specs — and keeping it searchable, traversable, and connected.

Fibers are the unit. Each one lives in its own directory under `.felt/`, with a `<slug>.md` file carrying YAML frontmatter plus MyST-flavored markdown body content. Fibers can depend on each other, forming a DAG that you can walk: upstream to trace the reasoning behind a decision, downstream to follow its consequences into finer detail. Closing a fiber with an outcome captures what was learned. Over time, the graph becomes a persistent, navigable record of how a project arrived where it is.

There is no database or server — `.felt/` is a directory tree of markdown fibers that you can version-control, grep, and move between machines.

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

The session hook prints active and ready fibers at the start of each conversation, giving the agent context about ongoing work. See [Agent Integration](#agent-integration) for details.

## Quick Start

```bash
felt init                                              # creates .felt/ + myst.yml
felt "Use DES Y3 weights"                              # file a decision
felt add "Covariance estimation" -a use-des-y3-weights # depends on that decision
felt edit covariance-estimation --comment "tried analytic, too slow"
felt edit covariance-estimation -s closed -o "switched to jackknife — 10x faster, <2% bias"
```

A fiber can be anything: a task, a decision, a research claim, a question, a spec. The body carries detail and the outcome captures the conclusion. Dependencies connect them.

```bash
felt ls --ready                        # what's unblocked?
felt tree covariance-estimation --up   # what does this rest on?
felt tree use-des-y3-weights --down    # what follows from this?
felt ls -s all "jackknife"             # search across everything
```

## Fibers

A fiber is stored as `.felt/<path>/<slug>.md`. For example:

```yaml
---
title: Covariance estimation
status: closed
tags: [pure-eb, methods]
depends-on:
  - id: use-des-y3-weights
    label: weight choice
created-at: 2026-01-15T10:30:00Z
closed-at: 2026-01-16T14:20:00Z
outcome: "Jackknife covariance, 10x faster than analytic, <2% bias at all scales"
---

(covariance-estimation)=
# Covariance estimation

Tried analytic first — too slow for the number of bins we need.
Jackknife on 150 patches gives stable diagonal + off-diagonal.

## Comments
**2026-01-15 14:30** — tried analytic, too slow
**2026-01-16 09:15** — jackknife on 150 patches converges
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
felt "[pure-eb] Covariance estimation"    # extracted from title
felt add "Fix bug" -t pure-eb -t urgent   # via flag
felt edit covariance-estimation --tag note
felt ls -t pure-eb                        # filter by tag
felt ls -t tapestry:                      # prefix match
```

### The DAG

Dependencies form a directed acyclic graph. Cycles are rejected. Traversal, visualization, and integrity checks live under `felt tree`.

```bash
felt edit <id> --link <dep-id>          # add edge
felt edit <id> --link <dep-id> -l "why" # labeled edge
felt edit <id> --unlink <dep-id>        # remove edge
felt ls --ready                         # open fibers with all deps closed
felt tree <id> --up                     # direct dependencies
felt tree <id> --up --all               # transitive upstream
felt tree <id> --down                   # direct dependents
felt tree --format mermaid              # export whole graph (mermaid/dot/text)
felt tree --check                       # validate integrity
```

### Progressive Disclosure

```bash
felt show <id>                    # full body + metadata
felt show <id> -d compact         # metadata + outcome, no body
felt show <id> -d summary         # compact + lede paragraph
felt tree <id> --up -d compact    # outcome chain
```

## Tapestry

Fibers tagged with `tapestry:<specName>` become nodes in a visual DAG that can be exported as a static site. Attaching evidence (metrics, figures) lets the viewer show what's fresh, stale, or missing.

```bash
# Create tapestry nodes
felt add "B-modes consistent with noise" -t tapestry:bmodes
felt add "Covariance matrix" -t tapestry:covariance
felt edit bmodes --link covariance

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
felt setup skills                 # install skills only
felt setup skills --update        # update skills (overwrites local changes)
felt setup skills --link <path>   # symlink to source checkout (dev mode)
```

### Bundled Skills

| Skill | Purpose |
|-------|---------|
| **felt** | Filing fibers from conversation — session extraction, transcript processing, archiving |
| **tapestry** | Recording scientific work — when to file claims, evidence format, tapestry conventions |
| **constitution** | Drafting specs for autonomous iteration loops |
| **ralph** | Executing those loops — survey, contribute, exit |

## Commands

```bash
# Core
felt init                         felt add <title> [flags]
felt <title>                      felt show <id> [-d level]
felt edit <id> [flags]            felt ls [query]
felt rm <id>                      felt tree [id] [flags]
felt export [flags]               felt hook session
felt setup claude|codex|skills    felt update
```

### Flags

```bash
# felt add
-b, --body "text"                 -s, --status open|active|closed
-a, --depends-on <id>             -t, --tag <tag>
-D, --due 2024-03-15              -o, --outcome "text"

# felt edit
--tag <tag>                       --untag <tag>
--link <id>                       --unlink <id>
--comment "text"                  -l, --label "why"

# felt ls
--ready                           --body
-e, --exact                       -r, --regex

# felt tree
--up                              --down
--all                             --check
-f, --format text|mermaid|dot

# global
-j, --json
```

## License

[MIT](LICENSE)
