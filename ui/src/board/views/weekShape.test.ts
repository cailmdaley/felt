/**
 * WeekView's arithmetic — the part that must not drift.
 *
 * Like civilDay.test.ts, THE TIMEZONE IS THE EXPERIMENT: `npm test` runs this
 * file twice, once under TZ=America/Los_Angeles and once under TZ=Europe/Paris,
 * because a UTC-only run passes against broken code. The two zones also put
 * their DST transitions on different weekends, so between them the suite covers
 * a spring-forward week and a fall-back week in each direction.
 */

import { describe, expect, it } from 'vitest';
import {
  dayWeight,
  inferBucketMs,
  marksForDay,
  mondayOfWeek,
  pickDaySubjects,
  RAIL_START_HOUR,
  railBounds,
  railFraction,
  readableSubject,
  shiftWeekMonday,
  summarizeSpend,
  weekCivilDays,
  weekWindow,
} from './WeekView.js';
import { isoDayLocal } from '../civilDay.js';
import type { ActivityBucket } from './TemporalData.js';
import type { KanbanCard } from '../KanbanTypes.js';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const HOUR = 3_600_000;

/** The Mondays whose weeks contain a DST transition, per zone. Both zones move
 *  their clocks on a Sunday, so the transition always lands on the LAST row —
 *  the row a naive `+86_400_000` stride is most likely to lose. */
const DST_WEEKS: Record<string, string[]> = {
  'America/Los_Angeles': ['2026-03-02', '2026-10-26'],
  'Europe/Paris': ['2026-03-23', '2026-10-19'],
};

function card(over: Partial<KanbanCard> & { id: string }): KanbanCard {
  return {
    name: over.id,
    path: `.felt/${over.id}.md`,
    originId: 'local',
    status: 'open',
    createdAt: '2026-08-01T09:00:00Z',
    dependsOnSatisfied: true,
    effectiveHorizon: 'now',
    drifted: false,
    ...over,
  };
}

describe('the suite runs under a pinned, non-UTC zone', () => {
  it('is one of the two zones `npm test` pins', () => {
    expect(TZ, 'run via `npm test` — the zone is what this suite tests').toMatch(
      /^(America\/Los_Angeles|Europe\/Paris)$/,
    );
  });
});

describe('Monday-start week derivation', () => {
  // 2026-08-03 is a Monday; the week runs to Sunday 2026-08-09.
  const cases: Array<[string, string]> = [
    ['2026-08-03', '2026-08-03'], // the Monday itself
    ['2026-08-05', '2026-08-03'], // midweek
    ['2026-08-09', '2026-08-03'], // Sunday belongs to the week that BEGAN, not the one starting tomorrow
  ];
  for (const [day, monday] of cases) {
    it(`${day} sits in the week of ${monday}`, () => {
      expect(mondayOfWeek(day)).toBe(monday);
    });
  }

  it('reaches back across a month boundary', () => {
    // Saturday 2026-08-01 belongs to a week that started in July.
    expect(mondayOfWeek('2026-08-01')).toBe('2026-07-27');
    expect(weekCivilDays('2026-07-27')).toEqual([
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
      '2026-07-31',
      '2026-08-01',
      '2026-08-02',
    ]);
  });

  it('reaches back across a year boundary', () => {
    // Friday 2027-01-01 belongs to the week that started 2026-12-28.
    expect(mondayOfWeek('2027-01-01')).toBe('2026-12-28');
    expect(weekCivilDays('2026-12-28').at(-1)).toBe('2027-01-03');
  });

  it('steps whole weeks in both directions, across the month boundary', () => {
    expect(shiftWeekMonday('2026-08-03', -1)).toBe('2026-07-27');
    expect(shiftWeekMonday('2026-08-03', 1)).toBe('2026-08-10');
    expect(shiftWeekMonday('2026-08-03', -5)).toBe('2026-06-29');
  });
});

