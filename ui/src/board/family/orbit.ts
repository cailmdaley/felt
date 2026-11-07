import { isDrawn, needsHuman, type FamilyModel, type MapThread } from './model.js'
import { WHOLE, held, type View } from './zoom.js'
import { REVEAL, miniature, unfold, type Locality, type Mini, type Satellite } from './locality.js'
import { htmlEl, lay, markPath, optionFor, part, reconcile, shortAgo, svgEl, tagThread, type Point, type Sight } from './drawing.js'

/** The radial drawing's plate: bodies, arcs, names, a ledger on a phone, and a focused thread unfolded in place. */
export const TURN = 2 * Math.PI
export const LABEL_ROW = 24
const NUMERAL = 19
export const LABEL_MAX = 310
/** A satellite's row, as family-map.css sets it. */
const HELD_ROW = 24
const FOCUS_NAME = 190
/** A miniature's button, as family-map.css sets it. */
const MINI_MARK = 14
const BODY_MAX = 15
/** A serif name's width per character, kept generous so a whole name always fits, and what its number and age add. */
const LABEL_CHAR = 7.4
const LABEL_MARKS = 62
const MARGIN = 8
/** Sent files a body shows as dots, and their spacing around it. */
const MOONS = 8
const MOON_STEP = .42
/** The scale a thread is flown to, a step deeper for each generation below the first. */
const FOCUS_K = 3
const FOCUS_SHARE = .3
/** Where a flight leaves its thread, as a share of the plate's height. */
const FOCUS_Y = .46
const FOCUS_Y_NARROW = .14
/** How far from the plate's middle a body can be and still be the one a hand has zoomed to, as a share of the plate. */
const SIGHT = .3
/** How near a body's own scale the view must be for a hand to have reached it. */
const SIGHT_DEPTH = .6
const GATHERED_LEAST = 4
/** How long a close still counts as just come back up. */
const RECENT_MS = 24 * 3_600_000
/** How many bodies in view show what they hold. */
const MINIS = 8

export interface Star extends Point {
  thread: MapThread
  angle: number
  /** Its radius at the whole field. */
  r: number
  /** Its radius once there is room. */
  full: number
  /** The room around it for its own threads, on the whole field. */
  reach: number
}
export interface SkyLabel extends Point { thread: MapThread; numeral: number; width: number; side: 'left' | 'right'; rim?: Point }
export interface SkyNumeral extends Point { thread: MapThread; numeral: number; rim?: Point }
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
  /** The arms the bodies sit on, from the centre: what rises to the human and what recedes. */
  line?: { rising: string; receding: string }
  /** The arms' names, by the tips they end at. */
  arms?: ArmName[]
  /** The thread unfolded around its body, and the threads gathered to it. */
  locality?: Locality
  /** Bodies in view with what they hold, in miniature. */
  minis?: Mini[]
}
export interface ArmName extends Point { label: string; side: 'left' | 'right' }

/** A body's radius from its work, at a sky of R = 300: a thread or, one scale up, a whole family. */
export const bodySize = (work: number): number => 2.2 + Math.sqrt(work) * 1.05
export const bodyRadius = (thread: MapThread, unit: number): number => {
  if (thread.merged) return unit * 1.5
  return unit * Math.max(thread.tone === 'question' || thread.tone === 'blocked' ? 7 : needsHuman(thread) ? 5.5 : thread.standing === 'working' ? 4 : 2.2, Math.min(BODY_MAX, bodySize(thread.weight)))
}
export const rootRadius = (model: FamilyModel, unit: number): number => unit * Math.min(28, 8 + bodySize(model.mass) * .8)

/** How far from its body a name may sit, in rows, nearest first. */
export const NEAR_ROWS: readonly number[] = [0, -1, 1, -2, 2, -3, 3]
export interface Box { left: number; right: number; top: number; bottom: number }

/** Each name beside its body, on whichever side and row first keeps clear of every other name and body, whole or not at all. */
export function nearLabels(stars: readonly Star[], named: readonly Star[], numeral: (thread: MapThread) => number, cx: number, width: number, height: number, reserved: readonly Box[] = [], rows: (star: Star) => readonly number[] = () => NEAR_ROWS): SkyLabel[] {
  const placed: Box[] = [...reserved], labels: SkyLabel[] = []
  const touches = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  const clear = (box: Box, own: Star): boolean => !placed.some(other => touches(box, other))
    && stars.every(star => star === own || !touches(box, { left: star.x - star.r, right: star.x + star.r, top: star.y - star.r, bottom: star.y + star.r }))
  for (const star of named) {
    const out = star.x >= cx, wanted = star.thread.name.length * LABEL_CHAR + LABEL_MARKS
    const options = [out, !out].flatMap(right => {
      const x = right ? star.x + star.r + 7 : star.x - star.r - 7
      const room = Math.min(wanted, right ? width - x - MARGIN : x - MARGIN)
      return rows(star).map(row => ({ right, x, room, y: star.y + row * LABEL_ROW }))
    }).filter(option => option.room >= wanted && option.y >= LABEL_ROW / 2 && option.y <= height - LABEL_ROW / 2)
    const box = (option: typeof options[number]): Box => ({ left: option.right ? option.x : option.x - option.room, right: option.right ? option.x + option.room : option.x, top: option.y - LABEL_ROW / 2, bottom: option.y + LABEL_ROW / 2 })
    const chosen = options.find(option => clear(box(option), star))
    if (!chosen) continue
    placed.push(box(chosen))
    labels.push({
      thread: star.thread, numeral: numeral(star.thread), side: chosen.right ? 'right' : 'left', x: chosen.x, y: chosen.y, width: chosen.room,
      rim: chosen.y === star.y ? undefined : { x: chosen.x + (chosen.right ? -3 : 3), y: chosen.y },
    })
  }
  return labels
}

