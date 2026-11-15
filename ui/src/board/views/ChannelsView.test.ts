// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { ChannelsView } from './ChannelsView.js'
import type { ViewContext } from './ViewRegistry.js'
import type { BoardRecord } from '../channels.js'
import type { SentFile } from '../sentFiles.js'
import { card, response, settle } from '../testFixtures.js'

const views: ChannelsView[] = []
afterEach(() => { views.forEach(view => view.unmount()); views.length = 0; document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const minute = 60_000, day = 86_400_000
const at = (minutes: number): string => new Date(Date.now() - minutes * minute).toISOString()
const working = (minutes: number) => ({ status: 'active' as const, workerState: 'running' as const, runtimePhase: 'working' as const, lastActivityAt: Date.now() - minutes * minute })
const idle = (minutes: number) => ({ status: 'active' as const, workerState: 'running' as const, runtimePhase: 'waiting' as const, lastActivityAt: Date.now() - minutes * minute })
// cmbx: a seated chair, an expert that posted, one asking, one at work saying nothing.
const chair = card({ id: 'cmbx', uid: 'C', name: 'cmbx chair', shuttleChannel: 'cmbx', shuttleSeat: true, ...idle(5) })
const tsz = card({ id: 'cmbx/tsz', uid: 'T', name: 'κ × tSZ', orchestrator: 'C', ...working(2) })
const mask = card({ id: 'cmbx/mask', uid: 'M', name: 'Cluster mask', orchestrator: 'C', status: 'active', ask: { text: 'Mask at 5σ or 3σ?', at: at(20) } })
const beam = card({ id: 'cmbx/beam', uid: 'B', name: 'Beam window', orchestrator: 'C', ...working(1) })
// A lone constitution asking; a quiet one idle for weeks.
const van = card({ id: 'van', uid: 'R', name: 'Moving house', status: 'active', ask: { text: 'Which van?', at: at(10) } })
const notes = card({ id: 'notes', uid: 'N', name: 'Old notes', status: 'open', modifiedAt: new Date(Date.now() - 20 * day).toISOString() })
const record = (over: Partial<BoardRecord> & Pick<BoardRecord, 'id' | 'kind' | 'fiber'>, minutes: number): BoardRecord => ({ by: { fiber: over.fiber }, timestamp: Date.now() - minutes * minute, ...over })
const BOARD: Record<string, BoardRecord[]> = {
  C: [
    record({ id: 'b1', kind: 'post', fiber: 'T', text: 'κ×tSZ is measured to **9σ**.', files: ['/notes/tsz/spectrum.png'] }, 30),
    record({ id: 'b2', kind: 'human', fiber: 'T', by: { label: 'Sam' }, text: 'Show the nulls too?' }, 25),
    record({ id: 'b3', kind: 'asked', fiber: 'M', text: 'Mask at 5σ or 3σ?' }, 20),
    record({ id: 'b4', kind: 'post', fiber: 'C', text: 'Two calls for you today.' }, 12),
  ],
}

/** A daemon that answers the Channels view's reads, records its writes, and fails the ones `fail` names. */
function daemon(fail: string[] = [], stored = new Map<string, string>(), pinned: Record<string, number> = {}, kept: { dismissed?: string[]; order?: { keys: string[]; at: number } } = {}) {
  const posts: Array<[string, Record<string, unknown>]> = [], families: string[] = []
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push([url, JSON.parse(String(init.body))])
      if (fail.some(path => url.endsWith(path))) return new Response('{"error":"disk full"}', { status: 422 })
      return new Response(JSON.stringify(answer))
    }
    if (url.includes('/channels/dismissed')) return new Response(JSON.stringify({ dismissed: kept.dismissed ?? [], pinned, order: kept.order ?? null, reach_ms: 14 * day }))
    if (url.includes('/board/family')) {
      const params = new URL(url, 'http://test').searchParams
      families.push(params.get('fiber')!)
      return new Response(JSON.stringify({ records: (BOARD[params.get('fiber')!] ?? []).filter(each => each.timestamp >= Number(params.get('since_ms'))) }))
    }
    if (url.includes('/roles')) return new Response('[]')
    if (url.includes('/file-info')) return new Response(JSON.stringify({ exists: false }))
    return new Response('{}')
  }))
  return { posts, stored, families }
}
const board = (inFlight: ReturnType<typeof card>[]) => response({ now: { drafts: [], inFlight, awaitingReview: [] } })
const sentDoc = (uid: string, path: string, minutes: number, fiber = card({ id: uid, uid, name: uid })) =>
  ({ card: fiber, receipt: { uid, key: `host:${path}`, owner: 'host', host: 'host', fullPath: path, basename: path.split('/').at(-1)!, timestamp: Date.now() - minutes * minute } })