describe('a DST week still has exactly seven rails', () => {
  const mondays = [...new Set([...Object.values(DST_WEEKS).flat(), '2026-08-03'])];

  for (const monday of mondays) {
    it(`week of ${monday} is seven distinct consecutive civil days`, () => {
      const days = weekCivilDays(monday);
      expect(days).toHaveLength(7);
      expect(new Set(days).size).toBe(7);
      expect(days[0]).toBe(monday);
      // Consecutive by construction, checked by construction-independent means:
      // each day's local date is one greater than the previous, modulo month.
      for (let i = 1; i < days.length; i += 1) {
        const prev = Date.parse(`${days[i - 1]}T00:00:00Z`);
        const next = Date.parse(`${days[i]}T00:00:00Z`);
        expect(next - prev).toBe(86_400_000);
      }
    });

    it(`week of ${monday} opens every rail at ${RAIL_START_HOUR}am local`, () => {
      // This is the assertion a `+ 86_400_000` stride fails: after a spring
      // forward it lands at 7am, after a fall back at 5am.
      for (const day of weekCivilDays(monday)) {
        const { startMs, endMs } = railBounds(day);
        expect(new Date(startMs).getHours()).toBe(RAIL_START_HOUR);
        expect(new Date(endMs).getHours()).toBe(RAIL_START_HOUR);
      }
    });

    it(`week of ${monday} has contiguous rails, no gap and no overlap`, () => {
      const days = weekCivilDays(monday);
      for (let i = 1; i < days.length; i += 1) {
        expect(railBounds(days[i]).startMs).toBe(railBounds(days[i - 1]).endMs);
      }
    });
  }

  it('gives the transition day a 23h or 25h rail in the zone that transitions', () => {
    const mine = DST_WEEKS[TZ] ?? [];
    expect(mine, `no DST weeks recorded for ${TZ}`).not.toHaveLength(0);
    const spans = mine.flatMap((monday) =>
      weekCivilDays(monday).map((day) => {
        const { startMs, endMs } = railBounds(day);
        return (endMs - startMs) / HOUR;
      }),
    );
    expect(spans).toContain(23);
    expect(spans).toContain(25);
    // And nothing else is off-nominal.
    for (const span of spans) expect([23, 24, 25]).toContain(span);
  });

  it('keeps a full ordinary week at 24h a rail', () => {
    for (const day of weekCivilDays('2026-08-03')) {
      const { startMs, endMs } = railBounds(day);
      expect(endMs - startMs).toBe(24 * HOUR);
    }
  });
});

describe('the read window handed to the two routes', () => {
  // The daemon parses narration bounds with Elixir's `Date.from_iso8601/1`
  // (lib/shuttle_web/controllers/narration_controller.ex), which accepts a bare
  // date and NOTHING else. A full timestamp is a 400, the fetcher turns every
  // failure into an empty result, and the marginalia goes blank in silence —
  // the offline harness cannot catch it, because its mock parses anything.
  const BARE_CIVIL_DAY = /^\d{4}-\d{2}-\d{2}$/;
  const noon = (day: string) => Date.parse(`${day}T12:00:00Z`);

  // Ordinary week, a DST week in each zone, and a month/year boundary.
  const mondays = [
    '2026-08-03',
    '2026-07-27',
    '2026-12-28',
    ...Object.values(DST_WEEKS).flat(),
  ];

  for (const monday of mondays) {
    it(`asks narration for bare civil days, week of ${monday}`, () => {
      const win = weekWindow(monday, noon('2026-08-08'));
      expect(win.narrationFrom).toMatch(BARE_CIVIL_DAY);
      expect(win.narrationTo).toMatch(BARE_CIVIL_DAY);
      // No stray time-of-day, offset or `T` sneaking back in.
      expect(win.narrationFrom).not.toContain('T');
      expect(win.narrationTo).not.toContain('T');
      // The range must not be inverted — the daemon 400s on that too.
      expect(win.narrationFrom <= win.narrationTo).toBe(true);
    });
  }

  it('opens the narration range on the shown Monday', () => {
    expect(weekWindow('2026-08-03', noon('2026-08-08')).narrationFrom).toBe('2026-08-03');
  });

  it('closes it the day AFTER Sunday, so the last rail keeps its late night', () => {
    // A rail runs 6am→6am but the daemon's range is inclusive whole days.
    // Stopping at Sunday would drop Sunday's after-midnight commits, which
    // belong to Sunday's row — every other row gets its tail from the
    // following day, and Sunday must not be the exception.
    const win = weekWindow('2026-08-03', noon('2026-08-08'));
    expect(win.days.at(-1)).toBe('2026-08-09');
    expect(win.narrationTo).toBe('2026-08-10');
    // The range is inclusive, so its last day must be the LOCAL day the rail's
    // right edge falls on — that is what makes the edge covered.
    expect(isoDayLocal(win.toMs)).toBe(win.narrationTo);
  });

  it('crosses a month and a year boundary as civil days, not by adding a day of ms', () => {
    expect(weekWindow('2026-07-27', noon('2026-08-08')).narrationTo).toBe('2026-08-03');
    expect(weekWindow('2026-12-28', noon('2026-08-08')).narrationTo).toBe('2027-01-04');
  });

  it('gives activity INSTANTS, not days — the two routes differ', () => {
    const win = weekWindow('2026-08-03', noon('2026-08-08'));
    expect(typeof win.fromMs).toBe('number');
    expect(new Date(win.fromMs).getHours()).toBe(RAIL_START_HOUR);
    expect(win.toMs - win.fromMs).toBe(7 * 24 * HOUR);
  });

  it('caps the activity window at now, rounded up to the fetch quantum', () => {
    const now = Date.parse('2026-08-05T14:03:20Z');
    const win = weekWindow('2026-08-03', now);
    expect(win.activityToMs).toBeGreaterThanOrEqual(now);
    expect(win.activityToMs).toBeLessThan(now + 5 * 60_000);
    expect(win.activityToMs % (5 * 60_000)).toBe(0);
    expect(win.activityToMs).toBeLessThan(win.toMs);
  });

  it('asks for no activity at all on a week wholly in the future', () => {
    const win = weekWindow('2026-08-10', noon('2026-08-05'));
    expect(win.activityToMs).toBeLessThanOrEqual(win.fromMs);
  });

  it('asks for the whole span on a week wholly in the past', () => {
    const win = weekWindow('2026-07-27', noon('2026-08-05'));
    expect(win.activityToMs).toBe(win.toMs);
  });

  it('degrades to an empty window rather than throwing on a bad Monday', () => {
    const win = weekWindow('not-a-day', noon('2026-08-05'));
    expect(win.days).toEqual([]);
    expect(win.narrationFrom).toBe('');
  });
});

