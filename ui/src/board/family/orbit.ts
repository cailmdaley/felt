import { isDrawn, needsHuman, type FamilyModel, type MapThread } from './model.js'
import type { View } from './zoom.js'
import { htmlEl, lay, markPath, optionFor, part, reconcile, shortAgo, spread, svgEl, tagThread, type Point } from './drawing.js'

/** The drawings on a disc share this plate: bodies, fine arcs, names on the rim, a ledger on a phone. */
export const TURN = 2 * Math.PI
export const LABEL_ROW = 24
const NUMERAL = 19
const LABEL_MIN = 160
export const LABEL_MAX = 310
/** From the rim to where a label's text begins. */
const RIM_MARGIN = 15
const LABEL_GAP = 12
const DISC_MIN = 120
const BODY_MAX = 15
/** The field's fine grid. */
const GRID_RINGS = 22
/** The widest sweep a name may take along an orbit, and how many bodies carry one. */
const ARC_SWEEP = 200 * Math.PI / 180
const ARCS = 4
/** Bodies smaller than this at R = 300 stay unnamed until peeked. */
const ARC_BODY = 6
const CHAR = 6.3
const LABEL_CHAR = 6.6

export interface Star extends Point { thread: MapThread; angle: number; r: number }
export interface SkyLabel extends Point { thread: MapThread; numeral: number; width: number; side: 'left' | 'right'; rim?: Point }
export interface SkyNumeral extends Point { thread: MapThread; numeral: number; rim?: Point }
export interface SkyRing { label: string; radius: number; marked: boolean }
/** A name laid along an orbit, whole, or not at all. */
export interface SkyArc { thread: MapThread; d: string; radius: number; from: number; to: number }
export interface Plate {
  /** The field's scale; 1 for the whole field. */
  k: number
  width: number
  height: number
  cx: number
  cy: number
  R: number
  narrow: boolean
  stars: Star[]
  /** Parent to child, as fine arcs. */
  links: boolean
  labels: SkyLabel[]
  numerals: SkyNumeral[]
  arcs: SkyArc[]
  rings: SkyRing[]
  grid: number[]
  /** The direction the rings' labels run along. */
  scale: number
  /** The line the bodies sit on, from the centre: its rising part and what recedes past the horizon. */
  line?: { rising: string; receding: string }
}

/** A body's radius from its work, at a sky of R = 300: a thread or, one scale up, a whole family. */
export const bodySize = (work: number): number => 2.2 + Math.sqrt(work) * 1.05
export const bodyRadius = (thread: MapThread, unit: number): number => {
  if (thread.merged) return unit * 1.5
  return unit * Math.max(needsHuman(thread) ? 5.5 : thread.standing === 'working' ? 4 : 2.2, Math.min(BODY_MAX, bodySize(thread.weight)))
}
export const rootRadius = (model: FamilyModel, unit: number): number => unit * Math.min(28, 8 + bodySize(model.mass) * .8)
export const fineGrid = (from: number, to: number): number[] => Array.from({ length: GRID_RINGS }, (_, n) => from + (to - from) * (n + 1) / GRID_RINGS)
export const childrenOf = (model: FamilyModel, thread: MapThread): MapThread[] => thread.children.map(key => model.threads.get(key)!)
export const drawnChildren = (model: FamilyModel, thread: MapThread): MapThread[] => childrenOf(model, thread).filter(isDrawn)

/** How far above or below the centre a label of the least width first fits beside the rim. */
function clearance(R: number, width: number): number {
  const room = Math.max(0, width / 2 - LABEL_MIN - LABEL_GAP), rim = R + RIM_MARGIN
  return room >= rim ? 0 : Math.sqrt(rim ** 2 - room ** 2)
}
const quadrant = (angle: number): number => (Math.cos(angle) >= 0 ? 1 : 0) + (Math.sin(angle) >= 0 ? 2 : 0)
const quadrantRows = (R: number, width: number, height: number): number => Math.floor((height / 2 - clearance(R, width) - 2) / LABEL_ROW)