const library = [sentDoc('old', '/notes/old/lensing-notes.md', 600, card({ id: 'old', uid: 'old', name: 'Lensing notes' }))]
async function mount(inFlight = [chair, tsz, mask, beam, van, notes], view = new ChannelsView(), sent: SentFile[] = [], prepare?: (host: HTMLElement) => void) {
  const openFromDesk = vi.fn(), openPage = vi.fn(), requestRefresh = vi.fn(), see = vi.fn()
  const workspace = {
    openFromDesk, openPage,
    library: { subscribe: () => () => {}, visit: () => {}, cancelOpen: vi.fn(), documents: () => library, receipts: () => [] },
  }
  const sends = { files: sent, subscribe: () => () => {}, refresh: async () => {} }
  const ctx = { cards: [], response: board(inFlight), shuttleBase: '', workspace, sends, requestRefresh, openCard: vi.fn(), see } as unknown as ViewContext
  const host = document.createElement('div'); document.body.append(host)
  prepare?.(host)
  views.push(view); view.mount(host, ctx)
  await settle(); await settle(); await settle()
  const [reply, threadReply] = host.querySelectorAll<HTMLTextAreaElement>('.kbn-ch-reply-text')
  return { view, ctx, host, reply, threadReply, openFromDesk, openPage, requestRefresh, see }
}
const rail = (host: HTMLElement) => [...host.querySelectorAll('.kbn-ch-pick-name')].map(el => el.textContent)
const shown = (host: HTMLElement) => host.querySelector('.kbn-ch-name')?.textContent
const stream = (host: HTMLElement) => [...host.querySelectorAll('.kbn-ch .kbn-ch-msg')].map(el => [el.querySelector('.kbn-ch-msg-name')?.textContent, el.getAttribute('data-kind'), el.hasAttribute('data-waiting')])
const message = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLElement>('.kbn-ch .kbn-ch-msg')].find(el => el.querySelector('.kbn-ch-msg-name')?.textContent === name)!
const to = (form: number, host: HTMLElement) => host.querySelectorAll('.kbn-ch-reply-to')[form]?.textContent

it('lists the recent channels, the newest wait first, and reads a channel as a short stream: each worker once, the chair in full', async () => {
  const { families } = daemon()
  const { view, host, see } = await mount()
  expect(rail(host)).toStrictEqual(['cmbx', 'Moving house'])
  expect(host.querySelector('[data-channel="channel:cmbx"]')!.hasAttribute('data-waiting')).toBe(true)
  expect(families).toContain('C')
  expect(shown(host)).toBe('cmbx')
  expect(stream(host)).toStrictEqual([['κ × tSZ', 'post', false], ['Cluster mask', 'ask', true], ['cmbx chair', 'post', false]])
  // A worker's line is its message whole, with its files and its thread's size.
  const post = message(host, 'κ × tSZ')
  expect(post.querySelector('.kbn-ch-msg-text strong')?.textContent).toBe('9σ')
  expect(post.querySelector('.kbn-ch-image img')?.getAttribute('src')).toContain('spectrum.png')
  expect(post.querySelector('.kbn-ch-replies')?.textContent).toMatch(/^1 reply · last /)
  expect(to(0, host)).toBe('cmbx chair')
  expect(see).toHaveBeenLastCalledWith(chair)
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'j' }))).toBe(true)
  expect(shown(host)).toBe('Moving house')
  expect(stream(host)).toStrictEqual([['Moving house', 'ask', true]])
})

