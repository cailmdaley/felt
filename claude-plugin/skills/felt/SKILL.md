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

# felt

felt is a memory store of Markdown files kept in Git. Each *fiber* is one thing worth keeping track of — a todo, a decision, a finding, a spec, a reference note — in its own folder under `.felt/`, and folders nest:

```
.felt/bao-analysis/
├── bao-analysis.md
└── damping-prior/
    ├── damping-prior.md
    └── sigma-scan.png
```

That fiber's id is its path, `bao-analysis/damping-prior`, or its slug `damping-prior` alone when unique. `damping-prior.md`:

```markdown
---
name: BAO damping scale in the fiducial fit
status: closed
tags: [decision]
outcome: Fixed Σ_nl at the simulation-calibrated 5.5 Mpc/h — freeing it widens the α error ~30% with no shift in the mean.
---

The fiducial fit in [[bao-analysis]] needs a value for the damping scale Σ_nl, degenerate with the peak amplitude at our signal-to-noise.

Freed, Σ_nl runs to the prior edge in a third of the mocks ([[bao-analysis/mock-validation]]):

![Σ_nl scan](sigma-scan.png)
```

- **path** — containment: this fiber belongs to `bao-analysis`. `felt tree` walks it; `felt nest` changes it.
- **outcome** — the conclusion in one sentence that stands alone: what was learned or decided, and why. Listings lead with it, so "done" is a failed outcome.
- **status** — opt-in, for todos: ○ `open`, ◐ `active`, ● `closed`. A finding or decision recorded after the fact has none. `felt ls` lists open and active fibers.
- **body** — opens with a lede readable alone (`felt show -d summary` shows only that). `[[wikilinks]]` sit in the sentence that says why the link matters.
- **companion files** — plots, PDFs, reports sit beside the markdown and move with it.
- **your own fields** — any frontmatter a project needs survives every edit (`--set key=value`, or edit the file). An `inputs:` entry with `from: <fiber>` declares a data-flow edge (`felt show <id> --consumers`).
- **stamps** — `id:` (a ULID that survives moves), `created-at`, `updated-at`, `closed-at` are felt's; leave them alone.

A bare `.felt/<slug>.md` at a store's root is the project's entry point. A project's `.felt` may be a symlink into a larger shared store: `felt ls` and `tree` stay in the project's view, `felt find` searches the whole store, and any id works with `show` and `edit`.

## Commands

```
felt show <id>                              # read by address (-d compact | summary)
felt find "word"                            # does a fiber on this exist? whole store; --body for bodies
felt tree -L 1                              # orient
felt add <parent>/<slug> "name" -o "outcome" [-t tag] [-s open]
felt edit <id> -s closed -o "what was learned"
felt ls [-t tag]                            # open and active work
felt sync / felt sync --push                # merge the store's upstream / publish
```

`felt <verb> --help` has the rest. Edit bodies and long outcomes in the file itself (`.felt/<path>/<slug>.md`); put a multi-sentence outcome in a `|-` block scalar.

## Practice

**Sync first; commit your own files.** `felt sync` before substantive work. Other sessions write to the same store, so commit only the fibers you changed, by path, then `felt sync --push`. Resolve conflicts from context; never discard another session's edits, and report a sync you couldn't complete.

**Search before you file.** When a fiber already holds the concern, extend it; a second one splits its history.

**File while it's fresh.** When a decision, finding or correction from the user lands, file it under its parent then, without asking — reconstructed later, it has drifted. No empty stubs.

**Correct, don't append.** A body says what is true now. When understanding moves, rewrite the sentences it moved, outcome first; git holds the history. No "Update:" paragraphs or "v2" markers.

**Sweep before you leave.** File what stayed implicit — including what you decided *not* to do — and bring the outcome and status of every fiber you touched up to date.

**Tidy where you touch.** Open and active mean todo; close what's stale, and drop status from containers. Ask before deleting fibers or merging where the synthesis needs domain judgment. For a larger pass — regrouping, consolidating — read [references/tending.md](references/tending.md).
