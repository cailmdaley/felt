// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import { type KanbanResponse } from './KanbanTypes.js'
import { card, response } from './testFixtures.js'
import type { Workspace } from './workspace/Workspace.js'
import { MOBILE_MEDIA } from './mobile.js'
import { ThreadIndex } from './threads.js'
import { saveWaitingThreadEntries } from './threadPreferences.js'

interface BoardInternals {
  render(data: KanbanResponse): void
  lastResponse: KanbanResponse | null
  startPolling(): void
  fetchAndRender(): Promise<void>
  workspace: Workspace
  deskEl: HTMLElement
  cardPreview: import('./CardPreview.js').CardPreview
  lensCycleId: string | null
  workspaceColumn(card: typeof head): Array<{ card: typeof head }>
  setView(view: 'desk' | 'chronicle'): void
  openDocumentChannel(card: typeof head): void
}
let board: KanbanModal
let inside: BoardInternals
let mobile = false
let reduced = false
const scroll = vi.fn()
const intoView = vi.fn()
const settings = vi.fn()
const head = card({ id: 'hub', uid: 'hub-uid', status: 'active', workerState: 'running', runtimePhase: 'working' })
const ask = card({ id: 'hub/ask', uid: 'ask-uid', orchestrator: 'hub-uid', status: 'active', ask: { text: 'Which cut?', at: '2026-07-02T12:00:00Z' } })
const work = card({ id: 'hub/work', uid: 'work-uid', orchestrator: 'hub-uid', status: 'active' })
const after = card({ id: 'after', uid: 'after-uid', status: 'active', workerState: 'running', runtimePhase: 'working' })
head.threadSummary = new ThreadIndex([head, ask, work]).summary(head)
const data = () => response({ now: { drafts: [], inFlight: [head, after], awaitingReview: [] }, threads: [ask, work] })
function draw(value: KanbanResponse): void { inside.lastResponse = value; inside.render(value) }
function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}
function selected(): string | undefined { return document.querySelector<HTMLElement>('.kbn-key-selected')?.dataset.cardUid }

beforeEach(() => {
  mobile = false; reduced = false
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), clear: () => stored.clear() })
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === MOBILE_MEDIA ? mobile : query.includes('reduced-motion') ? reduced : false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ fibers: [], files: [] }))))
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scroll })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: intoView })
  window.history.replaceState(null, '', '/')
  localStorage.clear(); sessionStorage.clear(); settings.mockClear(); intoView.mockClear(); scroll.mockClear()
  board = new KanbanModal({ shuttleBase: '', onSettingsClick: settings })
  inside = board as unknown as BoardInternals
  vi.spyOn(inside, 'startPolling').mockImplementation(() => {})
  vi.spyOn(inside, 'fetchAndRender').mockResolvedValue()
  board.mount(document.body)
  saveWaitingThreadEntries(false)
  draw(data())
})
afterEach(() => { board?.unmount(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const family = () => document.querySelector<HTMLElement>('.kbn-card[data-card-uid="hub-uid"]')!
const badge = () => family().querySelector<HTMLButtonElement>('.kbn-thread-badge')!
const peek = () => family().querySelector<HTMLElement>('.kbn-thread-peek')!

describe('thread rows on the Desk keyboard', () => {
  it('rows carry the card identity the Desk traverses, and only expanded rows are stops', () => {
    const rows = [...peek().querySelectorAll<HTMLElement>('.kbn-thread-row')]
    expect(rows.map(r => [r.dataset.cardUid, r.dataset.cardOrigin])).toEqual([['ask-uid', 'local'], ['work-uid', 'local']])
    press('j')
    expect(selected()).toBe('hub-uid')
    press('j')
    expect(selected()).toBe('after-uid')
    press('k')
    badge().click()
    expect(peek().hidden).toBe(false)
    press('j')
    expect(selected()).toBe('ask-uid')
    press('j')
    expect(selected()).toBe('work-uid')
    press('j')
    expect(selected()).toBe('after-uid')
  })
  it('Tab walks from the family card to its badge and expanded rows, then back out to the columns', () => {
    const el = family(); el.tabIndex = -1; el.focus()
    expect(press('Tab', {}, el).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(badge())
    // Collapsed, the badge is the family's last stop: Tab falls through to the
    // Desk's column order (whose heads jsdom cannot lay out, so it stays put).
    expect(press('Tab', {}, badge()).defaultPrevented).toBe(false)
    badge().focus(); badge().click()
    press('Tab', {}, badge())
    expect((document.activeElement as HTMLElement).dataset.cardUid).toBe('ask-uid')
    press('Tab', { shiftKey: true }, document.activeElement!)
    expect(document.activeElement).toBe(badge())
    press('Tab', { shiftKey: true }, badge())
    expect(document.activeElement).toBe(family())
  })
  it('Escape collapses an expanded family before it clears the selection', () => {
    press('j')
    expect(selected()).toBe('hub-uid')
    badge().click()
    press('j')
    expect(selected()).toBe('ask-uid')
    const row = document.activeElement as HTMLElement
    expect(row.dataset.cardUid).toBe('ask-uid')
    press('Escape', {}, row)
    expect(peek().hidden).toBe(true)
    expect(document.activeElement).toBe(badge())
    expect(selected()).toBe('hub-uid')
    press('Escape', {}, badge())
    expect(selected()).toBeUndefined()
  })
})

describe('opening a family from the keyboard', () => {
  for (const [open, fold] of [['Enter', 'Escape'], ['ArrowRight', 'ArrowLeft']] as const) {
    it(`${open} on the selected card opens its family, which stays open; ${fold} folds it back to the card`, () => {
      press('j')
      expect(selected()).toBe('hub-uid')
      press(open, {}, family())
      expect(peek().hidden).toBe(false)
      expect(selected()).toBe('hub-uid')
      draw(data())
      expect(peek().hidden).toBe(false)
      press('j')
      expect(selected()).toBe('ask-uid')
      press(fold, {}, document.activeElement!)
      expect(peek().hidden).toBe(true)
      expect(selected()).toBe('hub-uid')
    })
  }
  it('with the family open, Enter opens the constitution and → moves to the next column', () => {
    const open = vi.spyOn(inside as unknown as { openDocumentChannel(card: unknown): void }, 'openDocumentChannel').mockImplementation(() => {})
    press('j')
    press('Enter', {}, family())
    expect(open).not.toHaveBeenCalled()
    press('Enter', {}, family())
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'hub' }))
  })
  it('o opens the constitution while its family stays folded', () => {
    const open = vi.spyOn(inside as unknown as { openDocumentChannel(card: unknown): void }, 'openDocumentChannel').mockImplementation(() => {})
    press('j')
    press('o', {}, family())
    expect(peek().hidden).toBe(true)
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'hub' }))
  })
})

