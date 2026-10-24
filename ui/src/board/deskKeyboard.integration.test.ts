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
const head = card({ id: 'head', uid: 'head-uid', status: 'active', workerState: 'running', runtimePhase: 'waiting' })
const data = () => response({
  now: {
    drafts: [card({ id: 'd1', uid: 'draft-uid' }), card({ id: 'd2' })],
    inFlight: [card({ id: 'working', status: 'active', workerState: 'running', runtimePhase: 'working' }), head],
    awaitingReview: [card({ id: 'review', status: 'closed', shuttleKind: 'oneshot' })],
  },
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
  draw(data())
})
afterEach(() => { board?.unmount(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

// jsdom has no native button default action. Dispatch its click only when
// the key is unconsumed, so an intercepted Enter/Space cannot pass this test.
function activate(button: HTMLButtonElement, key: 'Enter' | ' '): void {
  const down = press(key, {}, button)
  const up = new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true })
  button.dispatchEvent(up)
  expect(down.defaultPrevented).toBe(false)
  expect(up.defaultPrevented).toBe(false)
  if (!down.defaultPrevented && !up.defaultPrevented) button.click()
}

describe('Desk action menu keyboard controls', () => {
  const trigger = () => document.querySelector<HTMLButtonElement>('[data-card-uid="review"] .kbn-card-menu')!
  const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
  const items = () => [...menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  it.each(['Enter', ' '] as const)('%s opens the menu natively, arrows select, Escape restores the trigger, and a native activation gives a verdict', key => {
    press('j')
    const row = document.querySelector<HTMLElement>('.kbn-key-selected')!
    row.focus()
    expect(press('Tab', {}, row).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(trigger())
    expect(trigger().textContent).toBe('•••')
    activate(trigger(), key)
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(items().map(i => i.textContent)).toEqual(['Temper', 'Discard', 'Rest'])
    expect(document.activeElement).toBe(items()[0])
    press('ArrowDown', {}, document.activeElement!)
    expect(document.activeElement).toBe(items()[1])
    press('End', {}, document.activeElement!)
    expect(document.activeElement).toBe(items()[2])
    press('Home', {}, document.activeElement!)
    expect(document.activeElement).toBe(items()[0])
    press('ArrowUp', {}, document.activeElement!)
    expect(document.activeElement).toBe(items()[2])
    // Desk verb shortcuts do not act through the open menu.
    press('x', {}, document.activeElement!)
    expect(document.querySelector('.ws-verdict-undo')).toBeNull()
    press('Escape', {}, document.activeElement!)
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(selected()).toBe('review')
    activate(trigger(), key)
    activate(items()[0], key)
    expect(menu()).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Undo verdict on review')
    expect(document.querySelector('[data-card-uid="review"] .ws-verdict-undo')?.textContent).toBe('Tempered·undo z')
    expect(inside.workspace.isActive).toBe(false)
    press('z')
  })
  it('offers family expansion and folding without opening the reader', () => {
    const root = card({ id: 'family', uid: 'family', shuttleKind: 'oneshot' })
    const child = card({ id: 'family/child', orchestrator: 'family', status: 'active' })
    draw(response({ now: { drafts: [root], inFlight: [], awaitingReview: [] }, threads: [child] }))
    const row = document.querySelector<HTMLElement>('[data-card-uid="family"]')!
    const button = row.querySelector<HTMLButtonElement>('.kbn-card-menu')!
    const choose = (text: string) => {
      button.click()
      const action = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent === text)!
      expect(action).toBeDefined()
      activate(action, ' ')
    }
    choose('Expand family')
    expect(row.querySelector<HTMLElement>('.kbn-thread-peek')!.hidden).toBe(false)
    choose('Fold family')
    expect(row.querySelector<HTMLElement>('.kbn-thread-peek')!.hidden).toBe(true)
    expect(inside.workspace.isActive).toBe(false)
  })
  it('Tab dismisses the menu and a repaint removes its portal', () => {
    trigger().click()
    press('Tab', {}, document.activeElement!)
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger())
    trigger().click()
    draw(data())
    expect(menu()).toBeNull()
  })
})

describe('Reader Rest lifecycle', () => {
  it.each([
    { view: 'desk', tempered: true }, { view: 'desk', tempered: false },
    { view: 'chronicle', tempered: true }, { view: 'chronicle', tempered: false },
  ] as const)('s rests a constitution opened from $view with tempered=$tempered', async ({ view, tempered }) => {
    const finished = card({ id: 'finished', uid: 'finished-uid', originId: 'remote', status: 'closed', tempered, shuttleKind: 'oneshot' })
    draw(response({ timeline: { past: [finished], futureDated: [] } }))
    inside.setView(view)
    // The same entry point receives Desk and Chronicle's original card, even
    // when it isn't present in any drawn Desk region.
    inside.openDocumentChannel(finished)
    for (let i = 0; i < 200; i++) await Promise.resolve()
    const target = document.querySelector<HTMLElement>('.ws-reader .ws-return')!
    expect(target).not.toBeNull()
    target.focus()
    press('s', {}, target)
    const input = document.querySelector<HTMLInputElement>('.kbn-rest-popover')!
    expect(input).not.toBeNull()
    press('n', {}, input)
    await Promise.resolve(); await Promise.resolve()
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/api/v1/lifecycle'))
    expect(calls).toHaveLength(1)
    expect(calls[0][1]?.method).toBe('POST')
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ action: 'rest', fiber: 'finished', origin: 'remote', until: '' })
  })
})

