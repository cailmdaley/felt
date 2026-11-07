/**
 * One frame of the sphere on a canvas: the ground, the HEALPix grid and every
 * tile big enough to see, each cut at the horizon along the rim. A tile fades
 * in as it grows and its parent gives way to it, so zooming is continuous.
 */
import { markPath } from '../family/drawing.js'
import { fromCentre, mollweideAngle, project, type Frame, type Viewport } from './camera.js'
import { baseCell, cellRadius, cellSpan, centre as cellCentre, child, outline, type Cell, type Digit } from './healpix.js'
import type { Box, Point } from './labels.js'
import { askKind, chart, traceOf, type Body, type Scene, type Tone, type Trace } from './scene.js'

/** A leader's strength and the radius of the dot on its tile. */
const LEADER_ALPHA = .45, LEADER_DOT = 2

export interface Palette {
  ocean: string; deep: string; glow: string; grid: string; ink: string; paper: string; land: string; shade: string
  tones: Record<Tone, string>
}
/** A tile ringing because it just changed, `age` from nought to one. */
export interface Pulse { body: Body; age: number }
export interface Marks { hover: Body | null; focus: Body | null; worker: Body | null; pulses: readonly Pulse[] }

const EDGE = 2 * Math.SQRT2
/** Pixels of a tile below which it is not drawn at all, and the width over which it fades in. */
const LEAST_PX = 2, FADE_PX = 8
/** Grid cells narrower than this are not drawn. */
const GRID_PX = 20
/** A tile with a beacon stops needing it once it is this wide. */
export const BEACON_PX = 170
const smooth = (lo: number, hi: number, value: number): number => {
  const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

/** How strongly each tone colours its tile. */
const STRENGTH: Record<Tone, number> = { question: .95, blocked: .95, new: .85, turn: .72, review: .72, working: .62, still: .4, quiet: .34, aside: .24, land: .7, page: .5 }

/** Enough points that a tile's curve stays a curve at this width. */
const stepFor = (px: number): number => px < 36 ? 1 : px < 90 ? 2 : Math.min(512, Math.ceil(px / 48))

/** Traces a closed outline on the globe, cutting it at the horizon and following the rim. False when none of it faces us. */
function traceGlobe(c: CanvasRenderingContext2D, f: Frame, points: Float64Array): boolean {
  const count = points.length / 3
  const xs = new Float64Array(count), ys = new Float64Array(count), ds = new Float64Array(count)
  let first = -1, behind = 0
  for (let n = 0; n < count; n++) {
    const x = points[3 * n], y = points[3 * n + 1], z = points[3 * n + 2]
    const depth = x * f.fwdX + y * f.fwdY + z * f.fwdZ
    xs[n] = f.cx + f.r * (x * f.rightX + y * f.rightY)
    ys[n] = f.cy - f.r * (x * f.upX + y * f.upY + z * f.upZ)
    ds[n] = depth
    if (depth >= 0) { if (first < 0) first = n } else behind++
  }
  if (first < 0) return false
  c.moveTo(xs[first], ys[first])
  if (!behind) {
    for (let n = 1; n < count; n++) c.lineTo(xs[(first + n) % count], ys[(first + n) % count])
    c.closePath()
    return true
  }
  let left: number | null = null
  for (let n = 1; n <= count; n++) {
    const a = (first + n - 1) % count, b = (first + n) % count
    if ((ds[a] >= 0) !== (ds[b] >= 0)) {
      const t = ds[a] / (ds[a] - ds[b]), x = xs[a] + (xs[b] - xs[a]) * t, y = ys[a] + (ys[b] - ys[a]) * t
      const angle = Math.atan2(y - f.cy, x - f.cx)
      if (ds[a] >= 0) { c.lineTo(x, y); left = angle } else if (left !== null) {
        const turn = Math.atan2(Math.sin(angle - left), Math.cos(angle - left))
        c.arc(f.cx, f.cy, f.r, left, left + turn, turn < 0)
        left = null
      }
    }
    if (ds[b] >= 0 && n < count) c.lineTo(xs[b], ys[b])
  }
  c.closePath()
  return true
}

/** Traces an outline on the Mollweide plane, and once more shifted by a turn where it crosses the map's seam. */
function traceChart(c: CanvasRenderingContext2D, f: Frame, trace: Trace): boolean {
  const { phi, sin, cos } = chart(trace), count = phi.length, rate = f.r * EDGE / Math.PI
  const lons = new Float64Array(count)
  lons[0] = fromCentre(f, phi[0])
  let low = lons[0], high = lons[0]
  for (let n = 1; n < count; n++) {
    const step = phi[n] - phi[n - 1]
    lons[n] = lons[n - 1] + step - 2 * Math.PI * Math.round(step / (2 * Math.PI))
    low = Math.min(low, lons[n]); high = Math.max(high, lons[n])
  }
  const draw = (shift: number): void => {
    for (let n = 0; n < count; n++) {
      const x = f.cx + rate * (lons[n] + shift) * cos[n], y = f.cy - f.r * (Math.SQRT2 * sin[n] - f.rise)
      if (n) c.lineTo(x, y); else c.moveTo(x, y)
    }
    c.closePath()
  }
  draw(0)
  if (high > Math.PI) draw(-2 * Math.PI)
  if (low < -Math.PI) draw(2 * Math.PI)
  return true
}
const traceAny = (c: CanvasRenderingContext2D, f: Frame, trace: Trace): boolean => f.projection === 'globe' ? traceGlobe(c, f, trace.points) : traceChart(c, f, trace)

/** The tile is on screen, near enough. */
function seen(f: Frame, viewport: Viewport, body: { centre: readonly [number, number, number]; radius: number }): boolean {
  const [x, y, z] = body.centre
  if (f.projection === 'mollweide') {
    const angle = mollweideAngle(z), lon = fromCentre(f, Math.atan2(y, x))
    const reach = 3 * body.radius * f.r + (body.radius > .1 ? f.r : 0)
    const sx = f.r * EDGE / Math.PI * lon * Math.cos(angle), sy = f.r * (Math.SQRT2 * Math.sin(angle) - f.rise)
    return Math.abs(sx) < viewport.width / 2 + reach && Math.abs(sy) < viewport.height / 2 + reach
  }
  const depth = x * f.fwdX + y * f.fwdY + z * f.fwdZ
  if (depth < -Math.sin(Math.min(1.5, body.radius))) return false
  const sx = f.cx + f.r * (x * f.rightX + y * f.rightY), sy = f.cy - f.r * (x * f.upX + y * f.upY + z * f.upZ)
  const reach = body.radius * f.r
  return sx > -reach && sx < viewport.width + reach && sy > -reach && sy < viewport.height + reach
}

/** Draws the grid of the finest order that still reads at this zoom and the two above it, finer ones fainter. */
function grid(c: CanvasRenderingContext2D, f: Frame, viewport: Viewport, palette: Palette): void {
  const finest = Math.floor(Math.log2(.9 * f.r * cellSpan(0) / GRID_PX))
  const coarsest = Math.max(0, finest - 2)
  const walk = (cell: Cell): void => {
    const span = cellSpan(cell.order) * f.r
    const look = { centre: cellCentre(cell), radius: cellRadius(cell.order) }
    if (!seen(f, viewport, look)) return
    if (cell.order >= coarsest) {
      const fade = smooth(GRID_PX, GRID_PX * 3.2, span)
      c.globalAlpha = cell.order === 0 ? .34 : .04 + .1 * fade
      c.lineWidth = cell.order === 0 ? 1 : .5
      c.beginPath()
      if (traceAny(c, f, { points: outline(cell, stepFor(span)) })) c.stroke()
    }
    if (cell.order < finest) for (const digit of [0, 1, 2, 3] as Digit[]) walk(child(cell, digit))
  }
  c.strokeStyle = palette.grid
  for (let face = 0; face < 12; face++) walk(baseCell(face))
  c.globalAlpha = 1
}

function tiles(c: CanvasRenderingContext2D, f: Frame, viewport: Viewport, scene: Scene, palette: Palette, shown: number, leads: (body: Body) => boolean): void {
  const visit = (body: Body, fade: number): void => {
    if (!seen(f, viewport, body)) return
    const px = body.span * f.r
    if (px < LEAST_PX) return
    if ((body.kind === 'lead' && !leads(body))) return
    const appear = fade * smooth(LEAST_PX, FADE_PX, px)
    const opened = body.kids.length ? smooth(8, 56, px) : 1
    const trace = traceOf(body, stepFor(px))
    c.beginPath()
    if (traceAny(c, f, trace)) {
      const strength = STRENGTH[body.tone] * body.heat, ground = !body.thread ? 1 : body.kids.some(kid => kid.kind === 'thread') ? 1 - .55 * smooth(40, 220, px) : 1 - .25 * smooth(40, 220, px)
      if (opened < 1 && body.hottest !== body.tone) {
        c.fillStyle = palette.tones[body.hottest]
        c.globalAlpha = appear * STRENGTH[body.hottest] * body.heat * (1 - opened)
        c.fill()
      }
      c.fillStyle = palette.tones[body.tone]
      c.globalAlpha = appear * strength * ground * (opened < 1 && body.hottest !== body.tone ? opened : 1)
      c.fill()
      if (px > 7) {
        const bright = body.thread && px > 90
        c.globalAlpha = appear * (bright ? .9 * strength : .28)
        c.strokeStyle = bright ? palette.tones[body.tone] : palette.paper
        c.lineWidth = bright ? 1.25 : Math.min(1.2, .4 + px / 200)
        c.stroke()
      }
    }
    if (px > LEAST_PX * 2) for (const kid of body.kids) visit(kid, appear)
  }
  for (const root of scene.roots) visit(root, shown)
  c.globalAlpha = 1
}

function ring(c: CanvasRenderingContext2D, f: Frame, viewport: Viewport, body: Body, colour: string, width: number, dash: number[]): void {
  if (!seen(f, viewport, body)) return
  c.beginPath()
  if (!traceAny(c, f, traceOf(body, stepFor(body.span * f.r)))) return
  c.strokeStyle = colour; c.lineWidth = width; c.setLineDash(dash)
  c.stroke()
  c.setLineDash([])
}

const marks = new Map<string, Path2D>()
const beaconPath = (kind: string, r: number): Path2D => {
  const key = `${kind}${r}`
  let path = marks.get(key)
  if (!path) { path = new Path2D(markPath(kind as never, r)); marks.set(key, path) }
  return path
}

/** What asks keeps its size from any distance; what asks over the horizon waits at the rim, at its bearing. */
function beacons(c: CanvasRenderingContext2D, f: Frame, scene: Scene, palette: Palette, shown: number): void {
  const globe = f.projection === 'globe'
  for (const body of [...scene.asks].reverse()) {
    if (body.span * f.r > BEACON_PX) continue
    const [x, y, z] = body.centre, kind = askKind(body)
    const urgent = kind === 'question' || kind === 'blocked'
    let sx: number, sy: number, away = false
    if (globe) {
      sx = f.r * (x * f.rightX + y * f.rightY); sy = -f.r * (x * f.upX + y * f.upY + z * f.upZ)
      if (x * f.fwdX + y * f.fwdY + z * f.fwdZ < 0) {
        const off = Math.hypot(sx, sy) || 1
        sx *= (f.r + 7) / off; sy *= (f.r + 7) / off; away = true
      }
      sx += f.cx; sy += f.cy
    } else {
      const a = mollweideAngle(z)
      sx = f.cx + f.r * EDGE / Math.PI * fromCentre(f, Math.atan2(y, x)) * Math.cos(a)
      sy = f.cy - f.r * (Math.SQRT2 * Math.sin(a) - f.rise)
    }
    const r = urgent ? 4.5 : 3
    c.setTransform(c.getTransform().a, 0, 0, c.getTransform().d, sx * c.getTransform().a, sy * c.getTransform().d)
    const tone = palette.tones[kind === 'new' ? 'new' : body.tone]
    if (urgent && !away) {
      c.beginPath(); c.arc(0, 0, r * 2.4, 0, 2 * Math.PI)
      c.fillStyle = tone; c.globalAlpha = .22 * shown; c.fill()
    }
    c.fillStyle = tone; c.strokeStyle = palette.paper; c.lineWidth = 1
    c.globalAlpha = (away ? .55 : 1) * shown
    const path = beaconPath(kind, r)
    c.fill(path); c.globalAlpha = (away ? .4 : .9) * shown; c.stroke(path)
    c.globalAlpha = 1
    c.setTransform(c.getTransform().a, 0, 0, c.getTransform().d, 0, 0)
  }
}

/** Paints one frame. The caller holds the context scaled to CSS pixels. */
export function paint(c: CanvasRenderingContext2D, f: Frame, viewport: Viewport, scene: Scene, palette: Palette, marked: Marks, shown: number, leads: (body: Body) => boolean): void {
  c.clearRect(0, 0, viewport.width, viewport.height)
  const globe = f.projection === 'globe'
  c.save()
  if (globe) {
    if (f.r < 2 * Math.max(viewport.width, viewport.height)) {
      const glow = c.createRadialGradient(f.cx, f.cy, f.r * .96, f.cx, f.cy, f.r * 1.16)
      glow.addColorStop(0, palette.glow); glow.addColorStop(1, 'transparent')
      c.fillStyle = glow
      c.beginPath(); c.arc(f.cx, f.cy, f.r * 1.16, 0, 2 * Math.PI); c.fill()
    }
    const sea = c.createRadialGradient(f.cx - f.r * .28, f.cy - f.r * .34, f.r * .1, f.cx, f.cy, f.r)
    sea.addColorStop(0, palette.ocean); sea.addColorStop(1, palette.deep)
    c.fillStyle = sea
    c.beginPath(); c.arc(f.cx, f.cy, f.r, 0, 2 * Math.PI); c.fill(); c.clip()
  } else {
    c.beginPath()
    c.ellipse(f.cx, f.cy + f.rise * f.r, EDGE * f.r, Math.SQRT2 * f.r, 0, 0, 2 * Math.PI)
    c.fillStyle = palette.deep; c.fill(); c.clip()
  }
  tiles(c, f, viewport, scene, palette, shown, leads)
  grid(c, f, viewport, palette)
  if (globe && f.r < 2 * Math.max(viewport.width, viewport.height)) {
    const shade = c.createRadialGradient(f.cx - f.r * .3, f.cy - f.r * .36, f.r * .55, f.cx, f.cy, f.r * 1.02)
    shade.addColorStop(0, 'transparent'); shade.addColorStop(1, palette.shade)
    c.fillStyle = shade
    c.fillRect(f.cx - f.r, f.cy - f.r, 2 * f.r, 2 * f.r)
  }
  if (marked.worker && marked.worker !== marked.focus) ring(c, f, viewport, marked.worker, palette.ink, 1, [3, 3])
  for (const { body, age } of marked.pulses) {
    c.globalAlpha = 1 - age
    ring(c, f, viewport, body, palette.tones[body.tone], 1 + 3 * age, [])
    const at = project(f, body.centre)
    if (at.depth > 0) {
      c.globalAlpha = .6 * (1 - age)
      c.lineWidth = 1.5
      c.strokeStyle = palette.tones[body.tone]
      c.beginPath(); c.arc(at.x, at.y, 6 + 34 * age, 0, 2 * Math.PI); c.stroke()
    }
  }
  c.globalAlpha = .85
  if (marked.focus) ring(c, f, viewport, marked.focus, palette.ink, 1.25, [])
  if (marked.hover && marked.hover !== marked.focus) ring(c, f, viewport, marked.hover, palette.ink, .75, [])
  c.globalAlpha = 1
  c.restore()
  c.globalAlpha = shown
  beacons(c, f, scene, palette, shown)
}

/** The line from a name standing off its tile to the tile's centre. */
export interface Leader { box: Box; to: Point }
/** Draws each leader from the name's nearest edge, ending in a dot at the tile. */
export function paintLeaders(c: CanvasRenderingContext2D, leaders: readonly Leader[], palette: Palette): void {
  c.strokeStyle = c.fillStyle = palette.ink
  c.lineWidth = 1
  c.globalAlpha = LEADER_ALPHA
  for (const { box, to } of leaders) {
    c.beginPath()
    c.moveTo(Math.max(box.left, Math.min(box.right, to.x)), Math.max(box.top, Math.min(box.bottom, to.y)))
    c.lineTo(to.x, to.y)
    c.stroke()
    c.beginPath()
    c.arc(to.x, to.y, LEADER_DOT, 0, 2 * Math.PI)
    c.fill()
  }
  c.globalAlpha = 1
}
