/**
 * Resting (snoozed) fibers on the Chronicle — the row-inclusion bug behind
 * "I dragged a due mark into the past and the row vanished."
 *
 * `buildRows`'s include-set used to be built from `now.*` + `pinned` +
 * `timeline.futureDated` only — `response.stash` (the Desk's
 * Resting region: `horizon:stashed` cards, i.e. snoozed work) was never read.
 * A snoozed, WORKLESS card's only route onto the Chronicle was therefore the
 * activity join, which it can never win by definition. Its due mark could
 * still show — because the row existed via SOME other route at fetch time —
 * but dragging that mark past the point where the daemon's own
 * `effectiveHorizon` promotes the card back onto the desk left a window (the
 * optimistic edit lands locally well before the next poll confirms the
 * reclassification) where the row had nothing left to include it by.
 *
 * The fix reads `restingCards(response)` (the same helper the Desk's own
 * Resting section is built from) into the include-set, so a snoozed card
 * keeps its row regardless of which surface array it currently sits in or
 * how the poll timing lines up.
 */

import { describe, expect, it } from 'vitest'
import { buildRows, type ChronicleRow } from './ChronicleView.js'
import type { KanbanCard, KanbanResponse } from '../KanbanTypes.js'
import {
  card as baseCard,
  dayAt,
  DAY_INDEX,
  response,
  TODAY_DAY,
  TODAY_IDX,
} from '../testFixtures.js'

const card = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
  baseCard({ effectiveHorizon: 'stashed', storedHorizon: 'stashed', ...over })

/** A response carrying exactly one card, on Resting (`stash`) and nowhere
 *  else — the shape a snoozed, workless fiber actually has on the wire. */
const restingResponse = (resting: readonly KanbanCard[]): KanbanResponse =>
  response({ stash: [...resting] })

function rows(cards: KanbanCard[], response: KanbanResponse): ChronicleRow[] {
  return buildRows(response, cards, new Map(), DAY_INDEX, TODAY_IDX, TODAY_DAY, {})
}

describe('a snoozed, workless fiber on Resting', () => {
  it('gets a row for a future due date (the ordinary snooze)', () => {
    const euclid = card({ id: 'euclid', due: dayAt(5) })
    const response = restingResponse([euclid])
    const built = rows([euclid], response)
    expect(built.map((r) => r.cardId)).toContain('euclid')
    expect(built.find((r) => r.cardId === 'euclid')?.dueIdx).toBe(TODAY_IDX + 5)
  })

  it('KEEPS its row when the due mark is dragged into the past — the reported bug', () => {
    // The daemon hasn't echoed the reclassification yet (still `stash` on the
    // wire, exactly as `effectiveHorizon`'s drift promotion works: it takes a
    // poll). The row must not depend on that poll landing.
    const euclid = card({ id: 'euclid-timetracker', due: dayAt(-3) })
    const response = restingResponse([euclid])
    const built = rows([euclid], response)
    const row = built.find((r) => r.cardId === 'euclid-timetracker')
    expect(row).toBeDefined()
    expect(row?.dueIdx).toBe(TODAY_IDX - 3)
  })

  it('stays visible even with due today, exactly on the drift boundary', () => {
    const card0 = card({ id: 'due-today', due: dayAt(0) })
    const response = restingResponse([card0])
    const built = rows([card0], response)
    expect(built.find((r) => r.cardId === 'due-today')?.dueIdx).toBe(TODAY_IDX)
  })

  it('still shows a dateless Resting fiber, sunk to the bottom rather than dropped', () => {
    const dateless = card({ id: 'dateless-resting' })
    const worked = card({
      id: 'worked-and-resting',
      due: dayAt(3),
      effectiveHorizon: 'now',
      storedHorizon: undefined,
      status: 'open',
    })
    const response = restingResponse([dateless])
    // A second, unrelated included card just to confirm ordering doesn't
    // accidentally hide the dateless one rather than merely ranking it low.
    response.now.drafts.push(worked)
    const built = rows([dateless, worked], response)
    expect(built.map((r) => r.cardId)).toContain('dateless-resting')
  })
})
