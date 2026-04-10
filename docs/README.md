# felt

DAG-native fiber tracker. Directory-based markdown fibers with dependencies.

## Why

Fibers have dependencies. Most trackers ignore this or bolt it on. Felt makes the DAG the center: `felt ls --ready` shows what's actually unblocked, and the graph is always traversable.

Fibers are markdown files. Human-readable, version-controllable, greppable. No database, no sync, no lock-in.

## Install

```bash
go install github.com/cailmdaley/felt@latest
```

## Quick Start

```bash
felt init                                        # creates .felt/
felt "Design API"                                # create a fiber
felt add "Implement endpoint" -a design-api      # depends on design
felt ls --ready                                  # shows "Design API" (unblocked)
felt edit design-api -s active                   # mark active
felt edit design-api -s closed -o "REST, uses JWT"
felt ls --ready                                  # now shows "Implement endpoint"
```

## Core Concepts

### The DAG

Every fiber can depend on others via `-a`/`--depends-on`. This forms a directed acyclic graph (cycles are rejected). The DAG answers:

- `felt ls --ready` — what's unblocked and open?
- `felt tree <id> --up` — what does this depend on?
- `felt tree <id> --down` — what depends on this?
- `felt tree --check` — is the graph valid?

### Status (opt-in)

Status tracking is optional. `felt "title"` creates a statusless fiber. Add `-s open` to enter tracking.

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
| `title` | Title + tags |
| `compact` | Metadata + outcome + ASTRA counts |
| `summary` | Compact + lede paragraph + concise ASTRA summary |
| `full` | Everything (default) |

```bash
felt show <id> -d compact      # "what was decided?"
felt show <id> --body          # body + start line for editing
felt show <id> --decisions     # ASTRA decisions only
```

### Tags

Tags organize fibers across the graph:

```bash
felt "[pure-eb] Fix covariance bug"     # extracted from title
felt add "Fix bug" -t pure-eb -t urgent # via flag
felt edit design-api --tag backend      # add to existing
felt edit design-api --untag backend    # remove
felt ls -t pure-eb                      # filter (AND logic)
felt ls --ready -t pure-eb              # filter ready
```

### File Format

Fibers live in `.felt/<path>/<slug>.md`:

```yaml
---
title: "Design API"
status: closed
tags: [backend, auth]
depends-on:
  - id: research-auth-patterns
    label: auth approach
created-at: 2024-01-15T10:30:00Z
closed-at: 2024-01-16T14:20:00Z
outcome: "REST with JWT. See docs/api.md"
---

(design-api)=
# Design API

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
felt add <title>                  # create fiber
felt <title>                      # shorthand for add
felt edit <id> -s active          # enter tracking / mark active
felt edit <id> -s closed -o "outcome"
felt rm <id>                      # delete (fails if dependents exist)
```

### Viewing

```bash
felt ls                           # tracked fibers (open/active)
felt ls -s all                    # all fibers including untracked
felt ls -s closed                 # by status
felt ls -t backend -t urgent      # by tags (AND)
felt ls -s all -t rule:           # tag prefix matching
felt ls -s all "query"            # search title, outcome, ASTRA fields
felt ls -s all -r "pattern"       # regex search
felt ls --ready                   # open with all deps closed
felt show <id>                    # full details
felt show <id> -d compact         # structured overview
felt tree                         # dependency tree from roots
```

### Editing

```bash
felt edit <id> --body "text"      # replace full body (destructive overwrite)
felt edit <id> --title "new"      # set title
felt edit <id> -s active          # set status
felt edit <id> -o "outcome"       # set outcome
felt edit <id> --comment "note"   # append timestamped comment section entry
felt edit <id> --tag <tag>        # add tag
felt edit <id> --untag <tag>      # remove tag
felt edit <id> --link <dep-id>    # add dependency
felt edit <id> --link <dep-id> -l "why"
felt edit <id> --unlink <dep-id>  # remove dependency
```

### Tree

```bash
felt tree <id> --up              # direct dependencies
felt tree <id> --up --all        # transitive dependencies
felt tree <id> -d compact --up   # with detail per item
felt tree <id> --down            # what depends on this
felt tree -f mermaid             # visualize (mermaid/dot/text)
felt tree --check                # validate integrity
```

### Integration

```bash
felt hook session                 # context for session start hooks
felt export --format tapestry     # viewer payload
felt export --format astra        # ASTRA YAML export surface
```

### Add Flags

```bash
-b, --body "text"                 # body text
-s, --status open                 # status (open, active, closed)
-a, --depends-on <id>             # dependency (repeatable)
-D, --due 2024-03-15              # due date
-t, --tag <tag>                   # tag (repeatable)
-o, --outcome "text"              # outcome
```

### Global Flags

```bash
-j, --json                        # JSON output
```