it('opens a worker\'s thread from its message: its name, liveness and ask on top, its history, a reply to it', async () => {
  const { posts } = daemon()
  const { view, host, threadReply, openPage, requestRefresh } = await mount()
  const thread = host.querySelector<HTMLElement>('.kbn-ch-thread')!
  expect(thread.hidden).toBe(true)
  message(host, 'κ × tSZ').querySelector<HTMLElement>('.kbn-ch-msg-body')!.click()
  expect(thread.hidden).toBe(false)
  expect(host.querySelector('.kbn-ch-layout')!.hasAttribute('data-thread')).toBe(true)
  expect([thread.querySelector('.kbn-ch-thread-name')?.textContent, thread.querySelector('.kbn-ch-liveness')?.textContent]).toStrictEqual(['κ × tSZ', 'working'])
  expect([...thread.querySelectorAll('.kbn-ch-msg')].map(el => [el.querySelector('.kbn-ch-msg-name')?.textContent, el.getAttribute('data-kind')])).toStrictEqual([['κ × tSZ', 'post'], ['You', 'reply']])
  expect(thread.querySelector('.kbn-ch-thread-ask, .kbn-ch-conclusion')).toBeNull()
  thread.querySelector<HTMLButtonElement>('.kbn-ch-thread-name')!.click()
  expect(openPage).toHaveBeenLastCalledWith(tsz, undefined)
  expect(to(1, host)).toBe('κ × tSZ')
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true)
  expect(document.activeElement).toBe(threadReply)
  threadReply.value = 'Show the nulls.'
  threadReply.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await settle()
  expect(posts).toStrictEqual([['/api/v1/deliver', { fiber_id: 'cmbx/tsz', origin: 'local', text: 'Show the nulls.', from: 'human', message_id: expect.stringMatching(/^human-[0-9a-f]{32}$/) }]])
  expect(requestRefresh).toHaveBeenCalled()
  expect(threadReply.value).toBe('')
  // The reply stands in the thread until the board carries it, and not in the channel.
  expect([...thread.querySelectorAll('.kbn-ch-msg[data-human] .kbn-ch-msg-text')].map(el => el.textContent?.trim())).toContain('Show the nulls.')
  expect(stream(host).map(([name]) => name)).not.toContain('You')
  // An asking worker's thread shows its ask on top; Escape closes the thread.
  message(host, 'Cluster mask').querySelector<HTMLElement>('.kbn-ch-msg-name')!.click()
  expect(thread.querySelector('.kbn-ch-thread-ask')?.textContent?.trim()).toBe('Mask at 5σ or 3σ?')
  ;(document.activeElement as HTMLElement | null)?.blur()
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true)
  expect(thread.hidden).toBe(true)
})

it('opens a thread in the channel\'s place, with a way back, when the view is too narrow for both', async () => {
  daemon()
  const widths: Array<(entries: Array<{ contentRect: { width: number } }>) => void> = []
  vi.stubGlobal('ResizeObserver', class { constructor(seen: (typeof widths)[number]) { widths.push(seen) } observe() {} unobserve() {} disconnect() {} })
  const { host } = await mount()
  const layout = host.querySelector('.kbn-ch-layout')!
  widths.forEach(seen => seen([{ contentRect: { width: 750 } }]))
  expect(layout.hasAttribute('data-narrow')).toBe(true)
  message(host, 'κ × tSZ').click()
  expect(layout.hasAttribute('data-thread')).toBe(true)
  const back = host.querySelector<HTMLButtonElement>('.kbn-ch-thread-close')!
  expect(back.textContent).toBe('‹ cmbx')
  back.click()
  expect(layout.hasAttribute('data-thread')).toBe(false)
  // Wide again, a thread stands beside the channel.
  widths.forEach(seen => seen([{ contentRect: { width: 1400 } }]))
  message(host, 'κ × tSZ').click()
  expect([layout.hasAttribute('data-narrow'), host.querySelector('.kbn-ch-thread-close')!.textContent]).toStrictEqual([false, 'Close'])
})

it('shows a closed fiber\'s outcome as its conclusion, and an open one\'s not at all', async () => {
  daemon()
  const done = card({ id: 'cmbx/cov', uid: 'V', name: 'Covariance', orchestrator: 'C', column: 'tempered', status: 'closed', closedAt: at(40), outcome: 'Validated against 2000 simulations.' })
  BOARD.C.push(record({ id: 'b5', kind: 'post', fiber: 'V', text: 'The covariance is validated.' }, 40))
  try {
    const { host } = await mount([chair, { ...tsz, outcome: 'Working on the final pass.' }, done])
    message(host, 'Covariance').click()
    expect([host.querySelector('.kbn-ch-liveness')?.textContent, host.querySelector('.kbn-ch-conclusion')?.textContent?.trim()]).toStrictEqual(['closed', 'Validated against 2000 simulations.'])
    message(host, 'κ × tSZ').click()
    expect(host.querySelector('.kbn-ch-conclusion')).toBeNull()
    expect(host.querySelector('.kbn-ch-thread')!.textContent).not.toContain('Working on the final pass.')
  } finally { BOARD.C.pop() }
})

