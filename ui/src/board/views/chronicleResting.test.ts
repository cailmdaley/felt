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
import { collectCards } from './ViewRegistry.js'
import type { ActivityBucket } from './TemporalData.js'
import {
  card as baseCard,
  dayAt,
  DAY_INDEX,
  response,
  TODAY_DAY,
  TODAY_IDX,
  noonOf,
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

describe('resting seats on the Chronicle', () => {
  const dueSeat = card({ id: 'seats/due', shuttleSeat: 'vizier', due: dayAt(3) })
  const standingSeat = card({
    id: 'seats/standing', shuttleSeat: 'vizier', shuttleKind: 'standing',
    status: 'active', nextLaunchAt: noonOf(dayAt(4)),
  })
  const workedSeat = card({ id: 'seats/worked', shuttleSeat: 'vizier' })
  const seats = [dueSeat, standingSeat, workedSeat]

  it('collects Roles cards once, including cards projected onto another surface', () => {
    const resp = response({ roles: seats, timeline: { past: [], futureDated: [standingSeat] } })
    expect(collectCards(resp).map((c) => c.id).sort()).toEqual(seats.map((c) => c.id).sort())
  })

  it('includes seat deadlines, standing firings and attributed activity in rows', () => {
    const resp = response({ roles: seats })
    const bucket: ActivityBucket = {
      m: Date.parse(noonOf(TODAY_DAY)), s: 'session', cwd: null, k: 'agent', n: 2,
    }
    const built = buildRows(resp, seats, new Map([[workedSeat.id, [bucket]]]),
      DAY_INDEX, TODAY_IDX, TODAY_DAY, {})
    expect(built.find((r) => r.cardId === dueSeat.id)?.dueIdx).toBe(TODAY_IDX + 3)
    expect(built.find((r) => r.cardId === standingSeat.id)?.launchIdx).toBe(TODAY_IDX + 4)
    expect(built.find((r) => r.cardId === workedSeat.id)?.days.has(TODAY_DAY)).toBe(true)
    const throughContext = buildRows(resp, collectCards(resp), new Map([[workedSeat.id, [bucket]]]),
      DAY_INDEX, TODAY_IDX, TODAY_DAY, {})
    expect(throughContext.map((r) => r.cardId).sort()).toEqual(seats.map((c) => c.id).sort())
  })
})

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

  it('gives a FOLDED card its own row — the Desk hides it, the Chronicle does not', () => {
    // A never-run draft queued behind a desk head is drawn under that head on
    // the Desk and in no column of its own. That is a Desk reading; the card is
    // still work with a day, and it has no other route onto the Chronicle (a
    // never-run draft cannot win the activity join).
    const queued = baseCard({ id: 'science/mocks', due: dayAt(4), foldedUnder: 'science/cmbx' })
    const head = baseCard({ id: 'science/cmbx' })
    const resp = response({ now: { drafts: [head], inFlight: [], awaitingReview: [] }, folded: [queued] })
    const built = rows([queued, head], resp)
    expect(built.map((r) => r.cardId)).toContain('science/mocks')
    expect(built.find((r) => r.cardId === 'science/mocks')?.dueIdx).toBe(TODAY_IDX + 4)
  })
})
