import { FADE_PX, type Span, type Tube, type TubeLine } from './tube.js'

/**
 * The margin's ink: seeded noise, a tapering ribbon along a polyline, and the
 * field that places every fibre across the margin at each height. Pure: the
 * view turns its answers into SVG (`margin.ts`).
 *
 * Fibres never cross. They keep one order across the margin (the strand at
 * the left, then the lines by rank), and a fibre's place is the bundle's
 * shared sway plus the sum of the cells to its left; each cell breathes on its
 * own noise but stays positive, opening as a fibre arrives and closing as it
 * leaves. A fibre's own curl stays inside its cell, so order holds by
 * construction.
 */

export const hash = (text: string): number => {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
/** A seeded generator of numbers in [0, 1). */
export const random = (seed: string): (() => number) => {
  let a = hash(seed) || 1
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** A well-mixed 32-bit integer from two. */
const mix = (a: number, b: number): number => {
  let h = Math.imul(a ^ Math.imul(b, 0x9e3779b1), 0x85ebca6b)
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16
  return h >>> 0
}
/** Smooth value noise in [-1, 1] over its argument, with correlation length `scale`; the same seed, the same curve. */
export function noise(seed: string, scale: number): (s: number) => number {
  const base = hash(seed), knot = (i: number): number => (mix(base, i) / 2147483648) - 1
  return s => {
    const t = s / scale, i = Math.floor(t), f = t - i, eased = f * f * f * (f * (f * 6 - 15) + 10)
    return knot(i) * (1 - eased) + knot(i + 1) * eased
  }
}
export const smooth = (u: number): number => { const v = Math.min(1, Math.max(0, u)); return v * v * (3 - 2 * v) }

export type Point = readonly [number, number]
/** A cubic Bézier sampled at `n + 1` points. */
export const bezier = (p0: Point, p1: Point, p2: Point, p3: Point, n = 24): Point[] => Array.from({ length: n + 1 }, (_, i) => {
  const t = i / n, u = 1 - t
  return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]] as const
})
/** A tapering ribbon along a polyline: one closed path, `width(u)` wide at fraction `u` of the way along. */
export function ribbon(points: readonly Point[], width: (u: number, index: number) => number): string {
  const n = points.length
  if (n < 2) return ''
  const left: string[] = [], right: string[] = []
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(n - 1, i + 1)]
    let dx = b[0] - a[0], dy = b[1] - a[1]
    const m = Math.hypot(dx, dy) || 1
    dx /= m; dy /= m
    const h = width(i / (n - 1), i) / 2, [x, y] = points[i]
    left.push(`${(x - dy * h).toFixed(1)} ${(y + dx * h).toFixed(1)}`)
    right.push(`${(x + dy * h).toFixed(1)} ${(y - dx * h).toFixed(1)}`)
  }
  return `M${left.join('L')}L${right.reverse().join('L')}Z`
}

/** Where every fibre lies at one height: the strand's place and presence, and each drawn line's. */
export interface Slice {
  /** The strand's middle, its presence, and how many faint fibres it is drawn as (one or two, by how many lines it gathers). */
  strand?: { x: number; p: number; fibres: number }
  lines: Map<TubeLine, { x: number; p: number; taut: number }>
}
export interface FieldOptions {
  /** The margin's room for fibres, in pixels from its left edge. */
  left: number
  right: number
  /** How freely the fibres wander: 0 lies straight. */
  chaos: number
  /** How taut a line is at a height, 0 (rested) to 1 (its worker ran). */
  taut?: (line: TubeLine, s: number) => number
}
/** Wider than this between neighbours, the bundle keeps to the left of its room. */
export const MAX_CELL_PX = 13
/** The strand is drawn as at most this many faint fibres. */
export const STRAND_FIBRES = 2
/** The bundle's shared sway, at most this far either way. */
const SWAY_PX = 2.2

/**
 * The fibres' places at each reckoned height. A cell's width is the line's
 * presence (fading in and out at a span's ends) times its breathing, which
 * is wide where the line is slack and nearly still where it is taut; a slack
 * fibre also curls on a short scale within its cell.
 */
