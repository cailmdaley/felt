---
title: '[loom] Build felt: DAG-native markdown task tracker in Go'
status: closed
created-at: 2026-01-12T21:31:10.696707+01:00
closed-at: 2026-01-12T22:58:21.448042+01:00
outcome: |-
    COMPLETE. Built felt: DAG-native markdown task tracker in Go. All completion criteria met:

    ✓ All commands: init, add, ls, show, on, off, rm, tree, graph, upstream, downstream, path, check, ready, edit, comment, link, unlink, find
    ✓ DAG traversal: correct bidirectional edges (upstream/downstream)
    ✓ Cycle detection: prevents invalid graphs via DetectCycle()
    ✓ Performance: ~93ms for 1000 felts (target was ~100ms)
    ✓ Single binary: Go with gopkg.in/yaml.v3 and spf13/cobra
    ✓ Mermaid visualization: with proper escaping

    14 iterations refined the implementation:
    - Ralph:1 — Core MVP (parsing, storage, graph, all commands)
    - Ralph:2-4 — Early fixes (tree indent, check cycles, title validation)
    - Ralph:5-6 — Output formats (text ASCII, JSON flag)
    - Ralph:7-10 — ID handling and tree fixes
    - Ralph:11-12 — Storage tests, hex suffix matching
    - Ralph:13-14 — Mermaid escaping, ready() excludes active

    45+ unit tests in internal/felt/ covering felt.go, graph.go, storage.go. All tests pass. Binary compiles cleanly.
---

(build-felt-dag-native-markdown)=
# Goal

Build `felt` — a DAG-native markdown task/spec tracker in Go. Successor to dots with first-class bidirectional dependency traversal.

## Why

- Current dots (Zig) is fast but hard to extend
- Need traversable directed dependency graph for research workflow and loom orchestration
- Go: fast enough (~100ms/1000 files), single binary, hackable
- One edge type, computed inverse — simple model, powerful queries

## Design Decisions

- **Command**: `felt`
- **Directory**: `.felt/`
- **Repo**: `~/code/felt`
- **Edge model**: Single `depends-on` field, compute inverse ("enables"/"downstream")
- **Hierarchy**: Flat files only — no folders, relationships via depends-on
- **Classification**: tags, not a dedicated kind field
- **ID format**: `{slug}-{8hex}` (no prefix)

## Data Model

### File Format
```markdown
---
title: "Implement covariance estimation"
status: open
tags:
  - task
depends-on:
  - design-api-a1b2c3d4
  - get-data-e5f6a7b8
created-at: 2026-01-12T21:30:00+01:00
---

Description as markdown body.

## Comments

**2026-01-12 21:45** — Started looking at this, need to check the data format first.

**2026-01-12 22:30** — Data format confirmed, proceeding with implementation.
```

### Fields
| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| title | yes | — | Short description |
| status | yes | open | open, active, closed |
| tags | no | [] | Free-form labels: task, spec, thread, note, etc |
| depends-on | no | [] | List of IDs this depends on |
| created-at | yes | now | ISO 8601 timestamp |
| closed-at | no | — | When closed |
| outcome | no | — | Why closed (the documentation) |
| due | no | — | Due date |

### ID Format
`{slug}-{8hex}` e.g. `impl-covariance-a1b2c3d4`

No prefix. Slug derived from title, truncated at word boundary, max 32 chars.

## Commands

### Lifecycle
```bash
felt init                     # Create .felt/
felt add "Title" [flags]      # Create new felt
felt "Title"                  # Shorthand for add
felt rm <id>                  # Delete
felt on <id>                  # Mark active
felt off <id> [-o "outcome"]  # Mark closed
```

### Add Flags
```bash
-d "description"    # Body text
-t <tag>            # Tag (task, spec, thread, etc)
-a <depends-on-id>  # Add dependency (repeatable)
```

### Reading
```bash
felt ls [--status S] [--tag T]   # List (filterable)
felt show <id>                   # Full details
felt find "query"                # Search
felt ready                       # Open with resolved deps
```

### Editing
```bash
felt edit <id>                # Open in $EDITOR
felt comment <id> "text"      # Append timestamped comment to body
felt link <id> <dep-id>       # Add depends-on
felt unlink <id> <dep-id>     # Remove depends-on
```

### DAG
```bash
felt upstream <id>            # What this depends on (transitive)
felt downstream <id>          # What depends on this (transitive)
felt graph [--format F]       # Visualize (mermaid/dot/text)
felt check                    # Integrity: cycles, dangling refs
felt path <from> <to>         # Dependency path between nodes
```

## Session Hook

The `felt hook session` command outputs workflow context for Claude Code SessionStart hooks.

### Output Format

