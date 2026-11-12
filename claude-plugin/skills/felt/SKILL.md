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
- **role** — who answers for open work ([Roles](#roles)).
- **stamps** — `id:` (a ULID that survives moves), `created-at`, `updated-at`, `closed-at` are felt's; leave them alone.

A bare `.felt/<slug>.md` at a store's root is the project's entry point. A project's `.felt` may be a symlink into a larger shared store: `felt ls` and `tree` stay in the project's view, `felt find` searches the whole store, and any id works with `show` and `edit`. Linking a project into a store has a data-loss trap: follow <https://cailmdaley.github.io/felt/concepts/cross-project/>.

felt is the notes and nothing else: this skill is all an agent needs to read, search and write a store, including one shared with other people. Launching agents, the board and messages between sessions belong to Shuttle, which has its own skill and is optional.

## Roles

`role: analyst/sam` says Sam answers for this open work, in the analyst office; a bare person, `role: sam`, is Sam's own desk. felt stamps open fibers created without a role with `git config felt.person` of the repository that holds them (set once per checkout of a shared store), and bare `felt ls` shows your own open work. Hand work over by editing the field: `felt edit <id> -R <person>`. An office's charter is `roles/<office>`, at the top of the store or of a repository linked in there, and `roles/<office>/<person>` is that person's instance: read the charter, then the instance if there is one. `felt roles` lists the offices; `felt show roles/<office>` finds a charter in either place.

## Commands

```
felt show <id>                              # read by address (-d compact | summary)
felt find "word"                            # does a fiber on this exist? whole store; body search is default
felt tree -L 1                              # orient
felt add <parent>/<slug> "name" -o "outcome" [-t tag] [-s open]
felt edit <id> -s closed -o "what was learned"
felt ls [-t tag]                            # your open and active work (--person all: everyone's)
felt roles                                  # the offices and their charters
felt sync / felt sync --push                # merge the store's upstream / publish
```

`felt <verb> --help` has the rest. Edit bodies and long outcomes in the file itself (`.felt/<path>/<slug>.md`); put a multi-sentence outcome in a `|-` block scalar.

Plain queries search bodies by default, placing name/slug hits before metadata hits and marking body-dependent hits; `--no-body` restores the metadata-only scope.

## Practice

**Keep the archive together.** Before `felt sync`, commit the store's dirty fiber changes, whoever wrote them, including daemon lifecycle writes; mixed commits are fine. A subtree that is a link into another repository is committed in that repository (`git add .felt` in the store stops at the link); sync covers both and names a mounted repository that holds uncommitted changes. Then sync before substantive work and publish with `felt sync --push`. The agent running sync owns resolving conflicts from context. Never discard another session's edits, and report a sync you couldn't complete. The daemon never runs Git or commits; agents maintain the archive.

**Search before you file.** When a fiber already holds the concern, extend it; a second one splits its history.

**File while it's fresh.** When a decision, finding or correction from the user lands, file it under its parent then, without asking — reconstructed later, it has drifted. No empty stubs.

**Correct errors; date outgrown beliefs.** A body says what is true now, outcome first. A value that was never right is an error: correct it in place; git holds the history. A belief that was right when written and has since been outgrown is part of the record: keep it, dated, with a link to what replaced it. No "Update:" paragraphs or "v2" markers.

**Sweep before you leave.** File what stayed implicit — including what you decided *not* to do — and bring the outcome and status of every fiber you touched up to date.

**Tidy where you touch.** Open and active mean todo; close what's stale, and drop status from containers. Ask before deleting fibers or merging where the synthesis needs domain judgment. For a larger pass — regrouping, consolidating — read [references/tending.md](references/tending.md).
