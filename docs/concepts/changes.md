# Changes

A **change** is a snapshot of what head adds since it diverged from a base ref, with an optional story that explains a useful reading order.
It doesn't require a GitHub PR or a GitLab MR.
`shuttle change` writes the snapshot as a `<name>.change.json` [companion file](companions.md) beside a fiber's Markdown document.
The bundle contains the patch, commit metadata and file inventory, so reading it doesn't require access to Git or the forge.

## Bake a snapshot

Run on the host holding the fiber and worktree:

```bash
shuttle change review-task --base origin/main
shuttle change review-task --base origin/main --head topic/change \
  --repo "$PWD" --story story.json --name walkthrough
```

`--repo` defaults to the fiber's `shuttle.project_dir`, then the current working directory.
`--head` defaults to `HEAD`.
The filename defaults to the head ref with slashes replaced by hyphens and punctuation slugified; a detached `HEAD` uses the fiber slug instead.
`--name walkthrough` writes `walkthrough.change.json`.
The write is atomic, and an invalid story leaves any existing bundle untouched.
A fiber doesn't need a `shuttle:` block, but a block naming another host is refused: run the command on that host.

The base ref and head resolve to commit SHAs, then Git finds their common ancestor with `git merge-base`.
The patch, file inventory, hunks, coverage and commit list all compare that merge-base SHA to head, like a pull request's three-dot diff (`base...head`).
Work added to the base branch after divergence doesn't appear reversed in the change.
When base is already an ancestor of head, the comparison starts at base itself.
No common ancestor is an error.
Dirty and untracked files are excluded.

Rebake after changing the commits or story.
The bundle is a snapshot, not a live branch view, and its line references describe the captured head.
It can contain private source code; keep `*.change.json` out of a public fiber archive's Git history.
The CLI runs Git directly and makes no model calls.

## Version 1 bundle

```json
{
  "version": 1,
  "title": "Explain the snapshot boundary",
  "repo": { "name": "project", "dir": "/work/project", "forge_url": null },
  "base": "0123456789abcdef0123456789abcdef01234567",
  "head": "abcdef0123456789abcdef0123456789abcdef01",
  "base_ref": "origin/main",
  "head_ref": "topic/change",
  "commits": [
    {
      "sha": "abcdef0123456789abcdef0123456789abcdef01",
      "subject": "Capture a committed snapshot",
      "author": "Example Author",
      "time": "2026-11-04T19:00:00Z"
    }
  ],
  "patch": "diff --git a/src/snapshot.go b/src/snapshot.go\n--- a/src/snapshot.go\n+++ b/src/snapshot.go\n@@ -10 +10 @@\n-old\n+new\n",
  "files": [
    {
      "path": "src/snapshot.go",
      "status": "modified",
      "role": "implementation",
      "additions": 1,
      "deletions": 1
    }
  ],
  "story": null
}
```

| Field | Meaning |
|---|---|
| `version` | Schema version, currently `1` |
| `title` | The story's optional `title`, otherwise the head commit subject |
| `repo` | `name` comes from origin's repository path, falling back to the main worktree directory's basename; `dir` is the absolute directory used for Git; `forge_url` is origin's HTTP(S) URL or scp-style GitHub/GitLab URL normalized to HTTPS without credentials, query, fragment or `.git`, otherwise `null` |
| `base`, `head` | The merge-base SHA and resolved head SHA |
| `base_ref`, `head_ref` | `base_ref` preserves what the user typed, even when base has advanced beyond the fork; `head_ref` is the supplied ref, with `HEAD` becoming the short branch name when attached and staying `HEAD` when detached |
| `commits` | Commits reachable from head but not base, oldest first, with author name and RFC3339 author time |
| `patch` | Unified Git diff with three context lines and rename detection; binary changes carry Git's binary notice rather than binary contents |
| `files` | Repository-relative file paths, status, role and line counts; renamed files use the destination path, deleted files use the old path |
| `story` | The supplied story object, or `null` when no story is supplied |

File statuses are `modified`, `added`, `deleted` and `renamed`.
A file-type change is `modified`.
Binary files have zero additions and deletions because they have no textual line counts.
Pure renames and mode changes can also have zero counts and no text hunks.
An empty change has empty `commits` and `files` arrays and an empty patch.

