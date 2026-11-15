// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { ChannelsView, collapse } from './ChannelsView.js'
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
const van = card({ id: 'van', uid: 'R', name: 'Moving house', status: 'active', ask: { text: 'Which van?', at: at(30) } })
const notes = card({ id: 'notes', uid: 'N', name: 'Old notes', status: 'open', modifiedAt: new Date(Date.now() - 20 * day).toISOString() })
const record = (over: Partial<BoardRecord> & Pick<BoardRecord, 'id' | 'kind' | 'fiber'>, minutes: number): BoardRecord => ({ by: { fiber: over.fiber }, timestamp: Date.now() - minutes * minute, originName: 'local', ...over })
const BOARD: Record<string, BoardRecord[]> = {
  C: [
    record({ id: 'b1', kind: 'post', fiber: 'T', text: 'κ×tSZ is measured to **9σ**.', files: ['/notes/tsz/spectrum.png'] }, 30),
    record({ id: 'brd-human-b2', kind: 'human', fiber: 'T', by: { label: 'Sam' }, text: 'Show the nulls too?' }, 25),
    record({ id: 'b3', kind: 'asked', fiber: 'M', text: 'Mask at 5σ or 3σ?' }, 20),
    record({ id: 'b4', kind: 'post', fiber: 'C', text: 'Two calls for you today.' }, 12),
  ],
}

/** Tapestry pages the daemon serves, by path. */
const PAGES = new Map<string, string>()
/** A daemon that answers the Channels view's reads, records its writes, and fails the ones `fail` names. */
function daemon(fail: string[] = [], stored = new Map<string, string>(), pinned: Record<string, number> = {}, kept: { dismissed?: string[]; order?: { keys: string[]; at: number } } = {}, answer: Record<string, unknown> = { ok: true, delivered: true }) {
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
    const page = PAGES.get(new URL(url, 'http://test').searchParams.get('path') ?? '')
    if (url.includes('/file-info')) return new Response(JSON.stringify(page ? { exists: true, size: page.length, modified_at: 1 } : { exists: false }))
    if (page && url.includes('/api/v1/file?')) return new Response(page, { headers: { 'content-type': 'text/html' } })
    return new Response('{}')
  }))
  return { posts, stored, families }
}
const board = (inFlight: ReturnType<typeof card>[]) => response({ now: { drafts: [], inFlight, awaitingReview: [] } })
const sentDoc = (uid: string, path: string, minutes: number, fiber = card({ id: uid, uid, name: uid })) =>
  ({ card: fiber, receipt: { uid, key: `host:${path}`, owner: 'host', host: 'host', fullPath: path, basename: path.split('/').at(-1)!, timestamp: Date.now() - minutes * minute } })
