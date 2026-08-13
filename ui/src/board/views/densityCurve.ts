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
 *            floor under it ({@link spineFloor}) so a message sent while
 *            nothing was running is still a mark you can see and point at. The
 *            floor is a share of what THAT RAIL's curve reaches, so an accent
 *            can never out-top the day it annotates.
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
 * KERNEL WIDTH IS A FRACTION OF THE AXIS, NOT A NUMBER OF MINUTES.
 *
 * Two constants in minutes was the wrong shape for the knob. A minute means
 * something different on a two-hour frame than on a seven-day one, and the two
 * views were being asked to agree on a unit they do not share. What they DO
 * share is the drawn axis: whatever span a rail carries, it is drawn about a
 * thousand pixels wide, so a kernel stated as `span / N` is a kernel stated in
 * PIXELS — the only unit in which "crisp" and "calm" mean anything.
 *
 * So each view names one number: how many kernel widths fit across its axis.
 * Read `span / N` as "the axis is N kernels wide", and note that a Gaussian's
 * visible mound is roughly 2.4σ across, so a rail of 1000px at N draws each
 * episode about `2400 / N` pixels wide.
 *
 * These are decoupled on purpose. Day and Week are asking different questions
 * of the same minutes and there is no reason their answers should be within a
 * factor of four of each other.
 */

/**
 * DAY: the axis is 500 kernels wide.
 *
 * Day is the close read, and the thing it must resolve is ONE WORK EPISODE — a
 * burst of tool calls with quiet either side. On a whole civil day that is
 * σ ≈ 2.9 minutes, about 2px on a 1000px rail, and the day resolves into
 * distinct near-spiky masses rather than the three soft hills 220 gave.
 *
 * Tying it to the axis rather than to a number of minutes is what makes the
 * zoom work: Day's frame moves with the day's shape (see `drawnWindow`) and
 * moves again whenever the reader drags one out, and a fixed sigma silently
 * changed the grammar every time it did — the same day drawn crisp at one zoom
 * and blurred at the next. A zoom narrows σ automatically, so this errs sharp
 * for the full frame and gets sharper from there.
 */
export const DAY_KERNELS_PER_AXIS = 500

/**
 * The finest kernel Day is allowed: THREE QUARTERS OF A MINUTE.
 *
 * ON A TIGHT FRAME THIS IS THE NUMBER THAT GOVERNS, not the ratio above — at
 * 500 kernels a three-hour frame asks for σ = 0.36 and gets the floor instead,
 * so every frame under about six hours is drawn at exactly this width. It was
 * one minute, and one minute was the real reason Day still read as rolling
 * hills after the compression fix: the ratio was never binding on the frames
 * anybody was looking at.
 *
 * The floor's job is to stop the curve degenerating into one tooth per sample,
 * and the arithmetic says where that happens. Samples arrive one per minute, so
 * two neighbouring active minutes overlap at `exp(−0.5/σ²)`: at σ = 0.75 that
 * is 0.41 and they fuse into one episode with visible internal texture; at
 * σ = 0.5 it is 0.135 and they stand apart as separate teeth. Swept against a
 * real day's rail, that is exactly where the picture turns — 0.6 and 0.75 read
 * as crisp episodes, 0.5 and below as a comb, 1.0 and above as hills. So the
 * floor sits at the last width that still binds adjacent minutes together,
 * which is the honest limit of what a per-minute record can resolve.
 */
export const DAY_SIGMA_FLOOR_MINUTES = 0.75

/**
 * WEEK: the axis is 200 kernels wide.
 *
 * Week is the comparator, and the thing it must resolve is A DAY'S SHAPE —
 * morning, afternoon, evening — not the episodes inside it. At 200 a mound is
 * ~12px on the rail, so a day reads as two or three masses.
 *
 * Its floor is the harsher of the two, and it is the whole reason Week looked
 * wiggly: Week rasters its minutes into four-minute slots before the kernel
 * ever sees them (`RASTER_SLOT_MS` in WeekView), so its samples are a comb with
 * four-minute teeth. A sigma below the tooth spacing does not smooth that comb,
 * it DRAWS it — and the sawtooth the old σ = 3.0 produced was therefore not the
 * week's data being jagged, it was the raster grid showing through. Both the
 * ratio (1440/200 = 7.2 minutes) and the floor keep the kernel clear of the
 * tooth, so what is drawn is the day and not the bins it was folded into.
 */
