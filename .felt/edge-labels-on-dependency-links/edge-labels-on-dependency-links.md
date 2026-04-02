---
title: Edge labels on dependency links
status: closed
created-at: 2026-02-10T15:33:43.161833795+01:00
closed-at: 2026-02-10T20:39:27.705219122+01:00
---

(edge-labels-on-dependency-links)=
# Edge labels on dependency links

Dependency links carry topology but not meaning. Add an optional label to edges so the DAG says *why* B depends on A, not just that it does.

## Desired State

`DependsOn` supports both bare strings and `{id, label}` objects in YAML, backward compatible. Mixed arrays round-trip cleanly. `felt link B A -l "reason"` sets a label; bare `felt link B A` still works. Labels appear in `felt show`, `felt upstream`, `felt downstream`, and all graph output formats (text, DOT, mermaid).

**Done when:**

- `go test ./...` passes
- `DependsOn` field in `internal/felt/felt.go` uses a type that handles mixed YAML (bare string and `{id, label}` object) with custom marshal/unmarshal
- Writing only emits object form when label is non-empty
- `felt link B A -l "label"` works (flag in `cmd/edit.go`)
- `felt show` displays labels inline: `upstream-id [label text] (Title)`
- `felt upstream`/`felt downstream` include labels
- `internal/felt/graph.go` carries labels through graph construction and emits them in DOT (`[label="..."]`), mermaid (`-->|label|`), and text output
- Existing fibers with bare `depends-on: [id1, id2]` continue to parse and round-trip without modification

**Non-goals:** edge conditions/weights, multiple labels per edge, editing labels in place (use unlink + link).

## Context

**Core type** — `internal/felt/felt.go`: `Felt` struct has `DependsOn []string`. Custom YAML marshal/unmarshal needed here. See `Parse()` and `Marshal()` for frontmatter handling.

**Storage** — `internal/felt/storage.go`: `Read()` and `Write()` use `Parse`/`Marshal`. Round-trip fidelity matters — labels must survive read-modify-write.

**Graph** — `internal/felt/graph.go`: `Graph` struct has `Upstream map[string][]string` and `Downstream map[string][]string`. These maps need to carry labels. `ToMermaid()`, `ToDot()`, `ToText()` generate output. `BuildGraph()` constructs the graph from felts.

**Link command** — `cmd/edit.go`: `linkCmd` adds dependencies, checks cycles via `DetectCycle()`. Add `-l`/`--label` flag here.

**Show command** — `cmd/show.go`: `formatDeps()` displays dependencies with titles. Needs label display.

**Graph commands** — `cmd/graph.go`: `upstreamCmd`, `downstreamCmd`, `graphCmd`. Display functions here consume graph data.

## Skills

`/implementing-code`
