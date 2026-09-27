---
name: felt
description: >
  Use whenever working in a project that contains a `.felt/` directory — read it before other
  tools — and whenever the user mentions fibers or asks to "file this", "record a decision",
  "close this fiber", "update the outcome", "clean up fibers", "consolidate", "archive", "sweep",
  "maintenance pass", or "extract from the session". Covers what a fiber is, filing and searching,
  keeping outcomes and bodies current, project-specific frontmatter, syncing the store, the
  end-of-session sweep, and tending the tree.
---

# felt — Working with Fibers

A fiber is one concern — a task, decision, question, finding, or spec — kept as a markdown file with YAML frontmatter. Fibers live in a `.felt/` directory, one folder each, and folders nest:

```
.felt/
└── bao-analysis/
    ├── bao-analysis.md
    └── damping-prior/
        ├── damping-prior.md
        └── sigma-scan.png
```

The fiber in `damping-prior/` is addressed as `bao-analysis/damping-prior` — or just `damping-prior`, since a bare slug resolves when it is unique in the store.

## Anatomy of a fiber

Here is `damping-prior.md`:

```markdown
---
name: BAO damping scale in the fiducial fit
status: closed
tags: [decision]
outcome: Fixed Σ_nl at the simulation-calibrated 5.5 Mpc/h — freeing it widens the α error by ~30% with no shift in the mean, so the fixed value buys precision without bias.
---

The fiducial fit in [[bao-analysis]] needs a value for the nonlinear damping scale Σ_nl, which is degenerate with the peak amplitude at our signal-to-noise.

Freed under a flat prior, Σ_nl runs to the prior edge in a third of the mocks ([[bao-analysis/mock-validation]]) and α's error grows by ~30%, while the mean α moves by less than 0.1σ:

:::{embed} sigma-scan.png
:::

Decided *not* to use a Gaussian prior instead: it reproduces the fixed-value result at extra sampler cost.
```

- **path** — the fiber's address and its first relationship: this fiber belongs to `bao-analysis`. `felt tree` walks containment; `felt nest` changes it.
- **name** — a short label. Content goes in the outcome and body, not here.
- **outcome** — the conclusion in a sentence that stands alone: what was learned or decided, and why. `felt ls`, `felt show -d compact` and the shuttle board all lead with it, so an outcome reading "done" has failed its readers.
- **status** — this fiber was a todo: filed `open` when the question came up, closed with its outcome once answered. The three statuses are ○ `open` (to do), ◐ `active` (in flight) and ● `closed` (resolved), and `felt ls` lists the open and active ones. Status is opt-in and means *someone should act*. A finding or decision filed after the fact is complete the moment it is written and carries no status — most fibers never have one.
- **tags** — free labels for filtering (`felt ls -t decision`). A `due: YYYY-MM-DD` date (`-D`) is the other optional native field.
- **body** — opens with a lede: a paragraph that says what this is and where it sits, readable alone, since `felt show -d summary` shows it without the rest. Detail follows. `[[wikilinks]]` are the second relationship, and they work inside sentences — the link to `mock-validation` says what that fiber shows and why it matters here.
- **companion files** — plots, PDFs, recordings, a `report.html` — sit in the fiber's folder beside the markdown, travel with it through nest and sync, and are inlined where they help with `:::{embed} <path>` (paths relative to the folder). The shuttle board renders embeds; the CLI treats them as text.
- **your own fields** — add any frontmatter your project needs and felt keeps it intact through every edit: `felt edit <id> --set key=value` for scalars, the file for anything structured; `felt show <id> --field key` reads one back. One such convention felt reads itself: an `inputs:` list whose `from:` names another fiber is a data-flow edge — `felt show <id> --consumers` gives the reverse, and `felt check` flags a broken one.
- **felt's own stamps** — felt also writes a ULID `id:` (identity that survives moves and renames) and `created-at`, `updated-at` and `closed-at` into the frontmatter. Leave them alone; a hand-typed value is overwritten on the next write.

## Stores and sync

`felt init` creates a store at a project root. A single bare `.felt/<slug>.md` at the store root is the project's entry-point fiber — its front door, where the understanding that matters across the whole project ends up.

A project whose `.felt` symlinks into a larger store is a *view*, not a fence: `felt ls` and `felt tree` stay in the view, `felt find` searches the whole store, and an id from anywhere in it works with `show`, `edit` and `nest`, which act on the fiber where it lives and say `(in <root>)` when that is elsewhere. `-C <dir>` runs any verb as if from `<dir>`. Linking a project into a store is a one-time setup with a data-loss trap; follow https://cailmdaley.github.io/felt/concepts/cross-project/.

