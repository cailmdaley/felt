import { describe, expect, it } from 'vitest';
import {
  ascByKey,
  civilDayToLocalDate,
  dayIndexForDue,
  descByKey,
  dueCivilDay,
  formatSpanMinutes,
  instantMs,
  isoDayLocal,
  sameCivilDue,
} from './civilDay.js';
import { effectiveHorizon } from './KanbanRules.js';
import { buildTimelineDays, clusterStashCards, formatDue } from './KanbanSurfaces.js';
import {
  byClosedAtDesc,
  byCreatedAtDesc,
  byDueAtAsc,
  byRecentActivityThenName,
} from './KanbanReadModel.js';
import type { KanbanCard } from './KanbanTypes.js';

// The timezone is the experiment. `npm test` runs this file twice — once under
// TZ=America/Los_Angeles (negative offset, where the original bug bit) and once
// under TZ=Europe/Paris (positive offset) — because a UTC-only run passes
// against the broken code. Fail loudly rather than pass vacuously if neither
// zone is pinned.
// The zone actually in effect for `Date` — set by the `TZ=` prefix in the
// `npm test` script, read back here rather than trusted from the env.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
// Where `2026-07-30T22:00:00Z` actually falls, per zone.
const LOCAL_DAY_OF_22Z = TZ === 'America/Los_Angeles' ? '2026-07-30' : '2026-07-31';

describe('civil-day handling of a `due:` value', () => {
  it('runs under a pinned, non-UTC timezone', () => {
    expect(TZ, 'run via `npm test` — the zone is what this suite tests').toMatch(
      /^(America\/Los_Angeles|Europe\/Paris)$/,
    );
    expect(new Date('2026-07-30T00:00:00Z').getTimezoneOffset()).not.toBe(0);
  });

  // [value, expected civil day]
  const cases: Array<[string, string]> = [
    // A bare civil day, as authored.
    ['2026-07-30', '2026-07-30'],
    // felt's storage of that same civil day (UTC midnight) and its variants.
    ['2026-07-30T00:00:00Z', '2026-07-30'],
    ['2026-07-30T00:00:00.000Z', '2026-07-30'],
    ['2026-07-30T00:00:00+00:00', '2026-07-30'],
    // New Year's Eve — the case where a one-day slip also slips the year.
    ['2027-01-01T00:00:00Z', '2027-01-01'],
  ];

  for (const [value, expected] of cases) {
    it(`reads ${value} as the civil day ${expected}`, () => {
      expect(dueCivilDay(value)).toBe(expected);
    });
  }

  it('resolves a real timestamp by local day, not verbatim', () => {
    // 2026-07-30 22:00 UTC carries a real time-of-day, so it belongs to
    // whichever local day it lands on: Jul 30 15:00 in LA, Jul 31 00:00 in
    // Paris (UTC+2 in July). Verbatim would be wrong in both.
    const stamp = '2026-07-30T22:00:00Z';
    expect(dueCivilDay(stamp)).toBe(isoDayLocal(Date.parse(stamp)));
    expect(dueCivilDay(stamp)).toBe(LOCAL_DAY_OF_22Z);
  });

  it('is undefined for absent or unparseable values', () => {
    expect(dueCivilDay(undefined)).toBeUndefined();
    expect(dueCivilDay('')).toBeUndefined();
    expect(dueCivilDay('   ')).toBeUndefined();
    expect(dueCivilDay('not a date')).toBeUndefined();
    expect(dueCivilDay(20260730)).toBeUndefined();
  });
});

describe('dayIndexForDue', () => {
  // A three-day window, keyed by local civil days exactly as buildTimelineDays
  // keys the timeline strip.
  const dayIndex = new Map<string, number>([
    ['2026-07-29', 0],
    ['2026-07-30', 1],
    ['2026-07-31', 2],
  ]);

  it('places both spellings of a civil day on that day’s column', () => {
    expect(dayIndexForDue('2026-07-30', dayIndex)).toBe(1);
    expect(dayIndexForDue('2026-07-30T00:00:00Z', dayIndex)).toBe(1);
    expect(dayIndexForDue('2026-07-30T00:00:00.000Z', dayIndex)).toBe(1);
  });

  it('places a real timestamp by its local day', () => {
    expect(dayIndexForDue('2026-07-30T22:00:00Z', dayIndex)).toBe(
      dayIndex.get(LOCAL_DAY_OF_22Z),
    );
  });

  it('is null for no value and for a day outside the window', () => {
    expect(dayIndexForDue(undefined, dayIndex)).toBeNull();
    expect(dayIndexForDue('2026-08-15', dayIndex)).toBeNull();
  });
});