const library = [sentDoc('old', '/notes/old/lensing-notes.md', 600, card({ id: 'old', uid: 'old', name: 'Lensing notes' }))]
async function mount(inFlight = [chair, tsz, mask, beam, van, notes], view = new ChannelsView(), sent: SentFile[] = [], prepare?: (host: HTMLElement) => void, shuttleBase = '') {
  const openFromDesk = vi.fn(), openPage = vi.fn(), requestRefresh = vi.fn(), see = vi.fn(async () => false)
  const workspace = {
    openFromDesk, openPage, look: see,
    library: { subscribe: () => () => {}, visit: () => {}, cancelOpen: vi.fn(), documents: () => library, receipts: () => [] },
  }
  const sends = { files: sent, subscribe: () => () => {}, refresh: async () => {} }
  const ctx = { cards: [], response: board(inFlight), shuttleBase, workspace, sends, requestRefresh, openCard: vi.fn() } as unknown as ViewContext
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
  const { view, host, threadReply, openPage, requestRefresh, see } = await mount()
  const thread = host.querySelector<HTMLElement>('.kbn-ch-thread')!
  expect(thread.hidden).toBe(true)
  message(host, 'κ × tSZ').querySelector<HTMLElement>('.kbn-ch-msg-body')!.click()
  expect(thread.hidden).toBe(false)
  expect(host.querySelector('.kbn-ch-layout')!.hasAttribute('data-thread')).toBe(true)
  expect([thread.querySelector('.kbn-ch-thread-name')?.textContent, thread.querySelector('.kbn-ch-liveness')?.textContent]).toStrictEqual(['κ × tSZ', 'working'])
  // Opening the thread is the board looking at it: voice and Rex follow its worker.
  expect(see).toHaveBeenLastCalledWith(tsz)
  expect([...thread.querySelectorAll('.kbn-ch-msg')].map(el => [el.querySelector('.kbn-ch-msg-name')?.textContent, el.getAttribute('data-kind')])).toStrictEqual([[undefined, 'post'], ['You', 'reply']])
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
  // Once: in the head, not again in the history.
  expect(thread.querySelectorAll('.kbn-ch-thread-list .kbn-ch-msg[data-kind="ask"]')).toHaveLength(0)
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
  expect(host.querySelector('.kbn-ch-thread-head .kbn-ch-tip')?.textContent).toBe('Back to # cmbx')
  back.click()
  expect(layout.hasAttribute('data-thread')).toBe(false)
  // Wide again, a thread stands beside the channel.
  widths.forEach(seen => seen([{ contentRect: { width: 1400 } }]))
  message(host, 'κ × tSZ').click()
  expect([layout.hasAttribute('data-narrow'), host.querySelector('.kbn-ch-thread-head .kbn-ch-tip')!.textContent]).toStrictEqual([false, 'Close the thread'])
})

it('collapses a tapestry to its title, lede and first figure, an inline SVG drawn as an image', () => {
  expect(collapse('<h1>κ × tSZ</h1><p>At 9σ.</p><figure><img src="plots/spectrum.png"></figure>', '/notes/tsz')).toStrictEqual({ title: 'κ × tSZ', lede: 'At 9σ.', figure: '/notes/tsz/plots/spectrum.png' })
  const drawn = collapse('<style>.line{stroke:red}</style><h1>A</h1><svg viewBox="-12 -12 24 24"><path/></svg><svg width="0" height="0"><defs/></svg><svg viewBox="0 0 600 300"><svg viewBox="0 0 10 10"/><path class="line" d="M0 0"/></svg>').figure!
  // The icon and the sprite sheet are passed over; the plot carries the page's styles and its namespace.
  expect(drawn).toMatch(/^data:image\/svg\+xml,/)
  expect(decodeURIComponent(drawn)).toContain('viewBox="0 0 600 300"')
  expect(decodeURIComponent(drawn)).toContain('.line{stroke:red}')
  expect(decodeURIComponent(drawn)).toContain('xmlns="http://www.w3.org/2000/svg"')
  expect(collapse('<h1>A</h1><img src="https://example.org/a.png">').figure).toBe('https://example.org/a.png')
  expect(collapse('<title>T</title><p>Only words.</p>')).toStrictEqual({ title: 'T', lede: 'Only words.', figure: undefined })
})