## Write a story

A story is a JSON object authored separately from the bundle:

```json
{
  "title": "Explain the snapshot boundary",
  "overview": "This change captures **committed trees** for a reader.",
  "flags": [
    {
      "file": "src/snapshot.go",
      "from": 10,
      "to": 12,
      "side": "new",
      "text": "Check the boundary before reading the orchestration."
    }
  ],
  "chapters": [
    {
      "id": "snapshot",
      "title": "Capture one immutable change",
      "narrative": "The patch and story describe the same pair of commits.",
      "why_here": "The snapshot boundary explains the later validation rules.",
      "stops": [
        {
          "file": "src/snapshot.go",
          "from": 10,
          "to": 40,
          "side": "new",
          "note": "Refs resolve before reading the patch.",
          "importance": "critical"
        }
      ]
    }
  ],
  "roles": { "src/protocol.generated.ts": "generated" }
}
```

`overview`, chapter `narrative` and stop `note` carry Markdown.
Chapters are ordered: `why_here` explains why each chapter belongs at that point in the reading.
Each chapter has an `id`, a `title` and `stops` identifying useful places to read.
A stop's `importance` must be `critical`, `important`, `supporting` or `context`.
Flags identify things to look at first; their `text` says why.
Omitted flags, chapters and role overrides are allowed.
The role-override example assumes `src/protocol.generated.ts` is in the change's file inventory.

### Line references

Stops and flags use repository-relative `file` paths matching the inventory exactly.
For a rename, both old-side and new-side references use the destination path.
`from` and `to` are inclusive file line numbers, not positions within the patch.
Supply both, or omit both to refer to the whole file.
`side` defaults to `new`; use `old` for a deleted file or a deletion-only hunk.
A side with zero lines in a hunk has no line at which a ranged reference can land.

A reference must name a changed file and overlap at least one hunk on the selected side.
Hunk ranges include the three context lines shown by the patch.
A whole-file reference covers all its hunks with lines on that side.
Whole-file references also work for binary files, pure renames and mode-only changes, which have no text hunks; ranged references to those files fail.

### File roles

Each file has one role: `implementation`, `test`, `generated`, `config` or `docs`.
The path classifier recognizes test directories and language conventions such as `test_*.py`, `*_test.go`, `*.test.ts` and `*_test.exs`.
It also recognizes generated directories and filenames, documentation paths, config directories and lockfiles.
It doesn't inspect file contents for generated-code comments.
`story.roles` overrides classification by exact path; an unknown path or role fails validation.

## Validate and measure coverage

```bash
shuttle change review-task --base origin/main --story story.json --check
shuttle change review-task --base origin/main --story story.json --check --json
```

The CLI lists every invalid stop or flag with its location in the story, including unknown files, invalid ranges and ranges that overlap no hunk on the chosen side.
Validation failures exit nonzero and don't write a bundle.
`--check` never writes, including when validation succeeds.
Uncovered hunks don't fail validation: partial stories are useful while authoring.

Coverage counts **hunks**, not lines or files.
A stop covers a hunk if it overlaps that hunk on its chosen side; duplicate stops count only once.
Flags don't count as coverage.
Every hunk without a stop remains available to the reader under Remaining.
Files without text hunks don't enter the hunk denominator and remain in the inventory.

Text output reports `Hunks covered: N of M` and each uncovered hunk as `Remaining: path:line`.
The line is the hunk's new-side start, or its old-side start when the new side has no lines.
JSON output is a report, not the bundle:

```json
{
  "valid": true,
  "covered": 0,
  "total": 1,
  "uncovered": [
    {
      "file": "src/snapshot.go",
      "old_from": 10,
      "old_lines": 1,
      "new_from": 10,
      "new_lines": 1
    }
  ],
  "errors": []
}
```

A successful write adds `path`, the absolute companion path.
`--check` and validation failures omit `path`.
Invalid stories produce `valid: false` and an `errors` array listing the problems, as well as the coverage report; the command also returns a nonzero exit status.
Without a story, validation succeeds with zero covered hunks and every text hunk in `uncovered`.
