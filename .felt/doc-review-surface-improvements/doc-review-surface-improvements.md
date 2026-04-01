---
title: 'Doc review: surface improvements'
status: closed
tags:
    - felt
    - spec
created-at: 2026-01-13T00:54:43.769682257+01:00
closed-at: 2026-01-13T01:28:25.426679179+01:00
outcome: "Documentation review complete. 8 improvements implemented:\n\n1. Fixed shorthand-with-flags in Quick Start (shorthand only works without flags)\n2. Fixed workflows.md examples using shorthand incorrectly  \n3. Added hook/prime commands to README command reference\n4. Documented migrate-tags command in README\n5. Removed BFS implementation detail from graph.md (asymmetric mention)\n6. Clarified arrow direction diagram in graph.md\n7. Fixed cycle check claim (only link checks, not unlink)\n8. Clarified rm documentation ('other felts depend on it' vs 'has dependencies')\n\nAll docs are now accurate, consistent, and clear. Tests pass."
---

(doc-review-surface-improvements)=
## Goal

Read the felt documentation with fresh eyes. Notice what prompts questions:
- "Why is it done this way?"
- "This could be cleaner if..."
- "This seems inconsistent with..."

Surface genuine improvements — not feature creep.

## Completion Criteria

- All docs read: README.md, graph.md, workflows.md
- At least one improvement identified and implemented (or explained why not worth it)
- Each improvement is a child fiber with clear scope
- No feature creep — improvements to existing functionality only
- Tests pass after changes
- Docs updated if behavior changes

## Context Pointers

Documentation:
- `~/code/felt/docs/README.md` — main docs
- `~/code/felt/docs/graph.md` — DAG operations
- `~/code/felt/docs/workflows.md` — usage patterns

Source (if needed):
- `~/code/felt/internal/felt/felt.go` — core types, slugify, ID generation
- `~/code/felt/internal/felt/graph.go` — DAG traversal
- `~/code/felt/internal/felt/storage.go` — file I/O
- `~/code/felt/cmd/*.go` — CLI commands

## Constraints

- Improvements only, not new features
- If something seems wrong but has a good reason, document the reason
- Small, focused changes
- Run `go test ./...` after any code changes
