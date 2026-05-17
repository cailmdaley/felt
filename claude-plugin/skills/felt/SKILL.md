---
name: felt
description: >
  This skill should be used whenever working in a project that contains a `.felt/` directory, and
  when the user mentions fibers or asks to "file this", "record a decision", "add structure",
  "close this fiber", "sketch a fiber", "think through", "draft a constitution",
  "clean up fibers", "consolidate", "archive", "sweep", "maintenance pass", or "extract from the
  session". It covers filing fibers, updating outcomes and bodies, using additional YAML fields
  beyond what felt owns natively, session mining, maintenance passes, and transcript processing.
---

# felt — Working with Fibers

Fibers are concerns (tasks, decisions, questions, specs) stored as directory-contained markdown. Their relationships come from three surfaces: containment by path, `[[wikilinks]]` in the body for narrative connection, and optional project-owned conventions such as `inputs.from` when a project wants data-flow edges. felt owns the substrate — files, native metadata, search, history, links, and round-tripping of any extra top-level YAML fields — not the semantics of every YAML block a project might store.

The practical rule: **felt owns the fiber; projects own any additional YAML fields beyond felt's native metadata.** If a fiber needs more structure than felt owns natively, add those fields directly in the markdown file or use the project's own tool. felt will preserve them and surface them in `--field` / `--json`, but it will not validate the domain semantics for you.

Proactive filing. Retroactive extraction. Consolidation over time. Coherence when needed.

---

## CLI

```
Something came into focus. Start:
    felt add <slug> "name" -t tag -o "one-line outcome"

Understanding crystallized. Accrete:
    felt edit <id> --status active
    felt edit <id> --tag X
    felt edit <id> --outcome "what changed"
    Read then Edit .felt/<path>/<slug>.md          # body + non-native frontmatter

Search and read:
    felt ls                                        # tracked (open and active)
    felt ls "query" [-t tag] [-s closed]          # any filter widens to all statuses
    felt ls --body "query"                         # FTS5 body search
    felt tree [<id>]                               # containment hierarchy
    felt show <id>                                 # full
    felt show <id> -d summary | -d compact         # metadata + lede | + extra-key summary
    felt show <id> --body                          # body with start line
    felt show <id> --citations|--consumers         # narrative back-refs | data-flow consumers
    felt show <id> --field <key>                   # one raw frontmatter key, shell-friendly

A thread resolved. Close:
    felt edit <id> --status closed --outcome "what was learned"

History (per-fiber append-only event log):
    felt history <id>
    felt history <id> --last 1
    felt history <id> --mechanical
    felt history append <id> --summary "..."

Reshape:
    felt nest <child> <parent>
    felt unnest <id>

Maintain:
    felt check                                     # broken refs, broken data-flow refs, layout issues
    felt migrate [--dry-run]                       # normalize legacy layout
```

Statuses: · untracked, ○ open, ◐ active, ● closed
Detail: name < compact < summary < full. Summary shows the lede (first paragraph of the body; write it to stand alone).
Relationships: directory containment, `[[wikilinks]]` in bodies, and optional project-owned data-flow conventions. Nested IDs use paths (bao-analysis/damping-prior).

**Outcomes longer than a sentence:** edit `.felt/<path>/<slug>.md` directly using a `|-` block scalar (`outcome: |-`). `felt edit -o "…"` shell-escapes quotes and mangles multiline content; block scalar takes content literally so paragraphs, lists, and image embeds round-trip cleanly.

---

## Philosophy

**File while working.** The moment to update a fiber is right after something crystallizes, while the user reads and the understanding still has edges.

**Follow the understanding.** Don't ask permission to file. The user's corrections and opinions are the primary trigger; when the direction shifts, the fiber should shift too.

**Use the substrate cleanly.** Keep names short, outcomes specific, bodies narrative, and non-native frontmatter clearly owned by the project that introduced it. Wikilinks belong inline in the prose, woven into sentences that are doing work — not piled at the bottom of a fiber as a related-things list.

**Extract what slipped through.** Continuous filing catches most things. At session end, mine decisions, patterns, and findings that were left implicit.

**Outcomes teach.** An outcome that says "done" has failed. Put the conclusion in: what was learned, what was decided, why.

**Consolidate over time.** Quick fibers become noise. Read the assemblage periodically and compost stale fibers into doc fibers, fix coherence across siblings, reshape branching.

**CLAUDE.md stays lean.** Commands, paths, context pointers. Documentation fibers carry the depth.

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

### Additional YAML fields

Fibers may carry project-owned top-level YAML fields beyond what felt parses natively. When such fields matter, edit them carefully in the fiber file and keep the ordinary felt surfaces current alongside them: `outcome` for latest state, `felt history` for chronological handoff, sub-fibers for durable findings.

---

## Core Rules

- **Outcomes teach.** One-sentence conclusions that stand alone: they appear in `felt ls` and `-d compact`.
- **Use the right relationship surface.** Nest for containment, `[[wikilinks]]` for narrative, project-owned conventions for anything more specific.
- **Links in prose, not in piles.** A `[[wikilink]]` earns its place by doing work in a sentence — naming what the other fiber is, why it's relevant here, where to head next. Related-things lists at the bottom of a fiber are a smell that the relationships haven't been thought through; either fold them into the body where they belong, or drop the ones that aren't earning the link.
- **Compose upward.** When closing, ask whether the lesson belongs in a doc fiber or the root fiber; consolidate breadcrumbs.
- **Names are concise labels.** Body and outcome carry the content.

---

## References

Read the reference that matches the situation. Everything above applies always; references go deeper for specific activities.

| When | Reference |
|------|-----------|
| Helping the user think carefully — two diamonds, six stances, funnel, qualitative self-check | [crafting.md](references/crafting.md) |
| Drafting a constitution — pointers not snapshots, desired state, launch | [constitution.md](references/constitution.md) |
| At the end of a session — extracting what slipped through | [mining.md](references/mining.md) |
| Processing an external transcript — meeting notes, voice note, dictation file | [transcripts.md](references/transcripts.md) |
| Reading across the assemblage for mess — composting, coherence, reshaping | [maintenance.md](references/maintenance.md) |
| Migrating legacy flat fibers to directory format | [migration.md](references/migration.md) |
