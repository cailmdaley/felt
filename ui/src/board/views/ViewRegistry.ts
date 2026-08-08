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
