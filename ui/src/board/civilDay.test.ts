import { describe, expect, it } from 'vitest';
import {
  ascByKey,
  civilDayAt,
  descByKey,
  dueCivilDay,
  formatSpanMinutes,
  instantMs,
  isoDayLocal,
  sameCivilDue,
  shiftCivilDay,
  wallClock,
  zone,
} from './civilDay.js';
import { effectiveHorizon } from './KanbanRules.js';
import { buildTimelineDays, clusterStashCards, formatDue } from './KanbanSurfaces.js';
import {
  byClosedAtDesc,
  byCreatedAtDesc,
  byDueAtAsc,
} from './KanbanReadModel.js';
import type { KanbanCard } from './KanbanTypes.js';

// The named regressions. The laws they are points of — every spelling of a
// declared midnight, in every viewing zone; round trips; rails; offset-free
// instant order — are properties in civilDay.properties.test.ts. Each test
// here names its zone explicitly, so none depends on the zone `npm test` runs
// in.
const LA = zone('America/Los_Angeles');
const PARIS = zone('Europe/Paris');

describe('civil-day handling of a `due:` value', () => {
  it('reads felt’s storage of a civil day as that day west of Greenwich', () => {
    // The original bug: felt serializes `2026-07-31` as UTC midnight, which is
    // the previous evening in Los Angeles — a card due Friday rendered on
    // Thursday. New Year's Eve is where the slip also slips the year.
    expect(dueCivilDay('2026-07-31T00:00:00Z', LA)).toBe('2026-07-31');
    expect(dueCivilDay('2027-01-01T00:00:00Z', LA)).toBe('2027-01-01');
  });

  it('reads the real Paris-authored row as the day it names, not the 14th', () => {
    // ai-futures/…/pre-interview-outreach carries this: a due authored in
    // Paris comes back as `+02:00`, and the human still meant the 15th.
    expect(dueCivilDay('2026-06-15T00:00:00+02:00', LA)).toBe('2026-06-15');
  });

  it('resolves a real time-of-day by its day in the viewing zone, not verbatim', () => {
    // 22:00Z on the 30th carries a real time-of-day, so it belongs to whichever
    // day it lands on: Jul 30 15:00 in LA, Jul 31 00:00 in Paris (UTC+2 in
    // July). 00:30+02:00 is that same instant — not midnight, so the
    // offset-midnight rule must not swallow it.
    for (const stamp of ['2026-07-30T22:00:00Z', '2026-07-31T00:30:00+02:00']) {
      expect(dueCivilDay(stamp, LA)).toBe('2026-07-30');
      expect(dueCivilDay(stamp, PARIS)).toBe('2026-07-31');
    }
  });

  it('is undefined for absent, unparseable or impossible values', () => {
    expect(dueCivilDay(undefined)).toBeUndefined();
    expect(dueCivilDay('')).toBeUndefined();
    expect(dueCivilDay('   ')).toBeUndefined();
    expect(dueCivilDay('not a date')).toBeUndefined();
    expect(dueCivilDay(20260730)).toBeUndefined();
    // Date.parse would normalize February 30 to March 2.
    expect(dueCivilDay('2026-02-30')).toBeUndefined();
    expect(dueCivilDay('2026-02-30T00:00:00Z')).toBeUndefined();
    expect(instantMs('2026-02-30T12:00:00Z')).toBeUndefined();
  });
});

describe('duePromotesToNow at the day boundary', () => {
  // Noon on 2026-07-30 in the host zone — well away from any midnight, so
  // "today" is unambiguously Jul 30 wherever this runs.
  const now = civilDayAt('2026-07-30', 12)!;
  const horizon = (due: string) => effectiveHorizon({ due }, now).effectiveHorizon;

  it('promotes a card due today, in either spelling', () => {
    expect(horizon('2026-07-30')).toBe('now');
    expect(horizon('2026-07-30T00:00:00Z')).toBe('now');
  });

  it('promotes a card due yesterday', () => {
    expect(horizon('2026-07-29')).toBe('now');
    expect(horizon('2026-07-29T00:00:00Z')).toBe('now');
  });

  it('does NOT wake a snoozed card due tomorrow, in either spelling', () => {
    // The bug: `2026-07-31T00:00:00Z` read as an instant is Jul 30 17:00 in LA,
    // so the card was yanked onto the Now desk a day early. Read through a
    // SNOOZE, because that is the only state a future due still moves: a bare
    // future `due:` leaves the card on the desk either way.
    const snoozed = (due: string) =>
      effectiveHorizon({ horizon: 'stashed', due }, now).effectiveHorizon;
    expect(snoozed('2026-07-31')).toBe('stashed');
    expect(snoozed('2026-07-31T00:00:00Z')).toBe('stashed');
  });
});