describe('placement on a rail', () => {
  it('puts 6am at the left edge and the next 6am at the right', () => {
    const bounds = railBounds('2026-08-05');
    expect(railFraction(bounds.startMs, bounds)).toBe(0);
    expect(railFraction(bounds.endMs, bounds)).toBe(1);
    expect(railFraction(bounds.startMs + 12 * HOUR, bounds)).toBeCloseTo(0.5, 6);
  });

  it('clamps an instant outside the rail rather than positioning it off-edge', () => {
    const bounds = railBounds('2026-08-05');
    expect(railFraction(bounds.startMs - HOUR, bounds)).toBe(0);
    expect(railFraction(bounds.endMs + HOUR, bounds)).toBe(1);
  });
});

describe('a `due:` is a civil day, and lands on the day it names', () => {
  const week = weekCivilDays('2026-08-10'); // Mon 10th … Sun 16th
  const FRIDAY_INDEX = 4;

  // Every serialization felt (or another writer) can produce for "the 14th".
  const encodings = [
    '2026-08-14',
    '2026-08-14T00:00:00Z',
    '2026-08-14T00:00:00.000Z',
    '2026-08-14T00:00:00+00:00',
    '2026-08-14T00:00:00+02:00', // authored on a machine in Paris
    '2026-08-14T00:00:00-07:00', // authored on a machine in Berkeley
  ];

  for (const due of encodings) {
    it(`places due ${due} on Friday, under ${TZ}`, () => {
      expect(week[FRIDAY_INDEX]).toBe('2026-08-14');
      const cards = [card({ id: 'fiber/ship-it', due })];
      const onFriday = marksForDay(cards, week[FRIDAY_INDEX], railBounds(week[FRIDAY_INDEX]));
      expect(onFriday.map((m) => m.kind)).toEqual(['due']);
      // And on no other day of the week.
      for (const day of week) {
        if (day === '2026-08-14') continue;
        expect(marksForDay(cards, day, railBounds(day))).toHaveLength(0);
      }
    });
  }

  it('marks a stashed card`s return hollow, not as a due', () => {
    const cards = [card({ id: 'fiber/later', due: '2026-08-14', effectiveHorizon: 'stashed' })];
    const marks = marksForDay(cards, '2026-08-14', railBounds('2026-08-14'));
    expect(marks.map((m) => m.kind)).toEqual(['snooze']);
    expect(marks[0].glyph).toBe('◌');
  });

  it('carries no obligation for a closed card', () => {
    const cards = [card({ id: 'fiber/done', due: '2026-08-14', status: 'closed' })];
    expect(marksForDay(cards, '2026-08-14', railBounds('2026-08-14'))).toHaveLength(0);
  });

  it('places a nextLaunchAt at its real time of day, not mid-morning', () => {
    const bounds = railBounds('2026-08-14');
    // 21:30 local on the 14th — an instant, so it must be built in local terms.
    const at = new Date(bounds.startMs + 15.5 * HOUR);
    const cards = [
      card({
        id: 'role/morning-post',
        shuttleKind: 'standing',
        status: 'active',
        nextLaunchAt: at.toISOString(),
      }),
    ];
    const marks = marksForDay(cards, '2026-08-14', bounds);
    expect(marks.map((m) => m.kind)).toEqual(['launch']);
    expect(marks[0].fraction).toBeCloseTo(15.5 / 24, 6);
  });

  it('prefers the launch instant over a due when a card carries both', () => {
    const bounds = railBounds('2026-08-14');
    const cards = [
      card({
        id: 'role/both',
        due: '2026-08-14',
        nextLaunchAt: new Date(bounds.startMs + 3 * HOUR).toISOString(),
      }),
    ];
    expect(marksForDay(cards, '2026-08-14', bounds).map((m) => m.kind)).toEqual(['launch']);
  });
});

