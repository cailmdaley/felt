import { needsHuman, isDrawn, type FamilyModel, type MapThread, type Standing } from './model.js'
import { NARROW, htmlEl, mount, part, type Drawing, type OpenThread, type Point, type Sight } from './drawing.js'
import { NEAR_ROWS, TURN, bodyRadius, bodySize, nearLabels, paintPlate, rootRadius, zoomPlate, type ArmName, type Box, type Plate, type Star } from './orbit.js'
import { WHOLE, type View } from './zoom.js'

export type Arm = 'todo' | 'done'
const START = -TURN / 4
/** How far an arm winds: further around the constitution than around a thread. */
const TURNS = 1.75
const TURNS_NESTED = 1.25
const STEP = .05
/** Each arm's first body sits this share of the arm along it, and none holds more than this share of it. */
const FIRST = .03
const SLOT_MOST = .1
const SLOT_WIDE = .34
/** A nested arm begins this far out from its thread's body, and a thread's room never crowds the arm beside it. */
const NESTED_GAP = 1.4
const ROOM = .46
/** A body's share of its slot on the whole field, and the least radius it keeps, at R = 300. */
const BODY_SHARE = .36
const BODY_LEAST = 1.6
const MERGED_LEAST = 3.4
const DRAG_FROM = 5
const ARM_NAMES: Readonly<Record<Arm, string>> = { todo: 'To do', done: 'Just finished' }
const DONE_ROWS: readonly number[] = NEAR_ROWS.slice(0, 5)
/** An arm's name, drawn in from its tip: its width and height, as family-map.css sets them. */
const NAME_BOX = { width: 110, height: 20 }

/** A body the human placed: its arm and slot around its orchestrator, held while its state lasts. */
export interface Pin { arm: Arm; slot: number; standing: Standing }
export type Pins = Record<string, Pin>
interface Measure { best: number; live: boolean; count: number }
interface Winding { line: string; at: Array<Point & { angle: number; room: number }>; tip: Point }

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

/** An Archimedean arm from `inner` to `outer`, setting off at `phase`, each body taking arc in proportion to `weights`. */
function wind(phase: number, inner: number, outer: number, turns: number, weights: readonly number[]): Winding {
  const span = turns * TURN, points: Array<[number, number]> = []
  for (let theta = 0; theta <= span; theta += STEP) points.push([phase + theta, inner + (outer - inner) * theta / span])
  const place = ([angle, radius]: [number, number]): Point => ({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) })
  const lengths = [0]
  for (let n = 1; n < points.length; n++) {
    const a = place(points[n - 1]), b = place(points[n])
    lengths.push(lengths[n - 1] + Math.hypot(b.x - a.x, b.y - a.y))
  }
  const whole = lengths.at(-1)!, total = weights.reduce((sum, weight) => sum + weight, 0) || 1
  const unit = Math.min((whole * (1 - FIRST)) / total, whole * SLOT_MOST)
  let along = whole * FIRST
  const at = weights.map(weight => {
    const middle = along + unit * weight / 2
    along += unit * weight
    const found = Math.max(0, lengths.findIndex(length => length >= middle))
    return { ...place(points[found]), angle: points[found][0], room: unit * weight }
  })
  return {
    at, tip: place(points.at(-1)!),
    line: points.map((point, n) => { const { x, y } = place(point); return `${n ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}` }).join(''),
  }
}
const offset = (line: string, x: number, y: number): string => line.replace(/([ML])(-?[\d.]+) (-?[\d.]+)/g, (_, op: string, a: string, b: string) => `${op}${(Number(a) + x).toFixed(1)} ${(Number(b) + y).toFixed(1)}`)

/**
 * Where everything goes: the constitution at the centre and two arms winding
 * out of it, to do from the top and just finished from the foot, first at the
 * centre on each. Every thread with threads of its own is the same drawing at
 * its own scale, its two arms wound in the room its place gives it, so zooming
 * in on a body arrives at the same picture, and a thread's room grows with
 * what is under it.
 */
