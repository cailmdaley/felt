/**
 * The chronicle's two load-bearing pure steps: which fiber an activity bucket
 * belongs to, and which calendar column it lands in.
 *
 * The timezone is the experiment for the second half. `npm test` runs this file
 * twice — TZ=America/Los_Angeles (negative offset) and TZ=Europe/Paris
 * (positive offset) — because a UTC-only run passes against the broken code.
 * Each zone catches a different sign of the same defect:
 *
 *   • west of Greenwich, a late-evening instant has already crossed into the
 *     NEXT UTC day, so a `m / 86_400_000` bucketing files it a day early;
 *   • east of Greenwich, an early-morning instant is still in the PREVIOUS UTC
 *     day, so the same bucketing files it a day late.
 *
 * Both cases are asserted in both zones, and the day used is a DST transition
 * day — 23 hours long — so an implementation that strides by a fixed 86.4e6 ms
 * also drifts off the column it should have landed on.
 */

import { describe, expect, it } from 'vitest'
import {
  aggregateByCivilDay,
  attributeActivity,
  assignCycleLanes,
  buildCycleBands,
  densityStep,
  eraName,
  fiberBodyOf,
  fiberDocUrl,
  firstParagraph,
  groupNarration,
  lifelineExtent,
  railDate,
  spellFractions,
  readCycleBand,
  retirePendingCycles,
  type PendingCycle,
  rowDiffTotals,
  rowWaitingOn,
  type CycleCard,
  saysNothingHere,
  shuttleOrigin,
} from './ChronicleView.js'
import { buildLedgerNarration } from './join.js'
import type { LedgerNarration } from './join.js'
import { diffClause } from './vocabulary.js'
import type { CommitRecord, SessionPairing } from './TemporalData.js'
import { formatSpanMinutes, railBounds } from './railTime.js'
import { buildSessionIndex, foldActiveMinutes } from './TemporalData.js'
import type { ActivityBucket } from './TemporalData.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { civilDayToLocalDate, isoDayLocal } from '../civilDay.js'
import { buildTimelineDays } from '../KanbanSurfaces.js'

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

/** The spring-forward day in the zone this run is pinned to: 2026-03-08 in
 *  US Pacific, 2026-03-29 in Central European. Both are 23 hours long. */
const DST_DAY =
  TZ === 'America/Los_Angeles'
    ? { y: 2026, m: 2, d: 8 }
    : { y: 2026, m: 2, d: 29 }

/** A local wall-clock time on a given day, as epoch ms. The `Date` constructor
 *  reads its arguments in the ambient zone, which is exactly what we want:
 *  these are "23:30 wherever the reader is", the values a civil-day grouping
 *  has to get right. */
function localMs(day: { y: number; m: number; d: number }, h: number, min = 0): number {
  return new Date(day.y, day.m, day.d + 0, h, min, 0, 0).getTime()
}

function bucket(m: number, over: Partial<ActivityBucket> = {}): ActivityBucket {
  return { m, s: null, cwd: null, k: 'agent', n: 1, ...over }
}

