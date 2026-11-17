// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { layTube } from '../tube.js'
import { ChannelsView } from './ChannelsView.js'
import type { ViewContext } from './ViewRegistry.js'
import { BoardFeed, type BoardRecord } from '../boardFeed.js'
import type { SentFile } from '../sentFiles.js'
import { card, response, settle } from '../testFixtures.js'
import { Dock, type ConsoleOptions } from '../workspace/Dock.js'

vi.mock('../tube.js', async original => {
  const tube = await original<typeof import('../tube.js')>()
  return { ...tube, layTube: vi.fn(tube.layTube) }
})

const views: ChannelsView[] = []
afterEach(() => { views.forEach(view => view.unmount()); views.length = 0; document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const minute = 60_000, day = 86_400_000
const at = (minutes: number): string => new Date(Date.now() - minutes * minute).toISOString()
const working = (minutes: number) => ({ status: 'active' as const, workerState: 'running' as const, runtimePhase: 'working' as const, shuttleKind: 'oneshot' as const, sessionUuid: 'session', lastActivityAt: Date.now() - minutes * minute })
const idle = (minutes: number) => ({ status: 'active' as const, workerState: 'running' as const, runtimePhase: 'waiting' as const, shuttleKind: 'oneshot' as const, sessionUuid: 'session', lastActivityAt: Date.now() - minutes * minute })
// cmbx: a seated chair, an expert that sent a plot, one asking, one at work saying nothing.
const chair = card({ id: 'cmbx', uid: 'C', name: 'cmbx chair', shuttleChannel: 'cmbx', shuttleSeat: true, shuttleProjectDir: '/p', ...idle(5) })
const tsz = card({ id: 'cmbx/tsz', uid: 'T', name: 'κ × tSZ', orchestrator: 'C', ...working(2) })
const mask = card({ id: 'cmbx/mask', uid: 'M', name: 'Cluster mask', orchestrator: 'C', shuttleKind: 'oneshot', status: 'active', ask: { text: 'Mask at **5σ** or 3σ?', at: at(20) } })
const beam = card({ id: 'cmbx/beam', uid: 'B', name: 'Beam window', orchestrator: 'C', ...working(1) })
// A lone constitution asking; a quiet one idle for weeks.
const van = card({ id: 'van', uid: 'R', name: 'Moving house', status: 'active', ask: { text: 'Which van?', at: at(30) } })
const notes = card({ id: 'notes', uid: 'N', name: 'Old notes', status: 'open', modifiedAt: new Date(Date.now() - 20 * day).toISOString() })
const record = (over: Partial<BoardRecord> & Pick<BoardRecord, 'id' | 'kind' | 'fiber'>, minutes: number): BoardRecord => ({ by: { fiber: over.fiber }, timestamp: Date.now() - minutes * minute, originName: 'local', ...over })
const BOARD: Record<string, BoardRecord[]> = {
  C: [
    record({ id: 'b1', kind: 'post', fiber: 'T', text: 'κ×tSZ is measured to 9σ.' }, 30),
    record({ id: 'brd-human-b2', kind: 'human', fiber: 'T', by: { label: 'human' }, text: 'Show the nulls too?' }, 25),
    record({ id: 'b3', kind: 'asked', fiber: 'M', to: { fiber: 'C' }, text: 'Mask at **5σ** or 3σ?' }, 20),
    record({ id: 'b4', kind: 'handed_off', fiber: 'B' }, 3),
  ],
}
const SENT: SentFile[] = [
  { fullPath: '/w/tsz/spectrum.svg', basename: 'spectrum.svg', uid: 'T', host: 'local', timestamp: Date.now() - 15 * minute, caption: 'The spectrum at 9σ.' },
  { fullPath: '/w/tsz/deck.html', basename: 'deck.html', uid: 'T', host: 'local', timestamp: Date.now() - 14 * minute },
  { fullPath: '/w/tsz/nulls.md', basename: 'nulls.md', uid: 'T', host: 'local', timestamp: Date.now() - 14 * minute },
]

/** A daemon that answers the Channels view's reads, records its writes, and fails the ones `fail` names. */
function daemon(fail: string[] = [], stored = new Map<string, string>(), pinned: Record<string, number> = {}, kept: { dismissed?: string[]; order?: { keys: string[]; at: number }; board?: Record<string, BoardRecord[]>; waiting?: Record<string, { id: string; at: number }> } = {}) {
  const posts: Array<[string, Record<string, unknown>]> = [], families: string[] = []
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push([url, JSON.parse(String(init.body))])
      if (fail.some(path => url.endsWith(path))) return new Response('{"error":"disk full"}', { status: 422 })
      return new Response('{"ok":true}')
    }
    if (url.includes('/channels/dismissed')) return new Response(JSON.stringify({ dismissed: kept.dismissed ?? [], pinned, order: kept.order ?? null, reach_ms: 14 * day }))
    if (url.includes('/board/family')) {
      const params = new URL(url, 'http://test').searchParams
      families.push(params.get('fiber')!)
      return new Response(JSON.stringify({ family: { uid: params.get('fiber') }, records: ((kept.board ?? BOARD)[params.get('fiber')!] ?? []).filter(each => each.timestamp >= Number(params.get('since_ms'))), reach_ms: 14 * day, waiting: kept.waiting ?? {} }))
    }
    return new Response('{}')
  }))
  return { posts, stored, families }
}
const board = (inFlight: ReturnType<typeof card>[]) => response({ now: { drafts: [], inFlight, awaitingReview: [] } })
const sentDoc = (uid: string, path: string, minutes: number, fiber = card({ id: uid, uid, name: uid })) =>
  ({ card: fiber, receipt: { uid, key: `host:${path}`, owner: 'host', host: 'host', fullPath: path, basename: path.split('/').at(-1)!, timestamp: Date.now() - minutes * minute } })