/**
 * The largest disc that leaves its corners room for every thread needing the
 * human. A wide frame stacks them down the sides; a tall one lets the disc fill
 * the width and stacks them in the corners.
 */
export function discRadius(model: FamilyModel, angles: ReadonlyMap<MapThread, number>, width: number, height: number): number {
  const asking = model.attention.filter(needsHuman)
  const most = Math.max(0, ...[0, 1, 2, 3].map(corner => asking.filter(thread => quadrant(angles.get(thread)!) === corner).length))
  let R = Math.floor(Math.min(height / 2 - 12, width / 2 - 26))
  while (R > DISC_MIN && quadrantRows(R, width, height) < most) R -= 4
  return R
}

/**
 * Names beside the rim, each corner of the frame stacked in the order its stars
 * come round, so leaders do not cross and labels never touch.
 */
export function rimLabels(stars: readonly Star[], model: FamilyModel, cx: number, cy: number, R: number, width: number, height: number): SkyLabel[] {
  const star = new Map(stars.map(item => [item.thread, item]))
  const wanted = model.attention.filter(needsHuman).map(thread => star.get(thread)!)
  const clear = clearance(R, width), rows = quadrantRows(R, width, height)
  return [0, 1, 2, 3].flatMap(corner => {
    const right = corner % 2 === 1, below = corner >= 2
    const rimY = (item: Star): number => cy + R * Math.sin(item.angle)
    const chosen = wanted.filter(item => quadrant(item.angle) === corner).slice(0, rows).sort((a, b) => rimY(a) - rimY(b))
    const [lo, hi] = below ? [cy + clear + LABEL_ROW / 2, height - LABEL_ROW / 2 - 2] : [LABEL_ROW / 2 + 2, cy - clear - LABEL_ROW / 2]
    const ys = spread(chosen.map(rimY), LABEL_ROW, lo, hi)
    return chosen.map((item, n): SkyLabel => {
      const y = ys[n], reach = Math.sqrt(Math.max(0, (R + RIM_MARGIN) ** 2 - (y - cy) ** 2)) + LABEL_GAP
      const x = right ? cx + reach : cx - reach, toward = Math.atan2(y - cy, x - cx)
      return {
        thread: item.thread, numeral: item.thread.rank + 1, side: right ? 'right' : 'left', x, y,
        rim: { x: cx + R * Math.cos(toward), y: cy + R * Math.sin(toward) }, width: Math.min(right ? width - x - 6 : x - 6, LABEL_MAX),
      }
    })
  })
}

/** On a phone the rim carries each asking thread's number, spread around so none touch; the list below names them. */
export function rimNumerals(stars: readonly Star[], cx: number, cy: number, R: number): SkyNumeral[] {
  const asking = stars.filter(star => needsHuman(star.thread)).sort((a, b) => a.angle - b.angle)
  const ring = R + 13, gap = NUMERAL / ring
  const angles = spread(asking.map(star => star.angle), gap, -TURN / 4, 3 * TURN / 4 - gap)
  return asking.map((star, n) => ({
    thread: star.thread, numeral: star.thread.rank + 1, x: cx + ring * Math.cos(angles[n]), y: cy + ring * Math.sin(angles[n]),
    rim: { x: cx + (R - 1) * Math.cos(star.angle), y: cy + (R - 1) * Math.sin(star.angle) },
  }))
}

/**
 * The names of the root and the largest bodies the rim does not already name,
 * each laid along its orbit, above the body. A name goes whole where its arc
 * runs clear of other bodies, or it waits for a peek: never cut short.
 */
