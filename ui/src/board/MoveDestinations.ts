/**
 * "Move to" — the places a card may go, named as the board names them.
 *
 * Drag-and-drop has always been the board's only way to move a card, and it
 * has no touch backend: on a phone the whole vocabulary of the desk — the
 * columns and Resting — is simply unreachable. This
 * module is that vocabulary written down, so a menu can offer it.
 *
 * A DESTINATION IS A PLACE, not a verb about one. The label is the column or
 * surface title the board already prints (`COLUMN_TITLES`, `SURFACE_TITLE`),
 * so the menu reads as the drag said out loud and needs no gloss under it.
 * Resting is the board's one way to put a card down without a verdict, from
 * In flight and from Awaiting review alike — the worker's `shuttle rest`, said
 * by hand.
 *
 * THE RULE THIS FILE FOLLOWS: it does not decide anything the drag does not
 * already decide. Every entry below mirrors a guard that already lives in
 * `KanbanModal.setSurface` or `KanbanModal.transition`.
 * Where a guard would banner "that is not a thing this card does", the
 * destination is simply not offered — a menu can
 * be honest about legality in a way a drop target cannot, because it is
 * allowed to be absent. Where the guard would banner "it is already there",
 * the destination is likewise absent.
 *
 * It performs nothing. It returns intents; the caller hands each one to the
 * board's existing wire calls, unchanged.
 *
 * The parity is with the drop's LEGALITY, not with everything a drop can carry.
 * A drag can name a date column or drop a card cold; the menu offers the bare
 * destinations and lets the drop's own defaults apply. Where such a field
 * changes whether a move is a no-op — `cold` is the one — it is read here too.
 */

import type { KanbanCard, ColumnKind } from './KanbanTypes.js'
import { hasLiveWorker } from './KanbanTypes.js'
import { COLUMN_TITLES, SURFACE_TITLE } from './KanbanSurfaces.js'

/** What a chosen destination asks the board to do. One-to-one with the
 *  gestures the drag already speaks; no new verbs. */
export type MoveAction =
  /** `KanbanModal.transition(card, target)` — the lifecycle drop. */
  | { kind: 'transition'; target: ColumnKind }
  /** `KanbanModal.setSurface(card, horizon)` — the planning drop. */
  | { kind: 'surface'; horizon: 'now' | 'stashed' }

export interface MoveDestination {
  /** Stable key, for tests and for DOM ids. */
  id: string
  /** What the human reads: the board's own name for the place. */
  label: string
  /** Which band of the menu this belongs to. The Now columns come first, a
   *  rule under them, then the surfaces. */
  group: 'column' | 'other'
  action: MoveAction
}

/** A card is UNPLANNABLE when a horizon write on it would be ignored by the
 *  classifier and the card would snap back: a standing constitution, placed by
 *  its schedule — exactly `setSurface`'s banner guard. */
function planningIgnored(card: KanbanCard): boolean {
  return card.shuttleKind === 'standing'
}

/**
 * `setSurface`'s no-op test for the stash side: the card is really sitting in
 * Resting right now, AND a stash would change nothing about it.
 *
 * The `cold` half is easy to drop and wrong to. `setSurface` compares the
 * card's `cold` against the one the gesture carries, and a menu Rest carries
 * none — so a resting COLD card is not a no-op at all: the write clears the
 * flag, which is a real move onto the held-open cluster's terms. Without this
 * clause the menu would withhold a destination the drop performs.
 */
function restingNow(card: KanbanCard): boolean {
  return (
    !hasLiveWorker(card) &&
    card.status === 'open' &&
    card.effectiveHorizon === 'stashed' &&
    (card.cold ?? false) === false
  )
}

/**
 * Where may this card go from where it is?
 *
 * `column` is the board's own placement (`findCardColumn`), not a re-derivation
 * — the same source of truth `transition` consults, for the same reason: local
 * reclassification drifts and turns a move into a silent no-op. `null` means
 * the card is on a surface rather than in a Now column (Resting, the timeline).
 */
export function moveDestinations(card: KanbanCard, column: ColumnKind | null): MoveDestination[] {
  const out: MoveDestination[] = []
  // A cycle is a band of time on the calendar, not work. Nothing here applies.
  if (card.isCycle) return out
  // A seat at rest is already where every parking gesture would put it: a
  // draft, the desk or Resting all land it back among the Roles. What it can
  // do is start, or be sent for review.
  const restingSeat = seatAtRest(card)

  // ── The Now columns ────────────────────────────────────────────────────
  // Offered in the board's own left-to-right order, each omitted only when the
  // card already sits there — `transition`'s single no-op guard
  // (`fromKind === target`) and nothing else. In flight is unconditional apart
  // from that: the drag routes it through force-dispatch, which bypasses
  // status, schedule and review gates. Awaiting review is likewise a plain
  // drop — it closes the card with the verdict cleared and stops the worker.
  for (const target of ['drafts', 'inFlight', 'awaitingReview'] as const) {
    if (column === target) continue
    if (restingSeat && target === 'drafts') continue
    out.push({
      id: target,
      label: COLUMN_TITLES[target],
      group: 'column',
      action: { kind: 'transition', target },
    })
  }

  // ── Surfaces ───────────────────────────────────────────────────────────
  // Onto the desk.
  if (!planningIgnored(card) && !(card.shuttleSeat === true && card.shuttleRole)) {
    const alreadyOnDesk = card.status !== 'closed' && card.effectiveHorizon === 'now'
    if (!alreadyOnDesk) {
      out.push({
        id: 'now',
        label: 'The desk',
        group: 'other',
        action: { kind: 'surface', horizon: 'now' },
      })
    }
  }
  // Into Resting — for a seat, back among the Roles.
  if (!planningIgnored(card) && !restingSeat) {
    if (card.status === 'closed' || !restingNow(card)) {
      out.push({
        id: 'stashed',
        label: card.shuttleSeat === true && card.shuttleRole ? 'Roles' : SURFACE_TITLE.stashed,
        group: 'other',
        action: { kind: 'surface', horizon: 'stashed' },
      })
    }
  }

  return out
}

/** A seat at rest — the cards the Roles band draws: `classifyFiber`'s `roles`
 *  branch, read off the card. */
export function seatAtRest(card: KanbanCard): boolean {
  return (
    card.shuttleSeat === true && !!card.shuttleRole &&
    card.status !== 'closed' &&
    !hasLiveWorker(card) &&
    (card.status !== 'active' || card.shuttleKind === 'standing')
  )
}

/**
 * What the move menu needs from the board in order to offer its places.
 *
 * The menu opens from a long-press on a card. It knows nothing about columns,
 * wire protocols; the board knows nothing about menus.
 * This is the seam. `KanbanModal` implements it over its existing gesture
 * methods, so every item the menu performs is byte-for-byte the drop it stands
 * in for.
 */
export interface MoveBroker {
  /** Legal destinations for this card, given where the board has it. */
  destinations(card: KanbanCard): MoveDestination[]
  /** Run one destination. */
  perform(card: KanbanCard, action: MoveAction): void
}
