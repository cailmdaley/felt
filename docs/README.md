# felt

Directory-contained markdown fibers with YAML frontmatter, wikilinks, and optional structured frontmatter.

## Why

Fibers are markdown files. Human-readable, version-controllable, greppable. The markdown tree is the source of truth; felt also keeps a rebuildable SQLite cache at `.felt/index.db` for typed links, citations, and FTS5 body search.

Containment comes from the directory tree, narrative connections come from `[[wikilinks]]` in the body, and `inputs.from` carries computational provenance when needed.

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
- Data flow via `inputs.from`
- Indexed citations, reverse data-flow consumers, and FTS5 body search via `.felt/index.db`

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
| `compact` | Metadata + outcome + frontmatter counts |
| `summary` | Compact + citations/consumers + lede paragraph + concise frontmatter summary |
| `full` | Everything (default) |

```bash
felt show <id> -d compact      # "what was decided?"
felt show <id> --body          # body + start line for editing
felt show <id> --citations     # indexed narrative back-references
felt show <id> --consumers     # indexed reverse data-flow consumers
felt show <id> --decisions     # decisions slice
felt ls --body "jwt refresh"   # FTS5 body search
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
name: "Design API"
status: closed
tags: [backend, auth]
created-at: 2024-01-15T10:30:00Z
closed-at: 2024-01-16T14:20:00Z
outcome: "REST with JWT. See docs/api.md"
---

Optional body with notes, context, etc.
```

IDs are slug paths. Commands accept unique slug or path matching:

```bash
felt show design-api       # unique slug
felt show auth/design-api  # nested path
felt show api              # unique prefix
```

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
felt ls -s all "query"            # search name, outcome, frontmatter fields
felt ls -s all -r "pattern"       # regex search
felt show <id>                    # full details
felt show <id> -d compact         # structured overview
felt check                        # repository-wide integrity lint
```

### Editing

```bash
felt edit <id> --body "text"      # replace full body (destructive overwrite)
felt edit <id> --name "new"       # set name
felt edit <id> -s active          # set status
felt edit <id> -o "outcome"       # set outcome
felt edit <id> --tag <tag>        # add tag
felt edit <id> --untag <tag>      # remove tag
felt edit <id> --decision cov --label "Covariance" --option 'glass:GLASS mocks'
felt edit <id> --input 'catalog:data:upstream.posterior'
felt edit <id> --insight 'stable:Posterior is stable'
```

### Maintenance

```bash
felt check                        # broken refs/fragments, legacy format residue, frontmatter lint, depth consistency
felt migrate --dry-run            # preview legacy storage migration
```

### Global Flags

```bash
-j, --json                        # JSON output
```
