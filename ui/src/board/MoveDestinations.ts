/**
 * "Move to" — the places a card may go, named as the board names them.
 *
 * Drag-and-drop has always been the board's only way to move a card, and it
 * has no touch backend: on a phone the whole vocabulary of the desk — the
 * columns, Resting, the Pinned strip, the queue — is simply unreachable. This
 * module is that vocabulary written down, so a menu can offer it.
 *
 * A DESTINATION IS A PLACE, not a verb about one. The label is the column or
 * surface title the board already prints (`COLUMN_TITLES`, `SURFACE_TITLE`),
 * so the menu reads as the drag said out loud and needs no gloss under it.
 * Several legality branches can share one place name — the two ways a pinned
 * role comes back to rest on the strip are both, to the reader, "Pinned".
 *
 * THE RULE THIS FILE FOLLOWS: it does not decide anything the drag does not
 * already decide. Every entry below mirrors a guard that already lives in
 * `KanbanModal.setSurface` / `transition` / `pinRole`, or in
 * `stackDropVerdict` (KanbanRules). Where a guard would banner "that is not a
 * thing this card does", the destination is simply not offered — a menu can
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
import { stackDropVerdict } from './KanbanRules.js'
import { COLUMN_TITLES, SURFACE_TITLE } from './KanbanSurfaces.js'

/** What a chosen destination asks the board to do. One-to-one with the
 *  gestures the drag already speaks; no new verbs. */
export type MoveAction =
  /** `KanbanModal.transition(card, target)` — the lifecycle drop. */
  | { kind: 'transition'; target: ColumnKind }
  /** `KanbanModal.setSurface(card, horizon)` — the planning drop. */
  | { kind: 'surface'; horizon: 'now' | 'stashed' }
  /** `KanbanModal.pinRole(card)` — the drop onto the Pinned strip. */
  | { kind: 'pin' }
  /** Reshape back to a one-shot: the strip's only exit that isn't a verdict. */
  | { kind: 'unpin' }
  /** `KanbanModal.unstack(card)` — leave the queue. */
  | { kind: 'unstack' }
  /** Not a move by itself: opens the picker of cards this one may queue
   *  behind. The chosen target becomes `stackBehind(card, tail)`. */
  | { kind: 'queue' }

export interface MoveDestination {
  /** Stable key, for tests and for DOM ids. */
  id: string
  /** What the human reads: the board's own name for the place. */
  label: string
  /** Which band of the menu this belongs to. The Now columns come first, a
   *  rule under them, then the surfaces and the queue. */
  group: 'column' | 'other'
  action: MoveAction
}

/** A card is UNPLANNABLE when a horizon write on it would be ignored by the
 *  classifier and the card would snap back. The three cases are exactly
 *  `setSurface`'s three banner guards, in its order. */
