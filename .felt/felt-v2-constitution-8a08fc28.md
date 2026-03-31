---
title: felt v2 constitution
status: open
tags:
    - constitution
    - felt
    - astra
created-at: 2026-04-01T00:41:11.77547+02:00
---

# felt v2: Directory Fibers, MyST, ASTRA-Compatible

felt shifts from flat files to directory-based fibers, from hex IDs to slugs, from 22 commands to ~10, from plain markdown to MyST-flavored, and from felt-only fields to ASTRA-compatible frontmatter. felt stays felt — one implementation of the ASTRA format.

## Desired State

### Fiber storage

Every fiber is a directory containing `<slug>.md` plus optional artifacts:

```
.felt/
├── myst.yml
├── bao-analysis/
│   ├── bao-analysis.md
│   ├── damping-prior/
│   │   ├── damping-prior.md
│   │   └── contour_plot.png
│   └── broadband-model/
│       ├── broadband-model.md
│       └── pk_comparison.png
├── quick-gotcha/
│   └── quick-gotcha.md
└── some-decision/
    └── some-decision.md
```

Directories nest — a sub-analysis is a subdirectory. The filesystem mirrors the analysis tree.

### IDs

Slugs only. `bao-analysis`, `damping-prior`, `quick-gotcha`. No hex suffix. `slugify(title)` — lowercase, non-alphanum → hyphens, truncated at word boundary. Collision → append `-2`, `-3`. Filesystem enforces uniqueness.

Nested fibers addressed by path: `bao-analysis/damping-prior`. Bare slug resolves if globally unique across the tree.

**Evidence:** `grep -r 'GenerateID' internal/felt/` should show slug-only generation, no `crypto/rand` hex.

### Frontmatter

The fiber file carries both felt fields AND optional ASTRA fields. Frontmatter is the source of truth — `felt export --format astra` generates `astra.yaml` from the fiber tree. ASTRA fields are optional; a fiber with just `title` is valid. Fields accrete as understanding crystallizes.

**Minimal fiber:**

```yaml
---
title: Quick gotcha about SSH
outcome: Always single-quote remote commands.
---
```

**Full ASTRA fiber:**

```yaml
---
title: BAO Damping Prior
status: closed
tags: [tier-1]
depends-on:
  - broadband-model
  - id: fitting-range
    label: "range affects prior sensitivity"
created-at: 2026-03-15T10:00:00Z
closed-at: 2026-03-20T14:30:00Z
outcome: Informative Gaussian priors confirmed.

# ASTRA fields (optional, self-similar with astra.yaml schema)
description: "Prior on BAO damping parameters"
inputs:
  - id: clustering_data
    type: data
    from: parent.desi_dr1_vac
outputs:
  - id: damped_pk
    type: data
    recipe:
      command: "python fit_damping.py"
      resources: {cpus: 4, memory: "16GB"}
decisions:
  damping_prior:
    label: BAO Damping Prior
    rationale: "Without informative priors, broadband projection creates spurious minima"
    default: gaussian
    options:
      gaussian:
        label: Informative Gaussian
      flat:
        label: Flat uniform
        excluded: true
        excluded_reason: "Shifts <0.3σ"
insights:
  damping_physical:
    claim: "BAO damping caused by pairwise displacements of ~10 Mpc"
    created_at: 2026-03-16T09:00:00Z
    evidence:
      - id: ev1
        doi: "10.48550/arXiv.astro-ph/0604361"
        quote:
          type: TextQuoteSelector
          exact: "velocity flows move matter ~10 Mpc"
success_criteria:
  - claim: "BAO parameters shift <0.5σ from DESI 2024 III"
container: "python:3.11-slim"
---
```

**Why frontmatter as source of truth:** agents see structure and narrative in one place. Formalization happens alongside exploration, not in a separate step. Opening a fiber to edit the body forces consideration of the formal structure.

**ASTRA field reference** (all optional, spec-compatible):

| Field | Type | Purpose |
|-------|------|---------|
| `description` | string | Detailed analysis description |
| `inputs` | array | Data sources: `{id, type: data\|analysis, from?, source?, checksum?}` |
| `outputs` | array | Products: `{id, type: metric\|figure\|table\|data\|report, recipe?}` |
| `decisions` | map | Choice points: `{label, rationale?, default?, options: {id: {label, excluded?, excluded_reason?}}}` |
| `insights` | map | Claims with evidence: `{claim, created_at, evidence: [{id, doi\|artifact, quote?}]}` |
| `success_criteria` | array | Pass/fail: `{claim, output?, condition?}` |
| `container` | string | Default container image |

**Evidence:** `grep -rn 'omitempty' internal/felt/felt.go` — all ASTRA fields should be `omitempty`. Fibers without ASTRA fields should marshal cleanly.

### Body format

MyST-flavored markdown. Body CAN use MyST directives (dropdowns, tab-sets, cross-refs, figures) but plain markdown is always valid.

