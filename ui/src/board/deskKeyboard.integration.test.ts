// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import { type KanbanResponse } from './KanbanTypes.js'
import { card, response, voiceStatus, settle } from './testFixtures.js'
import type { Workspace } from './workspace/Workspace.js'
import { MOBILE_MEDIA } from './mobile.js'
import { offeredVerbs } from './workspace/testActs.js'
import type { VoiceStatus } from './voice.js'

interface BoardInternals {
  render(data: KanbanResponse): void
  lastResponse: KanbanResponse | null
  startPolling(): void
  fetchAndRender(): Promise<void>
  workspace: Workspace
  deskEl: HTMLElement
  lensCycleId: string | null
  activeViewId: 'desk' | 'chronicle' | 'board'
  voice: { status: VoiceStatus | null; notify(): void }
  deskKeyboard: { selection: { uid: string; origin: string } | null }
  workspaceColumn(card: typeof head): Array<{ card: typeof head }>
  setView(view: 'desk' | 'chronicle' | 'board'): void
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
async function pop(action: () => void): Promise<void> {
  await new Promise<void>(resolve => {
    window.addEventListener('popstate', () => resolve(), { once: true })
    action()
  })
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
  localStorage.clear(); localStorage.setItem('shuttle.desk.sections', JSON.stringify({ drafts: true })); sessionStorage.clear(); settings.mockClear(); intoView.mockClear(); scroll.mockClear()
  board = new KanbanModal({ shuttleBase: '', onSettingsClick: settings })
  inside = board as unknown as BoardInternals
  vi.spyOn(inside, 'startPolling').mockImplementation(() => {})
  vi.spyOn(inside, 'fetchAndRender').mockResolvedValue()
  board.mount(document.body)
  draw(data())
})
afterEach(() => { board?.unmount(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

// The SDK owns menu activation; jsdom only supplies an unhandled native button click.
async function activate(button: HTMLButtonElement, key: 'Enter' | ' '): Promise<void> {
  const down = press(key, {}, button)
  const up = new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true })
  button.dispatchEvent(up)
  if (!down.defaultPrevented && !up.defaultPrevented) button.click()
  await settle()
}

it('repaints the Desk as the voice target changes', () => {
  const band = () => document.querySelector<HTMLElement>('[data-card-uid="head-uid"]')!.closest<HTMLElement>('[data-flight-band]')!.dataset.flightBand
  expect(band()).toBe('yourTurn')
  inside.voice.status = voiceStatus({ target: { fiber_id: 'head-uid', origin: head.originId, name: head.name } })
  inside.voice.notify()
  expect(band()).toBe('working')
  expect(document.querySelector('[data-card-uid="head-uid"] .constitution-state-dot')?.getAttribute('data-turn')).toBe('working')
  inside.voice.status = { ...inside.voice.status, target: null }
  inside.voice.notify()
  expect(band()).toBe('yourTurn')
})

describe('Desk row menu', () => {
  const row = () => document.querySelector<HTMLElement>('[data-card-uid="review"]')!
  const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
  const items = () => [...menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  const rightClick = async (el: HTMLElement) => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }))
    await settle()
  }
  it('a row carries no menu control; right-click opens the header verbs, drawn as the header draws them', async () => {
    expect(document.querySelector('.kbn-card-menu')).toBeNull()
    await rightClick(row())
    // The header's verbs, then what only the Desk adds: the touch path to a move.
    expect(items().map(i => i.textContent)).toEqual(['Rest', 'Temper', 'Discard', 'Move…'])
    expect(items().slice(0, 3).map(i => [...i.classList].filter(c => c.startsWith('kbn-ctl-') || c.startsWith('ws-header')))).toEqual([
      ['kbn-ctl-rest', 'ws-header-icon', 'ws-header-verb'], ['kbn-ctl-temper', 'ws-header-icon', 'ws-header-verb'], ['kbn-ctl-discard', 'ws-header-icon', 'ws-header-verb']])
    expect(items().slice(0, 3).every(i => i.querySelector('svg') && i.querySelector('.ws-header-word'))).toBe(true)
    expect(menu()!.classList.contains('kbn-verb-menu')).toBe(true)
  })
  it.each(['Enter', ' '] as const)('Shift+F10 on the selected row opens it; arrows select, Escape restores the row, and %s gives a verdict', async key => {
    press('j')
    const selectedRow = document.querySelector<HTMLElement>('.kbn-key-selected')!
    expect(selectedRow).toBe(row())
    selectedRow.focus()
    expect(press('F10', { shiftKey: true }, selectedRow).defaultPrevented).toBe(true)
    await settle()
    expect(row().getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(items()[0])
    press('ArrowDown', {}, document.activeElement!)
    expect(document.activeElement).toBe(items()[1])
    press('End', {}, document.activeElement!)
    expect(document.activeElement).toBe(items()[3])
    press('Home', {}, document.activeElement!)
    expect(document.activeElement).toBe(items()[0])
    // Desk verb shortcuts do not act through the open menu.
    press('x', {}, document.activeElement!)
    expect(document.querySelector('.ws-verdict-undo')).toBeNull()
    press('Escape', {}, document.activeElement!)
    await settle()
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(row())
    expect(selected()).toBe('review')
    press('ContextMenu', {}, row())
    await settle()
    await activate(items()[1], key)
    expect(menu()).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Undo verdict on review')
    expect(document.querySelector('[data-card-uid="review"] .ws-verdict-undo')?.textContent).toBe('Tempered·undo z')
    expect(inside.workspace.isActive).toBe(false)
    press('z')
  })
  it('Close for review from the menu enters the same undo window as the header and keys', async () => {
    const live = card({ id: 'live', uid: 'live', shuttleKind: 'oneshot', status: 'active', workerState: 'running', runtimePhase: 'waiting' })
    draw(response({ now: { drafts: [], inFlight: [live], awaitingReview: [] } }))
    vi.stubGlobal('confirm', () => true)
    await rightClick(document.querySelector<HTMLElement>('[data-card-uid="live"]')!)
    const review = items().find(i => i.getAttribute('aria-label') === 'Close for review')!
    review.click()
    await settle()
    expect(menu()).toBeNull()
    expect(document.querySelector('[data-card-uid="live"] .ws-verdict-undo')?.textContent).toMatch(/undo/)
    press('z')
  })
  it('a thread under a row opens neither the row menu nor the browser menu', () => {
    const waiting = { status: 'active' as const, workerState: 'running' as const, runtimePhase: 'waiting' as const }
    const root = card({ id: 'family', uid: 'family', shuttleKind: 'oneshot', ...waiting })
    const kids = ['a', 'b'].map(k => card({ id: `family/${k}`, uid: `family-${k}`, orchestrator: 'family', ...waiting }))
    draw(response({ now: { drafts: [], inFlight: [root], awaitingReview: [] }, threads: kids }))
    const line = document.querySelector<HTMLElement>('.kbn-desk-threads .kbn-thread-row')!
    expect(line).not.toBeNull()
    const name = line
    name.focus()
    expect(press('F10', { shiftKey: true }, name).defaultPrevented).toBe(false)
    expect(menu()).toBeNull()
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 })
    line.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(menu()).toBeNull()
  })
  it('never offers family expansion or folding in the row menu', async () => {
    const root = card({ id: 'family', uid: 'family', shuttleKind: 'oneshot' })
    const child = card({ id: 'family/child', orchestrator: 'family', status: 'active' })
    draw(response({ now: { drafts: [root], inFlight: [], awaitingReview: [] }, threads: [child] }))
    await rightClick(document.querySelector<HTMLElement>('[data-card-uid="family"]')!)
    expect(menu()?.textContent ?? '').not.toMatch(/Expand family|Fold family/)
    expect(inside.workspace.isActive).toBe(false)
  })
  it('Tab dismisses the menu and a repaint removes its portal', async () => {
    await rightClick(row())
    press('Tab', {}, document.activeElement!)
    await settle()
    expect(menu()).toBeNull()
    await rightClick(row())
    draw(data())
    await settle()
    expect(menu()).toBeNull()
  })
})

