// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import { type KanbanResponse } from './KanbanTypes.js'
import { card, response } from './testFixtures.js'
import type { Workspace } from './workspace/Workspace.js'
import { MOBILE_MEDIA } from './mobile.js'

interface BoardInternals {
  render(data: KanbanResponse): void
  lastResponse: KanbanResponse | null
  startPolling(): void
  fetchAndRender(): Promise<void>
  workspace: Workspace
  deskEl: HTMLElement
  lensCycleId: string | null
  workspaceColumn(card: typeof head): Array<{ card: typeof head }>
}
let board: KanbanModal
let inside: BoardInternals
let mobile = false
let reduced = false
const scroll = vi.fn()
const intoView = vi.fn()
const settings = vi.fn()
const head = card({ id: 'head', uid: 'head-uid', status: 'active', runtimePhase: 'waiting' })
const child = card({ id: 'child', uid: 'child-uid', dependsOn: ['head'], foldedUnder: 'head' })
const data = () => response({
  now: {
    drafts: [card({ id: 'd1', uid: 'draft-uid' }), card({ id: 'd2' })],
    inFlight: [head, card({ id: 'working', status: 'active', runtimePhase: 'working' })],
    awaitingReview: [card({ id: 'review', status: 'closed' })],
  },
  folded: [child], pinned: [card({ id: 'pinned', shuttleKind: 'pinned' })],
  stash: [card({ id: 'resting', effectiveHorizon: 'stashed' })],
})
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
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
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
  draw(data())
})
afterEach(() => { board?.unmount(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Desk keyboard selection', () => {
  it('gives Escape in the bar\'s Find to the field before releasing an engaged lens', () => {
    inside.lensCycleId = 'season'
    const find = document.querySelector<HTMLInputElement>('.kbn-viewtabs-find input')!
    find.focus(); find.value = 'mask'
    press('Escape', {}, find)
    expect(inside.lensCycleId).toBe('season')
    expect(find.value).toBe('')
    expect(document.activeElement).not.toBe(find)
  })
  it('leaves initial focus alone and selects the top review card with the first j or k', () => {
    expect(document.activeElement).not.toBe(document.querySelector('.kbn-col-head'))
    expect(selected()).toBeUndefined()
    press('j'); expect(selected()).toBe('review')
    press('u')
    press('k'); expect(selected()).toBe('review')
  })
  it('opens Find over Desk without entering Reader until a match is selected', () => {
    const previous = document.createElement('button')
    inside.deskEl.append(previous); previous.focus()
    const route = window.location.hash
    expect(press('/').defaultPrevented).toBe(true)
    expect(inside.workspace.isActive).toBe(false)
    expect(window.location.hash).toBe(route)
    const find = document.querySelector<HTMLInputElement>('.ws-switcher input')!
    expect(document.activeElement).toBe(find)
    press('Escape', {}, find)
    expect(document.activeElement).toBe(previous)
    press('/')
    const input = document.querySelector<HTMLInputElement>('.ws-switcher input')!
    input.value = 'd1'; input.dispatchEvent(new Event('input'))
    press('Enter', {}, input)
    expect(inside.workspace.isActive).toBe(true)
    expect(window.location.hash).toContain('draft-uid')
  })
  it('uses a visible existing card filter and leaves slash literal in fields', () => {
    const input = document.createElement('input'); input.type = 'search'
    inside.deskEl.append(input)
    vi.spyOn(input, 'getClientRects').mockReturnValue([{ width: 100 }] as unknown as DOMRectList)
    press('/')
    expect(document.activeElement).toBe(input)
    expect(document.querySelector('.ws-switcher')).toBeNull()
    expect(press('/', {}, input).defaultPrevented).toBe(false)
  })
  it('moves through both flight bands, the three columns, Pinned and Resting without wrapping', () => {
    press('j'); expect(selected()).toBe('review')
    press('h'); expect(selected()).toBe('head-uid')
    press('j'); expect(selected()).toBe('working')
    press('j'); expect(selected()).toBe('working')
    press('g'); expect(selected()).toBe('head-uid')
    press('G'); expect(selected()).toBe('working')
    press('ArrowRight'); expect(selected()).toBe('review')
    press('l'); expect(selected()).toBe('pinned')
    press('l'); expect(selected()).toBe('resting')
    press('l'); expect(selected()).toBe('resting')
    press('h'); expect(selected()).toBe('pinned')
    press('u'); expect(selected()).toBe('pinned')
    press('Escape'); expect(selected()).toBeUndefined()
  })
  it('treats a folded queue as one stop and expanded members as stops', () => {
    press('j'); press('h'); press('j'); expect(selected()).toBe('working')
    press('k')
    document.querySelector<HTMLElement>('[data-fiber-id="head"] .kbn-card-queued')!.click()
    press('j'); expect(selected()).toBe('child-uid')
    press('j'); expect(selected()).toBe('working')
    press('k'); press('Enter')
    expect(window.location.hash).toContain('child-uid')
  })
  it('opens the reader on one grouped sidebar, and keeps the flight column for the cards that fly', () => {
    press('j'); press('h'); press('Enter')
    expect([...document.querySelectorAll<HTMLElement>('.ws-sidebar .ws-channel-row')].map(el => el.dataset.channelUid)).toEqual(['review', 'head-uid', 'working'])
    expect([...document.querySelectorAll('.ws-sidebar .kbn-flight-caption')].map(el => el.textContent)).toEqual(['Awaiting review', 'Needs you', 'Working'])
    document.querySelector<HTMLButtonElement>('.ws-return')!.click()
    document.querySelector<HTMLElement>('[data-fiber-id="head"] .kbn-card-queued')!.click()
    expect(document.querySelector<HTMLElement>('[data-fiber-id="head"] .kbn-card-queued-list')!.hidden).toBe(false)
    expect(inside.workspace.isActive).toBe(false)
    expect(inside.workspaceColumn(head).map(entry => entry.card.uid ?? entry.card.id)).toEqual(['head-uid', 'child-uid', 'working'])
  })
  it('keeps the grouped sidebar whether or not a queue is expanded on the Desk', () => {
    press('j'); press('h')
    document.querySelector<HTMLElement>('[data-fiber-id="head"] .kbn-card-queued')!.click()
    press('Enter')
    expect([...document.querySelectorAll<HTMLElement>('.ws-sidebar .ws-channel-row')].map(el => el.dataset.channelUid)).toEqual(['review', 'head-uid', 'working'])
  })
  it('survives refresh reorder and a path rename by uid+origin, not list position', () => {
    press('j'); press('h'); press('h')
    const updated = data()
    updated.now.drafts = [card({ id: 'd2' }), card({ id: 'renamed', uid: 'draft-uid' })]
    draw(updated)
    expect(selected()).toBe('draft-uid')
    expect(document.querySelector<HTMLElement>('.kbn-key-selected')?.dataset.fiberId).toBe('renamed')
    press('k'); expect(selected()).toBe('d2')
  })
  it('opens with Enter and restores the opened card after reader return and a deferred refresh', () => {
    press('j'); press('h'); press('h'); press('j'); press('Enter')
    expect(inside.workspace.isActive).toBe(true)
    expect(window.location.hash).toContain('d2')
    const updated = data()
    updated.now.drafts.reverse()
    inside.render(updated)
    document.querySelector<HTMLButtonElement>('.ws-return')!.click()
    expect(inside.workspace.isActive).toBe(false)
    expect(selected()).toBe('d2')
    const restored = document.querySelector<HTMLElement>('.kbn-key-selected')!
    expect(restored.tabIndex).toBe(-1)
    expect(document.activeElement).toBe(restored)
    press('j'); expect(selected()).toBe('draft-uid')
  })
  it('selects clicked cards and distinguishes identical uids on different origins', () => {
    const updated = response({ now: { drafts: [card({ id: 'a', uid: 'same', originId: 'a' }), card({ id: 'b', uid: 'same', originId: 'b' })], inFlight: [], awaitingReview: [] } })
    draw(updated)
    document.querySelector<HTMLElement>('[data-fiber-id="b"]')!.click()
    expect(document.querySelector<HTMLElement>('.kbn-key-selected')?.dataset.cardOrigin).toBe('b')
    document.querySelector<HTMLButtonElement>('.ws-return')!.click()
    updated.now.drafts.reverse()
    draw(updated)
    expect(document.querySelector<HTMLElement>('.kbn-key-selected')?.dataset.cardOrigin).toBe('b')
  })
  it('keeps the selection painted through a poll without scrolling the Desk out from under the pointer', () => {
    for (const phone of [false, true]) {
      mobile = phone
      draw(data())
      press('j'); press('j')
      const chosen = selected()
      intoView.mockClear(); scroll.mockClear()
      const polled = data()
      polled.now.inFlight.reverse()
      draw(polled)
      expect(selected()).toBe(chosen)
      expect(intoView).not.toHaveBeenCalled()
      expect(scroll).not.toHaveBeenCalled()
    }
  })
  it('pages the phone to the selected column and opens folded lower bands, with reduced motion', () => {
    mobile = true; reduced = true
    draw(data())
    const pager = document.querySelector<HTMLElement>('.kbn-now-board')!
    Object.defineProperty(pager, 'clientWidth', { configurable: true, value: 390 })
    press('j'); press('l')
    expect(scroll).toHaveBeenCalledWith({ left: 780, behavior: 'instant' })
    expect(intoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
    press('l'); press('l'); press('l')
    expect(selected()).toBe('resting')
    expect(document.querySelector('.kbn-section-stash')?.classList.contains('kbn-band-folded')).toBe(false)
  })
  it('ignores typing, composition and layered dialogs; keeps settings and view keys', () => {
    const input = document.createElement('input'); document.body.append(input); input.focus()
    press('j', {}, input); expect(selected()).toBeUndefined()
    press(',', { metaKey: true }, input); expect(settings).toHaveBeenCalledOnce()
    input.blur()
    press('j', { isComposing: true }); press('j', { keyCode: 229 }); expect(selected()).toBeUndefined()
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); document.body.append(dialog)
    press('j'); expect(selected()).toBeUndefined()
    dialog.remove()
    press('j'); expect(selected()).toBe('review')
    expect(press('1').defaultPrevented).toBe(true)
  })

  it('chooses the first movement target by review, Needs-you flight, then drafts', () => {
    press('ArrowDown'); expect(selected()).toBe('review')
    press('u')

    const flight = data()
    flight.now.awaitingReview = []
    flight.now.inFlight = [card({ id: 'needs-you', uid: 'needs-you', status: 'active', runtimePhase: 'attention' })]
    draw(flight)
    press('ArrowDown'); expect(selected()).toBe('needs-you')
    press('u')

    const drafts = response({ now: { drafts: [card({ id: 'draft', uid: 'draft' })], inFlight: [], awaitingReview: [] } })
    draw(drafts)
    press('ArrowDown'); expect(selected()).toBe('draft')
  })
})

describe('keyboard help', () => {
  it('opens from the table, traps Tab, prevents navigation underneath, and returns focus', () => {
    const focus = document.querySelector<HTMLElement>('.kbn-col-head')!; focus.focus()
    press('?')
    const dialog = document.querySelector('.kbn-keymap-dialog')!
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect([...dialog.querySelectorAll('h3')].map(el => el.textContent)).toEqual(['Desk', 'Overview', 'Reader'])
    press('j'); expect(selected()).toBeUndefined()
    press('Tab'); expect(document.activeElement).toBe(dialog.querySelector('button'))
    press('Escape'); expect(document.querySelector('.kbn-keymap-dialog')).toBeNull()
    expect(document.activeElement).toBe(focus)
    press('?'); press('?'); expect(document.querySelector('.kbn-keymap-dialog')).toBeNull()
  })
})