it('shows a worker\'s own tapestry under its line and in its thread\'s head, and opens it in the reader', async () => {
  PAGES.set('/notes/tsz/tapestry.html', '<h1>κ × tSZ at 9σ</h1><p>Every null passes.</p><img src="spectrum.png">')
  try {
    daemon()
    const { host, openPage } = await mount([chair, { ...tsz, fiberDir: '/notes/tsz' }, mask, beam, van, notes])
    await settle(); await settle()
    const embed = message(host, 'κ × tSZ').querySelector<HTMLButtonElement>('.kbn-ch-embed')!
    expect([embed.querySelector('.kbn-ch-embed-title')?.textContent, embed.querySelector('.kbn-ch-embed-lede')?.textContent]).toStrictEqual(['κ × tSZ at 9σ', 'Every null passes.'])
    expect(embed.querySelector('img')?.getAttribute('src')).toBe(`/api/v1/file?path=${encodeURIComponent('/notes/tsz/spectrum.png')}`)
    embed.click()
    expect(openPage).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'cmbx/tsz' }), 'local:/notes/tsz/tapestry.html')
    message(host, 'κ × tSZ').querySelector<HTMLElement>('.kbn-ch-msg-name')!.click()
    expect(host.querySelector('.kbn-ch-thread-head .kbn-ch-embed-title')?.textContent).toBe('κ × tSZ at 9σ')
    // Inside the thread, its messages carry none.
    expect(host.querySelectorAll('.kbn-ch-thread-list .kbn-ch-embed')).toHaveLength(0)
  } finally { PAGES.clear() }
})

it('a retried reply keeps its id, so the owner types it at most once; another reply gets its own', async () => {
  const { posts } = daemon(['/api/v1/deliver'])
  const { host, reply } = await mount()
  const send = async (text: string) => {
    reply.value = text
    reply.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()
  }
  await send('Keep it.')
  expect(host.querySelector('.kbn-ch-note')?.textContent ?? '').toContain('Not sent')
  await send('Keep it.')
  await send('Drop it.')
  const ids = posts.filter(([url]) => url === '/api/v1/deliver').map(([, body]) => body.message_id)
  expect(ids[0]).toMatch(/^human-[0-9a-f]{32}$/)
  expect(ids[1]).toBe(ids[0])
  expect(ids[2]).not.toBe(ids[0])
})

it('a repeated reply reads as sent only when its first send was delivered; else it may not have arrived, and sending again is a new message', async () => {
  const send = async (reply: HTMLTextAreaElement, text: string) => {
    reply.value = text
    reply.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()
  }
  {
    daemon([], new Map(), {}, {}, { delivery: 'input', duplicate: true, disposition: 'delivered', delivered: true })
    const { host, reply } = await mount()
    await send(reply, 'Keep it.')
    expect(reply.value).toBe('')
    expect(host.querySelector('.kbn-ch-note')?.textContent ?? '').not.toContain('may not have arrived')
  }
  document.body.replaceChildren()
  const { posts } = daemon([], new Map(), {}, {}, { delivery: 'input', duplicate: true, disposition: 'unknown', delivered: null })
  const { host, reply } = await mount()
  await send(reply, 'Keep it.')
  expect(host.querySelector('.kbn-ch-note')?.textContent).toContain('may not have arrived')
  expect(reply.value).toBe('Keep it.')
  await send(reply, 'Keep it.')
  const ids = posts.filter(([url]) => url === '/api/v1/deliver').map(([, body]) => body.message_id)
  expect(ids).toHaveLength(2)
  expect(ids[1]).not.toBe(ids[0])
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

it('sets a waiting channel aside, pins and unpins from its menu, and restores a write that fails', async () => {
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
  await choose('Not now')
  // The newest wait is the mask's ask; the chair, idle at the end of its turn, waits on no one.
  expect(posts[0][0]).toBe('/api/v1/channels/dismiss')
  expect(posts[0][1]).toMatchObject({ key: `office:channel:cmbx:${Date.parse(mask.ask!.at!)}`, fiber: 'C' })
  // The mark clears; cmbx stays in the rail, active this week.
  expect(host.querySelector('[data-channel="channel:cmbx"]')!.hasAttribute('data-waiting')).toBe(false)
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
  expect(rail(host)).toStrictEqual(['cmbx', 'Moving house', 'science', 'french'])
  const pick = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('.kbn-ch-pick')].find(el => el.querySelector('.kbn-ch-pick-name')?.textContent === name)!
  const press = (name: string, key: string, over: KeyboardEventInit = {}) => pick(name).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...over }))
  press('science', 'ArrowDown', { altKey: true })
  await settle()
  // Every channel's place is written, the ones out of the rail and the waiting ones keeping theirs.
  expect(posts.at(-1)).toStrictEqual(['/api/v1/channels/order', { keys: ['channel:cmbx', 'fiber:R', 'fiber:N', 'channel:french', 'channel:science'] }])
  expect(rail(host)).toStrictEqual(['cmbx', 'Moving house', 'french', 'science'])
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
  expect(posts.at(-1)).toStrictEqual(['/api/v1/channels/order', { keys: ['channel:cmbx', 'fiber:R', 'fiber:N', 'channel:science', 'channel:french'] }])
  expect(rail(host)).toStrictEqual(['cmbx', 'Moving house', 'science', 'french'])
  // A poll keeps the order written here until the feed carries a newer one.
  view.refresh(ctx); await settle()
  expect(rail(host)).toStrictEqual(['cmbx', 'Moving house', 'science', 'french'])
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
  expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toStrictEqual(['Not now', 'Unhide', 'Pin', 'Move to bottom'])
  ;(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await settle()
  expect(document.querySelector('[role="menu"]')).toBeNull()
  pick('Moving house').click()
  await settle()
  expect(posts.at(-1)?.[1]).toMatchObject({ key: expect.stringMatching(/^show:fiber:R:\d+$/) })
  expect(rail(host)).toStrictEqual(['cmbx', 'Moving house'])
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
  expect(rail(host)).toStrictEqual(['cmbx', 'Moving house'])
  window.dispatchEvent(Object.assign(press('pointerup'), { pointerId: 1, pointerType: 'touch', isPrimary: true }))
  await settle()
  expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toStrictEqual(['Not now', 'Hide', 'Pin', 'Move to bottom'])
  // Lifted, the rail takes the poll.
  expect(rail(host)).toStrictEqual(['cmbx', 'Moving house', 'Fresh'])
  ;(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  // The window swallows the click a fired hold sends for a moment; let it pass before the next test clicks.
  await new Promise(resolve => setTimeout(resolve, 750))
})

