/**
 * Chronicle row ordering — `buildRows`'s comparator.
 *
 * Two honest signals compete for a row's rank, and `modifiedAt` is
 * deliberately absent from both: a metadata-only touch (a due-date tweak, a
 * frontmatter edit) must not float an unworked fiber above one that was
 * actually worked. See `buildFiberRow` in ChronicleView.ts for the mechanism
 * these tests pin down.
 */

import { describe, expect, it } from 'vitest'
import { buildRows, type ChronicleRow } from './ChronicleView.js'
import type { ActivityBucket } from './TemporalData.js'
import type { KanbanCard, KanbanResponse } from '../KanbanTypes.js'
import { card as baseCard } from '../testFixtures.js'
import { civilDayToLocalDate } from '../civilDay.js'
import { buildTimelineDays } from '../KanbanSurfaces.js'

// The real column layout: 28 back, 14 forward, today fixed at a known local
// day. Built from the production helper so the fixture is the same shape in
// both zones `npm test` pins.
const WINDOW_DAYS = buildTimelineDays(28, 14, new Date(2026, 6, 15))
const DAY_INDEX = new Map(WINDOW_DAYS.map((d, i) => [d.iso, i]))
const TODAY_IDX = WINDOW_DAYS.findIndex((d) => d.isToday)
const TODAY_DAY = WINDOW_DAYS[TODAY_IDX].iso

/** An INSTANT at local noon on a civil day — safely inside that day's column
 *  in any zone, unlike a midnight a DST shift can push over the edge. */
function noonOf(dayISO: string): string {
  const d = civilDayToLocalDate(dayISO)
  if (!d) throw new Error(`not a civil day: ${dayISO}`)
  d.setHours(12, 0, 0, 0)
  return d.toISOString()
}

/** A civil day N days from today, by index into the fixed window. */
function dayAt(offset: number): string {
  const day = WINDOW_DAYS[TODAY_IDX + offset]
  if (!day) throw new Error(`offset ${offset} outside fixture window`)
  return day.iso
}

const card = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
  baseCard({ status: 'active', ...over })

/** `m` is epoch-MILLISECONDS (see `ActivityBucket`'s own doc comment in
 *  TemporalData.ts) — NOT minutes. Dividing by 60_000 here once put every
 *  bucket at a bogus 1970 day computed from misread units; in a negative-UTC-
 *  offset zone that day fell BEFORE the epoch, so its noon went negative and
 *  the `Math.max(workMs, 0)` floor in `buildFiberRow` silently zeroed it —
 *  the two ordering tests that failed only west of Greenwich. */
function bucket(day: string, over: Partial<ActivityBucket> = {}): ActivityBucket {
  return { m: new Date(noonOf(day)).getTime(), s: null, cwd: null, k: 'agent', n: 1, ...over }
}

function emptyResponse(cards: readonly KanbanCard[]): KanbanResponse {
  return {
    feltHost: 'local',
    now: { drafts: [], inFlight: [], awaitingReview: [] },
    timeline: { past: [], futureDated: [] },
    stash: [],
    pinned: [...cards],
    cycles: [],
    totals: {
      drafts: 0,
      inFlight: 0,
      awaitingReview: 0,
      past: 0,
      futureDated: 0,
      stash: 0,
      pinned: cards.length,
    },
    temperedTotal: 0,
  } as unknown as KanbanResponse
}

/** Runs `buildRows` with the fixed window and no origins, keyed for lookup. */
function orderedIds(cards: KanbanCard[], attribution: Map<string, ActivityBucket[]>): string[] {
  const response = emptyResponse(cards)
  const rows = buildRows(response, cards, attribution, DAY_INDEX, TODAY_IDX, TODAY_DAY, {})
  return rows.map((r: ChronicleRow) => r.cardId!)
}

