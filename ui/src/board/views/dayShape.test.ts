/**
 * The shape of a day — the arithmetic DayView draws.
 *
 * Everything here is built from LOCAL wall-clock constructors
 * (`new Date(y, m, d, h, min)`), never from a `Z` literal, because the whole
 * subject is a civil day in the viewer's zone. `npm test` runs the file twice
 * (TZ=America/Los_Angeles, then TZ=Europe/Paris) so a rule that only holds at
 * one sign of UTC offset fails loudly instead of passing vacuously.
 */

import { describe, expect, it } from 'vitest'
import type { KanbanCard } from '../KanbanTypes.js'
import type { ActivityBucket, ActivityResult, NarrationCommit } from './TemporalData.js'
import {
  buildDayEntries,
  buildDayLanes,
  cwdLaneLabel,
  dayTotals,
  dayWindow,
  defaultDayISO,
  firstSentence,
  formatSpanHM,
  groupCommitsBySlug,
  mergeMinuteRuns,
  shiftCivilDay,
  tmuxFiberUlid,
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
    expect(lanes[0].host).toBe('ada-workstation')
    expect(lanes[0].agent).toEqual([{ start: 60, end: 61 }])
    expect(lanes[0].attention).toEqual([{ start: 61, end: 62 }])
    expect(lanes[0].weight).toBe(2)
  })

  it('drops unjoined work into cwd lanes below the fiber lanes', () => {
    const lanes = buildDayLanes(
      activity([
        bucket(10, 'agent', null, '/home/ada/dev/felt'),
        bucket(11, 'agent', null, '/home/ada/dev/felt'),
        bucket(12, 'agent', 'some-other-01ZZZ-shuttle', '/Users/ada/loom'),
        bucket(13, 'agent', SESSION),
      ]),
      [card()],
      WIN,
    )
    expect(lanes.map((l) => l.kind)).toEqual(['fiber', 'loose', 'loose'])
    expect(lanes[1].label).toBe('~/dev/felt · interactive')
    expect(lanes[2].label).toBe('~/loom · interactive')
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
    const entries = buildDayEntries([commit('views: a different fiber entirely')], lanes, [
      card({ outcome: 'Compute the PTE across the patch set. Then check Hartlap.' }),
    ])
    expect(entries.map((e) => e.title)).toEqual(['views', 'bmodes-2d'])
    expect(entries[1].fallback).toBe(true)
    expect(entries[1].body).toBe('Compute the PTE across the patch set.')
    expect(entries[1].cardId).toBe('work/spt3g_papers/bmodes-2d')
  })

  it('gives no fallback to a fiber whose slug the commits already name', () => {
    const lanes = buildDayLanes(activity([bucket(30, 'agent', SESSION)]), [card()], WIN)
    const entries = buildDayEntries([commit('bmodes-2d: ran the nulls')], lanes, [card()])
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
    )
    expect(entries[entries.length - 1]).toMatchObject({
      title: '— elsewhere in the store —',
      body: 'typo',
      loose: true,
    })
  })

  it('takes the first sentence, or the whole line when there is no full stop', () => {
    expect(firstSentence('One. Two. Three.')).toBe('One.')
    expect(firstSentence('No full stop here')).toBe('No full stop here')
    expect(firstSentence('Ends in a question? Then more.')).toBe('Ends in a question?')
    expect(firstSentence(undefined)).toBe('')
  })
})
