# Changes

A **change** captures what a committed head adds since it diverged from a base ref, with an optional story that explains a useful reading order.
It doesn't require a GitHub PR or GitLab MR.
`shuttle change` writes a `<name>.change.json` [companion file](companions.md) beside a fiber's Markdown document.
The bundle contains commits, file metadata and independently renderable hunks, so reading it needs neither Git nor the forge.

## Bake and open a snapshot

```bash
shuttle change review-task --base origin/main
shuttle change review-task --base origin/main --head topic/change \
  --repo "$PWD" --story story.json --name walkthrough
```

`--repo` defaults to the fiber's `shuttle.project_dir`, then the current directory.
`--head` defaults to `HEAD`.
The filename defaults to the head ref with slashes replaced by hyphens and punctuation slugified; detached `HEAD` uses the fiber slug.
`--name walkthrough` writes `walkthrough.change.json`.
The write is atomic, and an invalid story leaves an existing bundle untouched.
A fiber doesn't need a `shuttle:` block, but a block naming another host is refused.
Run the command on the host holding that fiber and worktree.

The bundle appears among the fiber's sent documents on the board; no Markdown embed or link is needed.
Open the fiber, then its **± change chip**.
A relative link to `walkthrough.change.json` in an HTML report also opens it in the reader, with Back returning to the report.
The reader has Story, Tests and Remaining lanes.
File roles appear on each file; generated files start folded.
Binary, mode-only and pure-rename changes have visible metadata markers even without text hunks.

Rebake after changing commits or the story.
An open reader checks for rewritten bytes through the same conditional polling as other live documents.
The bundle is a snapshot, not a live branch view, and its line references describe the captured head.
It can contain private code; keep `*.change.json` out of a public fiber archive's Git history.
The CLI runs Git directly and makes no model calls.

## Snapshot boundary

Git resolves the base and head to SHAs and finds their common ancestor with `git merge-base`.
Files, hunks and commits all compare that ancestor to head, like a pull request's three-dot diff (`base...head`).
Work added to the base after divergence doesn't appear reversed in the change.
No common ancestor is an error.
Dirty and untracked files are excluded.

Capture pins diff formatting, three context lines, Myers alignment, rename detection and `core.bigFileThreshold=512m`.
A file-type change retains both Git sections, including a binary notice on either side.
An isolated bare Git repository ignores `.gitattributes` in both captured trees and the worktree, repository-local attributes and global attributes.
A file marked `-diff` gets a text patch if Git classifies its contents as text.
Files Git classifies as binary carry its binary notice rather than their contents.

## Version 1 bundle

The bundle has these fields:

| Field | Meaning |
|---|---|
| `version` | Schema version, `1` |
| `title` | The story's optional title, otherwise the head commit subject |
| `repo` | `{name, dir, forge_url}`; `dir` is absolute and `forge_url` is an HTTPS forge address without credentials, query, fragment or `.git`, otherwise `null` |
| `base`, `head` | Merge-base and resolved head SHAs |
| `base_ref`, `head_ref` | Requested refs; attached `HEAD` becomes the short branch name |
| `commits` | Oldest first, each with `sha`, `subject`, `author` and RFC3339 author `time` |
| `files` | Repository-relative inventory, with destination paths for renames and old paths for deletions |
| `story` | Resolved story object, or `null` |

A file has `path`, `old_mode`, `new_mode`, `status`, `role`, `additions`, `deletions`, `header`, `hunks` and `remaining`, plus `old_path` for renames.
`old_path` names the source path; `path` names the destination.
Modes are six-digit octal strings from Git's raw inventory, with `000000` for an absent side.
Different nonzero mode prefixes (the first three digits) identify file-type changes; other mode differences include executable-bit changes.
Statuses are `modified`, `added`, `deleted` and `renamed`; a file-type change is `modified`.
The header retains Git's metadata, including binary notices, rename paths and mode changes.
Empty changes have empty `commits` and `files` arrays.
Files without textual changes have empty `hunks` arrays and zero line counts.

Each hunk has `{file, old_from, old_lines, new_from, new_lines, patch, windows}`.
Its `patch` includes the file headers and complete hunk text needed by the renderer.
Go alone reads Git's diff and decides coverage.
The reader uses these supplied boundaries and flags rather than reconstructing them from a top-level patch.
`windows` contains bounded rendering pieces, each with `{old_from, old_lines, new_from, new_lines, patch, rows, lines}`.
Each `lines` entry has `{kind, old, new, text}` for plain-text rendering without parsing the patch.
`kind` is `addition`, `deletion`, `context` or `note`; absent-side line numbers are zero.
`text` omits the patch row's leading marker, and `rows` counts all entries, including no-newline notes.
These let the reader mount long hunks a piece at a time without another diff parser.
Story stops acquire their own `hunks` array containing just the selected excerpts.
Each file’s `remaining` array contains the changed lines no stop shows, with up to three adjacent context lines and the same renderable shape.
The reader renders these excerpts directly, without calculating coverage.
All collection fields are arrays, including when empty.

## Write a story

```json
{
  "title": "Capture a committed snapshot",
  "overview": "This change keeps **committed trees** and their reading order together.",
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

`overview`, chapter `narrative` and stop `note` carry untrusted Markdown.
Chapters have unique ids and are ordered; `why_here` explains that order.
Stop importance is `critical`, `important`, `supporting` or `context`.
A flag uses the same file and range fields, plus `text` explaining what to inspect first.
Flags don't count toward coverage.
Omitted flags, chapters and role overrides are allowed and become empty collections.
Unknown JSON keys, duplicate chapter ids and control characters in `story.title` fail validation.

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
`story.roles` overrides by exact inventory path; unknown paths and roles fail validation.
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
Files with no text hunks don't enter the denominator and remain visible in the inventory.

`--check` never writes.
Invalid references fail the command and leave an existing bundle untouched.
Unshown lines do not fail validation: a story selects what matters, rather than exhausting the diff.
Text output lists `Changed lines shown: N of M` and `Remaining: path:line` for each remaining excerpt.
JSON output is a report with `valid`, `covered`, `total`, `uncovered` and `errors`, plus `path` on a successful write.
`covered` and `total` count changed lines; `uncovered` contains the resolved Remaining excerpts.
An invalid story returns `valid: false` and a nonzero exit status.

## Write a story worth reading

Aim for a ten-minute reading, in plain language. Select the lines that carry the meaning, usually fewer than 40 per stop, and explain why the reader is here. Walk a new file through several short stops in reading order rather than beginning at its imports and printing everything. Leave supporting machinery to Remaining on purpose; coverage is an honesty check, not a target to maximize. Added and deleted files use neutral code backgrounds with change markers in the gutter, while tokens stay theme-aware.

## Review state and delivery

Mark a stop or file viewed to track progress.
Click a diff line number to add an anchored comment, and add an overall note under Your review.
Drafts and viewed marks stay in this browser, bound to the document's owner/path, base, head and exact bundle digest.
Rebaking with a different story or hunk set starts a separate review state.

Send review uses the fiber composer's worker route and sends one message with Base and Head SHAs before quoted title and path data.
A missing worker route disables sending; reading a change never authorizes a fresh worker launch.
Successful delivery clears the sent draft, while a failed send leaves it available to retry.
