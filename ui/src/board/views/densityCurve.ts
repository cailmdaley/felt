/**
 * The activity curve — how Day and Week draw a stretch of time.
 *
 * THE OLD GRAMMAR WAS RUNS. A minute in which an agent worked became a wash
 * block, a minute in which you typed became a solid one, and neighbouring
 * minutes were bridged into strokes so the eye read them as a single stretch of
 * work. It said only one thing per minute — busy or not — and it said it
 * loudest for whoever emitted the most events, which is always the machine.
 *
 * THE CURVE SAYS TWO THINGS, on two channels that cannot compete because they
 * are about two different subjects:
 *
 *   HEIGHT   how much the MACHINES did — agent events alone, smoothed with a
 *            tight kernel because the machine's timing is precise, then
 *            compressed so a fifty-event minute does not flatten the rest of
 *            the day into the baseline. One pigment the whole way: the curve is
 *            a picture of agent work, and a colour scale over it was answering
 *            a question the spines already answer better.
 *
 *   SPINES   exactly when YOU spoke. Rare discrete marks on a continuous field,
 *            drawn in CINNABAR over the wash: the board's attention pigment,
 *            because a message of yours is the one event on the rail that was
 *            addressed to somebody. Iron gall carried this before, and it was
 *            the highest-contrast ink available — but it is also the ink every
 *            rule, bullet and gridline on the page is drawn in, so the spine
 *            read as chrome standing up. A spine rises
 *            to the CURVE'S OWN HEIGHT at that minute — your message is drawn
 *            inside the work it landed in, not over the top of the row — with a
 *            floor under it ({@link SPINE_MIN_HEIGHT}) so a message sent while
 *            nothing was running is still a mark you can see and point at.
 *
 * Human events are therefore NOT in the height field at all. They were, once,
 * along with a whole colour channel that painted their neighbourhood teal; both
 * are gone. One message among four hundred tool calls moved the height by
 * nothing and the colour by everything, and the honest form of "one message
 * happened here" turned out to be one line at one minute.
 *
 * Replies are not spines either. A reply is the agent's message, not your
 * attention, so it counts toward height like any other agent event.
 *
 * Nothing here touches the DOM except {@link buildCurveSvg}, and nothing here
 * knows what a fiber is — the two views hand it minutes and weights and get
 * back a shape. Every function above the renderer is pure, which is how the
 * bandwidth and the spine geometry are testable without a browser.
 */

// ── The pigment ──────────────────────────────────────────────────────────────

/**
 * The one colour the curve is drawn in — the board's cobalt, stepped until it
 * passes the palette checks against parchment (#FBF6E9).
 *
 * There is no second pole. The teal that used to sit opposite it belonged to a
 * colour channel that read the human signal, and the human signal is the spines
 * now; a lone pigment with nothing to be compared against needs only to clear
 * contrast on paper, which this does.
 */
export const CURVE_AGENT = '#3D5BA0'

// ── The parameters ───────────────────────────────────────────────────────────

/**
 * Kernel width for the HEIGHT channel, in minutes — now one per view rather
 * than a single constant, because Day and Week disagreed about what "tight"
 * means. A width that kept Day's rail crisp turned Week's rail, which spans
 * seven times the minutes over the same 1000 units of path, into a jagged
 * saw: the same sigma is a much narrower fraction of Week's rail than of
 * Day's, so what read as an edge on Day read as noise on Week.
 *
 * Tune these directly — each is a one-line knob, not a formula to solve.
 */

/**
 * Day's kernel width, in minutes. Tight: an agent's events are stamped when
 * they happened and mean what they say, so smoothing them further would only
 * blur a signal that is already honest.
 *
 * Tightened from 1.6 by looking at a real day: at that width a burst and the
 * two quiet minutes beside it merged into one soft mound, and the rail read
 * as a weather map rather than as work. Tightened again from 1.25 to 0.75
 * when the mounds still read as soft "little prince elephants" rather than
 * work with edges.
 */
export const SIGMA_DAY_MINUTES = 0.75