const library = [sentDoc('old', '/notes/old/lensing-notes.md', 600, card({ id: 'old', uid: 'old', name: 'Lensing notes' }))]
async function mount(inFlight = [chair, tsz, mask, beam, van, notes], view = new ChannelsView(), sent: SentFile[] = SENT, launches: Record<string, number[]> = { T: [Date.now() - 40 * minute] }) {
  const openFromDesk = vi.fn(), openPage = vi.fn(), requestRefresh = vi.fn(), see = vi.fn(async () => false)
  const workspace = {
    openFromDesk, openPage, look: see, isActive: false,
    console: (options: ConsoleOptions) => new Dock('', requestRefresh, undefined, undefined, options),
    library: { subscribe: () => () => {}, cancelOpen: vi.fn(), documents: () => library },
    board: new BoardFeed(''), charterNames: new Map(), said: () => undefined,
    globeHost: { feeds: { marks: (each: { uid?: string }) => ({ launches: launches[each.uid!] ?? [], commits: [] }), reach: () => 14 * day, files: () => [], lead: async () => undefined, refresh: () => {} } },
  }
  const sends = { files: sent, subscribe: () => () => {}, refresh: async () => {} }
  const ctx = { cards: [], response: board(inFlight), shuttleBase: '', workspace, sends, requestRefresh, openCard: vi.fn() } as unknown as ViewContext
  const host = document.createElement('div'); document.body.append(host)
  views.push(view); view.mount(host, ctx)
  await settle(); await settle(); await settle()
  return { view, ctx, host, openFromDesk, openPage, see }
}
const rail = (host: HTMLElement) => [...host.querySelectorAll('.kbn-ch-pick-name')].map(el => el.textContent)
const shown = (host: HTMLElement) => host.querySelector('.kbn-ch-name')?.textContent
/** The stream as drawn: each item's slug, kind and whether it waits; each station's slug and what it marks. */
const stream = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.kbn-ch-stream > li[data-slug]')].map(el => el.dataset.what
  ? [el.dataset.slug, el.dataset.what]
  : [el.dataset.slug, el.dataset.kind, el.hasAttribute('data-waiting')])
const item = (host: HTMLElement, who: string) => [...host.querySelectorAll<HTMLElement>('.kbn-ch-item')].find(el => el.dataset.slug === who)!

it('lists the recent channels, the newest wait first, and reads a channel as what was addressed to the human with its threads\' lines between', async () => {
  const { families } = daemon()
  const { view, host } = await mount()
  expect(rail(host)).toStrictEqual(['cmbx', 'van'])
  expect(host.querySelector('[data-channel="channel:cmbx"]')!.hasAttribute('data-waiting')).toBe(true)
  expect(families).toContain('C')
  expect(shown(host)).toBe('cmbx')
  // Posts and the human's lines stay out; the expert's files are one item on its line, the mask's ask waits, the beam's hand-off is a tick.
  expect(stream(host)).toStrictEqual([['tsz', 'start'], ['mask', 'ask', true], ['tsz', 'file', false], ['beam', 'tick']])
  expect(item(host, 'mask').querySelector('.kbn-ch-item-text strong')?.textContent).toBe('5σ')
  expect(item(host, 'mask').querySelector('.kbn-ch-kind')?.textContent).toBe('asks')
  // Its files are previews in one sideways row below its words, every kind of file alike.
  const files = item(host, 'tsz').querySelectorAll('.kbn-ch-previews .uf-row > .uf-card')
  expect([[...files].map(file => file.getAttribute('aria-label')), item(host, 'tsz').querySelector('.kbn-ch-previews')!.hasAttribute('data-several')]).toStrictEqual([['Expand spectrum.svg', 'Expand deck.html', 'Expand nulls.md'], true])
  expect(item(host, 'tsz').querySelector('.kbn-ch-item-text')?.textContent?.trim()).toBe('The spectrum at 9σ.')
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'j' }))).toBe(true)
  expect(shown(host)).toBe('van')
  expect(stream(host)).toStrictEqual([['van', 'ask', true]])
})

