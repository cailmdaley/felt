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
  abbreviateCwd,
  aggregateByCivilDay,
  attributeActivity,
  densityStep,
  lifelineExtent,
  saysNothingHere,
  sessionSlug,
  sessionUlid,
} from './ChronicleView.js'
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
    ...over,
  }
}

// ── Session parsing ──────────────────────────────────────────────────────────

describe('reading a tmux session name', () => {
  it('lifts the ULID out of `<slug>-<ULID>-shuttle`', () => {
    expect(sessionUlid('bmodes-2d-01KVBR1F9BWBVKF97473PV67K8-shuttle')).toBe(
      '01KVBR1F9BWBVKF97473PV67K8',
    )
  })

  it('upper-cases a lower-case ULID, so the two spellings join', () => {
    expect(sessionUlid('triage-01kvbr1f9bwbvkf97473pv67k8-shuttle')).toBe(
      '01KVBR1F9BWBVKF97473PV67K8',
    )
  })

  it('finds nothing in a name that carries no ULID', () => {
    expect(sessionUlid('morning-post-shuttle')).toBeNull()
    expect(sessionUlid(null)).toBeNull()
    // 25 characters is not a ULID.
    expect(sessionUlid('x-01KVBR1F9BWBVKF97473PV67K-shuttle')).toBeNull()
  })

  it('strips the suffix and the ULID to leave the slug', () => {
    expect(sessionSlug('bmodes-2d-01KVBR1F9BWBVKF97473PV67K8-shuttle')).toBe('bmodes-2d')
    expect(sessionSlug('morning-post-shuttle')).toBe('morning-post')
    expect(sessionSlug('')).toBeNull()
  })

  it('labels a working directory for its row', () => {
    expect(abbreviateCwd('/home/ada/dev/felt')).toBe('~/dev/felt')
    expect(abbreviateCwd('/Users/ada/dev/felt')).toBe('~/dev/felt')
    expect(abbreviateCwd('/srv/data/runs/nightly/2026')).toBe('…/runs/nightly/2026')
    // The home directory itself is `~`, not a `~/` with nothing after it.
    expect(abbreviateCwd('/home/ada')).toBe('~')
    expect(abbreviateCwd('/Users/ada/')).toBe('~')
  })
})

// ── The join ladder ──────────────────────────────────────────────────────────

