/**
 * chronicleWindow — the two properties continuous scroll lives or dies by.
 *
 * Chunk boundaries are real local 6am instants, so every call that meets a
 * day names its zone: America/Los_Angeles, where a UTC literal noon falls at
 * 05:00 — the far side of the 6am rail boundary — and a DST zone, so the
 * 23- and 25-hour chunks are real. Every clock is built on that zone's wall
 * clock (see `atLocal`), never as a UTC literal.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  activityChunks,
  CHUNK_DAYS,
  chunkBounds,
  chunkIndexOf,
  daysBetween,
  EDGE_TRIGGER_DAYS,
  FUTURE_BLOCK_DAYS,
  LIVE_QUANTUM_MS,
  MAX_FUTURE_DAYS,
  MAX_PAST_DAYS,
  PAST_BLOCK_DAYS,
  planExtension,
  windowLimits,
  windowOf,
  type ScrollProbe,
} from './chronicleWindow.js';
import { civilDayAt, RAIL_START_HOUR, shiftCivilDay, wallClock, zone } from '../civilDay.js';

const LA = zone('America/Los_Angeles');

/** An instant at a wall-clock time on a civil day in Los Angeles — never a UTC
 *  literal, and noon by default so it is unambiguously past the 6am rail
 *  boundary. */
function atLocal(day: string, hour = 12, minute = 0): number {
  const ms = civilDayAt(day, hour, LA);
  if (ms === undefined) throw new Error(`not a civil day: ${day}`);
  return ms + minute * 60_000;
}

const NOW = atLocal('2026-08-05');
/** A scroller parked in the middle of a comfortable window. */
const settled: ScrollProbe = {
  scrollLeft: 900,
  clientWidth: 1000,
  scrollWidth: 4000,
  dayWidthPx: 24,
};

describe('civil-day arithmetic', () => {
  it('counts whole days between civil days, signed', () => {
    expect(daysBetween('2026-08-03', '2026-08-10')).toBe(7);
    expect(daysBetween('2026-08-10', '2026-08-03')).toBe(-7);
    expect(daysBetween('2026-08-03', '2026-08-03')).toBe(0);
  });

  it('counts correctly across a month, a year and a DST transition', () => {
    expect(daysBetween('2026-07-27', '2026-08-03')).toBe(7);
    expect(daysBetween('2026-12-28', '2027-01-04')).toBe(7);
    // US and European clocks move inside these spans; a civil-day difference
    // must not notice.
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31);
    expect(daysBetween('2026-10-01', '2026-11-01')).toBe(31);
  });

  it('strides by calendar day, not by 86_400_000', () => {
    for (const day of ['2026-03-07', '2026-03-28', '2026-10-24', '2026-10-31']) {
      // Round-tripping a DST-straddling stride must land back where it started.
      expect(shiftCivilDay(shiftCivilDay(day, 1), -1)).toBe(day);
      expect(daysBetween(day, shiftCivilDay(day, 1))).toBe(1);
    }
  });

  it('builds an inclusive window', () => {
    expect(windowOf('2026-08-03', '2026-08-09')).toEqual({
      first: '2026-08-03',
      last: '2026-08-09',
      length: 7,
    });
    expect(windowOf('2026-08-03', '2026-08-03').length).toBe(1);
  });
});

