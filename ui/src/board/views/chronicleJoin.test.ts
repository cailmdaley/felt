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
  assignCycleLanes,
  buildCycleBands,
  densityStep,
  firstParagraph,
  formatMinutes,
  groupNarration,
  lifelineExtent,
  spanMinutes,
  railDate,
  readCycleBand,
  type CycleCard,
  saysNothingHere,
  sessionSlug,
  sessionUlid,
  shuttleOrigin,
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
    isCycle: false,
    cycleStart: null,
    ...over,
  }
}

/** A cycle as the `cycles` surface delivers it — just the span and a name. */
function cycle(id: string, start: string | null, due: string | undefined): CycleCard {
  return { id, name: id, originId: 'local', cycleStart: start, due }
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
  const ledgerCard = card({ id: 'loom/felt-maintenance/ledger/sweep' })
  const cards = [bmodes, digest, morning, ledgerCard]

  it('joins on the ULID the session name carries', () => {
    const at = attributeActivity(
      [bucket(1, { s: 'anything-01KVBR1F9BWBVKF97473PV67K8-shuttle', cwd: '/home/ada/elsewhere' })],
      cards,
    )
    expect(at.byCard.get(bmodes.id)).toHaveLength(1)
    expect(at.byCwd.size).toBe(0)
  })

  // Rung 0. The ledger is a recorded fact about whose work a session was; every
  // rung below it is an inference from a name.
  const ledger = (pairs: Record<string, { fiber: string; uid?: string }>) =>
    new Map(Object.entries(pairs).map(([k, v]) => [k, { fiber: v.fiber, uid: v.uid ?? null }]))

  it('joins through the session ledger before trying any name', () => {
    // A session with no ULID and a cwd that names nothing — unreachable by the
    // lower rungs, and exactly the actor the ledger exists for.
    const at = attributeActivity(
      [bucket(1, { s: 'pi-2f9c41', cwd: '/home/ada/work/photoz' })],
      cards,
      ledger({ 'pi-2f9c41': { fiber: morning.id } }),
    )
    expect(at.byCard.get(morning.id)).toHaveLength(1)
    expect(at.byCwd.size).toBe(0)
  })

  it('lets the ledger outrank a name that would have resolved elsewhere', () => {
    const at = attributeActivity(
      [bucket(1, { s: 'morning-post-shuttle' })],
      cards,
      ledger({ 'morning-post-shuttle': { fiber: ledgerCard.id } }),
    )
    expect(at.byCard.get(ledgerCard.id)).toHaveLength(1)
    expect(at.byCard.has(morning.id)).toBe(false)
  })

  it('pairs on the ULID when the ledger’s path has moved under it', () => {
    const at = attributeActivity(
      [bucket(1, { s: 'pi-2f9c41' })],
      cards,
      ledger({ 'pi-2f9c41': { fiber: 'some/old/path', uid: '01KVBR1F9BWBVKF97473PV67K8' } }),
    )
    expect(at.byCard.get(bmodes.id)).toHaveLength(1)
  })

  // The property the ledger must not break: it can move work between rows, and
  // it can never invent one. A record for a fiber this board does not show must
  // fall through to the honest cwd row rather than vanishing into a card that
  // has no row to draw.
  it('conjures no row for a ledger record whose fiber is off the board', () => {
    // Deliberately a session name no lower rung can match either — otherwise
    // this would pass on the slug rung and prove nothing about rung 0.
    const at = attributeActivity(
      [bucket(1, { s: 'pi-9a3f21', cwd: '/home/ada/elsewhere' })],
      cards,
      ledger({ 'pi-9a3f21': { fiber: 'loom/felt-maintenance/ledger/sweep-2019' } }),
    )
    expect(at.byCard.size).toBe(0)
    expect(at.byCwd.get('/home/ada/elsewhere')).toHaveLength(1)
  })

  it('is a no-op when no ledger is supplied', () => {
    const at = attributeActivity([bucket(1, { s: 'morning-post-shuttle' })], cards)
    expect(at.byCard.get(morning.id)).toHaveLength(1)
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
    expect(shuttleOrigin('remote-cineca-login')).toBe('cineca-login')
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
      originId: 'remote-cineca-login',
      cycleStart: WINDOW_DAYS[10].iso,
      due: WINDOW_DAYS[20].iso,
    }
    const band = readCycleBand(remote, WINDOW_DAYS, DAY_INDEX, CYCLE_NOW)
    expect(band?.originId).toBe('remote-cineca-login')
    expect(shuttleOrigin(band?.originId)).toBe('cineca-login')
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
    expect(spanMinutes(buckets, 'agent', t - 1, t + 300_000)).toBe(2)
    expect(spanMinutes(buckets, 'attention', t - 1, t + 300_000)).toBe(1)
  })

  it('counts only what falls inside the span', () => {
    const t = localMs(DST_DAY, 10)
    const buckets = [bucket(t - 600_000, { k: 'agent' }), bucket(t, { k: 'agent' })]
    expect(spanMinutes(buckets, 'agent', t - 1, t + 1)).toBe(1)
  })

  it('reads a duration the way a person says it', () => {
    expect(formatMinutes(0)).toBe('—')
    expect(formatMinutes(45)).toBe('45m')
    expect(formatMinutes(200)).toBe('3h 20m')
    expect(formatMinutes(120)).toBe('2h 0m')
  })

  it('gathers commits under the thing each was about', () => {
    const groups = groupNarration([
      { iso: 'x', subject: 'board: fold the masthead' },
      { iso: 'x', subject: 'board: adaptive strip height' },
      { iso: 'x', subject: 'daemon: owner-route the write plane' },
      { iso: 'x', subject: 'no colon here' },
    ])
    expect(groups.map((g) => [g.slug, g.count])).toEqual([
      ['board', 2],
      ['daemon', 1],
      ['elsewhere', 1],
    ])
    expect(groups[0].subjects).toEqual(['fold the masthead', 'adaptive strip height'])
  })

  it('keeps two subjects a group and four groups — a memoir, not a log', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ iso: 'x', subject: `s${i}: did a thing` }))
    const deep = Array.from({ length: 5 }, (_, i) => ({ iso: 'x', subject: `one: thing ${i}` }))
    expect(groupNarration(many)).toHaveLength(4)
    expect(groupNarration(deep)[0].subjects).toHaveLength(2)
    // Trimming what is shown must never trim what is counted.
    expect(groupNarration(deep)[0].count).toBe(5)
  })

  it('says a repeated message once, and lets the count carry the repetition', () => {
    const groups = groupNarration(
      Array.from({ length: 13 }, () => ({ iso: 'x', subject: 'board: fold the masthead' })),
    )
    expect(groups[0].count).toBe(13)
    expect(groups[0].subjects).toEqual(['fold the masthead'])
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
