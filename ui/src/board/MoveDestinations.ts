/**
 * "Move ▾" — the list of places a card may go, said in words.
 *
 * Drag-and-drop has always been the board's only way to move a card, and it
 * has no touch backend: on a phone the whole vocabulary of the desk —
 * launch, rest, pin, queue — is simply unreachable. This module is that
 * vocabulary written down, so a menu can offer it.
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
 * verbs and lets the drop's own defaults apply. Where such a field changes
 * whether a move is a no-op — `cold` is the one — it is read here too.
 */

import type { KanbanCard, ColumnKind } from './KanbanTypes.js'
import { stackDropVerdict, type StackCandidate } from './KanbanRules.js'

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
  /** What the human reads. Sentence case, active, names the place. */
  label: string
  /** One clause of why, when the label alone under-explains. */
  hint?: string
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

  // ── Lifecycle ──────────────────────────────────────────────────────────
  // Launch is unconditional apart from "already there": the drag routes it
  // through force-dispatch, which bypasses status, schedule and review gates.
  if (column !== 'inFlight') {
    out.push({
      id: 'inFlight',
      label: 'Run it now',
      hint: 'Dispatch a worker immediately',
      action: { kind: 'transition', target: 'inFlight' },
    })
  }
  if (column !== 'drafts') {
    out.push({
      id: 'drafts',
      label: 'Back to Drafts',
      action: { kind: 'transition', target: 'drafts' },
    })
  }

  // ── Surfaces ───────────────────────────────────────────────────────────
  // Onto the desk. A dep-gated card asking for Now is asking to LEAVE THE
  // QUEUE — the horizon write cannot lift a derived gate — so the queue exit
  // below carries that case and this one stands down.
  if (!planningIgnored(card) && card.depGated !== true) {
    const alreadyOnDesk = card.status !== 'closed' && card.effectiveHorizon === 'now'
    if (!alreadyOnDesk) {
      out.push({
        id: 'now',
        label: 'Bring to the desk',
        action: { kind: 'surface', horizon: 'now' },
      })
    }
  }
  // Into Resting. A gated CLOSED card is already resting for a reason the
  // stash cannot improve on, and letting it through would reopen it.
  if (!planningIgnored(card) && !(card.depGated === true && card.status === 'closed')) {
    if (card.status === 'closed' || !restingNow(card)) {
      out.push({
        id: 'stashed',
        label: 'Rest it',
        hint: 'Off the desk until it is due or you fetch it',
        action: { kind: 'surface', horizon: 'stashed' },
      })
    }
  }

  // ── The Pinned strip ───────────────────────────────────────────────────
  // `pinRole` turns away a block-less card before the network is touched: a
  // bare draft has no host and no project_dir to install from.
  if (card.shuttleKind !== undefined) {
    if (card.shuttleKind !== 'pinned') {
      out.push({
        id: 'pin',
        label: 'Pin to the strip',
        hint: 'A resting role you launch by hand',
        action: { kind: 'pin' },
      })
    } else if (card.runningWorker) {
      // The drag's own reading of "back to the strip" for a live pinned role:
      // stop it, so it comes to rest.
      out.push({
        id: 'pin',
        label: 'Stop it and rest on the strip',
        action: { kind: 'pin' },
      })
    } else if (card.status === 'closed') {
      // A pinned role whose last run is CLOSED classifies into Awaiting review
      // or Past, not onto the strip — so "already pinned" is not true of it and
      // `pinRole` deliberately lets it through (reopen → reshape → park). This
      // is the only gesture that brings a once-pinned role back to rest;
      // withholding it left such a card stranded off the strip forever.
      out.push({
        id: 'pin',
        label: 'Rest it back on the strip',
        action: { kind: 'pin' },
      })
    }
    if (card.shuttleKind === 'pinned') {
      out.push({
        id: 'unpin',
        label: 'Unpin it',
        hint: 'Back to a one-shot you can plan',
        action: { kind: 'unpin' },
      })
    }
  }

  // ── The queue ──────────────────────────────────────────────────────────
  // A hand-written `depends_on:` LIST is a fan-in someone assembled on
  // purpose; neither the drag nor this menu may collapse it.
  if (card.dependsOnShape !== 'list') {
    if (card.depGated === true) {
      out.push({
        id: 'unstack',
        label: 'Take it out of the queue',
        action: { kind: 'unstack' },
      })
    }
    // The source refusals `stackDropVerdict` makes without looking at a
    // target: a standing role runs on its schedule, a pinned one waits on the
    // strip. Both would be dead frontmatter.
    if (card.shuttleKind !== 'standing' && card.shuttleKind !== 'pinned') {
      out.push({
        id: 'queue',
        label: 'Queue behind…',
        hint: 'It rests until that work is tempered',
        action: { kind: 'queue' },
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
  const byId = new Map(cards.map((c) => [c.id, c]))
  const lookup = (id: string): StackCandidate | undefined => byId.get(id)
  const out: QueueTarget[] = []
  for (const target of cards) {
    const verdict = stackDropVerdict(card, target, dependents, lookup)
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