it('brings a hidden channel back by itself when something in it begins waiting after the hide', async () => {
  daemon([], undefined, {}, { dismissed: [`hide:fiber:R:${Date.now() - 35 * minute}`] })
  const { view, ctx, host } = await mount()
  // The van asked half an hour ago, after the hide.
  expect(rail(host)).toStrictEqual(['cmbx', 'Moving house'])
  daemon([], undefined, {}, { dismissed: [`hide:fiber:R:${Date.now() - 25 * minute}`] })
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
  const tip = () => toggle.closest('ui-tooltip')!.querySelector('.kbn-ch-tip')!.textContent
  expect([layout.hasAttribute('data-rail-hidden'), tip()]).toStrictEqual([false, 'Hide channels'])
  // No key hints on the page: the keyboard help holds them.
  expect(host.textContent).not.toContain('j / k')
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

it('shows a reply sent from here until the board records it, once, or for two minutes at most', async () => {
  daemon()
  const { view, ctx, host, reply } = await mount()
  const yours = () => [...host.querySelectorAll('.kbn-ch .kbn-ch-msg[data-human] .kbn-ch-msg-text')].map(el => el.textContent?.trim())
  reply.value = 'Ship it.'
  host.querySelector<HTMLFormElement>('.kbn-ch-reply')!.requestSubmit()
  await settle()
  expect(yours()).toStrictEqual(['Ship it.'])
  // The daemon records the board's line as `human`, keyed by the line's id: it takes the echo's place.
  BOARD.C.push(record({ id: 'brd-human-1', kind: 'human', fiber: 'C', by: { label: 'Sam' }, text: 'Ship it.' }, 0))
  try {
    view.refresh(ctx); await settle(); await settle()
    expect(yours()).toStrictEqual(['Ship it.'])
  } finally { BOARD.C.pop() }
  // Unrecorded (a daemon that writes no such record), it stands two minutes.
  const clock = vi.spyOn(Date, 'now')
  reply.value = 'And the nulls.'
  host.querySelector<HTMLFormElement>('.kbn-ch-reply')!.requestSubmit()
  await settle()
  expect(yours()).toContain('And the nulls.')
  const later = Date.now() + 2 * minute + 1
  clock.mockReturnValue(later)
  view.refresh(ctx); await settle()
  expect(yours()).not.toContain('And the nulls.')
})

it('draws a record two families share once, asks again a minute before its newest, and says when a history cannot be read', async () => {
  // Vizier: two top-levels in one channel; a message between them is served to both families.
  const vizier = card({ id: 'vizier', uid: 'V', name: 'Vizier', shuttleChannel: 'Vizier', shuttleSeat: true, ...idle(5) })
  const dream = card({ id: 'dream', uid: 'D', name: 'Dream', shuttleChannel: 'Vizier', ...working(2) })
  const shared = record({ id: 'brd-shared', kind: 'message', fiber: 'D', by: { fiber: 'V' }, text: 'Sweep the slugs.' }, 10)
  const posted = record({ id: 'brd-post', kind: 'post', fiber: 'D', text: 'Swept.' }, 5)
  BOARD.V = [shared]; BOARD.D = [shared, posted]
  try {
    const { families } = daemon()
    const urls: string[] = []
    const fetcher = vi.mocked(fetch)
    const real = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async (url, init) => { urls.push(String(url)); return real(url, init) })
    const { view, ctx, host } = await mount([vizier, dream])
    expect(families).toEqual(expect.arrayContaining(['V', 'D']))
    message(host, 'Dream').click()
    expect([...host.querySelectorAll('.kbn-ch-thread-list .kbn-ch-msg-text')].map(el => el.textContent?.trim())).toStrictEqual(['Sweep the slugs.', 'Swept.'])
    view.refresh(ctx); await settle()
    const since = urls.filter(url => url.includes('fiber=D')).map(url => Number(new URL(url, 'http://test').searchParams.get('since_ms')))
    expect(since.at(-1)).toBe(posted.timestamp - minute)
    // A family that does not answer reads as unread history, not an empty channel.
    fetcher.mockImplementation(async (url, init) => String(url).includes('/board/family') ? new Response('{"error":"down"}', { status: 502 }) : real(url, init))
    const again = await mount([card({ id: 'quiet', uid: 'Q', name: 'Quiet', shuttleChannel: 'Quiet', ...working(1) })], new ChannelsView())
    expect(again.host.querySelector('.kbn-ch .kbn-ch-hush')?.textContent).toBe('This channel\'s history could not be read; trying again.')
  } finally { delete BOARD.V; delete BOARD.D }
})

it('shows the chair once, by its latest line, however many it sent', async () => {
  BOARD.C.push(record({ id: 'b5', kind: 'post', fiber: 'C', text: 'And one more thing.' }, 8))
  try {
    daemon()
    const { host } = await mount()
    const rows = [...host.querySelectorAll('.kbn-ch .kbn-ch-msg')].map(el => [el.querySelector('.kbn-ch-msg-name')?.textContent ?? null, el.hasAttribute('data-continued')])
    expect(rows).toStrictEqual([['κ × tSZ', false], ['Cluster mask', false], ['cmbx chair', false]])
    expect(message(host, 'cmbx chair').textContent).toContain('And one more thing.')
  } finally { BOARD.C.pop() }
})

it('offers no reply to a closed worker, and names an image its host no longer holds', async () => {
  daemon()
  const done = card({ id: 'cmbx/done', uid: 'X', name: 'Done', orchestrator: 'C', column: 'tempered', status: 'closed', closedAt: at(30), outcome: 'Measured.' })
  BOARD.C.push(record({ id: 'b6', kind: 'post', fiber: 'X', text: 'Finished.', files: ['/gone/shot.png'] }, 40))
  try {
    const { host } = await mount([chair, tsz, mask, beam, done])
    const image = message(host, 'Done').querySelector<HTMLImageElement>('.kbn-ch-image img')!
    image.dispatchEvent(new Event('error'))
    expect(message(host, 'Done').querySelector('.kbn-ch-file[data-gone]')?.textContent).toBe('shot.png')
    message(host, 'Done').click()
    const forms = host.querySelectorAll<HTMLFormElement>('.kbn-ch-reply')
    expect(forms[1].hidden).toBe(true)
    expect(host.querySelector('.kbn-ch-reopen')?.textContent).toBe('Closed. Reopen it from its page to reply.')
  } finally { BOARD.C.pop() }
})

it('keeps a channel read to the moment it was left', async () => {
  const { stored } = daemon()
  const { view } = await mount()
  const opened = Number(stored.get('shuttle.channels.seen:channel:cmbx'))
  const clock = vi.spyOn(Date, 'now').mockReturnValue(opened + 30 * minute)
  view.keydown(new KeyboardEvent('keydown', { key: 'j' }))
  expect(Number(stored.get('shuttle.channels.seen:channel:cmbx'))).toBe(opened + 30 * minute)
  clock.mockRestore()
})

it('takes no older record with the same words for the board\'s record of a reply', async () => {
  // The chair was told "ok" from here a week ago: a new "ok" still shows beside it until its own record arrives.
  BOARD.C.push(record({ id: 'brd-human-old-ok', kind: 'human', fiber: 'C', by: { label: 'Sam' }, text: 'ok' }, 7 * 24 * 60))
  try {
    daemon()
    const { host, reply } = await mount()
    reply.value = 'ok'
    host.querySelector<HTMLFormElement>('.kbn-ch-reply')!.requestSubmit()
    await settle()
    expect([...host.querySelectorAll('.kbn-ch .kbn-ch-msg[data-human] .kbn-ch-msg-text')].map(el => el.textContent?.trim())).toStrictEqual(['ok', 'ok'])
  } finally { BOARD.C.pop() }
})

it('names each icon by its tooltip', async () => {
  daemon()
  const { host } = await mount()
  for (const icon of host.querySelectorAll<HTMLButtonElement>('.kbn-ch-icon')) {
    const tip = icon.closest('ui-tooltip')!.querySelector('.kbn-ch-tip')!
    expect(icon.getAttribute('aria-labelledby')?.split(' ')).toContain(tip.id)
  }
})

it('reads the charters\' names again after a read that failed', async () => {
  daemon()
  const fetcher = vi.mocked(fetch), real = fetcher.getMockImplementation()!
  let roles = 0
  fetcher.mockImplementation(async (url, init) => {
    if (!String(url).includes('/roles')) return real(url, init)
    return ++roles === 1 ? new Response('{"error":"down"}', { status: 502 }) : new Response(JSON.stringify([{ slug: 'first-contact', name: 'Vizier' }]))
  })
  const errand = card({ id: 'errand', uid: 'E', name: 'Errand', shuttleRole: 'first-contact', ...working(1) })
  const { view, ctx, host } = await mount([chair, tsz, mask, beam, van, errand], new ChannelsView(), [], undefined, 'http://retry.test')
  expect(rail(host)).toContain('first-contact')
  view.refresh(ctx); await settle(); await settle()
  expect(roles).toBe(2)
  expect(rail(host)).toContain('vizier')
})

it('lets go of records past the board\'s reach', async () => {
  daemon()
  const { view, ctx, host } = await mount()
  expect(message(host, 'κ × tSZ')).toBeDefined()
  // Fifteen days on, the post is out of reach.
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15 * day)
  view.refresh(ctx); await settle(); await settle()
  expect(stream(host).map(([name]) => name)).not.toContain('κ × tSZ')
  clock.mockRestore()
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

it('opens on the channel and thread last open on this device, and on the first channel when that one is gone', async () => {
  const { stored } = daemon()
  const first = await mount()
  first.view.keydown(new KeyboardEvent('keydown', { key: 'j' }))
  first.view.keydown(new KeyboardEvent('keydown', { key: 'k' }))
  message(first.host, 'κ × tSZ').click()
  first.view.unmount(); views.length = 0
  // A reload: a new view on the same device.
  const again = await mount(undefined, new ChannelsView())
  expect(shown(again.host)).toBe('cmbx')
  expect(again.host.querySelector('.kbn-ch-thread-name')?.textContent).toBe('κ × tSZ')
  again.view.keydown(new KeyboardEvent('keydown', { key: 'Escape' }))
  again.view.keydown(new KeyboardEvent('keydown', { key: 'j' }))
  again.view.unmount(); views.length = 0
  const third = await mount(undefined, new ChannelsView())
  expect([shown(third.host), (third.host.querySelector('.kbn-ch-thread') as HTMLElement).hidden]).toStrictEqual(['Moving house', true])
  third.view.unmount(); views.length = 0
  stored.set('shuttle.channels.last', JSON.stringify({ channel: 'channel:gone', thread: 'T' }))
  const fourth = await mount(undefined, new ChannelsView())
  expect(shown(fourth.host)).toBe('cmbx')
})

it('clears a worker\'s line by its ✓, offers Undo in its place, and keeps a clear across devices', async () => {
  const { posts } = daemon()
  const { host } = await mount()
  const check = (name: string) => message(host, name)?.querySelector<HTMLButtonElement>('.kbn-ch-check')
  // An ask needs an answer: no ✓. The ✓ is an icon named by its tooltip.
  expect(check('Cluster mask')).toBeNull()
  expect(check('κ × tSZ')!.closest('ui-tooltip')!.querySelector('.kbn-ch-tip')?.textContent).toBe('Clear')
  check('κ × tSZ')!.click()
  await settle()
  const posted = BOARD.C[0].timestamp
  expect(posts).toStrictEqual([['/api/v1/channels/dismiss', { key: `clear:T:${posted}`, fiber: 'T' }]])
  // In its place, the line's Undo.
  expect(stream(host).map(([name]) => name)).toStrictEqual([undefined, 'Cluster mask', 'cmbx chair'])
  const cleared = host.querySelector<HTMLElement>('.kbn-ch-cleared')!
  expect(cleared.textContent).toBe('κ × tSZ cleared · Undo')
  expect(document.activeElement?.textContent).toBe('Undo')
  // The channel still waits on the ask, not on what was cleared.
  expect(host.querySelector('[data-channel="channel:cmbx"]')!.hasAttribute('data-waiting')).toBe(true)
  cleared.querySelector<HTMLButtonElement>('button')!.click()
  await settle()
  expect(posts.at(-1)).toStrictEqual(['/api/v1/channels/dismiss', { key: `unclear:T:${posted}`, fiber: 'T' }])
  expect(stream(host).map(([name]) => name)).toStrictEqual(['κ × tSZ', 'Cluster mask', 'cmbx chair'])
  expect(host.querySelector('.kbn-ch-cleared')).toBeNull()
  // Cleared again after the undo, the clear stands above it.
  check('κ × tSZ')!.click()
  await settle()
  expect(posts.at(-1)).toStrictEqual(['/api/v1/channels/dismiss', { key: `clear:T:${posted + 1}`, fiber: 'T' }])
  // Another device holds the clear: the line is gone, with no Undo.
  views.forEach(view => view.unmount()); views.length = 0; document.body.replaceChildren()
  daemon([], new Map(), {}, { dismissed: [`clear:T:${posted}`] })
  const again = await mount()
  expect(stream(again.host).map(([name]) => name)).toStrictEqual(['Cluster mask', 'cmbx chair'])
  expect(again.host.querySelector('.kbn-ch-cleared')).toBeNull()
})

it('clears the line in focus, else the open thread\'s, by e; a failed write brings the line back and says so', async () => {
  const { posts } = daemon(['/api/v1/channels/dismiss'])
  const { view, host } = await mount()
  message(host, 'cmbx chair').querySelector<HTMLButtonElement>('.kbn-ch-msg-name')!.focus()
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'e' }))).toBe(true)
  expect(posts[0][1]).toMatchObject({ key: expect.stringMatching(/^clear:C:\d+$/), fiber: 'C' })
  await settle()
  expect(stream(host).map(([name]) => name)).toContain('cmbx chair')
  expect(host.querySelector('.kbn-ch-cleared')).toBeNull()
  expect(host.querySelector('.kbn-ch-note')?.textContent).toBe('cmbx chair\'s line could not be cleared; it is back.')
  // With nothing focused, e clears the open thread's line; an asking thread's line has no clear.
  message(host, 'Cluster mask').click()
  ;(document.activeElement as HTMLElement | null)?.blur()
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'e' }))).toBe(false)
  message(host, 'κ × tSZ').click()
  ;(document.activeElement as HTMLElement | null)?.blur()
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'e' }))).toBe(true)
  expect(posts.at(-1)![1]).toMatchObject({ key: expect.stringMatching(/^clear:T:\d+$/), fiber: 'T' })
})