Each body starts with `(<slug>)=` — a MyST cross-reference anchor. Any fiber can reference any other: `[](#damping-prior)`.

```markdown
(damping-prior)=
# BAO Damping Prior

*Prior on BAO damping parameters ($\Sigma_\parallel$, $\Sigma_\perp$).*

Body content here — MyST directives appear as understanding crystallizes.

:::{dropdown} Evidence
> "velocity flows move matter ~10 Mpc"
> --- arXiv:astro-ph/0604361, p. 7
:::
```

**Evidence:** `npx myst start` in `.felt/` renders a navigable site with working cross-references between fibers.

### MyST project

`felt init` generates `myst.yml` in `.felt/`:

```yaml
version: 1
project:
  title: Project Fibers
site:
  template: article-theme
```

### Commands (~10 core)

felt's command set consolidates from 22+ to ~10. Every standalone modifier command (tag, untag, link, unlink, comment) becomes a flag on `felt edit`. Every graph traversal command (upstream, downstream, graph, check) becomes a mode of `felt tree`. `felt export` replaces `felt tapestry export` and adds `--format astra`.

**Core:**

```
felt <title>                 # create (shorthand)
felt add <title> [flags]     # create with options
felt show <id>               # read
felt edit <id> [flags]       # modify (--tag, --untag, --link, --unlink, --comment, --status, --outcome, --body, --title)
felt ls [query]              # list/search (--tag, --status, --ready, --recent, --body)
felt rm <id>                 # delete
felt tree [id]               # DAG (--up, --down, --format mermaid|dot|text, --check)
felt init                    # initialize .felt/ + myst.yml
felt export [flags]          # export (--format tapestry|astra)
felt hook session            # agent context
```

**Structure:**

```
felt migrate [--dir] [--dry-run]    # flat → directory
felt nest <child> <parent>          # create sub-analysis
felt unnest <child>                 # promote to top level
```

**Meta:**

```
felt setup [claude|codex|skills]    # integrations
felt update                         # self-update
```

**Removed commands and their replacements:**

| Gone | Replacement |
|------|-------------|
| `felt tag` | `felt edit <id> --tag` |
| `felt untag` | `felt edit <id> --untag` |
| `felt link` | `felt edit <id> --link` |
| `felt unlink` | `felt edit <id> --unlink` |
| `felt comment` | `felt edit <id> --comment` |
| `felt find` | `felt ls -s all` |
| `felt ready` | `felt ls --ready` |
| `felt upstream` | `felt tree <id> --up` |
| `felt downstream` | `felt tree <id> --down` |
| `felt graph` | `felt tree [--format]` |
| `felt path` | dropped |
| `felt check` | `felt tree --check` |
| `felt prime` | `felt hook session` |
| `felt tapestry export` | `felt export` |

**Evidence:** `felt --help` should show ~10 commands, not 22+. `felt tag` should be an unknown command.

### ASTRA export

`felt export --format astra` walks the fiber directory tree. For each fiber with ASTRA frontmatter fields, emits the corresponding node in `astra.yaml`. Directory nesting → ASTRA nesting. Output is a valid ASTRA spec that `astra validate` and Prism can consume.

**Sub-analysis data flow references:**

```yaml
# In bao-analysis/damping-prior/damping-prior.md:
inputs:
  - id: data
    type: data
    from: parent.desi_dr1_vac       # parent's input

  - id: broadband
    type: analysis
    from: broadband-model.fitted_pk  # sibling's output
```

**Evidence:** `felt export --format astra` produces valid YAML that passes `astra validate`. Run `python -m astra validate astra.yaml` against the output.

### Migration

`felt migrate` converts flat files to directories. Big bang — no backwards compatibility.

1. Each `<slug>-<hex>.md` → `<slug>/<slug>.md`
2. All `depends-on` references rewritten from hex IDs to slugs
3. `myst.yml` generated
4. `(<slug>)=` anchor inserted in each body
5. Collisions get disambiguator (`-2`, `-3`)

Run on project `.felt/`. Global felt (`~/loom/.felt/`) migrated separately, later.

**Evidence:** after migration, `felt ls` shows all fibers. `felt tree --check` passes. No `*.md` flat files remain in `.felt/` (only directories). `find .felt -maxdepth 1 -name '*.md' -not -name 'myst.yml'` returns nothing.

## Context

**Codebase:** `~/Documents/projects/felt/` — Go CLI, cobra commands, ~3k LOC.

**Current branch state:** the repo's own `.felt/` is still flat-file and hex-suffixed. Once storage flips to directory-only reads, source-built `felt` in this repo will stop seeing local fibers until `felt migrate` lands or the repo is migrated. Treat that as an expected intermediate state, not a regression in the storage layer.

