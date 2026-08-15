/**
 * The activity curve's arithmetic — everything above {@link buildCurveSvg},
 * which is the one export that touches the DOM and so is left to the browser
 * to exercise. Every test below is checking the doctrine set out in
 * densityCurve.ts's own module comment, not just the numbers: HEIGHT is
 * log-compressed AGENT volume, compressed PER EVENT before it is smeared, and
 * SPINES are discrete marks laid over that field, drawn to its own height
 * with a floor under them.
 */

import { describe, expect, it } from 'vitest'
import {
  DAY_KERNELS_PER_AXIS,
  DAY_SIGMA_FLOOR_MINUTES,
  PEAK_FLOOR,
  SPINE_ACCENT,
  SPINE_MIN_HEIGHT,
  WEEK_KERNELS_PER_AXIS,
  WEEK_SIGMA_FLOOR_MINUTES,
  curveField,
  curveGrid,
  curveRuns,
  daySigma,
  edgePath,
  fieldPeak,
  kernelSigma,
  ladderHeight,
  ladderPitch,
  ladderRows,
  smear,
  spineHeights,
  spineWidths,
  weekSigma,
  type ActivitySample,
  type LadderInterval,
} from './densityCurve.js'

describe('kernelSigma / daySigma / weekSigma — the kernel is a fraction of the axis', () => {
  it('scales with the span, holding the kernel count fixed', () => {
    expect(kernelSigma(1000, 500, 0)).toBeCloseTo(2, 10)
    expect(kernelSigma(2000, 500, 0)).toBeCloseTo(4, 10)
    // Day and Week disagree on purpose — different questions of the same
    // minutes — so the same span gives them different sigmas.
    expect(daySigma(1440)).not.toBeCloseTo(weekSigma(1440), 5)
  })

  it("floors Day's kernel at the last width that still binds two neighbouring minutes into one episode", () => {
    // 168/500 ≈ 0.34, under the floor: the floor binds. Every frame under
    // about six hours is drawn at exactly this width.
    expect(daySigma(168)).toBe(DAY_SIGMA_FLOOR_MINUTES)
    expect(daySigma(168)).toBe(0.75)
    // 2500/500 = 5, above the floor: the ratio binds instead.
    expect(daySigma(2500)).toBe(5)
    // The floor is where adjacent one-minute samples still overlap enough to
    // fuse: exp(-0.5/sigma^2) is 0.41 here, and under 0.2 by half a minute.
    expect(Math.exp(-0.5 / 0.75 ** 2)).toBeGreaterThan(0.35)
    expect(Math.exp(-0.5 / 0.5 ** 2)).toBeLessThan(0.2)
  })

  it("draws a whole civil day sharper than a soft-hill kernel would", () => {
    // ~2.9 minutes over 1440: distinct masses, not three rolling hills.
    expect(daySigma(1440)).toBeCloseTo(2.88, 2)
  })

  it("floors Week's kernel at four minutes — its own raster slot width — so sigma cannot draw the grid it was binned onto", () => {
    // 1440/200 = 7.2, above the floor: the ratio binds.
    expect(weekSigma(1440)).toBeCloseTo(7.2, 10)
    // 400/200 = 2, under the floor: the floor binds.
    expect(weekSigma(400)).toBe(WEEK_SIGMA_FLOOR_MINUTES)
    expect(weekSigma(400)).toBe(4)
  })

  it("clears Week's four-minute raster tooth on a full day, so sigma smooths the day and not the grid", () => {
    // 1440/200 = 7.2, comfortably clear of the 4-minute slot width — a sigma
    // at or below 4 would draw the raster comb rather than the day's shape.
    expect(weekSigma(1440)).toBeGreaterThan(4)
  })

  it('names how many kernels fit the axis, for Day and Week alike', () => {
    expect(DAY_KERNELS_PER_AXIS).toBe(500)
    expect(WEEK_KERNELS_PER_AXIS).toBe(200)
  })
})

