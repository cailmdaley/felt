import { isDrawn, type FamilyModel, type MapThread, type Standing } from './model.js'
import { NARROW, HOUR, DAY, htmlEl, mount, part, type Drawing, type OpenThread, type Point, type Sight } from './drawing.js'
import { QUIET_STEP, RIM_STEP, TURN, bodyRadius, labelFit, labelHeight, labelRoom, ownRadius, paintPlate, rootRadius, zoomPlate, type Frame, type Plate, type Segment, type Star } from './orbit.js'
import { WHOLE, type View } from './zoom.js'

export type Arm = 'todo' | 'done'
/** The to-do arm's run, in turns from east, clockwise on screen: from a curl under the body, up the left, over the top, and on along the rim for what has no row. */
const ARM_FROM = .11
const ARM_TIP = .78
const ARM_TAIL = .95
/** How the arm opens: its radius grows as this power of the way along it, tight about the body. */
const ARM_OPENING = 1.5
const ARM_START = 16
/** The arm's radius at its waist, due west, as a share of its reach. */
const WAIST = .5
const SAMPLES = 240
/** How many passes settle a station's height against the name it leaves room for. */
const ROUNDS = 3
/** A to-do arm's extra gap where the kind of ask changes. */
const KIND_GAP = 8
/** The room inside a body for its own threads: a leaf's, and how it grows with what is under it. */
const ROOM_LEAF = 14
const ROOM_GROWTH = 12
const ROOM_MOST = .24
const DRAG_FROM = 5
/** What the just-finished arm's length stands for: an hour to the map's window, on a log scale. */
const AGE_FIRST = HOUR
const AGE_LAST = 14 * DAY
const ARM_NAMES: Readonly<Record<Arm, string>> = { todo: 'To do', done: 'Just finished' }

/** A body the human placed: its arm and slot around its orchestrator, held while its state lasts. */
export interface Pin { arm: Arm; slot: number; standing: Standing }
export type Pins = Record<string, Pin>
interface Measure { best: number; live: boolean; count: number }

const pinsKey = (model: FamilyModel): string => `shuttle.family.spiral:${model.root.card.originId}:${model.root.card.uid ?? model.root.card.id}`
function readPins(model: FamilyModel): Pins {
  try { return JSON.parse(localStorage.getItem(pinsKey(model)) ?? '{}') as Pins } catch { return {} }
}
function writePins(model: FamilyModel, pins: Pins): void {
  try {
    if (Object.keys(pins).length) localStorage.setItem(pinsKey(model), JSON.stringify(pins))
    else localStorage.removeItem(pinsKey(model))
  } catch { /* Storage is optional. */ }
}

/**
 * The order along an arm: pinned threads hold the slots the human gave them,
 * the first named winning a contested slot, and everything else keeps its
 * order around them.
 */
export function arrange(order: readonly MapThread[], pins: Readonly<Record<string, number>>): MapThread[] {
  const slots = new Array<MapThread | undefined>(order.length), byKey = new Map(order.map(thread => [thread.key, thread]))
  const free = (from: number): number => { let at = Math.min(from, order.length - 1); while (slots[at] && at < order.length - 1) at++; while (slots[at]) at--; return at }
  for (const [key, slot] of Object.entries(pins)) {
    const thread = byKey.get(key)
    if (thread) slots[free(slot)] = thread
  }
  const rest = order.filter(thread => !slots.includes(thread))
  return Array.from(slots, slot => slot ?? rest.shift()!)
}

/** What each thread's subtree comes to: its most urgent rank, whether anything in it is in play, and how many threads it draws. */
function measured(model: FamilyModel): Map<MapThread, Measure> {
  const out = new Map<MapThread, Measure>()
  const walk = (thread: MapThread): Measure => {
    const own: Measure = { best: isDrawn(thread) ? thread.rank : Infinity, live: model.attention.includes(thread) || thread.standing === 'still', count: isDrawn(thread) ? 1 : 0 }
    for (const key of thread.children) {
      const kid = walk(model.threads.get(key)!)
      own.best = Math.min(own.best, kid.best); own.live ||= kid.live; own.count += kid.count
    }
    out.set(thread, own)
    return own
  }
  walk(model.root)
  return out
}
/** A thread's two arms, in order from its body: what has anything in play in it is to do, the rest just finished. */
export function armsOf(model: FamilyModel, thread: MapThread = model.root, pins: Pins = readPins(model), measures = measured(model)): Record<Arm, MapThread[]> {
  const kids = thread.children.map(key => model.threads.get(key)!).filter(kid => measures.get(kid)!.count > 0).sort((a, b) => measures.get(a)!.best - measures.get(b)!.best)
  const arm = (name: Arm): MapThread[] => {
    const on = kids.filter(kid => (pins[kid.key]?.arm ?? (measures.get(kid)!.live ? 'todo' : 'done')) === name)
    return arrange(on, Object.fromEntries(on.flatMap(kid => pins[kid.key] ? [[kid.key, pins[kid.key].slot]] : [])))
  }
  return { todo: arm('todo'), done: arm('done') }
}
/** A pin lasts while the thread's state does, so a thread set aside comes back when it next asks. */
function livePins(model: FamilyModel): Pins {
  const pins = readPins(model), live = Object.fromEntries(Object.entries(pins).filter(([key, pin]) => model.threads.get(key)?.standing === pin.standing))
  if (Object.keys(live).length !== Object.keys(pins).length) writePins(model, live)
  return live
}