describe('attributing activity to fibers', () => {
  const bmodes = card({
    id: 'work/spt3g_papers/bmodes-2d/run',
    uid: '01KVBR1F9BWBVKF97473PV67K8',
    runningWorker: 'bmodes-2d-01KVBR1F9BWBVKF97473PV67K8-shuttle',
  })
  const digest = card({ id: 'work/arxiv/daily-digest', status: 'closed' })
  const morning = card({ id: 'loom/email/morning-post/refine' })
  const ledger = card({ id: 'loom/felt-maintenance/ledger/sweep' })
  const cards = [bmodes, digest, morning, ledger]

  it('joins on the ULID the session name carries', () => {
    const at = attributeActivity(
      [bucket(1, { s: 'anything-01KVBR1F9BWBVKF97473PV67K8-shuttle', cwd: '/home/ada/elsewhere' })],
      cards,
    )
    expect(at.byCard.get(bmodes.id)).toHaveLength(1)
    expect(at.byCwd.size).toBe(0)
  })

  it('falls back to the session slug when the name has no ULID', () => {
    const at = attributeActivity([bucket(1, { s: 'morning-post-shuttle' })], cards)
    expect(at.byCard.get(morning.id)).toHaveLength(1)
  })

  // A directory tail is evidence about a PROJECT; a session name is evidence
  // about a WORKER. These two cases are the same error caught from both sides,
  // and they are why there is no directory rung at all.
  it('will not file a human\'s keystrokes under the one fiber nested in that directory', () => {
    // Two sessionless actors editing in a project directory. `daily-digest` is
    // a path segment of exactly one card, so the old ladder handed them to it.
    const at = attributeActivity(
      [
        bucket(1, { s: null, cwd: '/home/ada/work/daily-digest' }),
        bucket(2, { s: null, cwd: '/home/ada/work/daily-digest', k: 'attention' }),
      ],
      cards,
    )
    expect(at.byCard.size).toBe(0)
    expect(at.byCwd.get('/home/ada/work/daily-digest')).toHaveLength(2)
  })

  it('will not guess a directory for a worker whose fiber is off the board', () => {
    const at = attributeActivity(
      [
        bucket(1, {
          s: 'planning-01KXAX9HHA9VZC9DFA7RTATQC5-shuttle',
          cwd: '/home/ada/work/daily-digest',
        }),
      ],
      cards,
    )
    expect(at.byCard.size).toBe(0)
    expect(at.byCwd.get('/home/ada/work/daily-digest')).toHaveLength(1)
  })

  it('holds the same line for a ULID-free session name that resolves to nothing', () => {
    const at = attributeActivity(
      [bucket(1, { s: 'euclid-triage-shuttle', cwd: '/home/ada/work/daily-digest' })],
      cards,
    )
    expect(at.byCard.size).toBe(0)
    expect(at.byCwd.get('/home/ada/work/daily-digest')).toHaveLength(1)
  })

  it('labels a row of unresolved sessions `unmatched`, not `interactive`', () => {
    const at = attributeActivity(
      [
        bucket(1, { s: 'off-board-shuttle', cwd: '/home/ada/elsewhere' }),
        bucket(2, { s: null, cwd: '/home/ada/elsewhere' }),
      ],
      cards,
    )
    const list = at.byCwd.get('/home/ada/elsewhere') ?? []
    expect(list).toHaveLength(2)
    expect(list.every((b) => b.s === null)).toBe(false)
  })

  it('refuses an ambiguous token — a directory two fibers share is not a fiber', () => {
    // `loom` is a path segment of BOTH loom fibers, so it identifies neither;
    // the bucket becomes human work in that directory instead.
    const at = attributeActivity([bucket(1, { s: null, cwd: '/home/ada/loom' })], cards)
    expect(at.byCard.size).toBe(0)
    expect(at.byCwd.get('/home/ada/loom')).toHaveLength(1)
  })

  it('groups leftover interactive work by its directory', () => {
    const at = attributeActivity(
      [
        bucket(1, { s: null, cwd: '/home/ada/dev/felt' }),
        bucket(2, { s: null, cwd: '/home/ada/dev/felt', k: 'attention' }),
        bucket(3, { s: null, cwd: '/home/ada/notes' }),
      ],
      cards,
    )
    expect(at.byCard.size).toBe(0)
    expect(at.byCwd.get('/home/ada/dev/felt')).toHaveLength(2)
    expect(at.byCwd.get('/home/ada/notes')).toHaveLength(1)
  })

  it('drops only what has neither a session nor a directory', () => {
    const at = attributeActivity([bucket(1), bucket(2, { s: 'unknown-shuttle' })], cards)
    expect(at.byCard.size).toBe(0)
    expect(at.byCwd.size).toBe(0)
    expect(at.dropped).toBe(2)
  })

  it('prefers the live worker name over every weaker rung', () => {
    // The cwd tail would name `daily-digest`; the exact tmux name wins.
    const at = attributeActivity(
      [bucket(1, { s: bmodes.runningWorker, cwd: '/home/ada/work/daily-digest' })],
      cards,
    )
    expect(at.byCard.get(bmodes.id)).toHaveLength(1)
    expect(at.byCard.has(digest.id)).toBe(false)
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

  it('keeps a late evening and an early morning on their own local days', () => {
    const before = { ...DST_DAY, d: DST_DAY.d - 1 }
    const after = { ...DST_DAY, d: DST_DAY.d + 1 }
    const days = aggregateByCivilDay([
      // 23:30 the evening before the transition — already the next day in UTC
      // west of Greenwich, which is the Los Angeles half of the experiment.
      bucket(localMs(before, 23, 30), { n: 3 }),
      // 00:30 the morning after — still the previous day in UTC east of
      // Greenwich, which is the Paris half.
      bucket(localMs(after, 0, 30), { n: 5 }),
    ])
    expect([...days.keys()].sort()).toEqual([isoDayLocal(localMs(before, 23, 30)), isoDayLocal(localMs(after, 0, 30))])
    expect(days.get(isoDayLocal(localMs(before, 12)))?.agent).toBe(3)
    expect(days.get(isoDayLocal(localMs(after, 12)))?.agent).toBe(5)
  })

  it('gives the 23-hour transition day exactly one column, and its neighbours their own', () => {
    const before = { ...DST_DAY, d: DST_DAY.d - 1 }
    const after = { ...DST_DAY, d: DST_DAY.d + 1 }
    const days = aggregateByCivilDay([
      bucket(localMs(before, 22), { n: 1 }),
      bucket(localMs(DST_DAY, 1), { n: 2 }),
      bucket(localMs(DST_DAY, 12), { n: 4 }),
      bucket(localMs(DST_DAY, 23), { n: 8 }),
      bucket(localMs(after, 4), { n: 16 }),
    ])
    expect(days.size).toBe(3)
    // The whole transition day folds into one cell, DST notwithstanding.
    expect(days.get(isoDayLocal(localMs(DST_DAY, 12)))?.agent).toBe(2 + 4 + 8)
    expect(days.get(isoDayLocal(localMs(before, 12)))?.agent).toBe(1)
    expect(days.get(isoDayLocal(localMs(after, 12)))?.agent).toBe(16)
  })

  it('separates the three kinds within a day', () => {
    const days = aggregateByCivilDay([
      bucket(localMs(DST_DAY, 9), { k: 'agent', n: 12 }),
      bucket(localMs(DST_DAY, 10), { k: 'attention', n: 1 }),
      bucket(localMs(DST_DAY, 11), { k: 'notify', n: 1 }),
      bucket(localMs(DST_DAY, 14), { k: 'agent', n: 7 }),
    ])
    const cell = days.get(isoDayLocal(localMs(DST_DAY, 12)))
    expect(cell).toEqual({ agent: 19, attention: 1, notify: 1 })
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