describe('curveGrid — the sampling grid tracks the kernel', () => {
  it('grows finer as sigma narrows, and coarser as sigma widens', () => {
    const fine = curveGrid(1000, daySigma(1000))
    const coarse = curveGrid(1000, weekSigma(1000))
    expect(daySigma(1000)).toBeLessThan(weekSigma(1000))
    expect(fine.step).toBeLessThan(coarse.step)
  })

  it('never exceeds MAX_GRID_POINTS, however long the frame or tight the sigma', () => {
    const grid = curveGrid(10080, 0.1) // a week, at the tightest floor sigma
    expect(grid.count).toBeLessThanOrEqual(2881)
  })
})

describe('smear — the unnormalised kernel', () => {
  const sigma = daySigma(20)
  const grid = curveGrid(20, sigma)
  // The grid step is a fraction of sigma now, not a fixed 1, so a sample's own
  // minute no longer lines up with its own index — this maps minutes to the
  // nearest grid index instead of assuming step 1.
  const idx = (g: typeof grid, minute: number) => Math.round(minute / g.step)

  it('peaks a lone event of weight 1 at exactly 1, at its own position', () => {
    const samples: ActivitySample[] = [{ minute: 10, human: 0, agent: 1 }]
    const out = smear(samples, (s) => s.agent, sigma, grid)
    expect(out[idx(grid, 10)]).toBeCloseTo(1, 10)
  })

  it('falls to exp(-0.5) one sigma from that event', () => {
    // An UNNORMALISED Gaussian, so the peak never depends on sigma — only how
    // far the influence reaches does. Evaluated with an integer sigma and a
    // grid step of exactly 1 (forced past the floor with a wide sigma) so the
    // sampled point falls exactly one sigma out rather than merely near it.
    const wideSigma = 3 // wanted = sigma/GRID_POINTS_PER_SIGMA = 1, matching minutes/MAX_GRID_POINTS
    const fineGrid = curveGrid(2880, wideSigma) // minutes/MAX_GRID_POINTS = 1, so step -> 1
    expect(fineGrid.step).toBeCloseTo(1, 10)
    const samples: ActivitySample[] = [{ minute: 20, human: 0, agent: 1 }]
    const out = smear(samples, (s) => s.agent, wideSigma, fineGrid)
    expect(out[20 + wideSigma]).toBeCloseTo(Math.exp(-0.5), 10)
    expect(out[20 - wideSigma]).toBeCloseTo(Math.exp(-0.5), 10)
  })

  it('is zero everywhere for a non-positive sigma', () => {
    const samples: ActivitySample[] = [{ minute: 10, human: 0, agent: 1 }]
    expect(smear(samples, (s) => s.agent, 0, grid)).toEqual(new Array(grid.count).fill(0))
  })

  it('skips a sample whose weight is not positive', () => {
    const samples: ActivitySample[] = [{ minute: 10, human: 0, agent: 0 }]
    const out = smear(samples, (s) => s.agent, sigma, grid)
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
    const sigma = daySigma(60)
    const grid = curveGrid(60, sigma)
    const withYou = curveField([{ minute, human: 1, agent: 100 }], grid, [minute], sigma)
    const machineOnly = curveField([{ minute, human: 0, agent: 100 }], grid, [], sigma)
    expect(withYou.height).toEqual(machineOnly.height)
  })

  it('leaves a minute of pure human message at zero height — the spine carries it', () => {
    const minute = 10
    const sigma = daySigma(30)
    const grid = curveGrid(30, sigma)
    const field = curveField([{ minute, human: 4, agent: 0 }], grid, [minute], sigma)
    expect(field.height.every((h) => h === 0)).toBe(true)
    expect(field.spines).toEqual([minute])
  })
})

