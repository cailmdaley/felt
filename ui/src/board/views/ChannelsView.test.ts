// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { layTube } from '../tube.js'
import { ChannelsView } from './ChannelsView.js'
import { foldPx } from '../elements/filePreview.js'
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
// A constitution asking in a channel of its own; a quiet one idle for weeks.
const van = card({ id: 'van', uid: 'R', name: 'Moving house', shuttleChannel: 'van', status: 'active', ask: { text: 'Which van?', at: at(30) } })
const notes = card({ id: 'notes', uid: 'N', name: 'Old notes', shuttleChannel: 'notes', status: 'open', modifiedAt: new Date(Date.now() - 20 * day).toISOString() })
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
    board: new BoardFeed(''), said: () => undefined,
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

/** The rail settles: a trackpad's pause, then its motion's frames. */
const settled = () => new Promise(resolve => setTimeout(resolve, 600))
/** A finger drawn sideways across `on` from x `from` to `to`, let go, and the rail settled. */
async function swipe(on: Element, from: number, to: number): Promise<void> {
  const at = (x: number, y: number) => [{ clientX: x, clientY: y }]
  on.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), { touches: at(from, 300) }))
  for (let step = 1; step <= 4; step++) on.dispatchEvent(Object.assign(new Event('touchmove', { bubbles: true }), { touches: at(from + (to - from) * step / 4, 300 + step) }))
  on.dispatchEvent(Object.assign(new Event('touchend', { bubbles: true }), { changedTouches: at(to, 304) }))
  await settled()
}

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
  expect([[...files].map(file => file.getAttribute('aria-label')), item(host, 'tsz').querySelector('.kbn-ch-previews')!.hasAttribute('data-several')]).toStrictEqual([['Open spectrum.svg', 'Open deck.html', 'Open nulls.md'], true])
  expect(item(host, 'tsz').querySelector('.kbn-ch-item-text')?.textContent?.trim()).toBe('The spectrum at 9σ.')
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'j' }))).toBe(true)
  expect(shown(host)).toBe('van')
  expect(stream(host)).toStrictEqual([['van', 'ask', true]])
})

it('opening, paging and returning to a channel look at nothing; clicking an item opens its constitution\'s view, a file opens in the reader', async () => {
  daemon()
  const { view, ctx, host, see, openFromDesk, openPage } = await mount()
  view.keydown(new KeyboardEvent('keydown', { key: 'j' }))
  view.keydown(new KeyboardEvent('keydown', { key: 'k' }))
  host.querySelector<HTMLButtonElement>('[data-channel="channel:van"]')!.click()
  host.querySelector<HTMLButtonElement>('[data-channel="channel:cmbx"]')!.click()
  view.refresh(ctx); await settle()
  window.dispatchEvent(new Event('focus'))
  expect(see).not.toHaveBeenCalled()
  item(host, 'mask').querySelector<HTMLElement>('.kbn-ch-item-text')!.click()
  expect(openFromDesk).toHaveBeenLastCalledWith(mask)
  // A preview opens its file in the reader, and looks at nothing.
  item(host, 'tsz').querySelector<HTMLButtonElement>('.uf-card')!.click()
  expect(openPage).toHaveBeenLastCalledWith(tsz, 'local:/w/tsz/spectrum.svg')
  expect(host.querySelector('.kbn-ch-previews[data-unfolded]')).toBeNull()
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
  host.querySelector<HTMLButtonElement>('[data-channel="channel:van"]')!.click()
  expect(dock.hidden).toBe(true)
  host.querySelector<HTMLButtonElement>('[data-channel="channel:cmbx"]')!.click()
  expect(field().textContent).toBe('for the chair')
})