export const WEEK_KERNELS_PER_AXIS = 200

/** The finest kernel Week is allowed: the raster slot it bins into. Same
 *  argument as {@link DAY_SIGMA_FLOOR_MINUTES}, one quantum coarser — you
 *  cannot resolve below your own sampling interval, and trying draws it. */
export const WEEK_SIGMA_FLOOR_MINUTES = 4

/**
 * The kernel width, in minutes, for a rail carrying `spanMinutes`: a fixed
 * fraction of the axis, never finer than the grain the samples arrived at.
 */
export function kernelSigma(
  spanMinutes: number,
  kernelsPerAxis: number,
  floorMinutes: number,
): number {
  return Math.max(floorMinutes, Math.max(1, spanMinutes) / Math.max(1, kernelsPerAxis))
}

/** Day's kernel for a frame of `spanMinutes`. */
export function daySigma(spanMinutes: number): number {
  return kernelSigma(spanMinutes, DAY_KERNELS_PER_AXIS, DAY_SIGMA_FLOOR_MINUTES)
}

/** Week's kernel for a rail of `spanMinutes` (a civil day: 23, 24 or 25h). */
export function weekSigma(spanMinutes: number): number {
  return kernelSigma(spanMinutes, WEEK_KERNELS_PER_AXIS, WEEK_SIGMA_FLOOR_MINUTES)
}

/**
 * The floor under the per-view normaliser, in compressed units — `log1p(4)`.
 *
 * Without it a day holding one single event would normalise against itself and
 * draw that event as a full-height mountain. The floor says: four events in a
 * minute is the least that gets to fill a rail.
 */
export const PEAK_FLOOR = Math.log1p(4)

/**
 * The tallest a FLOORED spine may be drawn, as a fraction of the row's height.
 *
 * A spine reads the curve under it, and the curve is frequently zero there —
 * you write to an agent that is not running, which is how a great many
 * conversations start. At the true height that message would be a mark of zero
 * pixels: the event that matters most on the rail, invisible. So the floor,
 * chosen by looking: below about a quarter the row a 2px line reads as grit on
 * the paper, and above about a third it stops being distinguishable from a
 * spine standing in real work. 0.3 sits between.
 *
 * This is now the CEILING on the floor rather than the floor itself — see
 * {@link spineFloor}. On a rail whose curve reaches the top of the row it is
 * still exactly 0.3, which is every rail the constant was ever chosen against.
 */
export const SPINE_MIN_HEIGHT = 0.3

/**
 * The floor's share of what THIS RAIL's own curve reaches.
 *
 * Half: a spine standing on empty minutes may rise to half the tallest mound
 * the rail managed, and no further. Above that it stops annotating the day and
 * starts competing with it.
 */
export const SPINE_RAIL_SHARE = 0.5

/**
 * The shortest any spine is ever drawn, whatever the rail did.
 *
 * A rail with no curve at all — a message sent into a day where nothing ran —
 * has no mound to be measured against, and the mark still has to be a mark you
 * can point at. 0.18 is ~4px on a week rail and ~5px on a day lane: smaller
 * than the old fixed floor, and on a rail carrying no other ink, enough.
 */
export const SPINE_MIN_HEIGHT_ABS = 0.18

/**
 * How tall a spine standing on no curve is drawn, given how tall this rail's
 * curve gets — a share of the rail's own maximum, clamped into
 * [{@link SPINE_MIN_HEIGHT_ABS}, {@link SPINE_MIN_HEIGHT}].
 *
 * ## Why the floor could not stay a constant
 *
 * Every other mark on a rail is scaled by the PAGE's peak ({@link fieldPeak}):
 * a Tuesday whose busiest moment is a third of Friday's draws at a third the
 * height, which is the whole reason the rails are stacked. The floor alone was
 * invariant to that scaling — so on a rail normalised down to 0.3 of the row,
 * a fixed 0.3 floor made every quiet-minute message exactly as tall as the
 * busiest thing that happened all day. Measured on a real week (2026-08-01, a
 * quiet Saturday in a week holding a twelve-thousand-event Friday): the rail's
 * tallest mound reached 0.317 of the row and its one spine stood at 0.300.
 * The accent had become the mark.
 *
 * Week feels it first because its seven rails span a much wider range of volume
 * than one day's lanes do, but the flaw was never Week's — it is the same
 * arithmetic in both views, and it is fixed once, here.
 */
