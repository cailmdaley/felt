/**
 * The shape of a day — the arithmetic DayView draws.
 *
 * Everything here is built from LOCAL wall-clock constructors
 * (`new Date(y, m, d, h, min)`), never from a `Z` literal, because the whole
 * subject is a civil day in the viewer's zone. `npm test` runs the file twice
 * (TZ=America/Los_Angeles, then TZ=Europe/Paris) so a rule that only holds at
 * one sign of UTC offset fails loudly instead of passing vacuously.
 */

import { describe, expect, it, vi } from 'vitest'
import type { KanbanCard } from '../KanbanTypes.js'
import type { ActivityBucket, ActivityResult, NarrationCommit } from './TemporalData.js'
import {
  buildDayEntries,
  buildDayLanes,
  buildDayModel,
  buildDayPreviews,
  buildStillAhead,
  closureMark,
  commitsOnRail,
  cwdLaneLabel,
  dayTotals,
  dayWindow,
  defaultDayISO,
  firstSentence,
  formatClockTime,
  formatEntryStats,
  formatSpanHM,
  groupCommitsBySlug,
  isLivePresent,
  laneChip,
  mergeMinuteRuns,
  narrationRange,
  resolveDayISO,
  sessionSlug,
  shiftCivilDay,
  stepTarget,
  tmuxFiberUlid,
  type DayLane,
} from './DayView.js'

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

const at = (y: number, m: number, d: number, h = 0, min = 0): number =>
  new Date(y, m - 1, d, h, min).getTime()

describe('the pinned test zone', () => {
  it('runs under a non-UTC zone — the civil day is what this suite tests', () => {
    expect(TZ, 'run via `npm test`, which pins TZ on both passes').toMatch(
      /^(America\/Los_Angeles|Europe\/Paris)$/,
    )
    expect(new Date(2026, 7, 4).getTimezoneOffset()).not.toBe(0)
  })
})

