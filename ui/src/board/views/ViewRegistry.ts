/**
 * ViewRegistry — the contract between KanbanModal and the temporal views.
 *
 * The board is four full-page views behind one hotkey row:
 *
 *   1  desk       the kanban page (Timeline ribbon + Now board + Pinned +
 *                 Stash). Owned by KanbanModal itself, NOT a TemporalView.
 *   2  day        ┐
 *   3  week       ├ TemporalViews — each mounts into a full-width host where
 *   4  chronicle  ┘ the Desk surfaces would otherwise be.
 *
 * The order runs from the tightest window outward, so the strip reads as a
 * zoom: today, this week, the whole record.
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
 * idempotent.
 */

import type { KanbanCard, KanbanResponse } from '../KanbanTypes.js'
import type { ActivityResult, NarrationResult, SessionsResult } from './TemporalData.js'

export interface TemporalView {
  id: 'chronicle' | 'day' | 'week'
  title: string
  hotkey: string
  mount(host: HTMLElement, ctx: ViewContext): void
  refresh(ctx: ViewContext): void
  unmount(): void
}

export interface ViewContext {
  response: KanbanResponse
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
  activity(fromMs: number, toMs: number): Promise<ActivityResult>
  narration(fromISO: string, toISO: string): Promise<NarrationResult>
  /**
   * The FLEET's session ledger from `sinceMs` onward, oldest first. Pass 0 for
   * the whole history — the file holds one line per session, not per event.
   *
   * Feed it to `buildSessionIndex` and join buckets through `lookupTmux`: that
   * is RUNG 0, a recorded pairing, and it outranks every name-derived rung
   * because it survives the session ending. Join through `lookupTmux` rather
   * than `byTmux.get` — a tmux name is unique within a host, not across the
   * fleet, and the scoped key is what keeps two daemons' identically named
   * sessions apart. Degrades to an empty ledger on an older daemon, so a view
   * that adopts it must still keep its existing rungs.
   */
  sessions(sinceMs: number): Promise<SessionsResult>
  /**
   * Open a card's detail panel. Resolves against `cards` AND `response.cycles`,
   * so a cycle band or chip can hand over its id directly — the split above is
   * about what a view iterates, not about what it can open.
   *
   * An id matching neither warns to the console and does nothing.
   */
  openCard(cardId: string): void
  /**
   * Focus a running worker's terminal — the same gesture as the Desk's `▸ aloft`
   * / `☞ needs-you-now` pill, reached from a view.
   *
   * Not a new write plane: it delegates to the host callback the board has
   * always had, which POSTs `/api/v1/attach` so the daemon opens the tmux
   * session in kitty. `shuttleHost` routes a remote worker; omit it for local.
   *
   * OPTIONAL. Undefined when the board was mounted without `onOpenWorker` — a
   * read-only context, or the offline harness. Check before calling and hide
   * the affordance when it is absent, exactly as the Desk's pill degrades.
   */
  openWorker?(tmuxSessionName: string, shuttleHost?: string): void
  requestRefresh(): void
  /**
   * The shared temporal cursor: a bare civil day (`YYYY-MM-DD`), or null for
   * "today / current", which is the default and the state after a reset.
   *
   * It is ONE cursor across all views, held by KanbanModal, and it survives
   * tab switches — so paging Day back to Tuesday and pressing `4` opens Week
   * on the week containing Tuesday, not on this week. A view that keeps its
   * own local day state instead will disagree with its neighbours; read this
   * on every mount and refresh and let it be the source of truth.
   *
   * Null is not "no opinion" — it is the live present, and a view should
   * re-resolve it against the clock each time rather than freezing the day it
   * first saw.
   */
  focusDate: string | null
  /**
   * Move the cursor. Pass null to return it to today/current.
   *
   * This does NOT re-mount: it updates the shared state and calls the active
   * view's `refresh` with a context carrying the new `focusDate`, so the
   * caller patches itself in place. Do not call it from inside your own
   * `refresh` — that is a loop.
   *
   * The argument is a bare civil day. A full ISO timestamp is accepted for
   * convenience (its leading day is taken) but warns, because a civil day and
   * an instant are different kinds and the board keeps them apart — see
   * src/board/civilDay.ts.
   */
  setFocusDate(dayISO: string | null): void
  /**
   * Switch the page programmatically — a Day lane's "see this week" link, a
   * Chronicle entry jumping into its day. Same path as clicking the tab or
   * pressing the hotkey, tab styling included; `'desk'` returns to the kanban.
   *
   * `opts.focusDate` moves the cursor as part of the same gesture, so the
   * destination mounts already showing the right day rather than flashing
   * today first. Switching to the view that is already active is not a no-op
   * when it carries a new `focusDate`: the view refreshes on the new cursor.
   */
  switchView(id: BoardViewId, opts?: { focusDate?: string }): void
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
 * one lands there is nothing to mount — and the chassis used to bail silently,
 * leaving the page COMPLETELY blank: no heading, no message, no way back. A
 * blank page cannot be told from a broken one, so the two states now say which
 * they are.
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
// Three surfaces run bare-key hotkeys — the chassis's 1-4 view switch, and Day
// and Week's own paging keys — and all three must agree on when a keystroke is
// NOT theirs. They had three hand-copied predicates; these are the shared ones,
// so the next dialog added to the app is covered everywhere at once.

/** The board's own root. It carries `role="dialog" aria-modal="true"`, so a
 *  naive "is a modal dialog open?" query matches the board itself. */
const BOARD_ROOT_CLASS = 'kbn-modal'

/** Is the keystroke going into a text field? */
export function isTypingTarget(
  el: { tagName: string; isContentEditable?: boolean } | null | undefined,
): boolean {
  if (!el) return false
  const tag = el.tagName?.toUpperCase()
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
 * `[data-state="open"]` is Radix's stamp (Stash/Capture went through
 * `AppDialog`). `[aria-modal="true"]` catches every OTHER modal dialog — the
 * hand-rolled `StashForm` sets `role="dialog" aria-modal="true"` and NO
 * data-state, which is exactly the gap that let `1`-`4` switch views out from
 * under an open form. Matching on aria rather than on a library's attribute
 * means the next hand-rolled dialog is covered without a code change here.
 */
export const BLOCKING_DIALOG_SELECTOR =
  '[role="dialog"][data-state="open"], [role="dialog"][aria-modal="true"], .kbn-detail-overlay'

/**
 * True when a bare keystroke belongs to something other than the board: a text
 * field has focus, or a dialog is layered over it.
 *
 * THE predicate — chassis, Day and Week should all call this rather than keep
 * their own copy, so they cannot drift apart again.
 */
export function keystrokeIsSpokenFor(doc: Document = document): boolean {
  if (isTypingTarget(doc.activeElement as HTMLElement | null)) return true
  for (const el of doc.querySelectorAll(BLOCKING_DIALOG_SELECTOR)) {
    if (isBlockingDialog(el)) return true
  }
  return false
}

const CIVIL_DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const LEADING_CIVIL_DAY_RE = /^(\d{4}-\d{2}-\d{2})/

/**
 * Coerce a `setFocusDate` / `switchView` argument to the cursor's own kind: a
 * bare civil day, or null for today/current.
 *
 * A civil day and an instant are different kinds, and the board keeps them
 * apart on purpose (src/board/civilDay.ts opens with why — reading a civil day
 * through `new Date()` loses a day west of Greenwich). So a full timestamp is
 * accepted, since the caller's intent is unambiguous, but it warns: passing one
 * means the call site is holding an instant where the cursor wants a day, and
 * that is worth seeing before it becomes a date-off-by-one somewhere downstream.
 * Anything unparseable resolves to null rather than poisoning the cursor.
 */
export function normalizeFocusDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  if (CIVIL_DAY_RE.test(trimmed)) return trimmed
  const leading = LEADING_CIVIL_DAY_RE.exec(trimmed)?.[1]
  if (leading) {
    console.warn(
      `[views] focusDate wants a bare civil day (YYYY-MM-DD); got "${value}". Using "${leading}".`,
    )
    return leading
  }
  console.warn(`[views] focusDate is not a civil day: "${value}". Falling back to today.`)
  return null
}

/**
 * Flatten a board response into one card list — the `cards` a ViewContext
 * carries. Surface order is the page's own top-to-bottom reading order
 * (timeline, then the Now lanes, then pinned, then stash); a card that
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
  take(response.timeline.anytimeSoon)
  take(response.now.drafts)
  take(response.now.inFlight)
  take(response.now.awaitingReview)
  take(response.pinned)
  take(response.stash)
  return out
}