/**
 * Week's kernel width, in minutes. Broader than Day's on purpose: a week's
 * rail draws seven days of minutes into the same 1000 units of path, so a
 * sigma tuned for Day's resolution is a much narrower fraction of Week's
 * rail and reads as jagged sawtooth rather than a curve. 3.0 is a starting
 * point for taste iteration, not a derived number.
 */
export const SIGMA_WEEK_MINUTES = 3.0

/**
 * The floor under the per-view normaliser, in compressed units — `log1p(4)`.
 *
 * Without it a day holding one single event would normalise against itself and
 * draw that event as a full-height mountain. The floor says: four events in a
 * minute is the least that gets to fill a rail.
 */
export const PEAK_FLOOR = Math.log1p(4)

/**
 * The shortest a spine may be drawn, as a fraction of the row's height.
 *
 * A spine reads the curve under it, and the curve is frequently zero there —
 * you write to an agent that is not running, which is how a great many
 * conversations start. At the true height that message would be a mark of zero
 * pixels: the event that matters most on the rail, invisible. So the floor,
 * chosen by looking: below about a quarter the row a 2px line reads as grit on
 * the paper, and above about a third it stops being distinguishable from a
 * spine standing in real work. 0.3 sits between.
 */
export const SPINE_MIN_HEIGHT = 0.3

/** Kernels are evaluated out to this many sigmas and cut. Beyond 4σ a Gaussian
 *  contributes under 0.04% and only costs time. */
const KERNEL_REACH_SIGMAS = 4

// ── The field ────────────────────────────────────────────────────────────────

/** Events at a moment. `human` is carried separately from `agent` because the
 *  two become two different marks — the agents become the curve, you become the
 *  spines. `minute` is offset from the frame's start. */
export interface ActivitySample {
  minute: number
  human: number
  agent: number
}

/** Where the curve is evaluated: `count` points, `step` minutes apart, the
 *  first at minute 0 of the frame. */
export interface CurveGrid {
  step: number
  count: number
}

/** A lane's curve before it knows how tall it is allowed to be. Normalisation
 *  is a property of the PAGE, not of the lane — see {@link fieldPeak}. */
export interface CurveField {
  grid: CurveGrid
  /** Compressed agent density at each grid point. */
  height: number[]
  /** Minutes you spoke in, ascending — where the spines go. */
  spines: number[]
}

/**
 * The grid may never be coarser than this many minutes per step — fine
 * enough that {@link SIGMA_DAY_MINUTES}, the narrowest kernel drawn anywhere
 * on the board, is not under-sampled. A discrete grid samples a genuinely
 * continuous Gaussian (the kernel is evaluated at each grid point from the
 * event's real, unbinned minute), so a step finer than the minute samples
 * arrive at is not wasted precision — it is resolution the curve's shape
 * actually has.
 *
 * Driven off Day's sigma specifically, not Week's, because Day is the
 * narrower kernel and the tighter constraint: a floor that satisfies Day
 * satisfies Week for free. `/1.5` rather than `/KERNEL_REACH_SIGMAS` keeps
 * several points inside even the steepest part of the curve (the flank
 * within one sigma of a spike) without chasing sub-pixel precision no rail
 * could show.
 */
const GRID_STEP_FLOOR_MINUTES = SIGMA_DAY_MINUTES / 1.5

/**
 * A sampling grid for a frame, fine enough that the tightest kernel on the
 * board ({@link GRID_STEP_FLOOR_MINUTES}) is not under-sampled and coarse
 * enough that a long frame is not a hundred thousand path commands. The step
 * only widens past the floor once a frame is long enough that holding it
 * would blow {@link MAX_GRID_POINTS} — a day's frame (1440 minutes) sits
 * comfortably under that at the floor step, so Day gets the fine grid its
 * narrow sigma needs and nothing has to ask for it specially.
 */
const MAX_GRID_POINTS = 2880

export function curveGrid(frameMinutes: number): CurveGrid {
  const minutes = Math.max(1, Math.ceil(frameMinutes))
  const step = Math.max(GRID_STEP_FLOOR_MINUTES, minutes / MAX_GRID_POINTS)
  return { step, count: Math.floor(minutes / step + 1e-9) + 1 }
}

