// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { card } from '../testFixtures.js'
import { ThreadIndex } from '../threads.js'
import { THREAD_PIN, type ThreadPinRequest } from '../ThreadPeek.js'
import type { KanbanCard } from '../KanbanTypes.js'
import type { FamilyFeeds, MapPlace } from './FamilyPage.js'
import { shouldForwardDocumentKey } from '../keymap.js'
import { radial } from '../family/radial.js'
import { disposeFileViewer, resumeFileViewer, suspendFileViewer } from '../FileViewerPanel.js'
import { FamilyPage } from './FamilyPage.js'
import { threadKey as threadKeyOf } from '../threads.js'

const now = 1_800_000_000_000, hour = 3_600_000
const feeds: FamilyFeeds = { marks: () => undefined, files: () => [], refresh: vi.fn(), lead: async () => undefined }
const when = (back: number): string => new Date(now - back * hour).toISOString()
const root = card({ id: 'hub', createdAt: when(300), status: 'active' })
const asked = card({ id: 'hub/q', name: 'Asked', orchestrator: 'hub', status: 'active', createdAt: when(10), ask: { text: 'Which one?', at: when(1) } })
const idle = card({ id: 'hub/w', name: 'Idle', orchestrator: 'hub', status: 'active', createdAt: when(10), workerState: 'running', runtimePhase: 'waiting', lastActivityAt: now - 2 * hour, outcome: 'Needs a look' })
const done = card({ id: 'hub/d', name: 'Done', orchestrator: 'hub', status: 'closed', tempered: true, createdAt: when(50), closedAt: when(5) })
const draft = card({ id: 'hub/draft', name: 'Draft', orchestrator: 'hub', status: 'open', createdAt: when(50) })
const cards = [root, asked, idle, done, draft]

