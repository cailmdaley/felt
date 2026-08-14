/**
 * WeekView's arithmetic — the part that must not drift.
 *
 * Like civilDay.test.ts, THE TIMEZONE IS THE EXPERIMENT: `npm test` runs this
 * file twice, once under TZ=America/Los_Angeles and once under TZ=Europe/Paris,
 * because a UTC-only run passes against broken code. The two zones also put
 * their DST transitions on different weekends, so between them the suite covers
 * a spring-forward week and a fall-back week in each direction.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dayWeight,
  annotationFor,
  BUCKET_MS,
  advanceSwipe,
  cyclesInWeek,
  IDLE_SWIPE,
  spanOfCycleCard,
  SWIPE_NUDGE_CAP_PX,
  SWIPE_SETTLE_MS,
  type SwipeState,
  weekStepTarget,
  marksForDay,
  midMorningFraction,
  mondayOfWeek,
  RAIL_START_HOUR,
  railBounds,
  railFraction,
  railRuleFractions,
  shiftWeekMonday,
  rasterSlots,
  rowWaitingOn,
  slotSamples,
  slotTip,
  summarizeSpend,
  weekCivilDays,
  weekLedgerDiff,
  weekMondayForFocus,
  weekWindow,
} from './WeekView.js';
import { buildJoinIndex, originOf } from './join.js';
import { civilDayToLocalDate, isoDayLocal, railCivilDay } from '../civilDay.js';
import { shiftCivilDay } from './railTime.js';
import type { ActivityBucket, CommitRecord, SessionPairing } from './TemporalData.js';
import type { KanbanCard } from '../KanbanTypes.js';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const HOUR = 3_600_000;

/**
 * An instant at a LOCAL wall-clock time on a civil day — the only safe way for
 * this suite to say "now".
 *
 * A UTC literal (`Date.parse('2026-08-08T12:00:00Z')`) names a different local
 * day either side of the Atlantic, so an assertion written against one only
 * ever tests the hemisphere it was authored in. Every clock here is built
 * locally instead, which makes the pinned-zone runs agree by construction
 * rather than by luck — and keeps them honest in zones neither run covers.
 *
 * NOON by default, never midnight: under this view's 6am rail rule, 00:00 on
 * day X still belongs to day X-1's rail, so a midnight clock silently shifts
 * every rail-derived expectation a day early. That has bitten this file more
 * than once.
 */
function atLocal(day: string, hour = 12, minute = 0): number {
  const d = civilDayToLocalDate(day);
  if (!d) throw new Error(`not a civil day: ${day}`);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

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
    // Required on KanbanCard since the cycles contract landed; a plain card is
    // not a cycle, and `over` overrides for the ones that are.
    isCycle: false,
    cycleStart: null,
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

  it('puts the 4-hourly rules on the wall-clock hours they name', () => {
    // Even sixths are only right on a 24h rail. On a 25h rail 2pm is 8/25
    // along, not 8/24, so fixed fractions would drift the rules up to an hour
    // off the ink they measure. Every rule must land on its real hour.
    const wanted = [10, 14, 18, 22, 2];
    for (const monday of [...Object.values(DST_WEEKS).flat(), '2026-08-03']) {
      for (const day of weekCivilDays(monday)) {
        const bounds = railBounds(day);
        const fractions = railRuleFractions(day, bounds);
        expect(fractions).toHaveLength(5);
        const span = bounds.endMs - bounds.startMs;
        // On a SPRING-FORWARD rail the 2am rule names a wall-clock time that
        // does not exist — the clock jumps 02:00 → 03:00 — and `Date` resolves
        // it forward to 03:00. That is the right place for the rule: it is the
        // first instant at or after where 2am would have been. Only the last
        // rule on a 23h rail can hit this, so the exception is that narrow.
        const skipsTwoAm = span === 23 * HOUR;
        fractions.forEach((f, i) => {
          expect(f).toBeGreaterThan(0);
          expect(f).toBeLessThan(1);
          if (i > 0) expect(f).toBeGreaterThan(fractions[i - 1]);
          const hour = new Date(bounds.startMs + f * span).getHours();
          expect(hour).toBe(i === 4 && skipsTwoAm ? wanted[i] + 1 : wanted[i]);
        });
      }
    }
  });

  it('is even sixths on an ordinary rail and is NOT on a DST one', () => {
    const even = [1, 2, 3, 4, 5].map((i) => i / 6);
    for (const f of railRuleFractions('2026-08-05', railBounds('2026-08-05'))) {
      expect(even.some((e) => Math.abs(e - f) < 1e-9)).toBe(true);
    }
    const oddRail = (DST_WEEKS[TZ] ?? [])
      .flatMap((monday) => weekCivilDays(monday))
      .find((day) => {
        const { startMs, endMs } = railBounds(day);
        return endMs - startMs !== 24 * HOUR;
      });
    expect(oddRail, `no off-nominal rail found for ${TZ}`).toBeDefined();
    const drifted = railRuleFractions(oddRail!, railBounds(oddRail!));
    expect(drifted.some((f, i) => Math.abs(f - even[i]) > 1e-6)).toBe(true);
  });
});

describe('the day a rail belongs to is the dawn day, not the midnight one', () => {
  // The whole view is built on 6am→6am rails, so "which row is now on" has to
  // be asked in the same terms. Asking the midnight question put the gold seam
  // on a row that had not started yet, clamped the now-marker to its left edge,
  // and greyed out the live rail as past — losing its in-flight marginalia and
  // suppressing every mark on it, for six hours every night.
  // [hour of Wednesday 2026-08-05, the rail day it belongs to]
  const cases: Array<[number, string]> = [
    [0, '2026-08-04'], // midnight is still Tuesday's evening
    [2, '2026-08-04'],
    [5, '2026-08-04'],
    [6, '2026-08-05'], // the rail opens
    [12, '2026-08-05'],
    [23, '2026-08-05'],
  ];
  for (const [hour, expected] of cases) {
    it(`${String(hour).padStart(2, '0')}:00 Wednesday sits on ${expected}'s rail`, () => {
      expect(railCivilDay(atLocal('2026-08-05', hour), RAIL_START_HOUR)).toBe(expected);
    });
  }

  it('agrees with the rail it names — the instant is inside those bounds', () => {
    for (const hour of [0, 2, 5, 6, 12, 23]) {
      const at = atLocal('2026-08-05', hour);
      const { startMs, endMs } = railBounds(railCivilDay(at, RAIL_START_HOUR));
      expect(at).toBeGreaterThanOrEqual(startMs);
      expect(at).toBeLessThan(endMs);
    }
  });

  it('rolls back across a month boundary at 02:00 on the first', () => {
    expect(railCivilDay(atLocal('2026-08-01', 2), RAIL_START_HOUR)).toBe('2026-07-31');
  });

  it('does not jump the week early in the small hours of a Monday', () => {
    // 01:00 Monday: the rail being worked is the PREVIOUS week's Sunday, so the
    // view must still show that week. Reading the midnight day here also put
    // the week's start four hours in the future, which made `weekWindow`
    // suppress the activity request entirely and blanked the whole page.
    const smallHoursMonday = atLocal('2026-08-10', 1);
    expect(weekMondayForFocus(null, smallHoursMonday)).toBe('2026-08-03');
    const win = weekWindow(weekMondayForFocus(null, smallHoursMonday), smallHoursMonday);
    expect(win.days).toContain('2026-08-09');
    expect(win.activityToMs).toBeGreaterThan(win.fromMs); // it still asks
  });

  it('has moved on by 06:00 that Monday', () => {
    expect(weekMondayForFocus(null, atLocal('2026-08-10', 6))).toBe('2026-08-10');
  });
});

