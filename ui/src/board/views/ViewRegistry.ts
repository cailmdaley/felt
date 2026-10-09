/**
 * ViewRegistry — the contract between KanbanModal and the temporal views.
 *
 * The board is three full-page views behind one hotkey row:
 *
 *   1  desk       the kanban page (Now board + Resting). Owned by
 *                 KanbanModal itself, NOT a TemporalView.
 *   2  chronicle  ┐ registered views — each mounts into a full-width host
 *   3  board      ┘ where the Desk surfaces would otherwise be.
 *
 * Chronicle holds the record in time. Board is the document workspace's
 * contact sheet, grouped by recent work, project or host.
 *
 * A view is a plain object with a three-call lifecycle. KanbanModal owns the
 * host element and the data; the view owns everything inside the host.
 *
 *   mount(host, ctx)   build your DOM into `host` (empty when you get it)
 *   refresh(ctx)       new board data landed — patch in place, do not rebuild
 *   unmount()          drop timers/listeners; the host is emptied for you
 *
 * `refresh` fires on every successful 15s poll, INCLUDING polls where the
 * fiber data is byte-identical (the Desk skips those re-renders; views do not,
 * because their content also moves with the clock). Keep it cheap and
 * idempotent — Chronicle reads the temporal feeds on its own cadence
 * (./chronicleFeeds.ts) rather than refetching per poll.
 */

import type { KanbanCard, KanbanResponse } from '../KanbanTypes.js'
import type { TemporalFetchers } from './TemporalData.js'

export interface TemporalView {
  id: 'chronicle' | 'shelf'
  title: string
  hotkey: string
  mount(host: HTMLElement, ctx: ViewContext): void
  refresh(ctx: ViewContext): void
  unmount(): void
}

/**
 * What a view is handed. It IS a {@link TemporalFetchers} — `activity`,
 * `sessions` and `commits` are that interface's, documented there — plus the
 * board's own response, cards and gestures.
 *
 * The one thing a view must know that the fetchers' own docs do not say: feed
 * `sessions` to `buildSessionIndex` and join buckets through `lookupTmux`.
 * That is RUNG 0, a recorded pairing, and it outranks every name-derived rung
 * because it survives the session ending. Join through `lookupTmux` rather
 * than `byTmux.get` — a tmux name is unique within a host, not across the
 * fleet, and the scoped key is what keeps two daemons' identically named
 * sessions apart. Likewise `commits`: join `record.session` through
 * `buildSessionIndex(...).bySession` (with `lookupSession`, host-scoped) and
 * the fiber is a recorded fact rather than a reading of the subject line.
 */
export interface ViewContext extends TemporalFetchers {
  response: KanbanResponse
  /** Persistent document sheet, owned by the board's workspace controller. */
  workspace?: { mountOverview(host: HTMLElement): void; hideOverview(): void }
  /**
   * WORK — every card on the eight lifecycle/planning surfaces, deduped. This
   * is the list to walk for due-marks and lane building.
   *
   * It deliberately EXCLUDES cycles. A cycle is an annotation, a named span of
   * time, and its `due` is the span's closing edge rather than a deadline — so
   * a cycle in here would draw a due-mark that means something else. Read
   * `response.cycles` for those, and `cycleSpan` (KanbanRules) to resolve one
   * into two civil days.
   */
  cards: KanbanCard[]
  /**
   * The daemon origin every request is built on — '' for the same-origin
   * bundle the daemon serves, an absolute origin when the host was given one.
   * The board resolves it once; a view must never re-resolve it from the env.
   */
  shuttleBase: string
  /**
   * Open a fiber in the workspace reader. Resolves against `cards` AND `response.cycles`,
   * so a cycle band or chip can hand over its id directly — the split above is
   * about what a view iterates, not about what it can open.
   *
   * An id matching neither warns to the console and does nothing.
   */
  openCard(cardId: string): void
  /** Re-fetch the board's own feed now, rather than on the next poll. */
  requestRefresh(): void
}

/** A view's id, or `desk` for the kanban page KanbanModal renders itself. */
export type ViewId = TemporalView['id']
export type BoardViewId = 'desk' | ViewId

// ── Registry ─────────────────────────────────────────────────────────────────
//
// Module-global and populated at import time (see ./index.ts). Registration
// order is tab order, so the import order in index.ts is the strip's order.

const registry = new Map<ViewId, TemporalView>()

/** Register a view. Re-registering an id replaces it (hot-reload friendly)
 *  while keeping its original position in the strip. */
export function registerView(view: TemporalView): void {
  registry.set(view.id, view)
}

export function getView(id: ViewId): TemporalView | undefined {
  return registry.get(id)
}

/** Every registered view, in registration order. */
export function listViews(): TemporalView[] {
  return [...registry.values()]
}

// ── View fallback ────────────────────────────────────────────────────────────

/** What the chassis should put in the view host when a view cannot be given a
 *  context: nothing (mount the real view), or one of two stand-in pages. */
export type ViewFallbackKind = 'none' | 'loading' | 'error'

/**
 * Which stand-in a temporal view needs right now.
 *
 * A view is only ever mounted with a real `KanbanResponse`, so before the first
 * one lands there is nothing to mount. A blank page cannot be told from a
 * broken one, so the chassis puts up a stand-in that says which it is.
 *
 * `error` outranks `loading`: once a fetch has failed, "waiting" is a lie, and
 * a stale error is still the truest thing we know.
 */
export function viewFallbackKind(state: {
  onDesk: boolean
  hasResponse: boolean
  lastFetchFailed: boolean
}): ViewFallbackKind {
  if (state.onDesk) return 'none'
  if (state.hasResponse) return 'none'
  return state.lastFetchFailed ? 'error' : 'loading'
}

