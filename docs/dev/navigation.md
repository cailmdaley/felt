# Where back goes

The board has one rule for back: **its destination depends on where you are, never on how you got there.**
The reader is one layer over a view (Desk, Chronicle, Channels, Globe), and back from any page it shows returns to that view in one step.
Read this page before adding anything that opens, moves or closes the reader.

## The model

One object owns the answer: `WorkspaceHistory` in `ui/src/board/workspace/route.ts`.
Every surface that moves the reader asks it; none touches `window.history` for the reader itself.

- **Opening the reader from a view** pushes one history entry, directly above the view's.
  The entry's state (`shuttleWorkspace`) records `layer: true` and the view it covers.
- **Every move inside the reader replaces that entry**: another constitution (a thread row, `b`, an ancestry link, a link in a page), another page of the same one (a file, its tapestry, the next sent file), a scan with `j` or `k`.
  The address always names what is shown, so a reload reopens it; the history never grows.
- **Back** (`WorkspaceHistory.leave`) is one `history.back()` onto the view's entry.
  The reader's ‹, Escape, the phone's swipe and the view's own tab all call it, and the browser's own Back pops the same entry, so they cannot disagree.
- **An address with nothing of ours below it** (a deep link, or a reload of one) has `layer: false`; back replaces it with its view's address.
- **Another view's tab from the reader** replaces the reader's entry with that view, so the browser's Back from there returns to the view the reader covered.
- **A back in flight** (the pop has not landed yet) holds whatever is asked meanwhile and applies it once the pop lands; an open queued this way pushes a fresh layer.

So from any reachable state, at most one back reaches a view.
The one exception is a dialog over the reader that keeps its own entry, the sent files sheet (`PageSheet`): back closes it first, so the bound is two.

## Returning where you were

Leaving the reader is only half of back; the view underneath restores itself.
Channels keeps its channel and its scroll while the reader covers it, and the surface that opened the reader names the item it opened from (`ChannelsView.leaveFor`).
On return that item takes the focus, or, when it has an unfolded file, the file does, so ←, → and Escape reach it without a click.
The Desk selects the last card viewed.

## Tests

- `route.test.ts`: each rule above, against jsdom's session history.
- `route.properties.test.ts`: random walks over every move (opens, moves, pages, scans, back, the browser's back and forward, tabs, reloads); from wherever a walk ends, one back by the reader or by the browser lands on the view the reader names. `ROUTE_FUZZ_RUNS` deepens it.
- `e2e/navBack.mjs`: the journey on the harness board, desktop and phone: a channel, a post, its thread, the orchestrator and back and forth between them, a file, full screen from an unfolded file, then each way back.
