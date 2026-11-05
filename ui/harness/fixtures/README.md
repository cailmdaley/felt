# Change-reader fixtures

Build with `cd ui && npm run harness:board`, then load `harness-board-dist/index.html?example=change` in a headless browser.
The main channel has a tapestry with relative links and header chips for three changes:

- `family.change.json` is a small real Git diff from a throwaway repository, with an authored story about family identity and navigation.
  Two stops deliberately visit the same file out of line order.
- `plain.change.json` captures the same diff without a story.
- `large.change.json` is a 5,000-line file with every line replaced.

Both harness builds run `scripts/bake-change-fixture.mjs`, which builds `shuttle`, creates a tiny disposable Git repository and runs `shuttle change` with and without `dogfood.story.json`.
The bundles land in gitignored `ui/harness/generated/`; no repository history or full CI checkout is needed.
It replaces `repo.dir` with a portable harness path and commit authors with fixture labels.
`go run scripts/rebake-change.go SOURCE DESTINATION REPO` rebakes a captured snapshot's commits and story with the current format, preserving its display metadata.

To inspect a freshly baked bundle instead of the small story fixture, run from `ui/`:

```sh
CHANGE_BUNDLE=/absolute/path/review.change.json npm run harness:board
SHOTS_DIR=/tmp/real-change node scripts/capture-change.mjs \
  internal/shuttle/change_patch.go ui/src/board/workspace/ChangeReader.ts
```

The capture script uses headless Chrome.
It captures desktop and phone overviews, the named files and the review form.
The plain and stress fixtures remain independent of the supplied story bundle.

## Verification

`TestChangeLineCoverageRealGit` in `internal/shuttle/change_lines_test.go` checks that every changed line appears in Story, Tests or Remaining and that window references point to the exact source rows.
`ChangeReader.test.ts` checks that opening a 103-file change reads no offscreen source rows.
`npm run e2e:change` checks that a real bundle renders highlighted code and leaves no windows or reader observers after disposal.

From `ui/`:

```sh
npm test
E2E_ONLY='^A change|^A tapestry relative link' node e2e/workspace.mjs
CHANGE_BUNDLE=/absolute/path/review.change.json node scripts/measure-change.mjs
ENGINE=webkit CHANGE_BUNDLE=/absolute/path/review.change.json node scripts/measure-change.mjs
```

The workspace journeys cover reviews, draft persistence, failed-send recovery, owner-routed delivery, relative-link Back navigation and bounded large-file mounts.
The measurement script uses the shared headless Chromium or headless WebKit against the board harness.
It reports open time, main-thread long tasks where supported, menu latency, timers, file reads, DOM counts and Chromium heap/style metrics before opening and after returning to the conversation.
`SWEEP=1` visits every file; `PROFILE=1` also saves a Chromium CPU profile to `/tmp/change-profile.json`.
`CHANGE_OUTPUT` selects the JSON result path.
The source is supplied through a Blob-backed file response; network download time is excluded.

## Rendering

Go resolves stop and Remaining excerpts into references to a file's source-row table.
The reader mounts nearby 120-row windows and builds their small highlighting patches on demand.
Pierre's vanilla `FileDiff` uses Shiki's WebAssembly engine; oversized windows stay plain.
Generated files start folded.
Selecting another document disposes the change reader and its shared highlighter rather than keeping it as an inactive neighbour.

Theme colors map workspace paper/ink/verdict/stop/machine tokens to Pierre's CSS-variable theme.
Both widths use unified, wrapped diffs.
Drafts and viewed marks are browser-local; comments keep their original snapshot anchors across rebakes.
Sending uses the composer's existing-worker route.
