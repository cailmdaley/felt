import { needsHuman, type FamilyModel, type MapThread } from './model.js'
import { NARROW, elapsed, mount, type Drawing } from './drawing.js'
import { TURN, bodyRadius, discRadius, drawnChildren, fineGrid, orbitNames, paintPlate, rimLabels, rimNumerals, rootRadius, separate, timeRings, zoomPlate, type Plate, type Star } from './orbit.js'

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
    rings: timeRings(back => radius(model.now - back)), grid: fineGrid(r0, R), scale: clearing(stars),
  }
}

export const sky: Drawing = {
  name: 'sky', label: 'Sky',
  reading: ['Zoom: ⌘ scroll or pinch', 'Centre: now', 'Rings: since it last moved', 'Direction: its branch', 'Arcs: who launched whom', 'Size: its mass of work', 'Dots: sent files', 'Colour: its state', 'Diamond: a new file', 'Numbers: the order to look'],
  layout: skyLayout,
  draw(host, model, open, view, sight) {
    const { width, height } = mount(host, 'sky', model, open)
    paintPlate(host, zoomPlate(skyLayout(model, width, height), view, model, sight), model)
  },
}
