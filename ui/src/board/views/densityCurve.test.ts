/**
 * The activity curve's arithmetic — everything above {@link buildCurveSvg},
 * which is the one export that touches the DOM and so is left to the browser
 * to exercise. Every test below is checking the doctrine set out in
 * densityCurve.ts's own module comment, not just the numbers: HEIGHT is
 * log-compressed volume, COLOUR reads the human signal alone, and SPINES are
 * discrete marks laid over a continuous field.
 */

import { describe, expect, it } from 'vitest'
import {
  CURVE_AGENT,
  CURVE_HUMAN,
  HUMAN_HALF_LIFE,
  PEAK_FLOOR,
  SIGMA_HUMAN_MINUTES,
  SIGMA_TOTAL_MINUTES,
  curveField,
  curveGrid,
  curveRuns,
  edgePath,
  fieldPeak,
  gradientStops,
  humanMix,
  mixHex,
  smear,
  spineAlphas,
  type ActivitySample,
  type CurveField,
} from './densityCurve.js'

describe('the two kernels', () => {
  it('gives the colour channel a wider reach than the height channel', () => {
    // See the module doc: the human kernel is wide on purpose, because "you
    // were engaged here" is not an honest claim at sub-five-minute
    // resolution. If this ever flips, one late-arriving human minute would
    // read as sharply localized as the machine's own precisely-timestamped
    // events — exactly the false precision the wide kernel exists to avoid.
    expect(SIGMA_HUMAN_MINUTES).toBeGreaterThan(SIGMA_TOTAL_MINUTES)
  })
})

describe('smear — the unnormalised kernel', () => {
  const grid = curveGrid(20) // step 1, so grid minutes line up with samples

  it('peaks a lone event of weight 1 at exactly 1, at its own position', () => {
    const samples: ActivitySample[] = [{ minute: 10, human: 0, agent: 1 }]
    const out = smear(samples, (s) => s.agent, SIGMA_TOTAL_MINUTES, grid)
    expect(out[10]).toBeCloseTo(1, 10)
  })

  it('falls to exp(-0.5) one sigma from that event', () => {
    // An UNNORMALISED Gaussian, so the peak never depends on sigma — only how
    // far the influence reaches does. This is what lets the height and colour
    // channels share weights but use different bandwidths without the colour
    // channel's peak drifting as SIGMA_HUMAN_MINUTES is tuned.
    //
    // Evaluated with an integer sigma (5, the human kernel's) and a fine grid
    // so the sampled point falls exactly one sigma out rather than merely near
    // it — the day/week grids are coarser than 1 minute and would only test
    // the grid's own rounding, not the kernel.
    const fineGrid = curveGrid(40)
    const samples: ActivitySample[] = [{ minute: 20, human: 1, agent: 0 }]
    const out = smear(samples, (s) => s.human, SIGMA_HUMAN_MINUTES, fineGrid)
    expect(out[20 + SIGMA_HUMAN_MINUTES]).toBeCloseTo(Math.exp(-0.5), 10)
    expect(out[20 - SIGMA_HUMAN_MINUTES]).toBeCloseTo(Math.exp(-0.5), 10)
  })

  it('is zero everywhere for a non-positive sigma', () => {
    const samples: ActivitySample[] = [{ minute: 10, human: 0, agent: 1 }]
    expect(smear(samples, (s) => s.agent, 0, grid)).toEqual(new Array(grid.count).fill(0))
  })

  it('skips a sample whose weight is not positive', () => {
    const samples: ActivitySample[] = [{ minute: 10, human: 0, agent: 0 }]
    const out = smear(samples, (s) => s.agent, SIGMA_TOTAL_MINUTES, grid)
    expect(out.every((v) => v === 0)).toBe(true)
  })
})

describe('humanMix — saturating in human density alone', () => {
  it('is zero at zero (and negative) density', () => {
    expect(humanMix(0)).toBe(0)
    expect(humanMix(-1)).toBe(0)
  })

  it('is monotone increasing', () => {
    const xs = [0.01, 0.1, 0.3, HUMAN_HALF_LIFE, 1, 2, 5]
    const ys = xs.map(humanMix)
    for (let i = 1; i < ys.length; i += 1) expect(ys[i]).toBeGreaterThan(ys[i - 1])
  })

  it('saturates below 1 and never reaches it', () => {
    // Large enough to be deep in the saturated tail, small enough that
    // exp(-density/HUMAN_HALF_LIFE) has not yet underflowed to exactly 0 —
    // 1000 does underflow at HUMAN_HALF_LIFE's current scale, which would make
    // this assertion vacuously true instead of testing the asymptote.
    expect(humanMix(20)).toBeLessThan(1)
    expect(humanMix(20)).toBeGreaterThan(0.99)
  })

  it("matches the module doc's own worked example: a lone message reads 1 - exp(-1/HUMAN_HALF_LIFE) at its own instant", () => {
    // A lone message peaks its own kernel at exactly density 1, so this is the
    // number the doctrine hangs on — checked against the formula rather than a
    // hardcoded percentage so it tracks HUMAN_HALF_LIFE if that constant is
    // ever retuned "by looking" again, per its own doc comment.
    expect(humanMix(1)).toBeCloseTo(1 - Math.exp(-1 / HUMAN_HALF_LIFE), 10)
  })
})