export function radialLayout(model: FamilyModel, width: number, height: number): Plate {
  const narrow = width < NARROW
  const measures = measured(model), pins = readPins(model)
  const R = Math.floor(narrow ? width / 2 - 18 : Math.min(height / 2 - 14, width / 2 - 34))
  const cx = width / 2, cy = narrow ? R + 18 : height / 2, unit = R / 300, rootR = rootRadius(model, unit)
  const stars: Star[] = [{ thread: model.root, angle: START, r: rootR, full: rootR, reach: R, x: cx, y: cy }]
  let rising = '', receding = ''
  const tips: Partial<Record<Arm, Point>> = {}
  const wound = (thread: MapThread, x: number, y: number, body: number, reach: number, turns: number): void => {
    const arms = armsOf(model, thread, pins, measures), inner = body * NESTED_GAP, gap = (reach - inner) / turns / 2
    for (const [name, phase] of [['todo', START], ['done', START + TURN / 2]] as const) {
      const kids = arms[name], weights = kids.map(kid => 1 + Math.sqrt(measures.get(kid)!.count - 1))
      const { line, at, tip } = wind(phase, inner, reach, turns, weights)
      if (kids.length || thread === model.root) {
        if (name === 'todo') rising += offset(line, x - cx, y - cy); else receding += offset(line, x - cx, y - cy)
      }
      if (thread === model.root) tips[name] = { x: x + tip.x, y: y + tip.y }
      kids.forEach((kid, n) => {
        const { x: dx, y: dy, angle, room } = at[n]
        const full = kid.merged ? unit * Math.max(MERGED_LEAST, bodySize(kid.weight)) : bodyRadius(kid, unit)
        const r = Math.min(full, Math.max(BODY_LEAST * unit, room * BODY_SHARE)), space = Math.min(room * SLOT_WIDE, gap * ROOM)
        stars.push({ thread: kid, angle, r, full, reach: Math.max(space, r * 1.5), x: x + dx, y: y + dy })
        if (measures.get(kid)!.count > 1) wound(kid, x + dx, y + dy, r, Math.max(space, r * 1.5), TURNS_NESTED)
      })
    }
  }
  wound(model.root, cx, cy, rootR, R, TURNS)
  const star = new Map(stars.map(item => [item.thread, item]))
  const numeral = (thread: MapThread): number => measures.get(thread)!.live ? thread.rank + 1 : 0
  const asking = model.attention.filter(needsHuman).flatMap(thread => star.get(thread) ?? [])
  const numerals = narrow ? asking.map(item => {
    const out = Math.hypot(item.x - cx, item.y - cy) || 1
    return { thread: item.thread, numeral: item.thread.rank + 1, x: item.x + (item.x - cx) / out * (item.r + 9), y: item.y + (item.y - cy) / out * (item.r + 9) }
  }) : []
  const names: ArmName[] = narrow ? [] : (['todo', 'done'] as const).map(arm => {
    const tip = tips[arm]!, side = tip.x >= cx ? 'right' : 'left', count = armsOf(model, model.root, pins, measures)[arm].length
    return { label: `${ARM_NAMES[arm]} · ${count}`, side, x: tip.x, y: tip.y + (arm === 'todo' ? -NAME_BOX.height : NAME_BOX.height) }
  })
  const reserved = names.map((name): Box => ({
    left: name.side === 'left' ? name.x : name.x - NAME_BOX.width, right: name.side === 'left' ? name.x + NAME_BOX.width : name.x,
    top: name.y - NAME_BOX.height / 2, bottom: name.y + NAME_BOX.height / 2,
  }))
  const first = stars.filter(item => item.thread.depth === 1 && !asking.includes(item))
  return {
    k: 1, width, height: narrow ? cy + R + 18 : height, cx, cy, R, narrow, stars, links: true, numerals,
    labels: narrow ? [] : nearLabels(stars, [...asking, ...first], numeral, cx, width, height, reserved, item => measures.get(item.thread)!.live ? NEAR_ROWS : DONE_ROWS),
    line: { rising, receding }, arms: names,
  }
}

/** A body dragged follows the pointer and takes the slot nearest it around its orchestrator, on either arm, and the others glide around it. */
function drag(host: HTMLElement, start: PointerEvent): void {
  const body = (start.target as Element).closest<SVGGElement>('.fm-star')
  const key = body?.getAttribute('data-thread')
  if (!body || !key || start.button !== 0) return
  let moving = false
  const move = (event: PointerEvent): void => {
    if (event.pointerId !== start.pointerId || !host.classList.contains('family-map-radial') || host.classList.contains('family-map-pinching')) return
    const { model, open, view, sight } = current.get(host)!
    const thread = model.threads.get(key), parent = thread?.parent ? model.threads.get(thread.parent) : undefined
    if (!thread || !parent) return
    if (!moving && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < DRAG_FROM) return
    moving = true
    host.classList.add('family-map-dragging')
    const box = host.getBoundingClientRect(), width = host.clientWidth || 1000, height = host.clientHeight || 680
    const layout = radialLayout(model, width, height), own = { x: event.clientX - box.left + host.scrollLeft, y: event.clientY - box.top + host.scrollTop }
    const point = { x: (own.x - view.x * width) / view.k, y: (own.y - view.y * layout.height) / view.k }
    const distance = (star: Star): number => Math.hypot(star.x - point.x, star.y - point.y)
    const slots = layout.stars.filter(star => star.thread.parent === thread.parent)
    const nearest = slots.reduce((best, star) => distance(star) < distance(best) ? star : best)
    if (nearest.thread.key !== key) {
      const arms = armsOf(model, parent), arm: Arm = arms.todo.includes(nearest.thread) ? 'todo' : 'done'
      const others = { ...readPins(model) }
      delete others[key]
      writePins(model, { [key]: { arm, slot: arms[arm].indexOf(nearest.thread), standing: thread.standing }, ...others })
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
  reading: ['Zoom: ⌘ scroll or pinch', 'Centre: the constitution', 'One arm: to do, next at the centre', 'Other arm: just finished, newest at the centre', 'Every thread: the same two arms, zoom in', 'Arcs: who launched whom', 'Size: its mass of work', 'Dots: sent files', 'Colour: its state', 'Glow: how recently it moved', 'Diamond: a new file', 'Drag a body along or across the arms'],
  layout: radialLayout,
  draw(host, model, open, view = WHOLE, sight = null) {
    const { width, height } = mount(host, 'radial', model, open)
    const pins = livePins(model), plate = radialLayout(model, width, height), measures = measured(model)
    paintPlate(host, zoomPlate(plate, view, model, sight, thread => measures.get(thread)!.live ? thread.rank + 1 : 0), model)
    for (const body of host.querySelectorAll<SVGGElement>('.fm-star')) body.toggleAttribute('data-pinned', body.getAttribute('data-thread')! in pins)
    if (!current.has(host)) host.addEventListener('pointerdown', event => { if (host.classList.contains('family-map-radial')) drag(host, event) })
    current.set(host, { model, open, view, sight })
    const reset = part(host, 'fm-unpin', cls => { const button = htmlEl('button', cls, 'Back to attention order'); button.type = 'button'; return button })
    reset.hidden = !Object.keys(pins).length
    reset.onclick = event => { event.stopPropagation(); writePins(model, {}); radial.draw(host, model, open, view, sight) }
  },
}
