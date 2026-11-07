import { needsHuman, type FamilyModel, type MapThread } from './model.js'
import { NARROW, TIME_MARKS, elapsed, mount, type Drawing } from './drawing.js'
import { TURN, bodyRadius, discRadius, drawnChildren, fineGrid, orbitNames, paintPlate, rimLabels, rimNumerals, rootRadius, zoomPlate, type Plate, type SkyRing, type Star } from './orbit.js'

/** The least distance between two rings' labels. */
const RING_LABEL = 34

/** Each thread's direction: a wedge for itself, then its threads' wedges beside it, weighted by what asks. */
function directions(model: FamilyModel): Map<MapThread, number> {
  const share = (thread: MapThread): number => needsHuman(thread) ? 3 : thread.standing === 'working' ? 2 : thread.standing === 'aside' ? .6 : 1
  const spans = new Map<MapThread, number>()
  const span = (thread: MapThread): number => {
    const total = share(thread) + drawnChildren(model, thread).reduce((sum, kid) => sum + span(kid), 0)
    spans.set(thread, total)
    return total
  }
  span(model.root)
  const angles = new Map<MapThread, number>([[model.root, -TURN / 4]])
  const place = (thread: MapThread, from: number, to: number, own: number): void => {
    const unit = (to - from) / spans.get(thread)!
    let at = from
    if (own) { angles.set(thread, from + unit * own / 2); at += unit * own }
    for (const kid of drawnChildren(model, thread)) {
      const end = at + unit * spans.get(kid)!
      place(kid, at, end, share(kid))
      at = end
    }
  }
  place(model.root, -TURN / 4, 3 * TURN / 4, 0)
  return angles
}

/** Marks that land on each other step outward; a ring's width of time is the most this bends. */
function separate(stars: Star[], cx: number, cy: number, R: number): void {
  const sorted = stars.filter(star => star.thread.parent !== null).sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))
  const clear = (star: Star, placed: readonly Star[]): boolean => placed.every(other => Math.hypot(star.x - other.x, star.y - other.y) >= star.r + other.r + 2)
  const placed = stars.filter(star => star.thread.parent === null)
  for (const star of sorted) {
    for (let radius = Math.hypot(star.x - cx, star.y - cy); !clear(star, placed) && radius < R; radius += 1.5) {
      star.x = cx + radius * Math.cos(star.angle); star.y = cy + radius * Math.sin(star.angle)
    }
    placed.push(star)
  }
}

/** The widest empty direction, where the time scale can be read clear of the stars. */
function clearing(stars: readonly Star[]): number {
  const angles = stars.filter(star => star.thread.parent !== null).map(star => star.angle).sort((a, b) => a - b)
  let best = -TURN / 4, width = 0
  angles.forEach((angle, n) => {
    const next = angles[n + 1] ?? angles[0] + TURN
    if (next - angle > width) { width = next - angle; best = angle + width / 2 }
  })
  return best
}

/** The rings of time; only those with room for it carry their label. */
function timeRings(radius: (at: number) => number, now: number): SkyRing[] {
  const rings = TIME_MARKS.map(([back, label]): SkyRing => ({ label, radius: radius(now - back), marked: false }))
  let room = Infinity
  for (const ring of [...rings].reverse()) {
    ring.marked = room - ring.radius >= RING_LABEL
    if (ring.marked) room = ring.radius
  }
  return rings
}

/** Where everything in the sky goes, as data. */
export function skyLayout(model: FamilyModel, width: number, height: number): Plate {
  const narrow = width < NARROW
  const angles = directions(model)
  const R = narrow ? Math.floor(width / 2 - 26) : discRadius(model, angles, width, height)
  const cx = width / 2, cy = narrow ? R + 26 : height / 2, r0 = R * .17, unit = R / 300
  const radius = (at: number): number => r0 + (R - r0) * elapsed(at, model.now)
  const stars = model.order.map((thread): Star => {
    const angle = angles.get(thread)!, at = thread === model.root ? 0 : radius(thread.lastMove)
    return { thread, angle, r: thread === model.root ? rootRadius(model, unit) : bodyRadius(thread, unit), x: cx + at * Math.cos(angle), y: cy + at * Math.sin(angle) }
  })
  separate(stars, cx, cy, R)
  const labels = narrow ? [] : rimLabels(stars, model, cx, cy, R, width, height)
  const numerals = narrow ? rimNumerals(stars, cx, cy, R) : []
  return {
    k: 1, width, height: narrow ? cy + R + 26 : height, cx, cy, R, narrow, stars, links: true, labels, numerals,
    arcs: orbitNames(stars, new Set([...labels, ...numerals].map(mark => mark.thread)), model, cx, cy, R),
    rings: timeRings(radius, model.now), grid: fineGrid(r0, R), scale: clearing(stars),
  }
}

export const sky: Drawing = {
  name: 'sky', label: 'Sky',
  reading: ['Centre: now', 'Rings: since it last moved', 'Arcs: who launched whom', 'Size: its mass of work', 'Colour: it needs you', 'Numbers: the order to look'],
  draw(host, model, open, view) {
    const { width, height } = mount(host, 'sky', model, open)
    paintPlate(host, zoomPlate(skyLayout(model, width, height), view), model)
  },
}