it('opening, paging and returning to a channel look at nothing; clicking an item opens its constitution\'s view, a file unfolds in place', async () => {
  daemon()
  const { view, ctx, host, see, openFromDesk, openPage } = await mount()
  view.keydown(new KeyboardEvent('keydown', { key: 'j' }))
  view.keydown(new KeyboardEvent('keydown', { key: 'k' }))
  host.querySelector<HTMLButtonElement>('[data-channel="fiber:R"]')!.click()
  host.querySelector<HTMLButtonElement>('[data-channel="channel:cmbx"]')!.click()
  view.refresh(ctx); await settle()
  window.dispatchEvent(new Event('focus'))
  expect(see).not.toHaveBeenCalled()
  item(host, 'mask').querySelector<HTMLElement>('.kbn-ch-item-text')!.click()
  expect(openFromDesk).toHaveBeenLastCalledWith(mask)
  // A preview unfolds in place: it opens no page and no view, and looks at nothing.
  const opened = openFromDesk.mock.calls.length, paged = openPage.mock.calls.length
  item(host, 'tsz').querySelector<HTMLButtonElement>('.uf-card')!.click()
  expect([item(host, 'tsz').querySelector('.kbn-ch-previews')!.hasAttribute('data-unfolded'), item(host, 'tsz').querySelector('.uf-count')?.textContent]).toStrictEqual([true, '1 / 3'])
  item(host, 'tsz').querySelector<HTMLElement>('.uf-page')!.click()
  expect([openFromDesk.mock.calls.length, openPage.mock.calls.length]).toStrictEqual([opened, paged])
  // Its worker going idle repaints its dot, and the unfolded file stays where it is.
  const page = item(host, 'tsz').querySelector('.uf-page')
  ctx.response = board([chair, { ...tsz, runtimePhase: 'waiting' }, mask, beam])
  view.refresh(ctx); await settle()
  expect(item(host, 'tsz').querySelector('.uf-page')).toBe(page)
  // The chair's pages in the head open there too.
  host.querySelector<HTMLButtonElement>('.kbn-ch-pages [data-part="constitution"]')!.click()
  expect(openPage).toHaveBeenLastCalledWith(chair, expect.stringContaining('C'))
  // A line, its start's slug and its tick open that thread's view, as an item does, and look at nothing.
  const ticked = host.querySelector<HTMLElement>('.kbn-ch-stream > [data-what="tick"]')!.dataset.line!
  host.querySelector<SVGGElement>(`.kbn-ch-margin .kbn-ch-fibre[data-line="${ticked}"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(openFromDesk).toHaveBeenLastCalledWith(beam)
  host.querySelector<HTMLButtonElement>('.kbn-ch-stream > [data-what="start"] .kbn-ch-slug')!.click()
  expect(openFromDesk).toHaveBeenLastCalledWith(tsz)
  // The item on that line hangs from its fibre and names its thread; a send says no word the stream does not.
  const wired = item(host, 'tsz')
  expect([wired.querySelector('.kbn-ch-who')?.textContent, wired.querySelector('.kbn-ch-kind'), !!host.querySelector(`.kbn-ch-margin .kbn-ch-fibre[data-line="${wired.dataset.line}"]`)]).toStrictEqual(['tsz', null, true])
  expect(see).not.toHaveBeenCalled()
})

it('speaks to the channel\'s chair by its slug, and keeps the console\'s draft by channel', async () => {
  daemon()
  const { host } = await mount()
  const dock = host.querySelector<HTMLElement>('.kbn-ch > .ws-dock')!
  const field = () => dock.querySelector<HTMLElement>('.ws-worker-message')!
  expect(field().dataset.placeholder).toBe('Message cmbx')
  // The chair's pages stand in the channel's head, so the console carries no copy of its constitution.
  expect(dock.querySelector<HTMLElement>('.ws-band-page')!.hidden).toBe(true)
  field().textContent = 'for the chair'; field().dispatchEvent(new Event('input'))
  // A chair with no worker to run has no console.
  host.querySelector<HTMLButtonElement>('[data-channel="fiber:R"]')!.click()
  expect(dock.hidden).toBe(true)
  host.querySelector<HTMLButtonElement>('[data-channel="channel:cmbx"]')!.click()
  expect(field().textContent).toBe('for the chair')
})

it('marks a channel with something new to the human by an ink dot, counting what a channel never opened has said, and never counting marks', async () => {
  const stored = new Map([['shuttle.channels.seen:fiber:R', String(Date.now() - 5 * minute)]])
  daemon([], stored)
  const science = card({ id: 'science', uid: 'S', name: 'Science desk', shuttleChannel: 'Science', ...working(3) })
  const { host } = await mount([chair, tsz, mask, beam, van, notes, science], undefined, SENT, { S: [Date.now() - minute] })
  const dot = (key: string) => host.querySelector(`[data-channel="${key}"]`)!
  // Moving house was read after its ask; science's only news is a thread starting.
  expect(dot('fiber:R').hasAttribute('data-unread')).toBe(false)
  expect(dot('channel:science').hasAttribute('data-unread')).toBe(false)
  // cmbx waits: gold, not ink.
  expect([dot('channel:cmbx').querySelector('.kbn-ch-pick-mark') !== null, dot('channel:cmbx').querySelector('.kbn-ch-pick-unread')]).toStrictEqual([true, null])
})

it('opens on the channel last open on this device, and on the first channel when that one is gone', async () => {
  const { stored } = daemon()
  const first = await mount()
  first.view.keydown(new KeyboardEvent('keydown', { key: 'j' }))
  first.view.unmount(); views.length = 0
  const again = await mount(undefined, new ChannelsView())
  expect(shown(again.host)).toBe('van')
  again.view.unmount(); views.length = 0
  stored.set('shuttle.channels.last', 'channel:gone')
  const third = await mount(undefined, new ChannelsView())
  expect(shown(third.host)).toBe('cmbx')
})

it('jumps to a channel the rail no longer lists, and to the fleet\'s documents; the rail lists the same on every device', async () => {
  const { stored } = daemon()
  const { view, host, openPage } = await mount()
  const jump = host.querySelector<HTMLInputElement>('.kbn-ch-jump')!
  jump.value = 'old'
  jump.dispatchEvent(new Event('input'))
  expect(rail(host)).toStrictEqual(['notes'])
  expect([...host.querySelectorAll('.kbn-ch-doclist .kbn-ch-doc-name')].map(el => el.textContent)).toStrictEqual(['lensing-notes.md'])
  host.querySelector<HTMLButtonElement>('.kbn-ch-doclist .kbn-ch-doc')!.click()
  expect(openPage).toHaveBeenLastCalledWith(library[0].card, 'host:/notes/old/lensing-notes.md')
  jump.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  expect(shown(host)).toBe('notes')
  expect(stored.has('shuttle.channels.seen:fiber:N')).toBe(true)
  // Listed while it is the one being read.
  expect(rail(host)).toStrictEqual(['cmbx', 'van', 'notes'])
  host.querySelector<HTMLButtonElement>('[data-channel="channel:cmbx"]')!.click()
  // Having opened it on this device does not keep it listed: what is listed is the same on every device.
  expect(rail(host)).toStrictEqual(['cmbx', 'van'])
  view.find('')
})

it('hides and shows the rail by its button, by [ and by sideways swipes, and remembers the rail', async () => {
  const { stored } = daemon()
  const { view, host } = await mount()
  const layout = host.querySelector('.kbn-ch-layout')!, toggle = host.querySelector<HTMLButtonElement>('.kbn-ch-rail-toggle')!
  const tip = () => toggle.closest('ui-tooltip')!.querySelector('.kbn-ch-tip')!.textContent
  expect([layout.hasAttribute('data-rail-hidden'), tip()]).toStrictEqual([false, 'Hide channels'])
  toggle.click()
  expect([layout.hasAttribute('data-rail-hidden'), tip(), toggle.getAttribute('aria-expanded')]).toStrictEqual([true, 'Show channels', 'false'])
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
  const wheel = (on: Element, deltaX: number) => { const event = Object.assign(new Event('wheel', { bubbles: true, cancelable: true }), { deltaX, deltaY: 2 }); on.dispatchEvent(event); return event.defaultPrevented }
  expect(wheel(streamEl, 80)).toBe(true)
  expect(layout.hasAttribute('data-rail-hidden')).toBe(true)
  view.unmount(); views.length = 0
  const again = await mount(undefined, new ChannelsView())
  expect(again.host.querySelector('.kbn-ch-layout')!.hasAttribute('data-rail-hidden')).toBe(true)
})

it('pins and unpins from its menu, and restores a write that fails', async () => {
  const { posts } = daemon()
  const { host } = await mount()
  const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  const choose = async (label: string) => {
    host.querySelector<HTMLButtonElement>('.kbn-ch-menu')!.click()
    await settle()
    items().find(item => item.textContent === label)!.click()
    await settle()
  }
  // The channel's menu is an icon named by its tooltip.
  expect(host.querySelector('.kbn-ch-menu')!.closest('ui-tooltip')!.querySelector('.kbn-ch-tip')?.textContent).toBe('Channel menu')
  host.querySelector<HTMLButtonElement>('.kbn-ch-menu')!.click()
  await settle()
  expect(items().map(item => item.textContent)).toStrictEqual(['Hide', 'Pin', 'Move to bottom'])
  items()[1].click()
  await settle()
  expect(posts.at(-1)).toStrictEqual(['/api/v1/channels/pin', { key: 'channel:cmbx', fiber: 'C' }])
  daemon(['/api/v1/channels/dismiss'])
  await choose('Unpin')
  expect(host.querySelector('.kbn-ch-note')?.textContent).toContain('could not be unpinned')
})

it('floats what waits above the human\'s order, and moves a channel by Alt and the arrows, by its menu and to the bottom', async () => {
  const science = card({ id: 'science', uid: 'S', name: 'Science desk', shuttleChannel: 'Science', ...working(3) })
  const french = card({ id: 'french', uid: 'F', name: 'French lessons', shuttleChannel: 'French', ...working(4) })
  const { posts } = daemon([], undefined, {}, { order: { keys: ['channel:science', 'channel:french'], at: Date.now() - day } })
  const { view, ctx, host } = await mount([chair, tsz, mask, beam, van, notes, science, french])
  // What waits on the human first, its newest wait first; then the stored order.
  expect(rail(host)).toStrictEqual(['cmbx', 'van', 'science', 'french'])
  const pick = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('.kbn-ch-pick')].find(el => el.querySelector('.kbn-ch-pick-name')?.textContent === name)!
  const press = (name: string, key: string, over: KeyboardEventInit = {}) => pick(name).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...over }))
  press('science', 'ArrowDown', { altKey: true })
  await settle()
  // Every channel's place is written, the ones out of the rail and the waiting ones keeping theirs.
  expect(posts.at(-1)).toStrictEqual(['/api/v1/channels/order', { keys: ['channel:cmbx', 'fiber:N', 'fiber:R', 'channel:french', 'channel:science'] }])
  expect(rail(host)).toStrictEqual(['cmbx', 'van', 'french', 'science'])
  // Nothing moves above what waits, and a waiting channel does not move at all.
  press('french', 'ArrowUp', { altKey: true })
  press('cmbx', 'ArrowDown', { altKey: true })
  await settle()
  expect(posts.filter(([url]) => url.endsWith('/order'))).toHaveLength(1)
  // The context-menu key opens the entry's menu; Move to bottom puts it last.
  press('french', 'ContextMenu')
  await settle()
  const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(items().map(item => item.textContent)).toStrictEqual(['Hide', 'Pin', 'Move to bottom'])
  items()[2].click()
  await settle()
  expect(posts.at(-1)).toStrictEqual(['/api/v1/channels/order', { keys: ['channel:cmbx', 'fiber:N', 'fiber:R', 'channel:science', 'channel:french'] }])
  expect(rail(host)).toStrictEqual(['cmbx', 'van', 'science', 'french'])
  // A poll keeps the order written here until the feed carries a newer one.
  view.refresh(ctx); await settle()
  expect(rail(host)).toStrictEqual(['cmbx', 'van', 'science', 'french'])
})

it('hides a channel by its menu; Jump to finds it, marked, and opening it brings it back', async () => {
  const { posts } = daemon()
  const { view, host } = await mount()
  const pick = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('.kbn-ch-pick')].find(el => el.querySelector('.kbn-ch-pick-name')?.textContent === name)!
  pick('van').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  await settle()
  ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Hide')!.click()
  await settle()
  expect(posts.at(-1)?.[0]).toBe('/api/v1/channels/dismiss')
  expect(posts.at(-1)?.[1]).toMatchObject({ key: expect.stringMatching(/^hide:fiber:R:\d+$/), fiber: 'R' })
  expect(rail(host)).toStrictEqual(['cmbx'])
  view.find('mov')
  expect(rail(host)).toStrictEqual(['van'])
  expect(pick('van').querySelector('.kbn-ch-pick-hidden')?.textContent).toBe('hidden')
  // Its menu offers to bring it back.
  pick('van').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  await settle()
  expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toStrictEqual(['Unhide', 'Pin', 'Move to bottom'])
  ;(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await settle()
  expect(document.querySelector('[role="menu"]')).toBeNull()
  pick('van').click()
  await settle()
  expect(posts.at(-1)?.[1]).toMatchObject({ key: expect.stringMatching(/^show:fiber:R:\d+$/) })
  expect(rail(host)).toStrictEqual(['cmbx', 'van'])
})

it('rebuilds nothing under a held entry: a poll during a hold waits, and the hold lifted opens the menu on it', async () => {
  daemon()
  const { view, ctx, host } = await mount()
  const held = host.querySelector<HTMLButtonElement>('[data-channel="fiber:R"]')!
  const press = (type: string) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 })
  held.dispatchEvent(Object.assign(press('pointerdown'), { pointerId: 1, pointerType: 'touch', isPrimary: true }))
  await new Promise(resolve => setTimeout(resolve, 500))
  // A poll brings a new channel while the finger is still down.
  ctx.response = board([chair, tsz, mask, beam, van, notes, card({ id: 'new', uid: 'NEW', name: 'Fresh', ...working(1) })])
  view.refresh(ctx); await settle()
  expect(held.isConnected).toBe(true)
  expect(rail(host)).toStrictEqual(['cmbx', 'van'])
  window.dispatchEvent(Object.assign(press('pointerup'), { pointerId: 1, pointerType: 'touch', isPrimary: true }))
  await settle()
  expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toStrictEqual(['Hide', 'Pin', 'Move to bottom'])
  // Lifted, the rail takes the poll.
  expect(rail(host)).toStrictEqual(['cmbx', 'van', 'new'])
  ;(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  // The window swallows the click a fired hold sends for a moment; let it pass before the next test clicks.
  await new Promise(resolve => setTimeout(resolve, 750))
})

it('brings a hidden channel back by itself when something in it begins waiting after the hide', async () => {
  daemon([], undefined, {}, { dismissed: [`hide:fiber:R:${Date.now() - 35 * minute}`] })
  const { view, ctx, host } = await mount()
  // The van asked half an hour ago, after the hide.
  expect(rail(host)).toStrictEqual(['cmbx', 'van'])
  daemon([], undefined, {}, { dismissed: [`hide:fiber:R:${Date.now() - 25 * minute}`] })
  view.refresh(ctx); await settle(); await settle()
  expect(rail(host)).toStrictEqual(['cmbx'])
})

it('names each icon by its tooltip', async () => {
  daemon()
  const { host } = await mount()
  for (const icon of host.querySelectorAll<HTMLButtonElement>('.kbn-ch-icon')) {
    const tip = icon.closest('ui-tooltip')!.querySelector('.kbn-ch-tip')!
    expect(icon.getAttribute('aria-labelledby')?.split(' ')).toContain(tip.id)
  }
})

it('keeps the rail on a phone\'s first screen when swiped leftward with no channel chosen', async () => {
  daemon()
  const media = window.matchMedia
  vi.stubGlobal('matchMedia', (query: string) => ({ ...media(query), matches: query.includes('max-width') }))
  const { host } = await mount()
  const layout = host.querySelector('.kbn-ch-layout')!
  expect(layout.hasAttribute('data-channel')).toBe(false)
  const rail = host.querySelector('.kbn-ch-rail')!
  rail.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), { touches: [{ clientX: 300, clientY: 300 }] }))
  rail.dispatchEvent(Object.assign(new Event('touchend', { bubbles: true }), { changedTouches: [{ clientX: 150, clientY: 305 }] }))
  expect(layout.hasAttribute('data-rail-hidden')).toBe(false)
})

it('on a phone, reads a channel only while it is the screen: it resumes on the rail, and going back leaves the channel', async () => {
  const stored = new Map([['shuttle.channels.last', 'channel:cmbx'], ['shuttle.channels.seen:channel:cmbx', '0']])
  daemon([], stored)
  const media = window.matchMedia
  vi.stubGlobal('matchMedia', (query: string) => ({ ...media(query), matches: query.includes('max-width') }))
  const { host } = await mount()
  // The rail is the first screen: nothing behind it is read.
  expect([host.querySelector('.kbn-ch-layout')!.hasAttribute('data-channel'), stored.get('shuttle.channels.seen:channel:cmbx')]).toStrictEqual([false, '0'])
  host.querySelector<HTMLButtonElement>('[data-channel="channel:cmbx"]')!.click()
  const read = Number(stored.get('shuttle.channels.seen:channel:cmbx'))
  expect(read).toBeGreaterThan(0)
  host.querySelector<HTMLButtonElement>('.kbn-ch-back')!.click()
  expect(host.querySelector('.kbn-ch-layout')!.hasAttribute('data-channel')).toBe(false)
  // A leftward swipe over the rail goes back to it.
  const rail = host.querySelector('.kbn-ch-rail')!
  rail.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), { touches: [{ clientX: 300, clientY: 300 }] }))
  rail.dispatchEvent(Object.assign(new Event('touchend', { bubbles: true }), { changedTouches: [{ clientX: 150, clientY: 305 }] }))
  expect([shown(host), host.querySelector('.kbn-ch-layout')!.hasAttribute('data-rail-hidden')]).toStrictEqual(['cmbx', true])
})

it('leaves the channel\'s head as it stands when only its stream changes, so its focus and menus survive a poll', async () => {
  daemon()
  const { view, ctx, host } = await mount()
  const pages = host.querySelector('.kbn-ch-head .kbn-ch-pages')!
  ctx.response = board([chair, { ...tsz, name: 'κ × tSZ, final' }, mask, beam, van, notes])
  view.refresh(ctx); await settle()
  expect(item(host, 'tsz').isConnected).toBe(true)
  expect(host.querySelector('.kbn-ch-head .kbn-ch-pages')).toBe(pages)
})

it('draws a post and the running list again when its thread\'s office or slug changes', async () => {
  const human = { label: 'Sam' }
  daemon([], undefined, {}, { board: { C: [...BOARD.C, record({ id: 'b9', kind: 'post', fiber: 'B', to: human, text: 'Beam done.' }, 2)] } })
  const { view, ctx, host } = await mount([chair, tsz, beam])
  expect(item(host, 'beam').querySelector('.kbn-ch-role')).toBeNull()
  const moved = { ...beam, shuttleRole: 'optics' }
  ctx.response = board([chair, tsz, moved])
  view.refresh(ctx); await settle()
  expect(item(host, 'beam').querySelector('.kbn-ch-role')?.textContent).toBe('optics')
  host.querySelector<HTMLButtonElement>('.kbn-ch-count-ring')!.click(); await settle()
  const row = [...document.querySelectorAll<HTMLElement>('[role="menuitem"] .thread-row')].find(each => each.querySelector('.thread-row-slug')!.textContent === 'beam')!
  expect(row.querySelector('.thread-row-role')?.textContent).toBe('optics')
})

it('heads the view with the channel itself, written as its chair\'s slug, the rail\'s toggle at its right', async () => {
  daemon()
  // A channel's key is never drawn: the Mill's channel is written as its chair, felt.
  const mill = card({ id: 'felt', uid: 'L', name: 'The Mill', shuttleChannel: 'The Mill', shuttleSeat: true, ...working(2) })
  const { host } = await mount([chair, tsz, van, mill])
  // The tab bar names the view: no page title of its own.
  expect(host.querySelector('.kbn-view-title')).toBeNull()
  expect(rail(host)).toStrictEqual(['van', 'cmbx', 'felt'])
  host.querySelector<HTMLButtonElement>('[data-channel="channel:the mill"]')!.click()
  await settle()
  const head = host.querySelector('.kbn-ch-head')!
  expect(shown(host)).toBe('felt')
  expect(head.querySelector('.kbn-ch-name')!.getAttribute('title')).toBe('The Mill')
  expect([...head.querySelectorAll('.kbn-ch-icon')].map(icon => icon.classList[1])).toStrictEqual(['kbn-ch-rail-toggle', 'kbn-ch-back', 'kbn-ch-menu'])
  // Its chair's pages stand beside its name.
  expect([...head.querySelectorAll<HTMLElement>('.kbn-ch-pages .ws-doc-button')].map(button => button.dataset.part)).toStrictEqual(['constitution'])
  // A lone constitution is named by its slug, its name in the tooltip.
  host.querySelector<HTMLButtonElement>('[data-channel="fiber:R"]')!.click()
  await settle()
  expect([shown(host), host.querySelector('.kbn-ch-name')!.hasAttribute('data-lone'), host.querySelector('.kbn-ch-name')!.getAttribute('title')]).toStrictEqual(['van', true, 'Moving house'])
})

it('shows a close awaiting review by its note and its tapestry, never its outcome, and keeps the tapestry across redraws', async () => {
  daemon()
  const cov = card({ id: 'cmbx/cov', uid: 'V', name: 'Covariance', orchestrator: 'C', column: 'awaitingReview', status: 'closed', closedAt: at(40), outcome: 'Validated against **2000** simulations.', reviewMark: { note: 'Agrees to 4%.', at: at(40) } })
  const { view, ctx, host } = await mount([chair, tsz, mask, beam, cov])
  const feeds = (ctx.workspace as unknown as { globeHost: { feeds: { lead: (card: { uid?: string }) => Promise<unknown> } } }).globeHost.feeds
  feeds.lead = async card => card.uid === 'V' ? { key: 'local:/w/cov/tapestry.html', name: 'Tapestry', at: Date.now(), unread: false } : undefined
  // Drawn again once the stream changes.
  ctx.response = board([chair, { ...tsz, name: 'κ × tSZ, final' }, mask, beam, cov])
  view.refresh(ctx); await settle(); await settle()
  const review = item(host, 'cov')
  expect([review.dataset.kind, review.hasAttribute('data-waiting'), review.querySelector('.kbn-ch-kind')?.textContent]).toStrictEqual(['close', true, 'for review'])
  expect(review.querySelector('.kbn-ch-item-text')?.textContent?.trim()).toBe('Agrees to 4%.')
  const lead = review.querySelector<HTMLElement>('.kbn-ch-previews .uf-card')!
  expect([lead.dataset.key, lead.querySelector('.ws-thumbnail') !== null]).toStrictEqual(['local:/w/cov/tapestry.html', true])
  expect(host.textContent).not.toContain('2000')
  // A redraw of the stream draws the same tapestry at once, not a new one.
  ctx.response = board([chair, tsz, mask, beam, cov])
  view.refresh(ctx)
  expect(item(host, 'cov').querySelector('.kbn-ch-previews .uf-card')).toBe(lead)
})

it('draws a post to the human that waits on them gold, with what it attached as a preview', async () => {
  const human = { label: 'Sam' }
  daemon([], undefined, {}, { board: { C: [...BOARD.C, record({ id: 'b5', kind: 'post', fiber: 'C', to: human, text: 'Two calls for you today.', files: ['/w/tsz/deck.html'] }, 4)] }, waiting: { C: { id: 'b5', at: Date.now() - 4 * minute } } })
  const { host } = await mount([chair, tsz, beam])
  expect(host.querySelector('[data-channel="channel:cmbx"]')!.hasAttribute('data-waiting')).toBe(true)
  const post = item(host, 'cmbx')
  expect([post.dataset.kind, post.hasAttribute('data-waiting'), post.querySelector('.kbn-ch-kind'), post.querySelector('.kbn-ch-item-text')?.textContent?.trim()]).toStrictEqual(['post', true, null, 'Two calls for you today.'])
  // Every post and file line carries a clear: the waiting post's, and the expert's files'.
  expect(post.querySelector('.kbn-ch-clear')?.textContent).toBe('✓')
  expect([...host.querySelectorAll('.kbn-ch-clear')].map(check => check.getAttribute('aria-label'))).toStrictEqual(["Clear κ × tSZ's files", "Clear cmbx chair's post"])
  expect([...post.querySelectorAll('.kbn-ch-previews .uf-card')].map(file => [file.getAttribute('aria-label'), file.querySelector('.ws-thumbnail') !== null])).toStrictEqual([['Expand deck.html', true]])
  expect(post.querySelector('.kbn-ch-previews')!.hasAttribute('data-several')).toBe(false)
})

it('says nothing for a closing post, its words being the outcome', async () => {
  const human = { label: 'Sam' }
  const closed = card({ id: 'cmbx/cov', uid: 'V', name: 'Covariance', orchestrator: 'C', column: 'awaitingReview', status: 'closed', closedAt: at(40), outcome: 'Validated against **2000** simulations.' })
  daemon([], undefined, {}, { board: { C: [...BOARD.C, record({ id: 'b6', kind: 'closed', fiber: 'V', to: human, text: 'Validated against **2000** simulations.' }, 40)] }, waiting: { V: { id: 'b6', at: Date.now() - 40 * minute } } })
  const { host } = await mount([chair, tsz, beam, closed])
  const close = item(host, 'cov')
  expect([close.dataset.kind, close.hasAttribute('data-waiting'), close.querySelector('.kbn-ch-item-text')]).toStrictEqual(['close', true, null])
  expect(host.textContent).not.toContain('2000')
})

/** What the board asked of the daemon after `from`: each request's path and method. */
const requestsSince = (from: number): Array<[string, string]> => vi.mocked(fetch).mock.calls.slice(from).map(([url, init]) => [String(url), init?.method ?? 'GET'])
const LIFECYCLE = /\/api\/v1\/(transition|lifecycle|kill|dispatch)\b/

it('clears a waiting post with one press of its ✓: it leaves the stream and stops waiting, two dismissals and no lifecycle request, and one undo restores both', async () => {
  const human = { label: 'Sam' }, posted = Date.now() - 4 * minute
  const { posts } = daemon([], undefined, {}, { board: { C: [...BOARD.C, { ...record({ id: 'b5', kind: 'post', fiber: 'C', to: human, text: 'Two calls for you today.' }, 4), timestamp: posted }] }, waiting: { C: { id: 'b5', at: posted } } })
  // The chair is active and was never closed.
  const { host } = await mount([chair, tsz, beam])
  expect([chair.status, chair.closedAt]).toStrictEqual(['active', undefined])
  const from = vi.mocked(fetch).mock.calls.length
  item(host, 'cmbx').querySelector<HTMLButtonElement>('.kbn-ch-clear')!.click()
  await settle(); await settle()
  const asked = requestsSince(from)
  expect(asked.filter(([, method]) => method === 'POST')).toStrictEqual([['/api/v1/channels/dismiss', 'POST'], ['/api/v1/channels/dismiss', 'POST']])
  expect(asked.filter(([url]) => LIFECYCLE.test(url))).toStrictEqual([])
  // The clear first, then the line: a refused line write leaves only a post that no longer waits.
  expect(posts.slice(-2).map(([, body]) => body)).toStrictEqual([{ key: `clear:C:${posted}`, fiber: 'C' }, { key: expect.stringMatching(/^line:\d+:b5$/), fiber: 'C' }])
  expect(item(host, 'cmbx')).toBeUndefined()
  expect(host.querySelector('[data-channel="channel:cmbx"]')!.hasAttribute('data-waiting')).toBe(false)
  document.querySelector<HTMLButtonElement>('.shuttle-toast .toast-undo')!.click()
  await settle(); await settle()
  expect(posts.slice(-2).map(([, body]) => String(body.key)).sort()).toStrictEqual([`unclear:C:${posted}`, expect.stringMatching(/^unline:\d+:b5$/)])
  expect(item(host, 'cmbx').hasAttribute('data-waiting')).toBe(true)
  expect(host.querySelector('[data-channel="channel:cmbx"]')!.hasAttribute('data-waiting')).toBe(true)
})

it('clears a line that waits on no one from the stream, with e as with its ✓, and an undo brings it back; a question has no ✓', async () => {
  const { posts } = daemon()
  const { view, host } = await mount()
  expect(item(host, 'mask').querySelector('.kbn-ch-clear')).toBeNull()
  const files = item(host, 'tsz')
  files.querySelector<HTMLElement>('.kbn-ch-who')!.focus()
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'e' }))).toBe(true)
  await settle(); await settle()
  // The clear names each send the item showed, one record each.
  expect(posts.slice(-3).map(([, body]) => [body.fiber, String(body.key).replace(/^line:\d+:/, '')])).toStrictEqual(SENT.map(file => ['T', `file:local:${file.fullPath}:${file.timestamp}`]))
  expect(item(host, 'tsz')).toBeUndefined()
  document.querySelector<HTMLButtonElement>('.shuttle-toast .toast-undo')!.click()
  await settle(); await settle()
  expect(posts.slice(-3).map(([, body]) => String(body.key).replace(/^unline:\d+:/, ''))).toStrictEqual(SENT.map(file => `file:local:${file.fullPath}:${file.timestamp}`))
  expect(item(host, 'tsz')).toBeDefined()
})

it('keeps the keys going after a clear: the line after it takes the focus, found again when it is drawn anew', async () => {
  const human = { label: 'Sam' }
  // Two posts of the chair's a minute apart: the second is grouped under the first, and takes a head once the first leaves.
  daemon([], undefined, {}, { board: { C: [...BOARD.C, record({ id: 'g1', kind: 'post', fiber: 'C', to: human, text: 'First.' }, 8), record({ id: 'g2', kind: 'post', fiber: 'C', to: human, text: 'Second.' }, 7)] } })
  const { view, host } = await mount([chair, tsz, beam])
  const second = host.querySelector<HTMLElement>('[data-item="item:g2"]')!.closest<HTMLElement>('.kbn-ch-item')!
  expect(second.hasAttribute('data-grouped')).toBe(true)
  host.querySelector<HTMLElement>('[data-item="item:g1"]')!.focus()
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'e' }))).toBe(true)
  await settle(); await settle()
  const now = host.querySelector<HTMLElement>('[data-item="item:g2"]')!
  expect(now.closest('.kbn-ch-item')!.hasAttribute('data-grouped')).toBe(false)
  expect(document.activeElement).toBe(now)
  expect(now.isConnected).toBe(true)
})

it('hides a channel and does nothing else: one write, the dismissal, and no lifecycle request', async () => {
  daemon()
  const { host } = await mount()
  const pick = [...host.querySelectorAll<HTMLButtonElement>('.kbn-ch-pick')].find(el => el.querySelector('.kbn-ch-pick-name')?.textContent === 'van')!
  const from = vi.mocked(fetch).mock.calls.length
  pick.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  await settle()
  ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(entry => entry.textContent === 'Hide')!.click()
  await settle(); await settle()
  const asked = requestsSince(from)
  expect(asked.filter(([, method]) => method === 'POST')).toStrictEqual([['/api/v1/channels/dismiss', 'POST']])
  expect(asked.filter(([url]) => LIFECYCLE.test(url))).toStrictEqual([])
})

it('rings the threads running now and lists them as thread rows from the ring; the strand names what it gathers where it is', async () => {
  daemon()
  const { host, openFromDesk } = await mount()
  const ring = host.querySelector<HTMLButtonElement>('.kbn-ch-count-ring')!
  // The beam's life runs in from before the stream; the expert's started 40 minutes ago; the mask, launched before the reach, asks in it with nothing else there; none has ended.
  expect([ring.hidden, ring.textContent, ring.title]).toStrictEqual([false, '3', '3 running: mask, beam, tsz'])
  expect([...host.querySelectorAll('.kbn-ch-gathered > title')].every(title => / gathered here: /.test(title.textContent!))).toBe(true)
  ring.click(); await settle()
  const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitem"] .thread-row')]
  expect(rows.map(row => [row.querySelector('.thread-row-slug')!.textContent, row.querySelector('.thread-row-doing')!.textContent])).toStrictEqual([['mask', 'Mask at 5σ or 3σ?'], ['beam', 'working'], ['tsz', 'working']])
  rows[2].click(); await settle(); await settle()
  expect(openFromDesk).toHaveBeenLastCalledWith(tsz)
})

it('redraws the ring when the threads running change and nothing drawn does', async () => {
  const human = { label: 'Sam' }
  // The chair said one line, cleared: it runs with nothing of it drawn.
  daemon([], undefined, {}, { board: { C: [...BOARD.C, record({ id: 'p1', kind: 'post', fiber: 'C', to: human, text: 'Done for today.' }, 10)] }, dismissed: [`line:${Date.now()}:p1`] })
  const { view, ctx, host } = await mount([chair, tsz, beam])
  expect(host.querySelector('.kbn-ch-count-ring')!.textContent).toBe('3')
  ctx.response = board([{ ...chair, status: 'open', column: 'resting' }, tsz, beam])
  view.refresh(ctx); await settle()
  expect(host.querySelector('.kbn-ch-count-ring')!.textContent).toBe('2')
})

it('lists the running threads as they stand when the list opens, not as the stream last drew them', async () => {
  daemon()
  const { view, ctx, host } = await mount()
  ctx.response = board([chair, tsz, mask, { ...beam, outcome: 'Beam is fitted.', modifiedAt: new Date().toISOString() }, van, notes])
  view.refresh(ctx); await settle()
  host.querySelector<HTMLButtonElement>('.kbn-ch-count-ring')!.click(); await settle()
  const row = [...document.querySelectorAll<HTMLElement>('[role="menuitem"] .thread-row')].find(each => each.querySelector('.thread-row-slug')!.textContent === 'beam')!
  expect(row.querySelector('.thread-row-doing')!.textContent).toBe('Beam is fitted.')
})

it('redraws a file sent again: its card says when it last came', async () => {
  daemon()
  const { view, ctx, host } = await mount()
  const age = () => [...item(host, 'tsz').querySelectorAll<HTMLElement>('.uf-card')].find(card => card.dataset.key?.endsWith('nulls.md'))!.querySelector('.uf-age')!.textContent
  expect(age()).toBe('14m ago')
  ;(ctx.sends as unknown as { files: SentFile[] }).files = [...SENT.slice(0, 2), { ...SENT[2], timestamp: Date.now() - 10 * minute }]
  view.refresh(ctx); await settle()
  expect(age()).toBe('10m ago')
})

it('keeps the undo of a waiting post\'s clear when the line could not be taken from the stream', async () => {
  const human = { label: 'Sam' }, posted = Date.now() - 4 * minute
  const { posts } = daemon([], undefined, {}, { board: { C: [...BOARD.C, { ...record({ id: 'b5', kind: 'post', fiber: 'C', to: human, text: 'Two calls for you today.' }, 4), timestamp: posted }] }, waiting: { C: { id: 'b5', at: posted } } })
  const answer = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) =>
    init?.method === 'POST' && String(JSON.parse(String(init.body)).key).startsWith('line:') ? new Response('{"error":"disk full"}', { status: 422 }) : answer(url, init))
  const { host } = await mount([chair, tsz, beam])
  item(host, 'cmbx').querySelector<HTMLButtonElement>('.kbn-ch-clear')!.click()
  await settle(); await settle()
  expect([item(host, 'cmbx').hasAttribute('data-waiting'), host.querySelector('.kbn-ch-note')!.textContent]).toStrictEqual([false, "cmbx chair's line could not be taken from the stream; it no longer waits."])
  document.querySelector<HTMLButtonElement>('.shuttle-toast .toast-undo')!.click()
  await settle(); await settle()
  // The undo takes back what was written: the clear, and no line.
  expect(posts.at(-1)?.[1]).toStrictEqual({ key: `unclear:C:${posted}`, fiber: 'C' })
  expect(posts.some(([, body]) => String(body.key).startsWith('unline:'))).toBe(false)
  expect(item(host, 'cmbx').hasAttribute('data-waiting')).toBe(true)
})

it('reads the tapestry of each fiber\'s newest close only, and reckons a close\'s row with a tapestry only when it shows one', async () => {
  const human = { label: 'Sam' }
  const cov = card({ id: 'cmbx/cov', uid: 'V', name: 'Covariance', orchestrator: 'C', column: 'tempered', status: 'closed', closedAt: at(20), outcome: 'Validated.' })
  daemon([], undefined, {}, { board: { C: [...BOARD.C, record({ id: 'v1', kind: 'closed', fiber: 'V', to: human, text: 'First pass.' }, 60), record({ id: 'v2', kind: 'closed', fiber: 'V', to: human, text: 'Second pass.' }, 20)] } })
  const lead = vi.fn(async (_card: { uid?: string }) => ({ key: 'local:/w/cov/tapestry.html', name: 'Tapestry', at: Date.now(), unread: false }))
  const view = new ChannelsView()
  const { ctx, host } = await mount([chair, tsz, mask, beam, cov], view)
  ;(ctx.workspace as unknown as { globeHost: { feeds: { lead: typeof lead } } }).globeHost.feeds.lead = lead
  ctx.response = board([chair, { ...tsz, name: 'κ × tSZ, final' }, mask, beam, cov])
  view.refresh(ctx); await settle(); await settle()
  const closes = () => [...host.querySelectorAll<HTMLElement>('.kbn-ch-item[data-kind="close"]')]
  expect(closes().map(close => [...close.querySelectorAll<HTMLElement>('.kbn-ch-previews .uf-card')].map(card => card.dataset.key))).toStrictEqual([[], ['local:/w/cov/tapestry.html']])
  expect(lead.mock.calls.every(([each]) => each.uid === 'V')).toBe(true)
  const calls = lead.mock.calls.length
  ctx.response = board([chair, tsz, mask, beam, cov])
  view.refresh(ctx); await settle()
  expect(lead.mock.calls.length - calls).toBe(1)
  // The stream was laid out again with the tapestry the newest close shows, and none for the older one.
  const [entries, heights] = vi.mocked(layTube).mock.lastCall!
  expect(entries.flatMap((entry, row) => entry.kind === 'close' ? [[entry.id, heights![row]]] : [])).toStrictEqual([['v1', 64], ['v2', 64 + 270]])
})

it('takes from the stream the sends whose clear was written, and its undo brings back only those', async () => {
  const { posts } = daemon()
  const answer = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) =>
    init?.method === 'POST' && String(JSON.parse(String(init.body)).key).endsWith('nulls.md:' + SENT[2].timestamp) ? new Response('{"error":"disk full"}', { status: 422 }) : answer(url, init))
  const { host } = await mount()
  item(host, 'tsz').querySelector<HTMLButtonElement>('.kbn-ch-clear')!.click()
  await settle(); await settle()
  expect([...item(host, 'tsz').querySelectorAll<HTMLElement>('.uf-card')].map(card => card.getAttribute('aria-label'))).toStrictEqual(['Expand nulls.md'])
  document.querySelector<HTMLButtonElement>('.shuttle-toast .toast-undo')!.click()
  await settle(); await settle()
  expect(posts.filter(([, body]) => String(body.key).startsWith('unline:')).map(([, body]) => String(body.key).replace(/^unline:\d+:/, ''))).toStrictEqual(SENT.slice(0, 2).map(file => `file:local:${file.fullPath}:${file.timestamp}`))
  expect(item(host, 'tsz').querySelectorAll('.uf-card')).toHaveLength(3)
})
