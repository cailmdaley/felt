// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { ThreadIndex } from '../threads.js'
import { THREAD_PIN, type ThreadPinRequest } from '../ThreadPeek.js'
import type { FamilyFeeds } from './FamilyPage.js'
import { shouldForwardDocumentKey } from '../keymap.js'
import { sky } from '../family/sky.js'
import { disposeFileViewer, resumeFileViewer, suspendFileViewer } from '../FileViewerPanel.js'
import { FamilyPage } from './FamilyPage.js'

const now = 1_800_000_000_000, hour = 3_600_000
const feeds: FamilyFeeds = { marks: () => undefined, files: () => [], refresh: vi.fn() }
const when = (back: number): string => new Date(now - back * hour).toISOString()
const root = card({ id: 'hub', createdAt: when(300), status: 'active' })
const asked = card({ id: 'hub/q', name: 'Asked', orchestrator: 'hub', status: 'active', createdAt: when(10), ask: { text: 'Which one?', at: when(1) } })
const idle = card({ id: 'hub/w', name: 'Idle', orchestrator: 'hub', status: 'active', createdAt: when(10), workerState: 'running', runtimePhase: 'waiting', lastActivityAt: now - 2 * hour, outcome: 'Needs a look' })
const done = card({ id: 'hub/d', name: 'Done', orchestrator: 'hub', status: 'closed', tempered: true, createdAt: when(50), closedAt: when(5) })
const draft = card({ id: 'hub/draft', name: 'Draft', orchestrator: 'hub', status: 'open', createdAt: when(50) })
const cards = [root, asked, idle, done, draft]

function page(open = vi.fn(), feed = feeds): { page: FamilyPage; open: typeof open } {
  const family = new FamilyPage(open, feed, vi.fn())
  document.body.append(family.el)
  family.update(root, new ThreadIndex(cards), now)
  return { page: family, open }
}
const option = (family: FamilyPage, name: string): HTMLElement => family.el.querySelector<HTMLElement>(`[role="option"][aria-label^="${name},"]`)!
const peekName = (family: FamilyPage): string | null | undefined => family.el.querySelector('.ws-family-peek-name')?.textContent
const key_ = (el: Element, name: string): KeyboardEvent => { const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }); el.dispatchEvent(event); return event }
const pointer = (el: Element, type: string, pointerType: string): void => {
  const event = new Event(type, { bubbles: true }); Object.assign(event, { pointerType }); el.dispatchEvent(event)
}