it('marks a channel with something new to the human by an ink dot, counting from when this device first saw it, and never counting marks', async () => {
  const stored = new Map([['shuttle.channels.seen:channel:van', String(Date.now() - 5 * minute)]])
  daemon([], stored)
  const science = card({ id: 'science', uid: 'S', name: 'Science desk', shuttleChannel: 'Science', ...working(3) })
  const { host } = await mount([chair, tsz, mask, beam, van, notes, science], undefined, SENT, { S: [Date.now() - minute] })
  const dot = (key: string) => host.querySelector(`[data-channel="${key}"]`)!
  // Moving house was read after its ask; science's only news is a thread starting.
  expect(dot('channel:van').hasAttribute('data-unread')).toBe(false)
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

it('jumps to a channel the rail no longer lists, finding channels and nothing else; the rail lists the same on every device', async () => {
  const { stored } = daemon()
  const { host } = await mount()
  const jump = host.querySelector<HTMLInputElement>('.kbn-ch-jump')!
  jump.value = 'old'
  jump.dispatchEvent(new Event('input'))
  expect(rail(host)).toStrictEqual(['notes'])
  // A sent document named like it is the board's Find's to find, not the rail's.
  expect(host.querySelector('.kbn-ch-rail')!.textContent).not.toContain('lensing-notes.md')
  jump.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  expect(shown(host)).toBe('notes')
  expect(stored.has('shuttle.channels.seen:channel:notes')).toBe(true)
  // Listed while it is the one being read.
  expect(rail(host)).toStrictEqual(['cmbx', 'van', 'notes'])
  host.querySelector<HTMLButtonElement>('[data-channel="channel:cmbx"]')!.click()
  // Having opened it on this device does not keep it listed: what is listed is the same on every device.
  expect(rail(host)).toStrictEqual(['cmbx', 'van'])
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
  const streamEl = host.querySelector('.kbn-ch .kbn-ch-stream')!
  await swipe(streamEl, 300, 180)
  expect(layout.hasAttribute('data-rail-hidden')).toBe(true)
  await swipe(streamEl, 200, 320)
  expect(layout.hasAttribute('data-rail-hidden')).toBe(false)
  const wheel = (on: Element, deltaX: number) => { const event = Object.assign(new Event('wheel', { bubbles: true, cancelable: true }), { deltaX, deltaY: 2 }); on.dispatchEvent(event); return event.defaultPrevented }
  expect(wheel(streamEl, 80)).toBe(true)
  await settled()
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
  expect(items().map(item => item.textContent).slice(0, 4)).toStrictEqual(['Hide', 'Pin', 'Move to bottom', 'Move a thread to another channel…'])
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
  expect(posts.at(-1)).toStrictEqual(['/api/v1/channels/order', { keys: ['channel:cmbx', 'channel:notes', 'channel:van', 'channel:french', 'channel:science'] }])
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
  expect(items().map(item => item.textContent).slice(0, 4)).toStrictEqual(['Hide', 'Pin', 'Move to bottom', 'Move a thread to another channel…'])
  items()[2].click()
  await settle()
  expect(posts.at(-1)).toStrictEqual(['/api/v1/channels/order', { keys: ['channel:cmbx', 'channel:notes', 'channel:van', 'channel:science', 'channel:french'] }])
  expect(rail(host)).toStrictEqual(['cmbx', 'van', 'science', 'french'])
  // A poll keeps the order written here until the feed carries a newer one.
  view.refresh(ctx); await settle()
  expect(rail(host)).toStrictEqual(['cmbx', 'van', 'science', 'french'])
})

it('hides a channel by its menu; Jump to finds it, marked, and opening it brings it back', async () => {
  const { posts } = daemon()
  const { host } = await mount()
  const pick = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('.kbn-ch-pick')].find(el => el.querySelector('.kbn-ch-pick-name')?.textContent === name)!
  pick('van').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  await settle()
  ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Hide')!.click()
  await settle()
  expect(posts.at(-1)?.[0]).toBe('/api/v1/channels/dismiss')
  expect(posts.at(-1)?.[1]).toMatchObject({ key: expect.stringMatching(/^hide:channel:van:\d+$/), fiber: 'R' })
  expect(rail(host)).toStrictEqual(['cmbx'])
  const jump = host.querySelector<HTMLInputElement>('.kbn-ch-jump')!
  jump.value = 'mov'
  jump.dispatchEvent(new Event('input'))
  expect(rail(host)).toStrictEqual(['van'])
  expect(pick('van').querySelector('.kbn-ch-pick-hidden')?.textContent).toBe('hidden')
  // Its menu offers to bring it back.
  pick('van').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  await settle()
  expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent).slice(0, 4)).toStrictEqual(['Unhide', 'Pin', 'Move to bottom', 'Move a thread to another channel…'])
  ;(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await settle()
  expect(document.querySelector('[role="menu"]')).toBeNull()
  pick('van').click()
  await settle()
  expect(posts.at(-1)?.[1]).toMatchObject({ key: expect.stringMatching(/^show:channel:van:\d+$/) })
  expect(rail(host)).toStrictEqual(['cmbx', 'van'])
})

it('rebuilds nothing under a held entry: a poll during a hold waits, and the hold lifted opens the menu on it', async () => {
  daemon()
  const { view, ctx, host } = await mount()
  const held = host.querySelector<HTMLButtonElement>('[data-channel="channel:van"]')!
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
  expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent).slice(0, 4)).toStrictEqual(['Hide', 'Pin', 'Move to bottom', 'Move a thread to another channel…'])
  // Lifted, the rail takes the poll: the new constitution names no channel, so it speaks in misc.
  expect(rail(host)).toStrictEqual(['cmbx', 'van', 'misc'])
  ;(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  // The window swallows the click a fired hold sends for a moment; let it pass before the next test clicks.
  await new Promise(resolve => setTimeout(resolve, 750))
})