Before substantive work, run `felt sync` to merge the store's Git upstream; it follows a view to the real store. Other sessions write to the same store, so commit only the fibers you changed, then `felt sync --push` at useful checkpoints. Resolve conflicts with the context you have and retry; never pick a side mechanically or discard another worker's edits, and report a failed sync rather than treating local content as current.

## Working paths

`felt --help` and `felt <verb> --help` carry the full reference. The paths worth knowing without looking:

```
felt add <slug> "name" -t tag -o "outcome"   # file; a/b lands under an existing a
felt add <slug> "name" -s open              # file a todo
felt edit <id> -s closed -o "what was learned"
felt ls                                     # open and active work in this view
felt ls "query"                             # search names, outcomes, fields; closed hits counted, -s closed shows them
felt ls --body "query"                      # search bodies too
felt find "query"                           # search the whole store
felt show <id> -d compact|summary|full      # outcome and metadata | + lede, links both ways | everything
felt show <id> --citations                  # what links here
felt tree <id> -L 2                         # containment around a fiber
felt nest <child> <parent>                  # move a subtree
felt check                                  # broken links and layout problems
felt session                                # reprint the session-start context
```

Bodies, long outcomes and structured fields are edited in the file itself — Read, then Edit `.felt/<path>/<slug>.md`; a hook stamps `updated-at` for you. (`felt edit -b` replaces the whole body, so it only suits one-liners.) An outcome longer than a sentence goes in a `|-` block scalar, since `-o "…"` mangles quotes and newlines. `felt nest` does not rewrite `[[wikilinks]]` that spell out the old path; fix them by hand.

---

## Practice

**Search before you file.** `felt find` the topic first. When a fiber already holds the concern, extend or correct it; a second fiber on the same question splits its history and its links.

**File while working.** The moment to file is right after something crystallizes, while the understanding still has edges — reconstructed later, it has already drifted. Don't ask permission: the user's corrections and opinions are the primary trigger, and when the direction shifts, the fiber shifts with it. Don't file empty stubs "for later"; file when the work is real, under the parent it belongs to.

**Correct, don't append.** A body says what is true now. When understanding moves, rewrite the sentences it moved — the outcome first — rather than adding a dated note underneath; the history is in the fiber's git log. Version markers ("v2"), "Update 2026-05-18" paragraphs and "originally for X, now Y" framings are sediment where a correction belongs. Fibers whose subject *is* a history — a postmortem, a decision log — are the exception. When an outcome reads complete, close the fiber in the same edit; if nothing was ever left to do, it should not have had a status. And a list of links at the bottom of a body usually means the relationships haven't been thought through yet — fold each link into the sentence where it does work, or drop it.

**Put knowledge where it will be found.** CLAUDE.md and AGENTS.md load into every session, so they carry commands, paths and pointers to fibers, and stay short. Fibers carry the depth: the architecture, the reasoning, the recipe you will need again.

**Sweep before you close out or hand off.** Continuous filing catches most things; the rest gets filed before you leave. Reread the session for what stayed implicit — decisions (including what you decided *not* to do, and why), questions answered, patterns, findings — and file each under its parent, statusless unless someone should act. Then bring the outcome and status of every fiber you touched up to date.

**Tend the store as you go.** Tidying is part of every session, and you have standing permission for it: when you touch a region of the store and see mess, fix it in the same motion, and when the session context shows `## Attention`, clear it this session. Mention a cleanup only when it needs judgment or would derail the current task; larger passes suit a background subagent while you keep working. Good shape:

- **Open and active mean todo** — not important or canonical. Demote open/active containers and keep their actionable children tracked; close stale todos with an outcome that can be stated now.
- **The tree stays walkable.** Top level under about 20 entries; a parent past 5–7 children wants grouping nodes (`felt nest`). Name groups for categories future fibers will reuse (`performance`, `setup`), never temporary ones (`misc`).
- **Understanding composes upward**, from quick fibers to a doc fiber to the entry-point fiber. Compost a cluster by reading the siblings side by side, writing the doc fiber as what is true now, and closing each source with `-o "Consolidated into [[<topic>]]."`
- **Ask first** before deleting fibers with possible historical value, merging where the synthesis needs domain judgment, moving private fibers across roots, or changing what a project's own fields mean. Prefer the reversible move — nest rather than delete, close rather than remove — run `felt check` after reshaping, and commit each reshape with a message that explains it.
