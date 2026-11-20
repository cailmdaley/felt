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
  The reader's ‹, Escape, the phone's swipe (outside Channels) and the view's own tab all call it, and the browser's own Back pops the same entry, so they cannot disagree.
- **An address with nothing of ours below it** (a deep link, or a reload of one) has `layer: false`; back replaces it with its view's address.
- **Another view's tab from the reader** replaces the reader's entry with that view, so the browser's Back from there returns to the view the reader covered.
- **An address typed into the browser** over a view opens a layer above it like any open. Typed over the reader, it is the browser's own entry above the reader's, so the browser's Back returns to the page it covered; the reader's back still goes to the view.
- **A back in flight** (the pop has not landed yet) holds whatever is asked meanwhile and applies it once the pop lands; an open queued this way pushes a fresh layer.

- **In Channels a swipe returns to the channel first, then brings the rail.** With anything open over a channel (a thread's view, a file, an image, a tapestry, a page reached by following links however deep), one rightward swipe, a finger's or a trackpad's, leaves the reader for the channel's stream (one `WorkspaceHistory.leave`, as back would) and does nothing more: it never steps back one level, and the rest of that swipe, a trackpad's inertia included, moves nothing. On the channel's stream with nothing over it, the swipe brings the channel rail, following the finger.
  The reader offers each page swipe it recognises, its frames' included, to the view beneath first (`Workspace.swipeBeneath`); Channels takes the rightward ones, and a trackpad's sideways wheel over the reader it reads itself. A framed page (a report, a tapestry, a deck) keeps its wheel events, so while Channels is beneath, every document frame passes its sideways wheel up through the document bridge, replayed on the frame element, and keeps it from the browser's swipe-back, save where the page itself scrolls that way (`takeSidewaysWheel`). Under any other view the browser's own swipe-back answers over a frame, and the phone's swipe is back.
- **A framed page's own history does not hold back up.** A page that keeps history of its own (a deck that puts its slide in its address, a report's tabs) adds entries above the reader's, so a `history.back()` lands in the frame. Each frame reports such a step (`popped` on the document bridge), and a back the board asked for goes on back until it reaches the view's entry (`WorkspaceHistory.framePopped`). The browser's own Back pressed over such a page steps through the page's history, as it would anywhere.
- **The view under the reader, chosen from it** (its tab, its key, the header's close on a reader opened from the Desk) is back, not a new entry.
- **Popups over the reader keep no entry.** The list of sent files (`openFileList`) closes by Escape or a click outside; Back leaves the reader and the list with it.

So from any reachable state, one back reaches a view.

## Returning where you were

Leaving the reader is only half of back; the view underneath restores itself.
Channels keeps its channel and its scroll while the reader covers it, and the surface that opened the reader names the item it opened from (`ChannelsView.leaveFor`).
On return that item takes the focus.
The Desk selects the last card viewed.

## Tests

- `route.test.ts`: each rule above, against jsdom's session history.
- `route.properties.test.ts`: random walks over every move (opens, moves, pages, scans, back, the browser's back and forward, tabs, typed addresses, reloads), some started at a deep link, some rushed so a back is still in flight; from wherever a walk ends the address names what is shown, and one back by the reader or by the browser lands on the view the reader names. `ROUTE_FUZZ_RUNS` deepens it.
- `e2e/railGesture.mjs` (a trackpad, in WebKit) and `e2e/channels.mjs` (a finger): over the reader opened from a channel, however deep (a deck stepped through its own history, then a link out of it) and over a framed page, one swipe returns to the channel's stream and the next brings the rail.
- `e2e/navBack.mjs`: the journey on the harness board, desktop and phone: a channel, a post, its thread, the orchestrator and back and forth between them, a file, a post's file opened in the reader, then each way back.
