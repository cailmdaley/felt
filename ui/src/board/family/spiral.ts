import { needsHuman, type FamilyModel, type MapThread } from './model.js'
import { NARROW, htmlEl, mount, part, type Drawing, type OpenThread } from './drawing.js'
import { TURN, bodyRadius, nearLabels, paintPlate, zoomPlate, type Plate, type Star } from './orbit.js'
import { WHOLE, type View } from './zoom.js'

/** A finished thread's slot along the arc, against one still in play, at most. */
const TAIL_SLOT = .3
const START = -TURN / 4
/** The horizon: inside it things rise to the human, past it they recede. */
const HORIZON = .8
const TURNS = 2.6
/** How far the line runs out past the last body, as a share of the rim. */
const FADE_OUT = 1.32
const DRAG_FROM = 5

type Pins = Record<string, number>
interface Winding { at: Array<{ angle: number; radius: number }>; rising: string; receding: string }

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
 * The order along the line: pinned threads hold the slots the human gave them,
 * the first named winning a contested slot, and everything else keeps its
 * order around them.
 */
export function arrange(order: readonly MapThread[], pins: Pins): MapThread[] {
  const slots = new Array<MapThread | undefined>(order.length), byKey = new Map(order.map(thread => [thread.key, thread]))
  const free = (from: number): number => { let at = Math.min(from, order.length - 1); while (slots[at] && at < order.length - 1) at++; while (slots[at]) at--; return at }
  for (const [key, slot] of Object.entries(pins)) {
    const thread = byKey.get(key)
    if (thread) slots[free(slot)] = thread
  }
  const rest = order.filter(thread => !slots.includes(thread))
  return Array.from(slots, slot => slot ?? rest.shift()!)
}
/** Everything in play holds the line inside the horizon, however it is pinned; the rest unwinds past it in the model's order. */
const sequence = (model: FamilyModel): MapThread[] => [...arrange(model.attention, readPins(model)), ...model.order.slice(model.attention.length)]
/** A thread keeps its pin while it is in play. */
function livePins(model: FamilyModel): Pins {
  const pins = readPins(model), live = Object.fromEntries(Object.entries(pins).filter(([key]) => model.attention.some(thread => thread.key === key)))
  if (Object.keys(live).length !== Object.keys(pins).length) writePins(model, live)
  return live
}

/** Walks an Archimedean spiral of `pitch` per turn, dropping a position at each slot's arc length. */
function wind(slots: readonly number[], pitch: number, length: number, split: number, limit: number): Winding {
  const b = pitch / TURN, step = .01
  const at: Winding['at'] = []
  const rising: Array<[number, number]> = [], receding: Array<[number, number]> = []
  let theta = 0, travelled = 0, next = 0
  for (let n = 0; n < 30_000; n++) {
    const radius = b * theta
    if (at.length < slots.length && travelled >= next) { next += slots[at.length] * length; at.push({ angle: START + theta, radius }) }
    if (at.length === slots.length && radius >= limit) break
    if (n % 6 === 0) (at.length <= split ? rising : receding).push([START + theta, radius])
    travelled += Math.hypot(radius, b) * step
    theta += step
  }
  const line = (points: Array<[number, number]>): string => points.map(([angle, radius], n) => `${n ? 'L' : 'M'}${(radius * Math.cos(angle)).toFixed(1)} ${(radius * Math.sin(angle)).toFixed(1)}`).join('')
  return { at, rising: line(rising), receding: line([...rising.slice(-1), ...receding]) }
}

/** The pitch that lands the last thread in play on the horizon. */
function fit(slots: readonly number[], split: number, horizon: number, length: number, limit: number): Winding {
  let lo = 8, hi = horizon * 2
  const reach = (winding: Winding): number => winding.at[Math.max(0, split - 1)].radius
  for (let n = 0; n < 22; n++) {
    const pitch = (lo + hi) / 2
    if (reach(wind(slots, pitch, length, split, limit)) > horizon) hi = pitch
    else lo = pitch
  }
  return wind(slots, lo, length, split, limit)
}

