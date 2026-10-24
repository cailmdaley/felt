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
const ask = card({ id: 'hub/ask', uid: 'ask-uid', orchestrator: 'hub-uid', status: 'active', ask: { text: 'Which cut?', at: '2026-07-02T12:00:00Z' }, tags: ['pinned'] })
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
  const stored = new Map<string, string>([['shuttle:workspace:rail', 'false']])
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

it('Enter opens the selected constitution on the first press, never a family', () => {
  const open = vi.spyOn(inside, 'openDocumentChannel').mockImplementation(() => {})
  press('j'); press('Enter', row())
  expect(open).toHaveBeenCalledExactlyOnceWith(head)
  expect(row().querySelector('.kbn-thread-peek')).toBeNull()
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
  press('ArrowRight'); expect(selected()).toBe('hub-uid')
  press('ArrowLeft'); expect(selected()).toBe('hub-uid')
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
it('Tab reaches the count and action menu without hidden family stops', () => {
  press('j'); row().focus(); press('Tab', row())
  expect(document.activeElement).toBe(row().querySelector('.constitution-state-dot'))
  press('Tab', document.activeElement!)
  expect(document.activeElement).toBe(row().querySelector('.kbn-thread-count'))
  press('Tab', document.activeElement!)
  expect(document.activeElement).toBe(row().querySelector('.kbn-card-menu'))
})
it('the count opens the constitution with the rail forced for only that visit, preserving the saved closed choice', async () => {
  row().querySelector<HTMLButtonElement>('.kbn-thread-count')!.click()
  await vi.waitFor(() => expect(inside.workspace.isActive).toBe(true))
  const reader = inside.workspace.reader as unknown as { railOpen: boolean; hide(): void }
  expect(reader.railOpen).toBe(true)
  expect(localStorage.getItem('shuttle:workspace:rail')).toBe('false')
  // A repaint during the same visit must not lose the override.
  draw(); expect(reader.railOpen).toBe(true)
  inside.workspace.returnToOrigin()
  inside.openDocumentChannel(head)
  expect(reader.railOpen).toBe(false)
  expect(localStorage.getItem('shuttle:workspace:rail')).toBe('false')
})
it('the phone count opens the existing threads sheet once, not again after dismissal and a refresh', async () => {
  mobile = true; draw()
  row().querySelector<HTMLButtonElement>('.kbn-thread-count')!.click()
  await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>('.ws-page-sheet')?.open).toBe(true))
  const reader = inside.workspace.reader as unknown as { phoneRailPending: boolean; pageSheet: { hide(): void } }
  expect(reader.phoneRailPending).toBe(false)
  reader.pageSheet.hide()
  expect(document.querySelector<HTMLDialogElement>('.ws-page-sheet')?.open).toBe(false)
  draw()
  expect(document.querySelector<HTMLDialogElement>('.ws-page-sheet')?.open).toBe(false)
  expect(localStorage.getItem('shuttle:workspace:rail')).toBe('false')
})
