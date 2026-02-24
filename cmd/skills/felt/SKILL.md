---
name: felt
description: >
  Working with fibers. Four modes:
  (1) Session — extract from conversation at session end.
  (2) Transcript — extract from external sources with review.
  (3) Archive — consolidate old fibers into documentation.
  (4) Sweep — coherence check across the assemblage.
---

# /felt — Working with Fibers

Retroactive extraction at session end. Consolidation over time. Coherence when needed.

---

## Philosophy

**Mining is retroactive.** Extract what wasn't captured in the moment. Decisions made, questions answered, patterns discovered.

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
| **archive** | Consolidating old fibers | Yes — confirm before changes |
| **sweep** | Coherence check across assemblage | Yes — present findings first |

**Felt target:**
- Project-specific session → local `.felt/`
- General/cross-project → `~/loom/.felt/`

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
| Consolidating old fibers | [archiving.md](references/archiving.md) |
| Claude Desktop CLI patterns | [claude-desktop.md](references/claude-desktop.md) |