it('brings a hidden channel back by itself when something in it begins waiting after the hide', async () => {
  daemon([], undefined, {}, { dismissed: [`hide:channel:van:${Date.now() - 35 * minute}`] })
  const { view, ctx, host } = await mount()
  // The van asked half an hour ago, after the hide.
  expect(rail(host)).toStrictEqual(['cmbx', 'van'])
  daemon([], undefined, {}, { dismissed: [`hide:channel:van:${Date.now() - 25 * minute}`] })
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
  await swipe(host.querySelector('.kbn-ch-rail')!, 300, 150)
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
  await swipe(host.querySelector('.kbn-ch-rail')!, 300, 150)
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
  host.querySelector<HTMLButtonElement>('.kbn-ch-count-label')!.click(); await settle()
  const row = [...document.querySelectorAll<HTMLElement>('[role="menuitem"] .thread-row')].find(each => each.querySelector('.thread-row-slug')!.textContent === 'beam')!
  expect([row.querySelector('.thread-row-role'), row.title]).toStrictEqual([null, expect.stringContaining(' — optics · ')])
})

it('heads the view with the channel itself, written as its name, the rail\'s toggle at its right', async () => {
  daemon()
  // The Mill's channel is written as its name, the-mill, not as its chair, felt.
  const mill = card({ id: 'felt', uid: 'L', name: 'The Mill', shuttleChannel: 'The Mill', shuttleSeat: true, ...working(2) })
  const { host } = await mount([chair, tsz, van, mill])
  // The tab bar names the view: no page title of its own.
  expect(host.querySelector('.kbn-view-title')).toBeNull()
  expect(rail(host)).toStrictEqual(['van', 'cmbx', 'the-mill'])
  host.querySelector<HTMLButtonElement>('[data-channel="channel:the mill"]')!.click()
  await settle()
  const head = host.querySelector('.kbn-ch-head')!
  expect(shown(host)).toBe('the-mill')
  expect(head.querySelector('.kbn-ch-name')!.getAttribute('title')).toBe('The Mill')
  expect([...head.querySelectorAll('.kbn-ch-icon')].map(icon => icon.classList[1])).toStrictEqual(['kbn-ch-rail-toggle', 'kbn-ch-back', 'kbn-ch-menu'])
  // Its chair's pages stand beside its name.
  expect([...head.querySelectorAll<HTMLElement>('.kbn-ch-pages .ws-doc-button')].map(button => button.dataset.part)).toStrictEqual(['constitution'])
  // A channel of one constitution is written as its channel too, its chair's name in the tooltip.
  host.querySelector<HTMLButtonElement>('[data-channel="channel:van"]')!.click()
  await settle()
  expect([shown(host), host.querySelector('.kbn-ch-name')!.hasAttribute('data-misc'), host.querySelector('.kbn-ch-name')!.getAttribute('title')]).toStrictEqual(['van', false, 'Moving house'])
})

