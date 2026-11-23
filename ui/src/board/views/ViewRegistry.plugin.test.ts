// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KanbanModal } from '../KanbanModal.js'
import type { KanbanResponse } from '../KanbanTypes.js'
import { card, response, settle } from '../testFixtures.js'
import { MOBILE_MEDIA } from '../mobile.js'
import { getView, listViews, registerView, unregisterView, viewForHotkey, viewHotkeys, type BoardViewPlugin, type ViewContext } from './index.js'

interface BoardInternals {
  render(data: KanbanResponse): void
  lastResponse: KanbanResponse | null
  startPolling(): void
  fetchAndRender(): Promise<void>
}

/** A third view, as a plugin would write one: it records its lifecycle. */
function plugin(patch: Partial<BoardViewPlugin> = {}) {
  const calls: string[] = []
  let host: HTMLElement | null = null
  const view: BoardViewPlugin = {
    id: 'ledger',
    title: 'Ledger',
    mount(into: HTMLElement, ctx: ViewContext) {
      host = into
      calls.push(`mount:${ctx.cards.length}`)
      into.append(Object.assign(document.createElement('p'), { className: 'ledger-page', textContent: `${ctx.cards.length} cards` }))
    },
    refresh(ctx: ViewContext) {
      calls.push(`refresh:${ctx.cards.length}`)
      host!.querySelector('.ledger-page')!.textContent = `${ctx.cards.length} cards`
    },
    unmount() { calls.push('unmount') },
    ...patch,
  }
  return { view, calls }
}

let board: KanbanModal
let inside: BoardInternals
const data = (n: number) => response({ now: { drafts: Array.from({ length: n }, (_, i) => card({ id: `d${i}` })), inFlight: [], awaitingReview: [] } })
const draw = (value: KanbanResponse): void => { inside.lastResponse = value; inside.render(value) }
const press = (key: string): void => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) }
const tabs = (): Array<[string | undefined, string | null | undefined]> =>
  [...document.querySelectorAll<HTMLElement>('.kbn-viewtab')].map(tab => [tab.dataset.view, tab.querySelector('.kbn-viewtab-hotkey')?.textContent])
const active = (): string | undefined => document.querySelector<HTMLElement>('.kbn-viewtab-active')?.dataset.view
/** The mounts and unmounts among a view's calls; refreshes come whenever the board redraws, on any poll. */
const lifecycle = (calls: string[]): string[] => calls.filter(call => !call.startsWith('refresh'))

beforeEach(() => {
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key), clear: () => stored.clear(), key: () => null, length: 0 })
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === MOBILE_MEDIA ? false : false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ fibers: [], files: [], held: [], dismissed: [], reach_ms: 14 * 86_400_000 }))))
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  window.history.replaceState(null, '', '/')
  board = new KanbanModal({ shuttleBase: '' })
  inside = board as unknown as BoardInternals
  vi.spyOn(inside, 'startPolling').mockImplementation(() => {})
  vi.spyOn(inside, 'fetchAndRender').mockResolvedValue()
})
afterEach(() => {
  unregisterView('ledger')
  unregisterView('archive')
  board?.unmount()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('gives each view the next free digit after the board’s own, and its own key when it names one', () => {
  const { view } = plugin()
  registerView(view)
  expect(viewHotkeys().map(({ view, hotkey }) => [view.id, hotkey])).toEqual([['channels', '2'], ['ledger', '3']])
  registerView(plugin({ id: 'archive', title: 'Archive', hotkey: '9' }).view)
  expect(viewForHotkey('9')?.id).toBe('archive')
  expect(viewForHotkey('3')?.id).toBe('ledger')
  expect(() => registerView(plugin({ id: 'desk' }).view)).toThrow(/desk/)
})

it('plugs a third view into the board: its tab and hotkey, mounting, refreshing and unmounting, then leaves cleanly', async () => {
  board.mount(document.body)
  draw(data(2))
  await settle()
  expect(tabs()).toEqual([['desk', '1'], ['channels', '2']])

  const { view, calls } = plugin()
  registerView(view)
  await settle()
  expect(tabs()).toEqual([['desk', '1'], ['channels', '2'], ['ledger', '3']])
  expect(document.querySelector('.kbn-viewtab[data-view="ledger"]')!.getAttribute('title')).toBe('ledger (3)')

  press('3')
  expect(active()).toBe('ledger')
  expect(lifecycle(calls)).toEqual(['mount:2'])
  expect(document.querySelector('.ledger-page')!.textContent).toBe('2 cards')

  draw(data(3))
  expect(calls.at(-1)).toBe('refresh:3')
  expect(document.querySelector('.ledger-page')!.textContent).toBe('3 cards')

  press('1')
  expect(active()).toBe('desk')
  expect(lifecycle(calls)).toEqual(['mount:2', 'unmount'])
  expect(document.querySelector('.ledger-page')).toBeNull()

  document.querySelector<HTMLButtonElement>('.kbn-viewtab[data-view="ledger"]')!.click()
  expect(active()).toBe('ledger')
  expect(lifecycle(calls)).toEqual(['mount:2', 'unmount', 'mount:3'])

  // Taken out while it is up: its tab and key go, and the board goes home.
  expect(unregisterView('ledger')).toBe(true)
  await settle()
  expect(calls.at(-1)).toBe('unmount')
  expect(active()).toBe('desk')
  expect(tabs()).toEqual([['desk', '1'], ['channels', '2']])
  expect(getView('ledger')).toBeUndefined()
  expect(unregisterView('ledger')).toBe(false)
  press('3')
  expect(active()).toBe('desk')
  expect(listViews().map(each => each.id)).toEqual(['channels'])
})

it('keeps Channels on 2 and an optional view off the strip but on its key', async () => {
  board.mount(document.body)
  draw(data(1))
  registerView(plugin({ optional: true }).view)
  await settle()
  expect(tabs()).toEqual([['desk', '1'], ['channels', '2']])
  press('2')
  expect(active()).toBe('channels')
  press('3')
  expect(document.querySelector('.ledger-page')!.textContent).toBe('1 cards')
  press('1')
  expect(active()).toBe('desk')
})

it('replaces a view registered again under its id, unmounting the old one', async () => {
  board.mount(document.body)
  draw(data(1))
  const first = plugin()
  registerView(first.view)
  press('3')
  const second = plugin({ title: 'Ledger two' })
  registerView(second.view)
  await settle()
  expect(lifecycle(first.calls)).toEqual(['mount:1', 'unmount'])
  expect(lifecycle(second.calls)).toEqual(['mount:1'])
  expect(tabs().map(([id]) => id)).toEqual(['desk', 'channels', 'ledger'])
})
