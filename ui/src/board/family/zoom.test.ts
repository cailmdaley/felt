// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { ThreadIndex } from '../threads.js'
import { FamilyPage } from '../workspace/FamilyPage.js'
import { WHOLE, held, zoomAbout, type View } from './zoom.js'
import { familyModel } from './model.js'
import { radialLayout } from './radial.js'
import { aim, labelFit, sighted, spokenName, zoomPlate } from './orbit.js'

const now = 1_800_000_000_000, hour = 3_600_000
const when = (back: number): string => new Date(now - back * hour).toISOString()
const root = card({ id: 'hub', name: 'Hub', createdAt: when(300), status: 'active' })
const threads = Array.from({ length: 30 }, (_, n) => card({ id: `hub/t${n}`, name: `Thread ${n}`, orchestrator: 'hub', status: 'active', createdAt: when(50), workerState: 'running', runtimePhase: n % 3 ? 'working' : 'waiting', lastActivityAt: now - n * hour }))
const cards = [root, ...threads]
const feeds = { marks: () => undefined, files: () => [], refresh: () => {}, lead: async () => undefined }
const stored = new Map<string, string>()
beforeEach(() => {
  stored.clear()
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduced-motion') }))
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) })
})
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers() })

function mapped(drawing = 'radial'): { stage: HTMLElement; plate: HTMLElement } {
  stored.set('shuttle.family.drawing', drawing)
  const page = new FamilyPage(vi.fn(), vi.fn(), feeds, { focus: null, view: null }, vi.fn())
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
  expect(held({ k: 3, x: .9, y: -9 })).toEqual({ k: 3, x: .5, y: -2.5 })
  expect(held({ k: 1, x: .4, y: -.4 })).toEqual(WHOLE)
  expect(held({ k: 1e6, x: 0, y: 0 }).k).toBe(4096)
})
it('scales the geometry, keeps marks their reading size, and names more threads as room opens', () => {
  const index = new ThreadIndex(cards), model = familyModel(index, root, root, feeds, now)
  const base = radialLayout(model, 1000, 680), view: View = { k: 3, x: -1, y: -1 }
  const sky = zoomPlate(base, view, model, null)
  const seen = (key: string) => sky.stars.find(star => star.thread.key === key)!
  for (const star of base.stars) {
    expect(seen(star.thread.key).x).toBeCloseTo(star.x * 3 - 1000)
    expect(seen(star.thread.key).r).toBeLessThanOrEqual(Math.max(star.full, star.own))
  }
  const names = sky.labels.map(label => ({ left: label.side === 'right' ? label.x : label.x - label.width, right: label.side === 'right' ? label.x + label.width : label.x, y: label.y }))
  for (const a of names) for (const b of names) if (a !== b) expect(a.left < b.right && b.left < a.right && Math.abs(a.y - b.y) < 24).toBe(false)
})
it('leaves the wheel to the page at the base scale, and takes it once zoomed', () => {
  const { stage, plate } = mapped()
  expect(wheel(plate, { deltaY: 40 }).defaultPrevented).toBe(false)
  expect(wheel(plate, { deltaY: -40, ctrlKey: true }).defaultPrevented).toBe(true)
  expect(wheel(plate, { deltaY: -40, metaKey: true }).defaultPrevented).toBe(true)
  expect(wheel(plate, { deltaY: 40 }).defaultPrevented).toBe(true)
  expect(stage.classList.contains('family-map-moving')).toBe(true)
})
it('repaints every frame a wheel runs, with no transition, and rests when it settles', async () => {
  vi.useFakeTimers()
  const { stage, plate } = mapped()
  const first = plate.querySelector<SVGElement>('.fm-star[data-root]')!, transform = first.style.transform
  for (let n = 0; n < 5; n++) { wheel(plate, { deltaY: -40, ctrlKey: true, clientX: 200, clientY: 200 }); vi.advanceTimersByTime(20) }
  expect(stage.classList.contains('family-map-moving')).toBe(true)
  expect(first.style.transform).not.toBe(transform)
  vi.advanceTimersByTime(400)
  expect(stage.classList.contains('family-map-zoomed')).toBe(true)
  expect(stage.classList.contains('family-map-moving')).toBe(false)
  expect(plate.querySelectorAll('.fm-label, .fm-focus').length).toBeGreaterThan(0)
})
it('rests a zoom inward on the scene it reached, with the title and the arc of that thread, and neighbours off the stage', () => {
  vi.useFakeTimers()
  const { stage, plate } = mapped()
  const body = stage.querySelector<SVGElement>('[aria-label^="Thread 3,"]')!
  const [, x, y] = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(body.style.transform)!
  for (let n = 0; n < 8; n++) wheel(plate, { deltaY: -60, ctrlKey: true, clientX: Number(x), clientY: Number(y) })
  vi.advanceTimersByTime(400)
  expect(stage.querySelector('.fm-focus-name')?.textContent).toBe('Thread 3')
  expect(body.hasAttribute('data-focus')).toBe(true)
  expect(body.style.transform).toBe('translate(500.0px, 340.0px)')
  expect(stage.querySelector('[aria-label^="Thread 2,"]')!.hasAttribute('data-hidden')).toBe(true)
})
it('reaches past the plate\'s edge once zoomed, so a body on the rim can come to the middle', () => {
  const index = new ThreadIndex(cards), model = familyModel(index, root, root, feeds, now)
  const base = radialLayout(model, 800, 720), rim = [...base.stars].sort((a, b) => a.x - b.x)[0], view = aim(base, rim.thread)
  expect(rim.x / 800 * view.k + view.x).toBeCloseTo(.5)
  const plate = zoomPlate(base, view, model, null)
  expect(plate.stars.find(star => star.thread === rim.thread)!.x).toBeCloseTo(400)
})
it('brings a thread\'s own scene to the plate at the size of every scene, whatever its depth', () => {
  const nested = [root, card({ id: 'hub/a', name: 'A', orchestrator: 'hub', status: 'active', workerState: 'running' }), card({ id: 'hub/a/b', name: 'B', orchestrator: 'hub/a', status: 'active', workerState: 'running' }), card({ id: 'hub/a/b/c', name: 'C', orchestrator: 'hub/a/b', status: 'active', workerState: 'running' })]
  const index = new ThreadIndex(nested), model = familyModel(index, root, root, feeds, now), base = radialLayout(model, 800, 720)
  const star = (name: string) => base.stars.find(item => item.thread.name === name)!
  expect(aim(base, model.root)).toEqual(WHOLE)
  const view = aim(base, star('B').thread), of = (item: { x: number; y: number }) => ({ x: item.x * view.k + view.x * 800, y: item.y * view.k + view.y * 720 })
  expect(view.k).toBeCloseTo(1 / star('B').scale)
  expect(of(star('B')).x).toBeCloseTo(400)
  expect(of(star('B')).y).toBeCloseTo(360)
  const rootScene = radialLayout(familyModel(new ThreadIndex(nested.slice(2).map((item, n) => n ? item : { ...item, orchestrator: undefined })), nested[2], nested[2], feeds, now), 800, 720)
  expect(of(star('C')).y - of(star('B')).y).toBeCloseTo(rootScene.stars[1].y - rootScene.stars[0].y, 0)
})
it('comes to the thread whose scene fills the plate around its middle as a hand zooms, keeping the one it holds, and the whole family short of any', () => {
  const index = new ThreadIndex(cards), model = familyModel(index, root, root, feeds, now), base = radialLayout(model, 800, 720)
  const star = base.stars[3], view = aim(base, star.thread)
  expect(sighted(base, WHOLE, null)).toBeNull()
  expect(sighted(base, { ...view, k: 1.1 }, null)).toBeNull()
  expect(sighted(base, view, null)).toBe(star.thread.key)
  expect(sighted(base, { k: 3, x: 40, y: 40 }, star.thread.key)).toBeNull()
})
it('tells a long name up to its last clause that fits, and never ends it on a dangling word', () => {
  expect(spokenName('Short name', 40)).toBe('Short name')
  expect(spokenName('sp_validation GitHub steward — CosmoStat PRs, issues and board', 40)).toBe('sp_validation GitHub steward')
  expect(spokenName('Data ↔ pipeline: the blinded vector on current develop', 30)).toBe('Data ↔ pipeline')
  expect(spokenName('Establish what causes the smooth droop of measured over model', 44)).toBe('Establish what causes the smooth droop')
  expect(spokenName('Explain the BB rise near the wall and the low-ell residual structure', 40)).toBe('Explain the BB rise near the wall')
  expect(spokenName('Run the very long pipeline again tomorrow morning please', 30)).toBe('Run the very long pipeline')
  expect(spokenName('x'.repeat(80), 40)).toBe('')
})
it('fits a name to one line, its marks after it while there is room', () => {
  const thread = (name: string, files = 0) => ({ name, files: new Array(files) }) as never
  expect(labelFit(thread('Short name'), 300)?.text).toBe('Short name')
  expect(labelFit(thread('Short name', 3), 300)?.files).toBe(true)
  expect(labelFit(thread('A name of just the length that fills', 300), 300)?.files).toBe(false)
  expect(labelFit(thread('x'.repeat(80)), 300)).toBeUndefined()
})
it('steps out on a double-click of the field, not of a thread, and leaves the spiral\'s pins', () => {
  vi.useFakeTimers()
  const { stage, plate } = mapped('radial')
  stored.set(`shuttle.family.spiral:${root.originId}:${root.uid ?? root.id}`, '{}')
  wheel(plate, { deltaY: -40, ctrlKey: true }); vi.advanceTimersByTime(400)
  expect(stage.classList.contains('family-map-zoomed')).toBe(true)
  stage.querySelector('.fm-star')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  expect(stage.classList.contains('family-map-zoomed')).toBe(true)
  plate.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  expect(stage.classList.contains('family-map-zoomed')).toBe(false)
})
it('pans a zoomed field by dragging it, and leaves the base field to the page', () => {
  vi.useFakeTimers()
  const { stage, plate } = mapped()
  const mouse = (target: EventTarget, type: string, x: number): void => { target.dispatchEvent(Object.defineProperty(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 340 }), 'view', { value: window })) }
  mouse(plate, 'mousedown', 500); mouse(window, 'mousemove', 400)
  expect(stage.classList.contains('family-map-moving')).toBe(false)
  mouse(window, 'mouseup', 400)
  wheel(plate, { deltaY: -60, ctrlKey: true }); vi.advanceTimersByTime(400)
  const root = () => plate.querySelector<SVGElement>('.fm-star[data-root]')!.style.transform, before = root()
  mouse(plate, 'mousedown', 500); mouse(window, 'mousemove', 400); vi.advanceTimersByTime(20)
  expect(stage.classList.contains('family-map-moving')).toBe(true)
  expect(root()).not.toBe(before)
  mouse(window, 'mouseup', 400); vi.advanceTimersByTime(40)
  expect(stage.classList.contains('family-map-moving')).toBe(false)
})
