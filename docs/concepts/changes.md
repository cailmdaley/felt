# Changes

A **change** captures what a committed head adds since it diverged from a base ref, with an optional story that explains a useful reading order.
It doesn't require a GitHub PR or GitLab MR.
`shuttle change` writes a `<name>.change.json` [companion file](companions.md) beside a fiber's Markdown document.
The bundle contains commits, file metadata and independently renderable hunks, so reading it needs neither Git nor the forge.

## Bake and open a snapshot

```bash
shuttle change review-task --pr 42
shuttle change review-task --base origin/main
shuttle change review-task --base origin/main --head topic/change \
  --repo "$PWD" --story story.json --name walkthrough
```

`--repo` defaults to the fiber's `shuttle.project_dir`, then the current directory.
`--pr N` reads GitHub metadata through `gh pr view` and fetches from the PR's base repository, regardless of the checkout's remotes.
The exact head OID goes into `refs/shuttle/pr/N/head` and the base branch into `refs/shuttle/pr/N/base`; remote-tracking refs are untouched. Stacked PRs compare against their own base branch. A merged PR's base branch already contains it, so `--pr` then bakes the range it merged: the merge commit (`mergeCommit` from gh) into the head ref and its first parent into the base ref, which holds the PR's changes for merge and squash merges alike. It defaults the name to `pr-N` and cannot be mixed with `--base` or `--head`.
`--head` defaults to `HEAD`.
The filename defaults to the head ref with slashes replaced by hyphens and punctuation slugified; detached `HEAD` uses the fiber slug.
`--name walkthrough` writes `walkthrough.change.json`.
The write is atomic, and an invalid story leaves an existing bundle untouched.
A fiber doesn't need a `shuttle:` block, but a block naming another host is refused.
Run the command on the host holding that fiber and worktree.

