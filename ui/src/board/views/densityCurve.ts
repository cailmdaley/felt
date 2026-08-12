/**
 * The activity curve — how Day and Week draw a stretch of time.
 *
 * THE OLD GRAMMAR WAS RUNS. A minute in which an agent worked became a wash
 * block, a minute in which you typed became a solid one, and neighbouring
 * minutes were bridged into strokes so the eye read them as a single stretch of
 * work. It said only one thing per minute — busy or not — and it said it
 * loudest for whoever emitted the most events, which is always the machine.
 *
 * THE CURVE SAYS THREE THINGS AT ONCE, on three channels that do not compete:
 *
 *   HEIGHT   how much happened — agent events and human events together,
 *            smoothed with a tight kernel because the machine's timing is
 *            precise, then compressed so a fifty-event minute does not flatten
 *            the rest of the day into the baseline.
 *
 *   COLOUR   how much of it was YOU — and this is the doctrine the whole
 *            design turns on: colour reads the HUMAN signal ALONE, never a
 *            share or a ratio. Hundreds of agent events must never drown one
 *            human message. So a single message paints its neighbourhood teal
 *            whatever the machine was doing underneath it. The human kernel is
 *            deliberately WIDE — we do not honestly know your engagement at
 *            sub-five-minute resolution; you were reading before you typed and
 *            you were reading after.
 *
 *   SPINES   exactly when you spoke. Rare discrete marks on a continuous
 *            field, drawn on top in iron gall: the most salient thing on the
 *            rail, because it is the rarest and the most yours.
 *
 * Replies are NOT spines. A reply is the agent's message, not your attention;
 * it counts toward height and toward the agent side of the colour, which is
 * where the machine's half of the conversation belongs.
 *
 * Nothing here touches the DOM except {@link buildCurveSvg}, and nothing here
 * knows what a fiber is — the two views hand it minutes and weights and get
 * back a shape. Every function above the renderer is pure, which is how the
 * bandwidths and the saturation curve are testable without a browser.
 */

// ── The pigments ─────────────────────────────────────────────────────────────

/**
 * The two poles the colour channel runs between — the board's cobalt and teal,
 * stepped until they pass the palette checks against parchment (#FBF6E9).
 *
 * The teal is a notch deeper than the board's #3F8278: that step reads as gray
 * under the chroma floor (C 0.07) and sits at ΔE 14.9 from the cobalt, below
 * the normal-vision floor of 15. #0F8A74 is the same pigment carried far enough
 * to clear both — C 0.11, ΔE 17.6 normal / 15.5 deutan, contrast ≥ 3:1 on
 * parchment. The mid-blend between them is a blend, not a third category: it is
 * checked for lightness band and surface contrast, not for separation from its
 * own endpoints.
 */
export const CURVE_AGENT = '#3D5BA0'
export const CURVE_HUMAN = '#0F8A74'

// ── The parameters ───────────────────────────────────────────────────────────

/**
 * Kernel width for the HEIGHT channel, in minutes. Tight: an agent's events are
 * stamped when they happened and mean what they say, so smoothing them further
 * would only blur a signal that is already honest.
 */
export const SIGMA_TOTAL_MINUTES = 1.6

/**
 * Kernel width for the COLOUR channel, in minutes. Wide, and wide on purpose —
 * see the module doc. A message at 14:03 tints roughly 13:53 → 14:13, which is
 * the smallest window in which "you were engaged here" is a claim we can make.
 */
export const SIGMA_HUMAN_MINUTES = 5

/**
 * How much smoothed human density it takes to paint fully teal — the constant
 * in `mix = 1 - exp(-h / HUMAN_HALF_LIFE)`.
 *
 * A lone message peaks its own kernel at 1.0, so at 0.7 one message reads 76%
 * human at the instant it was sent, and its neighbourhood is still visibly
 * yours five minutes out. That is the doctrine made arithmetic: one of yours
 * outweighs any amount of theirs, because the machine's volume is not an input
 * to this channel at all.
 *
 * TUNED BY LOOKING. At 0.45 a single message painted ±8 minutes almost pure
 * teal, and a normal evening of two dozen messages came out teal end to end —
 * the channel was saturated, so it had stopped saying anything. Larger is
 * narrower here (the threshold density rises), and 0.7 keeps a lone message
 * unmistakably yours while leaving a genuinely unattended half-hour cobalt.
 */
export const HUMAN_HALF_LIFE = 0.7

/**
 * The floor under the per-view normaliser, in compressed units — `log1p(4)`.
 *
 * Without it a day holding one single event would normalise against itself and
 * draw that event as a full-height mountain. The floor says: four events in a
 * minute is the least that gets to fill a rail.
 */