export function spineFloor(railMax: number): number {
  const share = SPINE_RAIL_SHARE * Math.max(0, railMax)
  return Math.min(SPINE_MIN_HEIGHT, Math.max(SPINE_MIN_HEIGHT_ABS, share))
}

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
 * How many grid points a kernel gets across one sigma. Three is the point at
 * which a sampled Gaussian stops having visible corners; more is precision no
 * rail a thousand pixels wide could show.
 *
 * THE GRID IS NOW CUT FROM THE KERNEL rather than from a constant. It used to
 * be floored off Day's sigma and shared, which was fine while both sigmas were
 * fixed and Day's was the narrower — and quietly wrong the moment sigma became
 * a function of the frame. A grid finer than the kernel is wasted work; a grid
 * coarser than the kernel draws the grid.
 */
const GRID_POINTS_PER_SIGMA = 3

/**
 * A sampling grid for a frame, fine enough that a kernel of `sigma` is not
 * under-sampled and coarse enough that a long frame is not a hundred thousand
 * path commands. The step widens past the kernel's own demand only when the
 * frame is long enough that holding it would blow {@link MAX_GRID_POINTS}.
 */
const MAX_GRID_POINTS = 2880

export function curveGrid(frameMinutes: number, sigma: number): CurveGrid {
  const minutes = Math.max(1, Math.ceil(frameMinutes))
  const wanted = Math.max(0.05, sigma) / GRID_POINTS_PER_SIGMA
  const step = Math.max(wanted, minutes / MAX_GRID_POINTS)
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
 * One lane's field: `log1p` of each minute's agent count, THEN smeared.
 *
 * ## The order is the whole thing
 *
 * This used to smear first and compress the smeared density, and that was the
 * bug behind years of "Day is still too smooth". Compression after smoothing
 * does not preserve the kernel's width — it inflates it, and it inflates it in
 * proportion to how loud the minute was:
 *
 *     log1p(n·e^(−d²/2σ²)) ≈ log n − d²/2σ²    for large n
 *
 * which is a parabola that does not reach the floor until `d ≈ σ·√(2 ln n)`.
 * Measured on a real day's counts at σ = 0.75: a single event drew a mound
 * 1.0 minutes across at half height, ten events drew 2.0, and fifty or more
 * drew 3.0 — the same kernel producing a mound THREE TIMES wider for the busy
 * minutes, which are precisely the ones the eye lands on. Every attempt to fix
 * this by tightening sigma failed the same way, because sigma was never what
 * was setting the width.
 *
 * Compressing per event first makes the drawn width the KERNEL'S width, full
 * stop: a one-event minute and a five-hundred-event minute are mounds of
 * identical shape differing only in height, which is what a density curve is
 * supposed to say. Sigma now means what it says, which is what let it become a
 * fraction of the axis above.
 *
 * The compression itself is unchanged in purpose — it keeps a burst of fifty
 * tool calls from flattening a quiet afternoon into the baseline, while leaving
 * the small end nearly linear so single events still differ from pairs. It is
 * only applied to the honest thing: the count that actually arrived in that
 * minute, before anything was smeared anywhere.
 */
export function curveField(
  samples: readonly ActivitySample[],
  grid: CurveGrid,
  spines: readonly number[],
  sigma: number,
): CurveField {
  return {
    grid,
    height: smear(samples, (s) => Math.log1p(s.agent), sigma, grid),
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
 * height at that minute, floored at {@link spineFloor} of this rail.
 *
 * The floor is read from the RAIL and not from a constant, so a spine is an
 * accent on the day it annotates rather than a fixed tower over it.
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
  let railMax = 0
  for (const h of field.height) if (h > railMax) railMax = h
  const floor = spineFloor(Math.min(1, railMax / scale))
  return field.spines.map((minute) => {
    const i = Math.min(last, Math.max(0, Math.round(minute / field.grid.step)))
    const h = Math.min(1, (field.height[i] ?? 0) / scale)
    return Math.max(floor, h)
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
  const widths = spineWidths(field.spines)
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
    // The WIDTH is the crowd channel now, and there is no opacity channel at
    // all — see `spineWidths`.
    spine.setAttribute('stroke-width', widths[i].toFixed(2))
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

/** A lone spine's stroke, in the curve's own 1000×100 units — the full-weight
 *  mark, and what every spine on a quiet rail draws at. */
const SPINE_WIDTH = 2

/** The narrowest a crowded spine draws. A hairline is still a line; below this
 *  it would start dropping out of the raster on some displays, and a message
 *  that happened must not disappear because other messages did too. */
const SPINE_WIDTH_FLOOR = 0.75

/**
 * Per-spine stroke width, narrowing as spines crowd each other.
 *
 * ## Why this is not opacity any more
 *
 * It was, and the semantics were wrong. Alpha on this board means UNCERTAINTY —
 * a stale lane, an open delegation whose length nobody recorded. A faded spine
 * therefore read as a message we were not sure about, and the honest question
 * came back immediately: *why is it fainter in a burst?* There is no answer.
 * The message in a burst is exactly as real as the message on its own; only its
 * claim on the eye needs rationing, and that is a matter of how much ink the
 * mark spends, not how confident the mark is.
 *
 * So the crowd channel is TYPOGRAPHIC. A lone message draws a full 2-unit
 * cinnabar stroke; a burst of thirty inside seven minutes draws thirty hairlines
 * and reads as a red texture rather than a red wall. Nothing is dropped, nothing
 * is merged, nothing is faded — every message is at full strength, exactly where
 * it happened, and the only thing that changed is the nib.
 *
 * The falloff is `1/√neighbours` rather than the linear one alpha used. Width
 * does not compound the way overlapping alpha does — two hairlines side by side
 * are two hairlines, not a darker line — so the aggressive falloff that alpha
 * needed would here thin a mild crowd to nothing for no gain.
 */
export function spineWidths(spines: readonly number[]): number[] {
  // A sliding window rather than the obvious pair loop: `curveField` sorts the
  // spines, and a day of five hundred messages should not cost a quarter of a
  // million comparisons to draw.
  const out = new Array<number>(spines.length)
  let lo = 0
  let hi = 0
  for (let i = 0; i < spines.length; i += 1) {
    while (spines[lo] < spines[i] - SPINE_CROWD_MINUTES) lo += 1
    while (hi < spines.length && spines[hi] <= spines[i] + SPINE_CROWD_MINUTES) hi += 1
    const neighbours = Math.max(1, hi - lo)
    out[i] = Math.max(SPINE_WIDTH_FLOOR, SPINE_WIDTH / Math.sqrt(neighbours))
  }
  return out
}

// ── The ladder: who was aloft, and for how long ──────────────────────────────
//
// A third channel, and the only one that is not about a moment: WHO WAS OUT,
// AND BETWEEN WHICH TWO INSTANTS. The curve says the machines were busy and
// the spines say you spoke, but a four-way fan-out and one long tool call make
// identical ink — and the difference between them is most of what a day of
// orchestration is.
//
// So the lane grows a LADDER, read from the ground up:
//
//   THE FLOOR    the main session itself — one solid line spanning the session
//                from its first recorded minute to its last. It is the thing
//                everything else was launched from, so it is the ground the
//                rest stands on.
//
//   THE RUNGS    one solid line per subagent or workflow agent, spanning spawn
//                → return, ABOVE the floor and stacked upward whenever two
//                overlap. Four agents launched at once is four rungs with four
//                visibly different right-hand ends; a long solitary delegation
//                is one long rung. You read tool-call density off the mound and
//                fleet concurrency off the ladder, and neither can be mistaken
//                for the other.
//
// The rungs are packed by interval-graph colouring, done greedily on a
// start-sorted list: each takes the lowest free row it does not collide in.
// Greedy is optimal here (the classic interval-partitioning result), so the
// ladder is exactly as tall as the concurrency was — never taller, which is the
// whole claim the channel makes.
//
// SESSIONS ARE PACKED FIRST, into rows of their own, and the rungs start above
// the last of them. That is what makes "above the floor" true rather than
// usually-true: a subagent must never be drawn level with or under the session
// that sent it, however the intervals happen to fall.

/** What a ladder line IS — the two things drawn differently, because they are
 *  two different claims. */
export type LadderKind = 'session' | 'agent'

/** The interval as the ladder needs it: two instants, what it was, and whether
 *  anybody recorded its close. */
export interface LadderInterval {
  start_ms: number
  end_ms: number
  open: boolean
  kind: LadderKind
  /** For the hover — the agent's name, the session's id. Never drawn as text
   *  on the rail; the rail is hairlines and the words are in the tip. */
  label?: string
}

/** One ladder line ready to draw: horizontal extent as fractions of the frame,
 *  and which rung it sits on. */
export interface LadderLine {
  /** 0…1 across the frame. */
  start: number
  end: number
  /** 0 is the ground; each further row is one rung up. */
  row: number
  kind: LadderKind
  /** Its close was never recorded — the length is a stub, not a duration. */
  open: boolean
  label?: string
  /** The real instants, kept for the tooltip: a fraction of a frame is what the
   *  ink needs and a clock time is what a person needs. */
  startMs: number
  endMs: number
}

/**
 * Lay a lane's ladder out in rows, clipped to `[startMs, endMs]`.
 *
 * Intervals wholly outside the frame are dropped; one that straddles an edge is
 * clipped, because the frame is the claim being made. Sorted by start, so the
 * row assignment is deterministic and two renders of the same data cannot
 * disagree about which line is which.
 */
export function ladderRows(
  spans: readonly LadderInterval[],
  frame: { startMs: number; endMs: number },
): LadderLine[] {
  const span = Math.max(1, frame.endMs - frame.startMs)
  const clip = (kind: LadderKind): LadderInterval[] =>
    spans
      .filter((s) => s.kind === kind && s.end_ms >= frame.startMs && s.start_ms <= frame.endMs)
      .map((s) => ({
        ...s,
        start_ms: Math.max(s.start_ms, frame.startMs),
        end_ms: Math.min(s.end_ms, frame.endMs),
      }))
      .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)

  const lines: LadderLine[] = []
  // The instant each row is free from. A row is reusable the moment its last
  // occupant ended — two that merely touch are not concurrent.
  const freeFrom: number[] = []
  const pack = (batch: readonly LadderInterval[], floorRow: number): number => {
    let top = floorRow
    for (const s of batch) {
      let row = freeFrom.findIndex((at, i) => i >= floorRow && at <= s.start_ms)
      if (row === -1) row = Math.max(floorRow, freeFrom.length)
      freeFrom[row] = s.end_ms
      top = Math.max(top, row + 1)
      lines.push({
        start: (s.start_ms - frame.startMs) / span,
        end: (s.end_ms - frame.startMs) / span,
        row,
        kind: s.kind,
        open: s.open,
        ...(s.label ? { label: s.label } : {}),
        startMs: s.start_ms,
        endMs: s.end_ms,
      })
    }
    return top
  }

  // The floors first, then the rungs strictly above the highest of them.
  const above = pack(clip('session'), 0)
  pack(clip('agent'), above)
  return lines
}

/** How tall the tallest ladder on a page is — one more than the largest row
 *  index anywhere on it. Per PAGE, like {@link fieldPeak}: the pitch the lines
 *  are drawn at has to be one number, or two lanes' ladders could not be
 *  compared down the column. */
export function ladderHeight(lanes: readonly (readonly LadderLine[])[]): number {
  let depth = 0
  for (const lines of lanes) {
    for (const line of lines) if (line.row + 1 > depth) depth = line.row + 1
  }
  return depth
}

/**
 * The band the ladder is allowed, in pixels, measured UP from the rail's
 * baseline. Deliberately under half the rail's height: these lines are strata
 * under the curve, and a ladder that climbed into it would compete with it.
 *
 * GREW BY A QUARTER WHEN THE LANE GREW BY A HALF (19px → 29px, see
 * `.kbn-day-rail`), which is the whole point of the number moving at all. The
 * extra height was bought for the CURVE — height is the channel that says how
 * much the machines did — so the ladder takes a smaller share of a bigger lane
 * rather than its old share of it: 58% of the rail before, 48% now, and the
 * curve keeps the difference on top of its own.
 */
export const LADDER_BAND_PX = 14

/** The gap between neighbouring rungs. Three pixels while the ladder is short
 *  — the pitch at which one line reads as one agent, opened up with the taller
 *  lane — closing only once a fan-out is deep enough that its HEIGHT is the
 *  thing being read. */
export function ladderPitch(height: number): number {
  if (height <= 1) return 0
  return Math.max(1, Math.min(3, LADDER_BAND_PX / (height - 1)))
}