Without `--pr` or `--base`, the fiber names its change (see [The change on open](#the-change-on-open)).
`--cache` writes the bundle to the host's cache instead of beside the fiber; the board's Change page bakes this way.

The bundle appears among the fiber's sent documents on the board; no Markdown embed or link is needed.
Open the fiber, then its **± change chip**.
A relative link to `walkthrough.change.json` in an HTML report also opens it in the reader, with Back returning to the report.
The reader has Story, Tests and Remaining lanes.
File roles appear on each file; generated files start folded.
Binary, mode-only and pure-rename changes have visible metadata markers even without text hunks.

The authored story lives beside its bundle as `<name>.story.json`. `--story path` copies that source into the sidecar on a successful bake; a bake without `--story` automatically reuses it. `--check` writes neither file.

When reapplying a saved story, a stop or flag is stale when its file is absent or its range no longer overlaps a diff hunk on the selected side.
It remains visible with a `stale` reason; stale stops have no resolved hunks and don't count as coverage.
A bake succeeds with stale references; `--check` reports them and exits nonzero.
A role override whose file has left the diff is dropped from the resolved story and reported.
With explicit `--story`, unsupported references and unknown role paths are authoring errors, not stale references.
Malformed ranges, sides, importance, duplicate chapter ids and invalid role values are always errors.

Rebake after changing commits or the story.
An open reader checks for rewritten bytes through the same conditional polling as other live documents.
The bundle is a snapshot, not a live branch view, and its line references describe the captured head.
It can contain private code; keep `*.change.json` out of a public fiber archive's Git history.
The CLI runs Git directly and makes no model calls.

## The change on open

Every constitution with a `shuttle.project_dir` has a **Change** page in its run of pages on the board, beside the fiber page.
Opening it asks the owner daemon to bake the change (`POST /api/v1/fibers/<id>/change`), which runs `shuttle change <fiber> --cache --json`, then reads the bundle through `/file` like any other.
Each opening bakes afresh, so the page shows the change as it stands.
A bake writes nothing in the felt store: the bundle goes to `$XDG_CACHE_HOME/felt/changes/<fiber-uid>/<name>.change.json` (`~/.cache` when unset), overwritten by the next bake.
An authored `<name>.story.json` beside the fiber is read, never written, and its relative images resolve against the fiber's directory.

An optional `change` map in the `shuttle:` block names the change:

```yaml
shuttle:
  project_dir: /path/to/checkout
  change:
    repo: code/sp_validation   # a checkout inside project_dir; default project_dir itself
    base: origin/develop       # the branch view's base; default the remote's default branch
    prs: [446]                 # GitHub PRs this card follows; replaces the branch view
```

With one PR, the Change page bakes it, as `--pr` bakes it; an explicit `--pr N` bakes another.
With two or more, the page opens on their list, read from GitHub through `shuttle change <fiber> --list` (`GET /api/v1/fibers/<id>/change`) without fetching or baking: each row gives the PR's number and title, head → base, its state (open, draft, merged, closed), its checks and its line counts, or the reason `gh` could not read it.
A row bakes its PR in the page, under a bar that leads back to the list and steps to the previous and next PR; a rebuild of the page, on Refresh or a return to it, re-bakes the PR left open.
A review sent from a PR's change opens by naming it, `PR #N <title>`, so the worker that follows several PRs knows which one it concerns.
Without them, the change is the checkout's branch **as it stands**: its commits since the merge base with `base` — by default `origin/HEAD`'s target, else `origin/main`, else `origin/master` — plus its uncommitted work.
Tracked edits and untracked files that `.gitignore` does not exclude, up to 1 MiB each, are staged into a copy of the index and committed with `git commit-tree` as one more commit, `Uncommitted changes`, on top of `HEAD`.
The worktree's own index and refs are never touched; the commit object lands in the object store and is collected like any unreachable object.
The snapshot commit takes `HEAD`'s identity and dates, so the same work bakes to the same commit and the reader keeps its viewed marks.
A worktree with no uncommitted work bakes `HEAD` itself.
`shuttle check` refuses an absolute `repo` or one outside `project_dir`, and a PR number below 1.

A change without a story opens on the text it already carries, its `description`: a PR's GitHub body, else the full messages of its commits, oldest first.
A change with no changed lines says so in one sentence naming its branch, base and head.

## Snapshot boundary

Git resolves the base and head to SHAs and finds their common ancestor with `git merge-base`.
Files, hunks and commits all compare that ancestor to head, like a pull request's three-dot diff (`base...head`).
Work added to the base after divergence doesn't appear reversed in the change.
No common ancestor is an error.
With `--base` or `--head`, dirty and untracked files are excluded; only the fiber-named branch view snapshots uncommitted work.

Capture pins diff formatting, three context lines, Myers alignment, rename detection and `core.bigFileThreshold=512m`.
A file-type change retains both Git sections, including a binary notice on either side.
An isolated bare Git repository ignores `.gitattributes` in both captured trees and the worktree, repository-local attributes and global attributes.
A file marked `-diff` gets a text patch if Git classifies its contents as text.
Files Git classifies as binary carry its binary notice rather than their contents.
NUL bytes and invalid UTF-8 render lossily; the reader isn't a byte-for-byte representation of arbitrary file contents.

## Version 2 bundle

The bundle has these fields:

| Field | Meaning |
|---|---|
| `version` | Schema version, `2`; other versions need a rebake |
| `title` | PR title with `--pr`; otherwise the story's optional title or head commit subject (the last real commit's subject for an uncommitted snapshot) |
| `description` | Optional Markdown: the PR body with `--pr`, else the commits' full messages, oldest first |
| `repo` | `{name, dir, forge_url}`; `dir` is absolute and `forge_url` is an HTTPS forge address without credentials, query, fragment or `.git`, otherwise `null` |
| `base`, `head` | Merge-base and resolved head SHAs |
| `base_ref`, `head_ref` | Requested refs; attached `HEAD` becomes the short branch name |
| `pr` | Optional `{number, title, url, head_branch, base_branch, state, draft, mergeable, checks, merge_commit}`; `merge_commit` is present once `state` is `MERGED`; checks counts `total`, `passed`, `failed`, `pending` |
| `stats` | `{files, additions, deletions}` for the entire diff; this and `pr` precede the large arrays |
| `commits` | Oldest first, each with `sha`, `subject`, `author` and RFC3339 author `time` |
| `files` | Repository-relative inventory, with destination paths for renames and old paths for deletions |
| `story` | Resolved story object, or `null` |
| `areas` | Conceptual groups with resolved `files`, changed `lines`, optional `what`, `chapter` and fallback `role` |

A file has `path`, `old_mode`, `new_mode`, `status`, `role`, `additions`, `deletions`, `header`, `lines`, `hunks` and `remaining`, plus `old_path` for renames.
`old_path` names the source path; `path` names the destination.
Modes are six-digit octal strings from Git's raw inventory, with `000000` for an absent side.
Different nonzero mode prefixes (the first three digits) identify file-type changes; other mode differences include executable-bit changes.
Statuses are `modified`, `added`, `deleted` and `renamed`; a file-type change is `modified`.
The header retains Git's metadata, including binary notices, rename paths and mode changes.
Empty changes have empty `commits` and `files` arrays.
Files without textual changes have empty `hunks` arrays and zero line counts.

Each file stores its source text once, in `lines`.
Each entry has `{kind, old, new, text}`; `kind` is `addition`, `deletion`, `context` or `note`, and absent-side line numbers are zero.
`text` omits the patch row's leading marker.

Each hunk has `{file, old_from, old_lines, new_from, new_lines, windows}`.
Each window has `{old_from, old_lines, new_from, new_lines, start, rows}`.
`start` is a zero-based offset into that file's `lines`; `rows` counts entries, including no-newline notes.
Windows hold at most 120 source rows plus an adjacent no-newline note.
Story stops and each file's `remaining` use the same hunk and window references, without copying text.
Remaining contains the changed lines no stop shows, with up to three adjacent context lines.
All collection fields are arrays, including when empty.

Go alone reads Git's diff and decides coverage.
The reader mounts nearby windows from these references and builds a small patch only when highlighting a visible window.
Large windows stay plain rather than tokenizing tens of thousands of characters on the UI thread.
Highlighting uses Shiki's WebAssembly engine, with readable structured rows as its fallback.
Generated files start folded.
Only the selected change has a reader: returning to the conversation removes its code DOM, observers, highlighter and source body cache.
An inactive change chip doesn't parse or mount the bundle.

## Write a story

```json
{
  "title": "Capture a committed snapshot",
  "overview": "This change keeps **committed trees** and their reading order together.",
  "areas": [
    { "name": "Snapshot", "what": "Pin the trees before reading their diff.", "files": ["src/**"], "chapter": "snapshot" }
  ],
  "flags": [],
  "chapters": [
    {
      "id": "snapshot",
      "title": "Resolve the snapshot boundary",
      "narrative": "Refs resolve before any tree is read.",
      "why_here": "The boundary explains the validation rules that follow.",
      "stops": [
        {
          "file": "src/snapshot.go",
          "from": 10,
          "to": 40,
          "side": "new",
          "note": "Both trees belong to this pair of commits.",
          "importance": "critical"
        }
      ]
    }
  ],
  "roles": { "src/protocol.generated.ts": "generated" }
}
```

Every change opens with a treemap above its title, sized by additions plus deletions, with the total changed lines and file count.
Name optional `areas` by concept for someone who has never seen the code; `what` gives each a short explanation.
`files` contains repository-relative globs (`*` within a directory, `**` across directories).
The first matching area owns each file; unmatched files fall into Tests, Generated, Docs, Config or Other by role.
Go resolves each area's paths and line count into the bundle; the reader only lays out those counts.
Tests and Generated are quieter tiles.
A tile's `chapter` jumps to that chapter; role tiles jump to their lane or first file.
Files with no changed text lines remain in the area's inventory but add no rectangle area.

`overview`, chapter `narrative` and stop `note` carry Markdown, including math and fenced `mermaid` diagrams.
Mermaid loads only when a fence is present, in its own chunk with separate diagram engines.
Diagrams take their colors from the board's paper, fill, ink and accent tokens and repaint with the workspace theme.
The same Markdown fences render natively in a GitHub PR body.
Chapters have unique ids and are ordered; `why_here` explains that order.
Stop importance is `critical`, `important`, `supporting` or `context`.
A flag uses the same file and range fields, plus `text` explaining a fact needing the human's judgment.
Flags render at the head of the story's opening, before the overview, and their file links open the relevant code.
Flags don't count toward coverage.
Omitted flags, chapters and role overrides are allowed and become empty collections.
Unknown JSON keys and duplicate chapter ids fail validation.

Stops and flags name inventory paths exactly, including the destination path on both sides of a rename.
`from` and `to` are inclusive file line numbers, not patch positions.
Supply both, or omit both for the whole file.
`side` defaults to `new`; use `old` for deleted files and deletion-only hunks.
A ranged reference must overlap a hunk on that side, including its context lines.
A side with zero lines has no position at which a ranged reference can land.
Whole-file references also work for binary, mode-only and pure-rename changes.

Files have one role: `implementation`, `test`, `generated`, `config` or `docs`.
Classification uses paths, including test, e2e, harness and fixture directories and language test filenames.
It doesn't inspect contents for generated-code comments.
`story.roles` overrides by exact inventory path; unknown role values fail validation.
Unknown paths fail for an explicit story and are dropped when reapplying a saved story.
The resolved role is shown on the file in the reader.

## Coverage means shown

```bash
shuttle change review-task --base origin/main --story story.json --check
shuttle change review-task --base origin/main --story story.json --check --json
```

Coverage counts **changed lines**: additions and deletions, each on its own side.
A changed line is shown when any stop’s range on that side includes it.
Stops combine across chapters; duplicates count once, and context-only stops count nothing.
A whole-file stop includes all changed lines on its selected side.
Go emits unshown changed lines as `remaining` excerpts with a little context, splitting around shown changes rather than repeating them.
Remaining renders exactly those excerpts, not the complete original hunks.
Tests stay in their own lane even when cited by the story.
Line counts and coverage exclude every file Git classifies as binary, including textual files above the pinned big-file threshold.
Binary, mode-only and pure-rename files have no text hunks, don't enter the denominator and remain visible in the inventory.

`--check` never writes.
Invalid story structure and invalid explicit story references fail the command and leave an existing bundle untouched.
Unsupported saved stop and flag references are retained as stale; `--check` returns nonzero for them, while a normal bake writes them with their reasons.
Normal text output includes `Stale: …` and `Dropped: …` lines.
Unshown lines do not fail validation: a story selects what matters, rather than exhausting the diff.
Text output lists `Changed lines shown: N of M` and `Remaining: path:line` for each remaining excerpt.
JSON output is a report with `valid`, `covered`, `total`, `uncovered`, `errors`, `stale` and `dropped`, plus `path` on a successful write.
`covered` and `total` count changed lines; `uncovered` contains the resolved Remaining excerpts.
An invalid story returns `valid: false` and a nonzero exit status.

## Write a story worth reading

The story is the PR body, written for someone who hasn't followed the work.
Open on what the change produces, how it will be used and what most needs the human's judgment.
Use the overview, flags and chapter narratives in the PR body, keeping one account in agreement across both surfaces.
Mermaid diagrams carry relationships and handoffs using the same source in the reader and GitHub.

Aim for a five-minute reading in plain language.
Use a stop only where the code itself is the thing to look at, usually fewer than 40 lines, and say why.
Never stop on documentation or a README; explain that material in the story.
A chapter can have no stops.
Leave supporting machinery to Remaining on purpose; coverage is an honesty check, not a target.
Added and deleted files use neutral code backgrounds with change markers in the gutter, while tokens stay theme-aware.

## Review state and delivery

File headers show status, a rename’s old path, mode or type changes, changed line counts, and explicit role overrides.
Tests and Remaining start as compact file lists; opening a row mounts its diff lazily.
Story stops show their notes and `file:lines` with code folded until clicked or opened by keyboard.
Opening code mounts it lazily; saved open rows stay open on return.
Marking a file or stop viewed folds its code, and it stays folded on return.
A stop's viewed mark works without opening code; marking or unmarking it doesn't open code.
Click its file header to read the code.
Folded rows retain their comment counts; flag jumps open the file they need.
A file in Tests or Remaining must be opened before it can first be marked viewed; unmarking it opens it again.
Click a diff line number to add an anchored comment.
The overall note, comment count and Send review stay at the foot of the rail on desktop and below the scroller on phone.
This small review dock stays quiet while the draft is empty.

Drafts stay in this browser by document owner/path. Every comment and the overall note keep their own base and head across rebakes.
Earlier-snapshot comments appear in the review list, not on different code at the same line number.
The reader and Send button name earlier anchors; the delivered message preserves them alongside the current snapshot.
Viewed marks are separate: they reset when the base, head or bundle’s non-cryptographic fingerprint changes.

Send review names and targets the fiber whose directory holds the bundle, on the file’s owner host, even when another fiber links to it.
It uses the existing-worker dispatch route and sends one plain-text message with Base and Head SHAs, the title and the comments.
A missing worker route disables sending; reading a change never authorizes a fresh worker launch.
The Send button is disabled while delivering.
Successful delivery clears the draft; a failed send keeps it available to retry.
A busy owner or a lost answer doesn't prove a failure, so Send then says the review may still arrive and asks you to check the worker's conversation before sending again.

The reader checks the bundle version and asks for a rebake when it differs.
A plain Go test against real Git output enforces that every changed line appears in Story, Tests or Remaining.
A browser smoke test checks that a real bundle renders and that disposal removes its windows and observers.
Captured rows remain readable if the optional parser, highlighter or grammar load fails.
