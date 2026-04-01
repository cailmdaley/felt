---
name: felt
description: >
  Working with fibers. Four modes:
  (1) Session — extract from conversation at session end.
  (2) Transcript — extract from external sources with review.
  (3) Archive — consolidate old fibers into documentation.
  (4) Sweep — coherence check across the assemblage.
  Also triggers on "update the tapestry", "file a claim", "add evidence",
  export work (`felt export --format tapestry|astra`), tapestry reshaping,
  evidence.json creation, or formalization (adding ASTRA structure to fibers).
---

# /felt — Working with Fibers

Retroactive extraction at session end. Formalization during work. Consolidation over time. Coherence when needed.

---

## Philosophy

**Mining is retroactive.** Extract what wasn't captured in the moment. Decisions made, questions answered, patterns discovered.

**Formalization is proactive.** During analysis work, fibers can move from annotated to formalized to analysis-grade as the structure becomes real and, later, human-validated. The agent does not forget reasoning; formalize on the fly.

**Consolidate over time.** Old fibers become noise. Archive mode composts quick fibers into richer documentation.

**Outcomes ARE documentation.** The outcome is the record — not a summary, the actual documentation.

**CLAUDE.md/AGENTS.md stays lean.** Commands, paths, context pointers. Points to documentation fibers for depth.

**Documentation fibers need maintenance.** Unlike quick fibers (fire and forget), `doc` fibers are living references.

---

## Modes

| Mode | When | Review? |
|------|------|---------|
| **session** | End of coding session | No — autonomous |
| **transcript** | External file (meeting, voice note) | Yes — present plan first |
| **formalize** | During analysis work, accreting ASTRA structure | No — inline with work |
| **archive** | Consolidating old fibers | Yes — confirm before changes |
| **sweep** | Coherence check across assemblage | Yes — present findings first |

**Felt target:**
- Project-specific session → local `.felt/`
- General/cross-project → `~/loom/.felt/`

## Formalization Model

| Kind | Annotated | Formalized | Analysis-grade |
|------|-----------|------------|----------------|
| **Decision** | Note or body text about a pending choice | `decisions:` block with real options, default, excluded reasoning | Same, plus `analysis-grade: true` after human validation and analytical reliance |
| **Computation** | Breadcrumb or running note about work being done | `inputs:` + `outputs:` with optional `recipe` | Same, plus `analysis-grade: true` when the computation is part of the real argument |
| **Finding** | Note that a claim may be true | `insights:` claim with evidence pointers | Same, plus `analysis-grade: true` after human validation and analytical reliance |

Annotated is any valid fiber. Formalized means at least one ASTRA object is well formed enough to export. Analysis-grade is a workflow flag, not a richer schema.

---

## What to Extract

### Quick fibers (retroactive capture)

| Category | What to capture |
|----------|-----------------|
| **Decision** | Choice made, alternatives, reasoning. Include "decided NOT to." |
| **Question answered** | What was figured out. Mechanism, cause, how. |
| **Pattern** | Architectural insight, convention, workflow. |
| **Outcome** | What was built, found, produced. |

### Documentation fibers

| Category | What to capture |
|----------|-----------------|
| **Reference doc** | Accumulated understanding. Architecture, philosophy, decision trees. |
| **How-to** | Procedures that get reused. More depth than CLAUDE.md/AGENTS.md. |

### CLAUDE.md/AGENTS.md updates

- Commands and invocations
- Context pointers (paths, important fibers, documentation fibers)
- Workflow sequences

---

## Quality Standards

**Red flags:**
- Generic summaries instead of specific findings
- "We discussed X" without capturing WHAT was concluded
- Closing fibers without substantive outcomes
- Orphan fibers (not linked to anything)
- Stale documentation fibers (out of date)

**Good extraction:**
- Specific, searchable titles
- Full context in outcome
- DAG links to related fibers
- CLAUDE.md/AGENTS.md updated with context pointers
- Documentation fibers created when patterns recur

---

## Propagation

A decision rarely touches one place. When a fiber changes something — config, code, methodology — use Explore agents to grep and traverse the codebase for consequences, implications, and downstream changes. They report back; you decide what to act on. The original fiber links to every downstream fiber it spawned, so the full impact is traceable.

---

## Sweep Mode

Coherence check across the assemblage. Not on a schedule — when it feels right:

- After a burst of exploration
- Before a deadline
- When something feels off

Launch explore agents across open fibers. Each one reads a fiber, checks whether the concern is still coherent with the code that implements it and the fibers that surround it. Findings come back to the main session for decision.

The cycle: explore → tangle → order → clarity → explore again.

---

## Reference Files

When this skill is activated, read at least one of the following depending on context:

| Context | Reference |
|---------|-----------|
| Mining a Claude session | [claude-sessions.md](references/claude-sessions.md) |
| Processing external transcript | [transcripts.md](references/transcripts.md) |
| Consolidating old fibers, tapestry reshaping | [archiving.md](references/archiving.md) |
| Formalizing fibers with ASTRA structure | [formalization.md](references/formalization.md) |
| Migrating flat fibers to directory format | [migration.md](references/migration.md) |
| Tapestry: evidence, export, reshaping | [tapestry.md](references/tapestry.md) |
| Tapestry: viewer setup, GitHub Pages | [viewer-setup.md](references/viewer-setup.md) |
