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
  CommitRecord,
  SessionPairing,
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
  dayTotals,
  dayWindow,
  defaultDayISO,
  drawnWindow,
  firstSentence,
  FRAME_MIN_MINUTES,
  formatClockTime,
  formatEntryStats,
  isLivePresent,
  laneChip,
  laneActivity,
  railTicks,
  resolveDayISO,
  stepTarget,
  tickStepMinutes,
  type DayEntry,
  type DayLane,
} from './DayView.js'
import { buildLedgerNarration, ledgerBetween, type LedgerNarration } from './join.js'
import { cardState } from './vocabulary.js'
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

// The old `mergeMinuteRuns` suite lived here — it tested run-fusing and
// gap-bridging for a wash-block grammar that the kernel-smoothed curve
// replaced outright. `mergeMinuteRuns` and `BRIDGE_MINUTES` no longer exist;
// there is no successor to bridging (the curve is continuous, so nothing
// needs to be stitched), so nothing here is rewritten — it is simply gone.

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

// `runningWorker` defaults to SESSION — the join's rung 1, a bucket's session
// name being exactly a card's live worker. A test that builds a SECOND card
// alongside this one must override it (to whichever session its own buckets
// use, or to `undefined`), or the two would collide on this default.
const card = (over: Partial<KanbanCard> = {}): KanbanCard => ({
  id: 'work/spt3g_papers/bmodes-2d',
  uid: FIBER_ULID,
  runningWorker: SESSION,
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
    expect(lanes[0].beats[0].minute).toBe(15)
  })

  it('carries the card lifecycle state onto the lane', () => {
    const lanes = buildDayLanes(activity(bucketsAt(240, 480)), [card()], WIN)
    expect(lanes[0].state).toBe(cardState(card()))

    // A closed fiber has no live worker, so its bucket joins through the
    // ledger (rung 0) rather than the exact-worker rung — and the lane still
    // carries the card's own lifecycle glyph, not the running one.
    const ledger = new Map([
      [SESSION, { fiber: 'work/spt3g_papers/bmodes-2d', uid: null, session: 'sess-x', host: null }],
    ])
    const closed = card({ runningWorker: undefined, status: 'closed' })
    const closedLanes = buildDayLanes(activity(bucketsAt(240, 480)), [closed], WIN, ledger)
    expect(closedLanes[0].state).toBe('awaitingReview')
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
        // Unjoined — no session, no card to carry it. The totals count only
        // what the page actually draws, so this contributes nothing.
        bucket(0, 'attention', null, '/home/ada/loom'),
        bucket(0, 'agent', SESSION),
        bucket(1, 'agent', SESSION),
        bucket(2, 'agent', SESSION),
        bucket(9, 'notify', SESSION),
      ]),
      [card()],
      WIN,
    )
    expect(totals).toEqual({ attention: 1, agent: 3, messages: 1, received: 0 })
  })

  it('sums the events in an attention bucket, not the minutes holding them', () => {
    const busy: ActivityBucket = { ...bucket(30, 'attention', SESSION), n: 4 }
    const totals = dayTotals(activity([busy, bucket(31, 'attention', SESSION)]), [card()], WIN)
    expect(totals.attention).toBe(2)
    expect(totals.messages).toBe(5)
  })

  it('ignores buckets outside the 06:00 → 06:00 window at both ends', () => {
    const outside: ActivityBucket[] = [
      { m: WIN.startMs - 60_000, s: SESSION, cwd: null, k: 'agent', n: 1 },
      { m: WIN.endMs, s: SESSION, cwd: null, k: 'agent', n: 1 },
      { m: WIN.endMs + 60_000, s: SESSION, cwd: null, k: 'attention', n: 1 },
    ]
    expect(dayTotals(activity([...outside, bucket(5, 'agent', SESSION)]), [card()], WIN)).toEqual({
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
      [card()],
      WIN,
    )
    expect(totals.messages).toBe(1)
    expect(totals.received).toBe(3)
    // A reply's minute is agent time, and is not attention.
    expect(totals.agent).toBe(2)
    expect(totals.attention).toBe(1)
  })

  it('counts a notify minute as neither attention nor agent', () => {
    expect(dayTotals(activity([bucket(30, 'notify', SESSION)]), [card()], WIN)).toEqual({
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
  it('joins a bucket to a fiber through its exact live-worker tmux name', () => {
    const lanes = buildDayLanes(
      activity([bucket(60, 'agent', SESSION), bucket(61, 'attention', SESSION)]),
      [card({ shuttleHost: 'Ada-Workstation' })],
      WIN,
    )
    expect(lanes).toHaveLength(1)
    expect(lanes[0].label).toBe('Run the 2D B-mode null tests')
    expect(lanes[0].cardId).toBe('work/spt3g_papers/bmodes-2d')
    // These minutes joined this fiber, one apiece: minute 60's beat is agent
    // only, minute 61's is attention only.
    expect(lanes[0].beats.map((b) => b.minute)).toEqual([60, 61])
    expect(lanes[0].beats[0].kinds).toEqual([{ kind: 'agent', count: 1 }])
    expect(lanes[0].beats[1].kinds).toEqual([{ kind: 'attention', count: 1 }])
    expect(lanes[0].weight).toBe(2)
    // The page's own host is printed once in the head, so a lane that ran
    // there says nothing; only a lane that ran ELSEWHERE names its host.
    expect(lanes[0].hostNote).toBe('')
  })

  it('names a host only when the lane ran somewhere other than the page', () => {
    const elsewhere = buildDayLanes(
      activity([bucket(60, 'agent', SESSION)]),
      [card({ shuttleHost: 'Basalt-Login-02' })],
      WIN,
    )
    expect(elsewhere[0].hostNote).toBe('basalt-login-02')

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
        bucket(12, 'agent', 'some-other-01ZZZ-shuttle', '/home/ada/loom'),
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
      [
        card(),
        card({ id: 'other', uid: otherUlid, name: 'A lighter fiber', runningWorker: `light-${otherUlid}-shuttle` }),
      ],
      WIN,
    )
    expect(lanes.map((l) => l.label)).toEqual(['Run the 2D B-mode null tests', 'A lighter fiber'])
  })

  // The old 'bridges a five-minute pause inside one lane run' test lived here
  // — its whole subject was mergeMinuteRuns's bridging rule, which the curve
  // has no analogue of (a kernel-smoothed field has no runs to bridge). Gone
  // with mergeMinuteRuns itself.
})

describe('the join ladder', () => {
  // Every rung below is a session shape the daemon really produces, and every
  // miss has the same consequence: the bucket draws no lane at all.

  it('joins an exact live-worker tmux name', () => {
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
    // `pi-2f9c41` names no live worker on this board, so rung 1 misses.
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
    // The hover reads BEATS, unsmoothed: three idle minutes between 20 and 24
    // must never be reported as work with words in it, so a beat exists only
    // for a minute that actually carried a bucket.
    const ledger = new Map([['pi-2f9c41', pairing('work/spt3g_papers/bmodes-2d')]])
    const lanes = buildDayLanes(
      activity([
        bucket(20, 'agent', 'pi-2f9c41'),
        bucket(20, 'attention', 'pi-2f9c41'),
        // Three idle minutes in between — no beat for 21, 22 or 23.
        bucket(24, 'agent', 'pi-2f9c41'),
      ]),
      [card()],
      WIN,
      ledger,
    )
    expect(lanes[0].beats.map((b) => b.minute)).toEqual([20, 24])
    expect(lanes[0].beats[0].kinds.map((k) => k.kind).sort()).toEqual(['agent', 'attention'])
    expect(lanes[0].beats[0].sources).toEqual([
      { session: 'sess-work/spt3g_papers/bmodes-2d', host: null },
    ])
  })

  it('turns beats into the curve\'s samples and spines', () => {
    // laneActivity is what DayView hands to the density curve: one weighted
    // sample per active minute (offset half a minute in, since a beat is a
    // bucket), a reply counted on the AGENT side, and a spine only where you
    // actually spoke.
    const lanes = buildDayLanes(
      activity([
        bucket(20, 'agent', SESSION),
        bucket(21, 'attention', SESSION),
        { ...bucket(22, 'reply' as ActivityBucket['k'], SESSION), n: 2 },
      ]),
      [card()],
      WIN,
    )
    const { samples, spines } = laneActivity(lanes[0].beats)
    expect(samples).toEqual([
      { minute: 20.5, human: 0, agent: 1 },
      { minute: 21.5, human: 1, agent: 0 },
      { minute: 22.5, human: 0, agent: 2 },
    ])
    expect(spines).toEqual([21.5])
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
    // on basalt. The minutes win — they are what the rail draws.
    const lanes = buildDayLanes(
      activity([
        bucket(60, 'agent', SESSION, null, 'Basalt-Login-02'),
        bucket(61, 'agent', SESSION, null, 'basalt-login-02'),
      ]),
      [card({ shuttleHost: 'ada-workstation' })],
      WIN,
    )
    expect(lanes[0].host).toBe('basalt-login-02')
    expect(lanes[0].hostNote).toBe('basalt-login-02')
  })

  it('says nothing for a lane whose activity came from the page host', () => {
    const lanes = buildDayLanes(
      activity([bucket(60, 'agent', SESSION, null, 'ada-workstation')]),
      [card({ shuttleHost: 'basalt-login-02' })],
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
      [card({ shuttleHost: 'Basalt-Login-02' })],
      WIN,
    )
    expect(lanes[0].hostNote).toBe('basalt-login-02')
  })

  it('keeps a mixed lane honest: the majority host, then the most recent', () => {
    const majority = buildDayLanes(
      activity([
        bucket(60, 'agent', SESSION, null, 'basalt-login-02'),
        bucket(61, 'agent', SESSION, null, 'basalt-login-02'),
        bucket(300, 'agent', SESSION, null, 'kelvin'),
      ]),
      [card()],
      WIN,
    )
    expect(majority[0].host).toBe('basalt-login-02')

    // Evenly split — the later one describes where the fiber is now.
    const tied = buildDayLanes(
      activity([
        bucket(60, 'agent', SESSION, null, 'basalt-login-02'),
        bucket(300, 'agent', SESSION, null, 'kelvin'),
      ]),
      [card()],
      WIN,
    )
    expect(tied[0].host).toBe('kelvin')
  })

  it('joins a tmux name on the host that owns it, so two fleets cannot swap', () => {
    // Both daemons run a session called `run-shuttle`, for different fibers.
    const other = '01KVBR9A6VP2Q4R7S3T8W5XYHK'
    const ledger = new Map([
      [tmuxJoinKey('ada-workstation', 'run-shuttle'), pairing('work/spt3g_papers/bmodes-2d')],
      [tmuxJoinKey('basalt-login-02', 'run-shuttle'), pairing('a/second')],
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
      'basalt-login-02': { kind: 'remote', stale: true, lastError: 'timeout' },
    }
    const other = '01KVBR9A6VP2Q4R7S3T8W5XYHK'
    const lanes = buildDayLanes(
      activity(
        [
          bucket(60, 'agent', SESSION, null, 'basalt-login-02'),
          bucket(61, 'agent', `second-${other}-shuttle`, null, 'ada-workstation'),
        ],
        'ada-workstation',
        origins,
      ),
      [card(), card({ id: 'a/second', uid: other, name: 'Second', runningWorker: `second-${other}-shuttle` })],
      WIN,
    )
    const remote = lanes.find((l) => l.cardId === 'work/spt3g_papers/bmodes-2d')
    const local = lanes.find((l) => l.cardId === 'a/second')
    // The stale lane still DRAWS — those minutes happened; what is shown is
    // that origin's last-good read, dimmed, not dropped.
    expect(remote).toMatchObject({ host: 'basalt-login-02', hostNote: 'basalt-login-02', stale: true })
    expect(remote?.beats.map((b) => b.minute)).toEqual([60])
    expect(local).toMatchObject({ host: 'ada-workstation', hostNote: '', stale: false })
  })

  it('reads staleness past a difference of case in the origin name', () => {
    const lanes = buildDayLanes(
      activity([bucket(60, 'agent', SESSION, null, 'Basalt-Login-02')], 'ada-workstation', {
        'Basalt-Login-02': { kind: 'remote', stale: true },
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
      activity([bucket(60, 'agent', SESSION, null, 'basalt-login-02')], 'ada-workstation', {
        'basalt-login-02': {
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
    // Activity from basalt is current; the ledger has not heard from it. The
    // lane is built from both files, so the lane is waiting.
    const model = buildDayModel(
      DAY,
      activity([bucket(60, 'agent', SESSION, null, 'basalt-login-02')], 'ada-workstation', {
        'basalt-login-02': { kind: 'remote', stale: false },
      }),
      [card()],
      '',
      NOW_IN_RAIL,
      undefined,
      { 'basalt-login-02': { kind: 'remote', stale: true } },
    )
    expect(model.lanes[0].stale).toBe(true)
    expect(model.origins['basalt-login-02'].stale).toBe(true)
  })
})

describe('what a day cost, per fiber', () => {
  it('counts raw minutes, not the distance spanned between them', () => {
    // 100 and 106 are five idle minutes apart. Nothing here stitches them into
    // a span any more, so the ledger's job is just to not invent the gap: two
    // sparse minutes of agent work are two minutes, not seven.
    const lanes = buildDayLanes(
      activity([
        bucket(100, 'agent', SESSION),
        bucket(106, 'agent', SESSION),
        bucket(200, 'attention', SESSION),
      ]),
      [card()],
      WIN,
    )
    expect(lanes[0].beats.map((b) => b.minute)).toEqual([100, 106, 200])
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
    const ledger: LedgerNarration = {
      byCard: new Map([
        ['work/spt3g_papers/bmodes-2d', { subjects: ['one', 'two'], commits: 2, insertions: 0, deletions: 0 }],
      ]),
    }
    const entries = buildDayEntries(lanes, [card()], WIN, NOW_IN_RAIL, ledger)
    expect(entries[0].stats).toEqual({ messages: 1, received: 0, agent: 2, commits: 2, insertions: 0, deletions: 0 })
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
    // The default card carries a live worker, for the join's sake; a chip is
    // a claim about a worker in the air, so this asks about a card with none.
    expect(laneChip(card({ runningWorker: undefined }), NOW_IN_RAIL)).toBeUndefined()
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
    const lanes = buildDayLanes(activity([bucket(30, 'agent', 'x-shuttle')]), [aloft], WIN)
    const live = buildDayEntries(lanes, [aloft], WIN, NOW_IN_RAIL)
    expect(live[0].chip).toBeDefined()
    // Same card, same lane, read from two days later: the worker is still in
    // the air, but it was not in the air on the day being drawn.
    const past = buildDayEntries(lanes, [aloft], WIN, at(2026, 8, 6, 12, 0))
    expect(past[0].chip).toBeUndefined()
    // What the day COST is a fact about the day, and survives.
    expect(past[0].stats).toEqual({ messages: 0, received: 0, agent: 1, commits: 0 })
  })

  it('carries the owning host, so the attach can be routed', () => {
    const chip = laneChip(worker({ runtimePhase: 'working', shuttleHost: 'basalt' }), NOW_IN_RAIL)
    expect(chip?.host).toBe('basalt')
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
      [withDir(), withDir({ id: 'a/second', uid: other, name: 'Second', runningWorker: `second-${other}-shuttle` })],
      WIN,
    )
    const previews = buildDayPreviews(lanes, [
      withDir(),
      withDir({ id: 'a/second', uid: other, name: 'Second', runningWorker: `second-${other}-shuttle` }),
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
    const remote = withDir({ originId: 'remote-basalt' })
    expect(buildDayPreviews(lanes, [remote], '')[0].reportUrl).toContain('&origin=remote-basalt')
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
  // Narration is ledger-only now — there is no second, subject-prefix reading
  // of the commit log, so there is no "elsewhere in the store" row and no
  // `noLane` entry: a commit the ledger cannot place to a card on this page
  // has nothing to say here, the same as any other unjoined minute.

  it('gives a fiber that worked but the ledger said nothing about its outcome, as a fallback', () => {
    const lanes = buildDayLanes(activity([bucket(30, 'agent', SESSION)]), [card()], WIN)
    const entries = buildDayEntries(
      lanes,
      [card({ outcome: 'Compute the PTE across the patch set. Then check Hartlap.' })],
      WIN,
      NOW_IN_RAIL,
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].fallback).toBe(true)
    expect(entries[0].body).toBe('Compute the PTE across the patch set.')
    expect(entries[0].cardId).toBe('work/spt3g_papers/bmodes-2d')
  })

  it('gives no fallback to a fiber the ledger recorded commits for', () => {
    const lanes = buildDayLanes(activity([bucket(30, 'agent', SESSION)]), [card()], WIN)
    const ledger: LedgerNarration = {
      byCard: new Map([
        ['work/spt3g_papers/bmodes-2d', { subjects: ['ran the nulls'], commits: 1, insertions: 0, deletions: 0 }],
      ]),
    }
    const entries = buildDayEntries(lanes, [card()], WIN, NOW_IN_RAIL, ledger)
    expect(entries).toHaveLength(1)
    expect(entries[0].fallback).toBeUndefined()
    expect(entries[0].body).toBe('ran the nulls')
    expect(entries[0].cardId).toBe('work/spt3g_papers/bmodes-2d')
  })

  it('reads in LANE ORDER, so a rail and its sentence line up', () => {
    // Three lanes of descending weight. The entries must follow the same
    // order — otherwise the two halves of the page are a lookup rather than
    // an obvious correspondence.
    const second = '01KVBR6X3RK7J9N4P8Q5S2TVEG'
    const third = '01KVBR7Y4SM8N2P5Q9R6T3VWFH'
    const cards = [
      card(),
      card({ id: 'a/second', uid: second, name: 'Second heaviest', runningWorker: `second-${second}-shuttle` }),
      card({ id: 'a/third', uid: third, name: 'Lightest', runningWorker: `third-${third}-shuttle` }),
    ]
    const lanes = buildDayLanes(
      activity([
        bucket(10, 'agent', SESSION),
        bucket(11, 'agent', SESSION),
        bucket(12, 'agent', SESSION),
        bucket(20, 'agent', `second-${second}-shuttle`),
        bucket(21, 'agent', `second-${second}-shuttle`),
        bucket(30, 'agent', `third-${third}-shuttle`),
      ]),
      cards,
      WIN,
    )
    expect(lanes.map((l) => l.label)).toEqual([
      'Run the 2D B-mode null tests',
      'Second heaviest',
      'Lightest',
    ])

    const entries = buildDayEntries(lanes, cards, WIN, NOW_IN_RAIL)
    expect(entries.map((e) => e.title)).toEqual([
      'Run the 2D B-mode null tests',
      'Second heaviest',
      'Lightest',
    ])
    // …and the middle one, which the ledger said nothing about, still holds
    // its place, with its outcome standing in.
    expect(entries[1].fallback).toBe(true)
  })

  it('takes the first sentence, or the whole line when there is no full stop', () => {
    expect(firstSentence('One. Two. Three.')).toBe('One.')
    expect(firstSentence('No full stop here')).toBe('No full stop here')
    expect(firstSentence('Ends in a question? Then more.')).toBe('Ends in a question?')
    expect(firstSentence(undefined)).toBe('')
  })
})

// ── The commit ledger — rung 0 of the narration ladder ───────────────────────

describe('attributing a commit by the session that made it', () => {
  // Narration is ledger-only. A hook recorded the harness session AT COMMIT
  // TIME, so the fiber is a fact rather than a reading of the subject line —
  // there is no second, prefix-parsing source to dedupe against any more.
  // These cover the join, host scoping, the refusal to attribute to a card
  // this board does not carry, and the diff figures only the ledger can know.

  const SHA = (n: number): string => String(n).padStart(40, '0')
  const HARNESS = 'a1b2c3d4-0000-4000-8000-000000000001'

  const pairing = (
    fiber: string,
    over: Partial<SessionPairing> = {},
  ): SessionPairing => ({ fiber, uid: null, session: HARNESS, host: 'ada-workstation', ...over })

  const bySession = (...pairs: [string, SessionPairing][]): Map<string, SessionPairing> =>
    new Map(pairs)

  const record = (over: Partial<CommitRecord> = {}): CommitRecord => ({
    at: WIN.startMs + 60_000,
    sha: SHA(1),
    subject: 'ran the nulls',
    repo: '/home/ada/work',
    files: 1,
    insertions: 0,
    deletions: 0,
    session: HARNESS,
    tmux: 'run-shuttle',
    cwd: '/home/ada/work',
    host: 'ada-workstation',
    ...over,
  })

  const lanes = (): DayLane[] =>
    buildDayLanes(activity([bucket(60, 'agent', SESSION)]), [card()], WIN)

  const narrate = (
    records: CommitRecord[],
    index = bySession([HARNESS, pairing('work/spt3g_papers/bmodes-2d')]),
    cards: KanbanCard[] = [card()],
  ): DayEntry[] => {
    const ledger = buildLedgerNarration(ledgerBetween(records, WIN.startMs, WIN.endMs), cards, index)
    return buildDayEntries(lanes(), cards, WIN, NOW_IN_RAIL, ledger)
  }

  it('names the fiber from the session, with no subject prefix to read', () => {
    const entries = narrate([record({ subject: 'ran the nulls' })])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      title: 'Run the 2D B-mode null tests',
      body: 'ran the nulls',
      cardId: 'work/spt3g_papers/bmodes-2d',
    })
    expect(entries[0].fallback).toBeUndefined()
    expect(entries[0].stats?.commits).toBe(1)
  })

  it('resolves through the pairing’s ULID when the fiber path has moved', () => {
    const entries = narrate(
      [record()],
      bySession([HARNESS, pairing('some/old/path', { uid: FIBER_ULID.toLowerCase() })]),
    )
    expect(entries[0].cardId).toBe('work/spt3g_papers/bmodes-2d')
  })

  it('refuses a pairing recorded on another host', () => {
    // Two daemons, one ledger merged by the composite. A commit recorded on
    // basalt must not read ada's pairing, so the fiber's lane falls back to
    // its outcome as though the ledger said nothing.
    const entries = narrate([record({ host: 'basalt-login-02' })])
    expect(entries[0].fallback).toBe(true)
    expect(entries[0].stats?.commits).toBe(0)
  })

  it('falls THROUGH a pairing for a fiber this board does not carry', () => {
    // Attributing to an absent card would put a claim on the page nothing can
    // open. It claims nothing instead, and the fiber's own lane falls back.
    const entries = narrate([record()], bySession([HARNESS, pairing('not/on/this/board')]))
    expect(entries[0].fallback).toBe(true)
    expect(entries[0].stats?.commits).toBe(0)
  })

  it('leaves a session-less commit unattributed', () => {
    // `git commit` typed by hand, outside any harness: there is no session for
    // the ledger to read, so this page has nothing to say about it.
    const entries = narrate([record({ session: null })])
    expect(entries[0].fallback).toBe(true)
    expect(entries[0].stats?.commits).toBe(0)
  })

  it('cuts the ledger to the rail at both ends', () => {
    const inside = record({ at: WIN.startMs })
    expect(ledgerBetween([inside], WIN.startMs, WIN.endMs)).toEqual([inside])
    expect(ledgerBetween([record({ at: WIN.startMs - 1 })], WIN.startMs, WIN.endMs)).toEqual([])
    expect(ledgerBetween([record({ at: WIN.endMs })], WIN.startMs, WIN.endMs)).toEqual([])
    expect(ledgerBetween([record({ at: WIN.endMs - 1 })], WIN.startMs, WIN.endMs)).toHaveLength(1)
  })

  it('counts one commit once when the composite serves it twice', () => {
    // A remote's cached read overlapping the local one. A sha is a sha on
    // every host, so the second copy is the same commit.
    const entries = narrate([
      record({ subject: 'ran the nulls', insertions: 10, deletions: 2 }),
      record({ subject: 'ran the nulls', insertions: 10, deletions: 2, host: 'basalt-login-02' }),
    ])
    expect(entries[0].stats).toMatchObject({ commits: 1, insertions: 10, deletions: 2 })
  })

  it('sums the diff over that fiber’s day, and nobody else’s', () => {
    const other = '01KVBR9A6VP2Q4R7S3T8W5XYHK'
    const otherSession = 'b2c3d4e5-0000-4000-8000-000000000002'
    const cards = [
      card(),
      card({ id: 'a/second', uid: other, name: 'Second', runningWorker: `second-${other}-shuttle` }),
    ]
    const twoLanes = buildDayLanes(
      activity([
        bucket(60, 'agent', SESSION),
        bucket(61, 'agent', `second-${other}-shuttle`),
      ]),
      cards,
      WIN,
    )
    const ledger = buildLedgerNarration(
      [
        record({ sha: SHA(1), subject: 'ran the nulls', insertions: 42, deletions: 7 }),
        record({ sha: SHA(2), subject: 'fixed the mask', insertions: 8, deletions: 0 }),
        record({
          sha: SHA(3),
          subject: 'shipped it',
          session: otherSession,
          insertions: 100,
          deletions: 100,
        }),
      ],
      cards,
      bySession(
        [HARNESS, pairing('work/spt3g_papers/bmodes-2d')],
        [otherSession, pairing('a/second', { session: otherSession })],
      ),
    )
    const entries = buildDayEntries(twoLanes, cards, WIN, NOW_IN_RAIL, ledger)
    const mine = entries.find((e) => e.cardId === 'work/spt3g_papers/bmodes-2d')
    expect(mine?.body).toBe('ran the nulls; fixed the mask')
    expect(mine?.stats).toMatchObject({ commits: 2, insertions: 50, deletions: 7 })
    expect(entries.find((e) => e.cardId === 'a/second')?.stats).toMatchObject({
      insertions: 100,
      deletions: 100,
    })
  })

  it('leaves the diff figures absent when no ledger covers the day', () => {
    // Pre-hook history: the page reads exactly as it did before the ledger
    // existed, with no `+0 −0` where a real figure would be.
    const entries = buildDayEntries(lanes(), [card()], WIN, NOW_IN_RAIL)
    expect(entries[0].stats?.insertions).toBeUndefined()
    expect(formatEntryStats(entries[0].stats!)).toBe('agents 1m')
  })

  it('carries the whole ladder through buildDayModel', () => {
    const model = buildDayModel(
      DAY,
      activity([bucket(60, 'agent', SESSION)]),
      [card()],
      '',
      NOW_IN_RAIL,
      undefined,
      undefined,
      {
        records: [record({ subject: 'ran the nulls', insertions: 42, deletions: 7 })],
        bySession: bySession([HARNESS, pairing('work/spt3g_papers/bmodes-2d')]),
        origins: { 'basalt-login-02': { kind: 'remote', stale: true } },
      },
    )
    expect(model.entries).toHaveLength(1)
    expect(model.entries[0].body).toBe('ran the nulls')
    expect(model.entries[0].stats).toMatchObject({ commits: 1, insertions: 42, deletions: 7 })
    // The commit feed's freshness merges in beside activity's and the ledger's.
    expect(model.origins['basalt-login-02'].stale).toBe(true)
  })

  it('is inert on a daemon that serves no commit ledger', () => {
    const withOut = buildDayModel(DAY, activity([bucket(60, 'agent', SESSION)]), [card()], '', NOW_IN_RAIL)
    expect(withOut.entries[0].fallback).toBe(true)
    expect(withOut.entries[0].stats?.commits).toBe(0)
  })
})

describe('the diff clause', () => {
  it('appends to the muted stat register, both sides', () => {
    expect(formatEntryStats({ messages: 0, agent: 0, commits: 3, insertions: 42, deletions: 7 }))
      .toBe('3 commits · +42 −7')
  })

  it('sets a true minus sign, not a hyphen', () => {
    expect(formatEntryStats({ messages: 0, agent: 0, commits: 0, deletions: 7 })).toBe('−7')
  })

  it('drops a side that is zero, and the clause when both are', () => {
    expect(formatEntryStats({ messages: 0, agent: 0, commits: 1, insertions: 42, deletions: 0 }))
      .toBe('1 commit · +42')
    expect(formatEntryStats({ messages: 0, agent: 0, commits: 1, insertions: 0, deletions: 0 }))
      .toBe('1 commit')
  })

  it('says nothing at all when the ledger does not cover the day', () => {
    expect(formatEntryStats({ messages: 2, agent: 5, commits: 1 })).toBe(
      'you 2 · agents 5m · 1 commit',
    )
  })
})