describe('Rest controls', () => {
  it.each([true, false])('the constitution page offers Rest for a card with tempered=%s and posts rest from the popover', async tempered => {
    const finished = card({ id: 'finished', uid: 'finished-uid', originId: 'remote', status: 'closed', tempered, shuttleKind: 'oneshot' })
    draw(response({ timeline: { past: [finished], futureDated: [] } }))
    inside.setView('chronicle')
    inside.openDocumentChannel(finished)
    for (let i = 0; i < 200; i++) await Promise.resolve()
    const rest = document.querySelector<HTMLButtonElement>('.ws-reader .kbn-ctl-rest')!
    expect(rest).not.toBeNull()
    expect(rest.hidden).toBe(false)
    expect(rest.closest('.kbn-ctl-verdict')!.hasAttribute('hidden')).toBe(false)
    expect(rest.title).toContain('s')
    expect(document.querySelector<HTMLElement>('.ws-reader .kbn-ctl-temper')!.hidden).toBe(true)
    rest.click()
    const input = document.querySelector<HTMLInputElement>('.kbn-rest-popover')!
    expect(input).not.toBeNull()
    press('n', {}, input)
    await Promise.resolve(); await Promise.resolve()
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/api/v1/lifecycle'))
    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ action: 'rest', fiber: 'finished', origin: 'remote', until: '' })
  })

  it('a Desk card carries a Rest affordance that opens the same popover', () => {
    draw(response({ now: { drafts: [], inFlight: [], awaitingReview: [card({ id: 'review', uid: 'review', status: 'closed', shuttleKind: 'oneshot' }), card({ id: 'note', uid: 'note', status: 'closed' })] } }))
    const button = document.querySelector<HTMLButtonElement>('[data-card-uid="review"] .kbn-card-menu')!
    button.click()
    const rest = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent === 'Rest')!
    expect(rest).toBeDefined()
    activate(rest, 'Enter')
    expect(document.querySelector('.kbn-rest-popover')).not.toBeNull()
  })
})

