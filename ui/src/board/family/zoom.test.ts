// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { ThreadIndex } from '../threads.js'
import { FamilyPage } from '../workspace/FamilyPage.js'
import { WHOLE, held, zoomAbout, type View } from './zoom.js'
import { familyModel } from './model.js'
import { skyLayout } from './sky.js'
import { zoomPlate } from './orbit.js'

const now = 1_800_000_000_000, hour = 3_600_000
const when = (back: number): string => new Date(now - back * hour).toISOString()
const root = card({ id: 'hub', name: 'Hub', createdAt: when(300), status: 'active' })
const threads = Array.from({ length: 30 }, (_, n) => card({ id: `hub/t${n}`, name: `Thread ${n}`, orchestrator: 'hub', status: 'active', createdAt: when(50), workerState: 'running', runtimePhase: n % 3 ? 'working' : 'waiting', lastActivityAt: now - n * hour }))
const cards = [root, ...threads]
const feeds = { marks: () => undefined, files: () => [], refresh: () => {} }
const stored = new Map<string, string>()
beforeEach(() => {
  stored.clear()
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) })
})
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers() })

function mapped(drawing = 'sky'): { stage: HTMLElement; plate: HTMLElement } {
  stored.set('shuttle.family.drawing', drawing)
  const page = new FamilyPage(vi.fn(), vi.fn(), feeds, vi.fn())
  document.body.append(page.el)
  page.update(root, new ThreadIndex(cards), now)
  const stage = page.el.querySelector<HTMLElement>('[role="listbox"]')!, plate = stage.querySelector<HTMLElement>('.fm-sky-plate')!
  plate.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 680, width: 1000, height: 680 }) as DOMRect
  return { stage, plate }
}
const wheel = (el: Element, init: WheelEventInit): WheelEvent => { const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 500, clientY: 340, ...init }); el.dispatchEvent(event); return event }

it('keeps the point under the pointer where it is, and the field over the plate', () => {
  const view = zoomAbout(WHOLE, 2, .25, .75)
  expect(view).toEqual({ k: 2, x: -.25, y: -.75 })
  expect(.25 * view.k + view.x).toBeCloseTo(.25)
  expect(zoomAbout(view, .25, .25, .75)).toEqual(WHOLE)
  expect(held({ k: 3, x: .4, y: -9 })).toEqual({ k: 3, x: 0, y: -2 })
  expect(held({ k: 99, x: 0, y: 0 }).k).toBe(8)
})
it('scales the geometry, keeps every mark its size, and names more threads as room opens', () => {
  const index = new ThreadIndex(cards), model = familyModel(index, root, root, feeds, now)
  const base = skyLayout(model, 1000, 680), view: View = { k: 3, x: -1, y: -1 }
  const plate = zoomPlate(base, view)
  expect(zoomPlate(base, WHOLE)).toBe(base)
  expect(plate.R).toBeCloseTo(base.R * 3)
  plate.stars.forEach((star, n) => {
    expect(star.r).toBe(base.stars[n].r)
    expect(star.x).toBeCloseTo(base.stars[n].x * 3 - 1000)
  })
  expect(plate.labels.length).toBeGreaterThan(base.labels.length)
  const names = plate.labels.map(label => ({ left: label.side === 'right' ? label.x : label.x - label.width, right: label.side === 'right' ? label.x + label.width : label.x, y: label.y }))
  for (const a of names) for (const b of names) if (a !== b) expect(a.left < b.right && b.left < a.right && Math.abs(a.y - b.y) < 24).toBe(false)
})
it('leaves the wheel to the page at the base scale, and takes it once zoomed', () => {
  const { stage, plate } = mapped()
  expect(wheel(plate, { deltaY: 40 }).defaultPrevented).toBe(false)
  expect(wheel(plate, { deltaY: -40, ctrlKey: true }).defaultPrevented).toBe(true)
  expect(wheel(plate, { deltaY: -40, metaKey: true }).defaultPrevented).toBe(true)
  expect(wheel(plate, { deltaY: 40 }).defaultPrevented).toBe(true)
  expect(stage.classList.contains('family-map-gesturing')).toBe(true)
})
it('moves layers while a wheel runs and paints only when it settles', async () => {
  vi.useFakeTimers()
  const { stage, plate } = mapped()
  const svg = plate.querySelector('.fm-sky-svg')!, first = svg.querySelector('.fm-star')!
  const transform = (first as SVGElement).style.transform
  for (let n = 0; n < 5; n++) { wheel(plate, { deltaY: -40, ctrlKey: true }); vi.advanceTimersByTime(20) }
  expect((first as SVGElement).style.transform).toBe(transform)
  vi.advanceTimersByTime(300)
  expect(stage.classList.contains('family-map-zoomed')).toBe(true)
  expect(stage.classList.contains('family-map-gesturing')).toBe(false)
  expect((svg as SVGElement).style.transform).toBe('')
  expect(plate.querySelectorAll('.fm-label').length).toBeGreaterThan(0)
})
it('resets on a double-click of the field, not of a thread, and leaves the spiral\'s pins', () => {
  vi.useFakeTimers()
  const { stage, plate } = mapped('spiral')
  stored.set(`shuttle.family.spiral:${root.originId}:${root.uid ?? root.id}`, '{}')
  wheel(plate, { deltaY: -40, ctrlKey: true }); vi.advanceTimersByTime(300)
  expect(stage.classList.contains('family-map-zoomed')).toBe(true)
  stage.querySelector('.fm-star')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  expect(stage.classList.contains('family-map-zoomed')).toBe(true)
  plate.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  expect(stage.classList.contains('family-map-zoomed')).toBe(false)
})
it('pans a zoomed field by dragging it, and leaves the base field to the page', () => {
  vi.useFakeTimers()
  const { stage, plate } = mapped()
  const mouse = (target: EventTarget, type: string, x: number): void => { target.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 340 }), { pointerId: 1, pointerType: 'mouse' })) }
  mouse(plate, 'pointerdown', 500); mouse(window, 'pointermove', 400)
  expect(stage.classList.contains('family-map-gesturing')).toBe(false)
  mouse(window, 'pointerup', 400)
  wheel(plate, { deltaY: -60, ctrlKey: true }); vi.advanceTimersByTime(300)
  mouse(plate, 'pointerdown', 500); mouse(window, 'pointermove', 400)
  expect(stage.classList.contains('family-map-gesturing')).toBe(true)
  mouse(window, 'pointerup', 400)
  expect(stage.classList.contains('family-map-gesturing')).toBe(false)
})
