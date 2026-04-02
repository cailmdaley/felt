---
name: felt
description: >
  Working with fibers. Four modes:
  (1) Session — extract from conversation at session end.
  (2) Transcript — extract from external sources with review.
  (3) Archive — consolidate old fibers into documentation.
  (4) Sweep — coherence check across the assemblage.
  Also triggers on formalization (adding ASTRA structure to fibers),
  tapestry export, evidence filing, or "update the tapestry".
---

# /felt — Working with Fibers

Fibers are concerns — tasks, decisions, questions, specs — connected in a directed graph. ASTRA is an open specification for computational science: decisions with excluded alternatives, inputs and outputs with recipes, insights backed by evidence. Felt fibers carry ASTRA fields in their frontmatter; the structure accretes as understanding crystallizes.

Proactive formalization. Retroactive extraction. Consolidation over time. Coherence when needed.

---

## Philosophy

**Formalize while working.** During analysis, fibers accrete ASTRA structure as it becomes real. Write inputs while scripts run. Record excluded options the moment you reject them. Don't wait for a separate formalization pass; the structure belongs where the thinking happens.

**Extract what was missed.** At session end, mine decisions, patterns, and findings that weren't captured in the moment. The retroactive pass catches what fell through.

**Outcomes teach.** An outcome that says "done" or "investigated X" has failed. Put the conclusion in: what was learned, what was decided, why. Someone reading the outcome should learn the thing without opening the body.

**Consolidate over time.** Quick fibers become noise. Archive mode composts them into richer documentation fibers.

**CLAUDE.md stays lean.** Commands, paths, context pointers. Documentation fibers carry the depth.

**Propagate decisions.** A decision rarely touches one place. Use Explore agents to find consequences — config, code, methodology, other fibers. Link every downstream change so impact is traceable.

---

## Modes

| Mode | When | Review? |
|------|------|---------|
| **session** | End of coding session | No — autonomous |
| **transcript** | External file (meeting, voice note) | Yes — present plan first |
| **formalize** | During analysis work, accreting ASTRA structure | No — inline with work |
| **archive** | Consolidating old fibers | Yes — confirm before changes |
| **sweep** | Coherence check across assemblage | Yes — present findings first |

**Target:**
- Project work → local `.felt/`
- Cross-project / life → `~/loom/.felt/`

---

## What to Extract

### Quick fibers

| Category | What to capture |
|----------|-----------------|
| **Decision** | Choice made, alternatives, reasoning. Include "decided NOT to." |
| **Question answered** | What was figured out. Mechanism, cause, how. |
| **Pattern** | Architectural insight, convention, workflow. |
| **Finding** | What was built, measured, produced. |

### Documentation fibers

| Category | What to capture |
|----------|-----------------|
| **Reference doc** | Accumulated understanding. Architecture, philosophy, decision trees. |
| **How-to** | Procedures that get reused. More depth than CLAUDE.md. |

### CLAUDE.md updates

- Commands and invocations
- Context pointers (paths, important fibers, documentation fibers)
- Workflow sequences

---

## Quality Standards

**Red flags:**
- Generic summaries instead of specific findings
- "We discussed X" without capturing what was concluded
- Closing fibers without substantive outcomes
- Orphan fibers (not linked to anything)
- Stale documentation fibers

**Good extraction:**
- Specific, searchable titles (2-3 words)
- Full context in outcome
- DAG links to related fibers
- Documentation fibers created when patterns recur

---

## Sweep Mode

Coherence check across the assemblage. Not scheduled — when it feels right:

- After a burst of exploration
- Before a deadline
- When something feels off

Launch Explore agents across open fibers. Each reads a fiber, checks whether the concern is still coherent with the code and the fibers around it. Findings come back to the main session for decision.

The cycle: explore, tangle, order, clarity, explore again.

---

## Reference Files

Read the relevant reference when the mode or context matches:

| Context | Reference |
|---------|-----------|
| Mining a Claude session | [claude-sessions.md](references/claude-sessions.md) |
| Processing external transcript | [transcripts.md](references/transcripts.md) |
| Formalizing fibers with ASTRA structure | [formalization.md](references/formalization.md) |
| ASTRA field reference (schema, types, constraints) | [astra.md](references/astra.md) |
| Consolidating old fibers, reshaping | [archiving.md](references/archiving.md) |
| Tapestry: evidence, export, reshaping | [tapestry.md](references/tapestry.md) |
| Tapestry: viewer setup, GitHub Pages | [viewer-setup.md](references/viewer-setup.md) |
| Migrating flat fibers to directory format | [migration.md](references/migration.md) |