describe('duePromotesToNow at the day boundary', () => {
  // Local noon on 2026-07-30 — well away from any midnight, so "today" is
  // unambiguously Jul 30 in both zones.
  const now = new Date(2026, 6, 30, 12, 0, 0).getTime();
  const horizon = (due: string) => effectiveHorizon({ due }, now).effectiveHorizon;

  it('promotes a card due today, in either spelling', () => {
    expect(horizon('2026-07-30')).toBe('now');
    expect(horizon('2026-07-30T00:00:00Z')).toBe('now');
  });

  it('promotes a card due yesterday', () => {
    expect(horizon('2026-07-29')).toBe('now');
    expect(horizon('2026-07-29T00:00:00Z')).toBe('now');
  });

  it('leaves a card due tomorrow on the timeline', () => {
    // The bug: `2026-07-31T00:00:00Z` read as an instant is Jul 30 17:00 in LA,
    // so the card was yanked onto the Now desk a day early.
    expect(horizon('2026-07-31')).toBe('soon');
    expect(horizon('2026-07-31T00:00:00Z')).toBe('soon');
  });
});

describe('a civil day stored with a non-UTC offset', () => {
  // The rule is about KIND, not encoding: exactly midnight in the offset the
  // value itself declares is a civil day, whatever that offset is. felt writes
  // a `due:` in the offset of the machine that touched it, so a due authored in
  // Paris comes back as `+02:00` — and the human still meant that date.
  // [value, expected civil day]
  const cases: Array<[string, string]> = [
    // The real row: ai-futures/…/pre-interview-outreach carries this.
    ['2026-06-15T00:00:00+02:00', '2026-06-15'],
    // Same date written from Berkeley, and from Tokyo. Neither is the 14th or
    // the 16th; all three name the 15th.
    ['2026-06-15T00:00:00-07:00', '2026-06-15'],
    ['2026-06-15T00:00:00+09:00', '2026-06-15'],
    // Half-hour and no-colon offsets are still RFC3339-ish in the wild.
    ['2026-06-15T00:00:00+05:30', '2026-06-15'],
    ['2026-06-15T00:00:00+0200', '2026-06-15'],
    ['2026-06-15T00:00:00.000+02:00', '2026-06-15'],
  ];

  for (const [value, expected] of cases) {
    it(`reads ${value} as the civil day ${expected}`, () => {
      expect(dueCivilDay(value)).toBe(expected);
    });
  }

  it('still resolves an offset value with a REAL time-of-day by local day', () => {
    // 00:30 is not midnight, so this one is a genuine instant: 22:30Z on the
    // 30th → Jul 30 in LA, Jul 31 in Paris. Verbatim ("Jul 31") would be wrong
    // in LA; the offset-midnight rule must not swallow it.
    const stamp = '2026-07-31T00:30:00+02:00';
    expect(dueCivilDay(stamp)).toBe(isoDayLocal(Date.parse(stamp)));
    expect(dueCivilDay(stamp)).toBe(LOCAL_DAY_OF_22Z);
  });
});

describe('one value, one day: the chip, the column and the drop guard agree', () => {
  // Every spelling of "the 30th of July 2026" the board can meet.
  const spellings = [
    '2026-07-30',
    '2026-07-30T00:00:00Z',
    '2026-07-30T00:00:00.000Z',
    '2026-07-30T00:00:00+02:00',
    '2026-07-30T00:00:00-07:00',
  ];
  const dayIndex = new Map<string, number>([
    ['2026-07-29', 0],
    ['2026-07-30', 1],
    ['2026-07-31', 2],
  ]);
  // Built from local date parts, independently of anything under test — the
  // label a human in this zone would read for July 30.
  const JUL_30_LABEL = new Date(2026, 6, 30).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });

  for (const value of spellings) {
    it(`${value}: chip, column and guard all say July 30`, () => {
      // The bug this pins: the card was PLACED on the Jul 30 column while its
      // own chip read Jul 29 — one card, one render pass, two days.
      expect(formatDue(value)).toBe(JUL_30_LABEL);
      expect(dayIndexForDue(value, dayIndex)).toBe(1);
      expect(sameCivilDue(value, '2026-07-30')).toBe(true);
      expect(sameCivilDue(value, '2026-07-31')).toBe(false);
    });
  }

  it('leaves an unparseable due visible rather than blank', () => {
    expect(formatDue('not a date')).toBe('not a date');
  });

  it('treats a cleared due as a change unless the card had none', () => {
    expect(sameCivilDue(undefined, null)).toBe(true);
    expect(sameCivilDue('2026-07-30T00:00:00Z', null)).toBe(false);
    expect(sameCivilDue(undefined, '2026-07-30')).toBe(false);
  });
});

