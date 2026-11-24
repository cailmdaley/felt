# Where back goes

The board has one rule for back: **one step back is where you were before the last step in depth.**
The reader is one layer over a view (Desk, Channels), and back from any page it shows returns to that view in one step.
Full screen is the one layer more: a file a page shows in place, sent full screen, sits over that page, and back returns to it.
Read this page before adding anything that opens, moves or closes the reader.

## The model

One object owns the answer: `WorkspaceHistory` in `ui/src/board/workspace/route.ts`.
Every surface that moves the reader asks it; none touches `window.history` for the reader itself.

- **Opening the reader from a view** pushes one history entry, directly above the view's.
  The entry's state (`shuttleWorkspace`) records `layer: true` and the view it covers.
- **Every move inside the reader replaces that entry**: another constitution (a thread row, `b`, an ancestry link, a link in a page), another page of the same one (a file, its tapestry, the next sent file), a scan with `j` or `k`.
  The address always names what is shown, so a reload reopens it; the history never grows.
- **Back** (`WorkspaceHistory.back`) is one `history.back()` onto the entry below: the view's, or from full screen the page's.
  The reader's ‹, Escape and the phone's swipe (outside Channels) call it, and the browser's own Back pops the same entry, so they cannot disagree.
  The reader's ‹ names where it goes: the view, or from full screen the constitution whose page is beneath.
- **Leaving** (`WorkspaceHistory.leave`) goes to the view from anywhere in the reader: the view's own tab and Channels' swipe call it. From full screen it passes both entries.
- **Full screen** (`WorkspaceHistory.full`): a file unfolded on a constitution's view, sent full screen by its bar's control or by a press on the page itself, pushes one entry above the view's page.
  Its state records the address beneath (`under`), so a reload keeps where back goes.
  Moves inside full screen (the next sent file, a link) replace it; full screen asked from full screen takes its place; the page beneath, chosen from it (`l`, `t`, its head's button), is back.
  A framed page unfolded in place takes every press inside it, so a transparent pane over it (`.uf-cover`) takes the press for the board: a drag still scrolls what holds it, and the page is the reader's to use once full screen.
  The page beneath may be rewritten after a back from full screen (a move, a tab); the browser's Forward into full screen then stands over whatever is there, and back lands on it.
- **An address with nothing of ours below it** (a deep link, or a reload of one) has `layer: false`; back replaces it with its view's address.
- **Another view's tab from the reader** replaces the reader's entry with that view, so the browser's Back from there returns to the view the reader covered.
- **An address typed into the browser** over a view opens a layer above it like any open. Typed over the reader, it is the browser's own entry above the reader's, so the browser's Back returns to the page it covered; the reader's back still goes to the view.
- **A back in flight** (the pop has not landed yet) holds whatever is asked meanwhile and applies it once the pop lands; an open queued this way pushes a fresh layer.

- **In Channels a swipe returns to the channel first, then brings the rail.** With anything open over a channel (a thread's view, a file, an image, a tapestry, a page reached by following links however deep), one rightward swipe, a finger's or a trackpad's, leaves the reader for the channel's stream (one `WorkspaceHistory.leave`, as back would) and does nothing more: it never steps back one level, and the rest of that swipe, a trackpad's inertia included, moves nothing (`SpentSwipe` in `railMotion.ts`: it ends when its events pause, or when their speed rises well past the slowest it fell to, which is the next swipe). On the channel's stream with nothing over it, the swipe brings the channel rail, following the finger.
  The reader offers each page swipe it recognises, its frames' included, to the view beneath first (`Workspace.swipeBeneath`); Channels takes the rightward ones, and a trackpad's sideways wheel over the reader it reads itself. A framed page (a report, a tapestry, a deck) keeps its wheel events, so while Channels is beneath, every document frame passes its sideways wheel up through the document bridge, replayed on the frame element, and keeps it from the browser's swipe-back, save where the page itself scrolls that way (`takeSidewaysWheel`). Under any other view the browser's own swipe-back answers over a frame, and the phone's swipe is back.
  Leaving the reader takes a swipe's travel: 48 px of sideways wheel within one burst (`LEAVE_PX`), and a frame passes its wheel up only while its last moments run sideways, so a scroll down a page that drifts sideways stays on the page.
- **A framed page's own history does not hold back up.** A page that keeps history of its own (a deck that puts its slide in its address, a report's tabs) adds entries above the reader's, so a `history.back()` lands in the frame. Each frame reports such a step (`popped` on the document bridge), and a back the board asked for goes on back until it reaches the view's entry (`WorkspaceHistory.framePopped`), through at most `FRAME_STEPS` such entries. A back the board does not hear land within `LANDING_MS` (one that stopped past those steps, or on an entry a nested frame made, which reports nothing) is taken as landed: the entry it stopped on is given the view's address and what was asked meanwhile goes ahead. The browser's own Back pressed over such a page steps through the page's history, as it would anywhere.
- **The view under the reader, chosen from it** (its tab, its key, the header's close on a reader opened from the Desk) is leaving, not a new entry.
- **Popups over the reader keep no entry.** The list of sent files (`openFileList`) closes by Escape or a click outside; Back leaves the reader and the list with it.

So from any reachable state, one back reaches a view, or from full screen the page beneath it, and a second reaches the view.

The standalone thread page (`/thread?f=…`) has no reader: on a phone a file shown full screen covers the page under a bar of its own, with one history entry, so the bar's back and the browser's both return to the page; elsewhere it opens a window of its own.

## Returning where you were

Leaving the reader is only half of back; the view underneath restores itself.
Channels keeps its channel and its scroll while the reader covers it, and the surface that opened the reader names the item it opened from (`ChannelsView.leaveFor`).
On return that item takes the focus.
The Desk selects the last card viewed.

## Tests

- `route.test.ts`: each rule above, against jsdom's session history.
- `route.properties.test.ts`: random walks over every move (opens, moves, pages, full screen, scans, back, leave, the browser's back and forward, tabs, typed addresses, reloads), some started at a deep link, some rushed so a back is still in flight; from wherever a walk ends the address names what is shown, one back from full screen lands on the page beneath it, and one back by the reader or by the browser from any other page lands on the view the reader names. `ROUTE_FUZZ_RUNS` deepens it.
- `e2e/railGesture.mjs` (a trackpad, in WebKit) and `e2e/channels.mjs` (a finger): over the reader opened from a channel, however deep (a deck stepped through its own history, then a link out of it) and over a framed page, one swipe returns to the channel's stream and the next brings the rail.
- `e2e/navBack.mjs`: the journey on the harness board, desktop and phone: a channel, a post, its thread, the orchestrator and back and forth between them, a file, a post's file opened in the reader, then each way back. Its full-screen journeys, at 390×844, 375×667 and desktop, send a tapestry that is one full-bleed frame of a deck full screen by a press on it, from Find over the Desk and from a post's thread in Channels, and check the way back stands on screen, uncovered and at touch size, and returns to the view, then to the Desk or Channels; and on the thread page, the full-screen layer's back.
