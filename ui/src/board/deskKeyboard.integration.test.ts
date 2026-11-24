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
  activeViewId: 'desk' | 'channels'
  voice: { status: VoiceStatus | null; notify(): void }
  deskKeyboard: { selection: { uid: string; origin: string } | null; select(address: { uid: string; origin: string }): void }
  workspaceColumn(card: typeof head): Array<{ card: typeof head }>
  setView(view: 'desk' | 'channels'): void
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
    awaitingReview: [],
  },
  // It asks, so it waits on you and leads the Desk.
  stash: [card({ id: 'review', status: 'active', ask: { text: 'Which threshold?', at: '2026-10-05T11:00:00Z' } }), card({ id: 'resting', effectiveHorizon: 'stashed' })],
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
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ fibers: [], files: [], held: [], dismissed: [], reach_ms: 14 * 86_400_000 }))))
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

it('keeps an idle worker that asked nothing in Working, its dot still, when a look moves the voice target onto it', () => {
  const column = () => document.querySelector<HTMLElement>('[data-card-uid="head-uid"]')!.closest<HTMLElement>('[data-column]')!.dataset.column
  expect(column()).toBe('working')
  inside.voice.status = voiceStatus({ target: { fiber_id: 'head-uid', origin: head.originId, name: head.name } })
  inside.voice.notify()
  draw(data())
  expect(column()).toBe('working')
  const dot = document.querySelector<HTMLElement>('[data-card-uid="head-uid"] .constitution-state-dot')!
  expect([dot.dataset.attention, dot.hasAttribute('data-busy')]).toEqual(['working', false])
})

// A slide-deck worker two levels under a top-level closed for review was found only by search: the Desk named it nowhere, only "2 working" on its family's head.
it('names a live worker deep in a family closed for review on the Desk, and opens its own view from its line and from the walk', async () => {
  const career = card({ id: 'career-futures', uid: 'career-uid', status: 'closed', closedAt: '2026-11-24T18:00:00Z' })
  const talks = card({ id: 'career-futures/talks', uid: 'talks-uid', orchestrator: 'career-uid', status: 'active', workerState: 'running', runtimePhase: 'waiting' })
  const seminar = card({ id: 'career-futures/talks/ice-seminar', uid: 'seminar-uid', orchestrator: 'talks-uid', status: 'active', workerState: 'running', runtimePhase: 'working' })
  draw(response({ now: { drafts: [], inFlight: [], awaitingReview: [career] }, threads: [talks, seminar] }))
  const family = document.querySelector<HTMLElement>('[data-column="review"] .kbn-family[data-card-uid="career-uid"]')!
  expect([...family.querySelectorAll<HTMLElement>('.kbn-family-line')].map(line => [line.dataset.cardUid, line.querySelector('.thread-row-slug')!.textContent])).toStrictEqual([
    ['seminar-uid', 'ice-seminar'], ['talks-uid', 'talks'],
  ])
  family.querySelector<HTMLElement>('.kbn-family-line[data-card-uid="seminar-uid"] .thread-row-doing')!.click()
  expect(inside.workspace.isActive).toBe(true)
  expect(window.location.hash).toContain('seminar-uid')
  // Back on the Desk its line holds the selection, one stop of the walk after its family's head.
  await pop(() => document.querySelector<HTMLButtonElement>('.ws-return')!.click())
  expect(selected()).toBe('seminar-uid')
  press('k'); expect(selected()).toBe('career-uid')
  press('j'); expect(selected()).toBe('seminar-uid')
  press('Enter')
  expect(window.location.hash).toContain('seminar-uid')
})

it('moves through the view tabs by arrows, Home and End, and keeps the numeric hotkeys', async () => {
  await settle()
  const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="Board views"] [role="tab"]'))
  expect(tabs.map(tab => tab.dataset.view ?? tab.querySelector<HTMLElement>('[data-view]')?.dataset.view)).toEqual(['desk', 'channels'])
  expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1])
  tabs[0].focus()
  // The tablist's own keys do not reach the Desk underneath it.
  const before = selected()
  press('ArrowRight', {}, document.activeElement!)
  await settle()
  expect(document.activeElement).toBe(tabs[1])
  expect(tabs[1].getAttribute('aria-selected')).toBe('true')
  expect(inside.activeViewId).toBe('channels')
  expect(selected()).toBe(before)
  press('End', {}, document.activeElement!)
  await settle()
  expect(document.activeElement).toBe(tabs[1])
  press('ArrowRight', {}, document.activeElement!)
  await settle()
  expect(document.activeElement).toBe(tabs[0])
  expect(inside.activeViewId).toBe('desk')
  // Every other Desk key still works from a focused tab.
  press('j', {}, document.activeElement!)
  expect(selected()).not.toBe(before)
  for (const [index, key] of ['1', '2'].entries()) {
    press(key, {}, document.activeElement!)
    await settle()
    expect(tabs[index].getAttribute('aria-selected')).toBe('true')
    expect(tabs.filter(tab => tab.tabIndex === 0)).toEqual([tabs[index]])
  }
})