describe('extension only near an edge', () => {
  const win = windowOf('2026-06-01', '2026-08-20');

  // Scroll positions a day-width either side of each trigger line, at either
  // edge, in the middle, or with an unmeasured column; a viewport sometimes
  // wide enough to touch both edges at once.
  const nearOrFar = (trigger: number) => fc.oneof(
    fc.integer({ min: -1, max: 1 }).map((d) => trigger + d),
    fc.integer({ min: 0, max: 3000 }),
  );
  const probes = fc.record({
    dayWidthPx: fc.oneof(fc.constant(0), fc.integer({ min: 8, max: 64 })),
    clientWidth: fc.integer({ min: 200, max: 1600 }),
    slack: fc.integer({ min: 0, max: 3000 }),
  }).chain(({ dayWidthPx, clientWidth, slack }) => {
    const trigger = EDGE_TRIGGER_DAYS * dayWidthPx;
    return fc.oneof(nearOrFar(trigger), nearOrFar(trigger).map((d) => slack - d))
      .map((left) => Math.max(0, Math.min(slack, left)))
      .map((scrollLeft): ScrollProbe => ({ scrollLeft, clientWidth, scrollWidth: clientWidth + slack, dayWidthPx }));
  });

  // Within EDGE_TRIGGER_DAYS day-widths of the left edge the window grows a
  // past block; otherwise, within it of the right edge, a smaller future
  // block; touching both, the past wins; anywhere else, or before the column
  // is measured, nothing. A window well inside both caps grows by a whole block.
  it('grows the side the scroller is near, by that side\'s block', () => {
    expect(FUTURE_BLOCK_DAYS).toBeLessThan(PAST_BLOCK_DAYS);
    fc.assert(fc.property(probes, (probe) => {
      const trigger = EDGE_TRIGGER_DAYS * probe.dayWidthPx;
      const nearPast = probe.scrollLeft <= trigger;
      const nearFuture = probe.scrollWidth - probe.scrollLeft - probe.clientWidth <= trigger;
      const side = probe.dayWidthPx <= 0 ? null : nearPast ? 'past' : nearFuture ? 'future' : null;
      const plan = planExtension(win, probe, NOW, LA);
      const added = side === 'past' ? PAST_BLOCK_DAYS : FUTURE_BLOCK_DAYS;
      expect(plan).toEqual(side === null ? null : side === 'past'
        ? { side, added, next: windowOf(shiftCivilDay(win.first, -added), win.last), scrollDelta: added * probe.dayWidthPx }
        : { side, added, next: windowOf(win.first, shiftCivilDay(win.last, added)), scrollDelta: 0 });
    }), { numRuns: 200, seed: 0xed6e });
  });
});

describe('the no-jump property', () => {
  it('compensates scrollLeft by exactly the width of what was inserted', () => {
    // The whole feature in one assertion: content displaced right by
    // `added × dayWidthPx` must be met by the same increase in scrollLeft, or
    // the timeline lurches under the cursor.
    for (const dayWidthPx of [16, 24, 37, 56]) {
      const probe = { ...settled, scrollLeft: 10, dayWidthPx };
      const plan = planExtension(windowOf('2026-06-01', '2026-08-20'), probe, NOW, LA);
      expect(plan?.scrollDelta).toBe((plan?.added ?? 0) * dayWidthPx);
      // And the day under the left edge is unchanged afterwards.
      const before = Math.round(probe.scrollLeft / dayWidthPx);
      const after = Math.round((probe.scrollLeft + (plan?.scrollDelta ?? 0)) / dayWidthPx);
      expect(shiftCivilDay(plan!.next.first, after)).toBe(shiftCivilDay('2026-06-01', before));
    }
  });

  it('needs no compensation when appending — nothing on screen moves', () => {
    const probe = {
      ...settled,
      scrollLeft: settled.scrollWidth - settled.clientWidth,
    };
    const plan = planExtension(windowOf('2026-06-01', '2026-08-20'), probe, NOW, LA);
    expect(plan?.side).toBe('future');
    expect(plan?.scrollDelta).toBe(0);
  });
});