const stored = new Map<string, string>()
beforeEach(() => {
  stored.clear()
  vi.stubGlobal('localStorage', { getItem: vi.fn((key: string) => stored.get(key) ?? null), setItem: vi.fn((key: string, value: string) => stored.set(key, value)), removeItem: vi.fn((key: string) => stored.delete(key)) })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
})
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('draws the sky first, counts what asks, and leads the peek with the most urgent thread', () => {
  const { page: family } = page()
  expect(family.el.querySelector('.family-map-sky')).not.toBeNull()
  expect(family.el.querySelector('.ws-family-counts')?.textContent).toBe('1 question1 your turn')
  expect(peekName(family)).toBe('Asked')
  expect(family.el.querySelector('.ws-family-peek-note')?.textContent).toBe('Which one?')
  expect(family.el.querySelector('.ws-family-all-counts')?.textContent).toBe('1 draft')
})
it('cycles the roster with its key and its buttons, and remembers the choice', () => {
  const { page: family } = page()
  const pressed = (): string | undefined => family.el.querySelector<HTMLElement>('.ws-family-drawing[aria-pressed="true"]')?.dataset.drawing
  expect(pressed()).toBe('sky')
  family.cycle()
  expect(pressed()).toBe('rings')
  expect(family.el.querySelector('.family-map-rings')).not.toBeNull()
  expect(family.el.querySelector('.family-map-sky')).toBeNull()
  expect(localStorage.getItem('shuttle.family.drawing')).toBe('rings')
  family.el.querySelector<HTMLElement>('[data-drawing="delta"]')!.click()
  expect(localStorage.getItem('shuttle.family.drawing')).toBe('delta')
  expect(pressed()).toBe('delta')
  family.cycle()
  expect(pressed()).toBe('sky')
  family.cycle()
  const { page: next } = page()
  expect(next.el.querySelector('.family-map-rings')).not.toBeNull()
})
it('falls back to the sky when storage refuses or holds a retired drawing', () => {
  localStorage.setItem('shuttle.family.drawing', 'retired')
  expect(page().page.el.querySelector('.family-map-sky')).not.toBeNull()
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied') })
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('denied') })
  const { page: family } = page()
  expect(family.el.querySelector('.family-map-sky')).not.toBeNull()
  family.cycle()
  expect(family.el.querySelector('.family-map-rings')).not.toBeNull()
})
it.each(['sky', 'rings', 'spiral', 'cloth', 'delta'])('walks the %s by arrow keys in attention order, stopping at the ends, and opens on Enter', drawing => {
  localStorage.setItem('shuttle.family.drawing', drawing)
  const { page: family, open } = page()
  family.focus()
  expect(document.activeElement).toBe(option(family, 'Asked'))
  expect(key_(document.activeElement!, 'ArrowDown').defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(option(family, 'Idle'))
  expect(peekName(family)).toBe('Idle')
  key_(document.activeElement!, 'ArrowRight')
  expect(peekName(family)).toBe(root.name)
  key_(document.activeElement!, 'ArrowUp')
  key_(document.activeElement!, 'ArrowLeft')
  key_(document.activeElement!, 'ArrowLeft')
  expect(peekName(family)).toBe('Asked')
  key_(document.activeElement!, 'End')
  expect(peekName(family)).toBe('Done')
  key_(document.activeElement!, 'ArrowDown')
  expect(peekName(family)).toBe('Done')
  key_(document.activeElement!, 'Home')
  key_(document.activeElement!, 'Enter')
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'hub/q' }))
})
it('arranges the spiral by dragging, per family, with order following and a way back', () => {
  stored.set('shuttle.family.drawing', 'spiral')
  const { page: family, open } = page()
  const key = (): string => [...stored.keys()].find(name => name.startsWith('shuttle.family.spiral:'))!
  const sequence = (): string[] => [...family.el.querySelectorAll<SVGGElement>('.fm-star')].sort((a, b) => Number(a.getAttribute('aria-posinset')) - Number(b.getAttribute('aria-posinset'))).map(star => star.getAttribute('aria-label')!.split(',')[0])
  const at = (name: string): { x: number; y: number } => { const [, x, y] = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(option(family, name).style.transform)!; return { x: Number(x), y: Number(y) } }
  const mouse = (target: EventTarget, type: string, point: { x: number; y: number }): void => {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: point.x, clientY: point.y }); target.dispatchEvent(event)
  }
  expect(sequence()).toContain('Idle')
  const from = at('Idle'), to = at('Asked')
  mouse(option(family, 'Idle'), 'pointerdown', from)
  mouse(window, 'pointermove', to)
  mouse(window, 'pointerup', to)
  option(family, 'Idle').dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(open).not.toHaveBeenCalled()
  expect(JSON.parse(stored.get(key())!)).toEqual({ [option(family, 'Idle').getAttribute('data-thread')!]: 0 })
  expect(option(family, 'Idle').hasAttribute('data-pinned')).toBe(true)
  family.focus()
  key_(document.activeElement!, 'Home')
  expect(peekName(family)).toBe('Idle')
  key_(document.activeElement!, 'ArrowDown')
  expect(peekName(family)).toBe('Asked')
  const reset = family.el.querySelector<HTMLButtonElement>('.fm-unpin')!
  expect(reset.hidden).toBe(false)
  reset.click()
  expect(key()).toBeUndefined()
  expect(reset.hidden).toBe(true)
  key_(document.activeElement!, 'Home')
  expect(peekName(family)).toBe('Asked')
})
it('leaves its arrows and Enter to itself under the reader, and j, k and h to the reader', () => {
  const { page: family } = page()
  family.focus()
  const target = document.activeElement!
  for (const name of ['ArrowDown', 'ArrowLeft', 'Home', 'Enter', ' ']) expect(shouldForwardDocumentKey({ target, defaultPrevented: false, key: name })).toBe(false)
  for (const name of ['j', 'k', 'h', 'l', 'v', 'b']) expect(shouldForwardDocumentKey({ target, defaultPrevented: false, key: name })).toBe(true)
  expect(key_(target, 'j').defaultPrevented).toBe(false)
  expect(peekName(family)).toBe('Asked')
})
it('peeks as the pointer rests on a thread, and keeps it after the pointer leaves', () => {
  const { page: family, open } = page()
  pointer(option(family, 'Idle').querySelector('path')!, 'pointerover', 'mouse')
  expect(peekName(family)).toBe('Idle')
  expect(option(family, 'Idle').getAttribute('tabindex')).toBe('0')
  expect(open).not.toHaveBeenCalled()
  option(family, 'Idle').dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'hub/w' }))
})
it('peeks on the first tap and opens on the second', () => {
  const { page: family, open } = page()
  const mark = option(family, 'Idle')
  pointer(mark, 'pointerdown', 'touch')
  mark.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(open).not.toHaveBeenCalled()
  expect(peekName(family)).toBe('Idle')
  pointer(mark, 'pointerdown', 'touch')
  mark.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'hub/w' }))
})
it('shows the selected thread\'s sent files in the peek, marks the unread, and opens one', () => {
  const files = Array.from({ length: 6 }, (_, n) => ({ key: `doc-${n}`, name: `f${n}.html`, at: now - n * hour, unread: n === 0 }))
  const { page: family, open } = page(vi.fn(), { ...feeds, files: thread => thread.id === 'hub/w' ? files : [] })
  pointer(option(family, 'Idle'), 'pointerover', 'mouse')
  const chips = [...family.el.querySelectorAll<HTMLElement>('.ws-family-peek-file')]
  expect(chips.map(chip => chip.textContent)).toEqual(['f0.html', 'f1.html', 'f2.html', 'f3.html'])
  expect(family.el.querySelector('.ws-family-peek-more')?.textContent).toBe('+2')
  expect(chips[0].hasAttribute('data-unread')).toBe(true)
  chips[1].click()
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'hub/w' }), 'doc-1')
})
it('keeps the selection and each mark\'s element across a repaint, so a moved thread drifts', () => {
  const { page: family } = page()
  pointer(option(family, 'Idle'), 'pointerover', 'mouse')
  const mark = option(family, 'Idle'), before = mark.style.transform
  const moved = { ...idle, lastActivityAt: now + hour - 60_000 }
  family.update(root, new ThreadIndex([root, asked, moved, done, draft]), now + hour)
  expect(option(family, 'Idle')).toBe(mark)
  expect(mark.style.transform).not.toBe(before)
  expect(peekName(family)).toBe('Idle')
  expect(mark.getAttribute('aria-selected')).toBe('true')
})
it('lands on the open thread on a thread\'s map, and repaints only when something changed', () => {
  const family = new FamilyPage(vi.fn(), feeds, vi.fn()), index = new ThreadIndex(cards)
  family.update(idle, index, now)
  expect(peekName(family)).toBe('Idle')
  const stage = family.el.querySelector('[role="listbox"]')!, marks = stage.querySelector('.fm-stars')
  family.update(idle, new ThreadIndex(cards), now)
  expect(stage.querySelector('.fm-stars')).toBe(marks)
})
it('moves the selection on when its thread leaves the map', () => {
  const { page: family } = page()
  pointer(option(family, 'Idle'), 'pointerover', 'mouse')
  family.update(root, new ThreadIndex([root, asked, done, draft]), now)
  expect(peekName(family)).toBe('Asked')
})
it('keeps every thread reachable in the fold, with its folds, pin and links', () => {
  const open = vi.fn(), { page: family } = page(open)
  const all = family.el.querySelector<HTMLDetailsElement>('.ws-family-all')!
  const names = [...all.querySelectorAll('.kbn-thread-name')].map(el => el.textContent)
  expect(names).toEqual(expect.arrayContaining([root.name, 'Asked', 'Idle', 'Done', 'Draft']))
  const row = [...all.querySelectorAll<HTMLElement>('.kbn-thread-row')].find(el => el.textContent?.includes('Draft'))!
  row.click()
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'hub/draft' }))
  const asks = vi.fn((event: Event) => (event as CustomEvent<ThreadPinRequest>).detail)
  family.el.addEventListener(THREAD_PIN, asks)
  const rootItem = [...all.querySelectorAll<HTMLElement>('.kbn-thread-item')].find(item => item.textContent?.includes(root.name))!
  rootItem.querySelector<HTMLButtonElement>('.kbn-thread-pin')!.click()
  expect(asks.mock.results[0].value).toEqual({ card: expect.objectContaining({ id: 'hub' }), pinned: true })
})
it('drops the old drawing when another page changed it, its gestures with it', () => {
  stored.set('shuttle.family.drawing', 'spiral')
  const { page: family } = page()
  const stage = family.el.querySelector('[role="listbox"]')!
  stored.set('shuttle.family.drawing', 'cloth')
  family.update(root, new ThreadIndex(cards), now + hour)
  expect(stage.className.split(' ')).toContain('family-map-cloth')
  expect(stage.className).not.toContain('family-map-spiral')
  expect(stage.querySelector('.fm-sky-plate')).toBeNull()
})
it('reads, repaints and animates nothing parked, and catches up when selected again', () => {
  const refresh = vi.fn(), { page: family } = page(vi.fn(), { ...feeds, refresh })
  const asks = refresh.mock.calls.length
  suspendFileViewer(family.el)
  expect(family.el.classList.contains('family-map-parked')).toBe(true)
  const moved = { ...asked, name: 'Asked again' }
  family.update(root, new ThreadIndex([root, moved, idle, done, draft]), now + hour)
  expect(refresh.mock.calls.length).toBe(asks)
  expect(peekName(family)).toBe('Asked')
  resumeFileViewer(family.el)
  expect(family.el.classList.contains('family-map-parked')).toBe(false)
  expect(refresh.mock.calls.length).toBeGreaterThan(asks)
  expect(peekName(family)).toBe('Asked again')
})
it('falls back to the first thread when the selected one goes aside, keeping a focusable option', () => {
  const { page: family, open } = page()
  pointer(option(family, 'Idle'), 'pointerover', 'mouse')
  const rested = card({ ...idle, status: 'open', effectiveHorizon: 'stashed', workerState: undefined, runtimePhase: undefined })
  family.update(root, new ThreadIndex([root, asked, rested, done, draft]), now)
  expect(peekName(family)).toBe('Asked')
  const held = family.el.querySelector<HTMLElement>('[role="option"][tabindex="0"]')!
  held.focus()
  key_(held, 'Enter')
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'hub/q' }))
})
it('leaves a star the map does not draw unselectable, by pointer or first tap', () => {
  stored.set('shuttle.family.drawing', 'rings')
  const { page: family } = page()
  const star = family.el.querySelector<SVGGElement>('.fm-star[data-standing="aside"]')!
  expect(star.hasAttribute('role')).toBe(false)
  pointer(star, 'pointerover', 'mouse')
  expect(peekName(family)).toBe('Asked')
  expect(family.el.querySelector('[role="option"][tabindex="0"]')).not.toBeNull()
  const walked = option(family, 'Idle')
  pointer(walked, 'pointerover', 'mouse')
  const rested = card({ ...idle, status: 'open', effectiveHorizon: 'stashed', workerState: undefined, runtimePhase: undefined })
  family.update(root, new ThreadIndex([root, asked, rested, done, draft]), now)
  expect(walked.hasAttribute('role')).toBe(false)
  expect(walked.hasAttribute('tabindex')).toBe(false)
})
it('paints once a resize settles, however many frames it crossed', () => {
  vi.useFakeTimers()
  let fire = (): void => {}
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { fire = callback } observe(): void {} disconnect(): void {} })
  vi.stubGlobal('requestAnimationFrame', vi.fn())
  const { page: family } = page()
  const stage = family.el.querySelector<HTMLElement>('[role="listbox"]')!
  let width = 900
  Object.defineProperty(stage, 'clientWidth', { get: () => width }); Object.defineProperty(stage, 'clientHeight', { get: () => 700 })
  fire()
  const paints = vi.spyOn(sky, 'draw')
  for (width = 800; width > 600; width -= 20) { fire(); vi.advanceTimersByTime(16) }
  expect(paints).not.toHaveBeenCalled()
  vi.advanceTimersByTime(200)
  expect(paints).toHaveBeenCalledTimes(1)
  expect(stage.classList.contains('family-map-still')).toBe(true)
  fire()
  vi.advanceTimersByTime(200)
  expect(paints).toHaveBeenCalledTimes(1)
  vi.useRealTimers()
})
it('leaves keys on its controls and modified keys alone', () => {
  stored.set('shuttle.family.drawing', 'spiral')
  const { page: family, open } = page()
  const pin = family.el.querySelector<HTMLButtonElement>('.fm-unpin')!
  expect(key_(pin, 'Enter').defaultPrevented).toBe(false)
  expect(open).not.toHaveBeenCalled()
  family.focus()
  const back = new KeyboardEvent('keydown', { key: 'ArrowLeft', metaKey: true, bubbles: true, cancelable: true })
  document.activeElement!.dispatchEvent(back)
  expect(back.defaultPrevented).toBe(false)
})
it('disconnects its observer and tells its owner when its frame is evicted', () => {
  const disconnect = vi.fn(), disposed = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect = disconnect })
  const family = new FamilyPage(vi.fn(), feeds, disposed)
  disposeFileViewer(family.el)
  expect(disconnect).toHaveBeenCalledOnce()
  expect(disposed).toHaveBeenCalledOnce()
})
it('keeps the peek and the focus in it across a repaint, and announces keys, not hover', () => {
  const files = [{ key: 'doc', name: 'f.html', at: now, unread: false }]
  const { page: family } = page(vi.fn(), { ...feeds, files: thread => thread.id === 'hub/q' ? files : [] })
  const chip = family.el.querySelector<HTMLElement>('.ws-family-peek-file')!
  chip.focus()
  family.update(root, new ThreadIndex(cards), now + 5 * 60_000)
  expect(family.el.querySelector('.ws-family-peek-file')).toBe(chip)
  expect(document.activeElement).toBe(chip)
  expect(family.el.querySelector('.ws-family-peek')!.hasAttribute('aria-live')).toBe(false)
  const live = family.el.querySelector('[aria-live="polite"]')!
  pointer(option(family, 'Idle'), 'pointerover', 'mouse')
  expect(live.textContent).toBe('')
  family.focus()
  key_(document.activeElement!, 'ArrowUp')
  expect(live.textContent).toContain('Which one?')
})
const spiralPins = (): string | undefined => [...stored.keys()].find(name => name.startsWith('shuttle.family.spiral:'))
const dragStar = (family: FamilyPage, from: string, to: string): void => {
  const at = (name: string): { clientX: number; clientY: number } => { const [, x, y] = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(option(family, name).style.transform)!; return { clientX: Number(x), clientY: Number(y) } }
  const start = at(from), end = at(to)
  option(family, from).dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, ...start }))
  window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, ...end }))
  window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, ...end }))
}
it('clears the spiral\'s pins even after storage refused one', async () => {
  stored.set('shuttle.family.drawing', 'spiral')
  const { page: family } = page()
  dragStar(family, 'Idle', 'Asked')
  const key = spiralPins()!
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
  dragStar(family, 'Asked', 'Idle')
  await new Promise(done => setTimeout(done))
  family.el.querySelector<HTMLButtonElement>('.fm-unpin')!.click()
  expect(stored.has(key)).toBe(false)
  expect(family.el.querySelector<HTMLButtonElement>('.fm-unpin')!.hidden).toBe(true)
})
it('takes a thread\'s pin away when it finishes', () => {
  stored.set('shuttle.family.drawing', 'spiral')
  const { page: family } = page()
  dragStar(family, 'Idle', 'Asked')
  const finished = { ...idle, status: 'closed', tempered: true, closedAt: when(1), workerState: undefined, runtimePhase: undefined }
  family.update(root, new ThreadIndex([root, asked, finished, done, draft]), now + hour)
  expect(spiralPins()).toBeUndefined()
  expect(family.el.querySelector('[data-pinned]')).toBeNull()
})
it('draws a drag with the newest model, not the one it began on', () => {
  stored.set('shuttle.family.drawing', 'spiral')
  const { page: family } = page()
  const start = option(family, 'Idle'), box = { clientX: 0, clientY: 0 }
  start.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, ...box }))
  const fresh = card({ id: 'hub/n', name: 'Newcomer', orchestrator: 'hub', status: 'active', createdAt: when(1), workerState: 'running', runtimePhase: 'working', lastActivityAt: now })
  family.update(root, new ThreadIndex([root, asked, idle, fresh, done, draft]), now + hour)
  window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 500, clientY: 340 }))
  window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 500, clientY: 340 }))
  expect(option(family, 'Newcomer')).not.toBeNull()
})
