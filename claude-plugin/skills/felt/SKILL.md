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

A fiber is one thing worth keeping track of — a todo, a question, a decision, a finding, a spec, a reference note — kept as a markdown file with YAML frontmatter. Fibers live in a `.felt/` directory, one folder each, and folders nest:

```
.felt/
└── bao-analysis/
    ├── bao-analysis.md
    └── damping-prior/
        ├── damping-prior.md
        └── sigma-scan.png
```

The fiber in `damping-prior/` is addressed by its path, `bao-analysis/damping-prior`, or by its slug (the folder name) `damping-prior` alone when that is unique in the store. Commands that take an `<id>` accept either.

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

![Σ_nl scan across the mocks](sigma-scan.png)

Decided *not* to use a Gaussian prior instead: it reproduces the fixed-value result at extra sampler cost.
```

- **path** — the fiber's address, and the first of the ways fibers relate: containment. This fiber belongs to `bao-analysis`; `felt tree` walks containment and `felt nest` changes it.
- **name** — a short label. Content goes in the outcome and body, not here.
- **outcome** — the conclusion in a sentence that stands alone: what was learned or decided, and why. `felt ls` and `felt show -d compact` lead with it, so an outcome reading "done" has failed its readers.
- **status** — marks a todo, and is opt-in. This fiber was filed `open` when the question came up and closed with its outcome once answered. The values are ○ `open`, ◐ `active` (in flight) and ● `closed`, and `felt ls` lists the first two. A finding or decision recorded after the fact is complete as written and carries no status; most fibers never have one. A todo can also carry a `due: YYYY-MM-DD` date (`-D`).
- **tags** — free labels for filtering (`felt ls -t decision`).
- **body** — opens with a lede, like the first paragraph above: what this is and where it sits, readable alone, since `felt show -d summary` shows it without the rest. Detail follows. `[[wikilinks]]` are the second relationship, and they belong inside the sentence that says why the link matters, as with `mock-validation` above; a list of links at the bottom usually means the relationships haven't been thought through.
- **companion files** — plots, PDFs, recordings, a report — sit in the fiber's folder beside the markdown and travel with it through nest and sync. Link them from the body with a relative path, as the scan above is.
- **your own fields** — add any frontmatter your project needs and felt keeps it intact through every edit: `felt edit <id> --set key=value` for scalars, the file for anything structured, `felt show <id> --field key` to read one back. One convention felt reads itself: entries in an `inputs:` list with `from: <fiber>` declare a data-flow edge, a third relationship. `felt show <id> --consumers` lists the fibers that draw on this one, and `felt check` flags a `from:` that names no fiber.
- **felt's own stamps** — felt also writes a ULID `id:`, an identity that survives moves and renames and works as an `<id>` too, along with `created-at`, `updated-at` and `closed-at`. Leave them alone; a hand-typed value is overwritten on the next write.

## Stores and sync

`felt init` creates a store at a project root. One fiber breaks the folder rule: a bare `.felt/<slug>.md` at the store root is the project's entry-point fiber, where understanding that matters across the whole project collects.

When a project's `.felt` is a symlink into a larger store, the project sees a view of it. `felt ls` and `felt tree` stay inside the view, while `felt find` searches the whole store. An id from anywhere in the store works with `show`, `edit` and `nest`, which act on the fiber where it lives and print `(in <root>)` when that is outside the view. Linking a project into a store is a one-time setup with a data-loss trap; follow https://cailmdaley.github.io/felt/concepts/cross-project/.

Before substantive work, run `felt sync` to merge the store's Git upstream; it follows a view to the real store. Other sessions write to the same store, so commit only the fiber files you changed, by path rather than `git add -A`, then `felt sync --push` at useful checkpoints. Resolve conflicts with the context you have and retry. Never pick a side mechanically or discard another worker's edits, and report a failed sync rather than treating local content as current.

## Working paths

`felt --help` and `felt <verb> --help` carry the full reference. The paths worth knowing without looking:

```
felt add <slug> "name" -t tag -o "outcome"   # file; parent/slug files under an existing parent
felt add <slug> "name" -s open              # file a todo
felt edit <id> -s closed -o "what was learned"
felt ls                                     # open and active work in this view
felt ls "query"                             # search names, outcomes, fields; closed hits counted, -s closed shows them
felt ls --body "query"                      # search bodies too
felt find "query"                           # like ls "query", across the whole store (--body works here too)
felt show <id> -d compact                   # outcome and metadata
felt show <id> -d summary                   # + lede and links in both directions
felt show <id> --citations                  # only what links here
felt tree <id> -L 2                         # containment around a fiber
felt nest <child> <parent>                  # move a subtree; links it would break are rewritten
felt check                                  # broken links and layout problems
felt session                                # reprint the session-start context
felt -C <dir> <verb>                        # run as if from <dir>
```

Bodies, long outcomes and structured fields are edited in the file itself: Read, then Edit `.felt/<path>/<slug>.md`, and a hook stamps `updated-at` for you. (`felt edit -b` replaces the whole body, so it only suits one-liners.) An outcome longer than a sentence goes in a `|-` block scalar, since `-o "…"` mangles quotes and newlines.

---

## Practice

**Search before you file.** `felt find` the topic first. When a fiber already holds the concern, extend or correct it; a second fiber on the same question splits its history and its links.

**File while working.** The moment to file is right after something crystallizes, while the understanding still has edges; reconstructed later, it has already drifted. You don't need permission. The user's corrections and opinions are the strongest trigger, and when the direction shifts, the fiber shifts with it. Don't file empty stubs "for later"; file when the work is real, under the parent it belongs to.

**Correct, don't append.** A body says what is true now. When understanding moves, rewrite the sentences it moved, the outcome first, rather than adding a dated note underneath; the history is in the fiber's git log. Version markers ("v2"), "Update 2026-05-18" paragraphs and "originally for X, now Y" framings are sediment where a correction belongs. Fibers whose subject *is* a history, such as a postmortem or a decision log, are the exception. When an outcome reads complete, close the fiber in the same edit.

**Put knowledge where it will be found.** CLAUDE.md and AGENTS.md load into every session, so they carry commands, paths and pointers to fibers, and stay short. Fibers carry the depth: the architecture, the reasoning, the recipe you will need again.

**Sweep before you close out or hand off.** Continuous filing catches most things; the rest gets filed before you leave. Reread the session for what stayed implicit — decisions (including what you decided *not* to do, and why), questions answered, patterns, findings — and file each under its parent, statusless unless someone should act. Then bring the outcome and status of every fiber you touched up to date.

**Tend the store as you go.** Tidying is part of every session, and you have standing permission for it. When you touch a region of the store and see mess, fix it in the same motion, and when the session context shows `## Attention`, clear it this session. Fix things without comment; tell the user about a cleanup only when it would derail the current task, and ask first for the cases below. Larger passes suit a background subagent while you keep working. Good shape looks like this:

- Open and active mean todo. A container marked open or active to look important loses its status, and its actionable children stay tracked. Close stale todos with an outcome that can be stated now.
- The tree stays walkable: top level under about 20 entries, and a parent past 5–7 children gets grouping fibers (`felt nest`). Name groups for categories future fibers will reuse (`performance`, `setup`), never temporary ones (`misc`).
- Understanding consolidates upward: quick fibers feed a topic fiber, and topic fibers feed the entry point. To consolidate a cluster, read the siblings side by side, write the topic fiber as what is true now, and point each source at it with `-o "Consolidated into [[<topic>]]."`, closing the ones that were todos.
- Ask first before deleting fibers with possible historical value, merging where the synthesis needs domain judgment, moving private fibers across roots, or changing what a project's own fields mean. Prefer the reversible move (nest rather than delete, close rather than remove), run `felt check` after reshaping, and commit each reshape with a message that explains it.
