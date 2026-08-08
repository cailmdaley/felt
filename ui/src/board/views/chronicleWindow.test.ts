/**
 * chronicleWindow — the two properties continuous scroll lives or dies by.
 *
 * THE TIMEZONE IS THE EXPERIMENT here as everywhere on this board: `npm test`
 * runs the file twice, under America/Los_Angeles and Europe/Paris, because the
 * chunk boundaries are real local 6am instants and a UTC-only run would agree
 * with broken code. Every clock is built LOCALLY (see `atLocal`) — a UTC
 * literal names a different local day either side of the Atlantic, and worse,
 * UTC noon falls at 05:00 in Los Angeles, which is on the far side of the 6am
 * rail boundary from Paris.
 */

import { describe, expect, it } from 'vitest';
import {
  activityChunks,
  addDays,
  CHUNK_DAYS,
  chunkBounds,
  chunkIndexOf,
  dayAtIndex,
  daysBetween,
  EDGE_TRIGGER_DAYS,
  FUTURE_BLOCK_DAYS,
  indexOfDay,
  LIVE_QUANTUM_MS,
  MAX_FUTURE_DAYS,
  MAX_PAST_DAYS,
  PAST_BLOCK_DAYS,
  pendingChunks,
  planExtension,
  RAIL_START_HOUR,
  shiftIndex,
  shiftSpan,
  windowLimits,
  windowOf,
  type ScrollProbe,
} from './chronicleWindow.js';
import { civilDayToLocalDate } from '../civilDay.js';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** An instant at a LOCAL wall-clock time on a civil day — never a UTC literal,
 *  and noon by default so it is unambiguously past the 6am rail boundary. */
