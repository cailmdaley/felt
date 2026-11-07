import { timeOpen, type FamilyModel, type MapThread } from './model.js'
import { DAY, NARROW, TIME_MARKS, mount, type Drawing } from './drawing.js'
import { TURN, bodyRadius, childrenOf, discRadius, fineGrid, orbitNames, paintPlate, rimLabels, rimNumerals, rootRadius, separate, timeRings, zoomPlate, type Plate, type Star } from './orbit.js'

const RING_MARKS: ReadonlyArray<readonly [number, string]> = [...TIME_MARKS, [30 * DAY, '30d'], [60 * DAY, '60d'], [120 * DAY, '120d']]
/** The disc's hollow around the root, as a share of its radius. */
const HOLLOW = .14
/** The shortest time open the scale tells apart. */
const SPAN_LEAST = 3_600_000

/**
 * Every thread's learned place: a leaf takes an equal slice of the circle in
 * tree order and an orchestrator sits over its threads, so a thread's direction
 * changes only when the family's shape does.
 */
function treeAngles(model: FamilyModel): Map<MapThread, number> {
  const leaves = new Map<MapThread, number>()
  const count = (thread: MapThread): number => {
    const below = childrenOf(model, thread).reduce((sum, kid) => sum + count(kid), 0) || 1
    leaves.set(thread, below)
    return below
  }
  const unit = TURN / count(model.root)
  const angles = new Map<MapThread, number>([[model.root, -TURN / 4]])
  const place = (thread: MapThread, from: number): void => {
    let at = from
    for (const kid of childrenOf(model, thread)) {
      angles.set(kid, at + unit * leaves.get(kid)! / 2)
      place(kid, at)
      at += unit * leaves.get(kid)!
    }
  }
  place(model.root, -TURN / 4)
  return angles
}

/**
 * Where everything goes: outward with how long a thread has been open, on a log
 * scale from this family's youngest thread to its oldest, each at a direction
 * fixed by the tree. Those two set the scale, so a flat family spreads as far
 * as a deep one.
 */
export function ringsLayout(model: FamilyModel, width: number, height: number): Plate {
  const narrow = width < NARROW
  const angles = treeAngles(model)
  const R = narrow ? Math.floor(width / 2 - 26) : discRadius(model, angles, width, height)
  const cx = width / 2, cy = narrow ? R + 26 : height / 2, unit = R / 300, r0 = R * HOLLOW
  const threads = [...model.threads.values()]
  const spans = threads.filter(thread => thread !== model.root).map(thread => timeOpen(thread, model.now))
  const young = Math.max(SPAN_LEAST, Math.min(...spans)), old = Math.max(SPAN_LEAST, ...spans)
  const radius = (span: number): number => r0 + (R - r0) * (old > young ? Math.log(Math.max(span, young) / young) / Math.log(old / young) : .5)
  const stars = threads.map((thread): Star => {
    const angle = angles.get(thread)!, at = thread === model.root ? 0 : radius(timeOpen(thread, model.now))
    return { thread, angle, r: thread === model.root ? rootRadius(model, unit) : bodyRadius(thread, unit), x: cx + at * Math.cos(angle), y: cy + at * Math.sin(angle) }
  })
  separate(stars, cx, cy, R)
  const drawn = stars.filter(star => star.thread.rank >= 0)
  const labels = narrow ? [] : rimLabels(drawn, model, cx, cy, R, width, height)
  const numerals = narrow ? rimNumerals(drawn, cx, cy, R) : []
  return {
    k: 1, width, height: narrow ? cy + R + 26 : height, cx, cy, R, narrow, stars, links: true, labels, numerals,
    arcs: orbitNames(stars, new Set([...labels, ...numerals].map(mark => mark.thread)), model, cx, cy, R),
    rings: timeRings(radius, RING_MARKS.filter(([back]) => back > young && back < old)),
    grid: fineGrid(r0, R), scale: -TURN / 4,
  }
}

export const rings: Drawing = {
  name: 'rings', label: 'Rings',
  reading: ['Zoom: ⌘ scroll or pinch', 'Outward: how long it has been open', 'Direction: fixed by the tree', 'Arcs: who launched whom', 'Size: its mass of work', 'Dots: sent files', 'Colour: its state', 'Glow: how recently it moved', 'Diamond: a new file'],
  layout: ringsLayout,
  draw(host, model, open, view, sight) {
    const { width, height } = mount(host, 'rings', model, open)
    paintPlate(host, zoomPlate(ringsLayout(model, width, height), view, model, sight), model)
  },
}
