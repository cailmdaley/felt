// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { ThreadIndex } from '../threads.js'
import { THREAD_PIN, type ThreadPinRequest } from '../ThreadPeek.js'
import type { MapFeeds } from '../family/model.js'
import { shouldForwardDocumentKey } from '../keymap.js'
import { FamilyPage } from './FamilyPage.js'

const now = 1_800_000_000_000, hour = 3_600_000
const feeds: MapFeeds = { marks: () => undefined, files: () => [] }
const when = (back: number): string => new Date(now - back * hour).toISOString()
const root = card({ id: 'hub', createdAt: when(300), status: 'active' })
const asked = card({ id: 'hub/q', name: 'Asked', orchestrator: 'hub', status: 'active', createdAt: when(10), ask: { text: 'Which one?', at: when(1) } })
const idle = card({ id: 'hub/w', name: 'Idle', orchestrator: 'hub', status: 'active', createdAt: when(10), workerState: 'running', runtimePhase: 'waiting', lastActivityAt: now - 2 * hour, outcome: 'Needs a look' })
const done = card({ id: 'hub/d', name: 'Done', orchestrator: 'hub', status: 'closed', tempered: true, createdAt: when(50), closedAt: when(5) })
const draft = card({ id: 'hub/draft', name: 'Draft', orchestrator: 'hub', status: 'open', createdAt: when(50) })
const cards = [root, asked, idle, done, draft]

function page(open = vi.fn(), feed = feeds): { page: FamilyPage; open: typeof open } {
  const family = new FamilyPage(open, feed)
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
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals() })

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
  expect(peekName(family)).toBe('Done')
  key_(document.activeElement!, 'ArrowUp')
  key_(document.activeElement!, 'ArrowLeft')
  key_(document.activeElement!, 'ArrowLeft')
  expect(peekName(family)).toBe('Asked')
  key_(document.activeElement!, 'End')
  expect(peekName(family)).toBe(root.name)
  key_(document.activeElement!, 'ArrowDown')
  expect(peekName(family)).toBe(root.name)
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
  const family = new FamilyPage(vi.fn(), feeds), index = new ThreadIndex(cards)
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