describe('the week follows the shared temporal cursor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const nowMs = atLocal('2026-08-05'); // midday Wednesday, wherever you are

  it('shows the current week when the cursor is null', () => {
    expect(weekMondayForFocus(null, nowMs)).toBe(mondayOfWeek(isoDayLocal(nowMs)));
  });

  it('re-resolves null against the clock rather than freezing a week', () => {
    const later = atLocal('2026-08-19'); // two weeks on
    expect(weekMondayForFocus(null, nowMs)).not.toBe(weekMondayForFocus(null, later));
  });

  // [cursor, the Monday it should open]
  const cases: Array<[string, string]> = [
    ['2026-08-03', '2026-08-03'], // the Monday itself
    ['2026-08-05', '2026-08-03'], // midweek
    ['2026-08-09', '2026-08-03'], // Sunday stays in the week that began
    ['2026-08-10', '2026-08-10'], // the next Monday opens the next week
    ['2026-08-01', '2026-07-27'], // reaches back across a month boundary
    ['2027-01-01', '2026-12-28'], // and across a year boundary
    ['2026-10-25', '2026-10-19'], // Paris's fall-back Sunday
    ['2026-03-08', '2026-03-02'], // Los Angeles's spring-forward Sunday
  ];
  for (const [cursor, monday] of cases) {
    it(`a cursor on ${cursor} opens the week of ${monday}`, () => {
      expect(weekMondayForFocus(cursor, nowMs)).toBe(monday);
    });
  }

  it('takes the leading day of a full timestamp, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A caller holding an instant where the cursor wants a civil day. It works,
    // but it is worth seeing before it becomes an off-by-one downstream.
    expect(weekMondayForFocus('2026-08-05T23:30:00Z', nowMs)).toBe('2026-08-03');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('falls back to the current week on an unparseable cursor', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(weekMondayForFocus('last tuesday', nowMs)).toBe(mondayOfWeek(isoDayLocal(nowMs)));
    expect(warn).toHaveBeenCalledOnce();
  });

  it('pages by seven days on the cursor, so the weekday survives the jump', () => {
    // ‹ › and the arrow keys move the CURSOR ±7 days rather than this view's
    // idea of the week, which is what keeps Day and Chronicle in step. A
    // seven-day civil stride must land on the same weekday even across a DST
    // transition — the bug an `+ 7 * 86_400_000` stride would introduce.
    const weekdayOf = (day: string) => civilDayToLocalDate(day)?.getDay();
    for (const day of ['2026-08-05', '2026-03-06', '2026-10-23', '2026-12-30']) {
      expect(weekdayOf(shiftCivilDay(day, 7))).toBe(weekdayOf(day));
      expect(weekdayOf(shiftCivilDay(day, -7))).toBe(weekdayOf(day));
    }
    expect(shiftCivilDay('2026-08-05', 7)).toBe('2026-08-12');
    expect(shiftCivilDay('2026-08-05', -7)).toBe('2026-07-29');
  });

  it('lands the paged cursor in the neighbouring week, not the same one', () => {
    const monday = weekMondayForFocus('2026-08-05', nowMs);
    expect(weekMondayForFocus(shiftCivilDay('2026-08-05', 7), nowMs)).toBe(
      shiftWeekMonday(monday, 1),
    );
    expect(weekMondayForFocus(shiftCivilDay('2026-08-05', -7), nowMs)).toBe(
      shiftWeekMonday(monday, -1),
    );
  });
});

describe('the read window handed to the activity route', () => {
  // Week asks for activity and nothing else. It used to ask for narration too,
  // and the bare-civil-day rule that call needed is now Day's to keep — see
  // DayView. What survives here is the instant side and the now-cap.

  it('gives activity INSTANTS with a 6am-local left edge', () => {
    const win = weekWindow('2026-08-03', atLocal('2026-08-08'));
    expect(typeof win.fromMs).toBe('number');
    expect(new Date(win.fromMs).getHours()).toBe(RAIL_START_HOUR);
    expect(win.toMs - win.fromMs).toBe(7 * 24 * HOUR);
  });

  it('caps the activity window at now, rounded up to the fetch quantum', () => {
    const now = atLocal('2026-08-05', 14, 3) + 20_000;
    const win = weekWindow('2026-08-03', now);
    expect(win.activityToMs).toBeGreaterThanOrEqual(now);
    expect(win.activityToMs).toBeLessThan(now + 5 * 60_000);
    expect(win.activityToMs % (5 * 60_000)).toBe(0);
    expect(win.activityToMs).toBeLessThan(win.toMs);
  });

  it('asks for no activity at all on a week wholly in the future', () => {
    const win = weekWindow('2026-08-10', atLocal('2026-08-05'));
    expect(win.activityToMs).toBeLessThanOrEqual(win.fromMs);
  });

  it('asks for the whole span on a week wholly in the past', () => {
    const win = weekWindow('2026-07-27', atLocal('2026-08-05'));
    expect(win.activityToMs).toBe(win.toMs);
  });

  it('degrades to an empty window rather than throwing on a bad Monday', () => {
    const win = weekWindow('not-a-day', atLocal('2026-08-05'));
    expect(win.days).toEqual([]);
    expect(win.fromMs).toBe(0);
  });
});

describe('the right-edge annotation, now the only text out there', () => {
  const spend = (hours: number) => ({ totalMs: hours * HOUR });

  it('reports how a past day went', () => {
    expect(annotationFor(spend(8), true, false, 0)).toBe('8h · full');
    expect(annotationFor(spend(3), true, false, 0)).toBe('3h · half');
  });

  it('says nothing on a future row — `—` there would read as "no activity"', () => {
    // A day that has not happened has not been quiet; it has not happened.
    expect(annotationFor(null, false, false, 0)).toBe('');
    expect(annotationFor(spend(8), false, false, 3)).toBe('');
  });

  it('marks a past day with no activity as an em dash, not as nothing', () => {
    expect(annotationFor(null, true, false, 0)).toBe('—');
    expect(annotationFor(spend(0), true, false, 0)).toBe('—');
  });

  it('carries the day\'s exchange in messages, between the weight and the count', () => {
    expect(annotationFor({ totalMs: 5 * HOUR, sent: 14, received: 9 }, true, false, 0)).toBe(
      '5h · half · you 14 · 9 back',
    );
    expect(annotationFor({ totalMs: 5 * HOUR, sent: 14, received: 9 }, false, true, 2)).toBe(
      '5h · half · you 14 · 9 back · 2 aloft',
    );
  });

  it('says nothing about messages on a day that had none', () => {
    // A batch run or an overnight sweep is not a conversation with zero turns.
    expect(annotationFor({ totalMs: 5 * HOUR, sent: 0, received: 0 }, true, false, 0)).toBe(
      '5h · half',
    );
  });

  it('drops the reply half against a daemon that does not report replies', () => {
    expect(annotationFor({ totalMs: 5 * HOUR, sent: 6, received: 0 }, true, false, 0)).toBe(
      '5h · half · you 6',
    );
  });

  it('appends the aloft count on today, and only there', () => {
    // The one signal the removed marginalia carried that the rasters cannot:
    // the seam says something is running, a count says how much.
    expect(annotationFor(spend(7), false, true, 3)).toBe('7h · full · 3 aloft');
    expect(annotationFor(spend(7), true, false, 3)).toBe('7h · full');
  });

  it('drops the count when nothing is aloft, rather than saying "0 aloft"', () => {
    expect(annotationFor(spend(7), false, true, 0)).toBe('7h · full');
  });

  it('still reports today when it has been quiet so far', () => {
    expect(annotationFor(null, false, true, 2)).toBe('— · 2 aloft');
  });

  it('carries the day\'s line count last, when the ledger joined one', () => {
    expect(annotationFor(spend(7), true, false, 0, { insertions: 512, deletions: 208 })).toBe(
      '7h · full · +512 −208',
    );
    expect(annotationFor(spend(7), false, true, 2, { insertions: 40, deletions: 0 })).toBe(
      '7h · full · 2 aloft · +40',
    );
  });

  it('drops the line count entirely rather than printing `+0 −0`', () => {
    // "The ledger recorded nothing attributable here" and "nothing changed"
    // are the same silence — a pair of zeros would be false precision.
    expect(annotationFor(spend(7), true, false, 0, { insertions: 0, deletions: 0 })).toBe(
      '7h · full',
    );
    expect(annotationFor(spend(7), true, false, 0, null)).toBe('7h · full');
    expect(annotationFor(spend(7), true, false, 0)).toBe('7h · full');
  });
});