export function orbitNames(stars: readonly Star[], named: ReadonlySet<MapThread>, model: FamilyModel, cx: number, cy: number, R: number): SkyArc[] {
  const unit = R / 300, arcs: SkyArc[] = []
  const reach = (star: Star): number => Math.hypot(star.x - cx, star.y - cy)
  const big = stars.filter(star => star.thread !== model.root && !named.has(star.thread) && star.r >= ARC_BODY * unit).sort((a, b) => b.r - a.r).slice(0, ARCS)
  const root = stars.filter(star => star.thread === model.root && !named.has(star.thread))
  const clash = (radius: number, from: number, to: number, own: Star): boolean => stars.some(star => {
    if (star === own) return false
    const off = Math.abs(((star.angle - (from + to) / 2 + TURN * 1.5) % TURN) - TURN / 2)
    return Math.abs(reach(star) - radius) < star.r + 12 && off < (to - from) / 2 + (star.r + 6) / radius
  }) || arcs.some(arc => Math.abs(arc.radius - radius) < 18 && from < arc.to && arc.from < to)
  for (const star of [...root, ...big]) {
    const radius = reach(star) + star.r + 8, sweep = star.thread.name.length * CHAR / radius
    if (radius > R - 8 || sweep > ARC_SWEEP) continue
    const at = star.thread === model.root ? -TURN / 4 : star.angle
    const from = at - sweep / 2, to = at + sweep / 2
    if (clash(radius, from, to, star)) continue
    const below = Math.sin(at) > .15, r = below ? radius + 10 : radius
    const a = below ? to : from, b = below ? from : to
    const d = `M${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}A${r.toFixed(1)} ${r.toFixed(1)} 0 ${sweep > TURN / 2 ? 1 : 0} ${below ? 0 : 1} ${(cx + r * Math.cos(b)).toFixed(1)} ${(cy + r * Math.sin(b)).toFixed(1)}`
    arcs.push({ thread: star.thread, d, radius, from, to })
  }
  return arcs
}

/** Each name beside its body, on whichever side and row first keeps clear of every other name and body, whole where it can be. */
export function nearLabels(stars: readonly Star[], named: readonly Star[], numeral: (thread: MapThread) => number, cx: number, width: number, height: number): SkyLabel[] {
  interface Box { left: number; right: number; top: number; bottom: number }
  const placed: Box[] = [], labels: SkyLabel[] = []
  const touches = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  const clear = (box: Box, own: Star): boolean => !placed.some(other => touches(box, other))
    && stars.every(star => star === own || !touches(box, { left: star.x - star.r, right: star.x + star.r, top: star.y - star.r, bottom: star.y + star.r }))
  for (const star of named) {
    const out = star.x >= cx, wanted = Math.min(LABEL_MAX, star.thread.name.length * LABEL_CHAR + 58)
    const options = [out, !out].flatMap(right => {
      const x = right ? star.x + star.r + 7 : star.x - star.r - 7
      const room = Math.min(wanted, right ? width - x - 6 : x - 6)
      return [0, -1, 1, -2, 2, -3, 3, -4, 4, -6, 6, -8, 8].map(row => ({ right, x, room, y: star.y + row * LABEL_ROW }))
    }).filter(option => option.room >= Math.min(wanted, 150) && option.y >= LABEL_ROW / 2 && option.y <= height - LABEL_ROW / 2)
    const box = (option: typeof options[number]): Box => ({ left: option.right ? option.x : option.x - option.room, right: option.right ? option.x + option.room : option.x, top: option.y - LABEL_ROW / 2, bottom: option.y + LABEL_ROW / 2 })
    const chosen = options.find(option => option.room >= wanted && clear(box(option), star)) ?? options.find(option => clear(box(option), star))
    if (!chosen) continue
    placed.push(box(chosen))
    labels.push({
      thread: star.thread, numeral: numeral(star.thread), side: chosen.right ? 'right' : 'left', x: chosen.x, y: chosen.y, width: chosen.room,
      rim: chosen.y === star.y ? undefined : { x: chosen.x + (chosen.right ? -3 : 3), y: chosen.y },
    })
  }
  return labels
}

/**
 * The plate seen through a zoomed view: its geometry scaled, its marks their
 * reading size, and a name on every thread in view with room for one.
 */
