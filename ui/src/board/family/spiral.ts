import { needsHuman, type FamilyModel, type MapThread, type Standing } from './model.js'
import { NARROW, htmlEl, mount, part, type Drawing, type Focus, type OpenThread, type Point } from './drawing.js'
import { NEAR_ROWS, TURN, bodyRadius, bodySize, nearLabels, paintPlate, rootRadius, zoomPlate, type ArmName, type Box, type Plate, type Star } from './orbit.js'
import { WHOLE, type View } from './zoom.js'

export type Arm = 'todo' | 'done'
const START = -TURN / 4
const TURNS = 1.75
/** Each arm's first body sits this far along it, past the root. */
const FIRST = 16
/** The most arc a body keeps to itself, at R = 300, so a short arm stays near the centre. */
const SLOT_MOST = 58
const STEP = .05
const DRAG_FROM = 5
/** A merged thread keeps a body here, however little it did, at R = 300. */
const MERGED_LEAST = 3.4
const ARM_NAMES: Readonly<Record<Arm, string>> = { todo: 'To do', done: 'Just finished' }
/** Rows a name may stray on the finished arm, where a name is a courtesy. */
const DONE_ROWS: readonly number[] = NEAR_ROWS.slice(0, 5)
/** An arm's name, drawn in from its tip: its width and height, as family-map.css sets them. */
const NAME_BOX = { width: 110, height: 20 }

/** A body the human placed: its arm and slot, held while its state lasts. */
export interface Pin { arm: Arm; slot: number; standing: Standing }
export type Pins = Record<string, Pin>
interface Winding { line: string; at: Array<Point & { angle: number; slot: number }>; tip: Point }

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
/** The arm a thread belongs on: what is in play or waiting to start is to do, and what has come to rest just finished. */
const homeArm = (model: FamilyModel, thread: MapThread): Arm => model.attention.includes(thread) || thread.standing === 'still' ? 'todo' : 'done'
/** The two arms, in order from the centre, every drawn thread but the root on one of them. */
export function armsOf(model: FamilyModel, pins: Pins = readPins(model)): Record<Arm, MapThread[]> {
  const rest = model.order.filter(thread => thread !== model.root)
  const arm = (name: Arm): MapThread[] => {
    const on = rest.filter(thread => (pins[thread.key]?.arm ?? homeArm(model, thread)) === name)
    return arrange(on, Object.fromEntries(on.flatMap(thread => pins[thread.key] ? [[thread.key, pins[thread.key].slot]] : [])))
  }
  return { todo: arm('todo'), done: arm('done') }
}
/** The arrow keys' order: to do from the centre then just finished from the centre, the root at its own rank. */
const sequence = (model: FamilyModel): MapThread[] => {
  const { todo, done } = armsOf(model), walk = [...todo, ...done]
  walk.splice(model.root.rank, 0, model.root)
  return walk
}
/** A pin lasts while the thread's state does, so a thread set aside comes back when it next asks. */
function livePins(model: FamilyModel): Pins {
  const pins = readPins(model), live = Object.fromEntries(Object.entries(pins).filter(([key, pin]) => model.threads.get(key)?.standing === pin.standing))
  if (Object.keys(live).length !== Object.keys(pins).length) writePins(model, live)
  return live
}

/** An Archimedean arm from `inner` to `outer`, setting off at `phase`, with `count` bodies spaced evenly along it from the centre. */
function wind(phase: number, inner: number, outer: number, count: number, slot: (room: number) => number): Winding {
  const span = TURNS * TURN, points: Array<[number, number]> = []
  for (let theta = 0; theta <= span; theta += STEP) points.push([phase + theta, inner + (outer - inner) * theta / span])
  const place = ([angle, radius]: [number, number]): Point => ({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) })
  const lengths = [0]
  for (let n = 1; n < points.length; n++) {
    const a = place(points[n - 1]), b = place(points[n])
    lengths.push(lengths[n - 1] + Math.hypot(b.x - a.x, b.y - a.y))
  }
  const whole = lengths.at(-1)!, step = slot((whole - FIRST) / Math.max(1, count))
  const at = Array.from({ length: count }, (_, n) => {
    const target = FIRST + n * step
    const found = Math.max(0, lengths.findIndex(length => length >= target))
    return { ...place(points[found]), angle: points[found][0], slot: step }
  })
  return {
    at, tip: place(points.at(-1)!),
    line: points.map((point, n) => { const { x, y } = place(point); return `${n ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}` }).join(''),
  }
}

