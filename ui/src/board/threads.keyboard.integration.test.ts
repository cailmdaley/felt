// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import { type KanbanResponse } from './KanbanTypes.js'
import { card, response, settle } from './testFixtures.js'
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
const ask = card({ id: 'hub/work', uid: 'ask-uid', orchestrator: 'hub-uid', status: 'active', ask: { text: 'Which cut?', at: '2026-11-15T10:00:00Z' } })
const after = card({ id: 'after', uid: 'after-uid', status: 'active', workerState: 'running', runtimePhase: 'working' })
const data = () => response({ now: { drafts: [], inFlight: [head, after], awaitingReview: [] }, threads: [ask] })
function draw(): void { inside.lastResponse = data(); inside.render(inside.lastResponse) }
function press(key: string, target: EventTarget = document): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}
const selected = () => {
  const el = document.querySelector<HTMLElement>('.kbn-key-selected')
  return el && `${el.dataset.cardUid}${el.hasAttribute('data-desk-line') ? ' line' : ''}`
}
const family = () => document.querySelector<HTMLElement>('.kbn-family[data-card-uid="hub-uid"]')!
beforeEach(() => {
  mobile = false
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) })
  vi.stubGlobal('matchMedia', (query: string) => ({ get matches() { return mobile && query === MOBILE_MEDIA }, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open') } })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes('/channels/dismissed') ? { dismissed: [], reach_ms: 14 * 86_400_000 } : { fibers: [], files: [] }))))
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  window.history.replaceState(null, '', '/'); sessionStorage.clear()
  board = new KanbanModal({ shuttleBase: '' }); inside = board as unknown as Internals
  vi.spyOn(inside, 'startPolling').mockImplementation(() => {})
  vi.spyOn(inside, 'fetchAndRender').mockResolvedValue()
  board.mount(document.body); draw()
})
afterEach(() => { board?.unmount(); document.body.replaceChildren(); Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); Reflect.deleteProperty(HTMLDialogElement.prototype, 'close'); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each(['Enter', 'l', 'ArrowRight'])('%s opens the selected family\'s top-level on the first press', key => {
  const open = vi.spyOn(inside, 'openDocumentChannel').mockImplementation(() => {})
  press('j'); press(key, family())
  expect(open).toHaveBeenCalledExactlyOnceWith(head)
})
it('l opens a selected waiting line\'s constitution, not its family\'s top-level', () => {
  const open = vi.spyOn(inside, 'openDocumentChannel').mockImplementation(() => {})
  press('j'); press('j'); expect(selected()).toBe('ask-uid line')
  press('l')
  expect(open).toHaveBeenCalledExactlyOnceWith(ask)
})
it.each([false, true])('the state dot opens the top-level once on phone=%s, and a click on a line opens its member', phone => {
  mobile = phone; draw()
  const open = vi.spyOn(inside, 'openDocumentChannel').mockImplementation(() => {})
  family().querySelector<HTMLButtonElement>('.kbn-family-head .constitution-state-dot')!.click()
  expect(open).toHaveBeenCalledExactlyOnceWith(head)
  family().querySelector<HTMLElement>('.kbn-family-want')!.click()
  expect(open).toHaveBeenLastCalledWith(ask)
  family().querySelector<HTMLElement>('.kbn-family-name')!.click()
  expect(open).toHaveBeenLastCalledWith(head)
})
it('j and k walk cards and their waiting lines across the columns; h and Escape clear the selection', () => {
  press('j'); expect(selected()).toBe('hub-uid')
  press('j'); expect(selected()).toBe('ask-uid line')
  press('j'); expect(selected()).toBe('after-uid')
  press('k'); expect(selected()).toBe('ask-uid line')
  press('ArrowLeft'); expect(selected()).toBeNull()
  press('j'); expect(selected()).toBe('hub-uid')
  press('Escape'); expect(selected()).toBeNull()
})
it('comes back from a waiting line\'s view to that line, and walks on from it', async () => {
  press('j'); press('j'); expect(selected()).toBe('ask-uid line')
  press('l')
  await settle()
  expect(inside.workspace.isActive).toBe(true)
  await new Promise<void>(resolve => { window.addEventListener('popstate', () => resolve(), { once: true }); press('Escape') })
  expect(inside.workspace.isActive).toBe(false)
  expect(selected()).toBe('ask-uid line')
  press('j'); expect(selected()).toBe('after-uid')
})
it('a poll keeps the selected line', () => {
  press('j'); press('j'); draw()
  expect(selected()).toBe('ask-uid line')
  expect(document.querySelectorAll('.kbn-key-selected')).toHaveLength(1)
  press('j'); expect(selected()).toBe('after-uid')
})
it('the Desk has no context menu and nothing to drag', () => {
  const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  family().dispatchEvent(menu)
  expect(menu.defaultPrevented).toBe(false)
  expect(document.querySelector('.kbn-desk [draggable="true"]')).toBeNull()
  expect(document.querySelector('[role="menu"]')).toBeNull()
})