describe('Reader Rest lifecycle', () => {
  it.each([
    { view: 'desk', tempered: true }, { view: 'desk', tempered: false },
    { view: 'chronicle', tempered: true }, { view: 'chronicle', tempered: false },
  ] as const)('s rests a constitution opened from $view with tempered=$tempered', async ({ view, tempered }) => {
    const finished = card({ id: 'finished', uid: 'finished-uid', originId: 'remote', status: 'closed', tempered, shuttleKind: 'oneshot', sessionUuid: 'finished-session' })
    draw(response({ timeline: { past: [finished], futureDated: [] } }))
    inside.setView(view)
    // The same entry point receives Desk and Chronicle's original card, even
    // when it isn't present in any drawn Desk region.
    inside.openDocumentChannel(finished)
    await settle()
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
  it.each([true, false])('a reviewed constitution offers Rest alone among its verbs, and on its keyboard, tempered=%s', async tempered => {
    const finished = card({ id: 'finished', uid: 'finished-uid', originId: 'remote', status: 'closed', tempered, shuttleKind: 'oneshot', sessionUuid: 'finished-session' })
    draw(response({ timeline: { past: [finished], futureDated: [] } }))
    inside.setView('chronicle')
    inside.openDocumentChannel(finished)
    await settle()
    const acts = [...document.querySelectorAll<HTMLElement>('.ws-reader .ws-fiber-acts')].find(el => !el.closest('[hidden]'))!
    expect(await offeredVerbs(acts)).toEqual(['Rest'])
    expect([...document.querySelectorAll<HTMLButtonElement>('.ws-reader .ws-worker-acts button[data-verb]')].filter(button => !button.hidden).map(button => button.dataset.verb)).toEqual(['Resume', 'New session'])
    const target = document.querySelector<HTMLElement>('.ws-reader .ws-return')!
    target.focus()
    press('s', {}, target)
    const input = document.querySelector<HTMLInputElement>('.kbn-rest-popover')!
    expect(input).not.toBeNull()
    press('n', {}, input)
    await Promise.resolve(); await Promise.resolve()
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/api/v1/lifecycle'))
    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ action: 'rest', fiber: 'finished', origin: 'remote', until: '' })
  })

  it("a Desk card's menu carries a Rest that opens the same popover", async () => {
    draw(response({ now: { drafts: [], inFlight: [], awaitingReview: [card({ id: 'review', uid: 'review', status: 'closed', shuttleKind: 'oneshot' }), card({ id: 'note', uid: 'note', status: 'closed' })] } }))
    document.querySelector<HTMLElement>('[data-card-uid="review"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await settle()
    const rest = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent === 'Rest')!
    expect(rest).toBeDefined()
    await activate(rest, 'Enter')
    expect(document.querySelector('.kbn-rest-popover')).not.toBeNull()
  })
})