/** The two arms' shared curve in a scene: the to-do arm, whose point reflection is the just-finished arm. */
interface Curve { points: Point[]; foot: number; tip: number }
function curveOf(frame: Frame): Curve {
  const { reach, stretch } = frame
  const points = Array.from({ length: SAMPLES + 1 }, (_, n): Point => {
    const way = n / SAMPLES, turn = ARM_FROM + (ARM_TAIL - ARM_FROM) * way, along = Math.min(1, (turn - ARM_FROM) / (ARM_TIP - ARM_FROM))
    const radius = ARM_START + (reach - ARM_START) * along ** ARM_OPENING
    return { x: stretch * radius * Math.cos(turn * TURN), y: radius * Math.sin(turn * TURN) }
  })
  const lowest = (best: number, point: Point, n: number): number => point.y > points[best].y ? n : best
  const highest = (best: number, point: Point, n: number): number => point.y < points[best].y ? n : best
  return { points, foot: points.reduce(lowest, 0), tip: points.reduce(highest, 0) }
}
const pointAt = ({ points }: Curve, index: number): Point => {
  const low = Math.floor(index), share = index - low, a = points[low], b = points[Math.min(low + 1, SAMPLES)]
  return { x: a.x + (b.x - a.x) * share, y: a.y + (b.y - a.y) * share }
}
/** The curve's place at height `y`, on the run from its foot to its tip, where each height has one. */
function indexAt(curve: Curve, y: number): number {
  const { points, foot, tip } = curve
  for (let n = foot; n < tip; n++) if (points[n + 1].y <= y) return n + (points[n].y - y) / (points[n].y - points[n + 1].y)
  return tip
}
/** The path along the curve between two places, reflected for the just-finished arm. */
function pathOf(curve: Curve, from: number, to: number, sign: 1 | -1): string {
  const stops = [from, ...Array.from({ length: Math.ceil(to) - Math.ceil(from) }, (_, n) => Math.ceil(from) + n), to]
  return stops.map((index, n) => { const { x, y } = pointAt(curve, index); return `${n ? 'L' : 'M'}${(sign * x).toFixed(1)} ${(sign * y).toFixed(1)}` }).join('')
}

interface Spot extends Point { thread: MapThread; arm: Arm; side: 'left' | 'right'; r: number; room: number }
/**
 * How far up a run of this length each thread's station falls, as many as fit:
 * pushed up from its wanted place only as far as the one below needs, then back
 * down only as far as the run's end needs.
 */
function stationsOf(needs: readonly number[], gaps: readonly number[], wants: readonly number[], run: number): number[] {
  const ups: number[] = []
  let used = 0
  for (let n = 0; n < needs.length && used + gaps[n] + needs[n] <= run; n++) {
    used += gaps[n] + needs[n]
    ups.push(Math.max(n ? ups[n - 1] + (needs[n - 1] + needs[n]) / 2 + gaps[n] : needs[0] / 2, wants[n]))
  }
  for (let n = ups.length - 1, last = run - needs[ups.length - 1] / 2; n >= 0; n--) {
    ups[n] = Math.min(ups[n], last)
    if (n) last = ups[n] - (needs[n] + needs[n - 1]) / 2 - gaps[n]
  }
  return ups
}

/** How far up the arm a thread's age sets it, as a share of its reading run. */
const ageShare = (age: number): number => Math.max(0, Math.min(1, Math.log(1 + age / AGE_FIRST) / Math.log(1 + AGE_LAST / AGE_FIRST)))

/**
 * One arm of a scene. Each thread takes a station up the arm with the height its
 * name and room need, so its name runs out from the arm on a line of its own:
 * to do from the foot, in order, its kinds set apart; just finished where its
 * age falls on the log scale, pushed along only as far as its neighbours need.
 * What has no row runs on around the rim, small and for the zoom to name.
 */