describe('Reader Rest lifecycle', () => {
  it.each([
    { view: 'desk', tempered: true }, { view: 'desk', tempered: false },
    { view: 'channels', tempered: true }, { view: 'channels', tempered: false },
  ] as const)('s rests a constitution opened from $view with tempered=$tempered', async ({ view, tempered }) => {
    const finished = card({ id: 'finished', uid: 'finished-uid', originId: 'remote', status: 'closed', tempered, shuttleKind: 'oneshot', sessionUuid: 'finished-session' })
    draw(response({ timeline: { past: [finished], futureDated: [] } }))
    inside.setView(view)
    // The same entry point receives the original card, even
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
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ action: 'rest', fiber: 'finished', origin: 'remote', until: '', actor: 'board' })
  })
})

describe('a standing constitution\'s schedule', () => {
  it.each([
    ['active', { action: 'rest', fiber: 'post', origin: 'remote', actor: 'board' }],
    ['open', { action: 'resume', fiber: 'post', origin: 'remote', actor: 'board' }],
  ] as const)('s in the view of a %s one pauses or resumes it at once, as the board', async (status, body) => {
    const post = card({ id: 'post', uid: 'post', originId: 'remote', status, shuttleKind: 'standing', shuttleSchedule: '0 9 * * 1-5', effectiveHorizon: status === 'open' ? 'stashed' : 'now' })
    draw(response({ stash: [post] }))
    inside.openDocumentChannel(post)
    await settle()
    const target = document.querySelector<HTMLElement>('.ws-reader .ws-return')!
    target.focus()
    press('s', {}, target)
    await settle()
    expect(document.querySelector('.kbn-rest-popover')).toBeNull()
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/api/v1/lifecycle'))
    expect(calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([body])
  })
})

describe('Rest controls', () => {
  it.each([true, false])('a reviewed constitution offers Rest alone among its verbs, and on its keyboard, tempered=%s', async tempered => {
    const finished = card({ id: 'finished', uid: 'finished-uid', originId: 'remote', status: 'closed', tempered, shuttleKind: 'oneshot', sessionUuid: 'finished-session' })
    draw(response({ timeline: { past: [finished], futureDated: [] } }))
    inside.setView('channels')
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
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ action: 'rest', fiber: 'finished', origin: 'remote', until: '', actor: 'board' })
  })

})