export const PEAK_FLOOR = Math.log1p(4)

/** Kernels are evaluated out to this many sigmas and cut. Beyond 4σ a Gaussian
 *  contributes under 0.04% and only costs time. */
const KERNEL_REACH_SIGMAS = 4

// ── The field ────────────────────────────────────────────────────────────────

/** Events at a moment, split the only way the colour channel cares about:
 *  yours, and everything else's. `minute` is offset from the frame's start. */
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
  /** Compressed total density at each grid point. */
  height: number[]
  /** Human-only mix at each grid point, 0 (all machine) → 1 (all you). */
  mix: number[]
  /** Minutes you spoke in, ascending — where the spines go. */
  spines: number[]
}

/**
 * A sampling grid for a frame, fine enough that the tight kernel is not
 * under-sampled and coarse enough that a week of rails is not a hundred
 * thousand path commands. One point per minute until a frame passes
 * {@link MAX_GRID_POINTS}, then as coarse as it must be.
 */
const MAX_GRID_POINTS = 720

export function curveGrid(frameMinutes: number): CurveGrid {
  const minutes = Math.max(1, Math.ceil(frameMinutes))
  const step = Math.max(1, Math.ceil(minutes / MAX_GRID_POINTS))
  return { step, count: Math.floor(minutes / step) + 1 }
}

/**
 * Smear weighted events over the grid with an UNNORMALISED Gaussian, so a lone
 * event of weight 1 peaks at exactly 1.
 *
 * The usual normalised kernel would make the peak depend on the bandwidth,
 * which would silently couple the colour doctrine to a tuning constant: widen
 * the human kernel and one message would stop reading as human. Here the two
 * bandwidths change how far a signal reaches and never how loud it is.
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

/** How much of this moment was you: saturating in human density alone, with no
 *  term for the machine anywhere in it. See {@link HUMAN_HALF_LIFE}. */
export function humanMix(density: number): number {
  if (density <= 0) return 0
  return 1 - Math.exp(-density / HUMAN_HALF_LIFE)
}

/**
 * One lane's field. Height is `log1p` of the total density — the compression
 * that keeps a burst of fifty tool calls from flattening a quiet afternoon into
 * the baseline, while leaving the small end nearly linear so single events
 * still differ from pairs.
 */
