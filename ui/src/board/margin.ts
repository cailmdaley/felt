import type { Entry } from './channels.js'
import { STRAND_FIBRES, bezier, field, hash, noise, random, ribbon, smooth, type Point, type Slice } from './ink.js'
import { ANCHOR, type Span, type Tube, type TubeLine } from './tube.js'

/**
 * Channels' margin drawn in fine ink, over the stream's rows as measured: a
 * tapering fibre per line where it has one, the faint strand for the rest, a
 * collateral from a fibre down to each post's drop, a cell body at a start
 * (touched by its parent's fibre when it is a sub-thread), a small loop at a
 * handoff, and an arbor, a fray or a taper at an end. Plain SVG paths, drawn
 * once per layout; the drops themselves are the posts' state dots.
 */

/** A row as laid out: its entry, whether it groups under the one above, and where it stands. */
export interface MarginRow { entry: Entry; grouped: boolean; top: number; height: number }
export interface MarginOptions {
  /** The margin's width; a post's drop sits 7px inside its right edge. */
  width: number
  /** How freely the fibres wander. */
  chaos: number
  /** A fibre's weight, about its width in pixels where it is taut. */
  weight: number
  /** A line's identity hue, `0`–`5`. */
  hue: (line: TubeLine) => string
  /** How taut a line is at a reckoned height (`tautAlong`). */
  taut: (line: TubeLine, s: number) => number
  /** What a line says on hover. */
  title: (line: TubeLine) => string
  /** What the strand says on hover where it gathers these lines. */
  gatheredTitle: (lines: readonly TubeLine[]) => string
  /** What a station's mark (a start, a handoff, an end) says on hover: its thread, what it marks, and when. */
  markTitle: (entry: Entry) => string
  /** The measured band to draw, from and to; the whole stream when absent. Only what crosses it is drawn. */
  band?: readonly [number, number]
}

const SVG = 'http://www.w3.org/2000/svg'
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}
/** Sampling step down the stream, in measured pixels. */
const STEP = 3

/**
 * Maps reckoned heights onto measured ones, row by row: each row's top and
 * its mark are fixed points, and the stretch between them is linear, so a
 * row that loads taller stretches only itself.
 */
export function measure(tube: Tube, rows: readonly MarginRow[]): { y: (s: number) => number; s: (y: number) => number } {
  const S: number[] = [], Y: number[] = []
  rows.forEach((row, i) => {
    const mark = tube.anchors[i] - tube.tops[i]
    S.push(tube.tops[i], tube.anchors[i])
    Y.push(row.top, row.top + Math.min(mark, row.height))
  })
  const last = rows.at(-1)
  S.push(tube.height)
  Y.push(last ? last.top + last.height : 0)
  const along = (from: number[], to: number[]) => (v: number): number => {
    if (!from.length) return v
    if (v <= from[0]) return to[0] + (v - from[0])
    if (v >= from[from.length - 1]) return to[to.length - 1] + (v - from[from.length - 1])
    let lo = 0, hi = from.length - 1
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (from[mid] <= v) lo = mid; else hi = mid }
    const span = from[hi] - from[lo]
    return span > 0 ? to[lo] + ((v - from[lo]) / span) * (to[hi] - to[lo]) : to[lo]
  }
  return { y: along(S, Y), s: along(Y, S) }
}

/** The margin drawn, the band it covers, and where its strand is inked at a measured height in that band. */
export interface Margin { svg: SVGSVGElement; band: readonly [number, number]; strandAt: (y: number) => number | undefined }

