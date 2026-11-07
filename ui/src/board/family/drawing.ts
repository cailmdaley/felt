import { ago } from '../civilDay.js'
import { MAP_WINDOW_MS, type FamilyModel, type MapFile, type MapThread, type Standing } from './model.js'
import type { View } from './zoom.js'
import type { Plate } from './orbit.js'
import './family-map.css'

export type OpenThread = (thread: MapThread) => void
/** The pages every thread has a place for, as far as they are known. */
export interface Holds { lead?: MapFile; constitution?: MapFile }
/** What the map shows beyond its bodies: the thread it has unfolded, whether that thread's own threads gather to it, and what any thread holds. */
export interface Sight { key: string | null; gather: boolean; holds(thread: MapThread): Holds }
/** One way of drawing the family: repainting into the same host keeps its elements, so they can move. */
export interface Drawing {
  name: string
  label: string
  /** What the drawing's marks mean, one channel to a phrase. */
  reading: readonly string[]
  /** The threads it shows, in the order the arrow keys walk them, when that is not the model's. */
  sequence?(model: FamilyModel, focus: string | null): MapThread[]
  /** A focused thread opens where the drawing lists it, on a drawing with no field. */
  folds?: boolean
  /** Where everything sits at the whole field, on a drawing with a field to zoom. */
  layout?(model: FamilyModel, width: number, height: number): Plate
  /** `view` is the field's zoom, where the drawing has a field to zoom; `sight` what it shows beyond its bodies. */
  draw(host: HTMLElement, model: FamilyModel, open: OpenThread, view: View, sight: Sight | null): void
}
export interface Stage { width: number; height: number; narrow: boolean }
export interface Point { x: number; y: number }

const SVG = 'http://www.w3.org/2000/svg'
/** Below this width a drawing lays out for a phone. */
export const NARROW = 560
export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const TIME_MARKS: ReadonlyArray<readonly [number, string]> = [[HOUR, '1h'], [6 * HOUR, '6h'], [DAY, '1d'], [3 * DAY, '3d'], [7 * DAY, '7d'], [14 * DAY, '14d']]

export const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, cls?: string): SVGElementTagNameMap[K] => {
  const el = document.createElementNS(SVG, tag)
  if (cls) el.setAttribute('class', cls)
  return el
}
export const htmlEl = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text !== undefined) el.textContent = text
  return el
}
export const shortAgo = (at: number, now: number): string => ago(at, now).replace(/ ago$/, '')

/** The host's stage for a drawing, with a click on any thread's mark wired to `open`. */
export function mount(host: HTMLElement, name: string, model: FamilyModel, open: OpenThread): Stage {
  const width = host.clientWidth || 1000, height = host.clientHeight || 680, narrow = width < NARROW
  host.classList.add('family-map', `family-map-${name}`)
  host.classList.toggle('family-map-narrow', narrow)
  host.onclick = event => {
    const target = event.target as Element
    if (event.detail > 1 || target.closest('[data-held]')) return
    const key = target.closest('[data-thread]')?.getAttribute('data-thread')
    const thread = key ? model.threads.get(key) : undefined
    if (thread) open(thread)
  }
  return { width, height, narrow }
}
/** A named child of the host, made once. */
export function part<E extends Element>(parent: Element, cls: string, make: (cls: string) => E): E {
  for (const child of parent.children) if (child.classList.contains(cls)) return child as E
  const el = make(cls); parent.append(el)
  return el
}

const pools = new WeakMap<Element, Map<string, Element>>()
/**
 * Keeps one element per key under `parent`, so a repaint moves what persists
 * instead of redrawing it; a new element goes in its items' place, and one
 * that stays is never reinserted, which would end its transition.
 */
export function reconcile<T, E extends Element>(parent: Element, items: readonly T[], key: (item: T) => string, make: (item: T) => E, fill: (el: E, item: T) => void): void {
  const before = pools.get(parent) ?? new Map<string, Element>(), after = new Map<string, Element>()
  for (const item of items) {
    const id = key(item), el = (before.get(id) ?? make(item)) as E
    after.set(id, el)
    fill(el, item)
  }
  for (const [id, el] of before) if (!after.has(id)) el.remove()
  const order = [...after.values()]
  for (let n = order.length - 1; n >= 0; n--) if (order[n].parentNode !== parent) parent.insertBefore(order[n], order[n + 1] ?? null)
  pools.set(parent, after)
}

/** Marks an element as a thread's way in: its identity and the state its colour says. */
export function tagThread(el: Element, thread: MapThread): void {
  el.setAttribute('data-thread', thread.key)
  el.setAttribute('data-standing', thread.tone)
}
/** The one focusable element a thread has in a drawing. */
export function optionFor(el: Element, thread: MapThread, model: FamilyModel): void {
  el.setAttribute('role', 'option')
  el.setAttribute('aria-label', `${thread.name}, ${thread.word}, ${shortAgo(thread.lastMove, model.now)}`)
  el.setAttribute('aria-posinset', String(thread.rank + 1))
  el.setAttribute('aria-setsize', String(model.order.length))
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
}

/** Draws `selected` as chosen, along with the line of orchestrators it hangs from. */
export function markSelection(host: HTMLElement, model: FamilyModel, selected: string | null): void {
  const chain = new Set<string>()
  for (let up = selected; up !== null;) {
    chain.add(up)
    up = model.threads.get(up)?.parent ?? null
  }
  for (const el of host.querySelectorAll('[data-thread]')) {
    const on = el.getAttribute('data-thread') === selected
    el.toggleAttribute('data-selected', on)
    if (el.getAttribute('role') !== 'option') continue
    el.setAttribute('tabindex', on ? '0' : '-1')
    el.setAttribute('aria-selected', String(on))
  }
  for (const el of host.querySelectorAll('[data-link]')) el.toggleAttribute('data-chain', chain.has(el.getAttribute('data-link')!))
  for (const el of host.querySelectorAll('[data-leader]')) el.toggleAttribute('data-selected', el.getAttribute('data-leader') === selected)
}

/** A mark's outline around its centre: the tone says whose move, the shape tells kinds of the same tone apart. */
export function markPath(standing: Standing, r: number): string {
  if (standing === 'new') { const d = r * 1.3; return `M0 ${-d}L${d} 0L0 ${d}L${-d} 0Z` }
  if (standing === 'blocked') { const d = r * .9; return `M${-d} ${-d}H${d}V${d}H${-d}Z` }
  return `M${-r} 0A${r} ${r} 0 1 0 ${r} 0A${r} ${r} 0 1 0 ${-r} 0Z`
}

/** A unit stroke laid from `a` to `b` by transform, so its ends can glide with what they join. */
export function lay(el: SVGElement, a: Point, b: Point): void {
  const length = Math.hypot(b.x - a.x, b.y - a.y)
  const turn = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI
  const previous = Number(el.getAttribute('data-turn') ?? turn)
  const nearest = turn + 360 * Math.round((previous - turn) / 360)
  el.setAttribute('data-turn', String(nearest))
  el.style.transform = `translate(${a.x.toFixed(1)}px, ${a.y.toFixed(1)}px) rotate(${nearest.toFixed(2)}deg) scale(${Math.max(length, .001).toFixed(1)})`
}

/** Square-root time: how far a moment sits from now, 0 to 1 across the map's window. */
export const elapsed = (at: number, now: number): number => Math.sqrt(Math.max(0, Math.min(1, (now - at) / MAP_WINDOW_MS)))
