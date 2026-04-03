---
title: Read-time fidelity modes for felt show
status: closed
tags:
    - spec
depends-on:
    - id: status-model-tasks-vs-knowledge
      label: compact depth depends on field naming
created-at: 2026-02-10T15:33:45.826854696+01:00
closed-at: 2026-02-11T00:30:09.914416583+01:00
outcome: 'Implemented: four depth levels (title/compact/summary/full) for show + upstream/downstream. Lede extraction convention. Recently Touched replaces Recently Closed in hook. Removed on/off commands — felt edit -s covers status changes. All docs updated.'
---

(read-time-fidelity-modes-for)=
# Depth: read-time progressive disclosure

## Motivation

When an LLM (or a person) surveys fibers, the right level of detail depends on the moment. Searching among 12 results needs titles. Understanding what a fiber concluded needs the outcome. Picking up where someone left off needs the full body.

`felt ls` gives titles, `felt show` gives everything. Depth adds the middle: read any fiber at the resolution you need, decide at read time, drill deeper where signal demands.

Inspired by attractor's context fidelity modes and StrongDM's pyramid summaries.

## Design

Four depth levels via `--depth` / `-d`:

| Level | Flag | What's shown | Upstream/downstream |
|---|---|---|---|
| **title** | `-d title` | Title, tags | not shown |
| **compact** | `-d compact` | ID, title, status, tags, outcome | IDs + edge labels |
| **summary** | `-d summary` | Compact + due date + lede paragraph | IDs + titles |
| **full** | (default) | Everything | IDs + titles |

### CLI

```bash
felt show <id>              # full (default)
felt show <id> -d compact   # "what happened?" — outcome without the body
felt show <id> -d summary   # compact + first paragraph
felt show <id> -d title     # just the headline

felt upstream <id> -d compact   # outcomes of all upstream decisions
felt downstream <id> -d title   # quick scan of what depends on this
```

### Lede convention

Summary depth extracts the lede mechanically: skip a title-level `# heading` (which repeats the fiber title), then take the first section heading + first paragraph underneath. No format changes to files — a reading convention. When truncated, shows `[... N more chars]`.

### The pyramid pattern

Survey at low resolution, expand selectively where signal warrants:

1. `felt find "query"` — titles (enumeration)
2. `felt show <id> -d compact` — "what was decided?" (orientation)
3. `felt show <id> -d summary` — "what's the shape of the reasoning?" (triage)
4. `felt show <id>` — full body (deep reading)

For graph traversal: `felt upstream <id> -d compact` surfaces upstream outcomes in one call — useful for understanding what a fiber rests on without reading each dependency's full body.

### Files

- `cmd/depth.go` — depth constants, validation, rendering functions (`renderTitle`, `renderCompact`, `renderSummary`, `renderFull`), lede extraction, dep formatting
- `cmd/depth_test.go` — tests for lede extraction
- `cmd/show.go` — `--depth` / `-d` flag
- `cmd/graph.go` — `--depth` / `-d` flag on upstream/downstream

### Non-goals

- LLM-generated summaries (v1 is mechanical; smart compression is future)
- Pre-computed summary fields (read-time, not write-time)
- Recursive depth on `show` (render neighbors inline) — composition handles this: call `upstream -d compact` then `show` individual fibers
- `felt find` / `felt ls` depth — deferred, composition works for now