describe('curveField — height is log1p-compressed volume', () => {
  it('does not scale a 100-event minute up 100x over a 1-event minute', () => {
    const sigma = daySigma(10)
    const grid = curveGrid(10, sigma)
    const i = Math.round(5 / grid.step)
    const quiet = curveField([{ minute: 5, human: 0, agent: 1 }], grid, [], sigma)
    const busy = curveField([{ minute: 5, human: 0, agent: 100 }], grid, [], sigma)
    const ratio = busy.height[i] / quiet.height[i]
    // log1p(100) / log1p(1) ≈ 6.6 — nowhere near the 100x a linear height
    // would give, and this is the whole point of the compression: a burst
    // must not flatten the rest of the day into the baseline.
    expect(ratio).toBeLessThan(7)
    expect(ratio).toBeGreaterThan(1) // still taller, just not proportionally
  })

  it('dedupes and sorts spines, ascending', () => {
    const sigma = daySigma(10)
    const grid = curveGrid(10, sigma)
    const field = curveField([{ minute: 3, human: 1, agent: 0 }], grid, [7, 3, 7, 1], sigma)
    expect(field.spines).toEqual([1, 3, 7])
  })

  describe('THE HEADLINE INVARIANT — compression happens per event, before smoothing', () => {
    // This is the whole rework in one measurement. The old order smeared raw
    // counts and compressed after, which meant the drawn width of a mound
    // depended on how many events were in it: log1p(n·e^(-d²/2σ²)) is a
    // parabola in d whose reach to the QUIET floor grows with ln(n), so a
    // busy minute drew a systematically WIDER mound than a quiet one at the
    // very same sigma. Compressing first — log1p(n), THEN smear — makes the
    // smeared shape n·kernel(d) for a constant n, so the half-height width is
    // exactly the kernel's own width, independent of n. Only the height
    // should differ.
    const sigma = 3
    const grid = curveGrid(200, sigma)

    // Half-height width, measured directly off the height array: the
    // distance between the two points nearest the peak where the field
    // crosses half its own maximum.
    const halfHeightWidth = (height: number[]): number => {
      const peak = Math.max(...height)
      const half = peak / 2
      let lo = -1
      let hi = -1
      for (let i = 0; i < height.length; i += 1) {
        if (height[i] >= half) {
          if (lo === -1) lo = i
          hi = i
        }
      }
      return (hi - lo) * grid.step
    }

    it('draws a 1-event minute and a 500-event minute as mounds of identical width', () => {
      const quiet = curveField([{ minute: 100, human: 0, agent: 1 }], grid, [], sigma)
      const busy = curveField([{ minute: 100, human: 0, agent: 500 }], grid, [], sigma)
      const quietWidth = halfHeightWidth(quiet.height)
      const busyWidth = halfHeightWidth(busy.height)
      // Only the height differs — that is the entire claim.
      expect(Math.max(...busy.height)).toBeGreaterThan(Math.max(...quiet.height))
      // Widths agree to within one grid step (the measurement's own quantum).
      expect(Math.abs(busyWidth - quietWidth)).toBeLessThanOrEqual(grid.step * 1.001)
    })
  })
})

describe('fieldPeak — a page-wide normaliser, never per-lane', () => {
  it('never returns below PEAK_FLOOR, even for an all-quiet page', () => {
    const sigma = daySigma(10)
    const grid = curveGrid(10, sigma)
    const quiet = curveField([], grid, [], sigma)
    expect(fieldPeak([quiet])).toBe(PEAK_FLOOR)
  })

  it("takes the max across every field passed, not each field's own max", () => {
    // Per PAGE and not per LANE, deliberately — see the module doc: normalising
    // each rail to its own maximum would draw a fiber that saw four events and
    // one that saw four hundred at the same height.
    const sigma = daySigma(10)
    const grid = curveGrid(10, sigma)
    const quiet = curveField([{ minute: 2, human: 0, agent: 1 }], grid, [], sigma)
    const loud = curveField([{ minute: 5, human: 0, agent: 400 }], grid, [], sigma)
    const peak = fieldPeak([quiet, loud])
    expect(peak).toBe(Math.max(...loud.height))
    // And the quiet field alone must not report loud's peak as its own.
    expect(fieldPeak([quiet])).toBeLessThan(peak)
  })
})