it('signs off a close for review by its ✓: tempers it, then clears its line at the close', async () => {
  const { posts } = daemon()
  const cuts = card({ id: 'cmbx/cuts', uid: 'K', name: 'Depth cuts', orchestrator: 'C', column: 'awaitingReview', closedAt: at(15), reviewMark: { note: 'The plot is attached.', at: at(15) } })
  const { host, requestRefresh } = await mount([chair, tsz, mask, cuts])
  const check = message(host, 'Depth cuts').querySelector<HTMLButtonElement>('.kbn-ch-check')!
  expect(check.closest('ui-tooltip')!.querySelector('.kbn-ch-tip')?.textContent).toBe('Temper: accept the work as done')
  check.click()
  await settle()
  expect(posts).toStrictEqual([
    ['/api/v1/transition', { fiber_id: 'cmbx/cuts', target: 'tempered', origin: 'local' }],
    ['/api/v1/channels/dismiss', { key: `clear:K:${Date.parse(cuts.closedAt!)}`, fiber: 'K' }],
  ])
  expect(requestRefresh).toHaveBeenCalled()
  // No Undo for a sign-off; the line goes once the board carries the temper.
  expect(host.querySelector('.kbn-ch-cleared')).toBeNull()
})

it('heads the view with the channel itself, its name written as Slack writes it, the rail\'s toggle at its right', async () => {
  daemon()
  const mill = card({ id: 'mill', uid: 'L', name: 'felt chair', shuttleChannel: 'The Mill', shuttleSeat: true, ...working(2) })
  const { host } = await mount([chair, tsz, van, mill])
  // The tab bar names the view: no page title of its own.
  expect(host.querySelector('.kbn-view-title')).toBeNull()
  expect(rail(host)).toStrictEqual(['Moving house', 'cmbx', 'the-mill'])
  host.querySelector<HTMLButtonElement>('[data-channel="channel:the mill"]')!.click()
  await settle()
  const head = host.querySelector('.kbn-ch-head')!
  expect(shown(host)).toBe('the-mill')
  expect([...head.querySelectorAll('.kbn-ch-icon')].map(icon => icon.classList[1])).toStrictEqual(['kbn-ch-back', 'kbn-ch-menu', 'kbn-ch-rail-toggle'])
  // A lone constitution keeps its own name.
  host.querySelector<HTMLButtonElement>('[data-channel="fiber:R"]')!.click()
  await settle()
  expect([shown(host), host.querySelector('.kbn-ch-name')!.hasAttribute('data-lone')]).toStrictEqual(['Moving house', true])
})
