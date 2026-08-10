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
import type {
  ActivityBucket,
  ActivityResult,
  NarrationCommit,
  TemporalOrigins,
} from './TemporalData.js'
import { tmuxJoinKey } from './TemporalData.js'
import {
  buildDayEntries,
  buildDayLanes,
  buildDayModel,
  buildDayPreviews,
  buildStillAhead,
  closureMark,
  commitsOnRail,
  dayTotals,
  dayWindow,
  defaultDayISO,
  drawnWindow,
  firstSentence,
  FRAME_MIN_MINUTES,
  formatClockTime,
  formatEntryStats,
  groupCommitsBySlug,
  isLivePresent,
  laneChip,
  mergeMinuteRuns,
  narrationRange,
  railTicks,
  resolveDayISO,
  stepTarget,
  tickStepMinutes,
  type DayLane,
} from './DayView.js'
import { sessionSlug, sessionUlid } from './sessionNames.js'
import { formatSpanMinutes, shiftCivilDay } from './railTime.js'

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
  host: string | null = null,
): ActivityBucket => ({ m: WIN.startMs + minute * 60_000, s, cwd, k, n: 1, host })

const activity = (
  buckets: ActivityBucket[],
  host = 'ada-workstation',
  origins?: TemporalOrigins,
): ActivityResult => ({
  host,
  from_ms: WIN.startMs,
  to_ms: WIN.endMs,
  buckets,
  origins,
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

describe('the drawn frame — how much of the day gets sheet', () => {
  const bucketsAt = (...minutes: number[]): ActivityBucket[] =>
    minutes.map((minute) => bucket(minute, 'agent', SESSION))

  it('runs from the first action to the last on a finished day', () => {
    // 10:00 and 14:00. The frame pads a quarter-hour outside each, and the last
    // action's own minute is a full minute wide.
    const frame = drawnWindow(WIN, bucketsAt(240, 480), at(2026, 8, 9, 12))
    expect(frame.startMs).toBe(at(2026, 8, 4, 9, 45))
    expect(frame.endMs).toBe(at(2026, 8, 4, 14, 16))
  })

  it('runs to NOW on the rail that contains this moment, however long since', () => {
    // Last action at 11:00, now 15:00: the four idle hours are the day's news,
    // not something to crop out.
    const frame = drawnWindow(WIN, bucketsAt(240, 300), NOW_IN_RAIL)
    expect(frame.startMs).toBe(at(2026, 8, 4, 9, 45))
    expect(frame.endMs).toBe(at(2026, 8, 4, 15, 15))
  })

  it('never zooms below the minimum span, and keeps the action inside it', () => {
    const frame = drawnWindow(WIN, bucketsAt(300), at(2026, 8, 9, 12))
    expect(frame.minutes).toBeGreaterThanOrEqual(FRAME_MIN_MINUTES)
    const action = WIN.startMs + 300 * 60_000
    expect(frame.startMs).toBeLessThan(action)
    expect(frame.endMs).toBeGreaterThan(action)
  })

  it('pushes the minimum span inward rather than off the rail', () => {
    // A single burst at first light: the frame cannot open before 06:00, so the
    // whole two hours are spent to the right of it.
    const frame = drawnWindow(WIN, bucketsAt(0), at(2026, 8, 9, 12))
    expect(frame.startMs).toBe(WIN.startMs)
    expect(frame.minutes).toBeGreaterThanOrEqual(FRAME_MIN_MINUTES)
    expect(frame.endMs).toBeLessThanOrEqual(WIN.endMs)
  })

  it('is always a sub-span of the civil day — the zoom cannot borrow a minute', () => {
    const frame = drawnWindow(WIN, bucketsAt(0, WIN.minutes - 1), NOW_IN_RAIL)
    expect(frame.startMs).toBe(WIN.startMs)
    expect(frame.endMs).toBe(WIN.endMs)
  })

  it('keeps the whole rail when nothing happened — there is nothing to frame', () => {
    expect(drawnWindow(WIN, [], NOW_IN_RAIL)).toEqual(WIN)
    // Buckets belonging to another page do not count as something to frame to.
    const stray: ActivityBucket = { m: WIN.endMs, s: null, cwd: null, k: 'agent', n: 1 }
    expect(drawnWindow(WIN, [stray], NOW_IN_RAIL)).toEqual(WIN)
  })

  it('positions the lanes in the frame, not in the rail', () => {
    // Work at 10:00 on a frame opening at 09:45 is minute 15 of the drawing,
    // not minute 240 of the day.
    const frame = drawnWindow(WIN, bucketsAt(240, 480), at(2026, 8, 9, 12))
    const lanes = buildDayLanes(activity(bucketsAt(240, 480)), [card()], frame)
    expect(lanes[0].agent[0]).toEqual({ start: 15, end: 16 })
  })
})

describe('the hour hand over a frame that zooms', () => {
  it('steps down its density as the frame widens', () => {
    expect(tickStepMinutes(24 * 60)).toBe(240)
    expect(tickStepMinutes(12 * 60)).toBe(120)
    expect(tickStepMinutes(5 * 60)).toBe(60)
    expect(tickStepMinutes(FRAME_MIN_MINUTES)).toBe(30)
  })

  it('rules the whole day four-hourly, as it always has', () => {
    expect(railTicks(WIN).map((t) => t.label)).toEqual([
      '8am',
      '12pm',
      '4pm',
      '8pm',
      '12am',
      '4am',
    ])
  })

  it('anchors to local midnight, so a tick names a round clock time', () => {
    // A frame opening at 09:47 still rules on the clock's own hours, not on
    // 09:47 + n hours — two frames of one day mark the same instants.
    const frame: typeof WIN = {
      startMs: at(2026, 8, 4, 9, 47),
      endMs: at(2026, 8, 4, 16, 3),
      minutes: 376,
    }
    const ticks = railTicks(frame)
    expect(ticks.map((t) => t.label)).toEqual([
      '10am',
      '11am',
      '12pm',
      '1pm',
      '2pm',
      '3pm',
      '4pm',
    ])
    for (const tick of ticks) {
      const d = new Date(tick.ms)
      expect([d.getMinutes(), d.getSeconds()]).toEqual([0, 0])
      expect(tick.ms).toBeGreaterThanOrEqual(frame.startMs)
      expect(tick.ms).toBeLessThan(frame.endMs)
    }
  })

  it('names the half hour once the frame is tight enough to need it', () => {
    const frame: typeof WIN = {
      startMs: at(2026, 8, 4, 9, 45),
      endMs: at(2026, 8, 4, 11, 45),
      minutes: 120,
    }
    expect(railTicks(frame).map((t) => t.label)).toEqual([
      '10:00am',
      '10:30am',
      '11:00am',
      '11:30am',
    ])
  })

  it('holds the label count down whatever the frame', () => {
    for (const minutes of [120, 137, 200, 300, 480, 700, 900, 1440, 1500]) {
      const frame = { startMs: WIN.startMs, endMs: WIN.startMs + minutes * 60_000, minutes }
      expect(railTicks(frame).length, `${minutes}m`).toBeLessThanOrEqual(7)
    }
  })
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
    // One attention MINUTE, but two attention buckets in it — and messages are
    // acts, not time, so both count.
    expect(totals).toEqual({ attention: 1, agent: 3, messages: 2, received: 0 })
  })

  it('sums the events in an attention bucket, not the minutes holding them', () => {
    const busy: ActivityBucket = { ...bucket(30, 'attention', SESSION), n: 4 }
    const totals = dayTotals(activity([busy, bucket(31, 'attention', SESSION)]), WIN)
    expect(totals.attention).toBe(2)
    expect(totals.messages).toBe(5)
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
      messages: 0,
      received: 0,
    })
  })

  it('counts the replies back, so the header can say both halves', () => {
    // The live feed carries `k:"reply"` in volume (167 buckets / 358 events in
    // a two-day window on this daemon), and the day head used to hardcode the
    // received half to zero.
    const totals = dayTotals(
      activity([
        bucket(0, 'attention', SESSION),
        { ...bucket(1, 'reply' as ActivityBucket['k'], SESSION), n: 3 },
        bucket(2, 'agent', SESSION),
      ]),
      WIN,
    )
    expect(totals.messages).toBe(1)
    expect(totals.received).toBe(3)
    // A reply's minute is agent time, and is not attention.
    expect(totals.agent).toBe(2)
    expect(totals.attention).toBe(1)
  })

  it('counts a notify minute as neither attention nor agent', () => {
    expect(dayTotals(activity([bucket(30, 'notify')]), WIN)).toEqual({
      attention: 0,
      agent: 0,
      messages: 0,
      received: 0,
    })
  })

  it('formats a span the head line can wear', () => {
    expect(formatSpanMinutes(0, { pad: true })).toBe('0m')
    expect(formatSpanMinutes(47, { pad: true })).toBe('47m')
    expect(formatSpanMinutes(60, { pad: true })).toBe('1h 00m')
    expect(formatSpanMinutes(125, { pad: true })).toBe('2h 05m')
    // Unpadded and with no empty case — the other two spellings the one
    // formatter has to cover.
    expect(formatSpanMinutes(125)).toBe('2h 5m')
    expect(formatSpanMinutes(0)).toBe('0m')
  })
})