describe('spineHeights — your message, drawn inside the work it landed in', () => {
  it("rises to the curve's own height where the agents were busy", () => {
    const minute = 20
    const sigma = daySigma(40)
    const grid = curveGrid(40, sigma)
    const field = curveField([{ minute, human: 1, agent: 60 }], grid, [minute], sigma)
    const peak = fieldPeak([field])
    const [h] = spineHeights(field, peak)
    // The spine stands in the tallest moment on the page, so it is the full
    // height of the row — and comfortably above the floor, which is what makes
    // this a test of the mapping rather than of the floor.
    const i = Math.round(minute / grid.step)
    expect(h).toBeCloseTo(field.height[i] / peak, 10)
    expect(h).toBeGreaterThan(SPINE_MIN_HEIGHT)
  })

  it('is a fraction of the row where the agents were quiet, not the whole of it', () => {
    // Two lanes on one page: the loud one sets the peak, the quiet one is
    // measured against it. A message during a lull must not draw as tall as a
    // message during a burst — that height difference IS the information.
    const sigma = daySigma(60)
    const grid = curveGrid(60, sigma)
    const quiet = curveField([{ minute: 10, human: 1, agent: 2 }], grid, [10], sigma)
    const loud = curveField([{ minute: 40, human: 1, agent: 400 }], grid, [40], sigma)
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
    // rail, invisible. A rail with no curve has no mound to be proportioned
    // against, so it draws at the absolute minimum.
    const sigma = daySigma(60)
    const grid = curveGrid(60, sigma)
    const alone = curveField([], grid, [25], sigma)
    const loud = curveField([{ minute: 40, human: 0, agent: 400 }], grid, [], sigma)
    expect(spineHeights(alone, fieldPeak([alone, loud]))).toEqual([SPINE_MIN_HEIGHT])
  })

  it('never out-tops the small mound it stands in, however busy the rest of the rail', () => {
    // THE WEEK BUG, second cut. The floor used to be sized from the RAIL's
    // tallest mound — so a day whose afternoon filled the row floored its lone
    // morning message at 0.3, a tower floating clear of a 9am bump of 0.08.
    // Every term is local now: a spine on a small bump clears that bump by the
    // accent and no more.
    const sigma = daySigma(600)
    const grid = curveGrid(600, sigma)
    const field = curveField(
      [
        { minute: 60, human: 1, agent: 3 }, // the small morning bump
        { minute: 400, human: 0, agent: 4000 }, // the afternoon that fills the row
      ],
      grid,
      [60],
      sigma,
    )
    const peak = fieldPeak([field])
    const local = field.height[Math.round(60 / grid.step)] / peak
    const [spine] = spineHeights(field, peak)

    expect(Math.max(...field.height) / peak).toBe(1) // the rail does reach the top
    expect(local).toBeLessThan(SPINE_MIN_HEIGHT) // the bump under the spine does not
    expect(spine).toBeLessThanOrEqual(Math.max(SPINE_MIN_HEIGHT, local + SPINE_ACCENT))
  })

  it('bounds every spine by its own local curve plus the accent', () => {
    // The invariant, stated once over a whole rail of mixed heights: a spine is
    // its mound plus a tick, or the bare minimum where there is no mound. It is
    // never anything else, and in particular never floor-driven past its mound.
    const sigma = daySigma(720)
    const grid = curveGrid(720, sigma)
    const samples = [
      { minute: 30, human: 0, agent: 1 },
      { minute: 200, human: 0, agent: 40 },
      { minute: 500, human: 0, agent: 2000 },
    ]
    const spines = [30, 120, 200, 350, 500, 700]
    const field = curveField(samples, grid, spines, sigma)
    const peak = fieldPeak([field])
    const heights = spineHeights(field, peak)
    heights.forEach((h, i) => {
      const local = field.height[Math.round(field.spines[i] / grid.step)] / peak
      expect(h).toBeCloseTo(Math.min(1, Math.max(SPINE_MIN_HEIGHT, local + SPINE_ACCENT)), 10)
      expect(h).toBeLessThanOrEqual(Math.max(SPINE_MIN_HEIGHT, local + SPINE_ACCENT))
    })
  })

  it('stands proud of a mound it shares a column with, so the tip can be found', () => {
    const sigma = daySigma(60)
    const grid = curveGrid(60, sigma)
    const field = curveField([{ minute: 30, human: 1, agent: 40 }], grid, [30], sigma)
    // Measured against a page whose peak is elsewhere, so the local height has
    // room to be exceeded rather than clamped at the top of the row.
    const peak = fieldPeak([field]) * 2
    const local = field.height[Math.round(30 / grid.step)] / peak
    expect(spineHeights(field, peak)[0]).toBeCloseTo(local + SPINE_ACCENT, 10)
  })

  it('draws a message on empty paper at the minimum, whatever the rail did', () => {
    // The rail no longer enters at all: a busy rail and a quiet one floor an
    // unaccompanied message identically.
    const sigma = daySigma(60)
    const grid = curveGrid(60, sigma)
    const busy = curveField([{ minute: 30, human: 0, agent: 400 }], grid, [5], sigma)
    const quiet = curveField([{ minute: 30, human: 0, agent: 2 }], grid, [5], sigma)
    const peak = fieldPeak([busy, quiet])
    expect(spineHeights(busy, peak)).toEqual([SPINE_MIN_HEIGHT])
    expect(spineHeights(quiet, peak)).toEqual([SPINE_MIN_HEIGHT])
  })
})