describe('one value, one day: the chip, the column and the drop guard agree', () => {
  it('says July 30 on the chip for every spelling the column files under July 30', () => {
    // The bug this pins: the card was PLACED on the Jul 30 column while its
    // own chip read Jul 29 — one card, one render pass, two days.
    const label = formatDue('2026-07-30');
    expect(label).toMatch(/30/);
    for (const value of [
      '2026-07-30T00:00:00Z',
      '2026-07-30T00:00:00.000Z',
      '2026-07-30T00:00:00+02:00',
      '2026-07-30T00:00:00-07:00',
    ]) {
      expect(formatDue(value)).toBe(label);
      expect(sameCivilDue(value, '2026-07-30', LA)).toBe(true);
    }
  });

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
  // Nov 1. A fixed 86_400_000 ms stride over instants drifts an hour at the
  // transition and then repeats a civil day while skipping another — and a
  // skipped column is a card that VANISHES, because its due day finds nothing
  // to land on. The strip strides civil days, so no zone enters it.
  const days = buildTimelineDays(30, 30, '2026-10-15');

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
    // Oct 18 2026 is a Sunday: the weekend and the week boundary.
    const sunday = days.find((d) => d.iso === '2026-10-18')!;
    expect([sunday.isWeekend, sunday.weekBoundary, sunday.label]).toEqual([true, true, '18']);
  });
});

describe('civilDayAt', () => {
  it('materializes a civil day as the zone’s midnight, never UTC midnight', () => {
    expect(civilDayAt('2026-07-30', 0, LA)).toBe(Date.parse('2026-07-30T07:00:00Z'));
    expect(civilDayAt('2026-07-30', 12, PARIS)).toBe(Date.parse('2026-07-30T10:00:00Z'));
  });

  it('starts a spring-forward day whose midnight does not exist at its first instant', () => {
    // Santiago moves 00:00 → 01:00 on 2026-09-06.
    expect(civilDayAt('2026-09-06', 0, zone('America/Santiago'))).toBe(Date.parse('2026-09-06T04:00:00Z'));
  });

  it('is undefined for anything that is not a bare civil day', () => {
    expect(civilDayAt(undefined)).toBeUndefined();
    expect(civilDayAt('2026-07-30T00:00:00Z')).toBeUndefined();
    expect(civilDayAt('2026-02-30')).toBeUndefined();
  });
});

describe('the offset cache at a transition inside a quarter hour', () => {
  // Liberia moved from UTC−0:44:30 to UTC at 1972-01-07T00:44:30Z — mid-way
  // through a quarter hour of UTC. Checked against Intl directly, to the second.
  const monrovia = zone('Africa/Monrovia');
  const intl = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Monrovia', hourCycle: 'h23',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  it('reads each side of the jump with its own offset', () => {
    for (const iso of ['1972-01-07T00:44:29Z', '1972-01-07T00:44:30Z', '1972-01-07T00:30:00Z', '1972-01-07T00:59:59Z']) {
      const ms = Date.parse(iso);
      const { hour, minute, second } = wallClock(ms, monrovia);
      const said = [hour, minute, second].map((n) => String(n).padStart(2, '0')).join(':');
      expect(said, iso).toBe(intl.format(ms));
    }
  });
});

describe('years Date.UTC would remap', () => {
  it('keeps years 0–99 as themselves', () => {
    const utc = zone('UTC');
    expect(isoDayLocal(Date.parse('0001-01-01T00:00:00Z'), utc)).toBe('0001-01-01');
    expect(civilDayAt('0050-06-01', 0, utc)).toBe(Date.parse('0050-06-01T00:00:00Z'));
    expect(shiftCivilDay('0099-12-31', 1)).toBe('0100-01-01');
  });
});

describe('formatSpanMinutes', () => {
  // The bare form — no `pad`, no `empty` — is what the fiber controls' session
  // summary renders. The padded and em-dash variants the views use are
  // pinned in chronicleJoin.test.ts.
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
  // placeholder — the fiber controls clamp at their call site instead.
  it('does not hide a negative span when no empty placeholder is given', () => {
    expect(formatSpanMinutes(-5)).toBe('-5m');
  });
});