it('replies in the channel to its chair; keeps each box\'s draft by whom it goes to; keeps the words when a reply fails', async () => {
  const { posts } = daemon(['/api/v1/deliver'])
  const { view, host, reply, threadReply } = await mount()
  reply.value = 'Half a thought'
  message(host, 'κ × tSZ').click()
  threadReply.value = 'For the thread'
  view.keydown(new KeyboardEvent('keydown', { key: 'j' }))
  expect([reply.value, threadReply.value]).toStrictEqual(['', ''])
  view.keydown(new KeyboardEvent('keydown', { key: 'k' }))
  expect(reply.value).toBe('Half a thought')
  message(host, 'κ × tSZ').click()
  expect(threadReply.value).toBe('For the thread')
  reply.value = 'Keep going.'
  host.querySelector<HTMLFormElement>('.kbn-ch-reply')!.requestSubmit()
  await settle()
  expect(posts.at(-1)).toStrictEqual(['/api/v1/deliver', { fiber_id: 'cmbx', origin: 'local', text: 'Keep going.', from: 'human', message_id: expect.stringMatching(/^human-[0-9a-f]{32}$/) }])
  expect(reply.value).toBe('Keep going.')
  expect(host.querySelector('.kbn-ch-note')?.textContent).toContain('Not sent')
})

it('sets a waiting channel aside, pins and unpins, and restores a write that fails', async () => {
  const { posts } = daemon()
  const { host } = await mount()
  host.querySelector<HTMLButtonElement>('.kbn-ch-later')!.click()
  await settle()
  // The newest wait is the chair's, idle at the end of its turn.
  expect(posts[0][0]).toBe('/api/v1/channels/dismiss')
  expect(posts[0][1]).toMatchObject({ key: `office:channel:cmbx:${chair.lastActivityAt}`, fiber: 'C' })
  // The mark clears; cmbx stays in the rail, active this week.
  expect(host.querySelector('[data-channel="channel:cmbx"]')!.hasAttribute('data-waiting')).toBe(false)
  expect(host.querySelector('.kbn-ch-later')).toBeNull()
  host.querySelector<HTMLButtonElement>('.kbn-ch-pin')!.click()
  await settle()
  expect(posts.at(-1)).toStrictEqual(['/api/v1/channels/pin', { key: 'channel:cmbx', fiber: 'C' }])
  daemon(['/api/v1/channels/dismiss'])
  host.querySelector<HTMLButtonElement>('.kbn-ch-unpin')!.click()
  expect(host.querySelector('.kbn-ch-pin')).not.toBeNull()
  await settle()
  expect(host.querySelector('.kbn-ch-note')?.textContent).toContain('could not be unpinned')
})

it('jumps to a channel the rail no longer lists, and to the fleet\'s documents; opening one brings it back', async () => {
  const { stored } = daemon()
  const { view, host, openPage } = await mount()
  const jump = host.querySelector<HTMLInputElement>('.kbn-ch-jump')!
  jump.value = 'old'
  jump.dispatchEvent(new Event('input'))
  expect(rail(host)).toStrictEqual(['Old notes'])
  expect([...host.querySelectorAll('.kbn-ch-doclist .kbn-ch-doc-name')].map(el => el.textContent)).toStrictEqual(['lensing-notes.md'])
  host.querySelector<HTMLButtonElement>('.kbn-ch-doclist .kbn-ch-doc')!.click()
  expect(openPage).toHaveBeenLastCalledWith(library[0].card, 'host:/notes/old/lensing-notes.md')
  jump.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  expect(shown(host)).toBe('Old notes')
  expect(stored.has('shuttle.channels.seen:fiber:N')).toBe(true)
  view.find('')
  expect(rail(host)).toStrictEqual(['cmbx', 'Moving house', 'Old notes'])
  // A new mount finds it listed, opened this week.
  view.unmount(); views.length = 0
  const again = await mount(undefined, new ChannelsView())
  expect(rail(again.host)).toStrictEqual(['cmbx', 'Moving house', 'Old notes'])
  expect(again.host.querySelector<HTMLInputElement>('.kbn-ch-jump')!.value).toBe('')
})

