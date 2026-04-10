---
name: felt
description: >
  This skill should be used whenever working in a project that contains a `.felt/` directory, and
  when the user mentions fibers, asks to "file this", "record a decision", "formalize", "add ASTRA
  structure", "close this fiber", or "extract from the session". Primary mode is formalize: accrete
  structure on fibers as understanding crystallizes, in the reply window after each response. Other
  modes are session (retroactive backstop at session end, chains into an exit interview written to
  `~/loom/.felt/felt/`), transcript (extract from external sources with review), archive (consolidate
  old fibers into documentation), and sweep (coherence check across the assemblage).
---

# /felt — Working with Fibers

Fibers are concerns (tasks, decisions, questions, specs) stored as directory-contained markdown. Their relationships come from three surfaces: containment by path, `[[wikilinks]]` in the body for narrative connection, and ASTRA `inputs.from` for computational provenance. ASTRA is an open specification for computational science: decisions with excluded alternatives, inputs and outputs with recipes, insights backed by evidence. Felt fibers carry ASTRA fields in their frontmatter; the structure accretes as understanding crystallizes.

For literature audits, model the audited paper statement as the `claim` and anchor the supporting `evidence` in the cited source itself with a traceable selector such as a quote, figure, or table. Use audit reports as artifact evidence for your own findings about the audit process, not as substitutes for literature evidence.

Proactive formalization. Retroactive extraction. Consolidation over time. Coherence when needed.

---

## Philosophy

**Formalize while working.** The moment to accrete structure is right after you respond, while the user reads; that time is unbilled, and what crystallized during the exchange is still fresh. Write inputs while scripts run, record excluded options the moment you reject them, file what just came into focus. Formalization belongs in the flow of the work, not in a separate pass at the end.

**Follow the understanding.** Don't ask permission to file. The user's corrections and opinions are the primary trigger; when the direction of the conversation shifts, your fibers shift with it, reversals included. You are tracking what has come to matter, not what was said first.

**Extract what slipped through.** Continuous formalization catches most things. At session end, mine decisions, patterns, and findings that weren't captured in the moment; this is a backstop, not the primary mode.

**Outcomes teach.** An outcome that says "done" or "investigated X" has failed. Put the conclusion in: what was learned, what was decided, why. Someone reading the outcome should learn the thing without opening the body.

**Consolidate over time.** Quick fibers become noise. Archive mode composts them into richer documentation fibers.

**CLAUDE.md stays lean.** Commands, paths, context pointers. Documentation fibers carry the depth.

**Propagate decisions.** A decision rarely touches one place. Use Explore agents to find consequences in config, code, methodology, and other fibers. Record the consequence in code or fibers, and add wikilinks where the narrative connection matters.

---

## Modes

| Mode | When | Review? |
|------|------|---------|
| **formalize** | After each response, while the user reads | No — inline with work |
| **session** | End of coding session (backstop) | No — autonomous |
| **transcript** | External file (meeting, voice note) | Yes — present plan first |
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
- Orphan fibers with no containment context, no `[[wikilinks]]`, and no data-flow connection
- Stale documentation fibers

**Good extraction:**
- Specific, searchable names (2-3 words)
- Full context in outcome
- Narrative/data-flow links where they carry meaning
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
| Migrating flat fibers to directory format | [migration.md](references/migration.md) |
| Agent exit interview at session end | [exit-interview.md](references/exit-interview.md) |