describe('spineHeights — the clamps', () => {

  it('never exceeds the full row, however suppressed the peak it is measured against', () => {
    const sigma = daySigma(20)
    const grid = curveGrid(20, sigma)
    const field = curveField([{ minute: 10, human: 1, agent: 50 }], grid, [10], sigma)
    expect(spineHeights(field, PEAK_FLOOR)).toEqual([1])
  })

  it('gives one height per spine, in the field\'s own sorted order', () => {
    const sigma = daySigma(30)
    const grid = curveGrid(30, sigma)
    const field = curveField([{ minute: 5, human: 0, agent: 30 }], grid, [20, 5], sigma)
    const heights = spineHeights(field, fieldPeak([field]))
    expect(heights).toHaveLength(2)
    // Spine 5 stands in the burst; spine 20 is out on quiet paper at the floor.
    expect(heights[0]).toBeGreaterThan(heights[1])
    expect(heights[1]).toBe(SPINE_MIN_HEIGHT)
  })

  it('is empty for a field with no spines', () => {
    const sigma = daySigma(10)
    const grid = curveGrid(10, sigma)
    const field = curveField([{ minute: 4, human: 0, agent: 10 }], grid, [], sigma)
    expect(spineHeights(field, fieldPeak([field]))).toEqual([])
  })
})

describe('curveRuns / edgePath', () => {
  it('draws nothing at all for a field with no activity — silence is silent', () => {
    // The doctrine curveRuns exists for: an unbroken path used to draw a flat
    // cobalt rule across days with no activity at all, reading as "the agents
    // worked here, evenly, all day". A quiet field must yield no runs.
    const sigma = daySigma(20)
    const grid = curveGrid(20, sigma)
    const empty = curveField([], grid, [], sigma)
    expect(curveRuns(empty, fieldPeak([empty]))).toEqual([])
    expect(edgePath(curveRuns(empty, fieldPeak([empty])))).toBe('')
  })

  it("starts each run's edge with an M, and only the first point of the run", () => {
    const sigma = daySigma(20)
    const grid = curveGrid(20, sigma)
    const field = curveField([{ minute: 10, human: 0, agent: 5 }], grid, [], sigma)
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
    const sigma = daySigma(30)
    const grid = curveGrid(30, sigma)
    const field = curveField([{ minute: 15, human: 0, agent: 20 }], grid, [], sigma)
    const runs = curveRuns(field, fieldPeak([field]))
    expect(runs).toHaveLength(1)
    const [run] = runs
    // Within a hair of the baseline rather than exactly on it: the run keeps
    // the first point BELOW `QUIET`, which is a threshold and not zero, so the
    // touch-down carries whatever fraction of the peak that point held.
    expect(run[0].y).toBeGreaterThan(99)
    expect(run[run.length - 1].y).toBeGreaterThan(99)
    // And somewhere inside the run the ink actually rises off the baseline —
    // otherwise "one run" would be true of a run that never left it either.
    expect(Math.min(...run.map((p) => p.y))).toBeLessThan(100)
  })

  it('clamps every drawn point at the peak — no y climbs above the top of the rail', () => {
    // y = VIEW_H - min(1, height/scale) * VIEW_H, so no y should go negative
    // (above the top) however tall a burst is relative to the peak it is
    // being measured against, e.g. a peak suppressed below this field's own
    // height by page normalisation.
    const sigma = daySigma(10)
    const grid = curveGrid(10, sigma)
    const field = curveField([{ minute: 5, human: 0, agent: 50 }], grid, [], sigma)
    const suppressedPeak = PEAK_FLOOR // smaller than this field's real height
    const runs = curveRuns(field, suppressedPeak)
    for (const run of runs) for (const p of run) expect(p.y).toBeGreaterThanOrEqual(0)
  })
})

