---
title: felt perf+simplify
status: closed
tags:
    - decision
created-at: 2026-03-06T10:46:48.992527+01:00
closed-at: 2026-03-10T17:00:07.907573+01:00
outcome: All done conditions met. Find() reads only matching file (5f0d6f6). Double-List() eliminated (5f0d6f6). Formatting deduplicated into internal/felt package (526bf42). Compat parsing removed (5e8be36). Staged metadata-only listing for ls (b77737e). Streaming frontmatter reads (fa380eb). Opt-in modtime (ba76689). FindMetadata for single-fiber commands (1dfc5fb). felt ls/show/hook all under 15ms on ~80 fibers. No caching layers, no index files — all wins from not doing unnecessary work.
---

(felt-perf-simplify)=
## Desired State

felt commands are fast and the codebase is tight. Single-fiber operations (show, edit, tag, comment) don't parse every fiber on disk. Full-tapestry scans (ls, hook session) don't parse fiber bodies unless searching body text. No formatting function is duplicated across files. A cold reader sees each concept once.

`felt ls` stays cheap when the query can be answered from metadata alone. Status-only, tag-only, `--recent`, exact-title, and title/outcome search should not require full body parses. Body content should only be parsed when query semantics actually demand body inspection.

### Done conditions

- `Find()` uses ReadDir + filename match, reads only the matching file
- Commands needing both a target fiber and the graph (show, upstream, downstream) call `List()` once, build graph, look up the target in `graph.Nodes`
- `felt ls` with only status/tag/recent filters does not parse bodies
- `felt ls` text queries parse only the fields they need:
  - exact title uses metadata only
  - substring/regex title+outcome search does not parse bodies
  - body parsing is opt-in by query mode, not unconditional
- No formatting duplication: statusIcon, shortID, two-line format each defined once
- All fibers migrated from legacy kind/close-reason fields to modern format; compat parsing removed
- All tests pass: `go test ./...`
- No new abstractions, caching layers, or index files

### Scope fence

- **Touch:** `internal/felt/` (storage, felt, graph) and `cmd/` (all commands)
- **Don't touch:** `cmd/setup.go` (integration plumbing — rarely called, not a hot path), `cmd/skills/` (embedded assets)
- **Don't add:** caching layers, index files, or persistent state. Perf wins come from not doing unnecessary work
- **Don't change:** the CLI interface or the public behavior of any command

## Decisions

These are resolved — iterations should implement, not revisit:

1. **Migration:** Rewrite all 79 fibers using legacy close-reason/kind fields to modern format (`outcome:`/tags), then remove the `parseFrontmatter` compat struct entirely.
2. **Find() design:** `ReadDir` + filename prefix/hex-suffix match, then read only the matching file. Handles both slug-prefix and hex-suffix matching.
3. **Double List():** Commands that need Find + graph do a single `List()`, build graph, look up target in `graph.Nodes` instead of calling `Find()` separately.
4. **Autonomy:** Full auto. Test suite + timing evidence for self-check.
5. **No persistence tricks:** keep the storage model simple. Performance work comes from staged parsing and better field selection, not caches or indexes.

## Context

### Architecture

```
cmd/           CLI commands (cobra). Each file registers commands in init().
internal/felt/ Core: Storage (read/write .felt/*.md), Felt (parse/marshal), Graph (DAG ops).
```

~6k lines of Go, 67 fibers in `.felt/`, 4 dependencies (cobra, pflag, yaml.v3, mousetrap).

### Hot paths (by frequency)

1. **`felt hook session`** — runs every Claude Code session start. Calls `List()` + `BuildGraph()`.
2. **`felt ls`** — most common interactive command. Calls `List()`.
3. **`felt show <id>`** — calls `Find()` (which calls `List()`), then `List()` again for graph.
4. **`felt edit/tag/comment <id>`** — calls `Find()` (which calls `List()`).

`felt ls` is still the remaining perf target. Today it calls `List()`, which parses full files including body, even when filters only need frontmatter or when text search only needs title/outcome.

### Key files

- `internal/felt/storage.go` — `List()` reads+parses all fibers. `Find()` calls `List()` to match an ID prefix.
- `internal/felt/felt.go` — `Parse()` splits frontmatter via `bufio.Scanner`, unmarshals YAML, reads full body.
- `internal/felt/graph.go` — `BuildGraph()` indexes all fibers, computes reverse edges. BFS traversals.
- `cmd/ls.go` — `statusIcon()`, `formatFeltTwoLine()`, `shortID()` — formatting utilities.
- `cmd/hook.go` — `formatFiberEntry()` — near-duplicate of `formatFeltTwoLine()`.
- `cmd/graph.go` — tree printing overlaps with ls.go tree printing.
- `cmd/depth.go` — `renderFelt()` progressive disclosure rendering.

Likely direction: split parsing into metadata-only vs full parse, then let `ls` choose the cheapest path compatible with its flags. Preserve current CLI behavior.

### Previous loop outcome

The prior loop completed these improvements and they should remain intact:

1. `Find()` optimized in commit `5f0d6f6`
2. Double-`List()` removal in `show`/graph paths in commit `5f0d6f6`
3. Formatting deduplicated in commit `526bf42`
4. Frontmatter migration + compat removal in commit `5e8be36`

Measured after that loop on this machine:

- `felt show chain-9` improved by about 23%
- `felt ls` and `felt hook session` showed no meaningful change

### Duplication map

- `statusIcon`: `cmd/ls.go:204` and inline switch in `graph.go:printTextTree`
- `shortID` / truncated ID: `cmd/ls.go:479` and `graph.go:printTextTree:466`
- Two-line fiber format: `cmd/ls.go:formatFeltTwoLine` and `cmd/hook.go:formatFiberEntry`
- Tree printing: `cmd/ls.go:printTreeWithVisited` and `graph.go`'s `Graph.ToText` via `printTextTree`

## Evidence

### Correctness
```bash
go test ./...
```

### Performance
```bash
go build . && time ./felt ls && time ./felt show chain-9 && time ./felt hook session
go build . && time ./felt ls -t decision
go build . && time ./felt ls --recent 20
go build . && time ./felt ls migrate
go build . && time ./felt ls -r 'rule:.*data'
```

### Duplication (should reach zero hits)
```bash
grep -rn 'func statusIcon\|func formatFelt\|func formatFiber\|func shortID' cmd/
# Expect exactly 1 hit per function name
```

### Migration (should reach zero)
```bash
legacy_close='close-reason'':'
legacy_kind='^ki''nd:'
grep -l "$legacy_close" .felt/*.md | wc -l
grep -l "$legacy_kind" .felt/*.md | wc -l
```