```markdown
# Felt Workflow Context

> **Context Recovery**: Run `felt prime` after compaction, clear, or new session

## Active Fibers

◐ impl-auth-a1b2c3d4  Implement user auth

## Ready Fibers (unblocked)

○ design-api-e5f6a7b8    Design REST API
○ write-tests-c3d4e5f6   Write integration tests

## Core Rules
- Track **work** that spans sessions, has dependencies, or emerges during work
- Track **decisions** — what was decided, why, and how decisions depend on each other
- Closing reason (`-r`) is the documentation: capture the outcome, the reasoning, what was learned
- TodoWrite is fine for simple single-session linear tasks
- When in doubt, prefer felt—persistence you don't need beats lost context

## Essential Commands

### Finding Work
- `felt ready` - Fibers with no unresolved dependencies
- `felt ls` - All open fibers
- `felt ls --status active` - Currently active
- `felt show <id>` - Details with dependencies

### Creating & Updating
- `felt add "Title" -k task -p 2` - New fiber (kind, priority)
- `felt on <id>` - Start working
- `felt off <id> -r "reason"` - Complete with context (reason IS the documentation)
- `felt comment <id> "note"` - Add timestamped comment

### Dependencies
- `felt link <id> <depends-on>` - Add dependency
- `felt unlink <id> <dep>` - Remove dependency
- `felt upstream <id>` - What this depends on (transitive)
- `felt downstream <id>` - What depends on this (transitive)

### Visualization
- `felt graph` - DAG in mermaid format
- `felt check` - Integrity (cycles, dangling refs)
- `felt path <from> <to>` - Dependency path

## Common Workflows

**Starting work:**
\`\`\`bash
felt ready              # Find available work
felt show <id>          # Review details
felt on <id>            # Claim it
\`\`\`

**Completing work:**
\`\`\`bash
felt off <id> -r "Implemented X because Y. Tested with Z."
felt ready              # What's next?
\`\`\`

**Tracking a decision:**
\`\`\`bash
felt add "Use JWT for auth" -t decision
felt off <id> -o "Chose JWT over sessions: stateless, scales horizontally, team familiar"
\`\`\`

**Creating dependent work:**
\`\`\`bash
felt add "Design API" -t spec
felt add "Implement API" -t task -a design-api-xxxxx
# Implement depends on Design
\`\`\`
```

### Behavior
- Filters to task-tagged work by default (excludes specs, threads, notes)
- Active fibers shown first, then ready fibers
- If no active or ready fibers: "No active fibers." with basic commands
- Output is ~800-1000 tokens

### Claude Code Integration

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [{"type": "command", "command": "felt hook session"}]
      }
    ]
  }
}
```

## Implementation Plan

### Phase 1: Core
- [ ] Project structure (go.mod, main.go, cmd/, internal/)
- [ ] File format parsing (YAML frontmatter + markdown body)
- [ ] Storage layer (read/write .felt/*.md)
- [ ] ID generation (slug + hex)
- [ ] Basic commands: init, add, ls, show, on, off, rm

### Phase 2: DAG
- [ ] Build in-memory graph from depends-on fields
- [ ] Compute reverse edges (downstream)
- [ ] upstream/downstream traversal (BFS)
- [ ] Cycle detection on add/link
- [ ] ready command (open with all deps closed)
- [ ] link/unlink commands

### Phase 3: Queries & Editing
- [ ] find command (search title, body, close-reason)
- [ ] edit command ($EDITOR)
- [ ] comment command (append timestamped to body)
- [ ] Filtering on ls (--status, --kind)

### Phase 4: Visualization
- [ ] graph command — mermaid format
- [ ] graph command — graphviz dot format
- [ ] graph command — text/ascii format
- [ ] check command (integrity)
- [ ] path command

### Phase 5: Polish
- [ ] Performance tuning for 1000+ files
- [ ] Short ID prefix matching
- [ ] Config file (.felt/config)
- [ ] Hooks integration (for Claude Code)
- [ ] JSON output flag for scripting

## Completion Criteria

- [ ] All commands implemented and working
- [ ] DAG traversal (upstream/downstream) correct
- [ ] Cycle detection prevents invalid graphs
- [ ] ~100ms for 1000 felts on ls/graph operations
- [ ] Single binary, no runtime dependencies
- [ ] Can visualize graph as mermaid

## Context Pointers

- Repo: ~/code/felt
- Current dots implementation: ~/code/dots/src/storage.zig
- Loom skill: ~/.claude/skills/loom/SKILL.md
- Research skill: ~/.claude/skills/conducting-research/SKILL.md

## Technical Notes

### Go Structure
```
felt/
  go.mod
  main.go
  cmd/
    root.go
    add.go
    ls.go
    ...
  internal/
    felt/
      felt.go      # Felt struct, parsing
      storage.go   # Read/write files
      graph.go     # DAG operations
```

### Dependencies
- `gopkg.in/yaml.v3` — YAML parsing
- `github.com/spf13/cobra` — CLI framework (optional, could use stdlib)
- Standard library for everything else

### Graph Representation
```go
type Felt struct {
    ID          string
    Title       string
    Status      string    // open, active, closed
    Kind        string    // task, spec, thread, etc
    Priority    int
    DependsOn   []string
    CreatedAt   time.Time
    ClosedAt    *time.Time
    CloseReason string
    Due         *time.Time
    Body        string    // markdown after frontmatter
}

type Graph struct {
    Nodes    map[string]*Felt     // ID -> Felt
    Upstream map[string][]string  // ID -> depends-on IDs
    Downstream map[string][]string // ID -> what depends on this (computed)
}
```

Build graph once on load, traverse as needed. Recompute downstream from upstream on load.