it('speaks for every constitution without a channel in misc, at the rail\'s foot, with no chair to address and nothing to pin', async () => {
  const { stored } = daemon()
  // Two strays: one asks (the newest wait on the board), one works; a third, quiet for weeks, is in misc but reads nothing.
  const stray = card({ id: 'errand', uid: 'E', name: 'Errand', status: 'active', ask: { text: 'Which form?', at: at(1) } })
  const busy = card({ id: 'busy', uid: 'U', name: 'Busy', ...working(2) })
  const quiet = card({ id: 'quiet', uid: 'Q', name: 'Quiet', status: 'open', modifiedAt: new Date(Date.now() - 20 * day).toISOString() })
  const { host } = await mount([chair, tsz, mask, beam, van, stray, busy, quiet])
  expect(rail(host)).toStrictEqual(['cmbx', 'van', 'misc'])
  const pick = host.querySelector<HTMLButtonElement>('[data-channel="misc"]')!
  expect([pick.hasAttribute('data-misc'), pick.hasAttribute('data-waiting'), pick.querySelector('.kbn-ch-pick-mark')?.textContent]).toStrictEqual([true, true, '1'])
  // First seen on this device: what it said before counts as read.
  expect(Number(stored.get('shuttle.channels.seen:misc'))).toBeGreaterThan(Date.now() - minute)
  pick.click(); await settle()
  expect([shown(host), host.querySelector('.kbn-ch-pages'), stream(host)]).toStrictEqual(['misc', null, [['errand', 'ask', true]]])
  expect(host.querySelector<HTMLElement>('.ws-dock')?.hidden ?? true).toBe(true)
  pick.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  await settle()
  expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).not.toContain('Pin')
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
  expect([...post.querySelectorAll('.kbn-ch-previews .uf-card')].map(file => [file.getAttribute('aria-label'), file.querySelector('.ws-thumbnail') !== null])).toStrictEqual([['Open deck.html', true]])
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

it('withdraws a worker\'s waiting question with its ✓, then takes its line from the stream; a refused withdrawal leaves both', async () => {
  const { posts } = daemon()
  const { host } = await mount()
  const check = () => item(host, 'mask').querySelector<HTMLButtonElement>('.kbn-ch-clear')!
  expect(check().getAttribute('aria-label')).toBe('Clear Cluster mask\'s question')
  check().click()
  await settle(); await settle(); await settle()
  // The question first, on its owner; its line once that has landed.
  expect(posts.slice(-2)).toStrictEqual([
    ['/api/v1/lifecycle', { action: 'ask-clear', fiber: 'cmbx/mask', origin: mask.originId }],
    ['/api/v1/channels/dismiss', { key: expect.stringMatching(/^line:\d+:ask:M:\d+$/), fiber: 'M' }],
  ])
  expect(item(host, 'mask')).toBeUndefined()
})

it('keeps a question and its line when its owner refuses the withdrawal', async () => {
  const { posts } = daemon(['/api/v1/lifecycle'])
  const { host } = await mount()
  item(host, 'mask').querySelector<HTMLButtonElement>('.kbn-ch-clear')!.click()
  await settle(); await settle(); await settle()
  expect([posts.filter(([url]) => url.endsWith('/dismiss')), item(host, 'mask') !== undefined]).toStrictEqual([[], true])
})

it('clears a line that waits on no one from the stream, with e as with its ✓, and an undo brings it back', async () => {
  const { posts } = daemon()
  const { view, host } = await mount()
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

it('counts the threads with a live worker, what waits first, and lists them as thread rows from the count; the strand names what it gathers where it is', async () => {
  daemon()
  // The mask asks from a live worker and the chair is idle at the end of its turn: both run. The van asks with no worker, and the notes are a draft: neither runs.
  const { host, openFromDesk } = await mount([chair, tsz, { ...mask, ...idle(20) }, beam, van, notes])
  const count = host.querySelector<HTMLButtonElement>('.kbn-ch-count-label')!
  expect([count.hidden, count.textContent, count.title]).toStrictEqual([false, '4', '4 running: mask, beam, tsz, cmbx'])
  expect([...host.querySelectorAll('.kbn-ch-gathered > title')].every(title => / gathered here: /.test(title.textContent!))).toBe(true)
  count.click(); await settle()
  const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitem"] .thread-row')]
  expect(rows.map(row => [row.querySelector('.thread-row-slug')!.textContent, row.querySelector('.thread-row-doing')!.textContent])).toStrictEqual([['mask', 'Mask at 5σ or 3σ?'], ['beam', 'working'], ['tsz', 'working'], ['cmbx', 'idle']])
  rows[2].click(); await settle(); await settle()
  expect(openFromDesk).toHaveBeenLastCalledWith(tsz)
})

it('redraws the count when the threads running change and nothing drawn does', async () => {
  daemon()
  const { view, ctx, host } = await mount([chair, tsz, beam])
  expect(host.querySelector('.kbn-ch-count-label')!.textContent).toBe('3')
  // The chair's worker stops, its line in the stream unchanged.
  ctx.response = board([{ ...chair, workerState: undefined, runtimePhase: undefined }, tsz, beam])
  view.refresh(ctx); await settle()
  expect(host.querySelector('.kbn-ch-count-label')!.textContent).toBe('2')
})

it('keeps the head\'s list of the chair\'s files current while it is open, whatever else the head shows', async () => {
  daemon()
  const { view, ctx, host } = await mount()
  const feeds = (ctx.workspace as unknown as { globeHost: { feeds: { files: () => unknown[] } } }).globeHost.feeds
  let files = [{ key: 'local:/w/plan.md', name: 'plan.md', at: Date.now() - minute, unread: false }]
  feeds.files = () => files
  ctx.response = board([{ ...chair, modifiedAt: new Date().toISOString() }, tsz, mask, beam, van, notes])
  view.refresh(ctx); await settle()
  const count = host.querySelector<HTMLButtonElement>('.kbn-ch-pages [data-part="sends"]')!
  count.click(); await settle()
  const rows = (): string[] => [...document.querySelectorAll<HTMLElement>('.kbn-conversation-menu .uf-file-row')].map(row => row.dataset.key!)
  expect(rows()).toStrictEqual(['local:/w/plan.md'])
  // The same count, another file; and the chair's file written, which would draw the head anew.
  files = [{ key: 'local:/w/plan-v2.md', name: 'plan-v2.md', at: Date.now(), unread: false }]
  ctx.response = board([{ ...chair, modifiedAt: new Date(Date.now() + minute).toISOString() }, tsz, mask, beam, van, notes])
  view.refresh(ctx); await settle()
  expect([rows(), count.isConnected, count.getAttribute('aria-expanded')]).toStrictEqual([['local:/w/plan-v2.md'], true, 'true'])
})

it('closes the chair\'s files list and draws the new head when Rex brings another channel', async () => {
  daemon()
  const { view, ctx, host } = await mount()
  const feeds = (ctx.workspace as unknown as { globeHost: { feeds: { files: () => unknown[] } } }).globeHost.feeds
  feeds.files = () => [{ key: 'local:/w/plan.md', name: 'plan.md', at: Date.now() - minute, unread: false }]
  ctx.response = board([{ ...chair, modifiedAt: new Date().toISOString() }, tsz, mask, beam, van, notes])
  view.refresh(ctx); await settle()
  host.querySelector<HTMLButtonElement>('.kbn-ch-pages [data-part="sends"]')!.click(); await settle()
  expect(document.querySelectorAll('.kbn-conversation-menu .uf-file-row')).toHaveLength(1)
  expect(view.followRex('R', 'local')).toBe(true); await settle(); await settle()
  expect([host.querySelector('.kbn-ch-name')!.textContent, document.querySelectorAll('.kbn-conversation-menu .uf-file-row').length]).toStrictEqual(['van', 0])
})

it('lists the running threads as they stand when the list opens, not as the stream last drew them', async () => {
  daemon()
  const { view, ctx, host } = await mount()
  ctx.response = board([chair, tsz, mask, { ...beam, outcome: 'Beam is fitted.', modifiedAt: new Date().toISOString() }, van, notes])
  view.refresh(ctx); await settle()
  host.querySelector<HTMLButtonElement>('.kbn-ch-count-label')!.click(); await settle()
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

it('clears a waiting post again after an undo while its first clear is still being written: the second clear waits for it, and the post stops waiting', async () => {
  const human = { label: 'Sam' }, posted = Date.now() - 4 * minute
  const { posts } = daemon([], undefined, {}, { board: { C: [...BOARD.C, { ...record({ id: 'b5', kind: 'post', fiber: 'C', to: human, text: 'Two calls for you today.' }, 4), timestamp: posted }] }, waiting: { C: { id: 'b5', at: posted } } })
  // The first clear's write hangs until it is let go.
  const answer = vi.mocked(fetch).getMockImplementation()!
  let land = (): void => {}
  const held = new Promise<void>(resolve => { land = resolve })
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const response = answer(url, init)
    return init?.method === 'POST' && String(JSON.parse(String(init.body)).key) === `clear:C:${posted}` ? held.then(() => response) : response
  })
  const { ctx, host } = await mount([chair, tsz, beam])
  item(host, 'cmbx').querySelector<HTMLButtonElement>('.kbn-ch-clear')!.click()
  await settle()
  document.querySelector<HTMLButtonElement>('.shuttle-toast .toast-undo')!.click()
  await settle()
  item(host, 'cmbx').querySelector<HTMLButtonElement>('.kbn-ch-clear')!.click()
  await settle()
  land()
  for (let n = 0; n < 6; n++) await settle()
  const keys = posts.map(([, body]) => String(body.key)).filter(key => /^(un)?clear:C:/.test(key))
  expect(keys.slice(0, 2)).toStrictEqual([`clear:C:${posted}`, `unclear:C:${posted}`])
  expect(keys.length === 3 && Number(keys[2].split(':')[2]) > posted).toBe(true)
  expect([item(host, 'cmbx'), ctx.workspace!.board.waiting.has('C')]).toStrictEqual([undefined, false])
})

it('clears an old post by what waits now once its earlier clear and undo have landed, leaving a newer wait be', async () => {
  const human = { label: 'Sam' }, posted = Date.now() - 4 * minute
  const { posts } = daemon([], undefined, {}, { board: { C: [...BOARD.C, { ...record({ id: 'b5', kind: 'post', fiber: 'C', to: human, text: 'Two calls for you today.' }, 4), timestamp: posted }] }, waiting: { C: { id: 'b5', at: posted } } })
  const { ctx, host } = await mount([chair, tsz, beam])
  item(host, 'cmbx').querySelector<HTMLButtonElement>('.kbn-ch-clear')!.click()
  await settle(); await settle()
  document.querySelector<HTMLButtonElement>('.shuttle-toast .toast-undo')!.click()
  for (let n = 0; n < 4; n++) await settle()
  // The chair asks since: what waits is its question, not the post.
  const board = ctx.workspace!.board as unknown as { lines: Map<string, { id: string; at: number }>; settle(): boolean; changed(): void }
  board.lines.set('C', { id: 'q1', at: Date.now() })
  board.settle(); board.changed(); await settle()
  const from = posts.length
  ;[...host.querySelectorAll<HTMLElement>('.kbn-ch-item')].find(each => each.querySelector('[data-item="item:b5"]'))!.querySelector<HTMLButtonElement>('.kbn-ch-clear')!.click()
  for (let n = 0; n < 4; n++) await settle()
  expect(posts.slice(from).map(([, body]) => String(body.key)).filter(key => key.startsWith('clear:'))).toStrictEqual([])
  expect(ctx.workspace!.board.waiting.get('C')?.id).toBe('q1')
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
  expect(entries.flatMap((entry, row) => entry.kind === 'close' ? [[entry.id, heights![row]]] : [])).toStrictEqual([['v1', 64], ['v2', 64 + foldPx()]])
})

it('takes from the stream the sends whose clear was written, and its undo brings back only those', async () => {
  const { posts } = daemon()
  const answer = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) =>
    init?.method === 'POST' && String(JSON.parse(String(init.body)).key).endsWith('nulls.md:' + SENT[2].timestamp) ? new Response('{"error":"disk full"}', { status: 422 }) : answer(url, init))
  const { host } = await mount()
  item(host, 'tsz').querySelector<HTMLButtonElement>('.kbn-ch-clear')!.click()
  await settle(); await settle()
  expect([...item(host, 'tsz').querySelectorAll<HTMLElement>('.uf-card')].map(card => card.getAttribute('aria-label'))).toStrictEqual(['Open nulls.md'])
  document.querySelector<HTMLButtonElement>('.shuttle-toast .toast-undo')!.click()
  await settle(); await settle()
  expect(posts.filter(([, body]) => String(body.key).startsWith('unline:')).map(([, body]) => String(body.key).replace(/^unline:\d+:/, ''))).toStrictEqual(SENT.slice(0, 2).map(file => `file:local:${file.fullPath}:${file.timestamp}`))
  expect(item(host, 'tsz').querySelectorAll('.uf-card')).toHaveLength(3)
})

it('writes a clear\'s records a few at a time, offers its undo at once, and an undo mid-way writes back what was written and never writes the rest', async () => {
  const many: SentFile[] = Array.from({ length: 7 }, (_, i) => ({ fullPath: `/w/tsz/plot-${i}.png`, basename: `plot-${i}.png`, uid: 'T', host: 'local', timestamp: Date.now() - (20 - i) * minute }))
  const { posts } = daemon()
  const answer = vi.mocked(fetch).getMockImplementation()!
  // In flight and at most in flight, the clear's records and the undo's apart.
  const flying = { line: 0, unline: 0 }, peak = { line: 0, unline: 0 }
  const held: Array<() => void> = []
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (init?.method !== 'POST') return answer(url, init)
    const kind = String(JSON.parse(String(init.body)).key).split(':')[0] as keyof typeof flying
    flying[kind]++; peak[kind] = Math.max(peak[kind], flying[kind])
    await new Promise<void>(resolve => held.push(resolve))
    flying[kind]--
    return answer(url, init)
  })
  const { host } = await mount(undefined, undefined, many)
  item(host, 'tsz').querySelector<HTMLButtonElement>('.kbn-ch-clear')!.click()
  await settle()
  expect([item(host, 'tsz'), flying.line, document.querySelector('.shuttle-toast .toast-undo') !== null]).toStrictEqual([undefined, 4, true])
  // Two land; the undo comes while the next two are on their way.
  held.splice(0, 2).forEach(release => release())
  await settle(); await settle()
  document.querySelector<HTMLButtonElement>('.shuttle-toast .toast-undo')!.click()
  expect(item(host, 'tsz')).toBeDefined()
  while (held.length) { held.splice(0).forEach(release => release()); await settle(); await settle() }
  expect(peak).toStrictEqual({ line: 4, unline: 4 })
  const keys = posts.map(([, body]) => String(body.key)), named = (prefix: string) => keys.filter(key => key.startsWith(prefix)).map(key => key.replace(/^\w+:\d+:/, '')).sort()
  // The two that landed made way for two more: six were sent before the undo, each is written back, and the last was never written.
  expect(named('line:')).toStrictEqual(many.slice(0, 6).map(file => `file:local:${file.fullPath}:${file.timestamp}`).sort())
  expect(named('unline:')).toStrictEqual(named('line:'))
  expect(item(host, 'tsz').querySelectorAll('.uf-card')).toHaveLength(7)
})

