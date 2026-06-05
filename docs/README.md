# felt

Directory-contained markdown fibers with YAML frontmatter, wikilinks, and opaque extra frontmatter.

## Why

Fibers are markdown files. Human-readable, version-controllable, greppable. The markdown tree is the source of truth; felt also keeps a rebuildable SQLite cache at `.felt/index.db` for typed links, citations, reverse data-flow consumers, history lookups, and rebuildable search rows.

Containment comes from the directory tree, narrative connections come from `[[wikilinks]]` in the body, and projects may use conventions like `inputs.from` when they want data-flow edges. felt preserves non-native frontmatter opaquely instead of owning its schema.

## Install

```bash
go install github.com/cailmdaley/felt@latest
```

## Quick Start

```bash
felt init
felt add design-api "Design API"
felt add auth/research-patterns "Research auth patterns"
felt edit design-api -s active
felt edit design-api -s closed -o "REST with JWT; see [[auth/research-patterns]]"
felt tree
felt ls "JWT"
```

## Core Concepts

### Relationships

Felt uses three relationship mechanisms:

- Containment via directory nesting
- Narrative references via `[[wikilinks]]`
- Optional data flow via conventions like `inputs.from`
- Citations, reverse consumers, and body search derived from markdown, with `.felt/index.db` used as a rebuildable cache where appropriate

### Status (opt-in)

Status tracking is optional. `felt add <slug> <name>` creates a statusless fiber. Add `-s open` to enter tracking.

```
· untracked — no status, just a fiber
○ open      — tracked, not started
◐ active    — currently being worked on
● closed    — done, with outcome captured
```

Transition with `felt edit <id> -s active` and `felt edit <id> -s closed -o "outcome"`.

### Outcome as Documentation

The `-o` flag captures what was learned, decided, or produced. Closed fibers become searchable project memory:

```bash
felt ls -s closed             # what's been done
felt ls -s all "JWT"          # search all fibers
felt show <id> -d compact     # see outcome without full body
```

### Progressive Disclosure

`felt show` supports detail levels via `--detail` / `-d`:

| Level | What you see |
|---|---|
| `name` | Name + tags |
| `compact` | Metadata + outcome + additional YAML field keys |
| `summary` | Compact + citations/consumers + lede paragraph |
| `full` | Everything (default), including raw additional YAML fields |

```bash
felt show <id> -d compact      # quick skim
felt show <id> --body          # body + start line for editing
felt show <id> --citations     # narrative back-references
felt show <id> --consumers     # reverse data-flow consumers
felt show <id> --field inputs  # one raw frontmatter field as YAML/text
felt ls --body "jwt refresh"   # body search
felt session                   # agent session context as readable text
```

### Tags

Tags organize fibers across the tree:

```bash
felt add fix-bug "Fix bug" -t pure-eb -t urgent
felt edit design-api --tag backend      # add to existing
felt edit design-api --untag backend    # remove
felt ls -t pure-eb                      # filter (AND logic)
```

For backward compatibility, felt also extracts `[tag]` prefixes from the slug argument:

```bash
felt add "[pure-eb] fix-covariance-bug" "Fix covariance bug"
```

### File Format

Fibers live in `.felt/<path>/<slug>.md`:

```yaml
---
id: 01KTC9C1G1CBJ84H6WB92J8A13
name: "Design API"
status: closed
tags: [backend, auth]
created-at: 2024-01-15T10:30:00Z
closed-at: 2024-01-16T14:20:00Z
outcome: "REST with JWT. See docs/api.md"
---

Optional body with notes, context, etc.
```

The filesystem slug path is the CLI address. The frontmatter `id` is an intrinsic ULID minted at creation and surfaced as `uid` in JSON so existing slug-based `id` consumers keep working.

Any other top-level YAML keys are preserved exactly enough for downstream tools to own their schema.

## Command Reference

### Creating & Closing

```bash
felt init                         # create .felt/
felt add <slug> <name>            # create fiber
felt edit <id> -s active          # enter tracking / mark active
felt edit <id> -s closed -o "outcome"
felt rm <id>                      # delete
```

### Viewing

```bash
felt ls                           # tracked fibers (open/active)
felt ls -s all                    # all fibers including untracked
felt ls -s closed                 # by status
felt ls -t backend -t urgent      # by tags (AND)
felt ls -s all -t rule:           # tag prefix matching
felt ls -s all "query"            # search name, outcome, frontmatter text
felt ls -s all -r "pattern"       # regex search
felt show <id>                    # full details
felt show <id> -d compact         # quick overview
felt show <id> --field shuttle    # one raw frontmatter field
felt check                        # repository-wide substrate lint
```

### Editing

```bash
felt edit <id> --body "text"      # replace full body (destructive overwrite)
felt edit <id> --name "new"       # set name
felt edit <id> -s active          # set status
felt edit <id> -o "outcome"       # set outcome
felt edit <id> --tag <tag>        # add tag
felt edit <id> --untag <tag>      # remove tag
# for non-native frontmatter: edit the markdown file directly
```

### Maintenance

```bash
felt check                        # broken refs/fragments, legacy format residue, layout issues
felt index sync                   # refresh the rebuildable SQLite cache
felt migrate --dry-run            # preview legacy storage migration
```

### Global Flags

```bash
-j, --json                        # JSON output
```
