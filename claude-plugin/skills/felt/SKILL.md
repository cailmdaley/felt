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

A fiber is one concern — a task, decision, question, finding, or spec — kept as a markdown file with YAML frontmatter. Fibers live in a `.felt/` directory, one folder each, and nest: `.felt/bao-analysis/damping-prior/damping-prior.md` is the fiber whose id is `bao-analysis/damping-prior`.

## Anatomy of a fiber

```markdown
---
name: Fix the BAO damping scale in the fiducial fit
tags: [decision]
outcome: Fixed Σ_nl at the simulation-calibrated 5.5 Mpc/h — freeing it widens the α error by ~30% with no shift in the mean, so the fixed value buys precision without bias.
---

The fiducial fit in [[bao-analysis]] needs a value for the nonlinear damping scale Σ_nl, which is degenerate with the peak amplitude at our signal-to-noise.

Freed under a flat prior, Σ_nl runs to the prior edge in a third of the mocks ([[bao-analysis/mock-validation]]) and α's error grows by ~30%, while the mean α moves by less than 0.1σ. Decided *not* to use a Gaussian prior instead: it reproduces the fixed-value result at extra sampler cost.
```

- **id** — the path. Containment is the first relationship: this fiber sits under `bao-analysis`, and `felt tree` walks the hierarchy.
- **name** — a short label.
- **outcome** — the conclusion, in a sentence that stands alone: what was learned or decided, and why. It is what `felt ls` shows, so "done" is a failed outcome.
- **status** — absent here, which is the default. Status is opt-in and means someone should act: ○ `open` a todo, ◐ `active` in flight, ● `closed` resolved. A decision, finding, or note exists by being filed and needs none.
- **tags** — free labels for filtering (`felt ls -t decision`).
- **body** — opens with a paragraph that says what this is and where it sits, readable alone (`felt show -d summary` shows it); detail follows. `[[wikilinks]]` are the second relationship, and they earn their place inside sentences.
- **your own fields** — add any frontmatter a project needs; felt keeps it intact (`felt edit <id> --set key=value` for scalars). `created-at` / `updated-at` are felt's, stamped on every write — never hand-edit them.
- **companion files** — plots, recordings, a `report.html` — sit beside `damping-prior.md` and are inlined in the body with a `:::{embed} <path>` line (syntax in the shuttle skill).

## Stores and sync

A project whose `.felt` symlinks into a larger store is a *view*, not a fence: `felt ls` lists the view, `felt find` searches the whole store, and an id reaches anywhere — `show`, `edit`, `nest` act on the fiber where it lives and say `(in <root>)` when that is elsewhere. Linking a project into a store is a one-time setup with a data-loss trap; follow https://cailmdaley.github.io/felt/concepts/cross-project/.

Before substantive work, run `felt sync` to merge the store's Git upstream (it follows a view to the real store). Commit intentional changes and `felt sync --push` at useful checkpoints. Resolve conflicts with context and retry; never pick a side mechanically or discard another worker's edits, and report a failed sync rather than treating local content as current.

## Working paths

`felt --help` is the reference — read it once in a session before leaning on felt; `felt <verb> --help` has each verb's flags and examples. The paths worth knowing without looking:

```
felt add <parent>/<slug> "name" -o "one-line outcome"   # file where it belongs
felt edit <id> -o "what was learned" -s closed          # conclude a thread
felt ls "query"   /   felt find "query"                 # search this view / the whole store
felt show <id> -d summary                               # outcome, lede, back-refs
felt tree <id> -L 2                                     # containment around a fiber
```

Bodies, long outcomes, and structured fields: Read then Edit the fiber's file directly. An outcome longer than a sentence goes in a `|-` block scalar — `-o "…"` mangles quotes and newlines.

---

## Practice

**File while working.** The moment to update a fiber is right after something crystallizes, while the understanding still has edges. Don't ask permission to file: the user's corrections and opinions are the primary trigger, and when the direction shifts, the fiber shifts too. Don't file empty stubs "for later" — file when the work is real.

**Sweep the session before you close out or hand off.** Continuous filing catches most things; the rest gets filed before you leave. Reread the session for what stayed implicit — decisions (including what you decided *not* to do, and why), questions answered, patterns, findings — and file each under the parent it belongs to, statusless unless someone should act. Then bring the outcome and status of every fiber you touched up to date.

**Tend the store as you go.** Tidying is part of every session, and you have full standing permission for it: whenever you touch a region of the store and see mess, fix it in the same motion, and when `felt session` shows `## Attention`, clear it this session. Don't ask first; mention a cleanup only when it needs judgment or would derail the current task. Larger passes suit a background subagent while you keep working. What good shape looks like:

- **Open and active mean todo** — not important or canonical. Demote open/active containers and keep their actionable children tracked; close stale todos with an outcome that can be stated now (`felt edit <id> -s closed -o "…"`).
- **The tree stays walkable.** Top level under about 20 entries; a parent past 5–7 children wants grouping nodes (`felt nest`). Name buckets for categories future fibers will reuse (`performance`, `setup`), never temporary ones (`misc`).
- **Understanding composes upward**: quick fiber → doc fiber → root fiber. Compost a cluster by reading the siblings side by side, writing the doc fiber as what is true now, and closing each source with `-o "Consolidated into [[<topic>]]."`
- **Ask first** before deleting fibers with possible historical value, merging where the synthesis needs domain judgment, moving private fibers across roots, or changing project-owned YAML semantics. Prefer the reversible move — nest rather than delete, close rather than remove — and commit each reshape with a message that explains it.
