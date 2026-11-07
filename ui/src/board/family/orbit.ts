import { isDrawn, needsHuman, type FamilyModel, type MapThread } from './model.js'
import { WHOLE, held, type View } from './zoom.js'
import { REVEAL, unfold, type Locality, type Satellite } from './locality.js'
import { TIME_MARKS, htmlEl, lay, markPath, optionFor, part, reconcile, shortAgo, spread, svgEl, tagThread, type Focus, type Point } from './drawing.js'

/** The drawings on a disc share this plate: bodies, fine arcs, names on the rim, a ledger on a phone, and a focused thread unfolded in place. */
export const TURN = 2 * Math.PI
export const LABEL_ROW = 24
const NUMERAL = 19
/** The least distance between two rings' labels. */
const RING_LABEL = 34
const LABEL_MIN = 160
export const LABEL_MAX = 310
/** From the rim to where a label's text begins. */
const RIM_MARGIN = 15
const LABEL_GAP = 12
const DISC_MIN = 120
/** A satellite's row, as family-map.css sets it. */
const HELD_ROW = 24
const FOCUS_NAME = 190
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
/** Sent files a body shows as dots, and their spacing around it. */
const MOONS = 8
const MOON_STEP = .42
/** The scale a thread is flown to, a step deeper for each generation below the first. */
const FOCUS_K = 3
const FOCUS_STEP = 1.35
/** Where a flight leaves its thread, as a share of the plate's height. */
const FOCUS_Y = .46
const FOCUS_Y_NARROW = .14
/** How far from the plate's middle a body can be and still be the one a hand has zoomed to, as a share of the plate. */
const SIGHT = .3

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
  /** The arms the bodies sit on, from the centre: what rises to the human and what recedes. */
  line?: { rising: string; receding: string }
  /** The arms' names, by the tips they end at. */
  arms?: ArmName[]
  /** The thread unfolded around its body, and the threads gathered to it. */
  locality?: Locality
}
export interface ArmName extends Point { label: string; side: 'left' | 'right' }

/** A body's radius from its work, at a sky of R = 300: a thread or, one scale up, a whole family. */
export const bodySize = (work: number): number => 2.2 + Math.sqrt(work) * 1.05
export const bodyRadius = (thread: MapThread, unit: number): number => {
  if (thread.merged) return unit * 1.5
  return unit * Math.max(thread.tone === 'question' || thread.tone === 'blocked' ? 7 : needsHuman(thread) ? 5.5 : thread.standing === 'working' ? 4 : 2.2, Math.min(BODY_MAX, bodySize(thread.weight)))
}
export const rootRadius = (model: FamilyModel, unit: number): number => unit * Math.min(28, 8 + bodySize(model.mass) * .8)
export const fineGrid = (from: number, to: number): number[] => Array.from({ length: GRID_RINGS }, (_, n) => from + (to - from) * (n + 1) / GRID_RINGS)
export const childrenOf = (model: FamilyModel, thread: MapThread): MapThread[] => thread.children.map(key => model.threads.get(key)!)
export const drawnChildren = (model: FamilyModel, thread: MapThread): MapThread[] => childrenOf(model, thread).filter(isDrawn)