it('names in its ✓ a send brought back on another device, though the item draws the same', async () => {
  const older = { ...SENT[1], timestamp: Date.now() - 14.5 * minute }, id = `file:local:${older.fullPath}:${older.timestamp}`
  const kept = { dismissed: [`line:${Date.now() - 5 * minute}:${id}`] }
  const { posts } = daemon([], undefined, {}, kept)
  const { view, ctx } = await mount(undefined, undefined, [older, ...SENT])
  kept.dismissed.push(`unline:${Date.now() - minute}:${id}`)
  view.refresh(ctx); await settle(); await settle()
  item(document.body, 'tsz').querySelector<HTMLButtonElement>('.kbn-ch-clear')!.click()
  await settle(); await settle()
  expect(posts.map(([, body]) => String(body.key).replace(/^line:\d+:/, ''))).toContain(id)
})

const menuItem = async (label: string) => {
  await settle()
  ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(each => each.textContent?.startsWith(label))!.click()
  await settle(); await settle()
}
const lifecycles = (posts: Array<[string, Record<string, unknown>]>) => posts.filter(([url]) => url.endsWith('/lifecycle')).map(([, body]) => body)

it('moves a family out of misc into a new channel by its top-level\'s channel, at once, and an undo writes back what it had', async () => {
  const { posts } = daemon()
  const errand = card({ id: 'errand', uid: 'E', name: 'Errand', status: 'active', ask: { text: 'Which form?', at: at(1) } })
  const leg = card({ id: 'errand/leg', uid: 'EL', name: 'Leg', orchestrator: 'E', ...working(2) })
  const { host } = await mount([chair, tsz, van, errand, leg])
  // Van waits, so it floats; misc, though its errand waits too, stays at the foot.
  expect(rail(host)).toStrictEqual(['van', 'cmbx', 'misc'])
  host.querySelector('[data-channel="misc"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  await menuItem('Move a thread')
  await menuItem('errand')
  // The picker offers the named channels and a new one as typed; misc, where it is now, is not a move.
  const field = document.querySelector<HTMLInputElement>('.kbn-move-field')!
  expect([...document.querySelectorAll('.kbn-move-option:not(:disabled) .kbn-move-name')].map(each => each.textContent)).toStrictEqual(['#cmbx', '#van'])
  field.value = 'Paper work'
  field.dispatchEvent(new Event('input'))
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await settle(); await settle()
  expect(lifecycles(posts)).toStrictEqual([{ action: 'channel', fiber: 'errand', origin: errand.originId, channel: 'Paper work' }])
  // The thread under it moves with it.
  expect(rail(host)).toStrictEqual(['paper-work', 'van', 'cmbx'])
  document.querySelector<HTMLButtonElement>('.shuttle-toast .toast-undo')!.click()
  await settle(); await settle()
  expect(lifecycles(posts).at(-1)).toStrictEqual({ action: 'channel', fiber: 'errand', origin: errand.originId, channel: null })
  expect(rail(host)).toStrictEqual(['van', 'cmbx', 'misc'])
})

it('archives a channel: every constitution that names it, closed ones too, names none, nothing is tempered, and its live threads speak in misc', async () => {
  const { posts } = daemon()
  const earlier = card({ id: 'cmbx-old', uid: 'C0', name: 'Old cmbx', shuttleChannel: 'cmbx', status: 'closed', column: 'tempered' })
  const { host } = await mount([chair, tsz, mask, beam, van, earlier])
  host.querySelector('[data-channel="channel:cmbx"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  await menuItem('Archive #cmbx')
  expect(lifecycles(posts)).toStrictEqual([
    { action: 'channel', fiber: 'cmbx', origin: chair.originId, channel: null },
    { action: 'channel', fiber: 'cmbx-old', origin: earlier.originId, channel: null },
  ])
  expect(rail(host)).toStrictEqual(['van', 'misc'])
  expect(document.querySelector('.shuttle-toast')!.textContent).toContain('#cmbx archived: its threads speak in #misc, or in a channel above them.')
  document.querySelector<HTMLButtonElement>('.shuttle-toast .toast-undo')!.click()
  await settle(); await settle()
  expect(lifecycles(posts).slice(-2).map(body => [body.fiber, body.channel])).toStrictEqual([['cmbx', 'cmbx'], ['cmbx-old', 'cmbx']])
  expect(rail(host)).toStrictEqual(['cmbx', 'van'])
})

it('takes a move back and says so when the owner refuses it', async () => {
  const { posts } = daemon(['/api/v1/lifecycle'])
  const { host } = await mount([chair, tsz, van])
  host.querySelector('[data-channel="channel:van"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  await menuItem('Archive #van')
  expect(lifecycles(posts)).toHaveLength(1)
  expect([rail(host), host.querySelector('.kbn-ch-note, [role="status"]')?.textContent ?? '']).toStrictEqual([['van', 'cmbx'], expect.stringContaining('could not be written')])
})

it('moves to misc a family whose channel comes from a closed constitution it is filed under by writing misc, and leaves misc out of the order', async () => {
  const { posts } = daemon()
  const alpha = card({ id: 'alpha', uid: 'A0', name: 'Alpha', shuttleChannel: 'Alpha', status: 'closed', column: 'tempered' })
  const kid = card({ id: 'alpha/kid', uid: 'AK', name: 'Kid', ...working(2) })
  const stray = card({ id: 'stray', uid: 'ST', name: 'Stray', ...working(3) })
  const { host } = await mount([chair, tsz, alpha, kid, stray])
  host.querySelector('[data-channel="channel:alpha"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  await menuItem('Move a thread')
  await menuItem('kid')
  const field = document.querySelector<HTMLInputElement>('.kbn-move-field')!
  // A typed # names the same channel.
  field.value = '#misc'
  field.dispatchEvent(new Event('input'))
  expect([...document.querySelectorAll('.kbn-move-option .kbn-move-name')].map(each => each.textContent)).toStrictEqual(['#misc'])
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await settle(); await settle()
  expect(lifecycles(posts)).toStrictEqual([{ action: 'channel', fiber: 'alpha/kid', origin: kid.originId, channel: 'misc' }])
  expect(rail(host)).toStrictEqual(['cmbx', 'misc'])
  // Moving a channel to the bottom writes the named channels alone.
  host.querySelector('[data-channel="channel:cmbx"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  await menuItem('Move to bottom')
  expect(posts.filter(([url]) => url.endsWith('/channels/order')).at(-1)?.[1]).toStrictEqual({ keys: ['channel:cmbx'] })
})

it('opens a channel on its newest lines, back to the oldest it holds unread, and Earlier shows as many again', async () => {
  const human = { label: 'Sam' }
  const posts = Array.from({ length: 12 }, (_, n) => record({ id: `p${n}`, kind: 'post', fiber: 'C', to: human, text: `Round ${n}.` }, 120 - n * 10))
  const said = (host: HTMLElement) => [...host.querySelectorAll('.kbn-ch-item .kbn-ch-item-text')].map(el => el.textContent?.trim())
  const read = async (seenMinutesAgo: number) => {
    daemon([], new Map([['shuttle.channels.seen:channel:cmbx', String(Date.now() - seenMinutesAgo * minute)]]), {}, { board: { C: posts } })
    return mount([chair])
  }
  // Read a moment ago: its newest eight, and Earlier for the four before them.
  const { host, view } = await read(1)
  expect(said(host)).toStrictEqual(posts.slice(4).map(post => post.text))
  expect(host.querySelector('.kbn-ch-earlier-more')?.textContent).toBe('Earlier · 4 more')
  host.querySelector<HTMLButtonElement>('.kbn-ch-earlier-more')!.click()
  expect([said(host).length, host.querySelector('.kbn-ch-earlier')]).toStrictEqual([12, null])
  view.unmount(); document.body.replaceChildren()
  // Last read before the third: it opens there, on everything unread.
  const again = await read(105)
  expect(said(again.host)).toStrictEqual(posts.slice(2).map(post => post.text))
  // Earlier reaches back from where the window starts, here past its first two lines.
  again.host.querySelector<HTMLButtonElement>('.kbn-ch-earlier-more')!.click()
  expect(said(again.host).length).toBe(12)
  again.view.unmount(); document.body.replaceChildren()
  // Rex brought to a worker whose only line is a handoff before the window: the window widens to it, and marks it.
  daemon([], new Map([['shuttle.channels.seen:channel:cmbx', String(Date.now())]]), {}, { board: { C: [record({ id: 'h1', kind: 'handed_off', fiber: 'B' }, 200), ...posts] } })
  const followed = await mount([chair, beam])
  expect(followed.host.querySelector('.kbn-ch-stream > [data-what="tick"]')).toBeNull()
  expect(followed.view.followRex('B', 'local')).toBe(true)
  expect(followed.host.querySelector('.kbn-ch-stream > [data-what="tick"]')?.hasAttribute('data-marked')).toBe(true)
})

it('folds the open channel to what Find holds, each match marked, steps between them, and draws it whole again', async () => {
  daemon()
  const { view, host } = await mount()
  const scope = view.findScope()!
  expect(scope.chip).toBe('in #cmbx')
  const find = 'inPlace' in scope ? scope.inPlace : undefined
  const folds = () => [...host.querySelectorAll('.kbn-ch-stream > .kbn-ch-folded')].map(el => el.textContent)
  const marks = () => [...host.querySelectorAll('.kbn-ch-stream mark')].map(el => el.textContent)
  const found = () => host.querySelector<HTMLElement>('.kbn-ch-stream > [data-found]')?.dataset.slug
  // The expert's files are captioned at 9σ: its line stays from its start, the rest folds away about it.
  find!.input('9σ')
  expect(stream(host)).toStrictEqual([['tsz', 'start'], ['tsz', 'file', false]])
  expect(folds()).toStrictEqual(['· · · 1 row folded · · ·', '· · · 1 row folded · · ·'])
  expect(marks()).toStrictEqual(['9σ'])
  expect(found()).toBe('tsz')
  // Two matches: the newest is in hand, and ↑ goes to the older.
  find!.input('σ')
  expect(stream(host).filter(row => row.length === 3).map(row => row[0])).toStrictEqual(['mask', 'tsz'])
  expect(found()).toBe('tsz')
  find!.step(-1)
  expect(found()).toBe('mask')
  find!.input('nowhere at all')
  expect(host.querySelector('.kbn-ch-stream > .kbn-ch-hush')?.textContent).toBe('Nothing in #cmbx says “nowhere at all”.')
  find!.clear()
  expect(stream(host)).toStrictEqual([['tsz', 'start'], ['mask', 'ask', true], ['tsz', 'file', false], ['beam', 'tick']])
  expect([folds(), marks(), found()]).toStrictEqual([[], [], undefined])
})

it('opens where Find picked: a hidden channel brought back, the picked line marked', async () => {
  const { posts } = daemon([], new Map(), {}, { dismissed: [`hide:channel:van:${Date.now()}`] })
  const { view, host } = await mount()
  expect(rail(host)).toStrictEqual(['cmbx'])
  const line = `ask:R:${Date.parse(van.ask!.at)}`
  view.show({ channel: 'channel:van', item: line })
  await settle()
  expect(shown(host)).toBe('van')
  expect(posts.at(-1)?.[1]).toMatchObject({ key: expect.stringMatching(/^show:channel:van:\d+$/) })
  expect(host.querySelector<HTMLElement>('.kbn-ch-stream > [data-marked]')?.dataset.slug).toBe('van')
})