describe('spineWidths — rationing the eye, not the record', () => {
  // What Week's 468-message Monday proved: a hairline per message, drawn at
  // full weight regardless of company, turns a burst into a solid black wall
  // that says only "a lot happened" — the loudest thing on the page, and the
  // least informative. Falling as 1/sqrt(neighbours) keeps every message
  // exactly where it happened while rationing how much ink its mark spends —
  // width now, since alpha would have meant "we are not sure this happened"
  // and that is never true of a message that was sent.

  it('draws a lone spine at full weight — the maximum stroke width', () => {
    expect(spineWidths([50])).toEqual([2])
  })

  it('leaves two spines far apart both at full weight', () => {
    // Well outside the 7-minute crowd window on both sides.
    expect(spineWidths([0, 100])).toEqual([2, 2])
  })

  it('narrows in proportion to a small crowd — five together draw thinner than one alone', () => {
    // Falloff is 1/sqrt(neighbours) (five spines sharing a minute each see all
    // five as neighbours): 2/sqrt(5) ≈ 0.894 — thinner than a lone message's
    // stroke, and still well above the floor.
    const crowd = [0, 0, 0, 0, 0]
    const widths = spineWidths(crowd)
    const expected = 2 / Math.sqrt(5)
    expect(widths.every((w) => Math.abs(w - expected) < 1e-10)).toBe(true)
    expect(widths.every((w) => w > 0.75)).toBe(true)
  })

  it('bottoms out at the floor for a genuine crowd, rather than thinning to nothing', () => {
    // A message that happened must not disappear because other messages did
    // too — 200 sharing a minute would compute to 2/sqrt(200) ≈ 0.14 unfloored,
    // which the floor catches.
    const crowd = Array.from({ length: 200 }, () => 0)
    const widths = spineWidths(crowd)
    expect(widths.every((w) => w === 0.75)).toBe(true)
  })

  it('never falls below the floor for any crowd size', () => {
    for (const n of [1, 2, 5, 30, 500]) {
      const widths = spineWidths(Array.from({ length: n }, (_, i) => i * 0.01))
      expect(widths.every((w) => w >= 0.75)).toBe(true)
    }
  })

  it('is empty for no spines', () => {
    expect(spineWidths([])).toEqual([])
  })
})