describe('which day the view opens on', () => {
  it('takes today once the day has started (06:00 or later)', () => {
    expect(defaultDayISO(at(2026, 8, 4, 6, 0))).toBe('2026-08-04')
    expect(defaultDayISO(at(2026, 8, 4, 13, 30))).toBe('2026-08-04')
    expect(defaultDayISO(at(2026, 8, 4, 23, 59))).toBe('2026-08-04')
  })

  it('takes YESTERDAY before 06:00 — small-hours work belongs to the evening it grew from', () => {
    expect(defaultDayISO(at(2026, 8, 5, 0, 1))).toBe('2026-08-04')
    expect(defaultDayISO(at(2026, 8, 5, 3, 14))).toBe('2026-08-04')
    expect(defaultDayISO(at(2026, 8, 5, 5, 59))).toBe('2026-08-04')
  })

  it('crosses a month and a year boundary backwards', () => {
    expect(defaultDayISO(at(2026, 9, 1, 2, 0))).toBe('2026-08-31')
    expect(defaultDayISO(at(2027, 1, 1, 4, 0))).toBe('2026-12-31')
  })

  it('shifts a civil day without a UTC round trip', () => {
    expect(shiftCivilDay('2026-08-04', -1)).toBe('2026-08-03')
    expect(shiftCivilDay('2026-08-04', 1)).toBe('2026-08-05')
    expect(shiftCivilDay('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftCivilDay('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('the shared temporal cursor', () => {
  const NOW = at(2026, 8, 4, 13, 30)

  it('shows the cursor day when the cursor holds one', () => {
    expect(resolveDayISO('2026-07-19', NOW)).toBe('2026-07-19')
  })

  it('resolves a null cursor against the clock, not once at mount', () => {
    expect(resolveDayISO(null, NOW)).toBe('2026-08-04')
    expect(resolveDayISO(undefined, NOW)).toBe('2026-08-04')
    // The same null cursor, read after midnight but before 06:00, is still
    // the day the evening grew from — the live present, re-resolved.
    expect(resolveDayISO(null, at(2026, 8, 5, 2, 0))).toBe('2026-08-04')
    expect(resolveDayISO(null, at(2026, 8, 5, 6, 1))).toBe('2026-08-05')
  })

  it('coerces a cursor carrying an instant, and falls back on nonsense', () => {
    // normalizeFocusDate warns on both — that is the point of it, and the
    // warning is not what this test is about.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(resolveDayISO('2026-07-19T22:15:00Z', NOW)).toBe('2026-07-19')
      expect(resolveDayISO('not a day', NOW)).toBe('2026-08-04')
      expect(resolveDayISO('', NOW)).toBe('2026-08-04')
    } finally {
      warn.mockRestore()
    }
  })

  it('writes an explicit day when paging away from today', () => {
    expect(stepTarget('2026-08-04', -1, NOW)).toBe('2026-08-03')
    expect(stepTarget('2026-08-03', -1, NOW)).toBe('2026-08-02')
    expect(stepTarget('2026-08-04', 1, NOW)).toBe('2026-08-05')
  })

  it('hands the cursor back to the live present when a step lands on today', () => {
    // Null, not "2026-08-04": pinning the date would go stale at 06:00
    // tomorrow, and the board can be left open overnight.
    expect(stepTarget('2026-08-03', 1, NOW)).toBeNull()
    expect(stepTarget('2026-08-05', -1, NOW)).toBeNull()
    // And the "today" it compares against is the 06:00-aware one: at 03:00 on
    // the 5th, today is still the 4th, so a step onto the 4th releases the
    // cursor while a step onto the 5th pins it.
    expect(stepTarget('2026-08-03', 1, at(2026, 8, 5, 3, 0))).toBeNull()
    expect(stepTarget('2026-08-04', 1, at(2026, 8, 5, 3, 0))).toBe('2026-08-05')
  })
})

describe('knowing when you are away from today', () => {
  const NOW = at(2026, 8, 4, 13, 30)

  it('is home on today, away on any other day', () => {
    expect(isLivePresent('2026-08-04', NOW)).toBe(true)
    expect(isLivePresent('2026-08-03', NOW)).toBe(false)
    expect(isLivePresent('2026-08-05', NOW)).toBe(false)
  })

  it('counts the small hours as still being home', () => {
    // At 02:00 on the 5th the live rail is the 4th's. A page showing the 4th
    // then IS today, and must not offer to take you somewhere you already are.
    const preDawn = at(2026, 8, 5, 2, 0)
    expect(isLivePresent('2026-08-04', preDawn)).toBe(true)
    expect(isLivePresent('2026-08-05', preDawn)).toBe(false)
    // And once the day turns at 06:00, the same two answers swap.
    const afterDawn = at(2026, 8, 5, 6, 30)
    expect(isLivePresent('2026-08-04', afterDawn)).toBe(false)
    expect(isLivePresent('2026-08-05', afterDawn)).toBe(true)
  })

  it('agrees with stepTarget about where home is', () => {
    // Both read the same rule, so a step that releases the cursor is exactly a
    // step onto the day the affordance would hide for.
    for (const nowMs of [NOW, at(2026, 8, 5, 2, 0), at(2026, 8, 5, 6, 30)]) {
      const home = defaultDayISO(nowMs)
      expect(isLivePresent(home, nowMs)).toBe(true)
      expect(stepTarget(shiftCivilDay(home, -1), 1, nowMs)).toBeNull()
    }
  })
})

describe('the 06:00 → 06:00 window', () => {
  it('starts and ends at local 06:00, one civil day apart', () => {
    const win = dayWindow('2026-08-04')
    expect(win.startMs).toBe(at(2026, 8, 4, 6))
    expect(win.endMs).toBe(at(2026, 8, 5, 6))
    expect(win.minutes).toBe(24 * 60)
    expect(new Date(win.startMs).getHours()).toBe(6)
    expect(new Date(win.endMs).getHours()).toBe(6)
  })

  it('is 23 or 25 hours across a DST transition, never assumed 1440', () => {
    // A 06:00 day absorbs the shift from the calendar date AFTER it: both
    // zones move their clocks in the small hours, which this view counts as
    // part of the previous day. So the short/long window is the one named by
    // the day BEFORE the transition date (Mar 8 / Nov 1 in the US, Mar 29 /
    // Oct 25 in the EU). The zones' dates differ, hence the branch.
    const springForward = TZ === 'America/Los_Angeles' ? '2026-03-07' : '2026-03-28'
    const fallBack = TZ === 'America/Los_Angeles' ? '2026-10-31' : '2026-10-24'
    expect(dayWindow(springForward).minutes).toBe(23 * 60)
    expect(dayWindow(fallBack).minutes).toBe(25 * 60)
    // The window still opens and closes at wall-clock 06:00 on both.
    for (const day of [springForward, fallBack]) {
      const win = dayWindow(day)
      expect(new Date(win.startMs).getHours()).toBe(6)
      expect(new Date(win.endMs).getHours()).toBe(6)
    }
  })
})

describe('merging active minutes into spans', () => {
  it('fuses adjacent minutes into one run, end-exclusive', () => {
    expect(mergeMinuteRuns([10, 11, 12])).toEqual([{ start: 10, end: 13 }])
  })

  it('bridges a gap of exactly five inactive minutes', () => {
    // 10 active, 11-15 idle, 16 active — a five-minute pause inside one run.
    expect(mergeMinuteRuns([10, 16])).toEqual([{ start: 10, end: 17 }])
  })

  it('breaks on a gap of six', () => {
    expect(mergeMinuteRuns([10, 17])).toEqual([
      { start: 10, end: 11 },
      { start: 17, end: 18 },
    ])
  })

  it('honours a custom bridge, including zero (adjacency only)', () => {
    expect(mergeMinuteRuns([10, 16], 4)).toEqual([
      { start: 10, end: 11 },
      { start: 16, end: 17 },
    ])
    expect(mergeMinuteRuns([10, 11, 13], 0)).toEqual([
      { start: 10, end: 12 },
      { start: 13, end: 14 },
    ])
  })

  it('sorts and de-duplicates its input', () => {
    expect(mergeMinuteRuns([12, 10, 10, 11])).toEqual([{ start: 10, end: 13 }])
  })

  it('is empty for no minutes', () => {
    expect(mergeMinuteRuns([])).toEqual([])
  })
})

// ── Activity fixtures ────────────────────────────────────────────────────────

const DAY = '2026-08-04'
const WIN = dayWindow(DAY)
/** A fixed instant inside the rail, so chip and closure logic is deterministic. */
const NOW_IN_RAIL = at(2026, 8, 4, 15, 0)

const bucket = (
  minute: number,
  k: ActivityBucket['k'],
  s: string | null = null,
  cwd: string | null = null,
): ActivityBucket => ({ m: WIN.startMs + minute * 60_000, s, cwd, k, n: 1 })

const activity = (buckets: ActivityBucket[], host = 'ada-workstation'): ActivityResult => ({
  host,
  from_ms: WIN.startMs,
  to_ms: WIN.endMs,
  buckets,
})

const FIBER_ULID = '01KVBR1F9BWBVKF97473PV67K8'
const SESSION = `bmodes-2d-${FIBER_ULID}-shuttle`

const card = (over: Partial<KanbanCard> = {}): KanbanCard => ({
  id: 'work/spt3g_papers/bmodes-2d',
  uid: FIBER_ULID,
  name: 'Run the 2D B-mode null tests',
  path: '.felt/x.md',
  originId: 'local',
  status: 'active',
  createdAt: new Date(WIN.startMs).toISOString(),
  dependsOnSatisfied: true,
  effectiveHorizon: 'now',
  drifted: false,
  isCycle: false,
  cycleStart: null,
  ...over,
})

describe("the day's two totals", () => {
  it('counts a minute once per kind however many buckets it holds', () => {
    const totals = dayTotals(
      activity([
        bucket(0, 'attention', SESSION),
        bucket(0, 'attention', null, '/home/ada/loom'),
        bucket(0, 'agent', SESSION),
        bucket(1, 'agent', SESSION),
        bucket(2, 'agent', SESSION),
        bucket(9, 'notify', SESSION),
      ]),
      WIN,
    )
    expect(totals).toEqual({ attention: 1, agent: 3 })
  })

  it('ignores buckets outside the 06:00 → 06:00 window at both ends', () => {
    const outside: ActivityBucket[] = [
      { m: WIN.startMs - 60_000, s: null, cwd: null, k: 'agent', n: 1 },
      { m: WIN.endMs, s: null, cwd: null, k: 'agent', n: 1 },
      { m: WIN.endMs + 60_000, s: null, cwd: null, k: 'attention', n: 1 },
    ]
    expect(dayTotals(activity([...outside, bucket(5, 'agent')]), WIN)).toEqual({
      attention: 0,
      agent: 1,
    })
  })

  it('counts a notify minute as neither attention nor agent', () => {
    expect(dayTotals(activity([bucket(30, 'notify')]), WIN)).toEqual({ attention: 0, agent: 0 })
  })

  it('formats a span the head line can wear', () => {
    expect(formatSpanHM(0)).toBe('0m')
    expect(formatSpanHM(47)).toBe('47m')
    expect(formatSpanHM(60)).toBe('1h 00m')
    expect(formatSpanHM(125)).toBe('2h 05m')
  })
})

describe('lanes', () => {
  it('joins a bucket to a fiber through the ULID in its tmux session name', () => {
    expect(tmuxFiberUlid(SESSION)).toBe(FIBER_ULID)
    expect(tmuxFiberUlid('morning-post-shuttle')).toBeNull()
    expect(tmuxFiberUlid(null)).toBeNull()

    const lanes = buildDayLanes(
      activity([bucket(60, 'agent', SESSION), bucket(61, 'attention', SESSION)]),
      [card({ shuttleHost: 'Ada-Workstation' })],
      WIN,
    )
    expect(lanes).toHaveLength(1)
    expect(lanes[0].kind).toBe('fiber')
    expect(lanes[0].label).toBe('Run the 2D B-mode null tests')
    expect(lanes[0].cardId).toBe('work/spt3g_papers/bmodes-2d')
    expect(lanes[0].agent).toEqual([{ start: 60, end: 61 }])
    expect(lanes[0].attention).toEqual([{ start: 61, end: 62 }])
    expect(lanes[0].weight).toBe(2)
    // The page's own host is printed once in the head, so a lane that ran
    // there says nothing; only a lane that ran ELSEWHERE names its host.
    expect(lanes[0].hostNote).toBe('')
  })

  it('names a host only when the lane ran somewhere other than the page', () => {
    const elsewhere = buildDayLanes(
      activity([bucket(60, 'agent', SESSION)]),
      [card({ shuttleHost: 'Cineca-Login-02' })],
      WIN,
    )
    expect(elsewhere[0].hostNote).toBe('cineca-login-02')

    const sameHost = buildDayLanes(
      activity([bucket(60, 'agent', SESSION)]),
      [card({ shuttleHost: 'Ada-Workstation' })],
      WIN,
    )
    expect(sameHost[0].hostNote).toBe('')
  })

  it('drops unjoined work into cwd lanes below the fiber lanes', () => {
    const lanes = buildDayLanes(
      activity([
        bucket(10, 'agent', null, '/home/ada/dev/felt'),
        bucket(11, 'agent', null, '/home/ada/dev/felt'),
        // A session that resolves to no card: a worker, not a person.
        bucket(12, 'agent', 'some-other-01ZZZ-shuttle', '/Users/ada/loom'),
        bucket(13, 'agent', SESSION),
      ]),
      [card()],
      WIN,
    )
    expect(lanes.map((l) => l.kind)).toEqual(['fiber', 'loose', 'loose'])
    expect(lanes[1].label).toBe('~/dev/felt · interactive')
    expect(lanes[2].label).toBe('~/loom · unmatched')
    expect(lanes[1].cardId).toBeUndefined()
  })

  it('labels a null cwd rather than dropping the minutes', () => {
    expect(cwdLaneLabel(null)).toBe('elsewhere · interactive')
    expect(cwdLaneLabel('/var/tmp')).toBe('/var/tmp · interactive')
    const lanes = buildDayLanes(activity([bucket(4, 'agent')]), [], WIN)
    expect(lanes).toHaveLength(1)
    expect(lanes[0].label).toBe('elsewhere · interactive')
  })

  it('sorts fiber lanes by the weight of the day, heaviest first', () => {
    const otherUlid = '01KVBR1F9BWBVKF97473PV67K9'
    const lanes = buildDayLanes(
      activity([
        bucket(1, 'agent', `light-${otherUlid}-shuttle`),
        bucket(2, 'agent', SESSION),
        bucket(3, 'agent', SESSION),
      ]),
      [card(), card({ id: 'other', uid: otherUlid, name: 'A lighter fiber' })],
      WIN,
    )
    expect(lanes.map((l) => l.label)).toEqual(['Run the 2D B-mode null tests', 'A lighter fiber'])
  })

  it('bridges a five-minute pause inside one lane run', () => {
    const lanes = buildDayLanes(
      activity([bucket(100, 'agent', SESSION), bucket(106, 'agent', SESSION)]),
      [card()],
      WIN,
    )
    expect(lanes[0].agent).toEqual([{ start: 100, end: 107 }])
  })
})

describe('the join ladder', () => {
  // Every rung below is a session shape the daemon really produces, and every
  // miss has the same consequence: the bucket lands on a lane labelled
  // "interactive", which says a human was typing when an agent was working.

  it('joins a session name whose ULID is lower-cased', () => {
    expect(tmuxFiberUlid(`bmodes-2d-${FIBER_ULID.toLowerCase()}-shuttle`)).toBe(FIBER_ULID)
    const lanes = buildDayLanes(
      activity([bucket(20, 'agent', `bmodes-2d-${FIBER_ULID.toLowerCase()}-shuttle`)]),
      [card()],
      WIN,
    )
    expect(lanes[0].kind).toBe('fiber')
    expect(lanes[0].cardId).toBe('work/spt3g_papers/bmodes-2d')
  })

  it('joins the legacy leaf-only session name the dispatcher still emits', () => {
    expect(sessionSlug('morning-post-shuttle')).toBe('morning-post')
    expect(sessionSlug(`bmodes-2d-${FIBER_ULID}-shuttle`)).toBe('bmodes-2d')
    const lanes = buildDayLanes(
      activity([bucket(20, 'agent', 'morning-post-shuttle', '/home/ada/loom')]),
      [card({ id: 'loom/email/morning-post/refine', uid: undefined, name: 'Morning post' })],
      WIN,
    )
    expect(lanes[0].kind).toBe('fiber')
    expect(lanes[0].label).toBe('Morning post')
  })

  it('joins an exact live-worker tmux name even with no ULID in it', () => {
    const lanes = buildDayLanes(
      activity([bucket(20, 'agent', 'legacy-worker-name')]),
      [card({ uid: undefined, runningWorker: 'legacy-worker-name' })],
      WIN,
    )
    expect(lanes[0].kind).toBe('fiber')
  })

  it('never joins on the working directory — a directory names a project', () => {
    // The cwd tail `spt3g_papers` uniquely names this card's path. It still
    // does not join, for a WORKER whose session resolved to nothing…
    const worker = buildDayLanes(
      activity([bucket(20, 'agent', 'scratch-shuttle', '/home/ada/work/spt3g_papers')]),
      [card()],
      WIN,
    )
    expect(worker[0].kind).toBe('loose')
    expect(worker[0].label).toBe('~/work/spt3g_papers · unmatched')

    // …nor for a person typing in the same directory. A repo root routinely
    // shares its name with one fiber nested inside it, and that coincidence is
    // not evidence about what the work was.
    const human = buildDayLanes(
      activity([bucket(20, 'agent', null, '/home/ada/work/spt3g_papers')]),
      [card()],
      WIN,
    )
    expect(human[0].kind).toBe('loose')
    expect(human[0].label).toBe('~/work/spt3g_papers · interactive')
  })

  it('refuses a session slug two cards answer to, rather than guessing', () => {
    // Both cards have a `refine` segment, so the session slug names neither.
    const lanes = buildDayLanes(
      activity([bucket(20, 'agent', 'refine-shuttle', '/home/ada/loom')]),
      [
        card({ id: 'loom/email/refine', uid: undefined, name: 'One' }),
        card({ id: 'loom/notes/refine', uid: undefined, name: 'Two' }),
      ],
      WIN,
    )
    expect(lanes[0].kind).toBe('loose')
    expect(lanes[0].label).toBe('~/loom · unmatched')
  })

  it('calls an unjoined WORKER unmatched and a sessionless bucket interactive', () => {
    expect(cwdLaneLabel('/home/ada/loom', true)).toBe('~/loom · unmatched')
    expect(cwdLaneLabel('/home/ada/loom', false)).toBe('~/loom · interactive')
    expect(cwdLaneLabel(null, true)).toBe('elsewhere · unmatched')
  })

  it('keeps worker and human work in the same directory on separate lanes', () => {
    const lanes = buildDayLanes(
      activity([
        bucket(20, 'agent', 'stranger-01ZZZ-shuttle', '/home/ada/loom'),
        bucket(21, 'attention', null, '/home/ada/loom'),
      ]),
      [],
      WIN,
    )
    expect(lanes.map((l) => l.label).sort()).toEqual([
      '~/loom · interactive',
      '~/loom · unmatched',
    ])
  })
})

describe('rung 0 — the session ledger', () => {
  // The ledger is a RECORD, not an inference: the daemon wrote down which
  // fiber it dispatched a session for. It goes ahead of every name-derived
  // rung because it can read a session name that carries no ULID and no
  // recognizable slug, which is the case that justifies its existence.
  const pairing = (fiber: string, uid: string | null = null) => ({ fiber, uid })

  it('joins a session name that carries nothing to infer from', () => {
    // `pi-2f9c41`: no ULID, no slug matching any card. Every lower rung misses.
    expect(tmuxFiberUlid('pi-2f9c41')).toBeNull()
    const naked = buildDayLanes(activity([bucket(20, 'agent', 'pi-2f9c41')]), [card()], WIN)
    expect(naked[0].kind).toBe('loose')

    const withLedger = buildDayLanes(
      activity([bucket(20, 'agent', 'pi-2f9c41')]),
      [card()],
      WIN,
      new Map([['pi-2f9c41', pairing('work/spt3g_papers/bmodes-2d')]]),
    )
    expect(withLedger[0].kind).toBe('fiber')
    expect(withLedger[0].cardId).toBe('work/spt3g_papers/bmodes-2d')
  })

  it('resolves through the pairing’s ULID when its fiber path has moved', () => {
    const ledger = new Map([['pi-2f9c41', pairing('some/old/path', FIBER_ULID.toLowerCase())]])
    const lanes = buildDayLanes(activity([bucket(20, 'agent', 'pi-2f9c41')]), [card()], WIN, ledger)
    expect(lanes[0].cardId).toBe('work/spt3g_papers/bmodes-2d')
  })

  it('falls THROUGH a pairing for a fiber this board does not carry', () => {
    // Resolving to an absent card would drop the minutes off the page: no
    // fiber lane to hold them, and no cwd lane either. Losing time silently is
    // worse than mis-filing it.
    const ledger = new Map([['pi-2f9c41', pairing('not/on/this/board', null)]])
    const lanes = buildDayLanes(
      activity([bucket(20, 'agent', 'pi-2f9c41', '/home/ada/work/photoz')]),
      [card()],
      WIN,
      ledger,
    )
    expect(lanes[0].kind).toBe('loose')
    expect(lanes[0].label).toBe('~/work/photoz · unmatched')
  })

  it('leaves the lanes the lower rungs already got right exactly where they were', () => {
    const buckets = activity([bucket(20, 'agent', SESSION)])
    const without = buildDayLanes(buckets, [card()], WIN)
    const agreeing = buildDayLanes(
      buckets,
      [card()],
      WIN,
      new Map([[SESSION, pairing('work/spt3g_papers/bmodes-2d', FIBER_ULID)]]),
    )
    expect(agreeing[0].cardId).toBe(without[0].cardId)
    expect(agreeing[0].weight).toBe(without[0].weight)
  })

  it('conjures no lane from a pairing whose session did no work today', () => {
    // The ledger outlives its sessions — that is the point of the file. A
    // three-day-old record must not put an empty rail on today's page.
    const ledger = new Map([['sweep-old-shuttle', pairing('loom/felt-maintenance/ledger/sweep')]])
    const lanes = buildDayLanes(activity([]), [card()], WIN, ledger)
    expect(lanes).toEqual([])
  })

  it('is ignored for a bucket with no session at all', () => {
    const ledger = new Map([['pi-2f9c41', pairing('work/spt3g_papers/bmodes-2d')]])
    const lanes = buildDayLanes(
      activity([bucket(20, 'agent', null, '/home/ada/notes')]),
      [card()],
      WIN,
      ledger,
    )
    expect(lanes[0].kind).toBe('loose')
    expect(lanes[0].label).toBe('~/notes · interactive')
  })
})

describe('the narration window against the rail', () => {
  // The rail is 06:00→06:00; the narration route speaks inclusive civil days,
  // midnight to midnight. Widen by a day, then discard by the rail's edges.

  it('asks for the day and the one after it', () => {
    expect(narrationRange('2026-08-04')).toEqual({ from: '2026-08-04', to: '2026-08-05' })
    expect(narrationRange('2026-12-31')).toEqual({ from: '2026-12-31', to: '2027-01-01' })
  })

  const commitAt = (ms: number, subject = 'x: y'): NarrationCommit => ({
    iso: new Date(ms).toISOString(),
    subject,
  })

  it('keeps a post-midnight commit on the rail it was made on', () => {
    // 01:30 on the 5th is the tail of the 4th's session, not the 5th's morning.
    const late = commitAt(at(2026, 8, 5, 1, 30))
    expect(commitsOnRail([late], WIN)).toEqual([late])
  })

  it('discards the early overhang — before 06:00 belongs to yesterday', () => {
    expect(commitsOnRail([commitAt(at(2026, 8, 4, 3, 0))], WIN)).toEqual([])
  })

  it('is inclusive at 06:00 and exclusive at the next 06:00', () => {
    expect(commitsOnRail([commitAt(WIN.startMs)], WIN)).toHaveLength(1)
    expect(commitsOnRail([commitAt(WIN.endMs)], WIN)).toHaveLength(0)
    expect(commitsOnRail([commitAt(WIN.endMs - 1)], WIN)).toHaveLength(1)
  })

  it('drops a commit whose timestamp will not parse', () => {
    expect(commitsOnRail([{ iso: 'not a time', subject: 'x: y' }], WIN)).toEqual([])
  })

  it('does not fabricate "wrote nothing down" for a fiber that committed at 01:30', () => {
    // The review's scenario end to end: work 22:00 → 02:00 on one fiber, its
    // commit landing after midnight. Before the fix the prose said the fiber
    // worked and wrote nothing, while its own commit sat on the next page.
    const model = buildDayModel(
      DAY,
      activity([bucket(16 * 60, 'agent', SESSION), bucket(19 * 60 + 30, 'agent', SESSION)]),
      [commitAt(at(2026, 8, 5, 1, 30), 'bmodes-2d: ran the nulls')],
      [card()],
    )
    expect(model.entries).toHaveLength(1)
    expect(model.entries[0]).toMatchObject({
      title: 'Run the 2D B-mode null tests',
      body: 'ran the nulls',
      cardId: 'work/spt3g_papers/bmodes-2d',
    })
    expect(model.entries[0].fallback).toBeUndefined()
  })

  it('keeps yesterday’s small hours off this page', () => {
    const model = buildDayModel(
      DAY,
      activity([bucket(60, 'agent', SESSION)]),
      [commitAt(at(2026, 8, 4, 2, 0), 'somewhere-else: finished last night')],
      [card({ outcome: 'Ran the nulls.' })],
    )
    // The 02:00 commit is Aug 3's; all this page can say is the fallback.
    expect(model.entries.map((e) => e.title)).toEqual(['Run the 2D B-mode null tests'])
    expect(model.entries[0].fallback).toBe(true)
  })
})

describe('two fibers with the same leaf slug', () => {
  // Nested ids are the norm in this store, so a shared leaf is ordinary. Each
  // fiber has its own ULID, which is how both lanes get drawn at all — the
  // ambiguity bites at the NARRATION step, where all a commit carries is
  // `board: `.
  const OTHER_ULID = '01KVBR5W2QJ6K8M3N7P4R9TSDF'
  const felt = card({ id: 'felt/board', name: 'Felt board', outcome: 'Tidy it.' })
  const lightcone = card({
    id: 'lightcone/board',
    uid: OTHER_ULID,
    name: 'Lightcone board',
    outcome: 'Ship it.',
  })
  const twoLanes = (): DayLane[] =>
    buildDayLanes(
      activity([
        bucket(10, 'agent', `board-${FIBER_ULID}-shuttle`, '/home/ada/felt/board'),
        bucket(20, 'agent', `board-${OTHER_ULID}-shuttle`, '/home/ada/lightcone/board'),
      ]),
      [felt, lightcone],
      WIN,
    )

  it('draws both lanes', () => {
    const lanes = twoLanes()
    expect(lanes.map((l) => l.cardId).sort()).toEqual(['felt/board', 'lightcone/board'])
    // Both answer to the same commit prefix — that is the hazard.
    expect(lanes.every((l) => l.slugs.includes('board'))).toBe(true)
  })

  it('refuses to attribute the shared slug to either fiber', () => {
    const entries = buildDayEntries(
      [{ iso: new Date(WIN.startMs).toISOString(), subject: 'board: fold the masthead' }],
      twoLanes(),
      [felt, lightcone],
      WIN,
      NOW_IN_RAIL,
    )
    const commitEntry = entries.find((e) => e.key === 'slug:board')
    expect(commitEntry?.body).toBe('fold the masthead')
    // No card: a click that opened one of two candidates would open the wrong
    // fiber half the time.
    expect(commitEntry?.cardId).toBeUndefined()
  })

  it('still gives BOTH lanes their own line', () => {
    const entries = buildDayEntries(
      [{ iso: new Date(WIN.startMs).toISOString(), subject: 'board: fold the masthead' }],
      twoLanes(),
      [felt, lightcone],
      WIN,
      NOW_IN_RAIL,
    )
    const fallbacks = entries.filter((e) => e.fallback)
    // Titled as their LANES are, which is also what makes them distinguishable
    // where the shared leaf slug would not have been.
    expect(fallbacks.map((e) => e.title).sort()).toEqual(['Felt board', 'Lightcone board'])
    expect(fallbacks.map((e) => e.body).sort()).toEqual(['Ship it.', 'Tidy it.'])
  })

  it('still attributes — and still suppresses — when the slug is unique', () => {
    const lanes = buildDayLanes(activity([bucket(10, 'agent', SESSION)]), [card()], WIN)
    const entries = buildDayEntries(
      [{ iso: new Date(WIN.startMs).toISOString(), subject: 'bmodes-2d: ran the nulls' }],
      lanes,
      [card()],
      WIN,
      NOW_IN_RAIL,
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].cardId).toBe('work/spt3g_papers/bmodes-2d')
  })
})

describe('what a day cost, per fiber', () => {
  it('counts raw minutes, NOT the bridged render spans', () => {
    // 100 and 106 merge into one 7-minute span for drawing, because a
    // five-minute pause inside a run is a pause. But only two minutes of work
    // happened, and the ledger must say two.
    const lanes = buildDayLanes(
      activity([
        bucket(100, 'agent', SESSION),
        bucket(106, 'agent', SESSION),
        bucket(200, 'attention', SESSION),
      ]),
      [card()],
      WIN,
    )
    expect(lanes[0].agent).toEqual([{ start: 100, end: 107 }])
    expect(lanes[0].agentMinutes).toBe(2)
    expect(lanes[0].attentionMinutes).toBe(1)
  })

  it('does not double-count a minute that carried several buckets', () => {
    const lanes = buildDayLanes(
      activity([
        bucket(10, 'agent', SESSION),
        bucket(10, 'agent', SESSION, '/elsewhere'),
        bucket(10, 'attention', SESSION),
      ]),
      [card()],
      WIN,
    )
    expect(lanes[0].agentMinutes).toBe(1)
    expect(lanes[0].attentionMinutes).toBe(1)
  })

  it('reports the lane minutes and the commit count on the entry', () => {
    const lanes = buildDayLanes(
      activity([
        bucket(10, 'attention', SESSION),
        bucket(11, 'agent', SESSION),
        bucket(12, 'agent', SESSION),
      ]),
      [card()],
      WIN,
    )
    const entries = buildDayEntries(
      [
        { iso: new Date(WIN.startMs).toISOString(), subject: 'bmodes-2d: one' },
        { iso: new Date(WIN.startMs).toISOString(), subject: 'bmodes-2d: two' },
      ],
      lanes,
      [card()],
      WIN,
      NOW_IN_RAIL,
    )
    expect(entries[0].stats).toEqual({ attention: 1, agent: 2, commits: 2 })
  })

  it('drops empty terms rather than printing zeros', () => {
    expect(formatEntryStats({ attention: 38, agent: 130, commits: 3 })).toBe(
      'you 38m · agents 2h 10m · 3 commits',
    )
    expect(formatEntryStats({ attention: 0, agent: 130, commits: 1 })).toBe(
      'agents 2h 10m · 1 commit',
    )
    expect(formatEntryStats({ attention: 5, agent: 0, commits: 0 })).toBe('you 5m')
    expect(formatEntryStats({ attention: 0, agent: 0, commits: 0 })).toBe('')
  })
})

describe('the live chip', () => {
  const worker = (over: Partial<KanbanCard>) =>
    card({ runningWorker: 'bmodes-2d-x-shuttle', ...over })

  it('is absent when no worker is in the air', () => {
    expect(laneChip(card(), NOW_IN_RAIL)).toBeUndefined()
    expect(laneChip(undefined, NOW_IN_RAIL)).toBeUndefined()
  })

  it('says aloft for a worker mid-tool', () => {
    const chip = laneChip(worker({ runtimePhase: 'working', lastActivityAt: NOW_IN_RAIL - 4_000 }), NOW_IN_RAIL)
    expect(chip).toMatchObject({ label: '▸ aloft', variant: 'aloft' })
    expect(chip?.tmux).toBe('bmodes-2d-x-shuttle')
  })

  it('lets attention take over at once — a raised hand is not a state to age', () => {
    const chip = laneChip(worker({ runtimePhase: 'attention', lastActivityAt: NOW_IN_RAIL - 5_000 }), NOW_IN_RAIL)
    expect(chip?.variant).toBe('attention')
    expect(chip?.label).toBe('☞︎ needs you now')
  })

  it('holds `waiting` back for a minute, then shows how long it has stood there', () => {
    // The daemon stamps `waiting` the instant a worker stops, so without the
    // gate every momentary pause would flip the chip. Same gate as the Desk.
    const fresh = laneChip(worker({ runtimePhase: 'waiting', lastActivityAt: NOW_IN_RAIL - 30_000 }), NOW_IN_RAIL)
    expect(fresh?.variant).toBe('aloft')
    const aged = laneChip(worker({ runtimePhase: 'waiting', lastActivityAt: NOW_IN_RAIL - 3 * 3_600_000 }), NOW_IN_RAIL)
    expect(aged?.variant).toBe('waiting')
    expect(aged?.label).toBe('⏸ waiting · 3h')
  })

  it('never appears on a past day — aloft is a fact about now', () => {
    const aloft = card({ runningWorker: 'x-shuttle', runtimePhase: 'working' })
    const lanes = buildDayLanes(activity([bucket(30, 'agent', SESSION)]), [aloft], WIN)
    const live = buildDayEntries([], lanes, [aloft], WIN, NOW_IN_RAIL)
    expect(live[0].chip).toBeDefined()
    // Same card, same lane, read from two days later: the worker is still in
    // the air, but it was not in the air on the day being drawn.
    const past = buildDayEntries([], lanes, [aloft], WIN, at(2026, 8, 6, 12, 0))
    expect(past[0].chip).toBeUndefined()
    // What the day COST is a fact about the day, and survives.
    expect(past[0].stats).toEqual({ attention: 0, agent: 1, commits: 0 })
  })

  it('carries the owning host, so the attach can be routed', () => {
    const chip = laneChip(worker({ runtimePhase: 'working', shuttleHost: 'cineca' }), NOW_IN_RAIL)
    expect(chip?.host).toBe('cineca')
  })
})

describe('a fiber that ended inside the rail', () => {
  it('is marked by its verdict, or by neither when there is none yet', () => {
    const closedAt = new Date(at(2026, 8, 4, 20, 0)).toISOString()
    expect(closureMark(card({ closedAt, tempered: true }), WIN)).toMatchObject({ glyph: '✓' })
    expect(closureMark(card({ closedAt, tempered: false }), WIN)).toMatchObject({ glyph: '✗' })
    expect(closureMark(card({ closedAt }), WIN)).toMatchObject({ glyph: '◦' })
  })

  it('is unmarked when the closure belongs to another day', () => {
    expect(closureMark(card({ closedAt: new Date(at(2026, 8, 3, 20, 0)).toISOString() }), WIN)).toBeUndefined()
    expect(closureMark(card({ closedAt: new Date(at(2026, 8, 5, 8, 0)).toISOString() }), WIN)).toBeUndefined()
    expect(closureMark(card(), WIN)).toBeUndefined()
  })

  it("takes the rail's own boundaries, so last night's 01:00 close is today's", () => {
    const smallHours = new Date(at(2026, 8, 5, 1, 0)).toISOString()
    expect(closureMark(card({ closedAt: smallHours, tempered: true }), WIN)).toMatchObject({
      glyph: '✓',
    })
  })
})

describe('where things stand', () => {
  const withDir = (over: Partial<KanbanCard> = {}) =>
    card({ fiberDir: '/home/ada/loom/.felt/bmodes-2d', ...over })

  it('offers one pane per FIBER lane, in lane order', () => {
    const other = '01KVBR8Z5TN9P3Q6R2S7V4WXGJ'
    const lanes = buildDayLanes(
      activity([
        bucket(10, 'agent', SESSION),
        bucket(11, 'agent', SESSION),
        bucket(20, 'agent', `second-${other}-shuttle`),
        bucket(30, 'agent', null, '/home/ada/notes'),
      ]),
      [withDir(), withDir({ id: 'a/second', uid: other, name: 'Second' })],
      WIN,
    )
    const previews = buildDayPreviews(lanes, [
      withDir(),
      withDir({ id: 'a/second', uid: other, name: 'Second' }),
    ])
    // The interactive lane has no fiber, so it has no page to show.
    expect(previews.map((p) => p.label)).toEqual(['Run the 2D B-mode null tests', 'Second'])
  })

  it('points at report.html inside the fiber dir the feed carries', () => {
    const lanes = buildDayLanes(activity([bucket(10, 'agent', SESSION)]), [withDir()], WIN)
    const [preview] = buildDayPreviews(lanes, [withDir()])
    expect(preview.reportUrl).toBe(
      '/api/v1/file?path=%2Fhome%2Fada%2Floom%2F.felt%2Fbmodes-2d%2Freport.html',
    )
  })

  it('owner-routes a remote fiber, and leaves a local one unrouted', () => {
    const lanes = buildDayLanes(activity([bucket(10, 'agent', SESSION)]), [withDir()], WIN)
    const remote = withDir({ originId: 'remote-cineca' })
    expect(buildDayPreviews(lanes, [remote])[0].reportUrl).toContain('&origin=remote-cineca')
    expect(buildDayPreviews(lanes, [withDir()])[0].reportUrl).not.toContain('&origin=')
  })

  it('asks for nothing when the feed carries no directory', () => {
    // Guessing a path here would be a 404 per pane per render.
    const lanes = buildDayLanes(activity([bucket(10, 'agent', SESSION)]), [card()], WIN)
    const [preview] = buildDayPreviews(lanes, [card({ outcome: 'Ran the nulls.' })])
    expect(preview.reportUrl).toBeUndefined()
    expect(preview.outcome).toBe('Ran the nulls.')
  })

  it('carries the outcome even when a report exists — it is the fallback', () => {
    const lanes = buildDayLanes(activity([bucket(10, 'agent', SESSION)]), [withDir()], WIN)
    const [preview] = buildDayPreviews(lanes, [withDir({ outcome: 'Compute the PTE.' })])
    expect(preview.reportUrl).toBeDefined()
    expect(preview.outcome).toBe('Compute the PTE.')
  })
})

describe('still ahead', () => {
  const NOON = at(2026, 8, 4, 12, 0)
  const launchCard = (hour: number, over: Partial<KanbanCard> = {}) =>
    card({
      id: `role/${hour}`,
      uid: undefined,
      name: `Role at ${hour}`,
      nextLaunchAt: new Date(at(2026, 8, 4, hour, 0)).toISOString(),
      ...over,
    })

  it('is empty on a day that is over — a finished day owes nothing', () => {
    // Same cards, a clock outside the rail: the strip disappears entirely.
    expect(buildStillAhead([launchCard(18)], DAY, WIN, at(2026, 8, 6, 12, 0))).toEqual([])
    expect(buildStillAhead([launchCard(18)], DAY, WIN, at(2026, 8, 4, 5, 0))).toEqual([])
  })

  it('keeps the firings still to come and drops the ones already past', () => {
    const items = buildStillAhead([launchCard(9), launchCard(18), launchCard(22)], DAY, WIN, NOON)
    expect(items.map((i) => i.label)).toEqual(['Role at 18', 'Role at 22'])
    expect(items[0]).toMatchObject({ glyph: '◐', when: '6:00pm' })
  })

  it("reaches past midnight to the rail's end, not to midnight", () => {
    // 01:00 tomorrow is still THIS rail — a role firing then is tonight's work.
    const pastMidnight = card({
      id: 'role/late',
      uid: undefined,
      name: 'Late role',
      nextLaunchAt: new Date(at(2026, 8, 5, 1, 0)).toISOString(),
    })
    const tooLate = card({
      id: 'role/tomorrow',
      uid: undefined,
      name: 'Tomorrow role',
      nextLaunchAt: new Date(at(2026, 8, 5, 9, 0)).toISOString(),
    })
    const items = buildStillAhead([pastMidnight, tooLate], DAY, WIN, NOON)
    expect(items.map((i) => i.label)).toEqual(['Late role'])
  })

  it('lists what is owed on this civil day, with no hour to give', () => {
    const due = card({ id: 'work/due', uid: undefined, name: 'Owed today', due: DAY })
    const other = card({ id: 'work/other', uid: undefined, name: 'Owed tomorrow', due: '2026-08-05' })
    const items = buildStillAhead([due, other], DAY, WIN, NOON)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ glyph: '◴', label: 'Owed today' })
    expect(items[0].when).toBeUndefined()
  })

  it("prefers a concrete firing hour over the same card's vaguer due", () => {
    const both = launchCard(18, { due: DAY })
    const items = buildStillAhead([both], DAY, WIN, NOON)
    expect(items).toHaveLength(1)
    expect(items[0].glyph).toBe('◐')
  })

  it('leaves out what is already finished', () => {
    const done = launchCard(18, { closedAt: new Date(at(2026, 8, 4, 11, 0)).toISOString() })
    expect(buildStillAhead([done], DAY, WIN, NOON)).toEqual([])
  })

  it('puts the firings first, in time order, then the dues by name', () => {
    const items = buildStillAhead(
      [
        card({ id: 'z/due', uid: undefined, name: 'Zebra owed', due: DAY }),
        launchCard(22),
        card({ id: 'a/due', uid: undefined, name: 'Alder owed', due: DAY }),
        launchCard(18),
      ],
      DAY,
      WIN,
      NOON,
    )
    expect(items.map((i) => i.label)).toEqual([
      'Role at 18',
      'Role at 22',
      'Alder owed',
      'Zebra owed',
    ])
  })

  it("tells the clock in the rail's own register", () => {
    expect(formatClockTime(at(2026, 8, 4, 6, 0))).toBe('6:00am')
    expect(formatClockTime(at(2026, 8, 4, 12, 0))).toBe('12:00pm')
    expect(formatClockTime(at(2026, 8, 4, 22, 5))).toBe('10:05pm')
    expect(formatClockTime(at(2026, 8, 5, 0, 30))).toBe('12:30am')
  })
})

describe('the day, by fiber', () => {
  const commit = (subject: string): NarrationCommit => ({
    iso: new Date(WIN.startMs).toISOString(),
    subject,
  })

  it('groups commits by their leading slug, keeping first-appearance order', () => {
    const groups = groupCommitsBySlug([
      commit('board: fold the masthead actions into the column heads'),
      commit('views: hang the temporal pages off a hotkey row'),
      commit('board: drag onto a day column writes due:'),
    ])
    expect(groups).toEqual([
      {
        slug: 'board',
        subjects: [
          'fold the masthead actions into the column heads',
          'drag onto a day column writes due:',
        ],
      },
      { slug: 'views', subjects: ['hang the temporal pages off a hotkey row'] },
    ])
  })

  it('collects unprefixed commits into one trailing null-slug group', () => {
    const groups = groupCommitsBySlug([
      commit('board: a prefixed one'),
      commit('Merge branch main'),
      commit('fix the thing'),
    ])
    expect(groups.map((g) => g.slug)).toEqual(['board', null])
    expect(groups[1].subjects).toEqual(['Merge branch main', 'fix the thing'])
  })

  it('reads a slash-bearing slug, and refuses a colon with no space after it', () => {
    expect(groupCommitsBySlug([commit('shuttle/day: two clocks')])[0]).toEqual({
      slug: 'shuttle/day',
      subjects: ['two clocks'],
    })
    expect(groupCommitsBySlug([commit('ratio 3:1 held')])[0].slug).toBeNull()
  })

  it('gives a fiber that worked but committed nothing its outcome, as a fallback', () => {
    const lanes = buildDayLanes(activity([bucket(30, 'agent', SESSION)]), [card()], WIN)
    const entries = buildDayEntries(
      [commit('views: a different fiber entirely')],
      lanes,
      [card({ outcome: 'Compute the PTE across the patch set. Then check Hartlap.' })],
      WIN,
      NOW_IN_RAIL,
    )
    // Lane first (it has a rail on this page), then the commit that named no
    // lane — and the lane's entry is titled exactly as its lane label reads.
    expect(entries.map((e) => e.title)).toEqual(['Run the 2D B-mode null tests', 'views'])
    expect(entries[0].fallback).toBe(true)
    expect(entries[0].body).toBe('Compute the PTE across the patch set.')
    expect(entries[0].cardId).toBe('work/spt3g_papers/bmodes-2d')
    expect(entries[1].noLane).toBe(true)
  })

  it('gives no fallback to a fiber whose slug the commits already name', () => {
    const lanes = buildDayLanes(activity([bucket(30, 'agent', SESSION)]), [card()], WIN)
    const entries = buildDayEntries(
      [commit('bmodes-2d: ran the nulls')],
      lanes,
      [card()],
      WIN,
      NOW_IN_RAIL,
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].fallback).toBeUndefined()
    // The commit slug resolves to the same card the lane label opens.
    expect(entries[0].cardId).toBe('work/spt3g_papers/bmodes-2d')
  })

  it('puts the unprefixed commits last, muted, under their own head', () => {
    const lanes = buildDayLanes(activity([bucket(30, 'agent', SESSION)]), [card()], WIN)
    const entries = buildDayEntries(
      [commit('bmodes-2d: ran the nulls'), commit('typo')],
      lanes,
      [card()],
      WIN,
      NOW_IN_RAIL,
    )
    expect(entries[entries.length - 1]).toMatchObject({
      title: '— elsewhere in the store —',
      body: 'typo',
      loose: true,
    })
  })

  it('reads in LANE ORDER, so a rail and its sentence line up', () => {
    // Three lanes of descending weight, and commits arriving in an order that
    // has nothing to do with it. The ledger must follow the lanes, not the
    // commit log — otherwise the two halves of the page are a lookup.
    const second = '01KVBR6X3RK7J9N4P8Q5S2TVEG'
    const third = '01KVBR7Y4SM8N2P5Q9R6T3VWFH'
    const lanes = buildDayLanes(
      activity([
        bucket(10, 'agent', SESSION),
        bucket(11, 'agent', SESSION),
        bucket(12, 'agent', SESSION),
        bucket(20, 'agent', `second-${second}-shuttle`),
        bucket(21, 'agent', `second-${second}-shuttle`),
        bucket(30, 'agent', `third-${third}-shuttle`),
      ]),
      [
        card(),
        card({ id: 'a/second', uid: second, name: 'Second heaviest' }),
        card({ id: 'a/third', uid: third, name: 'Lightest' }),
      ],
      WIN,
    )
    expect(lanes.map((l) => l.label)).toEqual([
      'Run the 2D B-mode null tests',
      'Second heaviest',
      'Lightest',
    ])

    const entries = buildDayEntries(
      [commit('third: went last'), commit('bmodes-2d: went first')],
      lanes,
      [card(), card({ id: 'a/second', uid: second, name: 'Second heaviest' }), card({ id: 'a/third', uid: third, name: 'Lightest' })],
      WIN,
      NOW_IN_RAIL,
    )
    expect(entries.map((e) => e.title)).toEqual([
      'Run the 2D B-mode null tests',
      'Second heaviest',
      'Lightest',
    ])
    // …and the middle one, which committed nothing, still holds its place.
    expect(entries[1].fallback).toBe(true)
  })

  it('puts commits with no lane on this page after every lane', () => {
    const lanes = buildDayLanes(activity([bucket(30, 'agent', SESSION)]), [card()], WIN)
    const entries = buildDayEntries(
      [commit('elsewhere-fiber: ran on another machine'), commit('bmodes-2d: ran the nulls')],
      lanes,
      [card()],
      WIN,
      NOW_IN_RAIL,
    )
    expect(entries.map((e) => e.title)).toEqual([
      'Run the 2D B-mode null tests',
      'elsewhere-fiber',
    ])
    // A bare slug as a title MEANS "no rail above for this one".
    expect(entries[1].noLane).toBe(true)
    expect(entries[0].noLane).toBeUndefined()
  })

  it('takes the first sentence, or the whole line when there is no full stop', () => {
    expect(firstSentence('One. Two. Three.')).toBe('One.')
    expect(firstSentence('No full stop here')).toBe('No full stop here')
    expect(firstSentence('Ends in a question? Then more.')).toBe('Ends in a question?')
    expect(firstSentence(undefined)).toBe('')
  })
})
