# Change-reader fixtures

Build with `cd ui && npm run harness:board`, then load
`harness-board-dist/index.html?example=change` in a headless browser. The main
channel has a tapestry with relative links and header chips for three changes:

- `family.change.json`: a real five-commit felt snapshot,
  `0f3a0cdc..f629d29c`, with an authored story about family identity and navigation.
  Two stops deliberately visit the same file out of line order.
- `plain.change.json`: a separate CLI bake of the same commits without a story or covered hunks.
- `large.change.json`: a 5,000-line file with every line replaced.

`nice -n 10 node ui/scripts/bake-change-fixture.mjs` builds `shuttle` and runs
`shuttle change` against the pinned repository revision, with and without `dogfood.story.json`.
`repo.dir` becomes a portable harness path and commit authors become fixture labels.
`changeContract.test.ts` rebakes that fixture and compares it to the checked-in bundle.
It also creates a disposable Git repository, bakes empty, minimal-story and full-story bundles,
type-checks their JSON against `ChangeBundle`, and compares the reader's paths and hunk coverage
with the CLI's report, including renames, spaced and quoted paths, binary and mode changes.

To inspect a freshly baked bundle instead of the pinned story fixture:

```sh
CHANGE_BUNDLE=/absolute/path/review.change.json nice -n 10 npm run harness:board
SHOTS_DIR=/tmp/real-change nice -n 10 node scripts/capture-change.mjs \
  internal/shuttle/change_patch.go ui/src/board/workspace/ChangeReader.ts
```

The capture script launches and closes its own headless Chrome.
It captures desktop and phone overviews, the named files, and the review form.
The plain and stress fixtures remain independent of the supplied story bundle.

## Verification

From `ui/`:

```sh
npm test -- changeModel.test.ts documents.test.ts
E2E_ONLY='^A change|^A tapestry relative link' node e2e/workspace.mjs
SHOTS_DIR=/tmp/change-reader-shots node scripts/probe-change.mjs
```

The e2e journeys cover desktop/phone reviews, inline annotation placement and
mirroring into the review summary, draft/progress persistence, failed-send
recovery, one owner-routed delivery with an exact head and old-side anchor,
relative-link Back navigation, the no-story inventory, and bounded large-file
mounts. The probe launches its own headless browser, writes light/dark
screenshots at desktop and 390px, and records render/scroll timings and DOM counts.
Cold measurements use fresh page realms and identical hash navigation after the
board is ready. Warm measurements retain the highlighter and adjacent-document
prefetch; the output records whether the target was already rendered. These
self-contained harness timings exclude production lazy-chunk and grammar downloads.
The output also includes the built reader, engine and TypeScript grammar gzip sizes.

## Rendering boundary

`ChangeReader` is a lazy production entry.
Go parses Git's diff, resolves each stop's excerpt and supplies covered flags and bounded rendering windows.
Pierre's vanilla `FileDiff` renders those independent patches; the reader never splits Git output or recomputes coverage.
One stop must show every changed line on its chosen side to cover a hunk.
Partial and context-only stops leave the complete hunk visible in Remaining.
Tests stay in their own lane even when the story cites them.
Only the chosen grammar set is bundled; other languages use plain text.

The workspace owns the outer scrollbar. Intersection-observed 120-row windows
bound the mounted diff DOM and retain measured heights when parked. Pierre's
metadata separators show patch coordinates; they do not call omitted portions
of a story excerpt “unmodified.” “Show file diff” exposes the file's available
patch hunks, not source outside the snapshot. Inline comments use
`render({lineAnnotations})`; `setLineAnnotations` stages data without painting it.

Theme colors map workspace paper/ink/verdict/stop/machine tokens to Pierre's
CSS-variable theme. Both widths use unified, wrapped diffs. Phone reviews keep
their navigation visible, with the contents control inside the top bar rather
than floating over the chapter tabs. Drafts and viewed
marks are browser-local and keyed by owner/path, base, head and a digest of the exact bundle.
Live-file polling reloads a rebake without reusing its review state.
Sending uses the composer's previous-session route with `existing_only` authority; a missing worker cannot be launched by a review.