/**
 * Smear weighted events over the grid with an UNNORMALISED Gaussian, so a lone
 * event of weight 1 peaks at exactly 1.
 *
 * The usual normalised kernel would make the peak depend on the bandwidth,
 * which would silently couple what a lone event looks like to a tuning
 * constant. Here the bandwidth changes how far a signal reaches and never how
 * loud it is.
 */
export function smear(
  samples: readonly ActivitySample[],
  weight: (s: ActivitySample) => number,
  sigma: number,
  grid: CurveGrid,
): number[] {
  const out = new Array<number>(grid.count).fill(0)
  if (sigma <= 0) return out
  const reach = KERNEL_REACH_SIGMAS * sigma
  const twoSigmaSq = 2 * sigma * sigma
  for (const sample of samples) {
    const n = weight(sample)
    if (n <= 0) continue
    const from = Math.max(0, Math.ceil((sample.minute - reach) / grid.step))
    const to = Math.min(grid.count - 1, Math.floor((sample.minute + reach) / grid.step))
    for (let i = from; i <= to; i += 1) {
      const d = i * grid.step - sample.minute
      out[i] += n * Math.exp(-(d * d) / twoSigmaSq)
    }
  }
  return out
}

/**
 * One lane's field. Height is `log1p` of the agent density — the compression
 * that keeps a burst of fifty tool calls from flattening a quiet afternoon into
 * the baseline, while leaving the small end nearly linear so single events
 * still differ from pairs.
 */
export function curveField(
  samples: readonly ActivitySample[],
  grid: CurveGrid,
  spines: readonly number[],
  sigma: number,
): CurveField {
  const agent = smear(samples, (s) => s.agent, sigma, grid)
  return {
    grid,
    height: agent.map((d) => Math.log1p(d)),
    spines: [...new Set(spines)].sort((a, b) => a - b),
  }
}

/**
 * The height every lane on a page is measured against — the tallest moment
 * anywhere on it, floored.
 *
 * Per PAGE and not per lane, deliberately: normalising each rail to its own
 * maximum would draw a fiber that saw four events and a fiber that saw four
 * hundred at the same height, and the whole point of stacking the rails is that
 * they can be compared down the column.
 */
export function fieldPeak(fields: readonly CurveField[]): number {
  let peak = PEAK_FLOOR
  for (const field of fields) {
    for (const h of field.height) if (h > peak) peak = h
  }
  return peak
}

/**
 * How tall each spine is drawn, as a fraction of the row — the curve's own
 * height at that minute, floored at {@link SPINE_MIN_HEIGHT}.
 *
 * Reading the FIELD rather than the drawn path: the path is cut into runs and
 * is simply absent over a quiet stretch, and a spine there still needs a
 * number. The field answers everywhere.
 *
 * The grid point is the nearest one, not an interpolation between two. At one
 * point per minute the nearest point IS the minute; at a week's coarser grid
 * the difference is a fraction of a pixel of height on a mark whose meaning is
 * its horizontal position.
 */
export function spineHeights(field: CurveField, peak: number): number[] {
  const scale = peak > 0 ? peak : 1
  const last = field.grid.count - 1
  return field.spines.map((minute) => {
    const i = Math.min(last, Math.max(0, Math.round(minute / field.grid.step)))
    const h = Math.min(1, (field.height[i] ?? 0) / scale)
    return Math.max(SPINE_MIN_HEIGHT, h)
  })
}

// ── The mark ─────────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg'

/** The curve is drawn in its own coordinate space and stretched to the rail, so
 *  a lane's geometry is CSS's business and the path's is arithmetic's. */
const VIEW_W = 1000
const VIEW_H = 100

export interface CurveSvgOptions {
  /** Extra classes on the `<svg>`, after `kbn-curve`. */
  className?: string
  /** Minutes in the frame, for placing spines at their true position. */
  frameMinutes: number
}

