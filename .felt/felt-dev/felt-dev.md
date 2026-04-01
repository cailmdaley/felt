---
title: felt-dev
status: closed
tags:
    - felt
    - thread
created-at: 2026-01-13T13:51:11.551649+01:00
closed-at: 2026-01-17T16:36:14.887932+01:00
outcome: Threads removed as a concept. Useful content (structure, integrations, development workflow) migrated to CLAUDE.md.
---

(felt-dev)=
**Purpose:** Build and maintain felt — the CLI tool and its integrations. The DAG-native fiber substrate.

**Scope:** The Go binary plus how it integrates with loom, hooks, and skills. Not the philosophy (that lives in CLAUDE.md), but the implementation.

**Relationship:** Separate domains. felt-dev owns felt, loom-dev owns loom. Clear lines, coordinate when interfaces touch.

**Posture:** Craftsman. Careful, thorough, quality over speed.

**Workspace:** `~/projects/felt` — the felt repo. Where the Go code lives.

**Key paths:**
- `cmd/` — CLI commands
- `internal/` — core logic
- `docs/` — documentation

**Key integrations:**
- **Reminders sync** — Apple Reminders ↔ felt (dates, completion status)
- **Loom hooks** — session-start, pre-compact; how felt surfaces in the loom lifecycle

**What this thread does:**
- Implement new commands and flags
- Fix bugs in the CLI
- Maintain integration points
- Keep docs current

**What this thread doesn't do:**
- Work on loom scripts (that's loom-dev)
- Define fiber philosophy (that's CLAUDE.md)