function layArm(kids: readonly MapThread[], arm: Arm, frame: Frame, curve: Curve, count: (kid: MapThread) => number, now: number): { spots: Spot[]; segments: Segment[] } {
  const sign = arm === 'todo' ? 1 : -1, { reach } = frame
  const footY = curve.points[curve.foot].y, run = footY - curve.points[curve.tip].y - labelHeight(1)
  const rooms = kids.map(kid => count(kid) > 1 ? Math.min(reach * ROOM_MOST, ROOM_LEAF + ROOM_GROWTH * Math.sqrt(count(kid) - 1)) : ROOM_LEAF)
  const radii = kids.map(kid => bodyRadius(kid, 1))
  const wants = kids.map(kid => arm === 'done' ? run * ageShare(now - kid.lastMove) : 0)
  const gaps = kids.map((kid, n) => n && arm === 'todo' && kid.standing !== kids[n - 1].standing ? KIND_GAP : 0)
  const needAt = (n: number, up: number): number => {
    const { x } = pointAt(curve, indexAt(curve, footY - up)), fit = frame.narrow ? undefined : labelFit(kids[n], labelRoom(frame.width / 2, Math.abs(x), radii[n]))
    return Math.max(fit ? labelHeight(fit.lines) : frame.narrow ? RIM_STEP : QUIET_STEP, 2 * radii[n] + 4, count(kids[n]) > 1 ? rooms[n] * 1.4 : 0)
  }
  let ups = kids.map(() => 0)
  for (let round = 0; round < ROUNDS; round++) ups = stationsOf(kids.map((_, n) => needAt(n, ups[n] ?? run)), gaps, wants, run)
  const pitch = Math.hypot(curve.points[curve.tip + 1].x - curve.points[curve.tip].x, curve.points[curve.tip + 1].y - curve.points[curve.tip].y)
  const step = Math.min(RIM_STEP / pitch, (SAMPLES - curve.tip) / Math.max(1, kids.length - ups.length))
  const within = kids.map((_, n) => n < ups.length ? indexAt(curve, footY - ups[n]) : curve.tip + (n - ups.length + 1) * step)
  const spots = kids.map((thread, n): Spot => {
    const { x, y } = pointAt(curve, within[n]), tail = n >= ups.length
    return { thread, arm, side: tail === (arm === 'todo') ? 'right' : 'left', x: sign * x, y: sign * y, r: tail ? Math.min(radii[n], 3) : radii[n], room: rooms[n] }
  })
  const keys = kids.map(kid => kid.key)
  const segments = kids.map((kid, n): Segment => ({ id: `${arm}${n}`, tone: kid.tone, quiet: n >= ups.length, links: keys.slice(n), d: pathOf(curve, n ? within[n - 1] : 0, within[n], sign) }))
  return { spots, segments }
}

/** A thread's room for its own threads, in the drawn threads under it, itself included. */
const roomCount = (measures: Map<MapThread, Measure>) => (kid: MapThread): number => measures.get(kid)!.count

export const frameOf = (width: number, height: number): Frame => {
  const narrow = width < NARROW, reach = Math.floor(narrow ? width / 2 - 18 : Math.min(height / 2 - 26, width / 2 - 34))
  const waist = narrow ? reach * WAIST : Math.max(reach * .4, Math.min(reach * .8, width / 2 - 290))
  return { width, height: narrow ? 2 * reach + 36 : height, cx: width / 2, cy: narrow ? reach + 18 : height / 2, reach, stretch: waist / (reach * WAIST), narrow }
}

/**
 * Where everything goes, one scene inside another. A scene is a thread at the
 * centre with its two arms: to do rising up the left and just finished falling
 * down the right, each a reflection of the other, so names run outward with
 * nothing to cross. Every thread's own scene is that same picture scaled down
 * into the room its place on the arm gives it, so zooming in on a body arrives
 * at exactly the picture a click lands on, at every level.
 */
export function radialLayout(model: FamilyModel, width: number, height: number): Plate {
  const frame = frameOf(width, height), curve = curveOf(frame), { reach } = frame
  const measures = measured(model), pins = readPins(model), stars: Star[] = [], count = roomCount(measures)
  const place = (thread: MapThread, x: number, y: number, r: number, full: number, room: number, owner: Star | null, spot: Spot | null): void => {
    const star: Star = {
      thread, x, y, r, full, own: thread === model.root ? rootRadius(model, 1) : ownRadius(thread), room, scale: room / reach, owner, side: spot?.side ?? 'right', arm: spot?.arm ?? null,
      numeral: isDrawn(thread) && measures.get(thread)!.live ? thread.rank + 1 : 0, segments: [],
    }
    stars.push(star)
    const arms = armsOf(model, thread, pins, measures)
    const laid = (['todo', 'done'] as const).map(name => layArm(arms[name], name, frame, curve, count, model.now))
    star.segments = laid.flatMap(arm => arm.segments)
    for (const { spots } of laid) for (const spot of spots) place(spot.thread, x + spot.x * star.scale, y + spot.y * star.scale, spot.r * star.scale, spot.r, spot.room * star.scale, star, spot)
  }
  place(model.root, frame.cx, frame.cy, rootRadius(model, 1), rootRadius(model, 1), reach, null, null)
  return { ...frame, stars, armNames: ARM_NAMES }
}