export function drawMargin(tube: Tube, rows: readonly MarginRow[], height: number, options: MarginOptions): Margin {
  const { width, chaos, weight } = options
  const box = svg('svg', { class: 'kbn-ch-ink', width, height, 'aria-hidden': 'true' })
  const band = [Math.max(0, Math.floor((options.band?.[0] ?? 0) / STEP) * STEP), Math.min(height, options.band?.[1] ?? height)] as const
  if (!rows.length) return { svg: box, band, strandAt: () => undefined }
  const map = measure(tube, rows), drop = width - 7
  const k0 = band[0] / STEP, slices: Slice[] = [], at = (y: number): Slice => slices[Math.max(0, Math.min(slices.length - 1, Math.round(y / STEP) - k0))]
  const place = field(tube, { left: 5, right: drop - 9, chaos, taut: options.taut })
  for (let y = band[0]; y <= band[1] + STEP; y += STEP) slices.push(place(map.s(y)))
  const inBand = (y: number, pad = 0): boolean => y >= band[0] - pad && y <= band[1] + pad
  const xOf = (line: TubeLine, y: number): number | undefined => at(y).lines.get(line)?.x
  const groups = new Map<TubeLine, SVGGElement>()
  const group = (line: TubeLine): SVGGElement => {
    const kept = groups.get(line)
    if (kept) return kept
    const g = svg('g', { class: 'kbn-ch-fibre', 'data-line': line.id, 'data-hue': options.hue(line) })
    g.toggleAttribute('data-ended', line.to !== Infinity)
    const title = svg('title')
    title.textContent = options.title(line)
    g.append(title)
    groups.set(line, g)
    return g
  }
  const wisp = (g: SVGGElement, points: readonly Point[], w: (u: number, i: number) => number, className = 'kbn-ch-twig'): void => {
    const d = ribbon(points, w)
    if (d) g.append(svg('path', { class: className, d }))
  }
  const hit = (g: SVGGElement, points: readonly Point[]): void => {
    // A target only, so every fourth point is enough.
    const coarse = points.filter((_, i) => i % 4 === 0 || i === points.length - 1)
    if (coarse.length > 1) g.append(svg('path', { class: 'kbn-ch-hit', d: `M${coarse.map(([x, y]) => `${x.toFixed(0)} ${y.toFixed(0)}`).join('L')}` }))
  }
  const rowY = (row: number): number => rows[row].top + Math.min(tube.anchors[row] - tube.tops[row], rows[row].height)

  // The strand: a few faint fibres under the ringed count, breathing around one another, wherever lines are gathered.
  {
    const g = svg('g', { class: 'kbn-ch-strand' })
    const breath = Array.from({ length: STRAND_FIBRES }, (_, k) => noise(`strand:${k}`, 40 + k * 17))
    for (let k = 0; k < STRAND_FIBRES; k++) {
      let run: Point[] = [], ps: number[] = []
      const flush = (): void => {
        if (run.length > 1) { const p = ps; wisp(g, run, (_, i) => 0.7 * weight * p[i], 'kbn-ch-strand-ink') }
        run = []; ps = []
      }
      slices.forEach((slice, n) => {
        // Faint and slowly breathing, the strand is drawn from every other slice.
        if (n % 2) return
        const strand = slice.strand, y = (n + k0) * STEP
        if (!strand || strand.p <= 0.02) { flush(); return }
        // A fibre beyond the strand's count thins away rather than stopping.
        const there = smooth(strand.fibres - k)
        if (there <= 0.02) { flush(); return }
        const spread = (k - (STRAND_FIBRES - 1) / 2) * (1.6 + 0.9 * breath[k](map.s(y)))
        run.push([strand.x + spread * strand.p, y])
        ps.push(strand.p * there)
      })
      flush()
    }
    // Its targets, one for each stretch that gathers the same lines, each naming those lines.
    tube.gathered.forEach((each, index) => {
      const from = Math.max(band[0], map.y(each.from)), to = Math.min(band[1], map.y(each.to)), spine: Point[] = []
      for (let y = Math.ceil(from / STEP) * STEP; y <= to; y += STEP) { const strand = at(y).strand; if (strand && strand.p > 0.3) spine.push([strand.x, y]) }
      if (spine.length < 2) return
      const target = svg('g', { class: 'kbn-ch-gathered', 'data-gathered': index }), title = svg('title')
      title.textContent = options.gatheredTitle(each.lines)
      target.append(title)
      hit(target, spine)
      g.append(target)
    })
    if (g.childElementCount) box.append(g)
  }

  // Each span of a line: its fibre, from its cell body when it is born there and into its end when it dies there.
  const pressure = (line: TubeLine) => { const phase = hash(line.id) % 7; return (i: number): number => 0.74 + 0.26 * Math.sin(i / 11 + phase) * Math.sin(i / 4.3 + 1) }
  for (const span of tube.spans) {
    const { line } = span, g = group(line), R = random(`${line.id}:${span.from}`)
    const start = span.born ? rowY(line.from) : undefined, end = span.dies ? rowY(line.to) : undefined
    const y0 = start !== undefined ? start + 30 + R() * 8 : Math.max(band[0], map.y(span.from)), y1 = end !== undefined ? end - 26 : Math.min(band[1], map.y(span.to))
    if (y1 < band[0] || y0 > band[1]) continue
    const body: Point[] = [], ws: number[] = [], inks: Array<[number, number]> = []
    for (let y = Math.ceil(Math.max(y0, band[0]) / STEP) * STEP; y <= Math.min(y1, band[1]); y += STEP) {
      const here = at(y).lines.get(line)
      if (!here) continue
      body.push([here.x, y])
      // Weight and ink both come in with presence; a rested stretch is thinner and fainter than a worked one.
      ws.push(Math.min(1, here.p * 1.6) * (0.6 + 0.65 * here.taut))
      inks.push([y, here.p * (0.42 + 0.58 * here.taut)])
    }
    // A life too short for a fibre of its own between its start and its end: one fine curve from its cell body to its arbor.
    if (body.length < 2 && start !== undefined && end !== undefined && inBand(start, 40)) {
      const x = drop - 1
      wisp(g, bezier([x - 0.5, start + 3], [x - 12, start + 10], [x - 22, end - 6], [drop - 10, end], 20), u => weight * (0.9 - 0.4 * u), 'kbn-ch-twig')
      continue
    }
    if (body.length < 2) continue
    let points = body, taper = ws
    if (start !== undefined && inBand(start, 40)) {
      const sx = drop - 1, [fx, fy] = body[0], next = body[Math.min(3, body.length - 1)]
      const head = bezier([sx - 0.5, start + 3], [sx - 1, start + 16], [fx + (fx - next[0]) * 3, fy - 10], [fx, fy], 18).slice(0, -1)
      points = [...head, ...points]
      taper = [...head.map((_, i) => (0.45 + 0.55 * (i / head.length)) * ws[0]), ...taper]
    }
    if (end !== undefined && inBand(end, 40)) {
      const ex = drop - 10, last = points[points.length - 1], before = points[Math.max(0, points.length - 4)]
      const tail = bezier(last, [last[0] + (last[0] - before[0]) * 2, last[1] + 14], [ex - 10, end + 3], [ex, end], 18).slice(1)
      points = [...points, ...tail]
      taper = [...taper, ...tail.map((_, i) => (1 - 0.6 * (i / tail.length)) * ws[ws.length - 1])]
    }
    const press = pressure(line), id = `kbn-ink-${hash(`${line.id}:${span.from}`).toString(36)}`
    const gradient = svg('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: 0, x2: 0, y1: 0, y2: height })
    let said = -1
    inks.forEach(([y, ink], k) => {
      if (k && k < inks.length - 1 && Math.abs(ink - said) < 0.04) return
      said = ink
      gradient.append(svg('stop', { offset: (y / height).toFixed(5), 'stop-opacity': ink.toFixed(3) }))
    })
    g.append(gradient)
    const d = ribbon(points, (_, i) => weight * taper[i] * press(i))
    if (d) g.append(svg('path', { class: 'kbn-ch-fibre-ink', d, fill: `url(#${id})` }))
    hit(g, points)
  }

  // Each row's own mark.
  rows.forEach((row, i) => {
    const entry = row.entry, line = entry.line ? tube.lines.find(each => each.id === entry.line) : undefined
    if (!line) return
    const y = rowY(i)
    if (!inBand(y, 40)) return
    const g = group(line), R = random(`${entry.id}`)
    if (entry.kind !== 'station') {
      // A post: a collateral leaves its fibre above, sweeps down and out, thins, and meets its drop.
      if (row.grouped) return
      const yb = y - (15 + R() * 14), xb = xOf(line, yb) ?? at(yb).strand?.x
      if (xb === undefined) return
      const xn = xOf(line, yb + 6) ?? xb, droop = 2 + R() * 5 * chaos, curl = (R() - 0.5) * 5 * chaos
      wisp(g, bezier([xb, yb], [xb + (xn - xb) * 2, yb + 12 + droop], [drop - 13 - R() * 5, y + 4 + curl], [drop - 3, y + (R() - 0.5) * 1.2]),
        u => weight * (0.9 - 0.5 * u) * (0.3 + 0.7 * Math.min(1, u * 5)))
      return
    }
    if (entry.what === 'tick') {
      const x = xOf(line, y) ?? at(y).strand?.x
      if (x !== undefined) named(g, entry, x, y).append(svg('circle', { class: 'kbn-ch-knot', cx: x.toFixed(2), cy: y, r: 1.7 }))
      return
    }
    if (entry.what === 'start') {
      cell(named(g, entry, drop - 1, y - 2), drop - 1, y, R, weight)
      if (line.parent) synapse(line.parent, drop - 1, y, R)
      // Born with nothing to say soon: its fibre sweeps from the cell into the strand, thinning as it goes.
      if (!tube.spans.some(span => span.line === line && span.born)) gather(g, [drop - 1.5, y + 3], y + 34 + R() * 10, 1)
      return
    }
    // Ending with nothing said just before: its fibre leaves the strand for the end.
    if (!tube.spans.some(span => span.line === line && span.dies)) gather(g, [drop - 10.5, y], y - 34 - R() * 10, -1)
    end(named(g, entry, drop - 5, y), drop - 10, y, line.end ?? 'closed', R, weight)
  })
  /** A station's mark, in a group of its own that names it on hover, with a target large enough to hover at 1x. */
  function named(g: SVGGElement, entry: Entry, x: number, y: number): SVGGElement {
    const mark = svg('g', { class: 'kbn-ch-mark', 'data-entry': entry.id }), title = svg('title')
    title.textContent = options.markTitle(entry)
    mark.append(title, svg('circle', { class: 'kbn-ch-hit-mark', cx: x.toFixed(1), cy: y.toFixed(1), r: 7 }))
    g.append(mark)
    return mark
  }
  /** A fine fibre between a mark and the strand: down into it from a start (`way` 1), or up out of it to an end (`way` -1); full where it meets the mark. */
  function gather(g: SVGGElement, mark: Point, ys: number, way: 1 | -1): void {
    const xs = at(ys).strand?.x
    if (xs === undefined) return
    const far: Point = [xs, ys], points = bezier(mark, [mark[0] - 8, mark[1] + way * 14], [xs, ys - way * 20], far, 20)
    wisp(g, points, u => weight * (0.85 - 0.75 * u) + 0.05, 'kbn-ch-gather')
  }
  function synapse(parent: TubeLine, sx: number, y: number, R: () => number): void {
    const yb = y - 24 - R() * 8, xb = xOf(parent, yb)
    if (xb === undefined) return
    const g = group(parent), xn = xOf(parent, yb + 6) ?? xb, to: Point = [sx - 4.6, y + 1.4]
    wisp(g, bezier([xb, yb], [xb + (xn - xb) * 2, yb + 14], [to[0] - 9, to[1] + 3], to), u => weight * (0.8 - 0.4 * u) * (0.3 + 0.7 * Math.min(1, u * 5)))
    g.append(svg('circle', { class: 'kbn-ch-bouton', cx: to[0].toFixed(2), cy: to[1].toFixed(2), r: 1.1 }))
  }
  for (const g of groups.values()) box.append(g)
  return { svg: box, band, strandAt: y => { const strand = at(y).strand; return strand && strand.p > 0.3 ? strand.x : undefined } }
}

/** A start: a small body of ink, a short apical wisp above it and two basal ones. */
function cell(g: SVGGElement, x: number, y: number, R: () => number, weight: number): void {
  const h = 3.3 + R() * 0.5, tilt = (R() - 0.5) * 0.5
  const rot = (px: number, py: number): Point => [x + px * Math.cos(tilt) - py * Math.sin(tilt), y + px * Math.sin(tilt) + py * Math.cos(tilt)]
  const mid = (p: Point, q: Point, k: number): Point => [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k]
  const corners = [rot(0, -h * 1.2), rot(h * 0.95, h * 0.8), rot(-h * 0.95, h * 0.8)]
  const f = (p: Point): string => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`
  const d = corners.map((p, k) => { const a = mid(p, corners[(k + 2) % 3], 0.3), b = mid(p, corners[(k + 1) % 3], 0.3); return `${k ? 'L' : 'M'}${f(a)}Q${f(p)} ${f(b)}` }).join('') + 'Z'
  g.append(svg('path', { class: 'kbn-ch-cell', d }))
  const [apex, right, left] = corners
  const crown = rot((R() - 0.5) * 3, -h * 1.2 - 6 - R() * 2.5)
  g.append(svg('path', { class: 'kbn-ch-twig', d: ribbon(bezier(apex, rot(1, -h * 1.8), rot(-1.2, -h * 2.2), crown, 10), u => weight * (1 - u) + 0.1) }))
  for (const [corner, side] of [[right, 1], [left, -1]] as const) {
    const tip = rot(side * (h + 3.5 + R() * 3), h * 0.8 + 2 + R() * 3)
    g.append(svg('path', { class: 'kbn-ch-twig', d: ribbon(bezier(corner, mid(corner, tip, 0.4), [tip[0] - side, tip[1] - 2], tip, 8), u => weight * 0.75 * (1 - u) + 0.08) }))
  }
}

/** An end, by its verdict: tempered an arbor with a bouton on each twig, closed the arbor bare, discarded a fray, rested a single taper. */
function end(g: SVGGElement, x: number, y: number, how: NonNullable<TubeLine['end']>, R: () => number, weight: number): void {
  const twigs = { tempered: 3, closed: 3, discarded: 4, rested: 1 }[how]
  for (let k = 0; k < twigs; k++) {
    const spread = how === 'discarded' ? 1.9 : 1.4, a = twigs > 1 ? -spread / 2 + (k * spread) / (twigs - 1) + (R() - 0.5) * 0.25 : 0
    const length = how === 'discarded' ? 3.5 + R() * 3 : 6.5 + R() * 3
    const tip: Point = [x + Math.cos(a) * length, y + Math.sin(a) * length], bend: Point = [x + length * 0.45, y + Math.sin(a) * length * 0.25]
    g.append(svg('path', { class: how === 'discarded' ? 'kbn-ch-fray' : 'kbn-ch-twig', d: ribbon(bezier([x - 0.5, y], bend, bend, tip, 10), u => weight * (how === 'discarded' ? 0.55 : 0.75) * (1 - u * (how === 'tempered' ? 0.6 : 1)) + 0.05) }))
    if (how === 'tempered') g.append(svg('circle', { class: 'kbn-ch-bouton', cx: tip[0].toFixed(2), cy: tip[1].toFixed(2), r: 1.05 }))
  }
}

/** How taut each line is at each reckoned height: between two rows, the share of that time its worker ran, eased across each row's mark. */
export function tautAlong(tube: Tube, times: readonly number[], runs: (line: TubeLine) => ReadonlyArray<readonly [number, number]>, tautness: (runs: ReadonlyArray<readonly [number, number]>, a: number, b: number) => number): (line: TubeLine, s: number) => number {
  const memo = new Map<TubeLine, number[]>()
  const of = (line: TubeLine): number[] => {
    const kept = memo.get(line)
    if (kept) return kept
    const own = runs(line)
    // Interval k runs from row k's mark to row k + 1's; before the first row, as the first interval.
    const values = times.map((at, k) => tautness(own, at, times[k + 1] ?? at))
    memo.set(line, values)
    return values
  }
  const { anchors } = tube
  return (line, s) => {
    const values = of(line)
    if (!values.length) return 0
    let lo = 0, hi = anchors.length
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (anchors[mid] <= s) lo = mid; else hi = mid }
    const k = s < anchors[0] ? 0 : lo, here = values[k], ease = 12
    // Near a mark, ease from the interval above it into the one below.
    const toMark = s - anchors[k]
    if (k > 0 && toMark < ease) return values[k - 1] + (here - values[k - 1]) * (0.5 + 0.5 * Math.max(-1, toMark / ease))
    const next = anchors[k + 1]
    if (next !== undefined && next - s < ease) return here + (values[k + 1] - here) * (0.5 - 0.5 * ((next - s) / ease))
    return here
  }
}
export { ANCHOR, type Span }