/**
 * One lane's curve as an `<svg>`: a washed area under a drawn edge, and the
 * spines over the top.
 *
 * The area and the edge are two paths rather than one filled-and-stroked path
 * because a stroke would also run down the two vertical sides and along the
 * baseline, boxing the curve in — and the board draws no borders around marks.
 *
 * `preserveAspectRatio="none"` is what lets the same 1000×100 arithmetic serve
 * a rail of any width; the spines carry `vector-effect="non-scaling-stroke"` so
 * that stretch cannot smear a line into a band.
 */
export function buildCurveSvg(
  field: CurveField,
  peak: number,
  opts: CurveSvgOptions,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', `kbn-curve${opts.className ? ` ${opts.className}` : ''}`)
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('aria-hidden', 'true')

  const runs = curveRuns(field, peak)
  if (runs.length > 0) {
    const area = document.createElementNS(SVG_NS, 'path')
    area.setAttribute('class', 'kbn-curve-area')
    area.setAttribute('d', areaPath(runs))
    area.setAttribute('fill', CURVE_AGENT)
    svg.append(area)

    const line = document.createElementNS(SVG_NS, 'path')
    line.setAttribute('class', 'kbn-curve-edge')
    line.setAttribute('d', edgePath(runs))
    line.setAttribute('fill', 'none')
    line.setAttribute('stroke', CURVE_AGENT)
    line.setAttribute('vector-effect', 'non-scaling-stroke')
    svg.append(line)
  }

  const span = Math.max(1, opts.frameMinutes)
  const alphas = spineAlphas(field.spines)
  const heights = spineHeights(field, peak)
  field.spines.forEach((minute, i) => {
    if (minute < 0 || minute > span) return
    const x = (minute / span) * VIEW_W
    const spine = document.createElementNS(SVG_NS, 'line')
    spine.setAttribute('class', 'kbn-curve-spine')
    spine.setAttribute('x1', x.toFixed(2))
    spine.setAttribute('x2', x.toFixed(2))
    spine.setAttribute('y1', (VIEW_H * (1 - heights[i])).toFixed(2))
    spine.setAttribute('y2', String(VIEW_H))
    spine.setAttribute('opacity', alphas[i].toFixed(3))
    spine.setAttribute('vector-effect', 'non-scaling-stroke')
    svg.append(spine)
  })
  return svg
}

/** Below this fraction of the page's peak a moment counts as nothing happening,
 *  and the curve is not drawn there at all. */
const QUIET = 0.004

export interface CurvePoint {
  x: number
  y: number
}

/**
 * The curve, cut into the stretches where something actually happened.
 *
 * ONE UNBROKEN PATH WAS A LIE — the first thing looking at Week said. A day
 * with no activity still drew its edge stroke flat along the baseline, so four
 * empty days at the bottom of the week each wore a solid cobalt rule that read
 * as "the agents worked here, evenly, all day". Silence has to be silent, so
 * the curve exists only above {@link QUIET} and the paper carries the rest.
 *
 * Each run keeps the first quiet point on either side, so a stretch of work
 * touches down on the baseline instead of starting and ending in mid-air.
 */
export function curveRuns(field: CurveField, peak: number): CurvePoint[][] {
  const scale = peak > 0 ? peak : 1
  const span = Math.max(1, (field.grid.count - 1) * field.grid.step)
  const at = (i: number): CurvePoint => ({
    x: ((i * field.grid.step) / span) * VIEW_W,
    y: VIEW_H - Math.min(1, field.height[i] / scale) * VIEW_H,
  })

  const runs: CurvePoint[][] = []
  let run: CurvePoint[] | null = null
  for (let i = 0; i < field.grid.count; i += 1) {
    const loud = field.height[i] / scale > QUIET
    if (loud) {
      if (!run) {
        run = []
        if (i > 0) run.push(at(i - 1))
        runs.push(run)
      }
      run.push(at(i))
    } else if (run) {
      run.push(at(i))
      run = null
    }
  }
  return runs
}