describe('how full a day was', () => {
  const cases: Array<[number, string]> = [
    [0, 'quiet'],
    [2 * HOUR - 60_000, 'quiet'],
    [2 * HOUR, 'half'],
    [6 * HOUR - 60_000, 'half'],
    [6 * HOUR, 'full'],
    [11 * HOUR, 'full'],
  ];
  for (const [ms, weight] of cases) {
    it(`${ms / HOUR}h reads as ${weight}`, () => {
      expect(dayWeight(ms)).toBe(weight);
    });
  }

  it('counts a minute once however many kinds it carries', () => {
    const bucket = (m: number, k: ActivityBucket['k'], n = 1): ActivityBucket =>
      ({ m, s: null, cwd: null, k, n });
    // Three kinds in the same minute, then one more minute of agent work.
    const spend = summarizeSpend(
      [
        bucket(0, 'agent', 9),
        bucket(0, 'attention'),
        bucket(0, 'notify'),
        bucket(60_000, 'agent', 4),
      ],
      60_000,
    );
    expect(spend.totalMs).toBe(2 * 60_000);
    expect(spend.agentMs).toBe(2 * 60_000);
    expect(spend.attentionMs).toBe(60_000);
    expect(spend.notifyCount).toBe(1);
  });

  it('reads the bucket grid off the data rather than assuming a minute', () => {
    const at = (m: number): ActivityBucket => ({ m, s: null, cwd: null, k: 'agent', n: 1 });
    // A 5-minute grid with a gap in it — the SMALLEST gap is the grid.
    expect(inferBucketMs([at(0), at(300_000), at(600_000), at(3_000_000)])).toBe(300_000);
    expect(inferBucketMs([at(0), at(60_000)])).toBe(60_000);
    // Too few buckets to tell: fall back to a minute rather than guess wide.
    expect(inferBucketMs([])).toBe(60_000);
    expect(inferBucketMs([at(0)])).toBe(60_000);
    // Same minute, several kinds — not a gap.
    expect(
      inferBucketMs([at(0), { m: 0, s: null, cwd: null, k: 'attention', n: 1 }]),
    ).toBe(60_000);
  });

  it('turns a five-minute grid into the hours it stands for', () => {
    // 72 five-minute buckets = 6h = the `full` threshold, exactly.
    const buckets: ActivityBucket[] = [];
    for (let i = 0; i < 72; i += 1) {
      buckets.push({ m: i * 300_000, s: null, cwd: null, k: 'agent', n: 3 });
    }
    const bucketMs = inferBucketMs(buckets);
    expect(bucketMs).toBe(300_000);
    const spend = summarizeSpend(buckets, bucketMs);
    expect(spend.totalMs).toBe(6 * HOUR);
    expect(dayWeight(spend.totalMs)).toBe('full');
  });
});

describe('narration marginalia', () => {
  it('turns a slug prefix into the marginal hand', () => {
    expect(readableSubject('board: fold the masthead actions')).toBe(
      'board — fold the masthead actions',
    );
    expect(readableSubject('no prefix here')).toBe('no prefix here');
    // A sentence with a colon is not a slug.
    expect(readableSubject('the point is: it works')).toBe('the point is: it works');
  });

  it('picks the busiest slugs, at most two', () => {
    const picked = pickDaySubjects([
      'views: hang the pages off a hotkey row',
      'daemon: owner-route the write plane',
      'views: patch rather than rebuild',
      'views: the tick row is shared',
      'daemon: back off a stale remote',
      'stash: cluster on the containment path',
    ]);
    expect(picked).toEqual([
      'views — hang the pages off a hotkey row',
      'daemon — owner-route the write plane',
    ]);
  });

  it('is empty for a day that said nothing', () => {
    expect(pickDaySubjects([])).toEqual([]);
  });
});
