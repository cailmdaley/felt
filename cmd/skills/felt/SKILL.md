---
name: felt
description: >
  This skill should be used whenever working in a project that contains a `.felt/` directory, and
  when the user mentions fibers, asks to "file this", "record a decision", "formalize", "add ASTRA
  structure", "close this fiber", "sketch a fiber", "think through", "draft a constitution", "set
  up a ralph", "ralph spec", "ralph", "clean up fibers", "consolidate", "archive", "sweep",
  "maintenance pass", or "extract from the session". Fibers are directory-contained markdown with
  optional ASTRA frontmatter; structure accretes as understanding crystallizes. The philosophy
  and the crafting rhythm below apply whenever the skill is active; the References table points at
  deeper material for specific activities.
---

# /felt — Working with Fibers

Fibers are concerns (tasks, decisions, questions, specs) stored as directory-contained markdown. Their relationships come from three surfaces: containment by path, `[[wikilinks]]` in the body for narrative connection, and ASTRA `inputs.from` for computational provenance. ASTRA is an open specification for computational science: decisions with excluded alternatives, inputs and outputs with recipes, insights backed by evidence. Felt fibers carry ASTRA fields in their frontmatter; the structure accretes as understanding crystallizes.

For literature audits, model the audited paper statement as the `claim` and anchor the supporting `evidence` in the cited source itself with a traceable selector such as a quote, figure, or table. Use audit reports as artifact evidence for your own findings about the audit process, not as substitutes for literature evidence.

Proactive formalization. Retroactive extraction. Consolidation over time. Coherence when needed.

---

## Philosophy

**Formalize while working.** The moment to accrete structure is right after you respond, while the user reads; that time is unbilled, and what crystallized during the exchange is still fresh. Write inputs while scripts run, record excluded options the moment you reject them, file what just came into focus. Formalization belongs in the flow of the work, not in a separate pass at the end.

**Follow the understanding.** Don't ask permission to file. The user's corrections and opinions are the primary trigger; when the direction of the conversation shifts, your fibers shift with it, reversals included. You are tracking what has come to matter, not what was said first.

**Help the user think.** When the conversation has careful-thinking character — deciding something non-trivial, scoping a sub-analysis, drafting a spec, talking through an open question — lean on the crafting rhythm from `crafting.md` (two diamonds, six stances, funnel ledger, qualitative self-check) to help the user converge. Err toward using it; the failure mode is letting important decisions slide by without structure, not pressing too hard.

**Extract what slipped through.** Continuous formalization catches most things. At session end, mine decisions, patterns, and findings that weren't captured in the moment; this is a backstop, not the primary mode.

**Outcomes teach.** An outcome that says "done" or "investigated X" has failed. Put the conclusion in: what was learned, what was decided, why. Someone reading the outcome should learn the thing without opening the body.

**Consolidate over time.** Quick fibers become noise. Read the assemblage periodically and compost stale fibers into doc fibers, fix coherence across siblings, reshape branching. See `maintenance.md`.

**CLAUDE.md stays lean.** Commands, paths, context pointers. Documentation fibers carry the depth.

**Propagate decisions.** A decision rarely touches one place. Use Explore agents to find consequences in config, code, methodology, and other fibers. Record the consequence in code or fibers, and add wikilinks where the narrative connection matters.

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

## References

Read the relevant reference when the situation matches. Everything above applies always; references go deeper for specific activities.

| When | Reference |
|------|-----------|
| Accreting ASTRA structure on a fiber — tier ladder, common shapes, body vs frontmatter | [formalization.md](references/formalization.md) |
| Helping the user think carefully — two diamonds, six stances, funnel, qualitative self-check, ASTRA output | [crafting.md](references/crafting.md) |
| Editing ASTRA frontmatter directly — full schema, types, constraints | [astra.md](references/astra.md) |
| Drafting a ralph constitution — pointers not snapshots, desired state, launch | [constitute.md](references/constitute.md) |
| At the end of a session — extracting what slipped through | [mining.md](references/mining.md) |
| Processing an external transcript — meeting notes, voice note, dictation file | [transcripts.md](references/transcripts.md) |
| Reading across the assemblage for mess — composting, coherence, reshaping | [maintenance.md](references/maintenance.md) |
| Migrating legacy flat fibers to directory format | [migration.md](references/migration.md) |