describe('the caps', () => {
  it('reaches a year back and eight weeks forward, and no further', () => {
    const { earliest, latest } = windowLimits(NOW, LA);
    expect(daysBetween(earliest, '2026-08-05')).toBe(MAX_PAST_DAYS);
    expect(daysBetween('2026-08-05', latest)).toBe(MAX_FUTURE_DAYS);
  });

  it('adds a partial block rather than overshooting the past cap', () => {
    const { earliest } = windowLimits(NOW, LA);
    // Ten days short of the cap: the block must shrink to ten, not add 28.
    const win = windowOf(shiftCivilDay(earliest, 10), '2026-08-20');
    const plan = planExtension(win, { ...settled, scrollLeft: 0 }, NOW, LA);
    expect(plan?.added).toBe(10);
    expect(plan?.next.first).toBe(earliest);
    // And the compensation still matches what was actually inserted.
    expect(plan?.scrollDelta).toBe(10 * settled.dayWidthPx);
  });

  it('stops entirely at the cap instead of returning an empty plan', () => {
    const { earliest, latest } = windowLimits(NOW, LA);
    expect(planExtension(windowOf(earliest, '2026-08-20'), { ...settled, scrollLeft: 0 }, NOW, LA))
      .toBeNull();
    const atRight = windowOf('2026-06-01', latest);
    const probe = { ...settled, scrollLeft: settled.scrollWidth - settled.clientWidth };
    expect(planExtension(atRight, probe, NOW, LA)).toBeNull();
  });

  it('measures the caps from the RAIL day, so 2am does not move them', () => {
    // 02:00 on the 5th still belongs to the 4th's rail.
    const small = windowLimits(atLocal('2026-08-05', 2), LA);
    const midday = windowLimits(atLocal('2026-08-04'), LA);
    expect(small).toEqual(midday);
  });
});

