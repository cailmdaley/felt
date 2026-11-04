# Change-reader fixtures

Build with `cd ui && npm run harness:board`, then load
`harness-board-dist/index.html?example=change` in a headless browser. The main
channel has a tapestry with relative links and header chips for three changes:

- `family.change.json`: a real five-commit felt snapshot,
  `0f3a0cdc..f629d29c`, with an authored story about family identity and navigation.
  Two stops deliberately visit the same file out of line order.
- `plain.change.json`: the same inventory and patch, without a story.
- `large.change.json`: a 5,000-line file with every line replaced.

`node ui/scripts/bake-change-fixture.mjs` reproduces `dogfood.change.json` from
its pinned repository revision. Its story and line references belong to that
revision. Harness-only paths and contributor labels keep the fixture independent
of an operator's checkout and identity.

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
Its render timings use the self-contained harness: they do not include production
lazy-chunk or grammar downloads.

## Rendering boundary

`ChangeReader` is a lazy production entry. Pierre's vanilla `FileDiff` renders
independent, line-number-preserving partial patches; syntax grammars are dynamic
imports. A stop selects an exact file-side interval. Hunk overlap, not the selected
row count, determines coverage in Remaining. Tests stay in their own lane even
when the story cites them.

The workspace owns the outer scrollbar. Intersection-observed 120-row windows
bound the mounted diff DOM and retain measured heights when parked. Pierre's
metadata separators show patch coordinates; they do not call omitted portions
of a story excerpt “unmodified.” “Show file diff” exposes the file's available
patch hunks, not source outside the snapshot. Inline comments use
`render({lineAnnotations})`; `setLineAnnotations` stages data without painting it.

Theme colors map workspace paper/ink/verdict/stop/machine tokens to Pierre's
CSS-variable theme. Both widths use unified, wrapped diffs. Drafts and viewed
marks are browser-local and keyed by owner/path and head. Sending uses the same
force-dispatch worker route as the composer, with previous-session intent.
