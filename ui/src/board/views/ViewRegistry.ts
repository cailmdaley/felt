/**
 * ViewRegistry — the contract between KanbanModal and the temporal views.
 *
 * The board is four full-page views behind one hotkey row:
 *
 *   1  desk       the kanban page (Timeline ribbon + Now board + Pinned +
 *                 Stash). Owned by KanbanModal itself, NOT a TemporalView.
 *   2  chronicle  ┐
 *   3  day        ├ TemporalViews — each mounts into a full-width host where
 *   4  week       ┘ the Desk surfaces would otherwise be.
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
import type { ActivityResult, NarrationResult } from './TemporalData.js'

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
  cards: KanbanCard[]
  activity(fromMs: number, toMs: number): Promise<ActivityResult>
  narration(fromISO: string, toISO: string): Promise<NarrationResult>
  openCard(cardId: string): void
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

/** Test/hot-reload escape hatch — drops every registration. */
export function clearViews(): void {
  registry.clear()
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
