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
})

it('refuses an id the board cannot address, and a hotkey that is not a view’s', () => {
  for (const id of ['', ' ', 'my view', ' ledger', 'a/b', 'a#b', 'a%20b', 'desk', 'Desk', 'board', 'chronicle', 'globe']) {
    expect(() => registerView(plugin({ id }).view), id).toThrow(/id|address/)
    expect(getView(id), id).toBeUndefined()
  }
  for (const hotkey of ['', '1', '0', 'j', 'k', 't', '/', 'c', 'e', ',', '22']) expect(() => registerView(plugin({ hotkey }).view), hotkey).toThrow(/hotkey/)
  expect(getView('ledger')).toBeUndefined()
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
  expect(window.location.hash).toBe('#/desk')
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

/** The board with the ledger up and a constitution of it open in the reader. */
async function readingFromLedger(title = 'Ledger') {
  board.mount(document.body)
  draw(data(2))
  const { view, calls } = plugin({ title })
  registerView(view)
  press('3')
  expect(window.location.hash).toBe('#/ledger')
  const workspace = (board as unknown as { workspace: { open(target: ReturnType<typeof card>): void; returnToOrigin(): void; isActive: boolean } }).workspace
  workspace.open(inside.lastResponse!.now.drafts[0])
  await settle()
  expect(workspace.isActive).toBe(true)
  return { workspace, calls, view }
}
/** jsdom lands a back over a few timer turns. */
const landed = async (): Promise<void> => { for (let turn = 0; turn < 6; turn++) { await new Promise(resolve => setTimeout(resolve, 0)); await settle() } }
const backLabel = (): string | null | undefined => document.querySelector('.ws-return')?.getAttribute('aria-label') ?? document.querySelector('.ws-return')?.textContent

it('goes back to the Desk from a reader whose view was unregistered under it, by its back or the browser’s', async () => {
  for (const back of ['reader', 'browser'] as const) {
    const { workspace } = await readingFromLedger()
    expect(backLabel()).toMatch(/Ledger/)
    unregisterView('ledger')
    expect(workspace.isActive).toBe(true)
    expect(backLabel()).toMatch(/Desk/)
    if (back === 'reader') workspace.returnToOrigin()
    else window.history.back()
    await landed()
    expect(workspace.isActive).toBe(false)
    expect(active()).toBe('desk')
    expect(document.querySelector<HTMLElement>('.kbn-desk')!.style.display).toBe('')
    expect(document.querySelector<HTMLElement>('.kbn-view-host')!.style.display).toBe('none')
    expect(window.location.hash).toBe('#/desk')
    board.unmount()
    window.history.pushState(null, '', '/')
  }
})

it('lands on the Desk from an address no view answers to', async () => {
  board.mount(document.body)
  draw(data(1))
  press('2')
  window.location.hash = '#/nowhere'
  await landed()
  expect(active()).toBe('desk')
  expect(window.location.hash).toBe('#/desk')
})

it('goes back to the view the reader was opened from when two views share a title', async () => {
  registerView(plugin({ id: 'archive', title: 'Ledger', hotkey: '9' }).view)
  const { workspace } = await readingFromLedger()
  workspace.returnToOrigin()
  await landed()
  expect(active()).toBe('ledger')
  expect(window.location.hash).toBe('#/ledger')
})

it('leaves a digit to whatever takes text, and to an input method composing', () => {
  board.mount(document.body)
  draw(data(1))
  const box = document.body.appendChild(document.createElement('div'))
  box.setAttribute('role', 'textbox')
  box.tabIndex = 0
  box.focus()
  box.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }))
  expect(active()).toBe('desk')
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '2', keyCode: 229, bubbles: true, cancelable: true }))
  expect(active()).toBe('desk')
  press('2')
  expect(active()).toBe('channels')
})

it('keeps the focused tab through a registration, and hands the focus of one that leaves to the selected tab', async () => {
  board.mount(document.body)
  draw(data(1))
  await settle()
  const tab = (id: string): HTMLElement => document.querySelector<HTMLElement>(`.kbn-viewtab[data-view="${id}"]`)!
  const channels = tab('channels')
  channels.focus()
  registerView(plugin().view)
  await settle()
  expect(document.activeElement).toBe(channels)
  expect(tab('channels')).toBe(channels)
  tab('ledger').focus()
  unregisterView('ledger')
  await settle()
  expect(document.activeElement).toBe(tab('desk'))
})