function page(open = vi.fn(), feed = feeds, place: MapPlace = { focus: null, view: null }, known = cards): { page: FamilyPage; open: typeof open; converse: Mock; place: MapPlace } {
  const converse = vi.fn(), family = new FamilyPage(open, converse, feed, place, vi.fn())
  document.body.append(family.el)
  family.update(root, new ThreadIndex(known), now)
  return { page: family, open, converse, place }
}
const stageOf = (family: FamilyPage): HTMLElement => family.el.querySelector<HTMLElement>('[role="listbox"]')!
const click = (el: Element): void => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
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
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduced-motion') }))
})
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('draws the sky first, counts what asks, and leads the peek with the most urgent thread', () => {
  const { page: family } = page()
  expect(family.el.querySelector('.family-map-radial')).not.toBeNull()
  expect(family.el.querySelector('.ws-family-counts')?.textContent).toBe('1 question1 your turn')
  expect(peekName(family)).toBe('Asked')
  expect(family.el.querySelector('.ws-family-peek-note')?.textContent).toBe('Which one?')
  expect(family.el.querySelector('.ws-family-all-counts')?.textContent).toBe('1 draft')
})
it('toggles the two drawings with its key and its buttons, and remembers the choice', () => {
  const { page: family } = page()
  const pressed = (): string | undefined => family.el.querySelector<HTMLElement>('.ws-family-drawing[aria-pressed="true"]')?.dataset.drawing
  expect(pressed()).toBe('radial')
  family.cycle()
  expect(pressed()).toBe('cloth')
  expect(family.el.querySelector('.family-map-cloth')).not.toBeNull()
  expect(family.el.querySelector('.family-map-radial')).toBeNull()
  expect(localStorage.getItem('shuttle.family.drawing')).toBe('cloth')
  family.el.querySelector<HTMLElement>('[data-drawing="radial"]')!.click()
  expect(localStorage.getItem('shuttle.family.drawing')).toBe('radial')
  family.cycle()
  const { page: next } = page()
  expect(next.el.querySelector('.family-map-cloth')).not.toBeNull()
})
it('falls back to the radial when storage refuses or holds a retired drawing', () => {
  localStorage.setItem('shuttle.family.drawing', 'retired')
  expect(page().page.el.querySelector('.family-map-radial')).not.toBeNull()
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied') })
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('denied') })
  const { page: family } = page()
  expect(family.el.querySelector('.family-map-radial')).not.toBeNull()
  family.cycle()
  expect(family.el.querySelector('.family-map-cloth')).not.toBeNull()
})
it.each(['radial', 'cloth'])('walks the %s by arrow keys in attention order, stopping at the ends, and comes to a thread on Enter', drawing => {
  localStorage.setItem('shuttle.family.drawing', drawing)
  const { page: family, open, place } = page()
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
  expect(peekName(family)).toBe('Asked')
  expect(place.focus).toContain('hub/q')
  expect(open).not.toHaveBeenCalled()
})
it('arranges the arms by dragging, per family, with a way back', () => {
  stored.set('shuttle.family.drawing', 'radial')
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
  mouse(window, 'pointermove', { x: to.x, y: to.y + 10 })
  mouse(window, 'pointerup', to)
  option(family, 'Idle').dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(open).not.toHaveBeenCalled()
  expect(JSON.parse(stored.get(key())!)).toEqual({ [option(family, 'Idle').getAttribute('data-thread')!]: { arm: 'todo', slot: 0, standing: 'turn' } })
  expect(option(family, 'Idle').hasAttribute('data-pinned')).toBe(true)
  family.focus()
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
  const { page: family, open, place } = page()
  pointer(option(family, 'Idle').querySelector('path')!, 'pointerover', 'mouse')
  expect(peekName(family)).toBe('Idle')
  expect(option(family, 'Idle').getAttribute('tabindex')).toBe('0')
  expect(open).not.toHaveBeenCalled()
  expect(place.focus).toBeNull()
})
it('comes to a thread on a first tap and opens its conversation on the second', () => {
  const held = card({ ...idle, sessionUuid: 'session-idle' })
  const { page: family, converse, place } = page(vi.fn(), feeds, undefined, [root, asked, held, done, draft])
  const mark = option(family, 'Idle')
  pointer(mark, 'pointerdown', 'touch')
  click(mark)
  expect(converse).not.toHaveBeenCalled()
  expect(place.focus).toContain('hub/w')
  expect(peekName(family)).toBe('Idle')
  pointer(mark, 'pointerdown', 'touch')
  click(mark)
  expect(converse).toHaveBeenCalledWith(expect.objectContaining({ id: 'hub/w' }))
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
  const newcomer = card({ id: 'hub/n', name: 'Newcomer', orchestrator: 'hub', status: 'active', createdAt: when(1), ask: { text: 'Now?', at: when(0) } })
  family.update(root, new ThreadIndex([root, newcomer, asked, idle, done, draft]), now + hour)
  expect(option(family, 'Idle')).toBe(mark)
  expect(mark.style.transform).not.toBe(before)
  expect(peekName(family)).toBe('Idle')
  expect(mark.getAttribute('aria-selected')).toBe('true')
})
it('lands on the open thread on a thread\'s map, and repaints only when something changed', () => {
  const family = new FamilyPage(vi.fn(), vi.fn(), feeds, { focus: null, view: null }, vi.fn()), index = new ThreadIndex(cards)
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
  open.mockClear()
  ;[...all.querySelectorAll<HTMLElement>('.kbn-thread-row')].find(el => el.textContent?.includes('Idle'))!.click()
  expect(open).not.toHaveBeenCalled()
  expect(peekName(family)).toBe('Idle')
  const asks = vi.fn((event: Event) => (event as CustomEvent<ThreadPinRequest>).detail)
  family.el.addEventListener(THREAD_PIN, asks)
  const rootItem = [...all.querySelectorAll<HTMLElement>('.kbn-thread-item')].find(item => item.textContent?.includes(root.name))!
  rootItem.querySelector<HTMLButtonElement>('.kbn-thread-pin')!.click()
  expect(asks.mock.results[0].value).toEqual({ card: expect.objectContaining({ id: 'hub' }), pinned: true })
})
it('drops the old drawing when another page changed it, its gestures with it', () => {
  stored.set('shuttle.family.drawing', 'radial')
  const { page: family } = page()
  const stage = family.el.querySelector('[role="listbox"]')!
  stored.set('shuttle.family.drawing', 'cloth')
  family.update(root, new ThreadIndex(cards), now + hour)
  expect(stage.className.split(' ')).toContain('family-map-cloth')
  expect(stage.className).not.toContain('family-map-radial')
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
  const { page: family, place } = page()
  pointer(option(family, 'Idle'), 'pointerover', 'mouse')
  const rested = card({ ...idle, status: 'open', effectiveHorizon: 'stashed', workerState: undefined, runtimePhase: undefined })
  family.update(root, new ThreadIndex([root, asked, rested, done, draft]), now)
  expect(peekName(family)).toBe('Asked')
  const held = family.el.querySelector<HTMLElement>('[role="option"][tabindex="0"]')!
  held.focus()
  key_(held, 'Enter')
  expect(place.focus).toContain('hub/q')
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
  const paints = vi.spyOn(radial, 'draw')
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
  stored.set('shuttle.family.drawing', 'radial')
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
  const family = new FamilyPage(vi.fn(), vi.fn(), feeds, { focus: null, view: null }, disposed)
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
  stored.set('shuttle.family.drawing', 'radial')
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
  stored.set('shuttle.family.drawing', 'radial')
  const { page: family } = page()
  dragStar(family, 'Idle', 'Asked')
  const finished = { ...idle, status: 'closed', tempered: true, closedAt: when(1), workerState: undefined, runtimePhase: undefined }
  family.update(root, new ThreadIndex([root, asked, finished, done, draft]), now + hour)
  expect(spiralPins()).toBeUndefined()
  expect(family.el.querySelector('[data-pinned]')).toBeNull()
})
it('draws a drag with the newest model, not the one it began on', () => {
  stored.set('shuttle.family.drawing', 'radial')
  const { page: family } = page()
  const start = option(family, 'Idle'), box = { clientX: 0, clientY: 0 }
  start.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, ...box }))
  const fresh = card({ id: 'hub/n', name: 'Newcomer', orchestrator: 'hub', status: 'active', createdAt: when(1), workerState: 'running', runtimePhase: 'working', lastActivityAt: now })
  family.update(root, new ThreadIndex([root, asked, idle, fresh, done, draft]), now + hour)
  window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 500, clientY: 340 }))
  window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 500, clientY: 340 }))
  expect(option(family, 'Newcomer')).not.toBeNull()
})