it('floats what waits above the human\'s order, and moves a channel by Alt and the arrows, by its menu and to the bottom', async () => {
  const science = card({ id: 'science', uid: 'S', name: 'Science desk', shuttleChannel: 'Science', ...working(3) })
  const french = card({ id: 'french', uid: 'F', name: 'French lessons', shuttleChannel: 'French', ...working(4) })
  const { posts } = daemon([], undefined, {}, { order: { keys: ['channel:science', 'channel:french'], at: Date.now() - day } })
  const { view, ctx, host } = await mount([chair, tsz, mask, beam, van, notes, science, french])
  // What waits on the human first, its newest wait first; then the stored order.
  expect(rail(host)).toStrictEqual(['cmbx', 'Moving house', 'Science', 'French'])
  const pick = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('.kbn-ch-pick')].find(el => el.querySelector('.kbn-ch-pick-name')?.textContent === name)!
  const press = (name: string, key: string, over: KeyboardEventInit = {}) => pick(name).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...over }))
  press('Science', 'ArrowDown', { altKey: true })
  await settle()
  // Every channel's place is written, the ones out of the rail and the waiting ones keeping theirs.
  expect(posts.at(-1)).toStrictEqual(['/api/v1/channels/order', { keys: ['channel:cmbx', 'fiber:R', 'fiber:N', 'channel:french', 'channel:science'] }])
  expect(rail(host)).toStrictEqual(['cmbx', 'Moving house', 'French', 'Science'])
  // Nothing moves above what waits, and a waiting channel does not move at all.
  press('French', 'ArrowUp', { altKey: true })
  press('cmbx', 'ArrowDown', { altKey: true })
  await settle()
  expect(posts.filter(([url]) => url.endsWith('/order'))).toHaveLength(1)
  // The context-menu key opens the entry's menu; Move to bottom puts it last.
  press('French', 'ContextMenu')
  await settle()
  const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(items().map(item => item.textContent)).toStrictEqual(['Hide', 'Pin', 'Move to bottom'])
  items()[2].click()
  await settle()
  expect(posts.at(-1)).toStrictEqual(['/api/v1/channels/order', { keys: ['channel:cmbx', 'fiber:R', 'fiber:N', 'channel:science', 'channel:french'] }])
  expect(rail(host)).toStrictEqual(['cmbx', 'Moving house', 'Science', 'French'])
  // A poll keeps the order written here until the feed carries a newer one.
  view.refresh(ctx); await settle()
  expect(rail(host)).toStrictEqual(['cmbx', 'Moving house', 'Science', 'French'])
})

it('hides a channel by its menu; Jump to finds it, marked, and opening it brings it back', async () => {
  const { posts } = daemon()
  const { view, host } = await mount()
  const pick = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('.kbn-ch-pick')].find(el => el.querySelector('.kbn-ch-pick-name')?.textContent === name)!
  pick('Moving house').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  await settle()
  ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Hide')!.click()
  await settle()
  expect(posts.at(-1)?.[0]).toBe('/api/v1/channels/dismiss')
  expect(posts.at(-1)?.[1]).toMatchObject({ key: expect.stringMatching(/^hide:fiber:R:\d+$/), fiber: 'R' })
  expect(rail(host)).toStrictEqual(['cmbx'])
  view.find('mov')
  expect(rail(host)).toStrictEqual(['Moving house'])
  expect(pick('Moving house').querySelector('.kbn-ch-pick-hidden')?.textContent).toBe('hidden')
  // Its menu offers to bring it back.
  pick('Moving house').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  await settle()
  expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toStrictEqual(['Unhide', 'Pin', 'Move to bottom'])
  ;(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await settle()
  expect(document.querySelector('[role="menu"]')).toBeNull()
  pick('Moving house').click()
  await settle()
  expect(posts.at(-1)?.[1]).toMatchObject({ key: expect.stringMatching(/^show:fiber:R:\d+$/) })
  expect(rail(host)).toStrictEqual(['cmbx', 'Moving house'])
})