describe('Desk constitution keys', () => {
  const agentDesk = () => response({ now: {
    drafts: [card({ id: 'plan', uid: 'plan', shuttleKind: 'oneshot' })],
    inFlight: [],
    awaitingReview: [card({ id: 'done', uid: 'done', status: 'closed', shuttleKind: 'oneshot' })],
  } })
  const undoLine = (uid: string): string | null | undefined =>
    document.querySelector(`[data-card-uid="${uid}"] .ws-verdict-undo`)?.textContent
  it.each([['t', 'Tempered'], ['x', 'Discarded']])('%s gives the selected card its verdict through the reader\'s undo window, and z takes it back', (key, word) => {
    draw(agentDesk())
    press('j'); expect(selected()).toBe('done')
    expect(press(key).defaultPrevented).toBe(true)
    expect(undoLine('done')).toBe(`${word}·undo z`)
    expect(inside.workspace.isActive).toBe(false)
    press('z')
    expect(undoLine('done')).toBeUndefined()
  })
  it('a moves a selected draft to review and is refused where review is not reachable', () => {
    draw(agentDesk())
    press('j'); press('h'); expect(selected()).toBe('plan')
    press('a')
    expect(undoLine('plan')).toBe('To review·undo z')
    press('z')
    press('l'); expect(selected()).toBe('done')
    expect(press('a').defaultPrevented).toBe(false)
    expect(undoLine('done')).toBeUndefined()
  })
  it('keys do nothing without a selection, and the verdict keys skip a fiber off the lifecycle', () => {
    expect(press('t').defaultPrevented).toBe(false)
    press('j'); press('h'); press('h'); expect(selected()).toBe('draft-uid')
    expect(press('t').defaultPrevented).toBe(false)
    expect(undoLine('draft-uid')).toBeUndefined()
  })
  it('r opens the selected card on its fiber page, writing', async () => {
    draw(agentDesk())
    press('j')
    press('r')
    for (let i = 0; i < 50; i++) await Promise.resolve()
    expect(inside.workspace.isActive).toBe(true)
    expect(window.location.hash).toContain('done')
    expect(document.activeElement?.closest('.ws-reader')).not.toBeNull()
    expect(document.activeElement?.tagName).toBe('TEXTAREA')
  })
})

describe('Desk keyboard selection', () => {
  it.each([['n', ''], ['Enter', 'tomorrow']])('s on the focused constitution then %s rests through lifecycle', async (k, which) => {
    press('j')
    press('s')
    const input = document.querySelector<HTMLElement>('.kbn-rest-popover')!
    expect(input).not.toBeNull()
    press(k, {}, input)
    await Promise.resolve(); await Promise.resolve()
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/api/v1/lifecycle'))
    expect(calls).toHaveLength(1)
    const body = JSON.parse(String(calls[0][1]?.body))
    expect(body).toMatchObject({ action: 'rest', fiber: 'review', origin: 'local' })
    if (which === '') expect(body.until).toBe('')
    else expect(body.until).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(document.querySelector('.kbn-rest-popover')).toBeNull()
  })

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
  it('moves through both flight bands, the three columns and Resting without wrapping', () => {
    press('j'); expect(selected()).toBe('review')
    press('h'); expect(selected()).toBe('head-uid')
    press('j'); expect(selected()).toBe('working')
    press('j'); expect(selected()).toBe('working')
    press('g'); expect(selected()).toBe('head-uid')
    press('G'); expect(selected()).toBe('working')
    press('ArrowRight'); expect(selected()).toBe('review')
    press('l'); expect(selected()).toBe('resting')
    press('l'); expect(selected()).toBe('resting')
    press('h'); expect(selected()).toBe('review')
    press('u'); expect(selected()).toBe('review')
    press('Escape'); expect(selected()).toBeUndefined()
  })
  it('opens the reader on one grouped sidebar of the Desk\'s columns, and keeps the flight column for the cards that fly', () => {
    press('j'); press('h'); press('Enter')
    expect([...document.querySelectorAll<HTMLElement>('.ws-sidebar .ws-channel-row')].map(el => el.dataset.channelUid)).toEqual(['draft-uid', 'd2', 'head-uid', 'working', 'review', 'resting'])
    expect([...document.querySelectorAll('.ws-sidebar .kbn-flight-caption')].map(el => el.textContent)).toEqual(['Drafts', 'Your turn', 'Working', 'Awaiting review', 'Resting'])
    expect([...document.querySelectorAll<HTMLElement>('.ws-sidebar-index-entry')].map(el => el.getAttribute('aria-label'))).toEqual(['Drafts, 2', 'In flight, 2', 'Awaiting review, 1', 'Resting, 1'])
    document.querySelector<HTMLButtonElement>('.ws-return')!.click()
    expect(inside.workspace.isActive).toBe(false)
    expect(inside.workspaceColumn(head).map(entry => entry.card.uid ?? entry.card.id)).toEqual(['head-uid', 'working'])
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
    flight.now.inFlight = [card({ id: 'needs-you', uid: 'needs-you', status: 'active', workerState: 'running', runtimePhase: 'attention' })]
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