it('offers a thread with a worker its conversation from the peek', () => {
  const root = card({ id: 'hub' }), thread = card({ id: 'hub/a', orchestrator: 'hub', status: 'active', workerState: 'running', runtimePhase: 'waiting', terminalBackend: 'rex' })
  const converse = vi.fn(), page = new FamilyPage(vi.fn(), converse, { marks: () => undefined, files: () => [], refresh: () => {}, lead: async () => undefined }, { focus: null, view: null }, () => {})
  document.body.append(page.el)
  page.update(root, new ThreadIndex([root, thread]))
  expect(page.selection?.id).toBe('hub/a')
  const worker = page.el.querySelector<HTMLButtonElement>('.ws-family-peek-worker')!
  expect(worker.textContent).toBe('Open in Rex')
  worker.click()
  expect(converse).toHaveBeenCalledWith(expect.objectContaining({ id: 'hub/a' }))
})

describe('coming to a thread', () => {
  const staged = (file: string): { key: string; name: string; at: number; unread: boolean } => ({ key: `doc:${file}`, name: file, at: now - hour, unread: file === 'fresh.png' })
  const sent = [staged('fresh.png'), staged('notes.md')]
  const hubMid = card({ id: 'hub/mid', name: 'Mid', orchestrator: 'hub', status: 'active', createdAt: when(40), workerState: 'running', runtimePhase: 'waiting', sessionUuid: 'session-mid' })
  const leafA = card({ id: 'hub/mid/a', name: 'Leaf a', orchestrator: 'hub/mid', status: 'active', createdAt: when(20), ask: { text: 'Which?', at: when(1) } })
  const leafB = card({ id: 'hub/mid/b', name: 'Leaf b', orchestrator: 'hub/mid', status: 'closed', tempered: true, createdAt: when(30), closedAt: when(10) })
  const tree = [root, hubMid, leafA, leafB]
  const lead = { key: 'doc:tapestry', name: 'Tapestry', at: now - 2 * hour, unread: false }
  const holding: FamilyFeeds = { ...feeds, files: thread => thread.id === 'hub/mid' ? sent : [], lead: vi.fn(async thread => thread.id === 'hub/mid' ? lead : undefined) }
  const settled = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }
  const named = (family: FamilyPage): string[] => [...family.el.querySelectorAll('.fm-held-name')].map(el => el.textContent!)

  it.each(['radial'])('flies the %s to the thread and opens its conversation, staying on the page', async drawing => {
    stored.set('shuttle.family.drawing', drawing)
    const { page: family, open, converse, place } = page(vi.fn(), holding, undefined, tree)
    const stage = stageOf(family)
    expect(stage.classList.contains('family-map-zoomed')).toBe(false)
    click(option(family, 'Mid'))
    expect(stage.classList.contains('family-map-zoomed')).toBe(true)
    expect(converse).toHaveBeenCalledTimes(1)
    expect(converse).toHaveBeenCalledWith(expect.objectContaining({ id: 'hub/mid' }))
    expect(open).not.toHaveBeenCalled()
    expect(place.focus).toContain('hub/mid')
    expect(option(family, 'Mid').hasAttribute('data-focus')).toBe(true)
    expect(family.el.querySelector('.fm-focus-name')?.textContent).toBe('Mid')
    await settled()
    expect(named(family)).toEqual(['Tapestry', 'fresh.png', 'notes.md', 'Constitution'])
  })
  it('counts a body\'s double-click as one coming, so one conversation opens', () => {
    const { page: family, converse } = page(vi.fn(), holding, undefined, tree)
    const mark = option(family, 'Mid')
    mark.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    mark.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
    expect(converse).toHaveBeenCalledTimes(1)
  })
  it('opens no conversation for a thread that has neither worker nor session', () => {
    const { page: family, converse } = page()
    click(option(family, 'Asked'))
    expect(converse).not.toHaveBeenCalled()
  })
  it('lands a click in one kind of place: the whole family is a scene like any thread\'s, with what it holds and no level above it', async () => {
    const { page: family } = page(vi.fn(), { ...holding, lead: async () => lead }, { focus: threadKeyOf(root), view: null }, tree)
    await settled()
    await settled()
    expect(stageOf(family).classList.contains('family-map-zoomed')).toBe(false)
    expect(family.el.querySelector('.fm-focus-name')?.textContent).toBe(root.name)
    expect(named(family)).toEqual(['Tapestry', 'Constitution'])
    expect(family.outward).toBeUndefined()
  })
  it('unfolds a thread in fixed places: tapestry first and largest, files newest first, the constitution small and across, its threads on their arms', async () => {
    const { page: family } = page(vi.fn(), holding, undefined, tree)
    click(option(family, 'Mid'))
    await settled()
    const held = [...family.el.querySelectorAll<HTMLElement>('.fm-held')]
    expect(held.map(way => way.dataset.kind)).toEqual(['lead', 'file', 'file', 'constitution'])
    expect(held.map(way => way.hasAttribute('data-unread'))).toEqual([false, true, false, false])
    expect(held[0].dataset.side).toBe('right')
    expect(held[3].dataset.side).toBe('left')
    expect([...family.el.querySelectorAll('.fm-label-name')].map(el => el.textContent)).toEqual(['Leaf a', 'Leaf b'])
    expect(family.el.querySelectorAll('.fm-reach').length).toBeGreaterThanOrEqual(2)
  })
  it('keeps every place where it is when a thread lacks what fills another', async () => {
    const plain: FamilyFeeds = { ...holding, lead: async () => undefined }
    const places = async (feed: FamilyFeeds): Promise<Map<string, string>> => {
      const { page: family } = page(vi.fn(), feed, undefined, tree)
      click(option(family, 'Mid'))
      await settled()
      const found = new Map([...family.el.querySelectorAll<HTMLElement>('.fm-held')].map(way => [way.dataset.held!, way.style.transform]))
      family.el.remove()
      return found
    }
    const whole = await places(holding), bare = await places(plain)
    expect(whole.has('doc:tapestry')).toBe(true)
    expect(bare.has('doc:tapestry')).toBe(false)
    for (const key of ['doc:fresh.png', 'doc:notes.md']) expect(bare.get(key)).toBe(whole.get(key))
    expect(bare.get('fiber:local:hub/mid')).toBe(whole.get('fiber:local:hub/mid'))
  })
  it('opens the constitution from its place, and no conversation', async () => {
    const open = vi.fn(), { page: family, converse } = page(open, holding, undefined, tree)
    click(option(family, 'Mid'))
    await settled()
    converse.mockClear()
    family.el.querySelector<HTMLElement>('.fm-held[data-kind="constitution"]')!.click()
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'hub/mid' }), expect.stringMatching(/^fiber:/))
    expect(converse).not.toHaveBeenCalled()
  })
  it('opens a held file on the stage, leaving the place it left for Back to find', async () => {
    const open = vi.fn(), { page: family, place, converse } = page(open, holding, undefined, tree)
    click(option(family, 'Mid'))
    converse.mockClear()
    await settled()
    const way = [...family.el.querySelectorAll<HTMLElement>('.fm-held')].find(el => el.textContent?.includes('notes.md'))!
    way.click()
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'hub/mid' }), 'doc:notes.md')
    expect(converse).not.toHaveBeenCalled()
    expect(place.focus).toContain('hub/mid')
    const again = new FamilyPage(open, vi.fn(), holding, place, vi.fn())
    document.body.append(again.el)
    again.update(root, new ThreadIndex(tree), now)
    expect(again.el.querySelector('[role="listbox"]')!.classList.contains('family-map-zoomed')).toBe(true)
    expect(option(again, 'Mid').hasAttribute('data-focus')).toBe(true)
  })
  it('steps out one level at a time, along the tree, to the whole; then has nowhere further', () => {
    const { page: family, place } = page(vi.fn(), holding, undefined, tree)
    click(option(family, 'Leaf a'))
    expect(place.focus).toContain('hub/mid/a')
    expect(family.outward).toBe('Mid')
    expect(family.stepOut()).toBe(true)
    expect(place.focus?.endsWith('hub/mid')).toBe(true)
    expect(family.outward).toBe('Whole family')
    expect(family.stepOut()).toBe(true)
    expect(place.focus).toBeNull()
    expect(stageOf(family).classList.contains('family-map-zoomed')).toBe(false)
    expect(family.outward).toBeUndefined()
    expect(family.stepOut()).toBe(false)
  })
  it('steps out on a double-click of the field, not of what the field holds', async () => {
    const { page: family, place } = page(vi.fn(), holding, undefined, tree)
    click(option(family, 'Mid'))
    await settled()
    family.el.querySelector('.fm-held')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(place.focus).not.toBeNull()
    family.el.querySelector('.fm-sky-plate')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(place.focus).toBeNull()
  })
  it('flies for Rex without speaking to Rex, and refuses a thread it has no place for', () => {
    const { page: family, converse, place } = page(vi.fn(), holding, undefined, tree)
    expect(family.flyTo(hubMid)).toBe(true)
    expect(place.focus).toContain('hub/mid')
    expect(place.worker).toContain('hub/mid')
    expect(converse).not.toHaveBeenCalled()
    expect(family.flyTo(card({ id: 'elsewhere' }))).toBe(false)
  })
  it('marks the worker Rex holds wherever the view goes, stepping out and panning leaving it be', () => {
    const { page: family, converse, place } = page(vi.fn(), holding, undefined, tree)
    click(option(family, 'Mid'))
    expect(option(family, 'Mid').hasAttribute('data-worker')).toBe(true)
    converse.mockClear()
    family.stepOut()
    expect(place.focus).toBeNull()
    expect(place.worker).toContain('hub/mid')
    expect(option(family, 'Mid').hasAttribute('data-worker')).toBe(true)
    expect(converse).not.toHaveBeenCalled()
  })
  it('holds a constitution with no threads unfolded, with nowhere to step out to', async () => {
    const lone = card({ id: 'lone', name: 'Lone', status: 'active', createdAt: when(30), sessionUuid: 'session-lone' })
    const feed: FamilyFeeds = { ...holding, files: () => sent, lead: async () => lead }
    const place: MapPlace = { focus: null, view: null }
    const family = new FamilyPage(vi.fn(), vi.fn(), feed, place, vi.fn())
    document.body.append(family.el)
    family.update(lone, new ThreadIndex([lone]), now)
    await settled()
    expect(place.focus).toContain('lone')
    expect(option(family, 'Lone').hasAttribute('data-focus')).toBe(true)
    expect(named(family)).toEqual(['Tapestry', 'fresh.png', 'notes.md', 'Constitution'])
    expect(family.outward).toBeUndefined()
    expect(family.stepOut()).toBe(false)
  })
  it('comes to rest on a thread as a hand zooms in, however far, showing what it holds and leaving Rex alone', async () => {
    const reads = vi.fn(async () => lead)
    const { page: family, converse, place } = page(vi.fn(), { ...holding, files: () => sent, lead: reads }, undefined, tree)
    const stage = stageOf(family), plate = stage.querySelector<HTMLElement>('.fm-sky-plate')!
    plate.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 680, width: 1000, height: 680 }) as DOMRect
    const before = option(family, 'Leaf a').style.transform
    vi.useFakeTimers()
    for (let n = 0; n < 40; n++) plate.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -60, clientX: 500, clientY: 340 }))
    vi.advanceTimersByTime(300)
    vi.useRealTimers()
    await settled()
    expect(place.focus).not.toBeNull()
    expect(stage.querySelectorAll('.fm-mini').length + stage.querySelectorAll('.fm-held').length).toBeGreaterThan(0)
    expect(before).not.toBe('')
    expect(converse).not.toHaveBeenCalled()
  })
  it('opens a body\'s file from its miniature, for that body', async () => {
    const open = vi.fn(), place: MapPlace = { focus: null, view: { k: 3, x: -1, y: -1 } }
    const family = page(open, { ...holding, files: () => sent, lead: async () => lead }, place, tree).page
    await settled()
    const way = family.el.querySelector<HTMLElement>('.fm-mini')
    if (way) { way.click(); expect(open).toHaveBeenCalledWith(expect.anything(), way.dataset.held) }
  })
  it('draws the way to a thread along its arm: one kind of line, lit from the body back to the centre', () => {
    const { page: family } = page(vi.fn(), feeds, undefined, tree)
    const lit = (): number => family.el.querySelectorAll('.fm-reach[data-chain]').length
    expect(family.el.querySelector('.fm-link, .fm-leader, .fm-orbit, .fm-tether')).toBeNull()
    pointer(option(family, 'Mid'), 'pointerover', 'mouse')
    expect(lit()).toBeGreaterThan(0)
  })
  it('keeps the thread in frame as the family moves, and leaves the view where a hand put it', () => {
    const { page: family, place } = page(vi.fn(), holding, undefined, tree)
    click(option(family, 'Mid'))
    const at = (): string => option(family, 'Mid').style.transform, held = at()
    const moved = { ...hubMid, lastActivityAt: now + 40 * hour }
    family.update(root, new ThreadIndex([root, moved, leafA, leafB]), now + 40 * hour)
    expect(at()).toBe(held)
    expect(place.view).toBeNull()
  })
  it('opens a row\'s fold in the cloth, with the conversation, and leaves each file a way in', async () => {
    stored.set('shuttle.family.drawing', 'cloth')
    const open = vi.fn(), { page: family, converse, place } = page(open, holding, undefined, tree)
    click(option(family, 'Mid'))
    expect(converse).toHaveBeenCalledTimes(1)
    await settled()
    const files = [...family.el.querySelectorAll<HTMLElement>('.fm-fold-file')]
    expect(files.map(way => way.querySelector('.fm-fold-name')?.textContent)).toEqual(['Tapestry', 'fresh.png', 'notes.md', 'Constitution'])
    expect(files[1].hasAttribute('data-unread')).toBe(true)
    converse.mockClear()
    files[0].click()
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'hub/mid' }), 'doc:tapestry')
    expect(converse).not.toHaveBeenCalled()
    expect(family.stepOut()).toBe(true)
    expect(place.focus).toBeNull()
    expect(family.el.querySelector('.fm-fold-file')).toBeNull()
  })
  it('names the tapestry for `l`, else the newest file, and never reads for a thread it has left', async () => {
    const reads = vi.fn((thread: KanbanCard) => holding.lead(thread)), { page: family } = page(vi.fn(), { ...holding, lead: reads }, undefined, tree)
    expect(family.leading).toBeUndefined()
    click(option(family, 'Mid'))
    expect(family.leading?.doc).toBe('doc:fresh.png')
    await settled()
    expect(family.leading?.doc).toBe('doc:tapestry')
    expect(reads.mock.calls.filter(([thread]) => thread.id === 'hub/mid')).toHaveLength(1)
    click(option(family, 'Leaf a'))
    await settled()
    expect(family.leading).toBeUndefined()
  })
  it('colours a thread by its state and leaves a new file to the mark on top', () => {
    const fresh: FamilyFeeds = { ...feeds, files: thread => thread.id === 'hub/w' ? [{ ...staged('fresh.png'), unread: true }] : [] }
    const { page: family } = page(vi.fn(), fresh)
    const body = option(family, 'Idle')
    expect(body.getAttribute('data-standing')).toBe('turn')
    expect(body.querySelector('.fm-star-fresh')?.getAttribute('d')).not.toBe('')
    expect(family.el.querySelector('[data-standing="new"].fm-star')).toBeNull()
    expect(family.el.querySelector('.ws-family-count[data-standing="new"]')?.textContent).toBe('1 new')
  })
})