/** Where everything goes: the threads along one winding line, first at the centre, what is finished unwinding past the horizon. */
export function spiralLayout(model: FamilyModel, width: number, height: number): Plate {
  const narrow = width < NARROW
  const threads = sequence(model), playing = Math.max(1, model.attention.length), tail = threads.length - playing
  const R = Math.floor(narrow ? width / 2 - 18 : Math.min(height / 2 - 14, width / 2 - 34))
  const cx = width / 2, cy = narrow ? R + 18 : height / 2, unit = R / 300, horizon = R * HORIZON
  const tailSlot = tail ? Math.min(TAIL_SLOT, playing * ((1 / HORIZON) ** 2 - 1) / tail) : 0
  const slots = threads.map((_, n) => n < playing ? 1 : tailSlot)
  const length = TURNS * Math.PI * horizon / playing
  const { at, rising, receding } = fit(slots, playing, horizon, length, R * FADE_OUT)
  const stars = at.map(({ angle, radius }, n): Star => ({
    thread: threads[n], angle, r: Math.min(bodyRadius(threads[n], unit), n < playing ? length * .28 : Math.max(2.2 * unit, length * tailSlot * .34)),
    x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle),
  }))
  const position = new Map(threads.map((thread, n) => [thread, n]))
  const place = (thread: MapThread): number => position.get(thread)! + 1
  const rankedNames = stars.slice(0, playing)
  const numerals = narrow ? rankedNames.filter(star => needsHuman(star.thread)).map(star => {
    const out = Math.hypot(star.x - cx, star.y - cy) || 1
    return { thread: star.thread, numeral: place(star.thread), x: star.x + (star.x - cx) / out * (star.r + 9), y: star.y + (star.y - cy) / out * (star.r + 9) }
  }) : []
  return {
    k: 1, width, height: narrow ? cy + R + 18 : height, cx, cy, R, narrow, stars, links: false,
    labels: narrow ? [] : nearLabels(stars, rankedNames, place, cx, width, height), numerals, arcs: [],
    rings: [{ label: 'horizon', radius: horizon, marked: false }], grid: [], scale: 0, line: { rising, receding },
  }
}

/** A thread in play dragged along the line takes the slot in play nearest the pointer, and the others glide around it. */
function drag(host: HTMLElement, start: PointerEvent): void {
  const key = (start.target as Element).closest('.fm-star')?.getAttribute('data-thread')
  if (!key || start.button !== 0) return
  let moving = false
  const move = (event: PointerEvent): void => {
    if (event.pointerId !== start.pointerId || !host.classList.contains('family-map-spiral') || host.classList.contains('family-map-pinching')) return
    const { model, open, view } = current.get(host)!
    if (!model.attention.some(thread => thread.key === key)) return
    if (!moving && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < DRAG_FROM) return
    moving = true
    host.classList.add('family-map-dragging')
    const box = host.getBoundingClientRect(), width = host.clientWidth || 1000, height = host.clientHeight || 680
    const layout = spiralLayout(model, width, height), inPlay = layout.stars.slice(0, model.attention.length)
    const point = { x: (event.clientX - box.left + host.scrollLeft - view.x * width) / view.k, y: (event.clientY - box.top + host.scrollTop - view.y * layout.height) / view.k }
    const distance = (star: Star): number => Math.hypot(star.x - point.x, star.y - point.y)
    const nearest = inPlay.reduce((best, star) => distance(star) < distance(best) ? star : best)
    if (nearest.thread.key === key) return
    const others = { ...readPins(model) }
    delete others[key]
    writePins(model, { [key]: inPlay.indexOf(nearest), ...others })
    spiral.draw(host, model, open, view)
  }
  const up = (event: PointerEvent): void => {
    if (event.pointerId !== start.pointerId) return
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    host.classList.remove('family-map-dragging')
    if (!moving) return
    const swallow = (event: Event): void => { event.stopPropagation() }
    host.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => host.removeEventListener('click', swallow, { capture: true }))
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

/** What a host last drew, which the one drag listener it keeps always reads. */
const current = new WeakMap<HTMLElement, { model: FamilyModel; open: OpenThread; view: View }>()

export const spiral: Drawing = {
  name: 'spiral', label: 'Spiral',
  reading: ['Centre: look here first', 'Inward: rising to you', 'Outward: receding', 'Colour: it needs you', 'Size: its mass of work', 'Drag a body to arrange'],
  sequence,
  draw(host, model, open, view = WHOLE) {
    const { width, height } = mount(host, 'spiral', model, open)
    const pins = livePins(model), plate = spiralLayout(model, width, height)
    const places = new Map(plate.stars.map((star, n) => [star.thread.key, n])), playing = Math.max(1, model.attention.length)
    paintPlate(host, zoomPlate(plate, view, thread => places.get(thread.key)! + 1), model)
    for (const body of host.querySelectorAll<SVGGElement>('.fm-star')) {
      const key = body.getAttribute('data-thread')!, past = places.get(key)! - playing
      body.toggleAttribute('data-pinned', key in pins)
      body.style.setProperty('--fm-recede', past < 0 ? '1' : (1 - .75 * past / Math.max(1, plate.stars.length - playing)).toFixed(2))
    }
    if (!current.has(host)) host.addEventListener('pointerdown', event => { if (host.classList.contains('family-map-spiral')) drag(host, event) })
    current.set(host, { model, open, view })
    const reset = part(host, 'fm-unpin', cls => { const button = htmlEl('button', cls, 'Back to attention order'); button.type = 'button'; return button })
    reset.hidden = !Object.keys(pins).length
    reset.onclick = event => { event.stopPropagation(); writePins(model, {}); spiral.draw(host, model, open, view) }
  },
}