describe('activity chunks', () => {
  // Zones that move their clocks both ways round (north and south), one that
  // never does, and a half-hour offset; windows anywhere in 2025–2026 up to
  // five months long, read at any minute from just before the window to well
  // after it, then again later and over a window grown leftward.
  const zones = ['America/Los_Angeles', 'Australia/Sydney', 'Europe/Paris', 'UTC', 'Asia/Kolkata'].map(zone)
  const reading = fc.record({
    z: fc.constantFrom(...zones),
    startDay: fc.integer({ min: 0, max: 700 }),
    length: fc.integer({ min: 1, max: 150 }),
    nowDay: fc.integer({ min: -10, max: 200 }),
    nowMinute: fc.integer({ min: 0, max: 1439 }),
    laterMinutes: fc.integer({ min: 0, max: 60 * 24 * 60 }),
    grownDays: fc.integer({ min: 0, max: 60 }),
  })

  it('tiles a fixed grid of 6am-to-6am civil-day chunks whose settled keys never move', () => {
    fc.assert(fc.property(reading, ({ z, startDay, length, nowDay, nowMinute, laterMinutes, grownDays }) => {
      const first = shiftCivilDay('2025-01-01', startDay);
      const win = windowOf(first, shiftCivilDay(first, length - 1));
      const now = civilDayAt(shiftCivilDay(first, nowDay), 0, z)! + nowMinute * 60_000;
      const chunks = activityChunks(win, now, z);
      // The chunk that opens the request holds the window's first day.
      const home = chunkBounds(chunkIndexOf(win.first));
      expect(daysBetween(home.first, win.first)).toBeGreaterThanOrEqual(0);
      expect(daysBetween(win.first, home.last)).toBeGreaterThanOrEqual(0);
      if (chunks.length > 0) expect(chunks[0].first).toBe(home.first);
      chunks.forEach((chunk, i) => {
        // On the grid: 28 civil days from a multiple of 28 days after the epoch.
        expect(daysBetween('1970-01-01', chunk.first) % CHUNK_DAYS, chunk.key).toBe(0);
        expect(daysBetween(chunk.first, chunk.last), chunk.key).toBe(CHUNK_DAYS - 1);
        expect(chunkBounds(chunkIndexOf(chunk.first)), chunk.key).toEqual({ first: chunk.first, last: chunk.last });
        // Opened and closed at real 6am instants, so a chunk spanning a DST
        // transition is however many whole hours that actually takes.
        expect(wallClock(chunk.fromMs, z).hour, chunk.key).toBe(RAIL_START_HOUR);
        if (!chunk.live) {
          expect(wallClock(chunk.toMs, z).hour, chunk.key).toBe(RAIL_START_HOUR);
          const hours = (chunk.toMs - chunk.fromMs) / 3_600_000;
          expect(Number.isInteger(hours), chunk.key).toBe(true);
          expect(Math.abs(hours - CHUNK_DAYS * 24), chunk.key).toBeLessThanOrEqual(1);
        }
        if (i > 0) {
          expect(chunk.first).toBe(shiftCivilDay(chunks[i - 1].last, 1));
          expect(chunk.fromMs).toBe(chunks[i - 1].toMs);
        }
      });
      // A settled chunk is the same request, under the same key, from any
      // later clock and any window grown to include it.
      const grown = activityChunks(windowOf(shiftCivilDay(win.first, -grownDays), win.last), now + laterMinutes * 60_000, z);
      for (const chunk of chunks.filter((c) => !c.live)) {
        expect(grown.find((g) => g.key === chunk.key), chunk.key).toEqual(chunk);
      }
      // At the same clock, a window grown leftward holds every chunk it already
      // held, the live one included, unchanged.
      const grownNow = activityChunks(windowOf(shiftCivilDay(win.first, -grownDays), win.last), now, z);
      for (const chunk of chunks) {
        expect(grownNow.find((g) => g.key === chunk.key), chunk.key).toEqual(chunk);
      }
    }), { numRuns: 200, seed: 0x6a3c4d });
  });

  it('starts chunk zero on the epoch day', () => {
    expect(chunkIndexOf('1970-01-01')).toBe(0);
    expect(chunkBounds(chunkIndexOf('1970-01-01'))).toEqual({ first: '1970-01-01', last: '1970-01-28' });
  });

  it('caps the live chunk at now and leaves the settled ones whole', () => {
    const chunks = activityChunks(windowOf('2026-05-01', '2026-09-20'), NOW, LA);
    const live = chunks.filter((c) => c.live);
    expect(live).toHaveLength(1);
    expect(live[0].toMs).toBeGreaterThanOrEqual(NOW);
    expect(live[0].toMs % LIVE_QUANTUM_MS).toBe(0);
    expect(live[0].toMs).toBeLessThan(NOW + LIVE_QUANTUM_MS);
    for (const settledChunk of chunks.filter((c) => !c.live)) {
      expect(settledChunk.toMs).toBeLessThanOrEqual(live[0].fromMs);
    }
  });

  it('re-keys the live chunk at most once per quantum', () => {
    const keyAt = (ms: number) =>
      activityChunks(windowOf('2026-08-01', '2026-08-05'), ms, LA).find((c) => c.live)?.key;
    // Two instants INSIDE one quantum share a key. Note NOW itself is local
    // noon, which lands exactly ON a boundary — under `ceil` that is the top of
    // the previous bucket, so probe from strictly inside instead.
    expect(keyAt(NOW + 60_000)).toBe(keyAt(NOW + 120_000));
    expect(keyAt(NOW + 60_000)).toBe(keyAt(NOW + LIVE_QUANTUM_MS));
    // Crossing into the next one re-keys, and only then.
    expect(keyAt(NOW + 60_000)).not.toBe(keyAt(NOW + LIVE_QUANTUM_MS + 1));
    // Over an hour of polling at 15s, a settled key count of one per 5 minutes.
    const keys = new Set<string | undefined>();
    for (let t = 0; t <= 3_600_000; t += 15_000) keys.add(keyAt(NOW + t));
    expect(keys.size).toBe(3_600_000 / LIVE_QUANTUM_MS + 1);
  });

  it('asks for nothing in a window wholly in the future', () => {
    expect(activityChunks(windowOf('2027-01-01', '2027-02-01'), NOW, LA)).toEqual([]);
  });

  it('omits future chunks from a window that straddles now', () => {
    const chunks = activityChunks(windowOf('2026-07-01', '2026-11-30'), NOW, LA);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(chunk.fromMs).toBeLessThan(NOW + LIVE_QUANTUM_MS);
  });

  it('asks for exactly one more chunk after a typical prepend', () => {
    // The payoff of matching CHUNK_DAYS to PAST_BLOCK_DAYS: one scroll gesture
    // usually costs one request, not a rescan of everything already held.
    const win = windowOf('2026-06-01', '2026-08-05');
    const fetched = new Set(activityChunks(win, NOW, LA).map((c) => c.key));
    const plan = planExtension(win, { ...settled, scrollLeft: 0 }, NOW, LA)!;
    const fresh = activityChunks(plan.next, NOW, LA).filter((c) => !fetched.has(c.key));
    expect(fresh.length).toBeLessThanOrEqual(2);
  });
});