/** Where everything goes: the root at the centre and two arms winding out of it, to do from the top, just finished from the foot, first at the centre on each. */
export function spiralLayout(model: FamilyModel, width: number, height: number): Plate {
  const narrow = width < NARROW
  const arms = armsOf(model)
  const R = Math.floor(narrow ? width / 2 - 18 : Math.min(height / 2 - 14, width / 2 - 34))
  const cx = width / 2, cy = narrow ? R + 18 : height / 2, unit = R / 300, r = rootRadius(model, unit)
  const inner = r + 16 * unit, slot = (room: number): number => Math.min(room, SLOT_MOST * unit)
  const windings: Record<Arm, Winding> = { todo: wind(START, inner, R, arms.todo.length, slot), done: wind(START + TURN / 2, inner, R, arms.done.length, slot) }
  const body = (arm: Arm) => (thread: MapThread, n: number): Star => {
    const { x, y, angle, slot: room } = windings[arm].at[n]
    const size = thread.merged ? unit * Math.max(MERGED_LEAST, bodySize(thread.weight)) : bodyRadius(thread, unit)
    return { thread, angle, r: Math.min(size, Math.max(2.2 * unit, room * .36)), x: cx + x, y: cy + y }
  }
  const todo = arms.todo.map(body('todo')), done = arms.done.map(body('done'))
  const root: Star = { thread: model.root, angle: START, r, x: cx, y: cy }
  const stars = [root, ...todo, ...done]
  const place = (thread: MapThread): number => arms.todo.indexOf(thread) + 1
  const numerals = narrow ? todo.filter(star => needsHuman(star.thread)).map(star => {
    const out = Math.hypot(star.x - cx, star.y - cy) || 1
    return { thread: star.thread, numeral: place(star.thread), x: star.x + (star.x - cx) / out * (star.r + 9), y: star.y + (star.y - cy) / out * (star.r + 9) }
  }) : []
  const finished = new Set(arms.done)
  const names: ArmName[] = narrow ? [] : (['todo', 'done'] as const).map(arm => {
    const { tip } = windings[arm], side = tip.x >= 0 ? 'right' : 'left'
    return { label: `${ARM_NAMES[arm]} · ${arms[arm].length}`, side, x: cx + tip.x, y: cy + tip.y + (arm === 'todo' ? -NAME_BOX.height : NAME_BOX.height) }
  })
  const reserved = names.map((name): Box => ({
    left: name.side === 'left' ? name.x : name.x - NAME_BOX.width, right: name.side === 'left' ? name.x + NAME_BOX.width : name.x,
    top: name.y - NAME_BOX.height / 2, bottom: name.y + NAME_BOX.height / 2,
  }))
  return {
    k: 1, width, height: narrow ? cy + R + 18 : height, cx, cy, R, narrow, stars, links: false,
    labels: narrow ? [] : nearLabels(stars, [...todo, ...done], thread => finished.has(thread) ? 0 : place(thread), cx, width, height, reserved, star => finished.has(star.thread) ? DONE_ROWS : NEAR_ROWS), numerals, arcs: [],
    rings: [], grid: [], scale: 0, line: { rising: windings.todo.line, receding: windings.done.line }, arms: names,
  }
}