// ── Hotkey guard ─────────────────────────────────────────────────────────────
//
// The chassis runs bare-key hotkeys — the 1-3 view switch and the bare `,` for
// settings — and each must agree on when a keystroke is NOT theirs. These are
// the shared predicates, so the next dialog added to the app is covered by
// every bare key at once.

/** The board's own root. It carries `role="dialog" aria-modal="true"`, so a
 *  naive "is a modal dialog open?" query matches the board itself. */
const BOARD_ROOT_CLASS = 'kbn-modal'

/** Is the keystroke going into a text field? */
export function isTypingTarget(
  el: { tagName: string; isContentEditable?: boolean } | null | undefined,
): boolean {
  if (!el) return false
  const tag = el.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return el.isContentEditable === true
}

/**
 * Is this dialog element something layered OVER the board, rather than the
 * board itself?
 *
 * The exclusion is the whole subtlety. `.kbn-modal` is `role="dialog"
 * aria-modal="true"` — it is the board — so a query broad enough to catch a
 * non-Radix form dialog also catches the page it is protecting, and the
 * hotkeys would be dead permanently rather than only while a form is open.
 */
export function isBlockingDialog(
  el: { classList: { contains(token: string): boolean } } | null | undefined,
): boolean {
  if (!el) return false
  return !el.classList.contains(BOARD_ROOT_CLASS)
}

/**
 * Selector for anything that takes keystrokes away from the board.
 *
 * `[data-state="open"]` is Radix's stamp — Stash, Capture and the settings
 * sheet all render through `AppDialog`. `[aria-modal="true"]` catches every
 * OTHER modal dialog: a hand-rolled one carries `role="dialog"
 * aria-modal="true"` and no data-state, and without this clause `1`-`3` would
 * switch views out from under it. Matching on aria rather than on a library's
 * attribute means a dialog built outside AppDialog is covered without a code
 * change here.
 */
export const BLOCKING_DIALOG_SELECTOR =
  '[role="dialog"][data-state="open"], [role="dialog"][aria-modal="true"]'

/**
 * Is a dialog currently layered over the board?
 *
 * The second half of `keystrokeIsSpokenFor` on its own, because a modifier
 * CHORD wants this half without the first: `⌘,` is not typing, wherever the
 * caret happens to be, but it must still not stack a second dialog on top of
 * an open one.
 */
export function blockingDialogOpen(): boolean {
  for (const el of document.querySelectorAll(BLOCKING_DIALOG_SELECTOR)) {
    if (isBlockingDialog(el)) return true
  }
  return false
}

/**
 * True when a bare keystroke belongs to something other than the board: a text
 * field has focus, or a dialog is layered over it.
 *
 * THE predicate — every bare-key handler calls this rather than keeping its own
 * copy, so they cannot drift apart.
 */
export function keystrokeIsSpokenFor(): boolean {
  if (isTypingTarget(document.activeElement as HTMLElement | null)) return true
  return blockingDialogOpen()
}

/** What kind of settings keystroke this is, if any. */
export type SettingsHotkey = 'chord' | 'bare'

/** The shape `settingsHotkey` reads — a `KeyboardEvent`, or a test's stand-in. */
export interface HotkeyLike {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

/**
 * Does this keystroke ask for settings, and in which of the two ways?
 *
 * Two openings, because the board is two things at once. On a keyboard it is
 * an application, and an application's preferences are `⌘,` — the one chord
 * a Mac user tries without being told. On the board itself every other page is
 * a BARE key (`1`–`3`), and a phone's keyboard has no `⌘` at all, so a bare `,`
 * opens it too. `,` is free: the chassis owns only the digits.
 *
 * Pure, and it deliberately does NOT consult the DOM — the two kinds are
 * guarded differently and the caller applies the guard:
 *
 *   - `'chord'` is inert only while another dialog is layered over the board
 *     (`blockingDialogOpen`), not while a field has focus. A modifier chord is
 *     never typing, and refusing it inside the Chronicle's search box would
 *     make the one universal shortcut the least reliable one.
 *   - `'bare'` follows the same rule as every other bare key
 *     (`keystrokeIsSpokenFor`), because a lone `,` in a text field is a comma.
 *
 * `Alt`/`Shift` disqualify both: `⌥,` and `⇧,` are keystrokes someone meant for
 * something else, and on several layouts `⌥,` is a character.
 */
export function settingsHotkey(e: HotkeyLike): SettingsHotkey | null {
  if (e.key !== ',') return null
  if (e.altKey || e.shiftKey) return null
  if (e.metaKey || e.ctrlKey) return 'chord'
  return 'bare'
}

/**
 * Flatten a board response into one card list — the `cards` a ViewContext
 * carries. Surface order is the page's own top-to-bottom reading order
 * (timeline, then the Now lanes, Roles, then stash); a card that
 * projects onto two surfaces appears once, at its first.
 */
export function collectCards(response: KanbanResponse): KanbanCard[] {
  const seen = new Set<string>()
  const out: KanbanCard[] = []
  const take = (list: KanbanCard[]): void => {
    for (const card of list) {
      if (seen.has(card.id)) continue
      seen.add(card.id)
      out.push(card)
    }
  }
  take(response.timeline.past)
  take(response.timeline.futureDated)
  take(response.now.drafts)
  take(response.now.inFlight)
  take(response.now.awaitingReview)
  take(response.roles)
  take(response.stash)
  // FOLDED CARDS BELONG ON A CALENDAR even though the Desk draws them under
  // their head. The fold is about how the Desk reads — one queue instead of six
  // cards — and it has nothing to say about a day: a card due Tuesday is due
  // Tuesday whoever it is filed behind, and dropping it here would take work off
  // the calendar for an ordering gesture.
  take(response.folded)
  return out
}