it('brings a hidden channel back by itself when something in it begins waiting after the hide', async () => {
  daemon([], undefined, {}, { dismissed: [`hide:fiber:R:${Date.now() - 15 * minute}`] })
  const { view, ctx, host } = await mount()
  // The van asked ten minutes ago, after the hide.
  expect(rail(host)).toStrictEqual(['cmbx', 'Moving house'])
  daemon([], undefined, {}, { dismissed: [`hide:fiber:R:${Date.now() - 5 * minute}`] })
  view.refresh(ctx); await settle(); await settle()
  expect(rail(host)).toStrictEqual(['cmbx'])
})

it('marks unread channels bold, and rules off what arrived since the last visit', async () => {
  const stored = new Map([['shuttle.channels.seen:channel:cmbx', String(Date.now() - 19 * minute)], ['shuttle.channels.seen:fiber:R', String(Date.now() - 5 * minute)]])
  daemon([], stored)
  const { view, host } = await mount()
  const items = () => [...host.querySelectorAll<HTMLElement>('.kbn-ch-stream > li')].map(el => el.classList.contains('kbn-ch-new') ? 'new' : el.querySelector('.kbn-ch-msg-name')?.textContent)
  expect(items()).toStrictEqual(['κ × tSZ', 'Cluster mask', 'new', 'cmbx chair'])
  expect(host.querySelector('[data-channel="fiber:R"]')!.hasAttribute('data-unread')).toBe(false)
  view.keydown(new KeyboardEvent('keydown', { key: 'j' }))
  expect(host.querySelector('[data-channel="channel:cmbx"]')!.hasAttribute('data-unread')).toBe(false)
})

it('hides and shows the rail by its button, by [ and by sideways swipes, closes a thread by a swipe, and remembers the rail', async () => {
  const { stored } = daemon()
  const { view, host } = await mount()
  const layout = host.querySelector('.kbn-ch-layout')!, toggle = host.querySelector<HTMLButtonElement>('.kbn-ch-rail-toggle')!
  expect([layout.hasAttribute('data-rail-hidden'), toggle.textContent]).toStrictEqual([false, 'Hide channels'])
  toggle.click()
  expect([layout.hasAttribute('data-rail-hidden'), toggle.textContent, toggle.getAttribute('aria-expanded')]).toStrictEqual([true, 'Show channels', 'false'])
  expect(stored.get('shuttle.channels.rail-hidden')).toBe('1')
  expect(view.keydown(new KeyboardEvent('keydown', { key: '[' }))).toBe(true)
  expect(layout.hasAttribute('data-rail-hidden')).toBe(false)
  const swipe = (on: Element, from: number, to: number) => {
    on.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), { touches: [{ clientX: from, clientY: 300 }] }))
    on.dispatchEvent(Object.assign(new Event('touchend', { bubbles: true }), { changedTouches: [{ clientX: to, clientY: 310 }] }))
  }
  const streamEl = host.querySelector('.kbn-ch .kbn-ch-stream')!
  swipe(streamEl, 300, 180)
  expect(layout.hasAttribute('data-rail-hidden')).toBe(true)
  swipe(streamEl, 200, 320)
  expect(layout.hasAttribute('data-rail-hidden')).toBe(false)
  message(host, 'κ × tSZ').click()
  swipe(host.querySelector('.kbn-ch-thread-list')!, 100, 320)
  expect(layout.hasAttribute('data-thread')).toBe(false)
  const wheel = (on: Element, deltaX: number) => { const event = Object.assign(new Event('wheel', { bubbles: true, cancelable: true }), { deltaX, deltaY: 2 }); on.dispatchEvent(event); return event.defaultPrevented }
  expect(wheel(streamEl, 80)).toBe(true)
  expect(layout.hasAttribute('data-rail-hidden')).toBe(true)
  view.unmount(); views.length = 0
  const again = await mount(undefined, new ChannelsView())
  expect(again.host.querySelector('.kbn-ch-layout')!.hasAttribute('data-rail-hidden')).toBe(true)
})