export function zoomPlate(plate: Plate, view: View, numeral: (thread: MapThread) => number = thread => thread.rank + 1): Plate {
  const { k } = view
  if (k === 1) return plate
  const { width, height } = plate, dx = view.x * width, dy = view.y * height
  const stars = plate.stars.map(star => ({ ...star, x: star.x * k + dx, y: star.y * k + dy }))
  const inView = stars.filter(star => star.x >= 0 && star.x <= width && star.y >= 0 && star.y <= height)
  const named = inView.filter(star => isDrawn(star.thread)).sort((a, b) => numeral(a.thread) - numeral(b.thread))
  const cx = plate.cx * k + dx
  return {
    ...plate, k, cx, cy: plate.cy * k + dy, R: plate.R * k, stars, labels: nearLabels(inView, named, numeral, cx, width, height), numerals: [], arcs: [],
    rings: plate.rings.map(ring => ({ ...ring, radius: ring.radius * k })), grid: plate.grid.map(radius => radius * k),
  }
}

function drawLinks(layer: SVGGElement, plate: Plate): void {
  const star = new Map(plate.stars.map(item => [item.thread.key, item]))
  const links = plate.links ? plate.stars.filter(item => item.thread.parent !== null && star.has(item.thread.parent)) : []
  reconcile(layer, links, item => item.thread.key, () => {
    const path = svgEl('path', 'fm-link'); path.setAttribute('d', 'M0 0Q.5 .24 1 0'); path.setAttribute('vector-effect', 'non-scaling-stroke')
    return path
  }, (path, item) => {
    path.setAttribute('data-link', item.thread.key)
    path.setAttribute('data-standing', item.thread.standing)
    path.toggleAttribute('data-merged', item.thread.merged)
    lay(path, star.get(item.thread.parent!)!, item)
  })
}

function unitLine(): SVGLineElement {
  const line = svgEl('line', 'fm-leader'); line.setAttribute('x2', '1'); line.setAttribute('vector-effect', 'non-scaling-stroke')
  return line
}
/** The dotted lines from a body out to its name: straight to the rim, then across to the label. */
function drawLeaders(layer: SVGGElement, plate: Plate): void {
  const star = new Map(plate.stars.map(item => [item.thread, item]))
  const ends = [
    ...plate.labels.map(label => ({ thread: label.thread, rim: label.rim, end: { x: label.x + (label.side === 'right' ? -4 : 4), y: label.y } })),
    ...plate.numerals.map(numeral => ({ thread: numeral.thread, rim: numeral.rim, end: { x: numeral.x, y: numeral.y } })),
  ]
  const segments = ends.flatMap(({ thread, rim, end }) => rim ? [
    { id: `${thread.key}\u0000out`, thread, a: star.get(thread)!, b: rim },
    { id: `${thread.key}\u0000off`, thread, a: rim, b: end },
  ] : [])
  reconcile(layer, segments, item => item.id, unitLine, (line, item) => {
    line.setAttribute('data-standing', item.thread.standing)
    line.setAttribute('data-leader', item.thread.key)
    lay(line, item.a, item.b)
  })
}