describe('instants sort by instant, not by wall clock', () => {
  // The same moment, written from Berkeley and from Paris.
  const berkeley = '2026-07-27T09:00:00-07:00';
  const paris = '2026-07-27T18:00:00+02:00';
  // A moment three hours EARLIER, written from Paris.
  const parisEarlier = '2026-07-27T15:00:00+02:00';

  it('reads two spellings of one instant as one number', () => {
    expect(instantMs(berkeley)).toBe(instantMs(paris));
    expect(instantMs(berkeley)).toBe(Date.parse('2026-07-27T16:00:00Z'));
    // Whereas as strings they are emphatically not equal, and in the wrong
    // order: "09:00…" sorts below "18:00…".
    expect(berkeley.localeCompare(paris)).toBeLessThan(0);
  });

  it('is undefined for absent or unparseable instants', () => {
    expect(instantMs(undefined)).toBeUndefined();
    expect(instantMs('')).toBeUndefined();
    expect(instantMs('not a date')).toBeUndefined();
  });

  it('puts the newer Berkeley instant above the older Paris one', () => {
    const desc = [parisEarlier, berkeley].sort((a, b) =>
      descByKey(instantMs(a), instantMs(b)),
    );
    // A string compare would sort "09:00-07:00" below "15:00+02:00" and sink
    // every Berkeley-created fiber under older Paris work.
    expect(desc[0]).toBe(berkeley);
    const asc = [berkeley, parisEarlier].sort((a, b) => ascByKey(instantMs(a), instantMs(b)));
    expect(asc[0]).toBe(parisEarlier);
  });

  it('sorts a missing timestamp last, in both directions', () => {
    expect(descByKey(instantMs(berkeley), undefined)).toBeLessThan(0);
    expect(descByKey(undefined, instantMs(berkeley))).toBeGreaterThan(0);
    expect(ascByKey(instantMs(berkeley), undefined)).toBeLessThan(0);
    expect(ascByKey(undefined, instantMs(berkeley))).toBeGreaterThan(0);
  });
});