describe('THE DOCTRINE — one human message among a hundred agent events still reads human', () => {
  // This is the single most important test in this file. The whole design of
  // the colour channel turns on it: colour reads the HUMAN signal ALONE, with
  // no term for the machine anywhere in it, so a hundred tool calls in the
  // same minute a person wrote one message must not dilute that minute's
  // colour toward agent-blue. If this regresses, the board starts reading
  // "the machine was busy" as more salient than "you were here" — exactly
  // backwards from what this rail exists to say.
  //
  // The bar is HUMAN_HALF_LIFE's own worked example (a lone message alone
  // reads 1 - exp(-1/HUMAN_HALF_LIFE) human), minus a hair of slack for the
  // 100 agent events sharing the minute — height and mix are independent
  // channels, but this asserts that independence rather than assuming it.
  it('gives a minute with 1 human event and 100 agent events a high human mix', () => {
    const minute = 30
    const samples: ActivitySample[] = [{ minute, human: 1, agent: 100 }]
    const grid = curveGrid(60)
    const field = curveField(samples, grid, [minute])
    const soloMessage = 1 - Math.exp(-1 / HUMAN_HALF_LIFE)
    expect(field.mix[minute]).toBeCloseTo(soloMessage, 10)
    // And, concretely, unambiguously human — not merely "the taller side". A
    // lone message peaks its own mix at ~0.76 (HUMAN_HALF_LIFE = 0.7); the
    // bar sits just under that, since the 100 agent events on the height
    // channel must not be allowed to shave any of it off the colour channel.
    expect(field.mix[minute]).toBeGreaterThan(0.7)
    // The height channel, meanwhile, is dominated by the 100 agent events —
    // colour and height disagreeing on the same minute is exactly the point.
    const agentOnly = curveField([{ minute, human: 0, agent: 100 }], grid, [])
    expect(field.height[minute]).toBeCloseTo(agentOnly.height[minute], 1)
  })
})

describe('curveField — height is log1p-compressed volume', () => {
  it('does not scale a 100-event minute up 100x over a 1-event minute', () => {
    const grid = curveGrid(10)
    const quiet = curveField([{ minute: 5, human: 0, agent: 1 }], grid, [])
    const busy = curveField([{ minute: 5, human: 0, agent: 100 }], grid, [])
    const ratio = busy.height[5] / quiet.height[5]
    // log1p(100) / log1p(1) ≈ 6.6 — nowhere near the 100x a linear height
    // would give, and this is the whole point of the compression: a burst
    // must not flatten the rest of the day into the baseline.
    expect(ratio).toBeLessThan(7)
    expect(ratio).toBeGreaterThan(1) // still taller, just not proportionally
  })

  it('dedupes and sorts spines, ascending', () => {
    const grid = curveGrid(10)
    const field = curveField([{ minute: 3, human: 1, agent: 0 }], grid, [7, 3, 7, 1])
    expect(field.spines).toEqual([1, 3, 7])
  })
})

describe('fieldPeak — a page-wide normaliser, never per-lane', () => {
  it('never returns below PEAK_FLOOR, even for an all-quiet page', () => {
    const grid = curveGrid(10)
    const quiet = curveField([], grid, [])
    expect(fieldPeak([quiet])).toBe(PEAK_FLOOR)
  })

  it("takes the max across every field passed, not each field's own max", () => {
    // Per PAGE and not per LANE, deliberately — see the module doc: normalising
    // each rail to its own maximum would draw a fiber that saw four events and
    // one that saw four hundred at the same height.
    const grid = curveGrid(10)
    const quiet = curveField([{ minute: 2, human: 0, agent: 1 }], grid, [])
    const loud = curveField([{ minute: 5, human: 0, agent: 400 }], grid, [])
    const peak = fieldPeak([quiet, loud])
    expect(peak).toBe(Math.max(...loud.height))
    // And the quiet field alone must not report loud's peak as its own.
    expect(fieldPeak([quiet])).toBeLessThan(peak)
  })
})

describe('mixHex and gradientStops', () => {
  // mixHex lower-cases its output (`toString(16)`), so the poles are compared
  // case-insensitively — the doctrine here is "the same pigment", not "the
  // same string the constant happens to be written with".
  const lower = (hex: string) => hex.toLowerCase()

  it('walks from CURVE_AGENT to CURVE_HUMAN as mix goes 0 → 1', () => {
    expect(mixHex(0)).toBe(lower(CURVE_AGENT))
    expect(mixHex(1)).toBe(lower(CURVE_HUMAN))
  })

  it('clamps mix outside [0, 1]', () => {
    expect(mixHex(-5)).toBe(lower(CURVE_AGENT))
    expect(mixHex(5)).toBe(lower(CURVE_HUMAN))
  })

  it('collapses a lane with no human events to a flat 2-stop gradient at CURVE_AGENT', () => {
    const grid = curveGrid(10)
    const field = curveField([{ minute: 4, human: 0, agent: 10 }], grid, [])
    const stops = gradientStops(field)
    expect(stops).toHaveLength(2)
    expect(stops[0].color).toBe(lower(CURVE_AGENT))
    expect(stops[1].color).toBe(lower(CURVE_AGENT))
    expect(stops[0].offset).toBe(0)
    expect(stops[1].offset).toBe(1)
  })

  it('always returns at least 2 stops, even for a single-point grid', () => {
    const field: CurveField = {
      grid: { step: 1, count: 1 },
      height: [0],
      mix: [0],
      spines: [],
    }
    expect(gradientStops(field).length).toBeGreaterThanOrEqual(2)
  })
})