function drawStars(layer: SVGGElement, plate: Plate, model: FamilyModel): void {
  reconcile(layer, plate.stars, item => item.thread.key, () => {
    const group = svgEl('g', 'fm-star')
    const hit = svgEl('circle', 'fm-star-hit'), halo = svgEl('circle', 'fm-star-halo'), ring = svgEl('circle', 'fm-star-ring'), mark = svgEl('path', 'fm-star-mark'), fresh = svgEl('path', 'fm-star-fresh')
    group.append(hit, halo, ring, mark, fresh)
    return group
  }, (group, item) => {
    const { thread, r } = item
    tagThread(group, thread)
    if (isDrawn(thread)) optionFor(group, thread, model)
    else for (const name of ['role', 'aria-label', 'aria-posinset', 'aria-setsize', 'aria-selected', 'tabindex']) group.removeAttribute(name)
    group.toggleAttribute('data-root', thread === model.root)
    group.toggleAttribute('data-merged', thread.merged)
    group.toggleAttribute('data-current', thread.key === model.current && thread !== model.root)
    group.style.transform = `translate(${item.x.toFixed(1)}px, ${item.y.toFixed(1)}px)`
    group.style.setProperty('--fm-heat', (1 - Math.sqrt(Math.max(0, model.now - thread.lastMove) / (6 * 86_400_000))).toFixed(2))
    const [hit, halo, ring, mark, fresh] = group.children
    hit.setAttribute('r', String(plate.narrow ? r + 10 : Math.max(r + 4, 9)))
    halo.setAttribute('r', String(r + 5))
    ring.setAttribute('r', String(Math.max(r + 7, 7)))
    mark.setAttribute('d', markPath(thread.standing === 'blocked' ? 'blocked' : 'turn', r))
    fresh.setAttribute('d', thread.fresh ? 'M0 -4L4 0L0 4L-4 0Z' : '')
    fresh.setAttribute('transform', `translate(${(r * .75 + 3).toFixed(1)} ${(-r * .75 - 3).toFixed(1)})`)
  })
}

let arcIds = 0
/** The names along the orbits, each on its own arc. */
function drawArcs(layer: SVGGElement, plate: Plate): void {
  reconcile(layer, plate.arcs, arc => arc.thread.key, () => {
    const group = svgEl('g', 'fm-arc'), path = svgEl('path'), text = svgEl('text'), along = svgEl('textPath')
    path.id = `fm-arc-${++arcIds}`
    along.setAttribute('href', `#${path.id}`); along.setAttribute('startOffset', '50%')
    text.append(along); group.append(path, text)
    return group
  }, (group, arc) => {
    tagThread(group, arc.thread)
    group.querySelector('path')!.setAttribute('d', arc.d)
    group.querySelector('textPath')!.textContent = arc.thread.name
  })
}

function drawLabels(layer: HTMLElement, numerals: HTMLElement, plate: Plate, model: FamilyModel): void {
  reconcile(layer, plate.labels, label => label.thread.key, () => {
    const el = htmlEl('div', 'fm-label')
    el.append(htmlEl('span', 'fm-label-rank'), htmlEl('span', 'fm-label-name'), htmlEl('span', 'fm-label-age'))
    return el
  }, (el, label) => {
    tagThread(el, label.thread)
    el.dataset.side = label.side
    el.style.width = `${Math.round(label.width)}px`
    el.style.transform = `translate(${(label.side === 'right' ? label.x : label.x - label.width).toFixed(1)}px, ${(label.y - LABEL_ROW / 2).toFixed(1)}px)`
    const [rank, name, age] = el.children
    rank.textContent = String(label.numeral)
    name.textContent = label.thread.name
    age.textContent = shortAgo(label.thread.lastMove, model.now)
  })
  reconcile(numerals, plate.numerals, numeral => numeral.thread.key, () => htmlEl('div', 'fm-numeral'), (el, numeral) => {
    tagThread(el, numeral.thread)
    el.textContent = String(numeral.numeral)
    el.style.transform = `translate(${(numeral.x - NUMERAL / 2).toFixed(1)}px, ${(numeral.y - NUMERAL / 2).toFixed(1)}px)`
  })
}

/** Under a phone's disc: every thread at work or asking, in the order to look at them. */
function drawLedger(layer: HTMLElement, model: FamilyModel, narrow: boolean): void {
  reconcile(layer, narrow ? model.attention : [], thread => thread.key, () => {
    const row = htmlEl('div', 'fm-ledger-row')
    const mark = svgEl('svg', 'fm-ledger-mark'); mark.setAttribute('viewBox', '-8 -8 16 16'); mark.append(svgEl('path'))
    row.append(htmlEl('span', 'fm-ledger-rank'), mark, htmlEl('span', 'fm-ledger-name'), htmlEl('span', 'fm-ledger-age'))
    return row
  }, (row, thread) => {
    tagThread(row, thread)
    row.style.order = String(thread.rank)
    const [rank, mark, name, age] = row.children
    rank.textContent = needsHuman(thread) ? String(thread.rank + 1) : ''
    mark.firstElementChild!.setAttribute('d', markPath(thread.standing, 5))
    name.textContent = thread.name
    age.textContent = shortAgo(thread.lastMove, model.now)
  })
}

