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

Fibers are concerns (tasks, decisions, questions, specs) stored as directory-contained markdown. Their relationships come from three surfaces: containment by path, `[[wikilinks]]` in the body for narrative connection, and optional project-owned conventions such as `inputs.from` when a project wants data-flow edges. felt owns the substrate — files, native metadata, search, links, and round-tripping of any extra top-level YAML fields — not the semantics of every YAML block a project might store.

The practical rule: **felt owns the fiber; projects own any additional YAML fields beyond felt's native metadata.** If a fiber needs more structure than felt owns natively, add those fields directly in the markdown file or use the project's own tool. felt will preserve them and surface them in `--field` / `--json`, but it will not validate the domain semantics for you.

Proactive filing. Retroactive extraction. Consolidation over time. Coherence when needed.

---

## CLI

```
Something came into focus. Start:
    felt add <slug> "name" -t tag -o "one-line outcome"
    # statusless by default. Pass -s open only if someone should do something.

Understanding crystallized. Accrete:
    felt edit <id> --outcome "what changed"
    felt edit <id> --tag X
    felt edit <id> --status active                 # only if this is now current work
    Read then Edit .felt/<path>/<slug>.md          # body + non-native frontmatter

Search and read:
    felt ls                                        # tracked (open and active) IN THIS VIEW
    felt ls "query" [-t tag] [-s closed] [-v]     # filters this view's listing: substring over name, outcome, YAML, slug; widens to every status but closed (a trailing hint counts those); matches under a matching ancestor collapse into it, -v expands
    felt ls --body "query"                         # adds body search — plain substring; use -r --body for regex
    felt find "query" [-t tag] [-s closed] [-v]   # searches the WHOLE store: local hits, then the rest of the loom by full id (outer block capped at 20; --limit 0 for all; -j emits one merged array, uncapped, each entry naming its `store`)
    felt session                                   # SessionStart context as plain text
    felt tree [<id>] [-L depth]                    # containment hierarchy; -L caps depth (1 = direct children)
    felt show <id>                                 # full
    felt show <id> -d compact | -d summary         # metadata/outcome/body size/extra keys | + lede + back-refs
    felt show <id> --body                          # body with start line
    felt show <id> --citations|--consumers         # narrative back-refs | data-flow consumers
    felt show <id> --field <key>                   # one raw frontmatter key, shell-friendly

A thread resolved. Close:
    felt edit <id> --status closed --outcome "what was learned"

Reshape:
    felt nest <child> <parent>
    felt unnest <id>

Maintain:
    felt check                                     # broken refs, broken data-flow refs, layout issues
    felt migrate [--dry-run]                       # normalize legacy layout
```

Runtime and installation truth:

```
felt setup receipt --json                  # actually loaded bundles, felt binary, hooks, daemon contract
felt setup validate --source <checkout>    # non-mutating complete local candidate check
```

Local paths and remote GitHub refs for Claude/Codex setup are validated, staged,
and promoted as one recoverable local generation before the native harness CLI
activates them. Remote acquisition is disposable; the harness still owns its
cache and configuration. Interrupted native activation is reconciled from the
restored last-known-good generation before setup continues. Each promoted
payload carries source/ref/commit/build/digest identity into the harness cache,
and a promotion only commits after the cache the native CLI reports as loaded
proves it holds that generation — a zero exit status alone is rolled back.
`setup receipt` queries the harness CLIs, recomputes both payload digests,
binds the marker's felt build to the resolved executable, and rejects a
pending journal or identity disagreement. An incidental cache directory is
not proof that a bundle is loaded.

Statuses: · none (the default — most fibers stay here)  ○ open (todo)  ◐ active (in flight)  ● closed (resolved todo). Status is opt-in: never pass `-s` on `felt add` unless someone should do something.
Detail: name < compact < summary < full. Summary adds the lede (first paragraph of the body; write it to stand alone).
Relationships: directory containment, `[[wikilinks]]` in bodies, and optional project-owned data-flow conventions. Nested IDs use paths (bao-analysis/damping-prior).

Stores and views: a project whose `.felt` symlinks into the loom is a *view* on that store, not a fence around it. `felt ls` lists the view; `felt find` searches the whole store; an id reaches anywhere — `show`, `edit`, `rm`, `nest`, `felt shuttle <verb>` all act on the fiber where it lives and say `(in <root>)` when that is elsewhere. So: looking for something you know is in the loom somewhere, use `find`; asking what am I working on here, use `ls`.

**Outcomes longer than a sentence:** edit `.felt/<path>/<slug>.md` directly using a `|-` block scalar (`outcome: |-`). `felt edit -o "…"` shell-escapes quotes and mangles multiline content; block scalar takes content literally so paragraphs, lists, and image embeds round-trip cleanly.

---

## Philosophy

**File while working.** The moment to update a fiber is right after something crystallizes, while the user reads and the understanding still has edges.

**Follow the understanding.** Don't ask permission to file. The user's corrections and opinions are the primary trigger; when the direction shifts, the fiber should shift too.

**Status is opt-in.** Most fibers never get one. A finding, a decision, a recipe, a note — those exist by being filed. `open`/`active` means *someone should do something*; if nobody should, leave it statusless. Don't file empty stubs "for later" — file when the work is real. When an outcome reads complete ("landed", "CONVERGED", "decisions closed"), close in the same motion, or the fiber shouldn't have been open.