export function curveField(
  samples: readonly ActivitySample[],
  grid: CurveGrid,
  spines: readonly number[],
): CurveField {
  const total = smear(samples, (s) => s.human + s.agent, SIGMA_TOTAL_MINUTES, grid)
  const human = smear(samples, (s) => s.human, SIGMA_HUMAN_MINUTES, grid)
  return {
    grid,
    height: total.map((d) => Math.log1p(d)),
    mix: human.map(humanMix),
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

// ── Colour ───────────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const AGENT_RGB = hexToRgb(CURVE_AGENT)
const HUMAN_RGB = hexToRgb(CURVE_HUMAN)

/** The pole-to-pole blend at a given mix, as `#rrggbb`. Both poles sit at
 *  nearly the same lightness, so a straight sRGB walk between them stays inside
 *  the band the whole way and never dips through a muddy midpoint. */
export function mixHex(mix: number): string {
  const t = Math.min(1, Math.max(0, mix))
  const parts = AGENT_RGB.map((a, i) => Math.round(a + (HUMAN_RGB[i] - a) * t))
  return `#${parts.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/**
 * The gradient stops for a field: the colour walk quantised into
 * {@link MIX_STEPS} levels, with a stop emitted only where the level actually
 * changes.
 *
 * A stop per grid point would be correct and would also be seven hundred DOM
 * nodes per rail. Quantising costs a band edge no eye can find and buys two
 * orders of magnitude — a normal day's lane comes out at a handful of stops,
 * because most of a day is entirely one pigment or the other.
 */
const MIX_STEPS = 24

export interface GradientStop {
  /** Position along the rail, 0…1. */
  offset: number
  color: string
}

export function gradientStops(field: CurveField): GradientStop[] {
  const span = Math.max(1, (field.grid.count - 1) * field.grid.step)
  const stops: GradientStop[] = []
  let last = -1
  for (let i = 0; i < field.grid.count; i += 1) {
    const level = Math.round(field.mix[i] * MIX_STEPS)
    if (level === last && i > 0) continue
    last = level
    stops.push({ offset: (i * field.grid.step) / span, color: mixHex(level / MIX_STEPS) })
  }
  // A gradient with one stop paints nothing in some engines; a rail that never
  // saw a human message is legitimately one flat colour, so say it twice.
  if (stops.length === 1) stops.push({ offset: 1, color: stops[0].color })
  return stops
}

// ── The mark ─────────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg'

/** The curve is drawn in its own coordinate space and stretched to the rail, so
 *  a lane's geometry is CSS's business and the path's is arithmetic's. */
const VIEW_W = 1000
const VIEW_H = 100

export interface CurveSvgOptions {
  /** Unique within the document — the gradient is referenced by id. */
  id: string
  /** Extra classes on the `<svg>`, after `kbn-curve`. */
  className?: string
  /** Minutes in the frame, for placing spines at their true position. */
  frameMinutes: number
}

/**
 * One lane's curve as an `<svg>`: a washed area under a drawn edge, both
 * carrying the same left-to-right gradient, and the spines over the top.
 *
 * The area and the edge are two paths rather than one filled-and-stroked path
 * because a stroke would also run down the two vertical sides and along the
 * baseline, boxing the curve in — and the board draws no borders around marks.
 *
 * `preserveAspectRatio="none"` is what lets the same 1000×100 arithmetic serve
 * a rail of any width; the spines carry `vector-effect="non-scaling-stroke"` so
 * that stretch cannot smear a hairline into a band.
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

  const defs = document.createElementNS(SVG_NS, 'defs')
  const grad = document.createElementNS(SVG_NS, 'linearGradient')
  grad.setAttribute('id', opts.id)
  // Along the rail, in the rail's own box rather than the path's bounding box:
  // a lane whose work all happened before noon would otherwise squeeze the
  // whole colour walk into its left half.
  grad.setAttribute('gradientUnits', 'userSpaceOnUse')
  grad.setAttribute('x1', '0')
  grad.setAttribute('x2', String(VIEW_W))
  for (const stop of gradientStops(field)) {
    const el = document.createElementNS(SVG_NS, 'stop')
    el.setAttribute('offset', stop.offset.toFixed(4))
    el.setAttribute('stop-color', stop.color)
    grad.append(el)
  }
  defs.append(grad)
  svg.append(defs)

  const runs = curveRuns(field, peak)
  if (runs.length > 0) {
    const area = document.createElementNS(SVG_NS, 'path')
    area.setAttribute('class', 'kbn-curve-area')
    area.setAttribute('d', areaPath(runs))
    area.setAttribute('fill', `url(#${opts.id})`)
    svg.append(area)

    const line = document.createElementNS(SVG_NS, 'path')
    line.setAttribute('class', 'kbn-curve-edge')
    line.setAttribute('d', edgePath(runs))
    line.setAttribute('fill', 'none')
    line.setAttribute('stroke', `url(#${opts.id})`)
    line.setAttribute('vector-effect', 'non-scaling-stroke')
    svg.append(line)
  }

  const span = Math.max(1, opts.frameMinutes)
  const alphas = spineAlphas(field.spines)
  field.spines.forEach((minute, i) => {
    if (minute < 0 || minute > span) return
    const x = (minute / span) * VIEW_W
    const spine = document.createElementNS(SVG_NS, 'line')
    spine.setAttribute('class', 'kbn-curve-spine')
    spine.setAttribute('x1', x.toFixed(2))
    spine.setAttribute('x2', x.toFixed(2))
    spine.setAttribute('y1', '0')
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

/** How near two spines have to be, in minutes, for each to count as crowding
 *  the other. Roughly the span in which a burst of messages reads as one act
 *  of talking rather than as separate events. */
const SPINE_CROWD_MINUTES = 4

/** A lone spine's weight. Everything else is measured down from it. */
const SPINE_ALPHA = 0.82

/** The faintest a crowded spine draws. Below this it would vanish, and a
 *  message that happened must not disappear because other messages did too. */
const SPINE_ALPHA_FLOOR = 0.09

/**
 * Per-spine opacity, falling as spines crowd each other.
 *
 * A SPINE IS SALIENT BECAUSE IT IS RARE, and Week proved what happens when it
 * is not: a Monday with 468 messages drew 468 hairlines across a 1400-pixel
 * rail and produced a solid black band — the loudest thing on the page, saying
 * only "a lot". So weight falls as `1/neighbours`: one message stays full iron
 * gall, and a burst of thirty inside four minutes bottoms out at the floor and
 * reads as a grey texture. Nothing is dropped and nothing is merged — every
 * message is still exactly where it happened, and a burst still looks like a
 * burst. Only the claim on your eye is rationed.
 *
 * `1/sqrt` was the first try and was not enough: at week scale the lines still
 * overlapped into a picket fence, and overlapping alpha compounds. Linear is
 * the falloff that makes the SOLITARY message the loudest mark on the page,
 * which is the whole point of the channel.
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