/** Paints a plate into the host, keeping every element it can. */
export function paintPlate(host: HTMLElement, plate: Plate, model: FamilyModel): void {
  const frame = part(host, 'fm-sky-plate', cls => htmlEl('div', cls))
  host.classList.toggle('family-map-zoomed', plate.k > 1)
  frame.style.height = `${plate.height}px`
  const svg = part(frame, 'fm-sky-svg', cls => svgEl('svg', cls))
  svg.setAttribute('viewBox', `0 0 ${plate.width} ${plate.height}`)
  const circle = (el: SVGCircleElement, radius: number): void => { el.setAttribute('cx', String(plate.cx)); el.setAttribute('cy', String(plate.cy)); el.setAttribute('r', radius.toFixed(1)) }
  reconcile(part(svg, 'fm-grid', cls => svgEl('g', cls)), plate.grid.map((radius, n) => ({ radius, n })), ring => String(ring.n), () => svgEl('circle'), (el, ring) => circle(el, ring.radius))
  reconcile(part(svg, 'fm-rings', cls => svgEl('g', cls)), plate.rings, ring => ring.label, ring => {
    const group = svgEl('g'), text = svgEl('text')
    text.textContent = ring.label
    group.append(svgEl('circle'), text)
    return group
  }, (group, ring) => {
    const [ringEl, text] = group.children
    circle(ringEl as SVGCircleElement, ring.radius)
    text.setAttribute('x', String(plate.cx + ring.radius * Math.cos(plate.scale))); text.setAttribute('y', String(plate.cy + ring.radius * Math.sin(plate.scale) + 4))
    text.toggleAttribute('hidden', !ring.marked)
  })
  if (plate.line) {
    const line = part(svg, 'fm-line', cls => svgEl('g', cls))
    line.setAttribute('transform', `translate(${plate.cx} ${plate.cy}) scale(${plate.k})`)
    for (const part_ of ['rising', 'receding'] as const) {
      part(line, `fm-line-${part_}`, cls => svgEl('path', cls)).setAttribute('d', plate.line[part_])
      part(line, `fm-flow-${part_}`, cls => svgEl('path', cls)).setAttribute('d', plate.line[part_])
    }
    const fade = part(svg, 'fm-line-fade', cls => { const el = svgEl('radialGradient', cls); el.id = `fm-fade-${++arcIds}`; el.setAttribute('gradientUnits', 'userSpaceOnUse'); el.append(svgEl('stop'), svgEl('stop')); return el })
    fade.setAttribute('cx', '0'); fade.setAttribute('cy', '0'); fade.setAttribute('r', String(plate.R / plate.k * 1.3))
    fade.children[0].setAttribute('offset', '.6'); fade.children[1].setAttribute('offset', '1')
    line.style.setProperty('--fm-fade', `url(#${fade.id})`)
  }
  drawLinks(part(svg, 'fm-links', cls => svgEl('g', cls)), plate)
  drawLeaders(part(svg, 'fm-leaders', cls => svgEl('g', cls)), plate)
  drawStars(part(svg, 'fm-stars', cls => svgEl('g', cls)), plate, model)
  drawArcs(part(svg, 'fm-arcs', cls => svgEl('g', cls)), plate)
  drawLabels(part(frame, 'fm-labels', cls => htmlEl('div', cls)), part(frame, 'fm-numerals', cls => htmlEl('div', cls)), plate, model)
  drawLedger(part(host, 'fm-ledger', cls => htmlEl('div', cls)), model, plate.narrow)
}
