import { describe, expect, it } from 'vitest';
import { dayIndexForDue, dueCivilDay, isoDayLocal } from './civilDay.js';
import { effectiveHorizon } from './KanbanRules.js';

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