/** Marks that land on each other step outward; a ring's width of time is the most this bends. */
export function separate(stars: Star[], cx: number, cy: number, R: number): void {
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

/** The rings of a time scale, each at `radius` of its span; only those with room for it carry their label. */
export function timeRings(radius: (back: number) => number, marks: ReadonlyArray<readonly [number, string]> = TIME_MARKS): SkyRing[] {
  const rings = marks.map(([back, label]): SkyRing => ({ label, radius: radius(back), marked: false }))
  let room = Infinity
  for (const ring of [...rings].reverse()) {
    ring.marked = room - ring.radius >= RING_LABEL
    if (ring.marked) room = ring.radius
  }
  return rings
}

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

/** How far from its body a name may sit, in rows, nearest first. */
export const NEAR_ROWS: readonly number[] = [0, -1, 1, -2, 2, -3, 3, -4, 4, -6, 6, -8, 8]
export interface Box { left: number; right: number; top: number; bottom: number }

/** Each name beside its body, on whichever side and row first keeps clear of every other name and body, whole where it can be. */
export function nearLabels(stars: readonly Star[], named: readonly Star[], numeral: (thread: MapThread) => number, cx: number, width: number, height: number, reserved: readonly Box[] = [], rows: (star: Star) => readonly number[] = () => NEAR_ROWS): SkyLabel[] {
  const placed: Box[] = [...reserved], labels: SkyLabel[] = []
  const touches = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  const clear = (box: Box, own: Star): boolean => !placed.some(other => touches(box, other))
    && stars.every(star => star === own || !touches(box, { left: star.x - star.r, right: star.x + star.r, top: star.y - star.r, bottom: star.y + star.r }))
  for (const star of named) {
    const out = star.x >= cx, wanted = Math.min(LABEL_MAX, star.thread.name.length * LABEL_CHAR + 58)
    const options = [out, !out].flatMap(right => {
      const x = right ? star.x + star.r + 7 : star.x - star.r - 7
      const room = Math.min(wanted, right ? width - x - 6 : x - 6)
      return rows(star).map(row => ({ right, x, room, y: star.y + row * LABEL_ROW }))
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

/** The view that brings a thread to the middle of the plate, deeper for a deeper thread; the whole field for one the plate has no body for. */
export function aim(plate: Plate, thread: MapThread): View {
  const star = plate.stars.find(item => item.thread === thread)
  if (!star) return WHOLE
  const k = Math.min(8, FOCUS_K * FOCUS_STEP ** Math.max(0, thread.depth - 1))
  return held({ k, x: .5 - star.x / plate.width * k, y: (plate.narrow ? FOCUS_Y_NARROW : FOCUS_Y) - star.y / plate.height * k })
}
/** The thread a hand has zoomed to: `kept` while it stays near the middle, else the nearest body there, once the view is deep enough to unfold it. */
export function sighted(plate: Plate, view: View, kept: string | null): string | null {
  if (view.k < REVEAL) return null
  const off = (star: Star): number => Math.max(Math.abs(star.x / plate.width * view.k + view.x - .5), Math.abs(star.y / plate.height * view.k + view.y - .5))
  const near = plate.stars.filter(star => isDrawn(star.thread) && off(star) <= SIGHT).sort((a, b) => off(a) - off(b))
  return (near.find(star => star.thread.key === kept) ?? near[0])?.thread.key ?? null
}

/** Unfolds the focused thread where it now sits, its threads gathered from the field onto its orbit. */
function gathered(plate: Plate, stars: Star[], model: FamilyModel, focus: Focus): Pick<Plate, 'stars' | 'locality' | 'labels'> | null {
  const thread = model.threads.get(focus.key), centre = stars.find(star => star.thread === thread)
  if (!thread || !centre) return null
  const locality = unfold(model, thread, focus.lead, plate, centre, centre.r, new Set(stars.map(star => star.thread.key)))
  const slots = new Map(locality.kids.map(slot => [slot.thread, slot]))
  return {
    locality,
    stars: stars.map(star => {
      const slot = slots.get(star.thread)
      if (star === centre) return { ...star, r: locality.r }
      return slot ? { ...star, x: slot.x, y: slot.y, r: Math.min(star.r, slot.r) } : star
    }),
    labels: locality.kids.map(slot => {
      const r = Math.min(stars.find(star => star.thread === slot.thread)!.r, slot.r), right = slot.side === 'right'
      return { thread: slot.thread, numeral: slot.thread.rank + 1, side: slot.side, x: slot.x + (right ? r + 7 : -r - 7), y: slot.y, width: slot.room - r - 7 }
    }),
  }
}

/**
 * The plate seen through a zoomed view: its geometry scaled, its marks their
 * reading size, a name on every thread in view with room for one, and past
 * `REVEAL` the focused thread unfolded in place of those names.
 */
export function zoomPlate(plate: Plate, view: View, model: FamilyModel, focus: Focus | null, numeral: (thread: MapThread) => number = thread => thread.rank + 1): Plate {
  const { k } = view
  if (k === 1) return plate
  const { width, height } = plate, dx = view.x * width, dy = view.y * height
  const stars = plate.stars.map(star => ({ ...star, x: star.x * k + dx, y: star.y * k + dy }))
  const cx = plate.cx * k + dx, cy = plate.cy * k + dy
  const zoomed = {
    ...plate, k, cx, cy, R: plate.R * k, stars, labels: [], numerals: [], arcs: [],
    rings: plate.rings.map(ring => ({ ...ring, radius: ring.radius * k })), grid: plate.grid.map(radius => radius * k),
    arms: plate.arms?.map(arm => ({ ...arm, x: arm.x * k + dx, y: arm.y * k + dy })),
  }
  const unfolded = focus && k >= REVEAL ? gathered(zoomed, stars, model, focus) : null
  if (unfolded) return { ...zoomed, ...unfolded }
  const inView = stars.filter(star => star.x >= 0 && star.x <= width && star.y >= 0 && star.y <= height)
  const named = inView.filter(star => isDrawn(star.thread)).sort((a, b) => numeral(a.thread) - numeral(b.thread))
  return { ...zoomed, labels: nearLabels(inView, named, numeral, cx, width, height) }
}

function drawLinks(layer: SVGGElement, plate: Plate): void {
  const star = new Map(plate.stars.map(item => [item.thread.key, item]))
  const near = new Set(plate.locality?.kids.map(slot => slot.thread))
  const links = plate.stars.filter(item => (plate.links || near.has(item.thread)) && item.thread.parent !== null && star.has(item.thread.parent))
  reconcile(layer, links, item => item.thread.key, () => {
    const path = svgEl('path', 'fm-link'); path.setAttribute('d', 'M0 0Q.5 .24 1 0'); path.setAttribute('vector-effect', 'non-scaling-stroke')
    return path
  }, (path, item) => {
    path.setAttribute('data-link', item.thread.key)
    path.setAttribute('data-standing', item.thread.tone)
    path.toggleAttribute('data-merged', item.thread.merged)
    path.toggleAttribute('data-far', !!plate.locality && !near.has(item.thread))
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
    line.setAttribute('data-standing', item.thread.tone)
    line.setAttribute('data-leader', item.thread.key)
    lay(line, item.a, item.b)
  })
}

/** One dot for each sent file, up to `MOONS`, spaced around the body from its foot. */
function moonPath(count: number, r: number): string {
  const shown = Math.min(count, MOONS)
  return Array.from({ length: shown }, (_, n) => {
    const angle = TURN / 4 + (n - (shown - 1) / 2) * MOON_STEP
    return `M${(r * Math.cos(angle) - 1.1).toFixed(1)} ${(r * Math.sin(angle)).toFixed(1)}a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0`
  }).join('')
}

function drawStars(layer: SVGGElement, plate: Plate, model: FamilyModel): void {
  const near = new Set(plate.locality?.kids.map(slot => slot.thread))
  reconcile(layer, plate.stars, item => item.thread.key, () => {
    const group = svgEl('g', 'fm-star')
    const hit = svgEl('circle', 'fm-star-hit'), halo = svgEl('circle', 'fm-star-halo'), ring = svgEl('circle', 'fm-star-ring'), mark = svgEl('path', 'fm-star-mark'), moons = svgEl('path', 'fm-star-moons'), fresh = svgEl('path', 'fm-star-fresh')
    group.append(hit, halo, ring, mark, moons, fresh)
    return group
  }, (group, item) => {
    const { thread, r } = item
    tagThread(group, thread)
    if (isDrawn(thread)) optionFor(group, thread, model)
    else for (const name of ['role', 'aria-label', 'aria-posinset', 'aria-setsize', 'aria-selected', 'tabindex']) group.removeAttribute(name)
    group.toggleAttribute('data-root', thread === model.root)
    group.toggleAttribute('data-merged', thread.merged)
    group.toggleAttribute('data-focus', thread === plate.locality?.thread)
    group.toggleAttribute('data-far', !!plate.locality && thread !== plate.locality.thread && !near.has(thread))
    group.toggleAttribute('data-near', near.has(thread))
    group.toggleAttribute('data-current', thread.key === model.current && thread !== model.root)
    group.style.transform = `translate(${item.x.toFixed(1)}px, ${item.y.toFixed(1)}px)`
    group.style.setProperty('--fm-heat', (1 - Math.sqrt(Math.max(0, model.now - thread.lastMove) / (6 * 86_400_000))).toFixed(2))
    const [hit, halo, ring, mark, moons, fresh] = group.children
    hit.setAttribute('r', String(plate.narrow ? r + 10 : Math.max(r + 4, 9)))
    halo.setAttribute('r', String(r + 5))
    ring.setAttribute('r', String(Math.max(r + 7, 7)))
    mark.setAttribute('d', markPath(thread.standing === 'blocked' ? 'blocked' : 'turn', r))
    moons.setAttribute('d', moonPath(thread.files.length, r + 3.5))
    fresh.setAttribute('d', thread.fresh ? markPath('new', 3.6) : '')
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
    rank.textContent = label.numeral ? String(label.numeral) : ''
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
    mark.firstElementChild!.setAttribute('d', markPath(thread.tone, 5))
    name.textContent = thread.name
    age.textContent = shortAgo(thread.lastMove, model.now)
  })
}

/** A sheet with its corner turned: a thing a thread holds. */
const SHEET = 'M-4.5 -6.5H2L4.5 -4V6.5H-4.5ZM2 -6.5V-4H4.5'
function heldMark(): SVGSVGElement {
  const mark = svgEl('svg', 'fm-held-mark'), sheet = svgEl('path', 'fm-held-sheet'), fresh = svgEl('path', 'fm-held-new')
  mark.setAttribute('viewBox', '-8 -8 16 16'); mark.setAttribute('aria-hidden', 'true')
  sheet.setAttribute('d', SHEET); fresh.setAttribute('d', markPath('new', 2.9)); fresh.setAttribute('transform', 'translate(5 -5.5)')
  mark.append(sheet, fresh)
  return mark
}
const heldId = (item: Satellite): string => item.file?.key ?? 'more'
/** What the focused thread holds: an orbit and its tethers in the field, a named way to each thing over it. */
function drawHeld(svg: SVGSVGElement, layer: HTMLElement, plate: Plate, model: FamilyModel): void {
  const local = plate.locality, at = local?.at ?? { x: 0, y: 0 }
  reconcile(part(svg, 'fm-orbits', cls => svgEl('g', cls)), local && local.reach ? [local] : [], () => 'orbit', () => svgEl('circle', 'fm-orbit'), (circle, item) => {
    circle.setAttribute('r', String(item.reach))
    circle.style.transform = `translate(${item.at.x.toFixed(1)}px, ${item.at.y.toFixed(1)}px)`
  })
  reconcile(part(svg, 'fm-tethers', cls => svgEl('g', cls)), local?.held.filter(item => item.file) ?? [], heldId, () => {
    const path = svgEl('path', 'fm-tether'); path.setAttribute('d', 'M0 0Q.5 .1 1 0'); path.setAttribute('vector-effect', 'non-scaling-stroke')
    return path
  }, (path, item) => lay(path, at, item))
  reconcile(layer, local?.held ?? [], heldId, item => {
    const way = item.file ? htmlEl('button', 'fm-held') : htmlEl('div', 'fm-held')
    if (item.file) (way as HTMLButtonElement).type = 'button'
    way.append(heldMark(), htmlEl('span', 'fm-held-name'), htmlEl('span', 'fm-held-age'))
    return way
  }, (way, item) => {
    const right = item.side === 'right', width = Math.round(item.room) + 8
    way.dataset.side = item.side
    way.toggleAttribute('data-lead', item.lead)
    way.toggleAttribute('data-unread', !!item.file?.unread)
    if (item.file) way.dataset.held = item.file.key
    way.style.width = `${width}px`
    way.style.transform = `translate(${(right ? item.x - 8 : item.x + 8 - width).toFixed(1)}px, ${(item.y - HELD_ROW / 2).toFixed(1)}px)`
    way.style.setProperty('--fm-from-x', `${(at.x - item.x).toFixed(1)}px`)
    way.style.setProperty('--fm-from-y', `${(at.y - item.y).toFixed(1)}px`)
    const [, name, age] = way.children
    name.textContent = item.file?.name ?? `+${item.more} more`
    age.textContent = item.file?.at ? shortAgo(item.file.at, model.now) : ''
  })
  reconcile(part(layer.parentElement!, 'fm-kickers', cls => htmlEl('div', cls)), local?.kickers ?? [], kicker => kicker.side, () => htmlEl('div', 'fm-held-kicker'), (el, kicker) => {
    el.textContent = kicker.label
    el.dataset.side = kicker.side
    el.style.transform = `translate(${kicker.x.toFixed(1)}px, ${(kicker.y - 8).toFixed(1)}px)`
  })
  const named = part(layer.parentElement!, 'fm-focus-names', cls => htmlEl('div', cls))
  reconcile(named, local ? [local] : [], () => 'focus', () => {
    const el = htmlEl('div', 'fm-focus')
    el.append(htmlEl('span', 'fm-focus-name'), htmlEl('span', 'fm-focus-state'))
    return el
  }, (el, item) => {
    tagThread(el, item.thread)
    const width = Math.max(FOCUS_NAME, item.reach * 1.5)
    el.style.width = `${Math.round(width)}px`
    el.style.transform = `translate(${(item.at.x - width / 2).toFixed(1)}px, ${(item.at.y + item.r + 13).toFixed(1)}px)`
    const [name, state] = el.children
    name.textContent = item.thread.name
    state.textContent = `${item.thread.word} · ${shortAgo(item.thread.lastMove, model.now)}`
  })
}

/** The arms' names, on a drawing with arms. */
function drawArmNames(layer: HTMLElement, plate: Plate): void {
  reconcile(layer, plate.arms ?? [], arm => arm.label, arm => htmlEl('div', 'fm-arm-name', arm.label), (el, arm) => {
    el.dataset.side = arm.side
    el.style.transform = `translate(${arm.x.toFixed(1)}px, ${arm.y.toFixed(1)}px)`
  })
}

/** Paints a plate into the host, keeping every element it can. */
export function paintPlate(host: HTMLElement, plate: Plate, model: FamilyModel): void {
  const frame = part(host, 'fm-sky-plate', cls => htmlEl('div', cls))
  host.classList.toggle('family-map-zoomed', plate.k > 1)
  host.classList.toggle('family-map-unfolded', !!plate.locality)
  frame.style.height = `${plate.height}px`
  const svg = part(frame, 'fm-sky-svg', cls => svgEl('svg', cls))
  svg.setAttribute('viewBox', `0 0 ${plate.width} ${plate.height}`)
  const field = `translate(${plate.cx.toFixed(1)}px, ${plate.cy.toFixed(1)}px) scale(${plate.k})`
  const circle = (el: SVGCircleElement, radius: number): void => { el.setAttribute('r', (radius / plate.k).toFixed(1)) }
  const grid = part(svg, 'fm-grid', cls => svgEl('g', cls)), rings = part(svg, 'fm-rings', cls => svgEl('g', cls))
  grid.style.transform = rings.style.transform = field
  reconcile(grid, plate.grid.map((radius, n) => ({ radius, n })), ring => String(ring.n), () => svgEl('circle'), (el, ring) => circle(el, ring.radius))
  reconcile(rings, plate.rings, ring => ring.label, () => svgEl('circle'), (el, ring) => circle(el, ring.radius))
  reconcile(part(svg, 'fm-ring-names', cls => svgEl('g', cls)), plate.rings.filter(ring => ring.marked), ring => ring.label, ring => {
    const text = svgEl('text'); text.textContent = ring.label
    return text
  }, (text, ring) => {
    text.style.transform = `translate(${(plate.cx + ring.radius * Math.cos(plate.scale)).toFixed(1)}px, ${(plate.cy + ring.radius * Math.sin(plate.scale) + 4).toFixed(1)}px)`
  })
  if (plate.line) {
    const line = part(svg, 'fm-line', cls => svgEl('g', cls))
    line.style.transform = field
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
  drawHeld(svg, part(frame, 'fm-helds', cls => htmlEl('div', cls)), plate, model)
  drawStars(part(svg, 'fm-stars', cls => svgEl('g', cls)), plate, model)
  drawArcs(part(svg, 'fm-arcs', cls => svgEl('g', cls)), plate)
  drawLabels(part(frame, 'fm-labels', cls => htmlEl('div', cls)), part(frame, 'fm-numerals', cls => htmlEl('div', cls)), plate, model)
  drawArmNames(part(frame, 'fm-arm-names', cls => htmlEl('div', cls)), plate)
  drawLedger(part(host, 'fm-ledger', cls => htmlEl('div', cls)), model, plate.narrow)
}