describe('thread families across Desk repaints', () => {
  it('an expanded family stays expanded through a poll', () => {
    badge().click()
    draw(data())
    expect(peek().hidden).toBe(false)
    expect(badge().getAttribute('aria-expanded')).toBe('true')
    badge().click()
    draw(data())
    expect(peek().hidden).toBe(true)
  })
  it('focus on a thread row or the badge returns to the same control', () => {
    badge().click()
    peek().querySelector<HTMLElement>('[data-card-uid="work-uid"]')!.focus()
    draw(data())
    const active = document.activeElement as HTMLElement
    expect(active.isConnected).toBe(true)
    expect(active.dataset.cardUid).toBe('work-uid')
    expect(peek().contains(active)).toBe(true)
    badge().focus()
    draw(data())
    expect(document.activeElement).toBe(badge())
  })
})

describe('the keyboard selection on a sub-entry', () => {
  it('stays drawn on a visible row in an open family through a poll', () => {
    saveWaitingThreadEntries(true)
    draw(data())
    badge().click()
    expect(peek().hidden).toBe(false)
    expect(selected()).toBe('hub-uid')
    press('j')
    expect(selected()).toBe('ask-uid')
    const sel = () => document.querySelector<HTMLElement>('.kbn-key-selected')!
    // Opened, the tree draws the thread where it hangs; the sub-entries fold away.
    expect(sel().closest('.kbn-thread-peek')).not.toBeNull()
    draw(data())
    expect(document.querySelectorAll('.kbn-key-selected')).toHaveLength(1)
    expect(sel().dataset.cardUid).toBe('ask-uid')
    expect(sel().closest('[hidden]')).toBeNull()
    press('j')
    expect(selected()).toBe('work-uid')
    expect(sel().closest('[hidden]')).toBeNull()
  })
})

describe('pinning a thread from the Desk', () => {
  afterEach(() => { for (const c of [ask, work]) delete c.tags })
  const entries = () => [...family().querySelectorAll('.kbn-thread-subentries .kbn-thread-row')].map(r => (r as HTMLElement).dataset.cardUid)
  const edits = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/api/v1/felt-edit')).map(([, init]) => JSON.parse(String(init?.body)))
  it('p on a selected thread row pins it under its card, through felt-edit; p again unpins it', async () => {
    expect(entries()).toEqual([])
    badge().click()
    press('j'); press('j')
    expect(selected()).toBe('work-uid')
    press('p')
    expect(entries()).toEqual(['work-uid'])
    await vi.waitFor(() => expect(edits()).toEqual([{ fiber_id: 'hub/work', origin: 'local', add: ['pinned'] }]))
    draw(data())
    expect(entries()).toEqual(['work-uid'])
    expect(selected()).toBe('work-uid')
    press('p')
    expect(entries()).toEqual([])
    await vi.waitFor(() => expect(edits()).toHaveLength(2))
    expect(edits()[1]).toEqual({ fiber_id: 'hub/work', origin: 'local', remove: ['pinned'] })
  })
  it('a refused pin is undone on the Desk', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => String(url).endsWith('/api/v1/felt-edit') ? new Response('no such fiber', { status: 500 }) : new Response(JSON.stringify({ fibers: [], files: [] })))
    badge().click()
    press('j'); press('j')
    press('p')
    expect(entries()).toEqual(['work-uid'])
    await vi.waitFor(() => expect(entries()).toEqual([]))
  })
})