describe('the week`s line-count ledger', () => {
  const MONDAY = '2026-08-03';
  const DAYS = weekCivilDays(MONDAY);

  /** A session ledger keyed the way `lookupSession` reads it. */
  function sessions(
    ...rows: { session: string; fiber: string; host?: string | null; uid?: string | null }[]
  ): Map<string, SessionPairing> {
    return new Map(
      rows.map((r) => [
        r.session,
        { fiber: r.fiber, uid: r.uid ?? null, session: r.session, host: r.host ?? null },
      ]),
    );
  }

  function commit(over: Partial<CommitRecord> & { at: number; sha: string }): CommitRecord {
    return {
      subject: 'work: a thing',
      repo: null,
      files: 1,
      insertions: 0,
      deletions: 0,
      session: 's-1',
      tmux: null,
      cwd: null,
      host: null,
      ...over,
    };
  }

  const cards = [card({ id: 'fiber/board' }), card({ id: 'fiber/notes' })];
  const ledger = sessions(
    { session: 's-1', fiber: 'fiber/board' },
    { session: 's-2', fiber: 'fiber/notes' },
  );

  it('puts each commit on the civil day whose RAIL holds it', () => {
    const records = [
      commit({ at: atLocal(DAYS[1], 10), sha: 'a', insertions: 10, deletions: 1 }),
      // 2am Wednesday is still TUESDAY's rail — the day the work started.
      commit({ at: atLocal(DAYS[3], 2), sha: 'b', insertions: 5, deletions: 2 }),
      commit({ at: atLocal(DAYS[4], 15), sha: 'c', insertions: 100, deletions: 0 }),
    ];
    const out = weekLedgerDiff(records, cards, ledger, DAYS);
    expect(out.byDay.get(DAYS[1])).toEqual({ insertions: 10, deletions: 1 });
    expect(out.byDay.get(DAYS[2])).toEqual({ insertions: 5, deletions: 2 });
    expect(out.byDay.get(DAYS[3])).toEqual({ insertions: 0, deletions: 0 });
    expect(out.byDay.get(DAYS[4])).toEqual({ insertions: 100, deletions: 0 });
  });

  it('names every day of the week, zeroed when nothing joined', () => {
    const out = weekLedgerDiff([], cards, ledger, DAYS);
    expect([...out.byDay.keys()]).toEqual(DAYS);
    for (const day of DAYS) expect(out.byDay.get(day)).toEqual({ insertions: 0, deletions: 0 });
    expect(out.week).toEqual({ insertions: 0, deletions: 0 });
  });

  it('totals the week to exactly the sum of its days', () => {
    const records = DAYS.map((day, i) =>
      commit({ at: atLocal(day, 11), sha: `s${i}`, insertions: i + 1, deletions: i }),
    );
    const out = weekLedgerDiff(records, cards, ledger, DAYS);
    const summed = [...out.byDay.values()].reduce(
      (acc, d) => ({
        insertions: acc.insertions + d.insertions,
        deletions: acc.deletions + d.deletions,
      }),
      { insertions: 0, deletions: 0 },
    );
    expect(out.week).toEqual(summed);
    expect(out.week).toEqual({ insertions: 28, deletions: 21 });
  });

  it('drops a commit whose session the ledger cannot resolve', () => {
    const records = [
      commit({ at: atLocal(DAYS[1], 10), sha: 'a', session: 'unknown', insertions: 999 }),
      commit({ at: atLocal(DAYS[1], 11), sha: 'b', session: null, insertions: 999 }),
      commit({ at: atLocal(DAYS[1], 12), sha: 'c', insertions: 3 }),
    ];
    const out = weekLedgerDiff(records, cards, ledger, DAYS);
    expect(out.week).toEqual({ insertions: 3, deletions: 0 });
  });

  it('drops a commit whose fiber this board does not carry', () => {
    const elsewhere = sessions({ session: 's-9', fiber: 'fiber/some-other-board' });
    const records = [commit({ at: atLocal(DAYS[1], 10), sha: 'a', session: 's-9', insertions: 40 })];
    expect(weekLedgerDiff(records, cards, elsewhere, DAYS).week).toEqual({
      insertions: 0,
      deletions: 0,
    });
  });

  it('counts one sha once, however many hosts reported it', () => {
    // The composite feed serves a remote's cached read alongside the local one;
    // a sha is a sha on every host.
    const records = [
      commit({ at: atLocal(DAYS[2], 9), sha: 'dup', host: 'ada', insertions: 12, deletions: 4 }),
      commit({ at: atLocal(DAYS[2], 9), sha: 'dup', host: 'bob', insertions: 12, deletions: 4 }),
    ];
    const out = weekLedgerDiff(records, cards, ledger, DAYS);
    expect(out.byDay.get(DAYS[2])).toEqual({ insertions: 12, deletions: 4 });
    expect(out.week).toEqual({ insertions: 12, deletions: 4 });
  });

  it('adds up the several fibers that shared a day', () => {
    const records = [
      commit({ at: atLocal(DAYS[0], 10), sha: 'a', session: 's-1', insertions: 7, deletions: 1 }),
      commit({ at: atLocal(DAYS[0], 14), sha: 'b', session: 's-2', insertions: 3, deletions: 9 }),
    ];
    expect(weekLedgerDiff(records, cards, ledger, DAYS).byDay.get(DAYS[0])).toEqual({
      insertions: 10,
      deletions: 10,
    });
  });

  it('has nothing to say without a session ledger', () => {
    const records = [commit({ at: atLocal(DAYS[1], 10), sha: 'a', insertions: 40 })];
    expect(weekLedgerDiff(records, cards, undefined, DAYS).week).toEqual({
      insertions: 0,
      deletions: 0,
    });
    expect(weekLedgerDiff(records, cards, new Map(), DAYS).week).toEqual({
      insertions: 0,
      deletions: 0,
    });
  });

  it('ignores records outside the week on screen', () => {
    const records = [
      commit({ at: atLocal(shiftCivilDay(MONDAY, -3), 12), sha: 'before', insertions: 50 }),
      commit({ at: atLocal(shiftCivilDay(MONDAY, 9), 12), sha: 'after', insertions: 60 }),
      commit({ at: atLocal(DAYS[5], 12), sha: 'in', insertions: 6 }),
    ];
    expect(weekLedgerDiff(records, cards, ledger, DAYS).week).toEqual({
      insertions: 6,
      deletions: 0,
    });
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

  it('parks an undated due on the rail`s own 10am rule, DST and all', () => {
    // A due has no time of day, so it is placed at mid-morning — and the rule
    // the rail already draws at 10am is exactly where the eye expects it. The
    // flat `(10 - 6) / 24` this replaced is only right on a 24-hour rail: on a
    // 23- or 25-hour one it drifts off its own rule by up to an hour.
    for (const monday of [...Object.values(DST_WEEKS).flat(), '2026-08-03']) {
      for (const day of weekCivilDays(monday)) {
        const bounds = railBounds(day);
        // railRuleFractions walks 10, 14, 18, 22, 26 — the first is 10am.
        const tenAm = railRuleFractions(day, bounds)[0];
        expect(midMorningFraction(day, bounds), `${day} in ${TZ}`).toBeCloseTo(tenAm, 12);
        const marks = marksForDay(
          [card({ id: 'fiber/owed', due: day })],
          day,
          bounds,
        );
        expect(marks[0].fraction).toBeCloseTo(tenAm, 12);
      }
    }
  });

  it('leaves the flat fraction as the answer for a day that will not parse', () => {
    expect(midMorningFraction('not-a-day', railBounds('2026-08-05'))).toBeCloseTo(4 / 24, 12);
  });

  it('marks a stashed card`s return hollow, not as a due', () => {
    const cards = [card({ id: 'fiber/later', due: '2026-08-14', effectiveHorizon: 'stashed' })];
    const marks = marksForDay(cards, '2026-08-14', railBounds('2026-08-14'));
    expect(marks.map((m) => m.kind)).toEqual(['snooze']);
    expect(marks[0].glyph).toBe('◌');
  });

  it('never draws a cycle as an obligation, however it reaches the rails', () => {
    // A cycle's `due` is the END of a span, not a deadline. If one ever leaked
    // onto `ctx.cards` — say by `collectCards` growing a `take(response.cycles)`
    // — a ◴ on its closing day would invent work that was never owed.
    const cycle = card({
      id: 'c/q3',
      isCycle: true,
      cycleStart: '2026-07-01',
      due: '2026-08-14',
      status: 'active',
    });
    expect(marksForDay([cycle], '2026-08-14', railBounds('2026-08-14'))).toHaveLength(0);
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

  it('files a pre-dawn launch on the rail that contains it, not the calendar day', () => {
    // A `0 3 * * *` role firing at 03:00 Thursday. 03:00 is three hours BEFORE
    // Thursday's rail opens, so the calendar day is the wrong row: the glyph
    // clamped to fraction 0 and drew under the 6am tick, while Wednesday's row
    // — which really owns that instant, near its right end — showed nothing.
    const wed = railBounds('2026-08-12');
    const at = new Date(wed.startMs + 21 * HOUR); // 03:00 Thursday local
    expect(at.getHours()).toBe(3);
    const cards = [card({ id: 'role/dawn', status: 'active', nextLaunchAt: at.toISOString() })];

    expect(marksForDay(cards, '2026-08-13', railBounds('2026-08-13'))).toHaveLength(0);
    const onWed = marksForDay(cards, '2026-08-12', wed);
    expect(onWed.map((m) => m.kind)).toEqual(['launch']);
    // Near the right end of Wednesday's rail, and emphatically not clamped.
    expect(onWed[0].fraction).toBeCloseTo(21 / 24, 6);
    expect(onWed[0].fraction).toBeGreaterThan(0);
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

describe('paging hands the cursor back to the present', () => {
  // "Now" is midday Wednesday 2026-08-05; the live week is Mon 08-03 … Sun
  // 08-09. MIDDAY, not midnight: by this view's own 6am rule, 00:00 Wednesday
  // still belongs to Tuesday's rail, so a midnight clock would silently make
  // every expectation here a day early. (It did, on the first run.)
  const NOW = atLocal('2026-08-05');

  it('writes null when a step lands anywhere in the current week', () => {
    // Paging back from next week returns to the live present, so the cursor
    // stops being a date. Any weekday of the live week does it — the rule is
    // the week, not the day, because the week is this view's unit.
    for (const from of ['2026-08-10', '2026-08-12', '2026-08-16']) {
      expect(weekStepTarget(from, -1, NOW)).toBeNull();
    }
    expect(weekStepTarget('2026-07-27', 1, NOW)).toBeNull();
  });

  it('writes a date when the step lands anywhere else', () => {
    expect(weekStepTarget(null, 1, NOW)).toBe('2026-08-12');
    expect(weekStepTarget(null, -1, NOW)).toBe('2026-07-29');
    expect(weekStepTarget('2026-08-12', 1, NOW)).toBe('2026-08-19');
  });

  it('keeps the weekday across every step that does not snap', () => {
    const weekdayOf = (day: string) => civilDayToLocalDate(day)?.getDay();
    let cursor = weekStepTarget(null, 1, NOW);
    expect(weekdayOf(cursor!)).toBe(weekdayOf('2026-08-05'));
    cursor = weekStepTarget(cursor, 1, NOW);
    expect(weekdayOf(cursor!)).toBe(weekdayOf('2026-08-05'));
  });

  it('round-trips out and back to null, never to a pinned today', () => {
    // The defect this rule exists to prevent: paging away and back used to
    // leave the cursor on a date inside the live week, so the header claimed
    // "This week" while Day opened on that weekday instead of today.
    const away = weekStepTarget(null, -1, NOW);
    expect(away).not.toBeNull();
    expect(weekStepTarget(away, 1, NOW)).toBeNull();
  });

  it('sends `t` home by writing null, at any hour including the pre-dawn ones', () => {
    // `t` is `setFocusDate(null)`, which is what `weekStepTarget` also produces
    // when a step lands on the live week — one meaning of "home", one rule.
    // The 02:00 case is the one that goes wrong: by the 6am rail rule the live
    // week at 01:00 Monday is still the one that began the PREVIOUS Monday, so
    // a page showing that week IS home and must not read as away.
    const smallHoursMonday = atLocal('2026-08-10', 1);
    expect(weekMondayForFocus(null, smallHoursMonday)).toBe('2026-08-03');
    // Home from a pinned day inside the live week, at that same hour.
    expect(weekMondayForFocus('2026-08-05', smallHoursMonday)).toBe(
      weekMondayForFocus(null, smallHoursMonday),
    );
    // And after 06:00 the live week has moved on, so the same pin is away.
    const afterDawn = atLocal('2026-08-10', 6);
    expect(weekMondayForFocus('2026-08-05', afterDawn)).not.toBe(
      weekMondayForFocus(null, afterDawn),
    );
  });

  it('reads the cursor by the RAIL day, so a 2am step is not a week early', () => {
    // 01:00 on Monday 2026-08-10: the live week is still the one that began
    // 08-03, so paging forward should land in the week of 08-10 — not skip it.
    const smallHours = atLocal('2026-08-10', 1);
    expect(weekMondayForFocus(null, smallHours)).toBe('2026-08-03');
    const next = weekStepTarget(null, 1, smallHours);
    expect(next).not.toBeNull();
    expect(mondayOfWeek(next!)).toBe('2026-08-10');
  });
});

describe('one physical swipe is one week', () => {
  const at = (state: SwipeState, dx: number, ms: number) => advanceSwipe(state, dx, ms);

  it('accumulates until the threshold, then pages once', () => {
    let s = IDLE_SWIPE;
    let steps = 0;
    // A flick: eight events of 20px each. 160px total crosses 120px once.
    for (let i = 0; i < 8; i += 1) {
      const out = at(s, 20, 1000 + i * 10);
      s = out.state;
      steps += out.step;
    }
    expect(steps).toBe(1);
  });

  it('does not page five times from one flick with an inertial tail', () => {
    // This is the whole reason the lock exists: a trackpad keeps sending
    // decaying events long after the fingers lift, and a bare threshold would
    // page again every 120px of tail.
    let s = IDLE_SWIPE;
    let steps = 0;
    let ms = 1000;
    for (const dx of [40, 60, 55, 50, 44, 38, 30, 24, 18, 12, 8, 5, 3, 2, 1]) {
      const out = at(s, dx, ms);
      s = out.state;
      steps += out.step;
      ms += 12; // well inside the settle window — one continuous gesture
    }
    expect(steps).toBe(1);
  });

  it('reopens after the gesture goes quiet, so a second swipe pages again', () => {
    let s = IDLE_SWIPE;
    let steps = 0;
    let ms = 1000;
    for (let gesture = 0; gesture < 3; gesture += 1) {
      for (let i = 0; i < 8; i += 1) {
        const out = at(s, 20, ms);
        s = out.state;
        steps += out.step;
        ms += 10;
      }
      ms += SWIPE_SETTLE_MS + 50; // fingers lift
    }
    expect(steps).toBe(3);
  });

  it('pages backward on a leftward swipe', () => {
    let s = IDLE_SWIPE;
    let step = 0;
    for (let i = 0; i < 8 && step === 0; i += 1) {
      const out = at(s, -20, 1000 + i * 10);
      s = out.state;
      step = out.step;
    }
    expect(step).toBe(-1);
  });

  it('leans with the gesture, capped, and opposite to the travel', () => {
    // The sheet slides left as you swipe forward in time, so the next week
    // appears to come in from the right.
    const small = at(IDLE_SWIPE, 20, 1000);
    expect(small.nudge).toBeLessThan(0);
    expect(Math.abs(small.nudge)).toBeLessThanOrEqual(SWIPE_NUDGE_CAP_PX);
    // Accumulated but still under threshold: the lean must not exceed the cap.
    let s = IDLE_SWIPE;
    let last = 0;
    for (let i = 0; i < 5; i += 1) {
      const out = at(s, 22, 1000 + i * 10);
      s = out.state;
      last = out.nudge;
    }
    expect(Math.abs(last)).toBeLessThanOrEqual(SWIPE_NUDGE_CAP_PX);
  });

  it('leans back to nothing on the event that pages', () => {
    const out = at({ offset: 110, locked: false, lastMs: 1000 }, 20, 1005);
    expect(out.step).toBe(1);
    expect(out.nudge).toBe(0);
    expect(out.state.offset).toBe(0);
    expect(out.state.locked).toBe(true);
  });

  it('treats a long pause as a new gesture even mid-accumulation', () => {
    // Half a swipe, then the user stops and starts again the other way. The
    // stale half must not combine with the new travel.
    const half = at(IDLE_SWIPE, 90, 1000);
    expect(half.state.offset).toBe(90);
    const later = at(half.state, -40, 1000 + SWIPE_SETTLE_MS + 1);
    expect(later.step).toBe(0);
    expect(later.state.offset).toBe(-40);
  });
});

describe('which cycles the week falls inside', () => {
  // Week of Mon 2026-08-03 … Sun 2026-08-09, "now" on the Thursday.
  const week = weekCivilDays('2026-08-03');
  const NOW = atLocal('2026-08-06');

  const cycle = (id: string, start: string | null, end?: string) =>
    card({ id, isCycle: true, cycleStart: start, due: end });

  const names = (cards: KanbanCard[]) => cards.map((c) => c.id);

  it('takes a cycle that covers the whole week', () => {
    expect(names(cyclesInWeek([cycle('c/q3', '2026-07-01', '2026-09-30')], week, NOW))).toEqual([
      'c/q3',
    ]);
  });

  // The edges are the whole question: a week that merely TOUCHES a cycle is
  // inside it for the purposes of this header, at both ends.
  it('takes a cycle ending on the Monday', () => {
    expect(names(cyclesInWeek([cycle('c/ends-mon', '2026-07-20', '2026-08-03')], week, NOW)))
      .toEqual(['c/ends-mon']);
  });

  it('takes a cycle starting on the Sunday', () => {
    expect(names(cyclesInWeek([cycle('c/starts-sun', '2026-08-09', '2026-08-21')], week, NOW)))
      .toEqual(['c/starts-sun']);
  });

  it('drops a cycle ending the day before the Monday', () => {
    expect(cyclesInWeek([cycle('c/just-missed', '2026-07-20', '2026-08-02')], week, NOW))
      .toHaveLength(0);
  });

  it('drops a cycle starting the day after the Sunday', () => {
    expect(cyclesInWeek([cycle('c/next-up', '2026-08-10', '2026-08-21')], week, NOW))
      .toHaveLength(0);
  });

  it('runs an open-ended cycle from its start onward, not just up to today', () => {
    // No `due`: still running. `cycleSpan` clamps its end to today so a view has
    // something concrete to draw, but for INTERSECTION that clamp would be a
    // lie — it would drop every week after this one from a cycle that has not
    // ended. So an open cycle covers everything from its start on.
    const open = cycle('c/open', '2026-07-01');
    expect(names(cyclesInWeek([open], week, NOW))).toEqual(['c/open']);
    for (const later of ['2026-08-10', '2026-09-07', '2027-02-01']) {
      expect(
        names(cyclesInWeek([open], weekCivilDays(later), NOW)),
        `an unfinished cycle still covers the week of ${later}`,
      ).toEqual(['c/open']);
    }
    // A week wholly BEFORE it began is still outside it.
    expect(cyclesInWeek([open], weekCivilDays('2026-06-01'), NOW)).toHaveLength(0);
  });

  it('does not claim a week that ends before an open cycle even starts', () => {
    // Starts a fortnight out with no end. The clamped span is inverted
    // (end=today precedes start), and matching on that inversion would have put
    // a not-yet-begun cycle in this week's header.
    expect(cyclesInWeek([cycle('c/future-open', '2026-08-20')], week, NOW)).toHaveLength(0);
    // It does claim the week it begins in, and every week after.
    expect(names(cyclesInWeek([cycle('c/future-open', '2026-08-20')], weekCivilDays('2026-08-17'), NOW)))
      .toEqual(['c/future-open']);
  });

  it('treats a cycle with only an end as that single day', () => {
    expect(names(cyclesInWeek([cycle('c/end-only', null, '2026-08-05')], week, NOW)))
      .toEqual(['c/end-only']);
    expect(cyclesInWeek([cycle('c/end-only-out', null, '2026-08-20')], week, NOW))
      .toHaveLength(0);
  });

  it('ignores cards that are not cycles, however they are dated', () => {
    const ordinary = card({ id: 'work/thing', due: '2026-08-05' });
    expect(cyclesInWeek([ordinary], week, NOW)).toHaveLength(0);
    // And a cycle flag with no dates at all names no span.
    expect(spanOfCycleCard(card({ id: 'c/dateless', isCycle: true }), NOW)).toBeNull();
  });

  it('reads a cycle`s dates as CIVIL DAYS, whatever offset they were written in', () => {
    // Authored in Paris; must not lose a day west of Greenwich.
    const paris = cycle('c/paris', '2026-08-09T00:00:00+02:00', '2026-08-21T00:00:00+02:00');
    expect(spanOfCycleCard(paris, NOW)).toEqual({
      start: '2026-08-09',
      end: '2026-08-21',
      openEnded: false,
    });
    expect(names(cyclesInWeek([paris], week, NOW))).toEqual(['c/paris']);
  });

  it('orders by start, soonest first, so the header reads oldest-commitment first', () => {
    const later = cycle('c/later', '2026-08-05', '2026-08-30');
    const earlier = cycle('c/earlier', '2026-07-01', '2026-08-30');
    expect(names(cyclesInWeek([later, earlier], week, NOW))).toEqual(['c/earlier', 'c/later']);
  });

  it('finds every overlapping cycle — the header decides how many to show', () => {
    const many = [
      cycle('c/a', '2026-07-01', '2026-08-30'),
      cycle('c/b', '2026-08-03', '2026-08-30'),
      cycle('c/c', '2026-08-05', '2026-08-30'),
      cycle('c/d', '2026-08-09', '2026-08-30'),
    ];
    // Truncation to two plus "+N" is the renderer's job, not this function's:
    // it must not decide for the header how much there was to say.
    expect(cyclesInWeek(many, week, NOW)).toHaveLength(4);
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
  });

  it('counts human messages as EVENTS, not as minutes', () => {
    // The asymmetry the week reads in: three prompts inside one minute are
    // three things the person said, even though they cost one minute of clock.
    const spend = summarizeSpend([
      { m: 0, s: 'a-shuttle', cwd: null, k: 'attention', n: 3 },
      { m: 60_000, s: 'a-shuttle', cwd: null, k: 'attention', n: 1 },
    ]);
    expect(spend.sent).toBe(4);
  });

  it('counts replies from k:"reply" buckets, which duplicate agent minutes', () => {
    // The daemon emits both kinds for one `stop` (lib/shuttle/activity.ex), so
    // the reply count must not disturb the agent time it shadows.
    const reply = (m: number, n: number): ActivityBucket =>
      ({ m, s: 'a-shuttle', cwd: null, k: 'reply' as ActivityBucket['k'], n });
    const spend = summarizeSpend([
      { m: 0, s: 'a-shuttle', cwd: null, k: 'agent', n: 5 },
      reply(0, 2),
      { m: 60_000, s: 'a-shuttle', cwd: null, k: 'agent', n: 1 },
      reply(60_000, 1),
    ]);
    expect(spend.received).toBe(3);
    expect(spend.agentMs).toBe(2 * 60_000);
    expect(spend.totalMs).toBe(2 * 60_000);
  });

  it('lets a notify bucket count as a minute but tally nothing', () => {
    // Notify still arrives on the wire. It is not a drawn state, so it earns
    // no figure of its own — but the minute it names did happen.
    const spend = summarizeSpend([
      { m: 0, s: 'a-shuttle', cwd: null, k: 'reply' as ActivityBucket['k'], n: 4 },
      { m: 60_000, s: 'a-shuttle', cwd: null, k: 'notify', n: 1 },
    ]);
    expect(spend.received).toBe(4);
    expect(spend.sent).toBe(0);
    expect(spend.totalMs).toBe(2 * 60_000);
  });

  it('reports zero replies against a daemon that does not emit the kind', () => {
    const spend = summarizeSpend([{ m: 0, s: null, cwd: null, k: 'attention', n: 2 }]);
    expect(spend.sent).toBe(2);
    expect(spend.received).toBe(0);
  });

  it('counts one minute per bucket — the wire grid is fixed, never inferred', () => {
    // `Shuttle.Activity` keys every event by div(ts, 60_000) * 60_000
    // unconditionally (lib/shuttle/activity.ex), so a bucket IS a minute.
    expect(BUCKET_MS).toBe(60_000);
    // 360 minute-buckets = 6h = the `full` threshold, exactly.
    const buckets: ActivityBucket[] = [];
    for (let i = 0; i < 360; i += 1) {
      buckets.push({ m: i * BUCKET_MS, s: null, cwd: null, k: 'agent', n: 3 });
    }
    const spend = summarizeSpend(buckets);
    expect(spend.totalMs).toBe(6 * HOUR);
    expect(dayWeight(spend.totalMs)).toBe('full');
  });

  it('does not inflate a sparse day by the distance between its buckets', () => {
    // The regression that killed the old `inferBucketMs`: four scattered
    // minutes must read as four minutes, not as four times the widest gap.
    // Under the inference these reported 28 minutes, and a slightly larger set
    // crossed the 2h `half` threshold on a genuinely quiet day.
    const at = (minutes: number): ActivityBucket =>
      ({ m: minutes * 60_000, s: null, cwd: null, k: 'agent', n: 1 });
    const spend = summarizeSpend([at(0), at(7), at(19), at(31)]);
    expect(spend.totalMs).toBe(4 * 60_000);
    expect(dayWeight(spend.totalMs)).toBe('quiet');
  });

  it('gives a notify-only minute clock time and no agent time', () => {
    const spend = summarizeSpend([
      { m: 0, s: 'a-shuttle', cwd: null, k: 'notify', n: 1 },
      { m: 0, s: 'b-shuttle', cwd: null, k: 'notify', n: 1 },
    ]);
    expect(spend.totalMs).toBe(60_000);
    expect(spend.agentMs).toBe(0);
  });
});

describe('the raster tick knows whose minute it was', () => {
  // The join itself belongs to TemporalData's own suite; here the question is
  // only what a SLOT ends up carrying, since that is what the ink and the
  // tooltip both read. Every bucket that should be DRAWN therefore names the
  // worker of a card the index carries — an unjoined bucket has no tick.
  const bucket = (over: Partial<ActivityBucket> & { m: number }): ActivityBucket =>
    ({ s: 'w-1', cwd: null, k: 'agent', n: 1, ...over });

  const noJoin = buildJoinIndex([]);
  const joined = buildJoinIndex([card({ id: 'fiber/notes', name: 'notes', runningWorker: 'w-1' })]);
  const origin = (index: ReturnType<typeof buildJoinIndex>) =>
    (b: ActivityBucket) => originOf(index, b);

  it('folds a slot per RASTER_SLOT_MS and centres its fraction in that slot', () => {
    const bounds = railBounds('2026-08-12');
    // Two minutes inside the first 4-minute slot, one inside the second.
    const slots = rasterSlots(
      [
        bucket({ m: bounds.startMs }),
        bucket({ m: bounds.startMs + 60_000 }),
        bucket({ m: bounds.startMs + 5 * 60_000 }),
      ],
      bounds,
      bounds.endMs,
      origin(joined),
    );
    expect(slots.map((s) => s.index)).toEqual([0, 1]);
    expect(slots[0].kinds[0].count).toBe(2);
    const span = bounds.endMs - bounds.startMs;
    // The MIDPOINT of the slot — the contract the CSS centring and the hover
    // snap both depend on.
    expect(slots[0].fraction).toBeCloseTo(2 * 60_000 / span, 9);
    expect(slots[0].startMs).toBe(bounds.startMs);
    expect(slots[0].endMs).toBe(bounds.startMs + 4 * 60_000);
  });

  it('drops everything after the cutoff, so today draws no ink in its future', () => {
    const bounds = railBounds('2026-08-12');
    const cut = bounds.startMs + 30 * 60_000;
    const slots = rasterSlots(
      [bucket({ m: bounds.startMs }), bucket({ m: cut + 60_000 })],
      bounds,
      cut,
      origin(joined),
    );
    expect(slots).toHaveLength(1);
    expect(slots[0].index).toBe(0);
  });

  it('marks the slot constitution-driven when the joined fiber carries a shuttle block', () => {
    const bounds = railBounds('2026-08-12');
    const index = buildJoinIndex([
      card({ id: 'fiber/ship-it', name: 'ship it', runningWorker: 'w-1', shuttleKind: 'oneshot' }),
      card({ id: 'fiber/notes', name: 'notes', runningWorker: 'w-2' }),
    ]);
    const [driven, plain] = [
      rasterSlots([bucket({ m: bounds.startMs, s: 'w-1' })], bounds, bounds.endMs, origin(index))[0],
      rasterSlots([bucket({ m: bounds.startMs, s: 'w-2' })], bounds, bounds.endMs, origin(index))[0],
    ];
    expect(driven.shuttle).toBe(true);
    expect(driven.kinds[0].where).toEqual(['ship it']);
    // A `shuttle:` block is what makes a fiber constitution-driven — a card
    // that merely has a running worker is not.
    expect(plain.shuttle).toBe(false);
    expect(plain.kinds[0].where).toEqual(['notes']);
  });

  it('draws nothing at all for work no ledger placed on a fiber', () => {
    // A rail of shuttle work. A session the ledger never paired, and a minute
    // in a directory, are both real work — but neither names a fiber, and a
    // tick labelled with a session name or a folder would put a project where
    // a fiber belongs. So the minute goes unshown rather than mislabelled.
    const bounds = railBounds('2026-08-12');
    const slots = rasterSlots(
      [
        bucket({ m: bounds.startMs, s: 'stray-session' }),
        bucket({ m: bounds.startMs, s: null, cwd: '/home/ada/dev/felt' }),
      ],
      bounds,
      bounds.endMs,
      origin(noJoin),
    );
    expect(slots).toEqual([]);
  });

  it('carries the slot’s transcripts, deduped, so a hover knows where to ask', () => {
    const bounds = railBounds('2026-08-12');
    // Two minutes of one session, one of another, all inside the same slot.
    const ledger = new Map([
      ['w-1', { fiber: 'fiber/ship-it', uid: null, session: 'sess-a', host: 'ada' }],
      ['w-2', { fiber: 'fiber/notes', uid: null, session: 'sess-b', host: 'ada' }],
    ]);
    const index = buildJoinIndex(
      [
        card({ id: 'fiber/ship-it', name: 'ship it', runningWorker: 'w-1' }),
        card({ id: 'fiber/notes', name: 'notes', runningWorker: 'w-2' }),
      ],
      ledger,
    );
    const slot = rasterSlots(
      [
        bucket({ m: bounds.startMs, s: 'w-1' }),
        bucket({ m: bounds.startMs + 60_000, s: 'w-1' }),
        bucket({ m: bounds.startMs + 60_000, s: 'w-2' }),
      ],
      bounds,
      bounds.endMs,
      origin(index),
    )[0];
    // The bucket carries no host of its own, so the ledger's stands — which is
    // still a recorded fact about where the transcript is.
    expect(slot.sources).toEqual([
      { session: 'sess-a', host: 'ada', spoke: false },
      { session: 'sess-b', host: 'ada', spoke: false },
    ]);
  });

  it('marks the transcript a spine was drawn from, so the hover asks it first', () => {
    // THE INVARIANT: a slot that draws a spine claims a human message, and the
    // slip under it must be able to show that message. The slot below is the
    // live shape that broke it — four minutes pooling three sessions, with the
    // attention minute belonging to the one that arrived LAST. The fetch cap
    // cut in arrival order, so the session that spoke was never asked and the
    // slip showed the other two's tool work under a red spine.
    const bounds = railBounds('2026-08-12');
    const ledger = new Map([
      ['w-1', { fiber: 'fiber/ship-it', uid: null, session: 'sess-a', host: 'ada' }],
      ['w-2', { fiber: 'fiber/notes', uid: null, session: 'sess-b', host: 'ada' }],
      ['w-3', { fiber: 'fiber/mirror', uid: null, session: 'sess-c', host: 'ada' }],
    ]);
    const index = buildJoinIndex(
      [
        card({ id: 'fiber/ship-it', name: 'ship it', runningWorker: 'w-1' }),
        card({ id: 'fiber/notes', name: 'notes', runningWorker: 'w-2' }),
        card({ id: 'fiber/mirror', name: 'mirror', runningWorker: 'w-3' }),
      ],
      ledger,
    );
    const slot = rasterSlots(
      [
        bucket({ m: bounds.startMs, s: 'w-1' }),
        bucket({ m: bounds.startMs, s: 'w-2' }),
        bucket({ m: bounds.startMs + 60_000, s: 'w-3' }),
        bucket({ m: bounds.startMs + 120_000, s: 'w-3', k: 'attention' }),
      ],
      bounds,
      bounds.endMs,
      origin(index),
    )[0];

    expect(slot.humanMinutes).toHaveLength(1);
    // Every spine in the slot has a transcript flagged as one that spoke.
    expect(slot.sources.filter((s) => s.spoke).map((s) => s.session)).toEqual(['sess-c']);
  });

  it('has no transcript to offer for a minute the ledger never paired', () => {
    // Joined by the live worker's name — the tick is drawn — but no pairing
    // means no session UUID, and so no transcript to ask `/moment` for.
    const bounds = railBounds('2026-08-12');
    const slot = rasterSlots(
      [bucket({ m: bounds.startMs })],
      bounds,
      bounds.endMs,
      origin(joined),
    )[0];
    expect(slot.sources).toEqual([]);
  });
});

describe('slots as the curve wants them', () => {
  // slotSamples is what WeekView hands to the density curve: one weighted
  // sample per occupied slot (human = attention, agent = everything else,
  // including reply), and spines at the exact attention minutes rasterSlots
  // recorded — never at a slot's centre and never at a reply.
  const bounds = railBounds('2026-08-12');
  const bucket = (over: Partial<ActivityBucket> & { m: number }): ActivityBucket =>
    ({ s: 'w-1', cwd: null, k: 'agent', n: 1, ...over });
  const joined = buildJoinIndex([card({ id: 'fiber/notes', name: 'notes', runningWorker: 'w-1' })]);
  const origin = (b: ActivityBucket) => originOf(joined, b);

  it('puts attention on the human side and agent+reply on the agent side', () => {
    const slots = rasterSlots(
      [
        bucket({ m: bounds.startMs, k: 'attention', n: 2 }),
        bucket({ m: bounds.startMs, k: 'agent', n: 3 }),
        bucket({ m: bounds.startMs + 60_000, k: 'reply' as ActivityBucket['k'], n: 5 }),
      ],
      bounds,
      bounds.endMs,
      origin,
    );
    const { samples } = slotSamples(slots, bounds);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ human: 2, agent: 8 });
  });

  it('spines the real attention minutes, not the slot centre and not a reply', () => {
    // The slot spans minutes 0–3; the attention bucket lands at minute 1, well
    // off the slot's centre (2). A reply in the same slot must add no spine.
    const slots = rasterSlots(
      [
        bucket({ m: bounds.startMs + 60_000, k: 'attention' }),
        bucket({ m: bounds.startMs + 2 * 60_000, k: 'reply' as ActivityBucket['k'] }),
      ],
      bounds,
      bounds.endMs,
      origin,
    );
    const { spines } = slotSamples(slots, bounds);
    expect(spines).toEqual([1]);
  });

  it('samples an empty slot list into nothing', () => {
    expect(slotSamples([], bounds)).toEqual({ samples: [], spines: [] });
  });
});

describe('what a hovered slot is willing to say', () => {
  const bounds = railBounds('2026-08-12');
  // Every bucket names `w-1`, and the default card carries that worker: only
  // joined work reaches a slot at all.
  const bucket = (over: Partial<ActivityBucket> & { m: number }): ActivityBucket =>
    ({ s: 'w-1', cwd: null, k: 'agent', n: 1, ...over });

  const slotOf = (
    buckets: ActivityBucket[],
    cards: KanbanCard[] = [card({ id: 'fiber/notes', name: 'notes', runningWorker: 'w-1' })],
  ) => rasterSlots(buckets, bounds, bounds.endMs, (b) => originOf(buildJoinIndex(cards), b))[0];

  it('reads strongest signal first: the human, then the agent under them', () => {
    const at = bounds.startMs;
    const tip = slotTip(slotOf([
      bucket({ m: at, k: 'agent', n: 4 }),
      bucket({ m: at, k: 'attention' }),
    ]));
    expect(tip.rows.map((r) => r.kind)).toEqual(['attention', 'agent']);
    expect(tip.rows.map((r) => r.phrase)).toEqual(['you', 'tool call']);
    expect(tip.rows.find((r) => r.kind === 'agent')?.count).toBe(4);
  });

  it('says nothing at all about a notify — it is not a drawn state', () => {
    const at = bounds.startMs;
    // A notify alongside real work adds no row...
    const tip = slotTip(slotOf([bucket({ m: at, k: 'agent' }), bucket({ m: at, k: 'notify' })]));
    expect(tip.rows.map((r) => r.kind)).toEqual(['agent']);
    // ...and a slot of nothing but notify is not a slot.
    expect(slotOf([bucket({ m: at, k: 'notify' })])).toBeUndefined();
  });

  it('names the slot by its own span, not by the minute that happened to seed it', () => {
    const tip = slotTip(slotOf([bucket({ m: bounds.startMs + 60_000 })]));
    // A 4-minute slot: two clock times, and they differ.
    const [from, to] = tip.time.split('–');
    expect(from).not.toBe(to);
    expect(tip.time).toContain('–');
  });

  it('carries no words until they are recovered, and no gloss about it', () => {
    const slot = slotOf([bucket({ m: bounds.startMs })]);
    // No transcript yet — and while none has come back, the card carries no
    // words and says nothing about not having them.
    expect(slotTip(slot).detail).toBeUndefined();
    expect(slotTip(slot).note).toBeUndefined();

    // What `/api/v1/moment` recovered, carried through verbatim.
    const words = {
      excerpts: [{ at_ms: bounds.startMs, role: 'user' as const, text: 'refactor the fold' }],
    };
    expect(slotTip(slot, words).detail).toEqual(words.excerpts);

    // A remote that could not be read says where the words live instead.
    expect(slotTip(slot, { excerpts: [], note: 'words live on kelvin' }).note).toBe(
      'words live on kelvin',
    );
  });

  it('carries the tool line for a slot that worked without speaking', () => {
    const slot = slotOf([bucket({ m: bounds.startMs })]);
    const tip = slotTip(slot, { excerpts: [], tools: 'Bash ×2 · Read' });
    expect(tip.tools).toBe('Bash ×2 · Read');
    // It is not speech and must never be dressed as any.
    expect(tip.detail).toBeUndefined();
  });

  it('carries the constitution flag onto the tooltip line it belongs to', () => {
    const cards = [
      card({ id: 'fiber/ship-it', name: 'ship it', runningWorker: 'w-1', shuttleKind: 'standing' }),
    ];
    const tip = slotTip(slotOf([bucket({ m: bounds.startMs, s: 'w-1' })], cards));
    expect(tip.rows[0]).toMatchObject({ where: 'ship it', shuttle: true });
  });
});

describe('a rail waits on a remote only when the whole row is that remote\u2019s', () => {
  const bucket = (over: Partial<ActivityBucket> & { m: number }): ActivityBucket =>
    ({ s: null, cwd: null, k: 'agent', n: 1, ...over });
  const origins = {
    hearth: { kind: 'local' as const, stale: false },
    ada: { kind: 'remote' as const, stale: true, lastError: 'connection refused' },
    bob: { kind: 'remote' as const, stale: false },
  };

  it('names the stale remote whose ink is the only ink on the row', () => {
    expect(rowWaitingOn([bucket({ m: 1, host: 'ada' }), bucket({ m: 2, host: 'ada' })], origins)).toBe(
      'ada',
    );
  });

  it('stays current when any of the row\u2019s ink came from an origin that is answering', () => {
    // Mixed ink includes minutes that ARE current — muting the row would claim
    // something false about them.
    expect(rowWaitingOn([bucket({ m: 1, host: 'ada' }), bucket({ m: 2, host: 'hearth' })], origins)).toBeNull();
    expect(rowWaitingOn([bucket({ m: 1, host: 'bob' })], origins)).toBeNull();
  });

  it('names every stale remote when the row is shared between them', () => {
    const both = { ...origins, bob: { kind: 'remote' as const, stale: true } };
    expect(rowWaitingOn([bucket({ m: 2, host: 'bob' }), bucket({ m: 1, host: 'ada' })], both)).toBe(
      'ada, bob',
    );
  });

  // Thin data is not an error. An empty rail is an empty rail, and a bucket
  // nobody stamped cannot be attributed to a host that is out of contact.
  it('says nothing about an empty row, or about ink that names no host', () => {
    expect(rowWaitingOn([], origins)).toBeNull();
    expect(rowWaitingOn([bucket({ m: 1 })], origins)).toBeNull();
    expect(rowWaitingOn([bucket({ m: 1, host: 'ada' })], {})).toBeNull();
  });
});
