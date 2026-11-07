import type { FamilyModel, MapThread } from './model.js'
import { NARROW, mount, type Drawing } from './drawing.js'
import { TURN, bodyRadius, childrenOf, discRadius, fineGrid, orbitNames, paintPlate, rimLabels, rimNumerals, rootRadius, type Plate, type Star } from './orbit.js'

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

/** Where everything goes: one ring to a generation, each thread at its learned place whatever it is doing. */
export function ringsLayout(model: FamilyModel, width: number, height: number): Plate {
  const narrow = width < NARROW
  const angles = treeAngles(model)
  const R = narrow ? Math.floor(width / 2 - 26) : discRadius(model, angles, width, height)
  const cx = width / 2, cy = narrow ? R + 26 : height / 2, unit = R / 300
  const threads = [...model.threads.values()]
  const deepest = Math.max(...threads.map(thread => thread.depth))
  const generation = (depth: number): number => R * depth / (deepest + .2)
  const room = new Map<number, number>()
  for (const thread of threads) room.set(thread.depth, (room.get(thread.depth) ?? 0) + 1)
  const stars = threads.map((thread): Star => {
    const angle = angles.get(thread)!, at = generation(thread.depth)
    const fit = thread.depth ? TURN * at / room.get(thread.depth)! * .46 : Infinity
    return { thread, angle, r: thread === model.root ? rootRadius(model, unit) : Math.min(bodyRadius(thread, unit), Math.max(fit, 2)), x: cx + at * Math.cos(angle), y: cy + at * Math.sin(angle) }
  })
  const drawn = stars.filter(star => star.thread.rank >= 0)
  const labels = narrow ? [] : rimLabels(drawn, model, cx, cy, R, width, height)
  const numerals = narrow ? rimNumerals(drawn, cx, cy, R) : []
  return {
    width, height: narrow ? cy + R + 26 : height, cx, cy, R, narrow, stars, links: true, labels, numerals,
    arcs: orbitNames(stars, new Set([...labels, ...numerals].map(mark => mark.thread)), model, cx, cy, R),
    rings: Array.from({ length: deepest }, (_, n) => ({ label: `${n + 1}`, radius: generation(n + 1), marked: false })),
    grid: fineGrid(R * .06, R), scale: -TURN / 4,
  }
}

export const rings: Drawing = {
  name: 'rings', label: 'Rings',
  reading: ['Rings: generations from the constitution', 'Place: fixed by the tree', 'Colour: it needs you', 'Glow: how recently it moved', 'Size: its mass of work', 'Arcs: who launched whom'],
  draw(host, model, open) {
    const { width, height } = mount(host, 'rings', model, open)
    paintPlate(host, ringsLayout(model, width, height), model)
  },
}
