# felt

DAG-native task tracker. Markdown files with dependencies.

## Why

Tasks have dependencies. Most trackers ignore this or bolt it on. Felt makes the DAG the center: `ready` shows what's actually unblocked, and the graph is always traversable.

Felts are markdown files. Human-readable, version-controllable, greppable. No database, no sync, no lock-in.

## Install

```bash
go install github.com/cailmdaley/felt@latest
```

## Quick Start

```bash
felt init                          # creates .felt/
felt "Design API"                  # shorthand for felt add
felt add "Implement endpoint" -a design-api   # depends on design
felt ready                         # shows "Design API" (unblocked)
felt on design-api                 # mark active
felt off design-api -r "REST, uses JWT"   # close with outcome
felt ready                         # now shows "Implement endpoint"
```

## Core Concepts

### The DAG

Every felt can depend on others via `-a`/`--depends-on`. This forms a directed acyclic graph (cycles are rejected). The DAG answers:

- `felt ready` — what's unblocked and open?
- `felt upstream <id>` — what does this depend on (transitively)?
- `felt downstream <id>` — what depends on this?
- `felt path <from> <to>` — how are two felts connected?

### States

```
○ open    — not started, waiting
◐ active  — currently being worked on
● closed  — done, with reason captured
```

Transition with `felt on <id>` and `felt off <id> -r "reason"`.

### Closure as Documentation

The `-r` flag on close captures *what was learned, decided, or produced*. Closed felts become searchable project memory:

```bash
felt ls --status closed    # what's been done
felt find "JWT"            # search all felts
```

**Reopening.** If circumstances change: `felt on <id>`. This clears the close reason and timestamp.

### Tags

Tags organize felts across the graph. Add them inline or explicitly:

```bash
felt "[pure-eb] Fix covariance bug"     # extracted from title
felt add "Fix bug" -t pure-eb -t urgent # via flag
felt tag design-api backend             # add to existing
felt untag design-api backend           # remove
felt ls -t pure-eb                      # filter (AND logic)
felt ready -t pure-eb                   # filter ready
```

Bracketed tags at the start of titles (`[tag]`) are automatically extracted into the tags field. For existing felts, use `felt migrate-tags` to extract bracketed tags from titles (use `--dry-run` to preview).

### File Format

Felts live in `.felt/<id>.md`:

```yaml
---
title: "Design API"
status: closed
kind: decision
tags: [backend, auth]
priority: 2
depends-on:
  - research-auth-patterns-a1b2c3d4
created-at: 2024-01-15T10:30:00Z
closed-at: 2024-01-16T14:20:00Z
close-reason: "REST with JWT. See docs/api.md"
---

Optional body with notes, context, etc.
```

IDs are `<slug>-<8-hex-chars>`. Commands accept fuzzy matching:

```bash
felt show design-api-ac6b19c1    # full ID
felt show design-api              # prefix match
felt show ac6b19c1                # hex suffix only
felt show ac6b                    # even shorter
```

## Command Reference

### Lifecycle

```bash
felt init                         # create .felt/
felt add <title>                  # create felt
felt <title>                      # shorthand for add (no flags)
felt on <id>                      # mark active (reopens if closed)
felt off <id> -r "reason"         # close with documentation
felt rm <id>                      # delete (fails if other felts depend on it)
```

### Viewing

```bash
felt ls                           # all felts
felt ls -s open                   # by status (open/active/closed)
felt ls -k spec                   # by kind
felt ls -t backend -t urgent      # by tags (AND)
felt ready                        # open with all deps closed
felt ready -t pure-eb             # filter ready by tag
felt show <id>                    # full details
felt tree                         # dependency tree
felt tree <id>                    # subtree from specific felt
felt find <query>                 # search title, body, close reason
```

### Editing

```bash
felt edit <id>                    # open in $EDITOR
felt comment <id> "note"          # add timestamped comment
felt tag <id> <tag>               # add tag
felt untag <id> <tag>             # remove tag
felt link <id> <dep-id>           # add dependency
felt unlink <id> <dep-id>         # remove dependency
felt migrate-tags                 # extract [tags] from titles
felt migrate-tags --dry-run       # preview without changes
```

### Graph

```bash
felt upstream <id>                # transitive dependencies
felt downstream <id>              # what depends on this
felt path <from> <to>             # path between felts
felt graph -f mermaid             # visualize (mermaid/dot/text)
felt check                        # validate integrity
```

### Integration

```bash
felt hook session                 # compact context for session start
felt prime                        # full context for session recovery
```

### Add Flags

```bash
-b, --body "text"                 # body text
-k, --kind spec                   # kind (task, spec, decision, etc.)
-p, --priority 1                  # 0-4, lower = more urgent
-a, --depends-on <id>             # dependency (repeatable)
-D, --due 2024-03-15              # due date
-t, --tag <tag>                   # tag (repeatable)
-r, --reason "text"               # close reason (creates fiber already closed)
```

### Global Flags

```bash
-j, --json                        # JSON output
```

## Further Reading

- [Graph Operations](graph.md) — traversal, visualization, integrity
- [Workflows](workflows.md) — patterns, Claude Code integration