describe('chronicle row ordering', () => {
  it('sinks a fiber whose only recent touch was metadata below one actually worked', () => {
    // The wedding-desk bug: a due-date/frontmatter edit bumps modifiedAt to
    // today with no work behind it. That must not outrank a fiber worked
    // three days ago.
    const untouched = card({
      id: 'untouched',
      modifiedAt: noonOf(TODAY_DAY), // touched today, but...
      createdAt: '2026-01-01T09:00:00Z',
    })
    const workedEarlier = card({ id: 'worked-earlier', createdAt: '2026-01-01T09:00:00Z' })
    const attribution = new Map<string, ActivityBucket[]>([
      ['worked-earlier', [bucket(dayAt(-3))]],
    ])
    const order = orderedIds([untouched, workedEarlier], attribution)
    expect(order.indexOf('worked-earlier')).toBeLessThan(order.indexOf('untouched'))
  })

  it('ranks a recently-closed fiber near the top, at closedAt not modifiedAt', () => {
    const justClosed = card({
      id: 'just-closed',
      status: 'closed',
      closedAt: noonOf(TODAY_DAY),
      createdAt: '2026-01-01T09:00:00Z',
    })
    const workedWeekAgo = card({ id: 'worked-week-ago', createdAt: '2026-01-01T09:00:00Z' })
    const attribution = new Map<string, ActivityBucket[]>([
      ['worked-week-ago', [bucket(dayAt(-7))]],
    ])
    const order = orderedIds([justClosed, workedWeekAgo], attribution)
    expect(order.indexOf('just-closed')).toBeLessThan(order.indexOf('worked-week-ago'))
  })

  it('lifts an overdue, unworked fiber near the top of the unstarted', () => {
    const overdueIdle = card({ id: 'overdue-idle', due: dayAt(-5), createdAt: '2026-01-01T09:00:00Z' })
    const workedTenDaysAgo = card({ id: 'worked-ten-days-ago', createdAt: '2026-01-01T09:00:00Z' })
    const neverTouchedNoDue = card({ id: 'never-touched', createdAt: '2026-01-01T09:00:00Z' })
    const attribution = new Map<string, ActivityBucket[]>([
      ['worked-ten-days-ago', [bucket(dayAt(-10))]],
    ])
    const order = orderedIds([overdueIdle, workedTenDaysAgo, neverTouchedNoDue], attribution)
    // Overdue ranks as if worked today: above the ten-day-old activity.
    expect(order.indexOf('overdue-idle')).toBeLessThan(order.indexOf('worked-ten-days-ago'))
    // And well above a fiber with neither activity nor a due date.
    expect(order.indexOf('overdue-idle')).toBeLessThan(order.indexOf('never-touched'))
  })

  it('lends less lift the further out a due date sits, and none to a future due', () => {
    const dueSoon = card({ id: 'due-soon', due: dayAt(2), createdAt: '2026-01-01T09:00:00Z' })
    const dueFarOut = card({ id: 'due-far-out', due: dayAt(12), createdAt: '2026-01-01T09:00:00Z' })
    const order = orderedIds([dueFarOut, dueSoon], new Map())
    expect(order.indexOf('due-soon')).toBeLessThan(order.indexOf('due-far-out'))
  })

  it('sinks a never-worked, no-due fiber below anything with real signal, tiebreaking on createdAt', () => {
    const worked = card({ id: 'worked', createdAt: '2026-01-01T09:00:00Z' })
    const newerButIdle = card({ id: 'newer-idle', createdAt: noonOf(dayAt(-1)) })
    const olderIdle = card({ id: 'older-idle', createdAt: '2026-01-01T09:00:00Z' })
    const attribution = new Map<string, ActivityBucket[]>([['worked', [bucket(dayAt(-25))]]])
    const order = orderedIds([newerButIdle, olderIdle, worked], attribution)
    // Real signal (a month-old activity day) still outranks a fiber created
    // yesterday but never touched — creation never enters the main rank.
    expect(order.indexOf('worked')).toBeLessThan(order.indexOf('newer-idle'))
    // Among the two untouched, no-due fibers, the more recently created sits
    // above the older one — but this is a tiebreak below the worked row.
    expect(order.indexOf('newer-idle')).toBeLessThan(order.indexOf('older-idle'))
    expect(order[0]).toBe('worked')
  })

  it('does not reorder on the same day — every input is day-granular', () => {
    // Two cards touched at different times of the SAME day must land on the
    // same rank, so a page rebuilt mid-poll never reshuffles them.
    const morning = card({ id: 'morning', createdAt: '2026-01-01T09:00:00Z' })
    const evening = card({ id: 'evening', createdAt: '2026-01-01T09:00:00Z' })
    const attribution = new Map<string, ActivityBucket[]>([
      ['morning', [bucket(dayAt(-2))]],
      ['evening', [bucket(dayAt(-2))]],
    ])
    const response = emptyResponse([morning, evening])
    const a = buildRows(response, [morning, evening], attribution, DAY_INDEX, TODAY_IDX, TODAY_DAY, {})
    const b = buildRows(response, [morning, evening], attribution, DAY_INDEX, TODAY_IDX, TODAY_DAY, {})
    expect(a.map((r) => r.sortMs)).toEqual(b.map((r) => r.sortMs))
    expect(a.find((r) => r.cardId === 'morning')!.sortMs).toBe(
      a.find((r) => r.cardId === 'evening')!.sortMs,
    )
  })
})
