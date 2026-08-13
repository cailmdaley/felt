/**
 * The activity curve's arithmetic — everything above {@link buildCurveSvg},
 * which is the one export that touches the DOM and so is left to the browser
 * to exercise. Every test below is checking the doctrine set out in
 * densityCurve.ts's own module comment, not just the numbers: HEIGHT is
 * log-compressed AGENT volume, and SPINES are discrete marks laid over that
 * field, drawn to its own height with a floor under them.
 */

import { describe, expect, it } from 'vitest'
import {
  PEAK_FLOOR,
  SIGMA_TOTAL_MINUTES,
  SPINE_MIN_HEIGHT,
  curveField,
  curveGrid,
  curveRuns,
  edgePath,
  fieldPeak,
  smear,
  stackDepth,
  stackPitch,
  stackSpawns,
  spineAlphas,
  spineHeights,
  type ActivitySample,
} from './densityCurve.js'

describe('smear — the unnormalised kernel', () => {
  const grid = curveGrid(20) // step 1, so grid minutes line up with samples

  it('peaks a lone event of weight 1 at exactly 1, at its own position', () => {
    const samples: ActivitySample[] = [{ minute: 10, human: 0, agent: 1 }]
    const out = smear(samples, (s) => s.agent, SIGMA_TOTAL_MINUTES, grid)
    expect(out[10]).toBeCloseTo(1, 10)
  })

  it('falls to exp(-0.5) one sigma from that event', () => {
    // An UNNORMALISED Gaussian, so the peak never depends on sigma — only how
    // far the influence reaches does. Evaluated with an integer sigma and a
    // fine grid so the sampled point falls exactly one sigma out rather than
    // merely near it: the day/week grids are coarser than a minute and would
    // only test the grid's own rounding, not the kernel.
    const sigma = 5
    const fineGrid = curveGrid(40)
    const samples: ActivitySample[] = [{ minute: 20, human: 0, agent: 1 }]
    const out = smear(samples, (s) => s.agent, sigma, fineGrid)
    expect(out[20 + sigma]).toBeCloseTo(Math.exp(-0.5), 10)
    expect(out[20 - sigma]).toBeCloseTo(Math.exp(-0.5), 10)
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

describe('THE DOCTRINE — the curve is the machines, and only the machines', () => {
  // The height field counts agent events alone. It used to count both, plus a
  // whole colour channel that read the human signal — and one message among
  // four hundred tool calls moved the height by nothing and the colour by
  // everything. What "you were here" looks like now is a spine, so a human
  // event must not touch the curve at all: a rail's shape is a picture of what
  // the machines did, and a person reading it can trust that literally.
  it('draws the same curve whether or not a human message shares the minute', () => {
    const minute = 30
    const grid = curveGrid(60)
    const withYou = curveField([{ minute, human: 1, agent: 100 }], grid, [minute])
    const machineOnly = curveField([{ minute, human: 0, agent: 100 }], grid, [])
    expect(withYou.height).toEqual(machineOnly.height)
  })

  it('leaves a minute of pure human message at zero height — the spine carries it', () => {
    const minute = 10
    const grid = curveGrid(30)
    const field = curveField([{ minute, human: 4, agent: 0 }], grid, [minute])
    expect(field.height.every((h) => h === 0)).toBe(true)
    expect(field.spines).toEqual([minute])
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

describe('spineHeights — your message, drawn inside the work it landed in', () => {
  it("rises to the curve's own height where the agents were busy", () => {
    const minute = 20
    const grid = curveGrid(40)
    const field = curveField([{ minute, human: 1, agent: 60 }], grid, [minute])
    const peak = fieldPeak([field])
    const [h] = spineHeights(field, peak)
    // The spine stands in the tallest moment on the page, so it is the full
    // height of the row — and comfortably above the floor, which is what makes
    // this a test of the mapping rather than of the floor.
    expect(h).toBeCloseTo(field.height[minute] / peak, 10)
    expect(h).toBeGreaterThan(SPINE_MIN_HEIGHT)
  })

  it('is a fraction of the row where the agents were quiet, not the whole of it', () => {
    // Two lanes on one page: the loud one sets the peak, the quiet one is
    // measured against it. A message during a lull must not draw as tall as a
    // message during a burst — that height difference IS the information.
    const grid = curveGrid(60)
    const quiet = curveField([{ minute: 10, human: 1, agent: 2 }], grid, [10])
    const loud = curveField([{ minute: 40, human: 1, agent: 400 }], grid, [40])
    const peak = fieldPeak([quiet, loud])
    const [quietSpine] = spineHeights(quiet, peak)
    const [loudSpine] = spineHeights(loud, peak)
    expect(quietSpine).toBeLessThan(loudSpine)
    expect(loudSpine).toBeCloseTo(1, 10)
  })

  it('floors a message sent while nothing was running, so it is still visible', () => {
    // The case the floor exists for: you write to an agent that is not running,
    // which is how a great many conversations start. At the true height that
    // message would be a mark of zero pixels — the most important event on the
    // rail, invisible.
    const grid = curveGrid(60)
    const alone = curveField([], grid, [25])
    const loud = curveField([{ minute: 40, human: 0, agent: 400 }], grid, [])
    expect(spineHeights(alone, fieldPeak([alone, loud]))).toEqual([SPINE_MIN_HEIGHT])
  })

  it('never exceeds the full row, however suppressed the peak it is measured against', () => {
    const grid = curveGrid(20)
    const field = curveField([{ minute: 10, human: 1, agent: 50 }], grid, [10])
    expect(spineHeights(field, PEAK_FLOOR)).toEqual([1])
  })

  it('gives one height per spine, in the field\'s own sorted order', () => {
    const grid = curveGrid(30)
    const field = curveField([{ minute: 5, human: 0, agent: 30 }], grid, [20, 5])
    const heights = spineHeights(field, fieldPeak([field]))
    expect(heights).toHaveLength(2)
    // Spine 5 stands in the burst; spine 20 is out on quiet paper at the floor.
    expect(heights[0]).toBeGreaterThan(heights[1])
    expect(heights[1]).toBe(SPINE_MIN_HEIGHT)
  })

  it('is empty for a field with no spines', () => {
    const grid = curveGrid(10)
    const field = curveField([{ minute: 4, human: 0, agent: 10 }], grid, [])
    expect(spineHeights(field, fieldPeak([field]))).toEqual([])
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
    // Within a hair of the baseline rather than exactly on it: the run keeps
    // the first point BELOW `QUIET`, which is a threshold and not zero, so the
    // touch-down carries whatever fraction of the peak that point held — under
    // half a percent of the rail, well below one drawn pixel. Asserting an
    // exact 100 was pinning an accident of the old bandwidth (its 4σ reach
    // happened to cut to a true zero at that grid point).
    expect(run[0].y).toBeGreaterThan(99.6)
    expect(run[run.length - 1].y).toBeGreaterThan(99.6)
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
    expect(alphas.every((a) => a > 0.07)).toBe(true)
  })

  it('bottoms out at the floor for a genuine crowd, rather than fading toward invisibility', () => {
    // A message that happened must not disappear because other messages did
    // too — 200 sharing a minute would compute to 0.82/200 ≈ 0.004 unfloored,
    // which the floor catches.
    const crowd = Array.from({ length: 200 }, () => 0)
    const alphas = spineAlphas(crowd)
    expect(alphas.every((a) => a === 0.07)).toBe(true)
  })

  it('is empty for no spines', () => {
    expect(spineAlphas([])).toEqual([])
  })
})

describe('stackSpawns', () => {
  const frame = { startMs: 0, endMs: 100_000 }
  const span = (start: number, end: number, open = false) => ({
    start_ms: start,
    end_ms: end,
    open,
  })

  it('gives one delegation one line at the bottom row', () => {
    expect(stackSpawns([span(25_000, 75_000)], frame)).toEqual([
      { start: 0.25, end: 0.75, row: 0, open: false },
    ])
  })

  it('stacks overlapping delegations and reuses a row once one has ended', () => {
    const lines = stackSpawns(
      [span(0, 50_000), span(10_000, 60_000), span(20_000, 30_000), span(70_000, 80_000)],
      frame,
    )
    // Three were aloft at 20s; the fourth starts after all of them ended and
    // so takes the row that freed up first.
    expect(lines.map((l) => l.row)).toEqual([0, 1, 2, 0])
  })

  it('does not count two that merely touch as concurrent', () => {
    const lines = stackSpawns([span(0, 50_000), span(50_000, 90_000)], frame)
    expect(lines.map((l) => l.row)).toEqual([0, 0])
  })

  it('clips a delegation that straddles the frame and drops one outside it', () => {
    const lines = stackSpawns(
      [span(-40_000, 20_000), span(80_000, 400_000), span(200_000, 300_000)],
      frame,
    )
    expect(lines.map((l) => [l.start, l.end])).toEqual([
      [0, 0.2],
      [0.8, 1],
    ])
  })

  it('carries the open flag through, since its length is a stub', () => {
    expect(stackSpawns([span(0, 5_000, true)], frame)[0].open).toBe(true)
  })

  it('is empty for no delegations', () => {
    expect(stackSpawns([], frame)).toEqual([])
  })
})

describe('stackDepth and stackPitch', () => {
  it('reads the deepest stack anywhere on the page', () => {
    expect(stackDepth([[], [{ start: 0, end: 1, row: 0, open: false }]])).toBe(1)
    expect(
      stackDepth([
        [{ start: 0, end: 1, row: 2, open: false }],
        [{ start: 0, end: 1, row: 0, open: false }],
      ]),
    ).toBe(3)
  })

  it('holds the pitch open while the stack is shallow and closes it as it deepens', () => {
    expect(stackPitch(0)).toBe(0)
    expect(stackPitch(1)).toBe(0)
    expect(stackPitch(3)).toBe(2)
    expect(stackPitch(20)).toBeLessThan(2)
    expect(stackPitch(200)).toBeGreaterThanOrEqual(1)
  })
})