function planningIgnored(card: KanbanCard): boolean {
  if (card.shuttleKind === 'standing') return true
  if (card.shuttleKind === 'pinned' && card.status === 'active') return true
  if (card.status === 'closed' && card.tempered === undefined && card.shuttleKind === 'pinned') {
    return true
  }
  return false
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
    !card.runningWorker &&
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
 * the card is on a surface rather than in a Now column (Resting, the timeline,
 * the strip).
 */
export function moveDestinations(card: KanbanCard, column: ColumnKind | null): MoveDestination[] {
  const out: MoveDestination[] = []
  // A cycle is a band of time on the calendar, not work. Nothing here applies.
  if (card.isCycle) return out

  // ── The Now columns ────────────────────────────────────────────────────
  // Offered in the board's own left-to-right order, each omitted only when the
  // card already sits there — `transition`'s single no-op guard
  // (`fromKind === target`) and nothing else. In flight is unconditional apart
  // from that: the drag routes it through force-dispatch, which bypasses
  // status, schedule and review gates. Awaiting review is likewise a plain
  // drop — it closes the card with the verdict cleared and stops the worker.
  for (const target of ['drafts', 'inFlight', 'awaitingReview'] as const) {
    if (column === target) continue
    out.push({
      id: target,
      label: COLUMN_TITLES[target],
      group: 'column',
      action: { kind: 'transition', target },
    })
  }

  // ── Surfaces ───────────────────────────────────────────────────────────
  // Onto the desk.
  if (!planningIgnored(card)) {
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
  // Into Resting.
  if (!planningIgnored(card)) {
    if (card.status === 'closed' || !restingNow(card)) {
      out.push({
        id: 'stashed',
        label: SURFACE_TITLE.stashed,
        group: 'other',
        action: { kind: 'surface', horizon: 'stashed' },
      })
    }
  }

  // ── The Pinned strip ───────────────────────────────────────────────────
  // `pinRole` turns away a block-less card before the network is touched: a
  // bare draft has no host and no project_dir to install from.
  if (card.shuttleKind !== undefined) {
    if (card.shuttleKind !== 'pinned') {
      out.push({ id: 'pin', label: COLUMN_TITLES.pinned, group: 'other', action: { kind: 'pin' } })
    } else if (card.runningWorker) {
      // The drag's own reading of "back to the strip" for a live pinned role:
      // stop it, so it comes to rest.
      out.push({ id: 'pin', label: COLUMN_TITLES.pinned, group: 'other', action: { kind: 'pin' } })
    } else if (card.status === 'closed' || (card.dependsOn?.length ?? 0) > 0) {
      // A closed role lives off the strip; a queued role lives beneath its
      // predecessor. pinRole reopens/reshapes/parks either back onto Pinned.
      out.push({ id: 'pin', label: COLUMN_TITLES.pinned, group: 'other', action: { kind: 'pin' } })
    }
    if (card.shuttleKind === 'pinned') {
      out.push({ id: 'unpin', label: 'Unpin', group: 'other', action: { kind: 'unpin' } })
    }
  }

  // ── The queue ──────────────────────────────────────────────────────────
  // A hand-written `depends_on:` LIST is a fan-in someone assembled on
  // purpose; neither the drag nor this menu may collapse it.
  if (card.dependsOnShape !== 'list') {
    // Any kind may be queued: the edge is ordering for the eye, so a standing
    // or pinned role filed after something is exactly that and nothing more.
    out.push({
      id: 'queue',
      label: 'Queue behind…',
      group: 'other',
      action: { kind: 'queue' },
    })
    // Offered on the EDGE, not on a gate: a card that names a predecessor is in
    // a queue whether or not the fold happens to be drawing it under one (a
    // running card stands in its own column and is still queued).
    if ((card.dependsOn?.length ?? 0) > 0) {
      out.push({
        id: 'unstack',
        label: 'Out of the queue',
        group: 'other',
        action: { kind: 'unstack' },
      })
    }
  }

  return out
}

export interface QueueTarget {
  card: KanbanCard
  /** The END of the target's chain — what the edge is actually written to. */
  tail: string
}

/**
 * Every card this one may be queued behind, ruled on by the SAME verdict the
 * card-onto-card drop uses. Nothing is re-derived here: `stackDropVerdict` is
 * asked once per candidate and only its `ok` branch survives.
 */
export function queueTargets(
  card: KanbanCard,
  cards: readonly KanbanCard[],
  dependents: ReadonlyMap<string, readonly string[]>,
): QueueTarget[] {
  const out: QueueTarget[] = []
  for (const target of cards) {
    const verdict = stackDropVerdict(card, target, dependents)
    if (verdict.ok) out.push({ card: target, tail: verdict.tail })
  }
  return out
}

/**
 * What the detail panel needs from the board in order to offer the menu.
 *
 * The panel knows nothing about columns, dependency graphs or wire protocols;
 * the board knows nothing about menus. This is the seam. `KanbanModal`
 * implements it over its existing gesture methods, so every item the menu
 * performs is byte-for-byte the drop it stands in for.
 */
export interface MoveBroker {
  /** Legal destinations for this card, given where the board has it. */
  destinations(card: KanbanCard): MoveDestination[]
  /** Cards this one may be queued behind, chain tails resolved. */
  queueTargets(card: KanbanCard): QueueTarget[]
  /** Run one non-queue destination. */
  perform(card: KanbanCard, action: MoveAction): void
  /** Run the queue destination, once a target has been chosen. */
  queueBehind(card: KanbanCard, tailId: string): void
}