/** The scale at which a body's room for its own threads fills the middle of the plate. */
const scaleFor = (plate: Plate, star: Star): number => Math.max(FOCUS_K, FOCUS_SHARE * Math.min(plate.width, plate.height) / star.reach)
/** The view that brings a thread to the middle of the plate, deeper for a deeper thread; the whole field for one the plate has no body for. */
export function aim(plate: Plate, thread: MapThread): View {
  const star = plate.stars.find(item => item.thread === thread)
  if (!star) return WHOLE
  const k = scaleFor(plate, star)
  return held({ k, x: .5 - star.x / plate.width * k, y: (plate.narrow ? FOCUS_Y_NARROW : FOCUS_Y) - star.y / plate.height * k })
}
/** The thread a hand has zoomed to: `kept` while it stays near the middle, else the nearest body there, once the view is deep enough to unfold it. */
export function sighted(plate: Plate, view: View, kept: string | null): string | null {
  if (view.k < REVEAL) return null
  const off = (star: Star): number => Math.max(Math.abs(star.x / plate.width * view.k + view.x - .5), Math.abs(star.y / plate.height * view.k + view.y - .5))
  const near = plate.stars.filter(star => isDrawn(star.thread) && off(star) <= SIGHT && view.k >= scaleFor(plate, star) * SIGHT_DEPTH).sort((a, b) => off(a) - off(b))
  return (near.find(star => star.thread.key === kept) ?? near[0])?.thread.key ?? null
}

/** A gathered thread's body: its own, within its slot, and never too small to see. */
const gatheredBody = (r: number, slot: number): number => Math.max(GATHERED_LEAST, Math.min(r, slot))
/** Unfolds the focused thread where it now sits, its threads gathered from the field onto its places when the map flew there. */
function gathered(plate: Plate, stars: Star[], model: FamilyModel, sight: Sight): Pick<Plate, 'stars' | 'locality' | 'labels'> | null {
  const thread = sight.key ? model.threads.get(sight.key) : undefined, centre = stars.find(star => star.thread === thread)
  if (!thread || !centre) return null
  const locality = unfold(model, thread, sight.holds(thread), sight.gather, plate, centre, centre.r, new Set(stars.map(star => star.thread.key)))
  const slots = new Map(locality.kids.map(slot => [slot.thread, slot]))
  return {
    locality,
    stars: stars.map(star => {
      const slot = slots.get(star.thread)
      if (star === centre) return { ...star, r: locality.r }
      return slot ? { ...star, x: slot.x, y: slot.y, r: gatheredBody(star.r, slot.r) } : star
    }),
    labels: locality.kids.map(slot => {
      const r = gatheredBody(stars.find(star => star.thread === slot.thread)!.r, slot.r), right = slot.side === 'right'
      return { thread: slot.thread, numeral: slot.thread.rank + 1, side: slot.side, x: slot.x + (right ? r + 7 : -r - 7), y: slot.y, width: slot.room - r - 7 }
    }),
  }
}
/** What an unfolded thread's names take up, for other names to keep clear of. */
const heldBoxes = (locality: Locality): Box[] => [
  ...locality.held.map(item => ({ left: item.side === 'right' ? item.x - 8 : item.x - item.room, right: item.side === 'right' ? item.x + item.room : item.x + 8, top: item.y - HELD_ROW / 2, bottom: item.y + HELD_ROW / 2 })),
  { left: locality.at.x - FOCUS_NAME / 2, right: locality.at.x + FOCUS_NAME / 2, top: locality.at.y + locality.r, bottom: locality.at.y + locality.r + 3 * LABEL_ROW },
]

/**
 * The plate seen through a zoomed view: its geometry scaled, its marks their
 * reading size, and what shows growing with the scale. Every body in view takes
 * a name where it has room. From `REVEAL` the focused thread unfolds at full
 * size and the bodies nearest the middle show what they hold in miniature, the
 * bodies staying where they are; a flight's arrival instead gathers the
 * thread's own threads, steps the field back and gives the stage to that thread.
 */