describe('the board comparators, over cards from two continents', () => {
  const berkeley = '2026-07-27T09:00:00-07:00'; // 16:00Z — the newer one
  const paris = '2026-07-27T15:00:00+02:00'; // 13:00Z — three hours older
  const card = (over: Partial<KanbanCard> & { id: string }): KanbanCard =>
    ({ name: over.id, ...over }) as KanbanCard;

  const bk = card({ id: 'bk', createdAt: berkeley, modifiedAt: berkeley, closedAt: berkeley });
  const pa = card({ id: 'pa', createdAt: paris, modifiedAt: paris, closedAt: paris });

  it('byCreatedAtDesc puts the newer instant first', () => {
    expect([pa, bk].sort(byCreatedAtDesc).map((c) => c.id)).toEqual(['bk', 'pa']);
  });

  it('byRecentActivityThenName puts the newer instant first', () => {
    expect([pa, bk].sort(byRecentActivityThenName).map((c) => c.id)).toEqual(['bk', 'pa']);
  });

  it('byClosedAtDesc puts the newer instant first', () => {
    expect([pa, bk].sort(byClosedAtDesc).map((c) => c.id)).toEqual(['bk', 'pa']);
  });

  it('byDueAtAsc puts the sooner launch first, across offsets', () => {
    const soon = card({ id: 'soon', nextLaunchAt: paris });
    const later = card({ id: 'later', nextLaunchAt: berkeley });
    expect([later, soon].sort(byDueAtAsc).map((c) => c.id)).toEqual(['soon', 'later']);
  });

  it('byDueAtAsc orders a `due:` by the civil day it names', () => {
    const d29 = card({ id: 'd29', due: '2026-07-29T00:00:00+02:00' });
    const d30 = card({ id: 'd30', due: '2026-07-30' });
    const none = card({ id: 'none' });
    expect([none, d30, d29].sort(byDueAtAsc).map((c) => c.id)).toEqual(['d29', 'd30', 'none']);
  });

  it('clusterStashCards orders each cluster by instant', () => {
    const clusters = clusterStashCards([
      card({ id: 'felt/a', createdAt: paris }),
      card({ id: 'felt/b', createdAt: berkeley }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].cards.map((c) => c.id)).toEqual(['felt/b', 'felt/a']);
  });
});

describe('the timeline strip across a DST transition', () => {
  // Autumn 2026: Europe/Paris falls back on Oct 25, America/Los_Angeles on
  // Nov 1. A fixed 86_400_000 ms stride drifts an hour at the transition and
  // then repeats a civil day while skipping another — and a skipped column is
  // a card that VANISHES, because its due day finds nothing to land on.
  const anchor = new Date(2026, 9, 15, 12, 0, 0); // Oct 15 2026, local noon
  const days = buildTimelineDays(30, 30, anchor);

  /** The expected civil days, generated in UTC where no DST exists. */
  const expected = (() => {
    const out: string[] = [];
    let t = Date.UTC(2026, 8, 15); // Sep 15 — 30 days before Oct 15
    for (let i = 0; i <= 60; i += 1) {
      out.push(new Date(t).toISOString().slice(0, 10));
      t += 86_400_000;
    }
    return out;
  })();

  it('spans one column per calendar day, none missing, none repeated', () => {
    expect(days.map((d) => d.iso)).toEqual(expected);
    expect(new Set(days.map((d) => d.iso)).size).toBe(days.length);
  });

  it('keeps today on the today column and the past/future split honest', () => {
    expect(days[30].iso).toBe('2026-10-15');
    expect(days[30].isToday).toBe(true);
    expect(days.filter((d) => d.isPast)).toHaveLength(30);
  });

  it('lands a due date on the far side of the transition on its own column', () => {
    const dayIndex = new Map(days.map((d, i) => [d.iso, i]));
    // Nov 3 — past both transitions. With the ms stride this column had drifted
    // off the strip entirely in one zone or the other.
    expect(dayIndexForDue('2026-11-03T00:00:00+01:00', dayIndex)).toBe(
      dayIndex.get('2026-11-03'),
    );
    expect(dayIndexForDue('2026-11-03', dayIndex)).not.toBeNull();
  });
});

describe('civilDayToLocalDate', () => {
  it('materializes a civil day as local midnight, never UTC midnight', () => {
    const d = civilDayToLocalDate('2026-07-30');
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(6);
    expect(d?.getDate()).toBe(30);
    expect(d?.getHours()).toBe(0);
  });

  it('is undefined for anything that is not a bare civil day', () => {
    expect(civilDayToLocalDate(undefined)).toBeUndefined();
    expect(civilDayToLocalDate('2026-07-30T00:00:00Z')).toBeUndefined();
  });
});

describe('formatSpanMinutes', () => {
  // The bare form — no `pad`, no `empty` — is what the fiber detail panel's
  // session window renders. The padded and em-dash variants the views use are
  // pinned in dayShape.test.ts and chronicleJoin.test.ts.
  it('renders a whole hour with an unpadded zero, not a bare hour', () => {
    expect(formatSpanMinutes(120)).toBe('2h 0m');
    expect(formatSpanMinutes(216)).toBe('3h 36m');
  });

  it('renders a sub-hour span as minutes alone, and zero as 0m', () => {
    expect(formatSpanMinutes(47)).toBe('47m');
    expect(formatSpanMinutes(0)).toBe('0m');
  });

  // Without `empty` a negative span shows as itself. It means the caller handed
  // over an inverted pair, which is worth seeing rather than hiding behind a
  // placeholder — the detail panel clamps at its own call site instead.
  it('does not hide a negative span when no empty placeholder is given', () => {
    expect(formatSpanMinutes(-5)).toBe('-5m');
  });
});