/** The drawn edge: one subpath per run, nothing between them. */
export function edgePath(runs: readonly CurvePoint[][]): string {
  return runs
    .map((run) => run.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' '))
    .join(' ')
}

/** The wash beneath it: each run closed down to the baseline and back. */
export function areaPath(runs: readonly CurvePoint[][]): string {
  return runs
    .map((run) => {
      const first = run[0]
      const last = run[run.length - 1]
      const top = run.map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ')
      return `M ${first.x.toFixed(2)} ${VIEW_H} ${top} L ${last.x.toFixed(2)} ${VIEW_H} Z`
    })
    .join(' ')
}

/**
 * How near two spines have to be, in minutes, for each to count as crowding
 * the other. Roughly the span in which a burst of messages reads as one act of
 * talking rather than as separate events.
 *
 * WIDENED FROM FOUR WHEN THE SPINE BECAME CINNABAR. The window is not really a
 * fact about conversation — it is how far the ink's claim on the eye reaches,
 * and cinnabar reaches further than iron gall did. At four minutes a talkative
 * evening on Week's day-wide rail crowded only in threes and fours, which left
 * every spine near full weight and filled the mound solid red. At seven the
 * same evening thins to a pink texture while a message sent on its own — the
 * mark this channel exists for — is untouched, because a lone spine is lone at
 * any window.
 */
const SPINE_CROWD_MINUTES = 7

/** A lone spine's weight. Everything else is measured down from it. */
const SPINE_ALPHA = 0.82

/**
 * The faintest a crowded spine draws. Below this it would vanish, and a
 * message that happened must not disappear because other messages did too.
 *
 * Lowered slightly (0.09 → 0.07) when the spine became cinnabar, for the
 * opposite of the obvious reason. Raising it was tried first, on the theory
 * that a lighter pigment needs more floor to stay visible — and it made a busy
 * evening WORSE, because cinnabar's problem at crowd scale is not that it
 * vanishes but that it accumulates. The floor is the last resort for a true
 * pile-up; the work of rationing a crowd is done by
 * {@link SPINE_CROWD_MINUTES}, which is the parameter that actually moved.
 */
const SPINE_ALPHA_FLOOR = 0.07

/**
 * Per-spine opacity, falling as spines crowd each other.
 *
 * A SPINE IS SALIENT BECAUSE IT IS RARE, and Week proved what happens when it
 * is not: a Monday with 468 messages drew 468 lines across a 1400-pixel rail
 * and produced a solid black band — the loudest thing on the page, saying only
 * "a lot". So weight falls as `1/neighbours`: one message stays full cinnabar,
 * and a burst of thirty inside four minutes bottoms out at the floor and reads
 * as a grey texture. Nothing is dropped and nothing is merged — every message
 * is still exactly where it happened, and a burst still looks like a burst.
 * Only the claim on your eye is rationed.
 *
 * `1/sqrt` was the first try and was not enough: at week scale the lines still
 * overlapped into a picket fence, and overlapping alpha compounds. Linear is
 * the falloff that makes the SOLITARY message the loudest mark on the page,
 * which is the whole point of the channel.
 *
 * THE FLOOR IS NOT THE KNOB. Monday's 468-message evening is drawn the same at
 * 0.09 and at 0.05 and at 0.15, because at week resolution that wall's spines
 * crowd in threes and fours and never reach the floor at all — everything
 * visible about a crowd is decided by the WINDOW. The floor binds only for a
 * true pile-up, which is the case it was written for; twice it has been reached
 * for to fix a crowd, and twice the crowd was unmoved.
 */
export function spineAlphas(spines: readonly number[]): number[] {
  // A sliding window rather than the obvious pair loop: `curveField` sorts the
  // spines, and a day of five hundred messages should not cost a quarter of a
  // million comparisons to draw.
  const out = new Array<number>(spines.length)
  let lo = 0
  let hi = 0
  for (let i = 0; i < spines.length; i += 1) {
    while (spines[lo] < spines[i] - SPINE_CROWD_MINUTES) lo += 1
    while (hi < spines.length && spines[hi] <= spines[i] + SPINE_CROWD_MINUTES) hi += 1
    out[i] = Math.max(SPINE_ALPHA_FLOOR, SPINE_ALPHA / Math.max(1, hi - lo))
  }
  return out
}