export function zoomPlate(plate: Plate, view: View, model: FamilyModel, sight: Sight | null, numeral: (thread: MapThread) => number = thread => thread.rank + 1): Plate {
  const { k } = view
  if (k === 1) return plate
  const { width, height } = plate, dx = view.x * width, dy = view.y * height
  const stars = plate.stars.map(star => ({ ...star, x: star.x * k + dx, y: star.y * k + dy, r: Math.min(star.full, star.r * k) }))
  const cx = plate.cx * k + dx, cy = plate.cy * k + dy
  const zoomed = {
    ...plate, k, cx, cy, R: plate.R * k, stars, labels: [], numerals: [],
    arms: [],
  }
  const deep = sight && k >= REVEAL ? sight : null
  const unfolded = deep ? gathered(zoomed, stars, model, deep) : null
  if (unfolded?.locality?.gathered) return { ...zoomed, ...unfolded }
  const focused = unfolded?.locality?.thread
  const inView = stars.filter(star => star.x >= 0 && star.x <= width && star.y >= 0 && star.y <= height)
  const named = inView.filter(star => isDrawn(star.thread) && star.thread !== focused).sort((a, b) => numeral(a.thread) - numeral(b.thread))
  const middle = (star: Star): number => Math.hypot(star.x - width / 2, star.y - height / 2)
  const minis = deep ? named.slice().sort((a, b) => middle(a) - middle(b)).slice(0, MINIS).map(star => miniature(star.thread, deep.holds(star.thread), star, star.r, k)) : []
  return { ...zoomed, ...unfolded, minis, labels: nearLabels(inView, named, numeral, cx, width, height, unfolded?.locality ? heldBoxes(unfolded.locality) : []) }
}

/**
 * Lineage where it says something: below the first generation, around an
 * unfolded thread, and for what just came back up. A direct child's line to the
 * root is implied by the family, drawn only on the selected thread's path.
 */
function drawLinks(layer: SVGGElement, plate: Plate, model: FamilyModel): void {
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
    path.toggleAttribute('data-far', !!plate.locality?.gathered && !near.has(item.thread))
    path.toggleAttribute('data-says', item.thread.depth > 1 || near.has(item.thread) || item.thread.fresh || model.now - (item.thread.ended ?? 0) < RECENT_MS)
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
    optionFor(group, thread, model)
    group.toggleAttribute('data-root', thread === model.root)
    group.toggleAttribute('data-merged', thread.merged)
    group.toggleAttribute('data-focus', thread === plate.locality?.thread)
    group.toggleAttribute('data-far', !!plate.locality?.gathered && thread !== plate.locality.thread && !near.has(thread))
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
    age.textContent = label.thread.name.length * LABEL_CHAR > 2 * (label.width - LABEL_MARKS) ? '' : shortAgo(label.thread.lastMove, model.now)
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
const heldId = (item: Satellite): string => item.file?.key ?? `more:${item.side}`
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
    way.dataset.kind = item.kind
    way.toggleAttribute('data-unread', !!item.file?.unread)
    if (item.file) { way.dataset.held = item.file.key; way.dataset.owner = local!.thread.key }
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
    el.style.transform = `translate(${(kicker.x + (kicker.side === 'right' ? 8 : -8)).toFixed(1)}px, ${(kicker.y - 8).toFixed(1)}px)`
  })
  reconcile(part(layer.parentElement!, 'fm-minis', cls => htmlEl('div', cls)), plate.minis ?? [], mini => mini.thread.key, () => htmlEl('div', 'fm-mini-set'), (set, mini) => {
    set.dataset.owner = mini.thread.key
    reconcile(set, mini.marks, mark => mark.file.key, () => {
      const way = htmlEl('button', 'fm-mini'); way.type = 'button'
      way.append(heldMark())
      return way
    }, (way, mark) => {
      way.dataset.held = mark.file.key
      way.dataset.owner = mini.thread.key
      way.dataset.kind = mark.kind
      way.title = mark.file.name
      way.setAttribute('aria-label', `${mark.file.name}, ${mini.thread.name}`)
      way.toggleAttribute('data-unread', mark.file.unread)
      way.style.transform = `translate(${(mark.x - MINI_MARK / 2).toFixed(1)}px, ${(mark.y - MINI_MARK / 2).toFixed(1)}px)`
    })
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
  drawLinks(part(svg, 'fm-links', cls => svgEl('g', cls)), plate, model)
  drawLeaders(part(svg, 'fm-leaders', cls => svgEl('g', cls)), plate)
  drawHeld(svg, part(frame, 'fm-helds', cls => htmlEl('div', cls)), plate, model)
  drawStars(part(svg, 'fm-stars', cls => svgEl('g', cls)), plate, model)
  drawLabels(part(frame, 'fm-labels', cls => htmlEl('div', cls)), part(frame, 'fm-numerals', cls => htmlEl('div', cls)), plate, model)
  drawArmNames(part(frame, 'fm-arm-names', cls => htmlEl('div', cls)), plate)
  drawLedger(part(host, 'fm-ledger', cls => htmlEl('div', cls)), model, plate.narrow)
}