describe('lanes', () => {
  it('joins a bucket to a fiber through the ULID in its tmux session name', () => {
    expect(sessionUlid(SESSION)).toBe(FIBER_ULID)
    expect(sessionUlid('morning-post-shuttle')).toBeNull()
    expect(sessionUlid(null)).toBeNull()

    const lanes = buildDayLanes(
      activity([bucket(60, 'agent', SESSION), bucket(61, 'attention', SESSION)]),
      [card({ shuttleHost: 'Ada-Workstation' })],
      WIN,
    )
    expect(lanes).toHaveLength(1)
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

  it('skips work that joined to no fiber — no lane, no ledger entry', () => {
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
    expect(lanes).toHaveLength(1)
    expect(lanes[0].cardId).toBe('work/spt3g_papers/bmodes-2d')
  })

  it('yields no lanes at all when nothing joined a fiber', () => {
    const lanes = buildDayLanes(activity([bucket(4, 'agent')]), [], WIN)
    expect(lanes).toEqual([])
  })

  it('carries each lane its own reply count, for the per-fiber ledger row', () => {
    const lanes = buildDayLanes(
      activity([
        bucket(10, 'attention', SESSION),
        { ...bucket(11, 'reply' as ActivityBucket['k'], SESSION), n: 2 },
        bucket(11, 'agent', SESSION),
      ]),
      [card()],
      WIN,
    )
    expect(lanes[0].attentionMessages).toBe(1)
    expect(lanes[0].replyMessages).toBe(2)
  })

  it('gives a notify no lane, no weight and no beat — it is not a drawn state', () => {
    // Notify still arrives on the wire and is dropped at ingest, so a fiber
    // whose whole day was nudges draws nothing rather than an empty rail.
    expect(buildDayLanes(activity([bucket(9, 'notify', SESSION)]), [card()], WIN)).toEqual([])
    const mixed = buildDayLanes(
      activity([bucket(9, 'notify', SESSION), bucket(10, 'agent', SESSION)]),
      [card()],
      WIN,
    )
    expect(mixed[0].weight).toBe(1)
    expect(mixed[0].beats.map((b) => b.minute)).toEqual([10])
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
  // miss has the same consequence: the bucket draws no lane at all.

  it('joins a session name whose ULID is lower-cased', () => {
    expect(sessionUlid(`bmodes-2d-${FIBER_ULID.toLowerCase()}-shuttle`)).toBe(FIBER_ULID)
    const lanes = buildDayLanes(
      activity([bucket(20, 'agent', `bmodes-2d-${FIBER_ULID.toLowerCase()}-shuttle`)]),
      [card()],
      WIN,
    )
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
    expect(lanes[0].label).toBe('Morning post')
  })

  it('joins an exact live-worker tmux name even with no ULID in it', () => {
    const lanes = buildDayLanes(
      activity([bucket(20, 'agent', 'legacy-worker-name')]),
      [card({ uid: undefined, runningWorker: 'legacy-worker-name' })],
      WIN,
    )
    expect(lanes).toHaveLength(1)
  })

  it('never joins on the working directory — a directory names a project', () => {
    // The cwd tail `spt3g_papers` uniquely names this card's path. It still
    // does not join, for a WORKER whose session resolved to nothing…
    const worker = buildDayLanes(
      activity([bucket(20, 'agent', 'scratch-shuttle', '/home/ada/work/spt3g_papers')]),
      [card()],
      WIN,
    )
    expect(worker).toEqual([])

    // …nor for a person typing in the same directory. A repo root routinely
    // shares its name with one fiber nested inside it, and that coincidence is
    // not evidence about what the work was.
    const human = buildDayLanes(
      activity([bucket(20, 'agent', null, '/home/ada/work/spt3g_papers')]),
      [card()],
      WIN,
    )
    expect(human).toEqual([])
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
    expect(lanes).toEqual([])
  })

  it('draws no lane for work in the same directory whether worker or human', () => {
    const lanes = buildDayLanes(
      activity([
        bucket(20, 'agent', 'stranger-01ZZZ-shuttle', '/home/ada/loom'),
        bucket(21, 'attention', null, '/home/ada/loom'),
      ]),
      [],
      WIN,
    )
    expect(lanes).toEqual([])
  })
})

describe('rung 0 — the session ledger', () => {
  // The ledger is a RECORD, not an inference: the daemon wrote down which
  // fiber it dispatched a session for. It goes ahead of every name-derived
  // rung because it can read a session name that carries no ULID and no
  // recognizable slug, which is the case that justifies its existence.
  const pairing = (fiber: string, uid: string | null = null) => ({
    fiber,
    uid,
    session: `sess-${fiber}`,
    host: null,
  })

  it('joins a session name that carries nothing to infer from', () => {
    // `pi-2f9c41`: no ULID, no slug matching any card. Every lower rung misses.
    expect(sessionUlid('pi-2f9c41')).toBeNull()
    const naked = buildDayLanes(activity([bucket(20, 'agent', 'pi-2f9c41')]), [card()], WIN)
    expect(naked).toEqual([])

    const withLedger = buildDayLanes(
      activity([bucket(20, 'agent', 'pi-2f9c41')]),
      [card()],
      WIN,
      new Map([['pi-2f9c41', pairing('work/spt3g_papers/bmodes-2d')]]),
    )
    expect(withLedger[0].cardId).toBe('work/spt3g_papers/bmodes-2d')
  })

  it('resolves through the pairing’s ULID when its fiber path has moved', () => {
    const ledger = new Map([['pi-2f9c41', pairing('some/old/path', FIBER_ULID.toLowerCase())]])
    const lanes = buildDayLanes(activity([bucket(20, 'agent', 'pi-2f9c41')]), [card()], WIN, ledger)
    expect(lanes[0].cardId).toBe('work/spt3g_papers/bmodes-2d')
  })

  it('falls THROUGH a pairing for a fiber this board does not carry', () => {
    // Resolving to an absent card draws no lane — the minutes are simply not
    // on the page, the same as any other unjoined bucket.
    const ledger = new Map([['pi-2f9c41', pairing('not/on/this/board', null)]])
    const lanes = buildDayLanes(
      activity([bucket(20, 'agent', 'pi-2f9c41', '/home/ada/work/photoz')]),
      [card()],
      WIN,
      ledger,
    )
    expect(lanes).toEqual([])
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

  it('gives each minute its own beat, with the transcript behind it', () => {
    // The hover reads BEATS, not the drawn runs: a run bridges idle minutes so
    // it reads as one stroke, and a bridged minute must never be reported as
    // work with words in it.
    const ledger = new Map([['pi-2f9c41', pairing('work/spt3g_papers/bmodes-2d')]])
    const lanes = buildDayLanes(
      activity([
        bucket(20, 'agent', 'pi-2f9c41'),
        bucket(20, 'attention', 'pi-2f9c41'),
        // Three idle minutes: the wash bridges them, the beats do not.
        bucket(24, 'agent', 'pi-2f9c41'),
      ]),
      [card()],
      WIN,
      ledger,
    )
    expect(lanes[0].agent).toEqual([{ start: 20, end: 25 }])
    expect(lanes[0].beats.map((b) => b.minute)).toEqual([20, 24])
    expect(lanes[0].beats[0].kinds.map((k) => k.kind).sort()).toEqual(['agent', 'attention'])
    expect(lanes[0].beats[0].sources).toEqual([
      { session: 'sess-work/spt3g_papers/bmodes-2d', host: null },
    ])
  })

  it('leaves a beat with no transcript when nothing paired its minute', () => {
    const lanes = buildDayLanes(activity([bucket(20, 'agent', SESSION)]), [card()], WIN)
    expect(lanes[0].beats).toEqual([
      { minute: 20, kinds: [{ kind: 'agent', count: 1 }], sources: [] },
    ])
  })

  it('is ignored for a bucket with no session at all', () => {
    const ledger = new Map([['pi-2f9c41', pairing('work/spt3g_papers/bmodes-2d')]])
    const lanes = buildDayLanes(
      activity([bucket(20, 'agent', null, '/home/ada/notes')]),
      [card()],
      WIN,
      ledger,
    )
    expect(lanes).toEqual([])
  })
})

describe('a fleet of daemons on one rail', () => {
  // The activity feed is a composite now: every bucket is stamped with the
  // daemon whose events file produced it, and the ledger is several hosts'
  // merged. So a lane's host is a fact about the minutes drawn, and a tmux
  // name means nothing without the host it ran on.
  const pairing = (fiber: string, uid: string | null = null) => ({
    fiber,
    uid,
    session: `sess-${fiber}`,
    host: null,
  })

  it('takes the lane host from the BUCKETS, not from the card', () => {
    // The card says the fiber lives here; the minutes say they were produced
    // on cineca. The minutes win — they are what the rail draws.
    const lanes = buildDayLanes(
      activity([
        bucket(60, 'agent', SESSION, null, 'Cineca-Login-02'),
        bucket(61, 'agent', SESSION, null, 'cineca-login-02'),
      ]),
      [card({ shuttleHost: 'ada-workstation' })],
      WIN,
    )
    expect(lanes[0].host).toBe('cineca-login-02')
    expect(lanes[0].hostNote).toBe('cineca-login-02')
  })

  it('says nothing for a lane whose activity came from the page host', () => {
    const lanes = buildDayLanes(
      activity([bucket(60, 'agent', SESSION, null, 'ada-workstation')]),
      [card({ shuttleHost: 'cineca-login-02' })],
      WIN,
    )
    expect(lanes[0].host).toBe('ada-workstation')
    expect(lanes[0].hostNote).toBe('')
  })

  it('falls back to the card when no bucket says where it ran', () => {
    // An old daemon stamps nothing. The board's own claim about the fiber is
    // better than silence, and it is what this page printed before.
    const lanes = buildDayLanes(
      activity([bucket(60, 'agent', SESSION)]),
      [card({ shuttleHost: 'Cineca-Login-02' })],
      WIN,
    )
    expect(lanes[0].hostNote).toBe('cineca-login-02')
  })

  it('keeps a mixed lane honest: the majority host, then the most recent', () => {
    const majority = buildDayLanes(
      activity([
        bucket(60, 'agent', SESSION, null, 'cineca-login-02'),
        bucket(61, 'agent', SESSION, null, 'cineca-login-02'),
        bucket(300, 'agent', SESSION, null, 'candide'),
      ]),
      [card()],
      WIN,
    )
    expect(majority[0].host).toBe('cineca-login-02')

    // Evenly split — the later one describes where the fiber is now.
    const tied = buildDayLanes(
      activity([
        bucket(60, 'agent', SESSION, null, 'cineca-login-02'),
        bucket(300, 'agent', SESSION, null, 'candide'),
      ]),
      [card()],
      WIN,
    )
    expect(tied[0].host).toBe('candide')
  })

  it('joins a tmux name on the host that owns it, so two fleets cannot swap', () => {
    // Both daemons run a session called `run-shuttle`, for different fibers.
    const other = '01KVBR9A6VP2Q4R7S3T8W5XYHK'
    const ledger = new Map([
      [tmuxJoinKey('ada-workstation', 'run-shuttle'), pairing('work/spt3g_papers/bmodes-2d')],
      [tmuxJoinKey('cineca-login-02', 'run-shuttle'), pairing('a/second')],
      // The bare key too, as buildSessionIndex writes it — a bucket that knows
      // its host must never reach this.
      ['run-shuttle', pairing('a/second')],
    ])
    const lanes = buildDayLanes(
      activity([bucket(60, 'agent', 'run-shuttle', null, 'ada-workstation')]),
      [card(), card({ id: 'a/second', uid: other, name: 'Second' })],
      WIN,
      ledger,
    )
    expect(lanes).toHaveLength(1)
    expect(lanes[0].cardId).toBe('work/spt3g_papers/bmodes-2d')
  })

  it('marks a lane whose origin is stale, and leaves a live one alone', () => {
    const origins: TemporalOrigins = {
      'ada-workstation': { kind: 'local', stale: false },
      'cineca-login-02': { kind: 'remote', stale: true, lastError: 'timeout' },
    }
    const other = '01KVBR9A6VP2Q4R7S3T8W5XYHK'
    const lanes = buildDayLanes(
      activity(
        [
          bucket(60, 'agent', SESSION, null, 'cineca-login-02'),
          bucket(61, 'agent', `second-${other}-shuttle`, null, 'ada-workstation'),
        ],
        'ada-workstation',
        origins,
      ),
      [card(), card({ id: 'a/second', uid: other, name: 'Second' })],
      WIN,
    )
    const remote = lanes.find((l) => l.cardId === 'work/spt3g_papers/bmodes-2d')
    const local = lanes.find((l) => l.cardId === 'a/second')
    // The stale lane still DRAWS — those minutes happened; what is shown is
    // that origin's last-good read, dimmed, not dropped.
    expect(remote).toMatchObject({ host: 'cineca-login-02', hostNote: 'cineca-login-02', stale: true })
    expect(remote?.agent).toEqual([{ start: 60, end: 61 }])
    expect(local).toMatchObject({ host: 'ada-workstation', hostNote: '', stale: false })
  })

  it('reads staleness past a difference of case in the origin name', () => {
    const lanes = buildDayLanes(
      activity([bucket(60, 'agent', SESSION, null, 'Cineca-Login-02')], 'ada-workstation', {
        'Cineca-Login-02': { kind: 'remote', stale: true },
      }),
      [card()],
      WIN,
    )
    expect(lanes[0].stale).toBe(true)
  })

  it('does not mark a lane for an origin covering less of the day than asked', () => {
    // A narrow `window` is an origin answering honestly about what it cached.
    // The data thins out; nothing is wrong, and nothing is dimmed.
    const lanes = buildDayLanes(
      activity([bucket(60, 'agent', SESSION, null, 'cineca-login-02')], 'ada-workstation', {
        'cineca-login-02': {
          kind: 'remote',
          stale: false,
          window: { fromMs: WIN.startMs + 3_600_000, toMs: WIN.startMs + 7_200_000 },
        },
      }),
      [card()],
      WIN,
    )
    expect(lanes[0].stale).toBe(false)
  })

  it('leaves an unmentioned host fresh rather than guessing', () => {
    const lanes = buildDayLanes(
      activity([bucket(60, 'agent', SESSION, null, 'unlisted-box')], 'ada-workstation', {
        'ada-workstation': { kind: 'local', stale: false },
      }),
      [card()],
      WIN,
    )
    expect(lanes[0].stale).toBe(false)
  })

  it('merges the ledger’s freshness with activity’s into the day model', () => {
    // Activity from cineca is current; the ledger has not heard from it. The
    // lane is built from both files, so the lane is waiting.
    const model = buildDayModel(
      DAY,
      activity([bucket(60, 'agent', SESSION, null, 'cineca-login-02')], 'ada-workstation', {
        'cineca-login-02': { kind: 'remote', stale: false },
      }),
      [],
      [card()],
      '',
      NOW_IN_RAIL,
      undefined,
      { 'cineca-login-02': { kind: 'remote', stale: true } },
    )
    expect(model.lanes[0].stale).toBe(true)
    expect(model.origins['cineca-login-02'].stale).toBe(true)
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
      '',
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
      '',
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
    expect(entries[0].stats).toEqual({ messages: 1, received: 0, agent: 2, commits: 2 })
  })

  it('counts your side of a lane in messages, the agents’ in minutes', () => {
    // Three prompts inside one minute is three messages and one minute — the
    // two measures deliberately disagree, and the ledger reports the acts.
    const lanes = buildDayLanes(
      activity([
        { ...bucket(10, 'attention', SESSION), n: 3 },
        bucket(11, 'attention', SESSION),
        bucket(12, 'agent', SESSION),
      ]),
      [card()],
      WIN,
    )
    expect(lanes[0].attentionMinutes).toBe(2)
    expect(lanes[0].attentionMessages).toBe(4)
  })

  it('drops empty terms rather than printing zeros', () => {
    expect(formatEntryStats({ messages: 14, agent: 130, commits: 3 })).toBe(
      'you 14 · agents 2h 10m · 3 commits',
    )
    expect(formatEntryStats({ messages: 0, agent: 130, commits: 1 })).toBe(
      'agents 2h 10m · 1 commit',
    )
    expect(formatEntryStats({ messages: 1, agent: 0, commits: 0 })).toBe('you 1')
    expect(formatEntryStats({ messages: 0, agent: 0, commits: 0 })).toBe('')
  })

  it('reaches for the "back" clause only when something came back', () => {
    expect(formatEntryStats({ messages: 14, received: 9, agent: 0, commits: 0 })).toBe(
      'you 14 · 9 back',
    )
    expect(formatEntryStats({ messages: 14, received: 0, agent: 0, commits: 0 })).toBe(
      'you 14',
    )
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
    expect(past[0].stats).toEqual({ messages: 0, received: 0, agent: 1, commits: 0 })
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
    ], '')
    // The bucket that joined no fiber drew no lane, so it has no page either.
    expect(previews.map((p) => p.label)).toEqual(['Run the 2D B-mode null tests', 'Second'])
  })

  it('points at report.html inside the fiber dir the feed carries', () => {
    const lanes = buildDayLanes(activity([bucket(10, 'agent', SESSION)]), [withDir()], WIN)
    const [preview] = buildDayPreviews(lanes, [withDir()], '')
    expect(preview.reportUrl).toBe(
      '/api/v1/file?path=%2Fhome%2Fada%2Floom%2F.felt%2Fbmodes-2d%2Freport.html',
    )
  })

  it('owner-routes a remote fiber, and leaves a local one unrouted', () => {
    const lanes = buildDayLanes(activity([bucket(10, 'agent', SESSION)]), [withDir()], WIN)
    const remote = withDir({ originId: 'remote-cineca' })
    expect(buildDayPreviews(lanes, [remote], '')[0].reportUrl).toContain('&origin=remote-cineca')
    expect(buildDayPreviews(lanes, [withDir()], '')[0].reportUrl).not.toContain('&origin=')
  })

  it('asks for nothing when the feed carries no directory', () => {
    // Guessing a path here would be a 404 per pane per render.
    const lanes = buildDayLanes(activity([bucket(10, 'agent', SESSION)]), [card()], WIN)
    const [preview] = buildDayPreviews(lanes, [card({ outcome: 'Ran the nulls.' })], '')
    expect(preview.reportUrl).toBeUndefined()
    expect(preview.outcome).toBe('Ran the nulls.')
  })

  it('carries the outcome even when a report exists — it is the fallback', () => {
    const lanes = buildDayLanes(activity([bucket(10, 'agent', SESSION)]), [withDir()], WIN)
    const [preview] = buildDayPreviews(lanes, [withDir({ outcome: 'Compute the PTE.' })], '')
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
