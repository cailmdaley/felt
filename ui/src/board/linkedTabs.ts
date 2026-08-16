/**
 * linkedTabs — where a followed [[wikilink]] lands, as arithmetic.
 *
 * A fiber card's body cites other fibers, and following one used to open
 * another floating card beside it: a second click, a third, and the screen was
 * a fan of windows the reader had to manage. Now there are exactly two panes —
 * the ORIGIN card the reader opened from the board, and ONE panel beside it
 * where every followed reference lands as a TAB, the same way the sent-file
 * viewer holds a card's deliverables.
 *
 * The tab set itself is `ReaderTabs` (open-order, dedupe, close-to-neighbour);
 * what is new here is the routing question a wikilink click asks BEFORE the
 * fiber is fetched, and the two answers that need no fetch at all:
 *
 *   ORIGIN — the link names the fiber the origin card is already showing. The
 *     reader is standing on it; opening a tab of the page you are reading from
 *     would be a duplicate of the card next door. Raise the origin instead.
 *   FOCUS — the link names a fiber already open as a tab. Show that tab. This
 *     is the dedupe rule stated one step earlier than `openTab`'s, because the
 *     fetch is the expensive part and a hit here skips it.
 *   LOAD — everything else: fetch it, then `insertTab`.
 *
 * `insertTab` dedupes again, and that is not belt-and-braces: two clicks on the
 * same reference before the first fetch resolves both route LOAD, and without
 * the second check the panel would grow two tabs for one fiber.
 *
 * No DOM, no daemon — the panel supplies both.
 */

import { closeTab, findTab, type TabLike, type TabState } from './ReaderTabs.js'

/** What a wikilink click should do, decided before anything is fetched. */
export type WikilinkRoute = 'origin' | 'focus' | 'load'

/**
 * Where does following `fiberId` lead, given what is already on screen?
 *
 * `originId` is the fiber the origin card shows — null when the origin card is
 * gone (or never named its fiber), in which case a self-reference is just
 * another fiber to open.
 */
export function routeWikilink<T extends TabLike>(
  state: TabState<T>,
  originId: string | null,
  fiberId: string,
): WikilinkRoute {
  if (originId && fiberId === originId) return 'origin'
  return findTab(state, fiberId) ? 'focus' : 'load'
}

/** Show an open tab. Unlike `activateTab` this is only ever called on a known
 *  hit, so a miss is a caller bug — it still leaves the set alone. */
export function focusTab<T extends TabLike>(state: TabState<T>, fiberId: string): TabState<T> {
  if (!findTab(state, fiberId)) return state
  return { tabs: state.tabs, active: fiberId }
}

/**
 * Add a freshly-loaded tab in open-order and make it active.
 *
 * `kept` is false when the id was already open — the fetch raced another click
 * — and the caller must throw away the DOM it just built rather than mount a
 * second copy.
 */
export function insertTab<T extends TabLike>(
  state: TabState<T>,
  entry: T,
): { state: TabState<T>; kept: boolean } {
  if (findTab(state, entry.path)) {
    return { state: { tabs: state.tabs, active: entry.path }, kept: false }
  }
  return { state: { tabs: [...state.tabs, entry], active: entry.path }, kept: true }
}

/**
 * Close one tab. `empty` says the panel has nothing left to show — the window
 * closes with its last tab, exactly as the file viewer's does, so a reader who
 * closes what they were reading is left with the card they came from and
 * nothing else.
 */
export function closeLinkedTab<T extends TabLike>(
  state: TabState<T>,
  fiberId: string,
): { state: TabState<T>; closed: T | null; empty: boolean } {
  const { state: next, closed } = closeTab(state, fiberId)
  return { state: next, closed, empty: next.tabs.length === 0 }
}