describe('ladderRows — sessions are the floor, agents are the rungs above it', () => {
  const frame = { startMs: 0, endMs: 100_000 }
  const session = (start: number, end: number, open = false, label?: string): LadderInterval => ({
    start_ms: start,
    end_ms: end,
    open,
    kind: 'session',
    ...(label ? { label } : {}),
  })
  const agent = (start: number, end: number, open = false, label?: string): LadderInterval => ({
    start_ms: start,
    end_ms: end,
    open,
    kind: 'agent',
    ...(label ? { label } : {}),
  })

  it('gives one session one line at the bottom row', () => {
    expect(ladderRows([session(25_000, 75_000)], frame)).toEqual([
      { start: 0.25, end: 0.75, row: 0, kind: 'session', open: false, startMs: 25_000, endMs: 75_000 },
    ])
  })

  it('stacks overlapping sessions and reuses a row once one has ended', () => {
    const lines = ladderRows(
      [session(0, 50_000), session(10_000, 60_000), session(20_000, 30_000), session(70_000, 80_000)],
      frame,
    )
    // Three were aloft at 20s; the fourth starts after all of them ended and
    // so takes the row that freed up first.
    expect(lines.map((l) => l.row)).toEqual([0, 1, 2, 0])
  })

  it('does not count two that merely touch as concurrent', () => {
    const lines = ladderRows([session(0, 50_000), session(50_000, 90_000)], frame)
    expect(lines.map((l) => l.row)).toEqual([0, 0])
  })

  it("puts every agent line strictly above every session line, however the intervals fall", () => {
    // One session, and an agent that on the numbers alone would fit in row 0
    // — the whole claim of the packer is that it never gets to.
    const lines = ladderRows([session(0, 10_000), agent(20_000, 30_000)], frame)
    const sessionRows = lines.filter((l) => l.kind === 'session').map((l) => l.row)
    const agentRows = lines.filter((l) => l.kind === 'agent').map((l) => l.row)
    expect(Math.min(...agentRows)).toBeGreaterThan(Math.max(...sessionRows))
  })

  it('stacks overlapping agents above the sessions, packed independently of them', () => {
    const lines = ladderRows(
      [session(0, 100_000), agent(0, 40_000), agent(10_000, 60_000), agent(70_000, 80_000)],
      frame,
    )
    const agentLines = lines.filter((l) => l.kind === 'agent')
    // One session row (row 0), so the agents start at row 1: two concurrent at
    // first, the third reusing the freed row.
    expect(agentLines.map((l) => l.row)).toEqual([1, 2, 1])
    expect(lines.find((l) => l.kind === 'session')?.row).toBe(0)
  })

  it('clips an interval that straddles the frame and drops one wholly outside it', () => {
    const lines = ladderRows(
      [session(-40_000, 20_000), session(80_000, 400_000), session(200_000, 300_000)],
      frame,
    )
    expect(lines.map((l) => [l.start, l.end])).toEqual([
      [0, 0.2],
      [0.8, 1],
    ])
  })

  it('carries the real instants through as startMs/endMs, clipped to the frame', () => {
    const [line] = ladderRows([session(-40_000, 20_000)], frame)
    expect(line.startMs).toBe(0)
    expect(line.endMs).toBe(20_000)
  })

  it('carries the open flag and the label through, since an open span is a stub', () => {
    const [line] = ladderRows([agent(0, 5_000, true, 'sub-analysis')], frame)
    expect(line.open).toBe(true)
    expect(line.label).toBe('sub-analysis')
  })

  it('omits the label when none was given', () => {
    const [line] = ladderRows([session(0, 5_000)], frame)
    expect(line.label).toBeUndefined()
  })

  it('is empty for no spans', () => {
    expect(ladderRows([], frame)).toEqual([])
  })
})

describe('ladderHeight and ladderPitch', () => {
  it('reads the deepest ladder anywhere on the page', () => {
    expect(ladderHeight([[], [{ start: 0, end: 1, row: 0, kind: 'session', open: false, startMs: 0, endMs: 1 }]])).toBe(1)
    expect(
      ladderHeight([
        [{ start: 0, end: 1, row: 2, kind: 'agent', open: false, startMs: 0, endMs: 1 }],
        [{ start: 0, end: 1, row: 0, kind: 'session', open: false, startMs: 0, endMs: 1 }],
      ]),
    ).toBe(3)
  })

  it('holds the pitch at zero while the ladder is a single row or shallower', () => {
    expect(ladderPitch(0)).toBe(0)
    expect(ladderPitch(1)).toBe(0)
  })

  it('closes the pitch up as the ladder deepens, clamped between 1 and 2.5', () => {
    expect(ladderPitch(2)).toBe(3) // 14/(2-1) = 14, clamped down to the ceiling
    expect(ladderPitch(20)).toBeLessThan(3)
    expect(ladderPitch(20)).toBeGreaterThanOrEqual(1)
    expect(ladderPitch(200)).toBe(1) // clamped to the floor
  })
})