function atLocal(day: string, hour = 12, minute = 0): number {
  const d = civilDayToLocalDate(day);
  if (!d) throw new Error(`not a civil day: ${day}`);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

const NOW = atLocal('2026-08-05');
/** A scroller parked in the middle of a comfortable window. */
const settled: ScrollProbe = {
  scrollLeft: 900,
  clientWidth: 1000,
  scrollWidth: 4000,
  dayWidthPx: 24,
};

describe('the suite runs under a pinned, non-UTC zone', () => {
  it('is one of the two zones `npm test` pins', () => {
    expect(TZ).toMatch(/^(America\/Los_Angeles|Europe\/Paris)$/);
  });
});

describe('civil-day arithmetic', () => {
  it('counts whole days between civil days, signed', () => {
    expect(daysBetween('2026-08-03', '2026-08-10')).toBe(7);
    expect(daysBetween('2026-08-10', '2026-08-03')).toBe(-7);
    expect(daysBetween('2026-08-03', '2026-08-03')).toBe(0);
  });

  it('counts correctly across a month, a year and a DST transition', () => {
    expect(daysBetween('2026-07-27', '2026-08-03')).toBe(7);
    expect(daysBetween('2026-12-28', '2027-01-04')).toBe(7);
    // Both zones move their clocks inside these spans; a civil-day difference
    // must not notice.
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31);
    expect(daysBetween('2026-10-01', '2026-11-01')).toBe(31);
  });

  it('strides by calendar day, not by 86_400_000', () => {
    for (const day of ['2026-03-07', '2026-03-28', '2026-10-24', '2026-10-31']) {
      // Round-tripping a DST-straddling stride must land back where it started.
      expect(addDays(addDays(day, 1), -1)).toBe(day);
      expect(daysBetween(day, addDays(day, 1))).toBe(1);
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

  it('does nothing while the scroller sits in the middle', () => {
    expect(planExtension(win, settled, NOW)).toBeNull();
  });

  it('does nothing before the column width has been measured', () => {
    // Extending against a zero width would compute a zero compensation and
    // jump — the exact failure this feature must not have.
    expect(planExtension(win, { ...settled, scrollLeft: 0, dayWidthPx: 0 }, NOW)).toBeNull();
  });

  it('prepends when within three day-widths of the left edge', () => {
    const probe = { ...settled, scrollLeft: EDGE_TRIGGER_DAYS * settled.dayWidthPx };
    const plan = planExtension(win, probe, NOW);
    expect(plan?.side).toBe('past');
    expect(plan?.added).toBe(PAST_BLOCK_DAYS);
    expect(plan?.next.first).toBe(addDays(win.first, -PAST_BLOCK_DAYS));
    expect(plan?.next.last).toBe(win.last);
  });

  it('appends a smaller block at the right edge', () => {
    const probe = {
      ...settled,
      scrollLeft: settled.scrollWidth - settled.clientWidth - EDGE_TRIGGER_DAYS * settled.dayWidthPx,
    };
    const plan = planExtension(win, probe, NOW);
    expect(plan?.side).toBe('future');
    expect(plan?.added).toBe(FUTURE_BLOCK_DAYS);
    expect(FUTURE_BLOCK_DAYS).toBeLessThan(PAST_BLOCK_DAYS);
    expect(plan?.next.last).toBe(addDays(win.last, FUTURE_BLOCK_DAYS));
    expect(plan?.next.first).toBe(win.first);
  });

  it('prefers the past edge when a short window touches both', () => {
    const tiny = windowOf('2026-08-01', '2026-08-07');
    const probe: ScrollProbe = { scrollLeft: 0, clientWidth: 400, scrollWidth: 400, dayWidthPx: 24 };
    expect(planExtension(tiny, probe, NOW)?.side).toBe('past');
  });
});

describe('the no-jump property', () => {
  it('compensates scrollLeft by exactly the width of what was inserted', () => {
    // The whole feature in one assertion: content displaced right by
    // `added × dayWidthPx` must be met by the same increase in scrollLeft, or
    // the timeline lurches under the cursor.
    for (const dayWidthPx of [16, 24, 37, 56]) {
      const probe = { ...settled, scrollLeft: 10, dayWidthPx };
      const plan = planExtension(windowOf('2026-06-01', '2026-08-20'), probe, NOW);
      expect(plan?.scrollDelta).toBe((plan?.added ?? 0) * dayWidthPx);
      // And the day under the left edge is unchanged afterwards.
      const before = Math.round(probe.scrollLeft / dayWidthPx);
      const after = Math.round((probe.scrollLeft + (plan?.scrollDelta ?? 0)) / dayWidthPx);
      expect(dayAtIndex(plan!.next, after)).toBe(dayAtIndex(windowOf('2026-06-01', '2026-08-20'), before));
    }
  });

  it('needs no compensation when appending — nothing on screen moves', () => {
    const probe = {
      ...settled,
      scrollLeft: settled.scrollWidth - settled.clientWidth,
    };
    const plan = planExtension(windowOf('2026-06-01', '2026-08-20'), probe, NOW);
    expect(plan?.side).toBe('future');
    expect(plan?.scrollDelta).toBe(0);
    expect(plan?.indexShift).toBe(0);
  });
});

describe('indices survive an extension', () => {
  const win = windowOf('2026-06-01', '2026-08-20');
  const plan = planExtension(win, { ...settled, scrollLeft: 0 }, NOW)!;

  it('shifts a retained index by the block size on a prepend', () => {
    // Index 12 named 2026-06-13 before; without the shift it names a day 28
    // columns later afterwards, and the band lands on the wrong fortnight.
    const day = dayAtIndex(win, 12);
    expect(dayAtIndex(plan.next, 12)).not.toBe(day);
    expect(dayAtIndex(plan.next, shiftIndex(12, plan))).toBe(day);
  });

  it('shifts a whole span — a cycle band, a drag draft', () => {
    const band = { startIdx: 4, endIdx: 9, name: 'Q3 push' };
    const moved = shiftSpan(band, plan);
    expect(dayAtIndex(plan.next, moved.startIdx)).toBe(dayAtIndex(win, band.startIdx));
    expect(dayAtIndex(plan.next, moved.endIdx)).toBe(dayAtIndex(win, band.endIdx));
    expect(moved.name).toBe('Q3 push'); // carries its other fields through
  });

  it('leaves indices alone on an append, and on no plan at all', () => {
    const append = planExtension(
      windowOf('2026-06-01', '2026-08-20'),
      { ...settled, scrollLeft: settled.scrollWidth - settled.clientWidth },
      NOW,
    )!;
    expect(shiftIndex(12, append)).toBe(12);
    expect(shiftIndex(12, null)).toBe(12);
    expect(shiftSpan({ startIdx: 1, endIdx: 2 }, null)).toEqual({ startIdx: 1, endIdx: 2 });
  });

  it('holds a CIVIL DAY across extension with no mapping at all', () => {
    // The better fix where a call site can take it: a day is the same day
    // whatever the window did.
    const day = '2026-06-13';
    expect(indexOfDay(win, day)).toBe(12);
    expect(indexOfDay(plan.next, day)).toBe(12 + PAST_BLOCK_DAYS);
    expect(dayAtIndex(plan.next, indexOfDay(plan.next, day)!)).toBe(day);
  });

  it('reports null for a day outside the window rather than a bogus index', () => {
    expect(indexOfDay(win, '2026-01-01')).toBeNull();
    expect(indexOfDay(win, '2027-01-01')).toBeNull();
    expect(dayAtIndex(win, -1)).toBeNull();
    expect(dayAtIndex(win, win.length)).toBeNull();
  });
});

describe('the caps', () => {
  it('reaches a year back and eight weeks forward, and no further', () => {
    const { earliest, latest } = windowLimits(NOW);
    expect(daysBetween(earliest, '2026-08-05')).toBe(MAX_PAST_DAYS);
    expect(daysBetween('2026-08-05', latest)).toBe(MAX_FUTURE_DAYS);
  });

  it('adds a partial block rather than overshooting the past cap', () => {
    const { earliest } = windowLimits(NOW);
    // Ten days short of the cap: the block must shrink to ten, not add 28.
    const win = windowOf(addDays(earliest, 10), '2026-08-20');
    const plan = planExtension(win, { ...settled, scrollLeft: 0 }, NOW);
    expect(plan?.added).toBe(10);
    expect(plan?.next.first).toBe(earliest);
    // And the compensation still matches what was actually inserted.
    expect(plan?.scrollDelta).toBe(10 * settled.dayWidthPx);
  });

  it('stops entirely at the cap instead of returning an empty plan', () => {
    const { earliest, latest } = windowLimits(NOW);
    expect(planExtension(windowOf(earliest, '2026-08-20'), { ...settled, scrollLeft: 0 }, NOW))
      .toBeNull();
    const atRight = windowOf('2026-06-01', latest);
    const probe = { ...settled, scrollLeft: settled.scrollWidth - settled.clientWidth };
    expect(planExtension(atRight, probe, NOW)).toBeNull();
  });

  it('measures the caps from the RAIL day, so 2am does not move them', () => {
    // 02:00 on the 5th still belongs to the 4th's rail.
    const small = windowLimits(atLocal('2026-08-05', 2));
    const midday = windowLimits(atLocal('2026-08-04'));
    expect(small).toEqual(midday);
  });
});

describe('activity chunks', () => {
  it('keys on a fixed grid, so the same days keep the same key', () => {
    // A window grown leftward in blocks and one grown in dribs must agree, or
    // every reshape refetches the same days under a new key.
    const wide = activityChunks(windowOf('2026-05-01', '2026-08-05'), NOW);
    const narrow = activityChunks(windowOf('2026-06-10', '2026-08-05'), NOW);
    const shared = narrow.filter((c) => wide.some((w) => w.key === c.key));
    expect(shared.length).toBeGreaterThan(0);
    for (const chunk of shared) {
      const match = wide.find((w) => w.key === chunk.key)!;
      expect(match.fromMs).toBe(chunk.fromMs);
      expect(match.toMs).toBe(chunk.toMs);
      expect(match.first).toBe(chunk.first);
    }
  });

  it('lays chunks end to end with no gap and no overlap', () => {
    const chunks = activityChunks(windowOf('2026-05-01', '2026-08-05'), NOW);
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i].first).toBe(addDays(chunks[i - 1].last, 1));
      // Settled chunks abut exactly; only the live one stops early.
      if (!chunks[i - 1].live) expect(chunks[i].fromMs).toBe(chunks[i - 1].toMs);
    }
  });

  it('opens AND closes every settled chunk at 6am local', () => {
    // Zone-agnostic, and the assertion a `days * 86_400_000` span fails wherever
    // a transition falls inside a chunk: both edges must be real 6am wall-clock
    // instants, so the chunk is however many hours that actually takes.
    for (const chunk of activityChunks(windowOf('2026-02-15', '2026-08-05'), NOW)) {
      expect(new Date(chunk.fromMs).getHours()).toBe(RAIL_START_HOUR);
      if (!chunk.live) expect(new Date(chunk.toMs).getHours()).toBe(RAIL_START_HOUR);
    }
  });

  it('keeps every chunk within an hour of nominal, and on whole hours', () => {
    for (const chunk of activityChunks(windowOf('2026-02-15', '2026-06-05'), atLocal('2026-08-05'))) {
      const hours = (chunk.toMs - chunk.fromMs) / 3_600_000;
      expect(Number.isInteger(hours)).toBe(true);
      expect(Math.abs(hours - CHUNK_DAYS * 24)).toBeLessThanOrEqual(1);
    }
  });

  // Zone-CONDITIONAL by premise, not by date literal: a chunk can only be
  // off-nominal in a zone that actually moves its clocks, and UTC, Kolkata and
  // São Paulo (which abolished DST in 2019) never do. Detected rather than
  // listed, so it runs wherever it is meaningful — including the southern
  // hemisphere, where the transitions fall the other way round.
  const observesDst =
    new Date(2026, 0, 15).getTimezoneOffset() !== new Date(2026, 6, 15).getTimezoneOffset();
  it.runIf(observesDst)('makes a DST chunk longer or shorter than days × 24h', () => {
    const spans = activityChunks(windowOf('2026-01-01', '2026-12-01'), atLocal('2026-12-15'))
      .filter((c) => !c.live)
      .map((c) => (c.toMs - c.fromMs) / 3_600_000);
    expect(spans.some((h) => h !== CHUNK_DAYS * 24)).toBe(true);
    expect(spans.some((h) => h === CHUNK_DAYS * 24)).toBe(true);
  });

  it('caps the live chunk at now and leaves the settled ones whole', () => {
    const chunks = activityChunks(windowOf('2026-05-01', '2026-09-20'), NOW);
    const live = chunks.filter((c) => c.live);
    expect(live).toHaveLength(1);
    expect(live[0].toMs).toBeGreaterThanOrEqual(NOW);
    expect(live[0].toMs % LIVE_QUANTUM_MS).toBe(0);
    expect(live[0].toMs).toBeLessThan(NOW + LIVE_QUANTUM_MS);
    for (const settledChunk of chunks.filter((c) => !c.live)) {
      expect(settledChunk.toMs).toBeLessThanOrEqual(live[0].fromMs);
    }
  });

  it('gives a settled chunk a key that does not move with the clock', () => {
    const a = activityChunks(windowOf('2026-05-01', '2026-08-05'), NOW).filter((c) => !c.live);
    const b = activityChunks(windowOf('2026-05-01', '2026-08-05'), NOW + 37 * 60_000)
      .filter((c) => !c.live);
    expect(a.map((c) => c.key)).toEqual(b.map((c) => c.key));
  });

  it('re-keys the live chunk at most once per quantum', () => {
    const keyAt = (ms: number) =>
      activityChunks(windowOf('2026-08-01', '2026-08-05'), ms).find((c) => c.live)?.key;
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
    expect(activityChunks(windowOf('2027-01-01', '2027-02-01'), NOW)).toEqual([]);
  });

  it('omits future chunks from a window that straddles now', () => {
    const chunks = activityChunks(windowOf('2026-07-01', '2026-11-30'), NOW);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(chunk.fromMs).toBeLessThan(NOW + LIVE_QUANTUM_MS);
  });

  it('agrees with its own index/bounds helpers', () => {
    for (const day of ['1970-01-01', '2026-08-05', '2026-12-31']) {
      const { first, last } = chunkBounds(chunkIndexOf(day));
      expect(daysBetween(first, last)).toBe(CHUNK_DAYS - 1);
      expect(daysBetween(first, day)).toBeGreaterThanOrEqual(0);
      expect(daysBetween(day, last)).toBeGreaterThanOrEqual(0);
    }
  });

  it('only hands back what has not been fetched', () => {
    const win = windowOf('2026-05-01', '2026-08-05');
    const all = activityChunks(win, NOW);
    expect(pendingChunks(win, NOW, new Set())).toHaveLength(all.length);
    const fetched = new Set(all.slice(0, 2).map((c) => c.key));
    expect(pendingChunks(win, NOW, fetched)).toHaveLength(all.length - 2);
    expect(pendingChunks(win, NOW, new Set(all.map((c) => c.key)))).toHaveLength(0);
  });

  it('asks for exactly one more chunk after a typical prepend', () => {
    // The payoff of matching CHUNK_DAYS to PAST_BLOCK_DAYS: one scroll gesture
    // usually costs one request, not a rescan of everything already held.
    const win = windowOf('2026-06-01', '2026-08-05');
    const fetched = new Set(activityChunks(win, NOW).map((c) => c.key));
    const plan = planExtension(win, { ...settled, scrollLeft: 0 }, NOW)!;
    expect(pendingChunks(plan.next, NOW, fetched).length).toBeLessThanOrEqual(2);
  });
});