// ── The delegations aloft ────────────────────────────────────────────────────
//
// A third channel, and the only one that is not about a moment: HOW MANY
// AGENTS WERE OUT. The curve says the machines were busy and the spines say
// you spoke, but a five-way fan-out and one long tool call make identical ink
// — and the difference between them is most of what a day of orchestration
// is. So each delegation gets one solid line spanning its real duration, and
// concurrent ones stack UP FROM THE LANE'S BASELINE: one agent is one line,
// five at once is five courses, and none is nothing at all.
//
// Stacking is an interval-graph colouring, done greedily on a start-sorted
// list: each delegation takes the lowest row it does not collide in. Greedy is
// optimal here (this is the classic interval-partitioning result), so the
// stack is exactly as deep as the concurrency was — never deeper, which is the
// whole claim the channel makes.

/** One delegation ready to draw: horizontal extent as fractions of the frame,
 *  and which row of the stack it sits in. */
export interface SpawnLine {
  /** 0…1 across the frame. */
  start: number
  end: number
  /** 0 is the topmost line; each further row is one concurrent neighbour. */
  row: number
  /** Its close was never recorded — the length is a stub, not a duration. */
  open: boolean
}

/** The interval as the stacker needs it: two instants and whether it closed. */
export interface SpawnInterval {
  start_ms: number
  end_ms: number
  open: boolean
}

/**
 * Lay a lane's delegations out in rows, clipped to `[startMs, endMs]`.
 *
 * Intervals that fall wholly outside the frame are dropped; one that straddles
 * an edge is clipped, because the frame is the claim being made. Sorted by
 * start, so the row assignment is deterministic and two renders of the same
 * data cannot disagree about which line is which.
 */
export function stackSpawns(
  spans: readonly SpawnInterval[],
  frame: { startMs: number; endMs: number },
): SpawnLine[] {
  const span = Math.max(1, frame.endMs - frame.startMs)
  const inside = spans
    .filter((s) => s.end_ms >= frame.startMs && s.start_ms <= frame.endMs)
    .map((s) => ({
      startMs: Math.max(s.start_ms, frame.startMs),
      endMs: Math.min(s.end_ms, frame.endMs),
      open: s.open,
    }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)

  // The instant each row is free from. A row is reusable the moment its last
  // delegation ended — two that merely touch are not concurrent.
  const freeFrom: number[] = []
  const lines: SpawnLine[] = []
  for (const s of inside) {
    let row = freeFrom.findIndex((at) => at <= s.startMs)
    if (row === -1) row = freeFrom.length
    freeFrom[row] = s.endMs
    lines.push({
      start: (s.startMs - frame.startMs) / span,
      end: (s.endMs - frame.startMs) / span,
      row,
      open: s.open,
    })
  }
  return lines
}

/** How deep the deepest stack on a page goes — one more than the largest row
 *  index anywhere on it. Per PAGE, like {@link fieldPeak}: the pitch the lines
 *  are drawn at has to be one number, or two lanes' stacks could not be
 *  compared down the column. */
export function stackDepth(lanes: readonly (readonly SpawnLine[])[]): number {
  let depth = 0
  for (const lines of lanes) {
    for (const line of lines) if (line.row + 1 > depth) depth = line.row + 1
  }
  return depth
}

/** The band the stack is allowed, in pixels, measured UP from the rail's
 *  baseline. Deliberately under half the rail's height: these lines are strata
 *  under the curve, and a stack that climbed into it would compete with it. */
export const STACK_BAND_PX = 9

/** The gap between neighbouring lines. Two pixels while the stack is shallow —
 *  the pitch at which one line reads as one agent — closing up only once a
 *  fan-out is deep enough that its DEPTH is the thing being read. */
export function stackPitch(depth: number): number {
  if (depth <= 1) return 0
  return Math.max(1, Math.min(2, STACK_BAND_PX / (depth - 1)))
}