it('attaches a file sent near a message to it, gives a file sent alone its own message, and opens files in the reader', async () => {
  daemon()
  const sent: SentFile[] = [
    { uid: 'M', host: 'local', fullPath: '/notes/mask/residual.png', basename: 'residual.png', timestamp: Date.now() - 21 * minute },
    { uid: 'B', host: 'local', fullPath: '/notes/beam/beam.md', basename: 'beam.md', timestamp: Date.now() - 3 * minute },
    { uid: 'T', host: 'local', fullPath: '/notes/tsz/spectrum.png', basename: 'spectrum.png', timestamp: Date.now() - 30 * minute },
  ]
  const { host, openPage } = await mount(undefined, new ChannelsView(), sent)
  expect(stream(host).map(([name, kind]) => [name, kind])).toStrictEqual([['κ × tSZ', 'post'], ['Cluster mask', 'ask'], ['cmbx chair', 'post'], ['Beam window', 'file']])
  expect([...message(host, 'Cluster mask').querySelectorAll('.kbn-ch-image img')].map(img => img.getAttribute('alt'))).toStrictEqual(['residual.png'])
  // The post's own file is not sent again as a message of its own.
  expect(host.querySelectorAll('.kbn-ch img[alt="spectrum.png"]').length).toBe(1)
  message(host, 'Beam window').querySelector<HTMLButtonElement>('.kbn-ch-file')!.click()
  expect(openPage).toHaveBeenLastCalledWith(beam, 'local:/notes/beam/beam.md')
})

it('keeps focus on its item across a poll, draws nothing under the reader, and returns focus where the reader was opened', async () => {
  daemon()
  const { view, ctx, host, openPage, reply } = await mount()
  const workspace = ctx.workspace as unknown as { isActive: boolean }
  const image = () => host.querySelector<HTMLButtonElement>('.kbn-ch .kbn-ch-image')!
  image().focus()
  view.refresh(ctx); await settle()
  expect(document.activeElement).toBe(image())
  image().click()
  expect(openPage).toHaveBeenCalled()
  workspace.isActive = true
  const before = image()
  view.refresh(ctx); await settle()
  expect(image()).toBe(before)
  ;(document.activeElement as HTMLElement | null)?.blur()
  workspace.isActive = false
  view.refresh(ctx)
  expect(document.activeElement).toBe(image())
  workspace.isActive = true; view.refresh(ctx); workspace.isActive = false; view.refresh(ctx)
  expect(document.activeElement).toBe(reply)
})

it('opens a channel on its newest message and follows new ones, unless the reader has scrolled up; only the stream scrolls', async () => {
  daemon()
  let top = 0, page = 0
  const prepare = (host: HTMLElement): void => {
    Object.defineProperty(host, 'scrollTop', { get: () => page, set: (value: number) => { page = value } })
  }
  const streamOnly = (get: (list: HTMLElement) => number) => function (this: HTMLElement) { return this.matches('.kbn-ch > .kbn-ch-stream') ? get(this) : 0 }
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(streamOnly(list => 100 * list.children.length))
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(streamOnly(() => 200))
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) { return this.matches('.kbn-ch > .kbn-ch-stream') ? top : 0 })
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: Element, value: number) {
    if (this.matches('.kbn-ch > .kbn-ch-stream')) top = Math.max(0, Math.min(value, 100 * this.children.length - 200))
  })
  const { view, ctx, host } = await mount(undefined, new ChannelsView(), [], prepare)
  // Three messages, 300 px, 200 in view.
  expect(top).toBe(100)
  const arrive = async (n: number) => {
    const more = Array.from({ length: n }, (_, i) => card({ id: `new${i}`, uid: `N${i}`, name: `New ${i}`, orchestrator: 'C', status: 'active', ask: { text: `Question ${i}?`, at: at(1) } }))
    ctx.response = board([chair, tsz, mask, beam, ...more, van])
    view.refresh(ctx); await settle()
  }
  await arrive(1)
  expect(top).toBe(200)
  // The reader scrolls up: they keep their place as more arrive.
  top = 50
  host.querySelector('.kbn-ch > .kbn-ch-stream')!.dispatchEvent(new Event('scroll'))
  await arrive(2)
  expect(top).toBe(50)
  view.keydown(new KeyboardEvent('keydown', { key: 'j' }))
  expect(top).toBe(0)
  view.keydown(new KeyboardEvent('keydown', { key: 'k' }))
  expect(top).toBe(300)
  expect(page).toBe(0)
})