export function field(tube: Tube, { left, right, chaos, taut = () => 0 }: FieldOptions): (s: number) => Slice {
  const order = new Map([...tube.lines].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id)).map((line, n) => [line, n]))
  const spans = [...tube.spans].sort((a, b) => order.get(a.line)! - order.get(b.line)!).map(span => {
    const id = span.line.id
    return { ...span, breath: [noise(`${id}:a`, 34), noise(`${id}:b`, 90), noise(`${id}:c`, 14)], curl: noise(`${id}:d`, 9) }
  })
  // Each span listed in every bin of the stream it reaches, so a height looks only at the few near it.
  const BIN = 64, bins: Array<typeof spans> = []
  for (const span of spans) {
    for (let bin = Math.max(0, Math.floor((span.from - 10) / BIN)); bin <= Math.floor(Math.min(span.to + 30, tube.height + BIN) / BIN); bin++) (bins[bin] ??= []).push(span)
  }
  const sway = noise('sway', 150), sway2 = noise('sway:2', 46)
  // The strand runs wherever lines are gathered; it fades only where a run of gathered stretches begins or ends,
  // and its fibres come and go smoothly as the count it gathers changes.
  const strand: Array<[number, number]> = []
  for (const each of tube.gathered) {
    const last = strand.at(-1)
    if (last && last[1] >= each.from) last[1] = Math.max(last[1], each.to)
    else strand.push([each.from, each.to])
  }
  const counted = (s: number): number => {
    const k = tube.gathered.findIndex(each => each.from <= s && s <= each.to)
    if (k < 0) return 1
    const here = tube.gathered[k], n = Math.min(STRAND_FIBRES, here.lines.length), before = tube.gathered[k - 1]
    if (!before || before.to !== here.from) return n
    return Math.min(STRAND_FIBRES, before.lines.length) + (n - Math.min(STRAND_FIBRES, before.lines.length)) * smooth((s - here.from) / FADE_PX + 0.5)
  }
  const presence = (span: Span, s: number): number =>
    (span.born ? smooth((s - span.from + 10) / 50) : smooth((s - span.from) / FADE_PX)) *
    (span.dies ? smooth((span.to - s + 30) / 50) : smooth((span.to - s) / FADE_PX))
  const sway0 = SWAY_PX * Math.min(1, chaos), room = right - left - 2 * sway0
  const lines: Array<{ line: TubeLine; c: number; slack: number; taut: number; p: number; curl: (s: number) => number }> = []
  return s => {
    lines.length = 0
    const run = strand.find(([from, to]) => from <= s && s <= to)
    let total = 0, ps = 0, fibres = 0, strandC = 0
    if (run) {
      ps = smooth((s - run[0]) / FADE_PX + (run[0] <= 0 ? 1 : 0)) * smooth((run[1] - s) / FADE_PX + (run[1] >= tube.height ? 1 : 0))
      fibres = counted(s)
      strandC = (0.5 + 0.3 * fibres) * ps
      total += strandC
    }
    for (const span of bins[Math.floor(s / BIN)] ?? []) {
      if (s <= span.from - 10 || s >= span.to + 30) continue
      const p = presence(span, s)
      if (p <= 0) continue
      const t = taut(span.line, s), slack = 1 - t, [n1, n2, n3] = span.breath
      const c = p * Math.max(0.3, 1 + chaos * (0.35 + 0.65 * slack) * (n1(s) * 0.42 + n2(s) * 0.34 + n3(s) * 0.1))
      lines.push({ line: span.line, c, slack, taut: t, p, curl: span.curl })
      total += c
    }
    const unit = Math.min(MAX_CELL_PX, room / Math.max(total, 1e-6))
    let x = left + sway0 * (1 + sway(s) * 0.7 + sway2(s) * 0.3)
    const slice: Slice = { lines: new Map() }
    if (run) { slice.strand = { x: x + (unit * strandC) / 2, p: ps, fibres }; x += unit * strandC }
    for (const cell of lines) {
      const own = 0.3 * unit * cell.c * cell.slack * cell.curl(s)
      slice.lines.set(cell.line, { x: x + (unit * cell.c) / 2 + own, p: cell.p, taut: cell.taut })
      x += unit * cell.c
    }
    return slice
  }
}