const plates = new WeakMap<FamilyModel, { size: string; plate: Plate }>()
/** The layout for a size and the placements in force, kept for as long as the field only moves. */
function plateFor(model: FamilyModel, width: number, height: number): Plate {
  const size = `${width}x${height}:${JSON.stringify(readPins(model))}`, kept = plates.get(model)
  if (kept?.size === size) return kept.plate
  const plate = radialLayout(model, width, height)
  plates.set(model, { size, plate })
  return plate
}

/** A body dragged follows the pointer; its side of its orchestrator chooses the arm and its height the slot, and the others glide around it. */
function drag(host: HTMLElement, start: PointerEvent): void {
  const body = (start.target as Element).closest<SVGGElement>('.fm-star')
  const key = body?.getAttribute('data-thread')
  if (!body || !key || start.button !== 0) return
  let moving = false
  const move = (event: PointerEvent): void => {
    if (event.pointerId !== start.pointerId || !host.classList.contains('family-map-radial')) return
    const { model, open, view, sight } = current.get(host)!
    const thread = model.threads.get(key), parent = thread?.parent ? model.threads.get(thread.parent) : undefined
    if (!thread || !parent) return
    if (!moving && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < DRAG_FROM) return
    moving = true
    host.classList.add('family-map-dragging')
    const box = host.getBoundingClientRect(), width = host.clientWidth || 1000, height = host.clientHeight || 680
    const layout = plateFor(model, width, height), own = { x: event.clientX - box.left + host.scrollLeft, y: event.clientY - box.top + host.scrollTop }
    const point = { x: (own.x - view.x * width) / view.k, y: (own.y - view.y * layout.height) / view.k }
    const centre = layout.stars.find(star => star.thread === parent)!
    const arm: Arm = point.x < centre.x ? 'todo' : 'done', arms = armsOf(model, parent)
    const others = arms[arm].filter(kid => kid !== thread).map(kid => layout.stars.find(star => star.thread === kid)!)
    const slot = others.filter(star => arm === 'todo' ? star.y > point.y : star.y < point.y).length
    if (!arms[arm].includes(thread) || arms[arm].indexOf(thread) !== slot) {
      const pins = { ...readPins(model) }
      delete pins[key]
      writePins(model, { [key]: { arm, slot, standing: thread.standing }, ...pins })
      radial.draw(host, model, open, view, sight)
    }
    body.setAttribute('data-dragged', '')
    body.style.transform = `translate(${own.x.toFixed(1)}px, ${own.y.toFixed(1)}px)`
  }
  const up = (event: PointerEvent): void => {
    if (event.pointerId !== start.pointerId) return
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    host.classList.remove('family-map-dragging')
    body.removeAttribute('data-dragged')
    if (!moving) return
    const { model, open, view, sight } = current.get(host)!
    radial.draw(host, model, open, view, sight)
    const swallow = (event: Event): void => { event.stopPropagation() }
    host.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => host.removeEventListener('click', swallow, { capture: true }))
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

/** What a host last drew, which the one drag listener it keeps always reads. */
const current = new WeakMap<HTMLElement, { model: FamilyModel; open: OpenThread; view: View; sight: Sight | null }>()

export const radial: Drawing = {
  name: 'radial', label: 'Radial',
  reading: ['Nearest comes first', 'Size is work', 'Drag to reorder', 'Pinch to zoom'],
  layout: plateFor,
  draw(host, model, open, view = WHOLE, sight = null) {
    const { width, height } = mount(host, 'radial', model, open)
    const pins = livePins(model)
    paintPlate(host, zoomPlate(plateFor(model, width, height), view, model, sight), model)
    for (const body of host.querySelectorAll<SVGGElement>('.fm-star')) body.toggleAttribute('data-pinned', body.getAttribute('data-thread')! in pins)
    if (!current.has(host)) host.addEventListener('pointerdown', event => { if (host.classList.contains('family-map-radial')) drag(host, event) })
    current.set(host, { model, open, view, sight })
    const reset = part(host, 'fm-unpin', cls => { const button = htmlEl('button', cls, 'Back to attention order'); button.type = 'button'; return button })
    reset.hidden = !Object.keys(pins).length
    reset.onclick = event => { event.stopPropagation(); writePins(model, {}); radial.draw(host, model, open, view, sight) }
  },
}