**Use the substrate cleanly.** Names are concise labels — body and outcome carry the content. Nest for containment, `[[wikilinks]]` for narrative, project-owned conventions for anything more specific. Never hand-edit `created-at` / `updated-at`: felt stamps them on every write (a manual value is silently overwritten); edit only content fields.

**Links in prose, not in piles.** A `[[wikilink]]` earns its place by doing work in a sentence — naming what the other fiber is, why it's relevant here, where to head next. Related-things lists at the bottom of a fiber are a smell that the relationships haven't been thought through; fold them into the body where they belong, or drop the ones that aren't earning the link.

**Bodies describe the now.** A fiber's body says what's true currently — not how it got that way. Edit the body by correction; chronology lives in the git log of the fiber file (fibers are git-synced), not in the prose. Version markers ("v1", "v2"), dated update notes ("✓ Updated 2026-05-18"), and repurposing framings ("originally added for X, now Y") are signs that history-shaped content is sedimenting where a correction belongs. The exception is fibers whose subject *is* chronology (postmortems, decision logs, change histories) — those genuinely belong in the body.

**Extract what slipped through.** Continuous filing catches most things. At session end, mine decisions, patterns, and findings that were left implicit.

**Outcomes teach.** An outcome that says "done" has failed. Put the conclusion in — what was learned, what was decided, why — in a sentence that stands alone: it's what `felt ls` and `-d compact` show.

**Act on Session Attention.** When `felt session` shows `## Attention`, treat it as standing authority to do obvious gardening without asking: nest top-level leaves under root buckets, demote open/active container fibers, close stale todos, consolidate clutter. Surface it to the user only when cleanup needs judgment or would distract from the current task.

**Consolidate over time.** Quick fibers become noise. Read the assemblage periodically and compost stale fibers into doc fibers, fix coherence across siblings, reshape branching. When closing, ask whether the lesson belongs in a doc fiber or the root fiber — compose upward.

**Write to the commons.** When the store carries a root `commons` fiber, that is the ecology's own surface — where sessions spread across machines and months accrete what the swarm learns about itself: capability and calibration observations ("each task is a data point about resources and capabilities"), cross-session patterns no single fiber owns, proposals for how we work, letters to workers who don't exist yet. It is not a report surface (reports reach the human) and not a task surface (that's the kanban); it is the third thing, and it is not graded. If a session taught you something about the *ecology* — not the project — leave it there, and leave the commons more coherent than you found it.

**CLAUDE.md stays lean.** Commands, paths, context pointers. Documentation fibers carry the depth.

**Cross-project stores are useful.** A `.felt/` store can be symlinked into a cross-project store so `felt -C <store> ls` searches every linked project; see [cross-project.md](references/cross-project.md) for direction choice and safe setup.

---

## What to Extract

### Quick fibers

| Category | What to capture |
|----------|-----------------|
| **Decision** | Choice made, alternatives, reasoning. Include "decided NOT to." |
| **Question answered** | What was figured out. Mechanism, cause, how. |
| **Pattern** | Architectural insight, convention, workflow. |
| **Finding** | What was built, measured, produced. |

These land statusless (`felt add` default). Only unanswered questions and real todos get `-s open`.

### Documentation fibers

| Category | What to capture |
|----------|-----------------|
| **Reference doc** | Accumulated understanding. Architecture, philosophy, decision trees. |
| **How-to** | Procedures that get reused. More depth than CLAUDE.md. |

### Additional YAML fields

Fibers may carry project-owned top-level YAML fields beyond what felt parses natively. Scalar keys can be set from the CLI (`felt edit <id> --set key=value` / `--unset key`); structured blocks are edited in the fiber file directly. Either way, keep the ordinary felt surfaces current alongside them: `outcome` for latest state, sub-fibers for durable findings.

### Companion files (`report.html`, plots, recordings)

Fibers can carry arbitrary companion files in their directory alongside `<slug>.md`, and the body can inline any of them where it helps the reader with a `:::{embed} <path>` directive (renderer by extension: PDF, HTML iframe, images, audio). The one named convention: a fiber's rich human-facing report lives in a companion `report.html`, rendered by an explicit `:::{embed} report.html` line placed where the reader should meet it. Embed syntax and worker-side `report.html` conventions live in the shuttle skill.

---

## References

Read the reference that matches the situation. Everything above applies always; references go deeper for specific activities.

| When | Reference |
|------|-----------|
| Helping fuzzy thought crystallize into a fiber — two diamonds, stances, funnel, ambiguity check | [ideating.md](references/ideating.md) |
| Drafting a constitution — pointers not snapshots, desired state, launch | [constitution.md](references/constitution.md) |
| At the end of a session — extracting what slipped through | [mining.md](references/mining.md) |
| Processing an external transcript — meeting notes, voice note, dictation file | [transcripts.md](references/transcripts.md) |
| Acting on `felt session` Attention or reading across the assemblage for mess — gardening, composting, coherence, reshaping | [maintenance.md](references/maintenance.md) |
| Migrating legacy flat fibers to directory format | [migration.md](references/migration.md) |
| Setting up a cross-project felt store, or linking a per-project store into one | [cross-project.md](references/cross-project.md) |
