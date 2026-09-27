---
name: felt
description: >
  This skill should be used whenever working in a project that contains a `.felt/` directory, and
  when the user mentions fibers or asks to "file this", "record a decision", "add structure",
  "close this fiber", "clean up fibers", "consolidate", "archive", "sweep", "maintenance pass", or "extract from the
  session". It covers filing fibers, updating outcomes and bodies, using additional YAML fields
  beyond what felt owns natively, end-of-session sweeps, and maintenance passes.
---

# felt — Working with Fibers

Fibers are concerns (tasks, decisions, questions, findings, specs) stored as directory-contained markdown — YAML frontmatter plus a body at `.felt/<id>/<slug>.md`, where the id is the nested path (`bao-analysis/damping-prior`). Their relationships come from containment by path, `[[wikilinks]]` in the body, and optional project-owned conventions such as `inputs.from` for data-flow edges. felt owns the substrate — files, native metadata, search, links — and preserves any extra top-level YAML fields a project adds without interpreting them.

Proactive filing. Retroactive extraction. Consolidation over time. Coherence when needed.

## Working paths

`felt --help` and `felt <verb> --help` carry the full reference. The paths worth knowing without looking:

```
felt add <slug> "name" -t tag -o "one-line outcome"   # file; nests under an existing parent by slug path
felt edit <id> -o "what was learned" -s closed        # conclude a thread
felt ls                                               # open/active work in this view
felt ls "query"                                       # search this view (closed matches counted, not shown)
felt find "query"                                     # search the whole store, across views
felt show <id> -d summary                             # metadata, outcome, lede, back-refs
felt tree <id> -L 2                                   # containment around a fiber
felt nest <child> <parent>                            # reshape
felt check                                            # broken links, layout issues
felt sync  /  felt sync --push                        # merge the store's upstream / publish
```

Bodies, long outcomes, and structured frontmatter: Read then Edit `.felt/<id>/<slug>.md` directly. Use a `|-` block scalar for an outcome longer than a sentence — `-o "…"` mangles quotes and newlines. Never hand-edit `created-at` / `updated-at`; felt stamps them on every write. Scalar project fields can be set with `felt edit <id> --set key=value` / `--unset key`.

**Statuses:** · none (the default — most fibers stay here) ○ open (todo) ◐ active (in flight) ● closed (resolved). `open`/`active` mean *someone should do something*; a finding, decision, recipe, or note exists by being filed and stays statusless. Never pass `-s` on `felt add` unless someone should act, and close in the same motion when an outcome reads complete.

**Stores and views.** A project whose `.felt` symlinks into a larger store (the loom) is a *view*, not a fence: `felt ls` lists the view, `felt find` searches the whole store, and an id reaches anywhere — `show`, `edit`, `nest`, `felt shuttle <verb>` act on the fiber where it lives and say `(in <root>)` when that is elsewhere. Linking a new project into a store is a one-time setup with a data-loss trap; follow https://cailmdaley.github.io/felt/concepts/cross-project/.

**Sync.** Before substantive work, run `felt sync` to merge the store's Git upstream (it follows a symlinked view to the real store). Edit local files, commit intentional changes, and `felt sync --push` at useful checkpoints. Resolve relevant conflicts with context and retry; never pick ours/theirs mechanically or discard another worker's edits. Report a failed sync rather than treating local content as current.

**Companion files** (plots, recordings, a `report.html`) live in the fiber's directory beside `<slug>.md`; the body inlines any of them with a `:::{embed} <path>` line (syntax in the shuttle skill).

---

## Practice

**File while working.** The moment to update a fiber is right after something crystallizes, while the understanding still has edges. Don't ask permission to file: the user's corrections and opinions are the primary trigger, and when the direction shifts, the fiber shifts too. Don't file empty stubs "for later" — file when the work is real.

**Sweep the session before you close out or hand off.** Continuous filing catches most things; the rest gets filed before you leave. Reread the session for what stayed implicit — decisions (including what you decided *not* to do, and why), questions answered, patterns, findings — and file each under the parent it belongs to, statusless unless someone should act. Then bring the outcome and status of every fiber you touched up to date. An outcome that says "done" has failed: put the conclusion in — what was learned, what was decided, why — in a sentence that stands alone, because it is what `felt ls` shows. Names are concise labels; body and outcome carry the content.

**Tend the store as you go.** Tidying is part of every session, and you have full standing permission for it: whenever you touch a region of the store and see mess, fix it in the same motion, and when `felt session` shows `## Attention`, clear it this session. Don't ask first; mention a cleanup only when it needs judgment or would derail the current task. Larger passes suit a background subagent while you keep working. What good shape looks like:

- **Open and active mean todo** — not important or canonical. Demote open/active containers and keep their actionable children tracked; close stale todos with an outcome that can be stated now (`felt edit <id> -s closed -o "…"`).
- **The tree stays walkable.** Top level under about 20 entries; a parent past 5–7 children wants grouping nodes (`felt nest`). Name buckets for categories future fibers will reuse (`performance`, `setup`), never temporary ones (`misc`).
- **Understanding composes upward**: quick fiber → doc fiber → root fiber. Compost a cluster by reading the siblings side by side, writing the doc fiber as what is true now, and closing each source with `-o "Consolidated into [[<topic>]]."`
- **Ask first** before deleting fibers with possible historical value, merging where the synthesis needs domain judgment, moving private fibers across roots, or changing project-owned YAML semantics. Prefer the reversible move — nest rather than delete, close rather than remove — and commit each reshape with a message that explains it.