describe('curveRuns / edgePath', () => {
  it('draws nothing at all for a field with no activity — silence is silent', () => {
    // The doctrine curveRuns exists for: an unbroken path used to draw a flat
    // cobalt rule across days with no activity at all, reading as "the agents
    // worked here, evenly, all day". A quiet field must yield no runs.
    const grid = curveGrid(20)
    const empty = curveField([], grid, [])
    expect(curveRuns(empty, fieldPeak([empty]))).toEqual([])
    expect(edgePath(curveRuns(empty, fieldPeak([empty])))).toBe('')
  })

  it("starts each run's edge with an M, and only the first point of the run", () => {
    const grid = curveGrid(20)
    const field = curveField([{ minute: 10, human: 0, agent: 5 }], grid, [])
    const runs = curveRuns(field, fieldPeak([field]))
    expect(runs.length).toBeGreaterThan(0)
    const path = edgePath(runs)
    const moves = path.split(' ').filter((tok) => tok === 'M')
    expect(moves).toHaveLength(runs.length)
    expect(path.startsWith('M ')).toBe(true)
  })

  it('cuts one isolated burst into exactly one run, touching the baseline at both ends', () => {
    // A run keeps the first quiet point on either side of the loud stretch, so
    // it touches down on the baseline (y = 100, VIEW_H) rather than starting
    // and ending in mid-air — the burst reads as a mound rising out of a flat
    // rail, not a shape floating over it.
    const grid = curveGrid(30)
    const field = curveField([{ minute: 15, human: 0, agent: 20 }], grid, [])
    const runs = curveRuns(field, fieldPeak([field]))
    expect(runs).toHaveLength(1)
    const [run] = runs
    expect(run[0].y).toBe(100)
    expect(run[run.length - 1].y).toBe(100)
    // And somewhere inside the run the ink actually rises off the baseline —
    // otherwise "one run" would be true of a run that never left it either.
    expect(Math.min(...run.map((p) => p.y))).toBeLessThan(100)
  })

  it('clamps every drawn point at the peak — no y climbs above the top of the rail', () => {
    // y = VIEW_H - min(1, height/scale) * VIEW_H, so no y should go negative
    // (above the top) however tall a burst is relative to the peak it is
    // being measured against, e.g. a peak suppressed below this field's own
    // height by page normalisation.
    const grid = curveGrid(10)
    const field = curveField([{ minute: 5, human: 0, agent: 50 }], grid, [])
    const suppressedPeak = PEAK_FLOOR // smaller than this field's real height
    const runs = curveRuns(field, suppressedPeak)
    for (const run of runs) for (const p of run) expect(p.y).toBeGreaterThanOrEqual(0)
  })
})

describe('spineAlphas — rationing the eye, not the record', () => {
  // What Week's 468-message Monday proved: a hairline per message, drawn at
  // full weight regardless of company, turns a burst into a solid black wall
  // that says only "a lot happened" — the loudest thing on the page, and the
  // least informative. Falling as 1/sqrt(neighbours) keeps every message
  // exactly where it happened while rationing how hard it can claim the eye.

  it('draws a lone spine at full weight', () => {
    expect(spineAlphas([50])).toEqual([0.82])
  })

  it('leaves two spines far apart both at full weight', () => {
    // Well outside the 4-minute crowd window on both sides.
    expect(spineAlphas([0, 100])).toEqual([0.82, 0.82])
  })

  it('falls in proportion to a small crowd — five together read fainter than one alone', () => {
    // Falloff is linear in neighbour count (0.82 / neighbours), so five spines
    // sharing a minute (each sees all five as neighbours) come out at
    // 0.82 / 5 — a visible fraction of a lone message's weight, and still well
    // above the floor.
    const crowd = [0, 0, 0, 0, 0]
    const alphas = spineAlphas(crowd)
    expect(alphas.every((a) => a === 0.82 / 5)).toBe(true)
    expect(alphas.every((a) => a > 0.09)).toBe(true)
  })

  it('bottoms out at the floor for a genuine crowd, rather than fading toward invisibility', () => {
    // A message that happened must not disappear because other messages did
    // too — 200 sharing a minute would compute to 0.82/200 ≈ 0.004 unfloored,
    // which the floor catches.
    const crowd = Array.from({ length: 200 }, () => 0)
    const alphas = spineAlphas(crowd)
    expect(alphas.every((a) => a === 0.09)).toBe(true)
  })

  it('is empty for no spines', () => {
    expect(spineAlphas([])).toEqual([])
  })
})