describe('a standing constitution on the Desk', () => {
  const armed = card({ id: 'post', uid: 'post', originId: 'remote', status: 'active', shuttleKind: 'standing', shuttleSchedule: '0 9 * * 1-5', scheduleText: 'weekdays at 09:00' })
  const paused = card({ id: 'digest', uid: 'digest', status: 'open', effectiveHorizon: 'stashed', storedHorizon: 'stashed', shuttleKind: 'standing', shuttleSchedule: '0 7 * * *', scheduleText: 'daily at 07:00' })
  const desk = () => response({ stash: [armed, paused] })
  const lifecycle = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/api/v1/lifecycle')).map(([, init]) => JSON.parse(String(init?.body)))
  const menu = async (uid: string) => {
    document.querySelector<HTMLElement>(`[data-card-uid="${uid}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await settle()
    return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  }

  it('reads as scheduled or paused, with its schedule', () => {
    draw(desk())
    expect(document.querySelector('[data-card-uid="digest"] .kbn-cluster-item-schedule')?.textContent).toBe('Paused · daily at 07:00')
    expect(document.querySelector<HTMLElement>('[data-card-uid="digest"]')!.dataset.schedule).toBe('paused')
    expect(document.querySelector('[data-card-uid="post"] .kbn-cluster-item-schedule')?.textContent).toBe('weekdays at 09:00')
  })

  it('pauses an armed schedule from its menu at once, posting rest with no wake day', async () => {
    draw(desk())
    const entries = await menu('post')
    expect(entries.map(item => item.textContent)).toEqual(['Pause schedule', 'Retire', 'Move…'])
    await activate(entries.find(item => item.textContent === 'Pause schedule')!, 'Enter')
    await settle()
    expect(document.querySelector('.kbn-rest-popover')).toBeNull()
    expect(lifecycle()).toEqual([{ action: 'rest', fiber: 'post', origin: 'remote' }])
  })

  it('resumes a paused schedule from its menu', async () => {
    draw(desk())
    const entries = await menu('digest')
    expect(entries.map(item => item.textContent)).toEqual(['Resume schedule', 'Retire', 'Move…'])
    await activate(entries.find(item => item.textContent === 'Resume schedule')!, 'Enter')
    await settle()
    expect(lifecycle()).toEqual([{ action: 'resume', fiber: 'digest', origin: 'local' }])
  })

  it('takes s as pause, x as retire, and refuses t', async () => {
    draw(desk())
    press('j')
    const uid = selected()!
    expect(['post', 'digest']).toContain(uid)
    expect(press('t').defaultPrevented).toBe(false)
    expect(document.querySelector(`[data-card-uid="${uid}"] .ws-verdict-undo`)).toBeNull()
    expect(press('x').defaultPrevented).toBe(true)
    expect(document.querySelector(`[data-card-uid="${uid}"] .ws-verdict-undo`)?.textContent).toBe('Retired·undo z')
    press('z')
    press('s')
    await settle()
    expect(document.querySelector('.kbn-rest-popover')).toBeNull()
    expect(lifecycle()).toEqual([uid === 'post'
      ? { action: 'rest', fiber: 'post', origin: 'remote' }
      : { action: 'resume', fiber: 'digest', origin: 'local' }])
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
    press('j'); press('k'); expect(selected()).toBe('plan')
    press('a')
    expect(undoLine('plan')).toBe('To review·undo z')
    press('z')
    press('j'); expect(selected()).toBe('done')
    expect(press('a').defaultPrevented).toBe(false)
    expect(undoLine('done')).toBeUndefined()
  })
  it('keys do nothing without a selection, and the verdict keys skip a fiber off the lifecycle', () => {
    expect(press('t').defaultPrevented).toBe(false)
    press('j'); press('k'); press('k'); press('k'); press('k'); expect(selected()).toBe('draft-uid')
    expect(press('t').defaultPrevented).toBe(false)
    expect(undoLine('draft-uid')).toBeUndefined()
  })
})

describe('Desk keyboard selection', () => {
  it.each([
    ['desk', 'desk'], ['desk', 'chronicle'], ['desk', 'board'],
    ['overview', 'desk'], ['overview', 'chronicle'], ['overview', 'board'],
    ['reader', 'desk'], ['reader', 'chronicle'], ['reader', 'board'],
  ] as const)('%s switches with the numbered view key and keeps Desk selection when returning', async (from, to) => {
    press('j'); expect(selected()).toBe('review')
    expect(inside.deskKeyboard.selection?.uid).toBe('review')
    if (from === 'overview') inside.setView('board')
    if (from === 'reader') {
      press('Enter')
      expect(inside.workspace.isActive).toBe(true)
    }
    const key = to === 'desk' ? '1' : to === 'chronicle' ? '2' : '3'
    expect(press(key).defaultPrevented).toBe(true)
    expect(inside.activeViewId).toBe(to)
    if (to === 'desk') expect(selected()).toBe('review')
    if (from === 'reader') expect(inside.workspace.isActive).toBe(false)
    await Promise.resolve()
  })

  it('Escape returns an empty Overview and a root Reader to Desk, while peeling Overview layers first', async () => {
    inside.setView('board')
    expect(press('Escape').defaultPrevented).toBe(true)
    expect(inside.activeViewId).toBe('desk')

    inside.setView('board')
    const latest = document.querySelector<HTMLDetailsElement>('.ws-overview-latest')!
    latest.open = true
    expect(press('Escape').defaultPrevented).toBe(true)
    expect(latest.open).toBe(false)
    expect(inside.activeViewId).toBe('board')

    inside.setView('desk')
    press('j'); press('Enter')
    expect(inside.workspace.isActive).toBe(true)
    await pop(() => { expect(press('Escape').defaultPrevented).toBe(true) })
    expect(inside.workspace.isActive).toBe(false)
    expect(inside.activeViewId).toBe('desk')
  })

  it('1 returns to Desk and Escape returns to Board without replacing the Desk selection', async () => {
    press('j'); expect(selected()).toBe('review')
    inside.setView('board')
    inside.openDocumentChannel(card({ id: 'd1', uid: 'd1' }))
    await settle()
    expect(inside.workspace.isActive).toBe(true)
    expect(press('1').defaultPrevented).toBe(true)
    expect(inside.activeViewId).toBe('desk')
    expect(inside.deskKeyboard.selection?.uid).toBe('review')
    expect(selected()).toBe('review')

    inside.setView('board')
    inside.openDocumentChannel(card({ id: 'd1', uid: 'd1' }))
    await settle()
    expect(inside.workspace.isActive).toBe(true)
    await pop(() => { expect(press('Escape').defaultPrevented).toBe(true) })
    expect(inside.activeViewId).toBe('board')
    expect(inside.deskKeyboard.selection?.uid).toBe('review')
  })

  it.each([
    ['h', {}], ['ArrowLeft', {}], ['‹', {}], ['ArrowLeft', { altKey: true }],
  ] as const)('%s and Escape both return to the non-Desk origin', async (key, init) => {
    inside.setView('board')
    inside.openDocumentChannel(card({ id: 'd1', uid: 'd1' }))
    await settle()
    expect(inside.workspace.isActive).toBe(true)
    await pop(() => { expect(press(key, init).defaultPrevented).toBe(true) })
    expect(inside.workspace.isActive).toBe(false)
    expect(inside.activeViewId).toBe('board')

    inside.openDocumentChannel(card({ id: 'd1', uid: 'd1' }))
    await settle()
    await pop(() => { expect(press('Escape').defaultPrevented).toBe(true) })
    expect(inside.workspace.isActive).toBe(false)
    expect(inside.activeViewId).toBe('board')
  })

  it.each([['n', ''], ['Enter', 'tomorrow']])('s on the focused constitution then %s rests through lifecycle', async (k, which) => {
    press('j')
    press('s')
    await settle()
    const input = document.querySelector<HTMLElement>('.kbn-rest-popover')!
    expect(input).not.toBeNull()
    press(k, {}, input)
    await settle()
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
    press('h')
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
    press('k'); expect(selected()).toBe('working')
    press('g'); expect(selected()).toBe('head-uid')
    press('G'); expect(selected()).toBe('working')
    press('j'); expect(selected()).toBe('review')
    press('j'); expect(selected()).toBe('resting')
    press('j'); expect(selected()).toBe('resting')
    press('k'); expect(selected()).toBe('review')
    press('h'); expect(selected()).toBeUndefined()
  })
  it('walks every visible Desk row across section boundaries in both directions', () => {
    press('j'); expect(selected()).toBe('review')
    press('k'); expect(selected()).toBe('working')
    press('k'); expect(selected()).toBe('head-uid')
    press('k'); expect(selected()).toBe('d2')
    press('k'); expect(selected()).toBe('draft-uid')
    press('k'); expect(selected()).toBe('draft-uid')
    press('j'); expect(selected()).toBe('d2')
    press('j'); expect(selected()).toBe('head-uid')
    press('j'); expect(selected()).toBe('working')
    press('j'); expect(selected()).toBe('review')
    press('j'); expect(selected()).toBe('resting')
    press('j'); expect(selected()).toBe('resting')
  })
  it('skips folded sections while walking across the Desk', () => {
    document.querySelector<HTMLElement>('[data-column="inFlight"] .kbn-col-head')!.click()
    press('j'); expect(selected()).toBe('review')
    press('k'); expect(selected()).toBe('d2')
    press('j'); expect(selected()).toBe('review')
    document.querySelector<HTMLElement>('.kbn-section-stash .kbn-bandhead')!.click()
    press('j'); expect(selected()).toBe('review')
  })
  it('opens the reader stepping the Desk\'s columns', async () => {
    press('j'); press('k'); press('k'); press('Enter')
    expect((inside.workspace.reader as unknown as { deskCards(): Array<{ id: string; uid?: string }> }).deskCards().map(row => row.uid ?? row.id)).toEqual(['draft-uid', 'd2', 'head-uid', 'working', 'review', 'resting'])
    await pop(() => document.querySelector<HTMLButtonElement>('.ws-return')!.click())
    expect(inside.workspace.isActive).toBe(false)
  })
  it('survives refresh reorder and a path rename by uid+origin, not list position', () => {
    press('j'); press('k'); press('k'); press('k'); press('k')
    const updated = data()
    updated.now.drafts = [card({ id: 'd2' }), card({ id: 'renamed', uid: 'draft-uid' })]
    draw(updated)
    expect(selected()).toBe('draft-uid')
    expect(document.querySelector<HTMLElement>('.kbn-key-selected')?.dataset.fiberId).toBe('renamed')
    press('k'); expect(selected()).toBe('d2')
  })
  it.each([['j', 'head-uid'], ['J', 'review']])('%s scans two stops and one Escape selects the last viewed Desk card', async (key, expected) => {
    press('j'); press('k'); press('k'); press('k'); press('k'); press('Enter')
    await settle()
    for (let step = 0; step < 2; step++) {
      press(key)
      await settle()
    }
    expect(window.location.hash).toContain(expected)
    await pop(() => press('Escape'))
    expect(inside.workspace.isActive).toBe(false)
    expect(selected()).toBe(expected)
    expect(document.activeElement).toBe(document.querySelector('.kbn-key-selected'))
  })
  it('opens with Enter and restores the opened card after reader return and a deferred refresh', async () => {
    press('j'); press('k'); press('k'); press('k'); press('Enter')
    expect(inside.workspace.isActive).toBe(true)
    expect(window.location.hash).toContain('d2')
    const updated = data()
    updated.now.drafts.reverse()
    inside.render(updated)
    await pop(() => document.querySelector<HTMLButtonElement>('.ws-return')!.click())
    expect(inside.workspace.isActive).toBe(false)
    expect(selected()).toBe('d2')
    const restored = document.querySelector<HTMLElement>('.kbn-key-selected')!
    expect(restored.tabIndex).toBe(-1)
    expect(document.activeElement).toBe(restored)
    press('j'); expect(selected()).toBe('draft-uid')
  })
  it('selects clicked cards and distinguishes identical uids on different origins', async () => {
    const updated = response({ now: { drafts: [card({ id: 'a', uid: 'same', originId: 'a' }), card({ id: 'b', uid: 'same', originId: 'b' })], inFlight: [], awaitingReview: [] } })
    draw(updated)
    document.querySelector<HTMLElement>('[data-fiber-id="b"]')!.click()
    expect(document.querySelector<HTMLElement>('.kbn-key-selected')?.dataset.cardOrigin).toBe('b')
    await pop(() => document.querySelector<HTMLButtonElement>('.ws-return')!.click())
    updated.now.drafts.reverse()
    draw(updated)
    expect(document.querySelector<HTMLElement>('.kbn-key-selected')?.dataset.cardOrigin).toBe('b')
  })
  it('keeps focus on its row through a poll, and gives a removed row\'s focus to the row in its place', () => {
    const row = (uid: string) => document.querySelector(`[data-card-uid="${uid}"]`)
    press('j'); press('k'); press('k')
    expect(document.activeElement).toBe(row('head-uid'))
    draw(data())
    expect(document.activeElement).toBe(row('head-uid'))
    const without = data()
    without.now.inFlight = without.now.inFlight.filter(card => card.uid !== 'head-uid')
    draw(without)
    expect(document.activeElement).toBe(row('working'))
    expect(selected()).toBe('working')
    press('j'); press('j')
    expect(document.activeElement).toBe(row('resting'))
    const shorter = data()
    shorter.stash = []
    draw(shorter)
    expect(document.activeElement).toBe(row('review'))
    expect(selected()).toBe('review')
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
    press('j')
    expect(scroll).toHaveBeenCalledWith({ left: 780, behavior: 'instant' })
    expect(intoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
    press('j')
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
    // With focus off the Desk, a selection the poll removes leaves no row to follow.
    press('u'); (document.activeElement as HTMLElement).blur()

    const flight = data()
    flight.now.awaitingReview = []
    flight.now.inFlight = [card({ id: 'needs-you', uid: 'needs-you', status: 'active', workerState: 'running', runtimePhase: 'attention' })]
    draw(flight)
    press('ArrowDown'); expect(selected()).toBe('needs-you')
    press('u'); (document.activeElement as HTMLElement).blur()

    const drafts = response({ now: { drafts: [card({ id: 'draft', uid: 'draft' })], inFlight: [], awaitingReview: [] } })
    draw(drafts)
    press('ArrowDown'); expect(selected()).toBe('draft')
  })
})

describe('keyboard help', () => {
  it('opens from the table, traps Tab, prevents navigation underneath, and returns focus', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0))
    const focus = document.querySelector<HTMLElement>('.kbn-col-head')!; focus.focus()
    press('?')
    await settle()
    const dialog = document.querySelector('[role="dialog"][aria-label="Keyboard shortcuts"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    await vi.waitFor(() => expect(focus.closest('[inert]')).not.toBeNull())
    expect([...dialog.querySelectorAll('h3')].map(el => el.textContent)).toEqual(['Everywhere', 'Moving', 'A constitution', 'Fiber page', "A constitution's page"])
    press('j'); expect(selected()).toBeUndefined()
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(dialog.contains(document.activeElement)).toBe(true)
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(document.querySelector('.kbn-keymap-dialog')).toBeNull()
    expect(document.activeElement).toBe(focus)
    press('?'); await settle(); press('?'); await settle()
    expect(document.querySelector('.kbn-keymap-dialog')).toBeNull()
  })
})