function card(over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard {
  return {
    name: over.name ?? over.id,
    path: `.felt/${over.id}.md`,
    originId: 'local',
    status: 'active',
    createdAt: '2026-03-01T09:00:00Z',
    dependsOnSatisfied: true,
    effectiveHorizon: 'now',
    drifted: false,
    isCycle: false,
    cycleStart: null,
    ...over,
  }
}

/** A cycle as the `cycles` surface delivers it — just the span and a name. */
function cycle(id: string, start: string | null, due: string | undefined): CycleCard {
  return { id, name: id, originId: 'local', cycleStart: start, due }
}

// ── Naming an era ────────────────────────────────────────────────────────────

describe('naming an era from what was spoken', () => {
  it('takes an era\u2019s name from the opening clause of what was spoken', () => {
    expect(eraName('Cross-correlation season. Everything points at the shear maps.')).toBe(
      'Cross-correlation season',
    )
    // A line break ends the clause as surely as a full stop does — dictation
    // puts one where the speaker paused.
    expect(eraName('  Winter of the pipeline\nrewrite the whole runner  ')).toBe(
      'Winter of the pipeline',
    )
    // No sentence at all: the opening is clipped at a word boundary, and the
    // ellipsis says the rest is still there in the body.
    const long = eraName(
      'a very long stretch of unpunctuated intention that keeps going well past the width any single band on the strip could ever carry',
    )
    expect(long.length).toBeLessThanOrEqual(65)
    expect(long.endsWith('\u2026')).toBe(true)
    expect(long.startsWith('a very long stretch')).toBe(true)
    expect(eraName('   ')).toBe('')
  })
})

// ── The join ladder ──────────────────────────────────────────────────────────
//
// Two rungs, both recorded evidence (see join.ts's module doc): the session
// ledger's tmux→fiber pairing, and a bucket's session name being exactly a
// card's live worker. Nothing here reads a name for a fiber it might mean, so
// there is no cwd row and no dropped count — a bucket that joins nothing is
// simply absent from the returned map.

describe('attributing activity to fibers', () => {
  const bmodes = card({
    id: 'work/spt3g_papers/bmodes-2d/run',
    uid: '01KVBR1F9BWBVKF97473PV67K8',
    runningWorker: 'bmodes-2d-01KVBR1F9BWBVKF97473PV67K8-shuttle',
  })
  const morning = card({
    id: 'loom/email/morning-post/refine',
    runningWorker: 'morning-post-shuttle',
  })
  const ledgerCard = card({ id: 'loom/felt-maintenance/ledger/sweep' })
  const cards = [bmodes, morning, ledgerCard]

  // Rung 0. The ledger is a recorded fact about whose work a session was.
  const ledger = (pairs: Record<string, { fiber: string; uid?: string }>) =>
    new Map(
      Object.entries(pairs).map(([k, v]) => [
        k,
        { fiber: v.fiber, uid: v.uid ?? null, session: `sess-${k}`, host: null },
      ]),
    )

  it('joins through the session ledger — a session no other rung can place', () => {
    const at = attributeActivity(
      [bucket(1, { s: 'pi-2f9c41' })],
      cards,
      ledger({ 'pi-2f9c41': { fiber: morning.id } }),
    )
    expect(at.get(morning.id)).toHaveLength(1)
  })

  it('lets the ledger outrank the live worker name it would otherwise have matched', () => {
    const at = attributeActivity(
      [bucket(1, { s: 'morning-post-shuttle' })],
      cards,
      ledger({ 'morning-post-shuttle': { fiber: ledgerCard.id } }),
    )
    expect(at.get(ledgerCard.id)).toHaveLength(1)
    expect(at.has(morning.id)).toBe(false)
  })

  it('pairs on the ULID when the ledger\u2019s path has moved under it', () => {
    const at = attributeActivity(
      [bucket(1, { s: 'pi-2f9c41' })],
      cards,
      ledger({ 'pi-2f9c41': { fiber: 'some/old/path', uid: '01KVBR1F9BWBVKF97473PV67K8' } }),
    )
    expect(at.get(bmodes.id)).toHaveLength(1)
  })

  // The property the ledger must not break: it can move work between rows, and
  // it can never invent one. A record for a fiber this board does not show
  // falls through to nothing rather than resolving to a card that has no row.
  it('conjures no row for a ledger record whose fiber is off the board', () => {
    const at = attributeActivity(
      [bucket(1, { s: 'pi-9a3f21' })],
      cards,
      ledger({ 'pi-9a3f21': { fiber: 'loom/felt-maintenance/ledger/sweep-2019' } }),
    )
    expect(at.size).toBe(0)
  })

  // Cross-host. Two daemons each run a tmux session called `run-shuttle`, on
  // two different fibers. Flat, the second ledger line would overwrite the
  // first and one host's minutes would be inked on the other's lifeline; the
  // bucket's own `host` is what keeps the two apart.
  const crossHostLedger = buildSessionIndex([
    {
      at: 1,
      fiber: morning.id,
      uid: null,
      session: 'sess-ada',
      harness: 'claude-code',
      host: 'ada',
      tmux: 'run-shuttle',
      kind: 'dispatch',
    },
    {
      at: 2,
      fiber: ledgerCard.id,
      uid: null,
      session: 'sess-bob',
      harness: 'claude-code',
      host: 'bob',
      tmux: 'run-shuttle',
      kind: 'dispatch',
    },
  ]).byTmux

  it('keeps two hosts\u2019 identically-named tmux sessions on their own fibers', () => {
    const at = attributeActivity(
      [
        bucket(1, { s: 'run-shuttle', host: 'ada' }),
        bucket(2, { s: 'run-shuttle', host: 'bob' }),
        bucket(3, { s: 'run-shuttle', host: 'bob' }),
      ],
      cards,
      crossHostLedger,
    )
    expect(at.get(morning.id)).toHaveLength(1)
    expect(at.get(ledgerCard.id)).toHaveLength(2)
  })

  it('falls back to the bare name only for a bucket that cannot say where it ran', () => {
    // No host on the bucket — an old daemon's un-stamped response. The bare key
    // resolves to whichever host paired most recently, which is `bob` here.
    const at = attributeActivity([bucket(1, { s: 'run-shuttle' })], cards, crossHostLedger)
    expect(at.get(ledgerCard.id)).toHaveLength(1)
  })

  it('ranks a remote host\u2019s work on its own row, not the local one', () => {
    // The whole point of the cross-host read: ink from `ada` lands on `ada`'s
    // fiber even though `run-shuttle` also matches a fiber on `bob`.
    const at = attributeActivity([bucket(1, { s: 'run-shuttle', host: 'ada' })], cards, crossHostLedger)
    expect(at.has(ledgerCard.id)).toBe(false)
    expect(at.get(morning.id)).toHaveLength(1)
  })

  // Rung 1. A bucket's session name is exactly a live worker's tmux name.
  it('joins a live worker\u2019s exact tmux name with no ledger at all', () => {
    const at = attributeActivity([bucket(1, { s: bmodes.runningWorker })], cards)
    expect(at.get(bmodes.id)).toHaveLength(1)
  })

  it('drops a session that neither rung can place', () => {
    const at = attributeActivity([bucket(1), bucket(2, { s: 'unknown-shuttle' })], cards)
    expect(at.size).toBe(0)
  })
})

// ── Per-day aggregation, across a DST transition ─────────────────────────────

describe('folding buckets into civil days', () => {
  it('runs under a pinned, non-UTC timezone', () => {
    expect(TZ, 'run via `npm test` — the zone is what this suite tests').toMatch(
      /^(America\/Los_Angeles|Europe\/Paris)$/,
    )
    expect(new Date(2026, 2, 1).getTimezoneOffset()).not.toBe(0)
  })

  // The page groups by 6am RAILS, not midnights, so that it agrees with Day and
  // Week about which day a piece of work belongs to. Both halves of the old
  // UTC-floor experiment still bite — the late-evening bucket is already
  // tomorrow in UTC west of Greenwich, the small-hours one still yesterday east
  // of it — and the rail adds its own claim on top: 01:00 is the night before.
  it('keeps a late evening on its own day and folds the small hours backwards', () => {
    const before = { ...DST_DAY, d: DST_DAY.d - 1 }
    const after = { ...DST_DAY, d: DST_DAY.d + 1 }
    const days = aggregateByCivilDay([
      bucket(localMs(before, 23, 30), { n: 3 }),
      // 00:30 the morning after the transition day: before 6am, so it belongs
      // to the transition day's rail, NOT to its own calendar date.
      bucket(localMs(after, 0, 30), { n: 5 }),
    ])
    expect(days.get(isoDayLocal(localMs(before, 12)))?.agent).toBe(3)
    expect(days.get(isoDayLocal(localMs(DST_DAY, 12)))?.agent).toBe(5)
    expect(days.has(isoDayLocal(localMs(after, 12)))).toBe(false)
  })

  it('splits a rail at 06:00, not at midnight', () => {
    const days = aggregateByCivilDay([
      bucket(localMs(DST_DAY, 5, 59), { n: 1 }), // still the previous rail
      bucket(localMs(DST_DAY, 6, 1), { n: 2 }), // the new one
    ])
    const yesterday = { ...DST_DAY, d: DST_DAY.d - 1 }
    expect(days.get(isoDayLocal(localMs(yesterday, 12)))?.agent).toBe(1)
    expect(days.get(isoDayLocal(localMs(DST_DAY, 12)))?.agent).toBe(2)
  })

  it('gives the 23-hour transition rail exactly one column, and its neighbours their own', () => {
    const before = { ...DST_DAY, d: DST_DAY.d - 1 }
    const after = { ...DST_DAY, d: DST_DAY.d + 1 }
    const days = aggregateByCivilDay([
      bucket(localMs(before, 22), { n: 1 }), // before's rail
      bucket(localMs(DST_DAY, 1), { n: 2 }), // still before's rail — pre-6am
      bucket(localMs(DST_DAY, 12), { n: 4 }), // the transition rail
      bucket(localMs(DST_DAY, 23), { n: 8 }), // ditto
      bucket(localMs(after, 4), { n: 16 }), // ditto — the small hours after it
      bucket(localMs(after, 9), { n: 32 }), // and finally the next rail
    ])
    expect(days.size).toBe(3)
    // The transition rail is 23 hours long and still exactly one cell.
    expect(days.get(isoDayLocal(localMs(DST_DAY, 12)))?.agent).toBe(4 + 8 + 16)
    expect(days.get(isoDayLocal(localMs(before, 12)))?.agent).toBe(1 + 2)
    expect(days.get(isoDayLocal(localMs(after, 12)))?.agent).toBe(32)
  })

  it('separates the drawn kinds within a day, and drops notify entirely', () => {
    const days = aggregateByCivilDay([
      bucket(localMs(DST_DAY, 9), { k: 'agent', n: 12 }),
      bucket(localMs(DST_DAY, 10), { k: 'attention', n: 1 }),
      bucket(localMs(DST_DAY, 11), { k: 'notify', n: 1 }),
      bucket(localMs(DST_DAY, 14), { k: 'agent', n: 7 }),
    ])
    const cell = days.get(isoDayLocal(localMs(DST_DAY, 12)))
    expect(cell?.agent).toBe(19)
    expect(cell?.attention).toBe(1)
    // The notify bucket contributes to no figure — it is not a drawn state.
    expect(cell?.attentionAt).toHaveLength(1)
  })

  // A steering mark is an EVENT: collapsing a day's minutes to one centered
  // tick invents a time that never happened, and hides a second sitting.
  it('places each steering spell at its own time of day, and keeps two apart', () => {
    const days = aggregateByCivilDay([
      // 10:00 and 10:01 — one sitting, one tick.
      bucket(localMs(DST_DAY, 10, 0), { k: 'attention' }),
      bucket(localMs(DST_DAY, 10, 1), { k: 'attention' }),
      // 21:00 — the evening again, a second tick.
      bucket(localMs(DST_DAY, 21, 0), { k: 'attention' }),
    ])
    const cell = days.get(isoDayLocal(localMs(DST_DAY, 12)))!
    expect(cell.attention).toBe(3)
    expect(cell.attentionAt).toHaveLength(2)
    // Both fractions are measured against the rail this day actually has —
    // 23h on the spring transition, 25h in autumn — so they are checked by
    // reconstructing the instant rather than by a hardcoded number.
    const { startMs, endMs } = railBounds(isoDayLocal(localMs(DST_DAY, 12)))
    const at = (f: number) => new Date(startMs + f * (endMs - startMs))
    expect(at(cell.attentionAt[0]).getHours()).toBe(10)
    expect(at(cell.attentionAt[1]).getHours()).toBe(21)
    // Ordered, and both strictly inside the column.
    expect(cell.attentionAt[0]).toBeLessThan(cell.attentionAt[1])
    for (const f of cell.attentionAt) {
      expect(f).toBeGreaterThan(0)
      expect(f).toBeLessThan(1)
    }
  })

  it('gives a pre-dawn spell its place on the PREVIOUS rail, past the far end', () => {
    // 01:30 belongs to yesterday's rail, and sits 19.5h into it — the far
    // right of that column, not its middle.
    const days = aggregateByCivilDay([bucket(localMs(DST_DAY, 1, 30), { k: 'attention' })])
    const yesterday = isoDayLocal(localMs({ ...DST_DAY, d: DST_DAY.d - 1 }, 12))
    const cell = days.get(yesterday)!
    expect(cell.attentionAt).toHaveLength(1)
    expect(cell.attentionAt[0]).toBeGreaterThan(0.75)
  })

  it('folds only ADJACENT minutes into one spell', () => {
    const day = isoDayLocal(localMs(DST_DAY, 12))
    // Contiguous run, given out of order and with a repeat.
    const run = [11, 9, 10, 10].map((min) => localMs(DST_DAY, 14, min))
    expect(spellFractions(run, day)).toHaveLength(1)
    // One idle minute in the middle is two spells.
    expect(spellFractions([localMs(DST_DAY, 14, 9), localMs(DST_DAY, 14, 11)], day)).toHaveLength(2)
    expect(spellFractions([], day)).toEqual([])
    expect(spellFractions([localMs(DST_DAY, 14)], 'not-a-day')).toEqual([])
  })

  it('ignores a bucket with an unusable timestamp', () => {
    expect(aggregateByCivilDay([bucket(Number.NaN)]).size).toBe(0)
  })
})

// ── The lifeline, and the honesty of its close mark ──────────────────────────

// The real column layout: 28 back, 14 forward, today at index 28. Built from
// the production helper against a fixed LOCAL day, so the fixture is the same
// shape in both zones.
const WINDOW_DAYS = buildTimelineDays(28, 14, new Date(2026, 6, 15))
const DAY_INDEX = new Map(WINDOW_DAYS.map((d, i) => [d.iso, i]))
const TODAY_IDX = 28

/** An INSTANT at local noon on a civil day — safely inside that day's column
 *  in any zone, unlike a midnight that a DST shift can push over the edge. */
function noonOf(dayISO: string): string {
  const d = civilDayToLocalDate(dayISO)
  if (!d) throw new Error(`not a civil day: ${dayISO}`)
  d.setHours(12, 0, 0, 0)
  return d.toISOString()
}

describe('placing a fiber lifeline and its close', () => {
  it('ends the line at a close it can place, and marks it there', () => {
    const ext = lifelineExtent(
      {
        createdAt: noonOf(WINDOW_DAYS[20].iso),
        closedAt: noonOf(WINDOW_DAYS[24].iso),
        status: 'closed',
      },
      [],
      DAY_INDEX,
      TODAY_IDX,
    )
    expect(ext).toEqual({ startIdx: 20, endIdx: 24, closeIdx: 24, closed: true })
  })

  // The bug: a fiber closed months ago drew a solid line across the whole
  // window and stamped ✓ under today, reading as "closed today, 29 days".
  it('refuses to place a dated close that predates the window', () => {
    const ext = lifelineExtent(
      { createdAt: '2026-01-02T09:00:00Z', closedAt: '2026-01-05T09:00:00Z', status: 'closed' },
      [],
      DAY_INDEX,
      TODAY_IDX,
    )
    expect(ext.closeIdx).toBeNull()
    // Not today: the line must not claim the whole window.
    expect(ext.endIdx).toBe(0)
    expect(ext.startIdx).toBe(0)
  })

  it('falls back to today only when the close carries no date at all', () => {
    const ext = lifelineExtent(
      { createdAt: noonOf(WINDOW_DAYS[26].iso), closedAt: undefined, status: 'closed' },
      [],
      DAY_INDEX,
      TODAY_IDX,
    )
    expect(ext.closed).toBe(true)
    // No mark — we cannot say when it closed…
    expect(ext.closeIdx).toBeNull()
    // …but the line still has to end somewhere, and today is the honest guess.
    expect(ext.endIdx).toBe(TODAY_IDX)
  })

  it('runs an open fiber to today with no close mark', () => {
    const ext = lifelineExtent(
      { createdAt: noonOf(WINDOW_DAYS[10].iso), closedAt: undefined, status: 'active' },
      [],
      DAY_INDEX,
      TODAY_IDX,
    )
    expect(ext).toEqual({ startIdx: 10, endIdx: TODAY_IDX, closeIdx: null, closed: false })
  })

  it('stretches to cover in-window activity, close mark still suppressed', () => {
    const ext = lifelineExtent(
      { createdAt: '2026-01-02T09:00:00Z', closedAt: '2026-01-05T09:00:00Z', status: 'closed' },
      [WINDOW_DAYS[12].iso, WINDOW_DAYS[19].iso],
      DAY_INDEX,
      TODAY_IDX,
    )
    expect(ext.startIdx).toBe(0)
    expect(ext.endIdx).toBe(19)
    expect(ext.closeIdx).toBeNull()
  })

  it('never lets a lifeline reach past today', () => {
    const ext = lifelineExtent(
      { createdAt: noonOf(WINDOW_DAYS[TODAY_IDX + 5].iso), closedAt: undefined, status: 'active' },
      [],
      DAY_INDEX,
      TODAY_IDX,
    )
    expect(ext.startIdx).toBeLessThanOrEqual(TODAY_IDX)
    expect(ext.endIdx).toBeLessThanOrEqual(TODAY_IDX)
  })
})

describe('dropping fibers that finished before the window', () => {
  const closedLongAgo = (over: Partial<KanbanCard> = {}): KanbanCard =>
    card({
      id: 'work/old/thing',
      status: 'closed',
      createdAt: '2026-01-02T09:00:00Z',
      closedAt: '2026-01-05T09:00:00Z',
      ...over,
    })

  it('drops a dated close before the window with nothing to show', () => {
    expect(saysNothingHere(closedLongAgo(), [], DAY_INDEX)).toBe(true)
  })

  it('keeps it when it worked inside the window after all', () => {
    const buckets = [bucket(civilDayToLocalDate(WINDOW_DAYS[15].iso)!.getTime() + 12 * 3_600_000)]
    expect(saysNothingHere(closedLongAgo(), buckets, DAY_INDEX)).toBe(false)
  })

  it('keeps it when something is still promised inside the window', () => {
    expect(saysNothingHere(closedLongAgo({ due: WINDOW_DAYS[35].iso }), [], DAY_INDEX)).toBe(false)
    expect(
      saysNothingHere(
        closedLongAgo({ nextLaunchAt: noonOf(WINDOW_DAYS[32].iso) }),
        [],
        DAY_INDEX,
      ),
    ).toBe(false)
  })

  it('keeps an undated close — we cannot say it is history', () => {
    expect(saysNothingHere(closedLongAgo({ closedAt: undefined }), [], DAY_INDEX)).toBe(false)
  })

  it('keeps a close inside the window, and every open fiber', () => {
    expect(
      saysNothingHere(closedLongAgo({ closedAt: noonOf(WINDOW_DAYS[22].iso) }), [], DAY_INDEX),
    ).toBe(false)
    expect(saysNothingHere(card({ id: 'open/one' }), [], DAY_INDEX)).toBe(false)
  })
})

// ── Cycles ───────────────────────────────────────────────────────────────────

/** A fixed "now" inside the fixture window, so the open-ended case (which
 *  resolves its end against the clock) is deterministic. */
const CYCLE_NOW = civilDayToLocalDate(WINDOW_DAYS[TODAY_IDX].iso)!.getTime() + 12 * 3_600_000

describe('placing a cycle band on the day grid', () => {
  const place = (start: string | null, due: string | undefined) =>
    readCycleBand(cycle('c', start, due), WINDOW_DAYS, DAY_INDEX, CYCLE_NOW)

  it('spans start to due', () => {
    expect(place(WINDOW_DAYS[10].iso, WINDOW_DAYS[20].iso)).toMatchObject({
      startIdx: 10,
      endIdx: 20,
      openStart: false,
      openEnd: false,
    })
  })

  it('draws a single day when only the end is known', () => {
    // `cycleSpan` resolves a start-less cycle to one day at its end, so the
    // band is a dot on that column rather than a span back to the window edge.
    expect(place(null, WINDOW_DAYS[17].iso)).toMatchObject({
      startIdx: 17,
      endIdx: 17,
      openStart: false,
      openEnd: false,
    })
  })

  it('runs an open-ended cycle to today with an open right edge', () => {
    // This is also the state a freshly drawn cycle sits in between its two
    // writes — start on disk, due not yet.
    expect(place(WINDOW_DAYS[24].iso, undefined)).toMatchObject({
      startIdx: 24,
      endIdx: TODAY_IDX,
      openStart: false,
      openEnd: true,
    })
  })

  it('clamps to the window edges and says which edge it ran past', () => {
    const early = place('2026-01-04', WINDOW_DAYS[6].iso)
    expect(early).toMatchObject({ startIdx: 0, endIdx: 6, openStart: true, openEnd: false })
    const late = place(WINDOW_DAYS[38].iso, '2027-02-01')
    expect(late).toMatchObject({ startIdx: 38, endIdx: 42, openStart: false, openEnd: true })
    const spanning = place('2026-01-04', '2027-02-01')
    expect(spanning).toMatchObject({ startIdx: 0, endIdx: 42, openStart: true, openEnd: true })
  })

  it('drops a cycle that misses the window on either side', () => {
    expect(place('2026-01-01', '2026-01-20')).toBeNull()
    expect(place('2027-01-01', '2027-01-20')).toBeNull()
  })

  it('drops a cycle with no dates at all', () => {
    expect(place(null, undefined)).toBeNull()
  })

  it('never draws a negative-width band from contradictory dates', () => {
    const band = place(WINDOW_DAYS[20].iso, WINDOW_DAYS[12].iso)
    expect(band?.startIdx).toBe(20)
    expect(band?.endIdx).toBe(20)
  })

  it('places bands in the future half — a cycle is a span, not a memory', () => {
    expect(place(WINDOW_DAYS[TODAY_IDX + 2].iso, WINDOW_DAYS[TODAY_IDX + 9].iso)).toMatchObject({
      startIdx: TODAY_IDX + 2,
      endIdx: TODAY_IDX + 9,
    })
  })
})

describe('routing a cycle write to its owner', () => {
  it('strips the remote- prefix and defaults to local', () => {
    expect(shuttleOrigin('remote-basalt-login')).toBe('basalt-login')
    expect(shuttleOrigin('local')).toBe('local')
    expect(shuttleOrigin(undefined)).toBe('local')
  })

  it('carries the owning origin onto the band, so an edge drag can route by it', () => {
    // The grips and the review write act on an existing fiber, and a
    // remote-owned cycle has to be written where it lives. Same-host the two
    // origins agree, which is exactly why sending a literal went unnoticed.
    const remote: CycleCard = {
      id: 'cycles/remote-era',
      name: 'Remote era',
      originId: 'remote-basalt-login',
      cycleStart: WINDOW_DAYS[10].iso,
      due: WINDOW_DAYS[20].iso,
    }
    const band = readCycleBand(remote, WINDOW_DAYS, DAY_INDEX, CYCLE_NOW)
    expect(band?.originId).toBe('remote-basalt-login')
    expect(shuttleOrigin(band?.originId)).toBe('basalt-login')
  })
})

describe('stacking overlapping cycles into lanes', () => {
  const lanes = (spans: Array<[number, number]>) =>
    assignCycleLanes(spans.map(([startIdx, endIdx]) => ({ startIdx, endIdx }))).map((b) => b.lane)

  it('keeps disjoint cycles on one lane', () => {
    expect(lanes([[0, 4], [5, 9], [10, 14]])).toEqual([0, 0, 0])
  })

  it('opens a lane per overlapping cycle', () => {
    expect(lanes([[0, 10], [2, 12], [4, 14]])).toEqual([0, 1, 2])
  })

  it('reuses a lane the moment its band has ended', () => {
    // Touching is not overlapping the other way round: [0,4] then [5,9] share.
    // But [0,5] and [5,9] do overlap on day 5, so they must not.
    expect(lanes([[0, 5], [5, 9]])).toEqual([0, 1])
  })

  it('shares the soonest-free lane past the cap rather than hiding a cycle', () => {
    const assigned = lanes([[0, 20], [1, 20], [2, 20], [3, 20], [4, 20]])
    expect(assigned).toHaveLength(5) // nothing dropped
    expect(Math.max(...assigned)).toBe(2) // never exceeds MAX_CYCLE_LANES - 1
  })

  it('honours a caller-supplied cap', () => {
    const assigned = assignCycleLanes(
      [{ startIdx: 0, endIdx: 9 }, { startIdx: 1, endIdx: 9 }, { startIdx: 2, endIdx: 9 }],
      2,
    ).map((b) => b.lane)
    expect(Math.max(...assigned)).toBe(1)
  })

  it('builds bands and lanes together, dropping the out-of-window ones', () => {
    const bands = buildCycleBands(
      [
        cycle('a', WINDOW_DAYS[2].iso, WINDOW_DAYS[12].iso),
        cycle('b', WINDOW_DAYS[6].iso, WINDOW_DAYS[18].iso),
        cycle('gone', '2020-01-01', '2020-02-01'),
      ],
      WINDOW_DAYS,
      DAY_INDEX,
      CYCLE_NOW,
    )
    expect(bands.map((b) => b.id)).toEqual(['a', 'b'])
    expect(bands.map((b) => b.lane)).toEqual([0, 1])
  })
})

describe('which day the page calls today', () => {
  it('is the rail that is running, not the calendar date, before 6am', () => {
    // 01:00 — Day and Week are still on yesterday's rail, and so must this page
    // be, or clicking its today header opens a rail that has not started.
    const smallHours = new Date(2026, 6, 15, 1, 0, 0).getTime()
    expect(isoDayLocal(railDate(smallHours).getTime())).toBe('2026-07-14')
  })

  it('is the calendar date once the rail has opened', () => {
    expect(isoDayLocal(railDate(new Date(2026, 6, 15, 6, 1, 0).getTime()).getTime())).toBe(
      '2026-07-15',
    )
    expect(isoDayLocal(railDate(new Date(2026, 6, 15, 23, 30, 0).getTime()).getTime())).toBe(
      '2026-07-15',
    )
  })

  it('lands at noon, the one wall-clock hour every DST day has', () => {
    // A spring-forward day has no 02:00; anchoring the rail date at midnight
    // and striding from it is how a day goes missing.
    const d = railDate(new Date(DST_DAY.y, DST_DAY.m, DST_DAY.d, 14, 0, 0).getTime())
    expect(d.getHours()).toBe(12)
  })
})

// ── The look-back ────────────────────────────────────────────────────────────

describe('composing an era’s look-back', () => {
  it('counts minutes, not events — a busy minute is still one minute', () => {
    const t = localMs(DST_DAY, 10)
    const buckets = [
      bucket(t, { k: 'agent', n: 40 }),
      bucket(t, { k: 'agent', n: 7 }), // same minute, second bucket
      bucket(t + 60_000, { k: 'agent', n: 1 }),
      bucket(t + 120_000, { k: 'attention', n: 1 }),
    ]
    expect(foldActiveMinutes(buckets, { fromMs: t - 1, toMs: t + 300_001 }).agent).toBe(2)
    expect(foldActiveMinutes(buckets, { fromMs: t - 1, toMs: t + 300_001 }).attention).toBe(1)
  })

  it('counts only what falls inside the span', () => {
    const t = localMs(DST_DAY, 10)
    const buckets = [bucket(t - 600_000, { k: 'agent' }), bucket(t, { k: 'agent' })]
    expect(foldActiveMinutes(buckets, { fromMs: t - 1, toMs: t + 2 }).agent).toBe(1)
  })

  it('reads a duration the way a person says it', () => {
    expect(formatSpanMinutes(0, { empty: '—' })).toBe('—')
    expect(formatSpanMinutes(45, { empty: '—' })).toBe('45m')
    expect(formatSpanMinutes(200, { empty: '—' })).toBe('3h 20m')
    expect(formatSpanMinutes(120, { empty: '—' })).toBe('2h 0m')
  })

  // groupNarration reads the COMMIT LEDGER's attribution now — a hook recorded
  // which harness session made each commit, and the session ledger names that
  // session's fiber. No subject line is read for identity, so a group is keyed
  // by cardId, not by a `slug: ` prefix a human might have mistyped or skipped.
  const ledgerCards = [card({ id: 'a/board', name: 'Board work' }), card({ id: 'b/daemon', name: 'Daemon work' })]

  /** One ledger commit. Only what the joins and the totals read is spelled out;
   *  the rest is the shape the wire always carries. */
  function commit(over: Partial<CommitRecord> & Pick<CommitRecord, 'sha'>): CommitRecord {
    return {
      at: localMs(DST_DAY, 12),
      subject: 'a subject',
      repo: 'felt',
      files: 1,
      insertions: 0,
      deletions: 0,
      session: 's1',
      tmux: null,
      cwd: null,
      // Host-agnostic pairings, so the host-scoping rung is not what these
      // cases are testing.
      host: null,
      ...over,
    }
  }

  /** Session→fiber pairings with no host of their own, so any host's commit may
   *  read them — the ledger's own `bySession` shape. */
  function pairings(pairs: readonly (readonly [string, string])[]): Map<string, SessionPairing> {
    return new Map(
      pairs.map(([session, fiber]) => [session, { fiber, uid: null, session, host: null }]),
    )
  }

  it('gathers commits under the fiber the ledger attributed them to', () => {
    const ledger: LedgerNarration = {
      byCard: new Map([
        ['a/board', { subjects: ['fold the masthead', 'adaptive strip height'], commits: 2, insertions: 0, deletions: 0 }],
        ['b/daemon', { subjects: ['owner-route the write plane'], commits: 1, insertions: 0, deletions: 0 }],
      ]),
    }
    const groups = groupNarration(ledger, ledgerCards)
    expect(groups.map((g) => [g.cardId, g.count])).toEqual([
      ['a/board', 2],
      ['b/daemon', 1],
    ])
    expect(groups[0].subjects).toEqual(['fold the masthead', 'adaptive strip height'])
  })

  it('drops a fiber the ledger names that this board does not carry', () => {
    // Attributing to an absent card would put a link in the look-back that
    // opens nothing — the ledger's claim is dropped instead.
    const ledger: LedgerNarration = {
      byCard: new Map([
        ['a/board', { subjects: [], commits: 1, insertions: 0, deletions: 0 }],
        ['gone/fiber', { subjects: [], commits: 99, insertions: 0, deletions: 0 }],
      ]),
    }
    expect(groupNarration(ledger, ledgerCards).map((g) => g.cardId)).toEqual(['a/board'])
  })

  it('keeps two subjects a group and four groups — a memoir, not a log', () => {
    const many = Array.from({ length: 9 }, (_, i) => card({ id: `f${i}`, name: `Fiber ${i}` }))
    const deep = card({ id: 'deep', name: 'Deep' })
    const manyLedger: LedgerNarration = {
      byCard: new Map(
        many.map((c, i) => [c.id, { subjects: [`thing ${i}`], commits: many.length - i, insertions: 0, deletions: 0 }]),
      ),
    }
    const deepLedger: LedgerNarration = {
      byCard: new Map([
        [deep.id, {
          subjects: Array.from({ length: 5 }, (_, i) => `thing ${i}`),
          commits: 5,
          insertions: 0,
          deletions: 0,
        }],
      ]),
    }
    expect(groupNarration(manyLedger, many)).toHaveLength(4)
    expect(groupNarration(deepLedger, [deep])[0].subjects).toHaveLength(2)
    // Trimming what is shown must never trim what is counted.
    expect(groupNarration(deepLedger, [deep])[0].count).toBe(5)
  })

  it('says a repeated message once, and lets the count carry the repetition', () => {
    const ledger: LedgerNarration = {
      byCard: new Map([
        ['a/board', {
          subjects: Array.from({ length: 13 }, () => 'fold the masthead'),
          commits: 13,
          insertions: 0,
          deletions: 0,
        }],
      ]),
    }
    const groups = groupNarration(ledger, ledgerCards)
    expect(groups[0].count).toBe(13)
    expect(groups[0].subjects).toEqual(['fold the masthead'])
  })

  // ── The gutter's line counts ───────────────────────────────────────────────
  // `+A −D` on a fiber row is RECORDED EVIDENCE: the commits the ledger's own
  // session→fiber pairing resolved onto that card, inside the drawn window, and
  // nothing else. No subject-line prefix is read, and a commit the join cannot
  // place contributes to no row's total.

  it('sums a row total from the commits the join resolved onto it', () => {
    const ledger: LedgerNarration = {
      byCard: new Map([
        ['a/board', { subjects: ['fold the masthead'], commits: 2, insertions: 512, deletions: 208 }],
        ['b/daemon', { subjects: [], commits: 1, insertions: 30, deletions: 0 }],
      ]),
    }
    const totals = rowDiffTotals(ledger, [{ cardId: 'a/board' }, { cardId: 'b/daemon' }])
    expect(totals.get('a/board')).toEqual({ insertions: 512, deletions: 208 })
    expect(totals.get('b/daemon')).toEqual({ insertions: 30, deletions: 0 })
  })

  it('gives a row with no recorded commits no clause at all', () => {
    // ABSENT, not zero: the row prints nothing, and `+0 −0` is a false
    // precision the gutter must never assert. A row with no card cannot be
    // asked about at all.
    const ledger: LedgerNarration = {
      byCard: new Map([['a/board', { subjects: [], commits: 1, insertions: 4, deletions: 1 }]]),
    }
    const totals = rowDiffTotals(ledger, [{ cardId: 'a/board' }, { cardId: 'quiet/fiber' }, {}])
    expect(totals.has('quiet/fiber')).toBe(false)
    expect(totals.size).toBe(1)
    expect(diffClause(0, 0)).toBe('')
  })

  it('drops a commit the ledger cannot place on this board', () => {
    // buildLedgerNarration keeps only what a pairing resolves to a card here;
    // an unresolvable session is evidence of nothing this page can draw.
    const records: CommitRecord[] = [
      commit({ sha: 'aaa', session: 's1', insertions: 10, deletions: 2 }),
      commit({ sha: 'bbb', session: 'unknown', insertions: 900, deletions: 900 }),
      commit({ sha: 'ccc', session: null, insertions: 900, deletions: 900 }),
    ]
    const ledger = buildLedgerNarration(records, ledgerCards, pairings([['s1', 'a/board']]))
    const totals = rowDiffTotals(ledger, ledgerCards.map((c) => ({ cardId: c.id })))
    expect(totals.get('a/board')).toEqual({ insertions: 10, deletions: 2 })
    expect(totals.size).toBe(1)
  })

  it('counts one sha once, however many hosts served it', () => {
    // The composite can hand back the same commit twice — a remote's cached
    // read overlapping the local one. Counting it twice would double the lines.
    const records: CommitRecord[] = [
      commit({ sha: 'dup', session: 's1', insertions: 100, deletions: 40, host: 'local' }),
      commit({ sha: 'dup', session: 's1', insertions: 100, deletions: 40, host: 'candide' }),
      commit({ sha: 'other', session: 's1', insertions: 5, deletions: 0 }),
    ]
    const ledger = buildLedgerNarration(records, ledgerCards, pairings([['s1', 'a/board']]))
    expect(ledger.byCard.get('a/board')?.commits).toBe(2)
    expect(rowDiffTotals(ledger, [{ cardId: 'a/board' }]).get('a/board')).toEqual({
      insertions: 105,
      deletions: 40,
    })
  })

  it('takes the intention from the first real paragraph of a body', () => {
    expect(firstParagraph('# Heading\n\nThe intention.\nSecond line.\n\nLater.')).toBe(
      'The intention. Second line.',
    )
    // `Fiber.body` is the markdown AFTER the frontmatter, so there is no fence
    // to strip — only headings and blank blocks stand between us and the line.
    expect(firstParagraph('## Why\n\nBecause it was time.')).toBe('Because it was time.')
    expect(firstParagraph(undefined)).toBe('')
    expect(firstParagraph('\n\n   \n')).toBe('')
  })
})

describe('density steps', () => {
  it('maps to three steps against the window peak', () => {
    expect(densityStep(100, 100)).toBe(3)
    expect(densityStep(60, 100)).toBe(3)
    expect(densityStep(30, 100)).toBe(2)
    expect(densityStep(5, 100)).toBe(1)
  })

  it('never divides by an empty window', () => {
    expect(densityStep(0, 0)).toBe(1)
    expect(densityStep(3, 0)).toBe(1)
  })
})

// ── Staleness ────────────────────────────────────────────────────────────────

describe('a row waits on its origin, and only on its own', () => {
  const origins = {
    local: { kind: 'local' as const, stale: false },
    ada: { kind: 'remote' as const, stale: true, lastError: 'timeout' },
    bob: { kind: 'remote' as const, stale: false },
  }

  it('names the host a wholly-remote row is waiting on', () => {
    expect(rowWaitingOn({ originId: 'remote-ada' }, 'ada', origins)).toBe('ada')
  })

  it('says nothing about a remote that is answering', () => {
    expect(rowWaitingOn({ originId: 'remote-bob' }, 'bob', origins)).toBeNull()
  })

  // The local daemon answers for itself. A remote falling behind says nothing
  // about this host's own record, and graying it would be a false claim.
  it('never mutes a locally-owned row', () => {
    expect(rowWaitingOn({ originId: 'local' }, 'ada', origins)).toBeNull()
  })

  // A thin window is not an error: an origin nobody reports on is one nothing
  // claims to be waiting for.
  it('reads an unmentioned origin as fresh rather than guessing', () => {
    expect(rowWaitingOn({ originId: 'remote-cass' }, 'cass', origins)).toBeNull()
    expect(rowWaitingOn({ originId: 'remote-ada' }, 'ada', {})).toBeNull()
  })

  it('resolves the origin under any of the three spellings the board uses', () => {
    expect(rowWaitingOn({ originId: 'ada' }, 'ada', origins)).toBe('ada')
    // Only the hostname matches here — the board's id for it is opaque.
    expect(rowWaitingOn({ originId: 'remote-7f2' }, 'ada', origins)).toBe('ada')
  })
})

/**
 * The optimistic band and the document it stands for.
 *
 * A cycle drawn on the strip appears before the daemon's polled feed carries
 * it. That courtesy cost the page its whole gesture: the ghost was retired only
 * when a poll echoed its NAME, and until then the band took no clicks — a
 * cycle you had just drawn, dated and named did nothing when you clicked it,
 * for up to a poll interval. The id the create hands back closes that window.
 */
describe('retirePendingCycles', () => {
  const ghost = (name: string, id?: string): PendingCycle => ({
    name,
    startDay: '2026-08-10',
    endDay: '2026-08-12',
    id,
  })

  it('retires a ghost the served feed carries by id', () => {
    const served = [{ id: '01ULID', name: 'renamed on disk' }]
    expect(retirePendingCycles([ghost('before', '01ULID')], served)).toEqual([])
  })

  it('retires by name for a ghost whose create has not answered yet', () => {
    expect(retirePendingCycles([ghost('before')], [{ id: '01ULID', name: 'before' }])).toEqual([])
  })

  it('keeps a ghost the feed knows nothing about', () => {
    const held = retirePendingCycles([ghost('before', 'cycles/before')], [{ id: '01OTHER', name: 'elsewhere' }])
    expect(held.map((p) => p.name)).toEqual(['before'])
  })
})

/**
 * The intention line reads a fiber DOCUMENT, and the daemon answers documents
 * in the list envelope — `{fibers:[{fiber:{…}}]}`. The old reader looked for
 * `doc.fiber.body` on that envelope and so found nothing on every response it
 * ever got: the era face was silent about every cycle, written or not.
 */
describe('fiberBodyOf', () => {
  it('reads the body out of the list envelope the daemon sends', () => {
    const doc = { fibers: [{ fiber: { id: '01ULID', body: 'The era in which.' } }] }
    expect(fiberBodyOf(doc)).toBe('The era in which.')
  })

  it('accepts the flatter shapes a relay or an older daemon may send', () => {
    expect(fiberBodyOf({ fiber: { body: 'flat' } })).toBe('flat')
    expect(fiberBodyOf({ body: 'flatter' })).toBe('flatter')
    expect(fiberBodyOf({ fibers: [{ body: 'on the entry' }] })).toBe('on the entry')
  })

  // A drawn era carries no prose — the drag asks when, not what. That is an
  // absence the face states, not a failure it should render as one.
  it('is undefined for a fiber with no body at all', () => {
    expect(fiberBodyOf({ fibers: [{ fiber: { id: '01ULID' } }] })).toBeUndefined()
    expect(fiberBodyOf({ fibers: [{ fiber: { body: '   ' } }] })).toBeUndefined()
    expect(fiberBodyOf({ fibers: [] })).toBeUndefined()
    expect(fiberBodyOf(null)).toBeUndefined()
  })
})

describe('fiberDocUrl', () => {
  it('encodes each id segment but keeps a slug id intact', () => {
    expect(fiberDocUrl('http://h:4000', 'cycles/before')).toBe(
      'http://h:4000/api/v1/fibers/cycles/before',
    )
    expect(fiberDocUrl('http://h:4000', 'cycles/a b')).toBe('http://h:4000/api/v1/fibers/cycles/a%20b')
  })
})

/**
 * A due written as an INSTANT is what felt stores — `2026-08-12` goes in and
 * `2026-08-12T00:00:00Z` comes back — so a cycle band must read the civil day
 * out of either spelling and place the same three days.
 */
describe('a cycle whose due came back as an instant', () => {
  it('spans the same days as the date-only spelling', () => {
    const [from, to] = [WINDOW_DAYS[10].iso, WINDOW_DAYS[12].iso]
    const asWritten = readCycleBand(cycle('c', from, to), WINDOW_DAYS, DAY_INDEX, CYCLE_NOW)
    const asStored = readCycleBand(
      cycle('c', `${from}T00:00:00Z`, `${to}T00:00:00Z`),
      WINDOW_DAYS,
      DAY_INDEX,
      CYCLE_NOW,
    )
    expect(asStored).toEqual(asWritten)
    expect(asStored?.openEnd).toBe(false)
  })
})