| File | Role |
|------|------|
| `internal/felt/felt.go` | `Felt` struct, `GenerateID()`, `Parse()`, `Marshal()` |
| `internal/felt/storage.go` | File I/O: `Read()`, `Save()`, `List()`, `FindMetadata()` |
| `internal/felt/graph.go` | `Graph` struct, `GetUpstream()`, `GetDownstream()`, `Ready()`, `DetectCycle()` |
| `internal/tapestry/astra.go` | `ReadASTRA()` — currently reads external `astra.yaml`, will also generate |
| `internal/tapestry/export.go` | Tapestry export logic |
| `cmd/*.go` | Command implementations |

**ASTRA schema:** `~/Documents/projects/ASTRA/spec/0.1/analysis.schema.json` — the formal spec felt must be compatible with.

**MyST:** Available via `npx myst`. Template: `article-theme`. DESI BAO example at `/tmp/desi-bao/`.

**Key patterns to preserve:**
- `felt <title>` shorthand (root command hijacking in `cmd/root.go`)
- Prefix matching for IDs (`felt show damp` → `damping-prior`)
- Depth levels for show (`-d title|compact|summary|full`)
- JSON output (`-j` global flag)
- Tag prefix matching (`-t rule:` matches `rule:*`)

### Tests

Tests are rewritten, not patched. Every `*_test.go` assumes flat files and hex IDs — these assumptions are gone. Test fixtures in `internal/felt/testdata/` use directory-based samples.

**Evidence:** `go test ./...` passes. `grep -r 'hex\|[a-f0-9]\{8\}' internal/felt/*_test.go` should find no hardcoded hex IDs in test logic (test data slugs are fine).

### Bundled skills

`cmd/skills/felt/SKILL.md`, `cmd/skills/constitution/`, and `cmd/skills/ralph/` reference old commands (`felt tag`, `felt upstream`, `felt comment`, etc.). These are updated to reflect the consolidated CLI. Agents read these skills at session start — stale command references break the loop.

**Evidence:** `grep -rn 'felt tag\|felt untag\|felt link\|felt unlink\|felt comment\|felt upstream\|felt downstream\|felt graph\|felt ready\|felt find\|felt prime\|felt check' cmd/skills/` returns no matches.

### JSON output includes ASTRA fields

`felt show -j` emits ASTRA fields when present. JSON output is the API surface for other tools (portolan server, tapestry viewer, scripts). All ASTRA struct fields are tagged `json:",omitempty"` — fibers without ASTRA fields produce the same JSON as before.

**Evidence:** `felt show -j <fiber-with-decisions>` includes `"decisions"` key. `felt show -j <simple-fiber>` omits it.

### Search spans ASTRA fields

`felt ls <query>` searches decision labels, insight claims, input/output descriptions — not just title, tags, and outcome. If a fiber has `decisions.damping_prior.label: "BAO Damping Prior"`, then `felt ls damping` finds it.

**Evidence:** `felt ls "BAO"` returns fibers with "BAO" in ASTRA decision labels, not just titles.

### ASTRA export filtering

`felt export --format astra` only includes fibers with at least one ASTRA field (inputs, outputs, decisions, insights, success_criteria). A gotcha fiber with just title+outcome has no place in `astra.yaml`. Non-ASTRA fibers are silently skipped.

**Evidence:** create a simple fiber (`felt add "test gotcha"`), run `felt export --format astra`, verify it's absent from the output.

## Iteration Discipline

**Commit after every iteration.** Codex needs a clean working tree. Each iteration ends with `git add` + `git commit` of all changes made.

**File what you learned.** At the end of every iteration, run `felt comment felt-v2-constitution-8a08fc28 "..."` with a brief summary of what was done, what was discovered, and what's next. This leaves a wake in the constitution fiber for the next iteration to read.

**Work directory:** `~/Documents/projects/felt/` — the Go codebase. The constitution fiber lives in portolan but the code lives in felt.

## Skills

Activate before working:
- `/snakemake` if touching workflow integration
- Check `astra validate` after modifying ASTRA field handling

## Resolved Questions

- **Flat file fallback?** No. Directories only, no exceptions. One invariant, one code path. The CLI handles creation; hand-creation requires `mkdir`. Read-only fallback adds if-branches to every storage function for a feature whose only purpose is handling files that shouldn't exist after migration.
- **Comments?** Keep in body (`## Comments` section). The crutch risk (agents appending comments instead of revising body) is behavioral, not structural — address via felt skill extraction patterns, not format constraints. Alternatives (separate file, drop entirely, child fibers) all have worse problems.
- **Global felt migration?** Separately, later. Not in scope for this constitution.
- **MyST TOC?** UI question. Defer.

## Open Questions

- **`myst.yml` generation:** Should `felt init` detect existing fibers and populate the TOC, or generate a minimal config and let MyST auto-discover?
- **Nested ID resolution:** When `damping-prior` exists both at top level and inside `bao-analysis/`, how does prefix matching work? Error on ambiguity, or prefer top-level?
- **ASTRA field validation:** Should `felt` validate ASTRA fields on write (reject bad schemas) or just store them and let `astra validate` catch errors?
