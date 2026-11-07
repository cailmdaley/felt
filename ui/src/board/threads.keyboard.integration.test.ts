// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import { type KanbanResponse } from './KanbanTypes.js'
import { card, response } from './testFixtures.js'
import type { Workspace } from './workspace/Workspace.js'
import { MOBILE_MEDIA } from './mobile.js'

interface Internals {
  render(data: KanbanResponse): void
  lastResponse: KanbanResponse | null
  startPolling(): void
  fetchAndRender(): Promise<void>
  workspace: Workspace
  openDocumentChannel(card: typeof head): void
}
let board: KanbanModal, inside: Internals
let mobile = false
const head = card({ id: 'hub', uid: 'hub-uid', status: 'active', workerState: 'running', runtimePhase: 'working' })
const ask = card({ id: 'hub/work', uid: 'ask-uid', orchestrator: 'hub-uid', status: 'active', workerState: 'running', runtimePhase: 'working', tags: ['pinned'] })
const after = card({ id: 'after', uid: 'after-uid', status: 'active', workerState: 'running', runtimePhase: 'working' })
const data = () => response({ now: { drafts: [], inFlight: [head, after], awaitingReview: [] }, threads: [ask] })
function draw(): void { inside.lastResponse = data(); inside.render(inside.lastResponse) }
function press(key: string, target: EventTarget = document): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}
const selected = () => document.querySelector<HTMLElement>('.kbn-key-selected')?.dataset.cardUid
const row = () => document.querySelector<HTMLElement>('.kbn-card[data-card-uid="hub-uid"]')!
beforeEach(() => {
  mobile = false
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) })
  vi.stubGlobal('matchMedia', (query: string) => ({ get matches() { return mobile && query === MOBILE_MEDIA }, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open') } })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ fibers: [], files: [] }))))
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  window.history.replaceState(null, '', '/'); sessionStorage.clear()
  board = new KanbanModal({ shuttleBase: '' }); inside = board as unknown as Internals
  vi.spyOn(inside, 'startPolling').mockImplementation(() => {})
  vi.spyOn(inside, 'fetchAndRender').mockResolvedValue()
  board.mount(document.body); draw()
})
afterEach(() => { board?.unmount(); document.body.replaceChildren(); Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); Reflect.deleteProperty(HTMLDialogElement.prototype, 'close'); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each(['Enter', 'l', 'ArrowRight'])('%s opens the selected constitution on the first press', key => {
  const open = vi.spyOn(inside, 'openDocumentChannel').mockImplementation(() => {})
  press('j'); press(key, row())
  expect(open).toHaveBeenCalledExactlyOnceWith(head)
  expect(row().querySelector('.kbn-thread-peek')).toBeNull()
})
it('l opens a selected nested thread, not its family root', () => {
  const open = vi.spyOn(inside, 'openDocumentChannel').mockImplementation(() => {})
  row().querySelector<HTMLButtonElement>('.kbn-thread-count')!.click()
  press('j'); expect(selected()).toBe('ask-uid')
  press('l')
  expect(open).toHaveBeenCalledExactlyOnceWith(ask)
})
it.each([false, true])('the state dot opens the constitution once on phone=%s, without pills or glyphs', phone => {
  mobile = phone; draw()
  const open = vi.spyOn(inside, 'openDocumentChannel').mockImplementation(() => {})
  row().querySelector<HTMLButtonElement>('.constitution-state-dot')!.click()
  expect(open).toHaveBeenCalledExactlyOnceWith(head)
  expect(row().querySelector('.kbn-card-worker, .kbn-card-glyph')).toBeNull()
})
it('arrows navigate and Escape clears selection without family state', () => {
  press('j'); expect(selected()).toBe('hub-uid')
  press('j'); expect(selected()).toBe('after-uid')
  press('k'); expect(selected()).toBe('hub-uid')
  press('ArrowLeft'); expect(selected()).toBeUndefined()
  press('j'); expect(selected()).toBe('hub-uid')
  press('Escape'); expect(selected()).toBeUndefined()
  expect(document.querySelector('.kbn-thread-peek, .kbn-thread-subentries')).toBeNull()
})
it('a poll preserves card selection without exposing pinned or waiting subentries', () => {
  press('j'); draw()
  expect(selected()).toBe('hub-uid')
  expect(document.querySelectorAll('.kbn-key-selected')).toHaveLength(1)
  expect(document.querySelector('[data-card-uid="ask-uid"]')).toBeNull()
  press('j'); expect(selected()).toBe('after-uid')
})
it('Tab reaches the dot and the count, with no menu control and no hidden family stops', () => {
  press('j'); row().focus(); press('Tab', row())
  expect(document.activeElement).toBe(row().querySelector('.constitution-state-dot'))
  press('Tab', document.activeElement!)
  expect(document.activeElement).toBe(row().querySelector('.kbn-thread-count'))
  expect(row().querySelector('.kbn-card-menu')).toBeNull()
})
it.each([false, true])('the count folds the family\'s threads open and shut, remembered across polls, on phone=%s', phone => {
  mobile = phone; draw()
  const shown = () => [...row().querySelectorAll<HTMLElement>('.kbn-desk-threads .kbn-thread-row')].map(r => r.dataset.cardUid)
  expect(shown()).toEqual([])
  row().querySelector<HTMLButtonElement>('.kbn-thread-count')!.click()
  expect(shown()).toEqual(['ask-uid'])
  expect(inside.workspace.isActive).toBe(false)
  draw()
  expect(shown()).toEqual(['ask-uid'])
  expect(selected()).toBe('hub-uid'); press('j'); expect(selected()).toBe('ask-uid')
  row().querySelector<HTMLButtonElement>('.kbn-thread-count')!.click()
  expect(shown()).toEqual([])
})