/** A body dragged follows the pointer and takes the slot nearest it, on either arm, and the others glide around it. */
function drag(host: HTMLElement, start: PointerEvent): void {
  const body = (start.target as Element).closest<SVGGElement>('.fm-star')
  const key = body?.getAttribute('data-thread')
  if (!body || !key || start.button !== 0) return
  let moving = false
  const move = (event: PointerEvent): void => {
    if (event.pointerId !== start.pointerId || !host.classList.contains('family-map-spiral') || host.classList.contains('family-map-pinching')) return
    const { model, open, view, focus } = current.get(host)!
    const thread = model.threads.get(key)
    if (!thread || thread === model.root) return
    if (!moving && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < DRAG_FROM) return
    moving = true
    host.classList.add('family-map-dragging')
    const box = host.getBoundingClientRect(), width = host.clientWidth || 1000, height = host.clientHeight || 680
    const layout = spiralLayout(model, width, height), own = { x: event.clientX - box.left + host.scrollLeft, y: event.clientY - box.top + host.scrollTop }
    const point = { x: (own.x - view.x * width) / view.k, y: (own.y - view.y * layout.height) / view.k }
    const distance = (star: Star): number => Math.hypot(star.x - point.x, star.y - point.y)
    const slots = layout.stars.filter(star => star.thread !== model.root)
    const nearest = slots.reduce((best, star) => distance(star) < distance(best) ? star : best)
    if (nearest.thread.key !== key) {
      const arms = armsOf(model), arm: Arm = arms.todo.includes(nearest.thread) ? 'todo' : 'done'
      const others = { ...readPins(model) }
      delete others[key]
      writePins(model, { [key]: { arm, slot: arms[arm].indexOf(nearest.thread), standing: thread.standing }, ...others })
      spiral.draw(host, model, open, view, focus)
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
    const { model, open, view, focus } = current.get(host)!
    spiral.draw(host, model, open, view, focus)
    const swallow = (event: Event): void => { event.stopPropagation() }
    host.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => host.removeEventListener('click', swallow, { capture: true }))
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

/** What a host last drew, which the one drag listener it keeps always reads. */
const current = new WeakMap<HTMLElement, { model: FamilyModel; open: OpenThread; view: View; focus: Focus | null }>()

export const spiral: Drawing = {
  name: 'spiral', label: 'Spiral',
  reading: ['Zoom: ⌘ scroll or pinch', 'Centre: the constitution', 'One arm: to do, next at the centre', 'Other arm: just finished, newest at the centre', 'Flow: rising to you, or receding', 'Size: its mass of work', 'Dots: sent files', 'Colour: its state', 'Diamond: a new file', 'Drag a body along or across the arms'],
  sequence,
  layout: spiralLayout,
  draw(host, model, open, view = WHOLE, focus = null) {
    const { width, height } = mount(host, 'spiral', model, open)
    const pins = livePins(model), plate = spiralLayout(model, width, height), { todo, done } = armsOf(model, pins)
    paintPlate(host, zoomPlate(plate, view, model, focus, thread => todo.indexOf(thread) + 1), model)
    for (const body of host.querySelectorAll<SVGGElement>('.fm-star')) {
      const key = body.getAttribute('data-thread')!, past = done.findIndex(thread => thread.key === key)
      body.toggleAttribute('data-pinned', key in pins)
      body.style.setProperty('--fm-recede', past < 0 ? '1' : (1 - .55 * past / Math.max(1, done.length)).toFixed(2))
    }
    if (!current.has(host)) host.addEventListener('pointerdown', event => { if (host.classList.contains('family-map-spiral')) drag(host, event) })
    current.set(host, { model, open, view, focus })
    const reset = part(host, 'fm-unpin', cls => { const button = htmlEl('button', cls, 'Back to attention order'); button.type = 'button'; return button })
    reset.hidden = !Object.keys(pins).length
    reset.onclick = event => { event.stopPropagation(); writePins(model, {}); spiral.draw(host, model, open, view, focus) }
  },
}