describe('Desk keyboard selection', () => {
  it.each([
    ['desk', 'desk'], ['desk', 'channels'],
    ['view', 'desk'], ['view', 'channels'],
    ['reader', 'desk'], ['reader', 'channels'],
  ] as const)('%s switches with the numbered view key and keeps Desk selection when returning', async (from, to) => {
    press('j'); expect(selected()).toBe('review')
    expect(inside.deskKeyboard.selection?.uid).toBe('review')
    if (from === 'view') inside.setView('channels')
    if (from === 'reader') {
      press('Enter')
      expect(inside.workspace.isActive).toBe(true)
    }
    const key = to === 'desk' ? '1' : '2'
    expect(press(key).defaultPrevented).toBe(true)
    expect(inside.activeViewId).toBe(to)
    if (to === 'desk') expect(selected()).toBe('review')
    if (from === 'reader') expect(inside.workspace.isActive).toBe(false)
    await Promise.resolve()
  })

  it('a verdict or Rest key acts on the selected row alone: nothing selected, nothing happens', () => {
    const drafted = document.querySelector<HTMLElement>('[data-card-uid="draft-uid"]')!
    drafted.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    for (const key of ['t', 'x', 'a', 's']) expect(press(key).defaultPrevented).toBe(false)
    expect(document.querySelector('.ws-verdict-undo, .kbn-rest-popover')).toBeNull()
  })

  // A verdict keyed on a live member's line was queued with no undo line drawn anywhere on the Desk.
  it('t on a live member\'s line draws its undo window on that line', () => {
    const top = card({ id: 'career-futures', uid: 'career-uid', status: 'closed', closedAt: '2026-11-24T18:00:00Z' })
    const seminar = card({ id: 'career-futures/ice-seminar', uid: 'seminar-uid', orchestrator: 'career-uid', status: 'active', workerState: 'running', runtimePhase: 'working', shuttleKind: 'oneshot' })
    draw(response({ now: { drafts: [], inFlight: [], awaitingReview: [top] }, threads: [seminar] }))
    inside.deskKeyboard.select({ uid: 'seminar-uid', origin: 'local' })
    expect(selected()).toBe('seminar-uid')
    // Stopping a live worker asks first.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    expect(press('t').defaultPrevented).toBe(true)
    confirm.mockRestore()
    expect(document.querySelector('[data-card-uid="seminar-uid"] .ws-verdict-undo, [data-card-uid="seminar-uid"] + .ws-verdict-undo')?.textContent).toContain('undo')
  })

  it('t tempers the selected draft through the undo window, and s opens Rest for it', () => {
    draw(response({ now: { drafts: [card({ id: 'd1', uid: 'draft-uid', shuttleKind: 'oneshot' })], inFlight: [], awaitingReview: [] } }))
    inside.deskKeyboard.select({ uid: 'draft-uid', origin: 'local' })
    expect(selected()).toBe('draft-uid')
    expect(press('t').defaultPrevented).toBe(true)
    expect(document.querySelector('.ws-verdict-undo')?.textContent).toContain('undo')
    expect(press('s').defaultPrevented).toBe(true)
    expect(document.querySelector('.kbn-rest-popover')).not.toBeNull()
  })

  it('c opens the selected row\'s conversation, as the reader\'s c does; with nothing selected or in a field, nothing', () => {
    const conversation = vi.spyOn(inside.workspace.dock, 'openConversation').mockReturnValue(true)
    expect(press('c').defaultPrevented).toBe(false)
    inside.deskKeyboard.select({ uid: 'head-uid', origin: 'local' })
    const field = document.body.appendChild(document.createElement('textarea'))
    expect(press('c', {}, field).defaultPrevented).toBe(false)
    expect(conversation).not.toHaveBeenCalled()
    expect(press('c').defaultPrevented).toBe(true)
    expect(conversation).toHaveBeenCalledTimes(1)
    expect(conversation.mock.calls[0][0].uid).toBe('head-uid')
  })

  it('Escape returns a root Reader to Desk', async () => {
    press('j'); press('Enter')
    expect(inside.workspace.isActive).toBe(true)
    await pop(() => { expect(press('Escape').defaultPrevented).toBe(true) })
    expect(inside.workspace.isActive).toBe(false)
    expect(inside.activeViewId).toBe('desk')
  })

  it('1 returns to Desk and Escape returns to Channels without replacing the Desk selection', async () => {
    press('j'); expect(selected()).toBe('review')
    inside.setView('channels')
    inside.openDocumentChannel(card({ id: 'd1', uid: 'd1' }))
    await settle()
    expect(inside.workspace.isActive).toBe(true)
    expect(press('1').defaultPrevented).toBe(true)
    expect(inside.activeViewId).toBe('desk')
    expect(inside.deskKeyboard.selection?.uid).toBe('review')
    expect(selected()).toBe('review')

    inside.setView('channels')
    inside.openDocumentChannel(card({ id: 'd1', uid: 'd1' }))
    await settle()
    expect(inside.workspace.isActive).toBe(true)
    await pop(() => { expect(press('Escape').defaultPrevented).toBe(true) })
    expect(inside.activeViewId).toBe('channels')
    expect(inside.deskKeyboard.selection?.uid).toBe('review')
  })

  it.each([
    ['h', {}], ['ArrowLeft', {}], ['‹', {}], ['ArrowLeft', { altKey: true }],
  ] as const)('%s and Escape both return to the non-Desk origin', async (key, init) => {
    inside.setView('channels')
    inside.openDocumentChannel(card({ id: 'd1', uid: 'd1' }))
    await settle()
    expect(inside.workspace.isActive).toBe(true)
    await pop(() => { expect(press(key, init).defaultPrevented).toBe(true) })
    expect(inside.workspace.isActive).toBe(false)
    expect(inside.activeViewId).toBe('channels')

    inside.openDocumentChannel(card({ id: 'd1', uid: 'd1' }))
    await settle()
    await pop(() => { expect(press('Escape').defaultPrevented).toBe(true) })
    expect(inside.workspace.isActive).toBe(false)
    expect(inside.activeViewId).toBe('channels')
  })

  it('puts the bar\'s Find away whole on Escape', () => {
    const find = document.querySelector<HTMLInputElement>('.kbn-viewtabs-find input')!
    find.focus(); find.value = 'mask'
    press('Escape', {}, find)
    expect(find.value).toBe('')
    expect(document.activeElement).not.toBe(find)
  })
  it('puts the bar\'s Find list away when a press goes into a framed page, which no listener of the board hears', async () => {
    const find = document.querySelector<HTMLInputElement>('.kbn-viewtabs-find input')!
    find.focus()
    await settle()
    expect(document.querySelector('.ws-find')).not.toBeNull()
    // A tapestry is an iframe: the press lands in its document, and all the board sees is its window losing focus to it.
    const tapestry = document.createElement('iframe')
    document.body.append(tapestry)
    tapestry.focus()
    window.dispatchEvent(new FocusEvent('blur'))
    expect(document.querySelector('.ws-find')).toBeNull()
    expect(find.getAttribute('aria-expanded')).toBe('false')
  })
  it('keeps the bar\'s Find chip when a press on the field\'s left edge is released over the chip it brought up', async () => {
    inside.openDocumentChannel(card({ id: 'd1', uid: 'd1' }))
    await settle()
    const find = document.querySelector<HTMLInputElement>('.kbn-viewtabs-find input')!
    const chip = document.querySelector<HTMLButtonElement>('.kbn-viewtabs-find .ws-find-chip')!
    find.focus()
    expect(chip.hidden).toBe(false)
    // The press went down on the field and came up on the chip that focus drew under it, so the browser clicks their label.
    find.closest('label')!.click()
    expect(chip.hidden).toBe(false)
    expect(document.activeElement).toBe(find)
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
    const find = document.querySelector<HTMLInputElement>('.ws-find-sheet input')!
    expect(document.activeElement).toBe(find)
    press('Escape', {}, find)
    expect(document.activeElement).toBe(previous)
    press('/')
    const input = document.querySelector<HTMLInputElement>('.ws-find-sheet input')!
    input.value = 'd1'; input.dispatchEvent(new Event('input'))
    press('Enter', {}, input)
    expect(inside.workspace.isActive).toBe(true)
    expect(window.location.hash).toContain('draft-uid')
  })
  it('moves through the sections without wrapping, g and G at a section\'s ends', () => {
    press('j'); expect(selected()).toBe('review')
    // A family of one that waits is its own line alone: one stop.
    expect(document.querySelector('.kbn-key-selected')!.hasAttribute('data-desk-line')).toBe(false)
    press('j'); expect(selected()).toBe('head-uid')
    press('G'); expect(selected()).toBe('working')
    press('g'); expect(selected()).toBe('head-uid')
    press('j'); press('j'); expect(selected()).toBe('draft-uid')
    press('G'); expect(selected()).toBe('d2')
    press('j'); expect(selected()).toBe('resting')
    press('G'); expect(selected()).toBe('resting')
    press('j'); expect(selected()).toBe('resting')
    press('h'); expect(selected()).toBeUndefined()
  })
  it('walks every card across the columns in both directions', () => {
    const walk = ['review', 'head-uid', 'working', 'draft-uid', 'd2', 'resting']
    for (const uid of walk) { press('j'); expect(selected()).toBe(uid) }
    press('j'); expect(selected()).toBe('resting')
    for (const uid of [...walk].reverse().slice(1)) { press('k'); expect(selected()).toBe(uid) }
    press('k'); expect(selected()).toBe('review')
  })
  it('opens the reader stepping the Desk\'s columns', async () => {
    press('j'); press('j'); press('Enter')
    expect((inside.workspace.reader as unknown as { deskCards(): Array<{ id: string; uid?: string }> }).deskCards().map(row => row.uid ?? row.id)).toEqual(['review', 'head-uid', 'working', 'draft-uid', 'd2', 'resting'])
    await pop(() => document.querySelector<HTMLButtonElement>('.ws-return')!.click())
    expect(inside.workspace.isActive).toBe(false)
  })
  it('survives refresh reorder and a path rename by uid+origin, not list position', () => {
    for (let n = 0; n < 4; n++) press('j')
    const updated = data()
    updated.now.drafts = [card({ id: 'd2' }), card({ id: 'renamed', uid: 'draft-uid' })]
    draw(updated)
    expect(selected()).toBe('draft-uid')
    expect(document.querySelector<HTMLElement>('.kbn-key-selected')?.dataset.fiberId).toBe('renamed')
    press('k'); expect(selected()).toBe('d2')
  })
  it.each([['j', 'working'], ['J', 'draft-uid']])('%s scans two stops and one Escape selects the last viewed Desk card', async (key, expected) => {
    press('j'); press('Enter')
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
    for (let n = 0; n < 5; n++) press('j')
    press('Enter')
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
    press('j'); expect(selected()).toBe('resting')
  })
  it('selects clicked cards and distinguishes identical uids on different origins', async () => {
    // Without a uid, one path on two hosts is two fibers.
    const updated = response({ now: { drafts: [card({ id: 'same', originId: 'a' }), card({ id: 'same', originId: 'b' })], inFlight: [], awaitingReview: [] } })
    draw(updated)
    document.querySelector<HTMLElement>('.kbn-family[data-card-origin="b"] .kbn-family-name')!.click()
    expect(document.querySelector<HTMLElement>('.kbn-key-selected')?.dataset.cardOrigin).toBe('b')
    await pop(() => document.querySelector<HTMLButtonElement>('.ws-return')!.click())
    updated.now.drafts.reverse()
    draw(updated)
    expect(document.querySelector<HTMLElement>('.kbn-key-selected')?.dataset.cardOrigin).toBe('b')
  })
  it('keeps focus on its row through a poll, and gives a removed row\'s focus to the row in its place', () => {
    const row = (uid: string) => document.querySelector(`[data-card-uid="${uid}"]`)
    press('j'); press('j')
    expect(document.activeElement).toBe(row('head-uid'))
    draw(data())
    expect(document.activeElement).toBe(row('head-uid'))
    const without = data()
    without.now.inFlight = without.now.inFlight.filter(card => card.uid !== 'head-uid')
    draw(without)
    expect(document.activeElement).toBe(row('working'))
    expect(selected()).toBe('working')
    press('j'); press('j'); press('j')
    expect(document.activeElement).toBe(row('resting'))
    const shorter = data()
    shorter.stash = []
    draw(shorter)
    expect(document.activeElement).toBe(row('d2'))
    expect(selected()).toBe('d2')
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
  it('pages the phone to the selected column, with reduced motion', () => {
    mobile = true; reduced = true
    draw(data())
    const pager = document.querySelector<HTMLElement>('.kbn-now-board')!
    Object.defineProperty(pager, 'clientWidth', { configurable: true, value: 390 })
    press('j')
    expect(scroll).toHaveBeenLastCalledWith({ left: 0, behavior: 'instant' })
    expect(intoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
    press('j')
    expect(selected()).toBe('head-uid')
    expect(scroll).toHaveBeenLastCalledWith({ left: 390, behavior: 'instant' })
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

  it('chooses the first movement target in Waiting on you, then Working, then the shelf', () => {
    press('ArrowDown'); expect(selected()).toBe('review')
    // With focus off the Desk, a selection the poll removes leaves no row to follow.
    press('u'); (document.activeElement as HTMLElement).blur()

    const flight = data()
    flight.stash = flight.stash.filter(each => each.id !== 'review')
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
    press('j')
    const focus = document.querySelector<HTMLElement>('.kbn-key-selected')!
    expect(document.activeElement).toBe(focus)
    press('?')
    await settle()
    const dialog = document.querySelector('[role="dialog"][aria-label="Keyboard shortcuts"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    await vi.waitFor(() => expect(focus.closest('[inert]')).not.toBeNull())
    expect([...dialog.querySelectorAll('h3')].map(el => el.textContent)).toEqual(['Everywhere', 'Moving', 'A constitution', 'Fiber page', "A constitution's view", 'Channels'])
    press('j'); expect(selected()).toBe('review')
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
