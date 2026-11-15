// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { ChannelsView } from './ChannelsView.js'
import type { ViewContext } from './ViewRegistry.js'
import type { SentFile } from '../sentFiles.js'
import { card, response, settle } from '../testFixtures.js'

const views: ChannelsView[] = []
afterEach(() => { views.forEach(view => view.unmount()); views.length = 0; document.body.replaceChildren(); vi.unstubAllGlobals() })

const minute = 60_000, day = 86_400_000
const at = (minutes: number): string => new Date(Date.now() - minutes * minute).toISOString()
const idle = (minutes: number) => ({ status: 'active' as const, workerState: 'running' as const, runtimePhase: 'waiting' as const, lastActivityAt: Date.now() - minutes * minute })
// The analyst office: its top-level idle at the end of its turn, a thread asking, a working thread with nothing to say.
const shear = card({ id: 'shear', uid: 'S', name: 'Cosmic shear', shuttleRole: 'analyst', outcome: 'The null passes.', ...idle(4) })
const mask = card({ id: 'mask', uid: 'M', name: 'Choose the mask', orchestrator: 'S', status: 'active', ask: { text: 'Keep the conservative mask?', at: at(40) } })
const covariance = card({ id: 'covariance', uid: 'V', name: 'Covariance', orchestrator: 'S', status: 'active', workerState: 'running', runtimePhase: 'working' })
// A top-level without an office, asking; a quiet one nobody waits on.
const van = card({ id: 'van', uid: 'R', name: 'Moving house', status: 'active', ask: { text: 'Which van?', at: at(20) } })
const garden = card({ id: 'garden', uid: 'G', name: 'Garden plan', status: 'active', workerState: 'running', runtimePhase: 'working', outcome: 'Seeds ordered.' })

/** A daemon that answers the Channels view's reads, records its writes, and fails the ones `fail` names. */
function daemon(fail: string[] = [], stored = new Map<string, string>(), pinned: Record<string, number> = {}) {
  const posts: Array<[string, Record<string, unknown>]> = []
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push([url, JSON.parse(String(init.body))])
      if (fail.some(path => url.endsWith(path))) return new Response('{"error":"disk full"}', { status: 422 })
      return new Response(JSON.stringify({ ok: true, delivered: true }))
    }
    if (url.includes('/channels/dismissed')) return new Response(JSON.stringify({ dismissed: [], pinned, reach_ms: 14 * day }))
    if (url.includes('/speak')) return new Response(JSON.stringify({ held: [] }))
    if (url.includes('/roles')) return new Response(JSON.stringify([{ slug: 'analyst', id: 'roles/analyst', name: 'Analyst', outcome: '' }]))
    if (url.includes('/fibers/')) return new Response(JSON.stringify({ fibers: [] }), { status: 404 })
    return new Response('{}')
  }))
  return { posts, stored }
}
const board = (inFlight: ReturnType<typeof card>[]) => response({ now: { drafts: [], inFlight, awaitingReview: [] } })
/** Documents the fleet sent: a plot from the mask thread, a note from a fiber the board does not hold. */
const sent = (uid: string, path: string, minutes: number, fiber = card({ id: uid, uid, name: uid })) =>
  ({ card: fiber, receipt: { uid, key: `host:${path}`, owner: 'host', host: 'host', fullPath: path, basename: path.split('/').at(-1)!, timestamp: Date.now() - minutes * minute } })
const library = [sent('M', '/notes/mask/north-mask.png', 30, mask), sent('old', '/notes/old/lensing-notes.md', 600, card({ id: 'old', uid: 'old', name: 'Lensing notes' }))]
async function mount(inFlight = [shear, mask, covariance, van, garden], view = new ChannelsView(), lately = [garden], shuttleBase = '', prepare?: (host: HTMLElement) => void, sent: SentFile[] = []) {
  const openFromDesk = vi.fn(), openPage = vi.fn(), requestRefresh = vi.fn(), see = vi.fn()
  const workspace = {
    openFromDesk, openPage, readLatelyCards: () => lately,
    library: { subscribe: () => () => {}, visit: () => {}, cancelOpen: vi.fn(), documents: () => library, receipts: (uid: string) => library.filter(doc => doc.receipt.uid === uid).map(doc => doc.receipt) },
  }
  const sends = { files: sent, subscribe: () => () => {}, refresh: async () => {} }
  const ctx = { cards: [], response: board(inFlight), shuttleBase, workspace, sends, requestRefresh, openCard: vi.fn(), see } as unknown as ViewContext
  const host = document.createElement('div'); document.body.append(host)
  prepare?.(host)
  views.push(view); view.mount(host, ctx)
  await settle(); await settle()
  const reply = host.querySelector<HTMLTextAreaElement>('.kbn-ch-reply-text')!
  return { view, ctx, host, reply, openFromDesk, openPage, requestRefresh, see }
}
const rail = (host: HTMLElement) => [...host.querySelectorAll('.kbn-ch-pick-name')].map(el => el.textContent)
const shown = (host: HTMLElement) => host.querySelector('.kbn-ch-name')?.textContent
const replyTo = (host: HTMLElement) => host.querySelector('.kbn-ch-reply-to')?.textContent
const line = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLElement>('.kbn-ch-msg')].find(el => el.querySelector('.kbn-ch-msg-name')?.textContent === name)!

it('reads a channel as a chat: each worker a line, oldest first, the waiting ones lit, replying to the seat', async () => {
  daemon()
  const { view, host, see } = await mount()
  expect(rail(host)).toStrictEqual(['Analyst', 'Moving house'])
  expect(shown(host)).toBe('Analyst')
  expect([...host.querySelectorAll('.kbn-ch-msg')].map(el => [el.querySelector('.kbn-ch-msg-name')?.textContent, el.getAttribute('data-kind'), el.hasAttribute('data-chosen')]))
    .toStrictEqual([['Choose the mask', 'ask', false], ['Cosmic shear', 'turn', true]])
  expect(replyTo(host)).toBe('Cosmic shear')
  expect(host.querySelector('.kbn-ch-label')?.textContent).toBe('Cosmic shear')
  expect(see).toHaveBeenLastCalledWith(shear)
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'j' }))).toBe(true)
  expect(shown(host)).toBe('Moving house')
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'k' }))).toBe(true)
  expect(shown(host)).toBe('Analyst')
})

it('choosing a line retargets the reply and the tapestry; a sent reply comes back to the seat and stays in the channel', async () => {
  const { posts } = daemon()
  const { view, host, reply, requestRefresh } = await mount()
  line(host, 'Choose the mask').querySelector<HTMLButtonElement>('.kbn-ch-msg-pick')!.click()
  expect(replyTo(host)).toBe('Choose the mask')
  expect(line(host, 'Choose the mask').hasAttribute('data-chosen')).toBe(true)
  expect(host.querySelector('.kbn-ch-back')?.textContent).toBe('← Cosmic shear')
  host.querySelector<HTMLButtonElement>('.kbn-ch-back')!.click()
  expect(replyTo(host)).toBe('Cosmic shear')
  line(host, 'Choose the mask').querySelector<HTMLButtonElement>('.kbn-ch-msg-pick')!.click()
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true)
  expect(document.activeElement).toBe(reply)
  reply.value = 'Keep it.'
  reply.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await settle()
  expect(posts).toStrictEqual([['/api/v1/deliver', { fiber_id: 'mask', origin: 'local', text: 'Keep it.', from: 'human' }]])
  expect(requestRefresh).toHaveBeenCalled()
  expect([shown(host), replyTo(host), reply.value]).toStrictEqual(['Analyst', 'Cosmic shear', ''])
  expect(line(host, 'Choose the mask').querySelector('.kbn-ch-replied')).not.toBeNull()
})

it('keeps the reader on a channel that stops waiting, with its draft, and never carries a draft to another channel', async () => {
  daemon()
  const { view, ctx, host, reply } = await mount()
  reply.value = 'Half a thought'
  // The seat is answered and the mask's ask is withdrawn: nothing in the analyst office waits now.
  view.refresh({ ...ctx, response: board([{ ...shear, workerState: 'running', runtimePhase: 'working', turn: 'working' }, { ...mask, ask: undefined, turn: 'none' }, covariance, van, garden]) })
  await settle()
  expect([shown(host), reply.value]).toStrictEqual(['Analyst', 'Half a thought'])
  expect(host.querySelector('[data-channel="role:analyst"]')!.hasAttribute('data-quiet')).toBe(true)
  // It sits quietly at the end of the rail until the reader moves on.
  expect(rail(host)).toStrictEqual(['Moving house', 'Analyst'])
  view.keydown(new KeyboardEvent('keydown', { key: 'k' }))
  expect([shown(host), reply.value, rail(host)]).toStrictEqual(['Moving house', '', ['Moving house']])
})

it('keeps a chosen worker as the reply\'s target after its line goes, until the reader chooses again', async () => {
  const { posts } = daemon()
  const { view, ctx, host, reply } = await mount()
  line(host, 'Choose the mask').querySelector<HTMLButtonElement>('.kbn-ch-msg-pick')!.click()
  view.refresh({ ...ctx, response: board([shear, { ...mask, ask: undefined, turn: 'none' }, covariance, van, garden]) })
  await settle()
  expect(line(host, 'Choose the mask')).toBeUndefined()
  expect(replyTo(host)).toBe('Choose the mask')
  reply.value = 'Go ahead.'
  host.querySelector<HTMLFormElement>('.kbn-ch-reply')!.requestSubmit()
  await settle()
  expect(posts.map(([url, body]) => [url, body.fiber_id])).toStrictEqual([['/api/v1/deliver', 'mask']])
  expect(replyTo(host)).toBe('Cosmic shear')
})

it('keeps the words when a reply fails', async () => {
  daemon(['/api/v1/deliver'])
  const { host, reply } = await mount()
  reply.value = 'Keep it.'
  host.querySelector<HTMLFormElement>('.kbn-ch-reply')!.requestSubmit()
  await settle()
  expect(reply.value).toBe('Keep it.')
  expect(host.querySelector('.kbn-ch-note')?.textContent).toContain('Not sent')
})

it('sets a channel aside under a key that names it and its newest wait, and restores it when the write fails', async () => {
  const { posts } = daemon()
  const { host } = await mount()
  host.querySelector<HTMLButtonElement>('.kbn-ch-later')!.click()
  expect(rail(host)).toStrictEqual(['Moving house'])
  await settle()
  expect(posts).toStrictEqual([['/api/v1/channels/dismiss', { key: `office:role:analyst:${shear.lastActivityAt}`, fiber: 'S' }]])
  daemon(['/api/v1/channels/dismiss'])
  host.querySelector<HTMLButtonElement>('.kbn-ch-later')!.click()
  expect(host.querySelector('.kbn-ch-empty')?.textContent).toBe('Nobody is waiting on you.')
  await settle()
  expect(rail(host)).toStrictEqual(['Moving house'])
})

it('finds a quiet channel, pins it from its header, and renews a pin when a channel is used', async () => {
  const { posts } = daemon([], new Map(), { 'role:analyst': Date.now() - 2 * day })
  const { view, host } = await mount()
  const finder = host.querySelector<HTMLInputElement>('.kbn-ch-finder')!
  finder.value = 'gard'
  finder.dispatchEvent(new Event('input'))
  expect(rail(host)).toStrictEqual(['Garden plan'])
  finder.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  expect(shown(host)).toBe('Garden plan')
  view.find('')
  expect(rail(host)).toStrictEqual(['Analyst', 'Moving house', 'Garden plan'])
  host.querySelector<HTMLButtonElement>('.kbn-ch-pin')!.click()
  expect(host.querySelector('.kbn-ch-pin')).toBeNull()
  expect(host.querySelector('.kbn-ch-msg-name')?.textContent).toBe('Garden plan')
  // Stepping through with j / k is not use; choosing the channel is.
  view.keydown(new KeyboardEvent('keydown', { key: 'k' }))
  view.keydown(new KeyboardEvent('keydown', { key: 'k' }))
  expect(shown(host)).toBe('Analyst')
  host.querySelector<HTMLButtonElement>('[data-channel="role:analyst"]')!.click()
  await settle()
  expect(posts).toStrictEqual([['/api/v1/channels/pin', { key: 'fiber:G', fiber: 'G' }], ['/api/v1/channels/pin', { key: 'role:analyst', fiber: 'S' }]])
  // Not now on a quiet pinned channel unpins it.
  host.querySelector<HTMLButtonElement>('[data-channel="fiber:G"]')!.click()
  expect(host.querySelector('.kbn-ch-later')!.getAttribute('title')).toBe('Unpin this channel')
  host.querySelector<HTMLButtonElement>('.kbn-ch-later')!.click()
  await settle()
  expect(rail(host)).toStrictEqual(['Analyst', 'Moving house'])
  expect(posts.at(-1)![0]).toBe('/api/v1/channels/dismiss')
  expect(posts.at(-1)![1].key).toMatch(/^pin:fiber:G:\d+$/)
})

it('hides and shows the rail by its button, by [ and by a sideways swipe over the lines, and remembers it', async () => {
  const { stored } = daemon()
  const { view, ctx, host } = await mount()
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
  const feed = host.querySelector('.kbn-ch-feed')!, tapestry = host.querySelector('.kbn-ch-tapestry')!
  swipe(feed, 300, 180)
  expect(layout.hasAttribute('data-rail-hidden')).toBe(true)
  // The tapestry is never a gesture surface; the lines are, from anywhere across them.
  swipe(tapestry, 100, 320)
  expect(layout.hasAttribute('data-rail-hidden')).toBe(true)
  swipe(feed, 200, 320)
  expect(layout.hasAttribute('data-rail-hidden')).toBe(false)
  // Nothing while the reader covers the view, nor on content that scrolls sideways.
  ;(ctx as { workspace: { isActive?: boolean } }).workspace.isActive = true
  swipe(feed, 300, 180)
  expect(layout.hasAttribute('data-rail-hidden')).toBe(false)
  ;(ctx as { workspace: { isActive?: boolean } }).workspace.isActive = false
  const wide = feed.querySelector('.kbn-ch-msg-text')!
  Object.defineProperties(wide, { scrollWidth: { value: 900 }, clientWidth: { value: 300 }, scrollLeft: { value: 0, writable: true } })
  ;(wide as HTMLElement).style.overflowX = 'auto'
  const wheel = (on: Element, deltaX: number) => { const event = Object.assign(new Event('wheel', { bubbles: true, cancelable: true }), { deltaX, deltaY: 2 }); on.dispatchEvent(event); return event.defaultPrevented }
  expect(wheel(wide, 80)).toBe(false)
  expect(wheel(tapestry, 80)).toBe(false)
  expect(layout.hasAttribute('data-rail-hidden')).toBe(false)
  expect(wheel(feed, 80)).toBe(true)
  expect(layout.hasAttribute('data-rail-hidden')).toBe(true)
  view.unmount(); views.length = 0
  const again = await mount(undefined, new ChannelsView())
  expect(again.host.querySelector('.kbn-ch-layout')!.hasAttribute('data-rail-hidden')).toBe(true)
})

it('marks what is new since the channel was last read, and reads it again when mounted again', async () => {
  const stored = new Map([['shuttle.channels.seen:role:analyst', String(Date.parse(at(20)))]])
  daemon([], stored)
  const first = await mount()
  expect([...first.host.querySelectorAll('.kbn-ch-msg')].map(el => el.hasAttribute('data-new'))).toStrictEqual([false, true])
  expect([...first.host.querySelectorAll('.kbn-ch-pick')].map(el => el.hasAttribute('data-new'))).toStrictEqual([false, true])
  first.view.unmount(); views.length = 0
  const again = await mount(undefined, first.view)
  expect([...again.host.querySelectorAll('.kbn-ch-msg')].map(el => el.hasAttribute('data-new'))).toStrictEqual([false, false])
})

it('shows a channel\'s files from its header, and finds channels and files across every channel', async () => {
  daemon()
  const { view, host, openPage } = await mount()
  const tab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('.kbn-ch-tab')].find(el => el.textContent?.startsWith(name))!
  expect(host.querySelector<HTMLElement>('.kbn-ch-files')!.hidden).toBe(true)
  tab('Files').click()
  expect(host.querySelector<HTMLElement>('.kbn-ch-tapestry')!.hidden).toBe(true)
  expect([...host.querySelectorAll('.kbn-ch-files .kbn-ch-doc')].map(el => [el.querySelector('.kbn-ch-doc-name')?.textContent, el.querySelector('.kbn-ch-doc-meta')?.firstChild?.textContent]))
    .toStrictEqual([['north-mask.png', 'Choose the mask']])
  host.querySelector<HTMLButtonElement>('.kbn-ch-files .kbn-ch-doc')!.click()
  expect(openPage).toHaveBeenLastCalledWith(mask, 'host:/notes/mask/north-mask.png')
  // Read lately sits under the channels until Find looks for something.
  expect([...host.querySelectorAll('.kbn-ch-lately .kbn-ch-doc-name')].map(el => el.textContent)).toStrictEqual(['Garden plan'])
  // A file's name finds its channel and the file; a fiber outside every channel is found by its files.
  view.find('north')
  expect(rail(host)).toStrictEqual(['Analyst'])
  expect([...host.querySelectorAll('.kbn-ch-doclist .kbn-ch-doc-name')].map(el => el.textContent)).toStrictEqual(['north-mask.png'])
  expect(host.querySelector<HTMLElement>('[aria-label="Read lately"]')!.hidden).toBe(true)
  view.find('lensing')
  expect(rail(host)).toStrictEqual([])
  host.querySelector<HTMLButtonElement>('.kbn-ch-doclist .kbn-ch-doc')!.click()
  expect(openPage).toHaveBeenLastCalledWith(library[1].card, 'host:/notes/old/lensing-notes.md')
  // Find reaches a channel that is not in the rail by any of its members.
  view.find('covariance')
  expect(rail(host)).toStrictEqual(['Analyst'])
})

it('draws a line whose time is unknown without an age, and names a channel by its charter title before the gloss', async () => {
  daemon()
  vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
    const path = String(url)
    if (path.includes('/channels/dismissed')) return new Response(JSON.stringify({ dismissed: [], pinned: {}, reach_ms: 14 * day }))
    if (path.includes('/speak')) return new Response(JSON.stringify({ held: [] }))
    if (path.includes('/roles')) return new Response(JSON.stringify([{ slug: 'analyst', id: 'roles/analyst', name: 'Analyst · the shear desk', outcome: '' }]))
    return new Response('{}')
  })
  const untimed = card({ id: 'untimed', uid: 'U', name: 'Untimed', orchestrator: 'S', status: 'active', outcome: 'No clock.', createdAt: '' })
  // Its own base, so the charter catalogue is read afresh.
  const { host } = await mount([shear, mask, untimed], new ChannelsView(), [], 'http://glossed.test')
  expect(rail(host)).toStrictEqual(['Analyst'])
  expect(host.querySelector('.kbn-ch-pick')!.getAttribute('title')).toBe('Analyst · the shear desk')
  expect(line(host, 'Untimed').querySelector('.kbn-ch-age')).toBeNull()
  expect(line(host, 'Choose the mask').querySelector('.kbn-ch-age')).not.toBeNull()
})

it('forgets its Find and drops a document still being read from its owner when Channels is left', async () => {
  daemon()
  const { view, ctx, host } = await mount()
  view.find('gard')
  expect(rail(host)).toStrictEqual(['Garden plan'])
  view.unmount()
  expect(ctx.workspace!.library.cancelOpen).toHaveBeenCalled()
  const again = await mount(undefined, view)
  expect(rail(again.host)).toStrictEqual(['Analyst', 'Moving house'])
  expect(again.host.querySelector<HTMLInputElement>('.kbn-ch-finder')!.value).toBe('')
})

it('keeps focus on its item across a poll, draws nothing under the reader, and returns focus where the reader was opened', async () => {
  daemon()
  const { view, ctx, host, openPage, reply } = await mount()
  const workspace = ctx.workspace as unknown as { isActive: boolean }
  const files = () => host.querySelector<HTMLButtonElement>('.kbn-ch-files .kbn-ch-doc')!
  ;[...host.querySelectorAll<HTMLButtonElement>('.kbn-ch-tab')].find(el => el.textContent === 'Files')!.click()
  files().focus()
  view.refresh(ctx); await settle()
  expect(document.activeElement).toBe(files())
  // Opening a file puts the reader over Channels: a poll beneath it rebuilds nothing.
  files().click()
  expect(openPage).toHaveBeenLastCalledWith(mask, 'host:/notes/mask/north-mask.png')
  workspace.isActive = true
  const shown = files()
  view.refresh(ctx); await settle()
  expect(files()).toBe(shown)
  // The reader closes: focus comes back to the file it was opened from.
  ;(document.activeElement as HTMLElement | null)?.blur()
  workspace.isActive = false
  view.refresh(ctx)
  expect((document.activeElement as HTMLElement).dataset.item).toBe('file:host:/notes/mask/north-mask.png')
  // Without an item to come back to, the reply box takes focus.
  workspace.isActive = true; view.refresh(ctx); workspace.isActive = false; view.refresh(ctx)
  expect(document.activeElement).toBe(reply)
})

it('probes a member\'s companions again after an unanswered probe and when its file changes', async () => {
  daemon()
  const base = 'http://probe.test', probes: string[] = []
  let answer: 'down' | 'none' | 'tapestry' = 'down'
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const path = String(url)
    if (!path.includes('/file-info?')) return original(url, init)
    probes.push(decodeURIComponent(path))
    if (answer === 'down') return new Response('unreachable', { status: 502 })
    return new Response(JSON.stringify({ exists: answer === 'tapestry' && path.includes('tapestry.html') }))
  })
  const thread = card({ id: 'mask', uid: 'M', name: 'Choose the mask', orchestrator: 'S', status: 'active', ask: { text: 'Keep it?', at: at(40) }, fiberDir: '/notes/mask', modifiedAt: at(40) })
  const { view, ctx, host } = await mount([shear, thread], new ChannelsView(), [], base)
  const names = () => [...host.querySelectorAll('.kbn-ch-files .kbn-ch-doc-name')].map(el => el.textContent)
  ;[...host.querySelectorAll<HTMLButtonElement>('.kbn-ch-tab')].find(el => el.textContent === 'Files')!.click()
  await settle(); await settle()
  const asked = probes.filter(url => url.includes('/notes/mask/')).length
  expect(asked).toBe(3)
  // The owner did not answer: the next draw of the files asks again, and finds nothing yet.
  answer = 'none'
  view.refresh(ctx); await settle(); await settle()
  expect(probes.filter(url => url.includes('/notes/mask/')).length).toBe(2 * asked)
  expect(names()).not.toContain('Tapestry')
  // Settled and unchanged, it is not asked again; once its file changes, it is, and its tapestry shows.
  view.refresh(ctx); await settle(); await settle()
  expect(probes.filter(url => url.includes('/notes/mask/')).length).toBe(2 * asked)
  answer = 'tapestry'
  ctx.response = board([shear, { ...thread, modifiedAt: at(1) }])
  view.refresh(ctx); await settle(); await settle()
  expect(probes.filter(url => url.includes('/notes/mask/')).length).toBe(3 * asked)
  expect(names()).toContain('Tapestry')
})

it('opens a channel on its newest line and follows new lines, unless the reader has scrolled up; only the feed scrolls', async () => {
  daemon()
  // The feed scrolls itself: 400 px in view, each line 100 px tall. The page around it must never move.
  let top = 0, page = 0
  const prepare = (host: HTMLElement): void => {
    Object.defineProperty(host, 'scrollTop', { get: () => page, set: (value: number) => { page = value } })
  }
  const feedOnly = (get: (feed: HTMLElement) => number) => function (this: HTMLElement) { return this.classList.contains('kbn-ch-feed') ? get(this) : 0 }
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(feedOnly(feed => 100 * feed.children.length))
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(feedOnly(() => 400))
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) { return this.classList.contains('kbn-ch-feed') ? top : 0 })
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: Element, value: number) {
    if (this.classList.contains('kbn-ch-feed')) top = Math.max(0, Math.min(value, 100 * this.children.length - 400))
  })
  const lines = Array.from({ length: 8 }, (_, i) => card({ id: `line${i}`, uid: `L${i}`, name: `Line ${i}`, orchestrator: 'S', status: 'active', workerState: 'running', runtimePhase: 'working', outcome: `Step ${i}.`, lastActivityAt: Date.now() - (60 - i) * minute }))
  const { view, ctx } = await mount([shear, mask, ...lines, van], undefined, [], '', prepare)
  // Ten lines, 1000 px, 400 in view.
  expect(top).toBe(600)
  const arrive = async (n: number) => {
    const more = Array.from({ length: n }, (_, i) => card({ id: `new${i}`, uid: `N${i}`, name: `New ${i}`, orchestrator: 'S', status: 'active', ask: { text: `Question ${i}?`, at: at(1) } }))
    ctx.response = board([shear, mask, ...lines, ...more, van])
    view.refresh(ctx); await settle()
  }
  // A new line while at the bottom follows it.
  await arrive(1)
  expect(top).toBe(700)
  // Scrolled up, the reader keeps their place when more arrive.
  top = 200
  await arrive(2)
  expect(top).toBe(200)
  // Another channel opens on its newest line too, and coming back lands on the newest again.
  view.keydown(new KeyboardEvent('keydown', { key: 'j' }))
  expect(top).toBe(0)
  view.keydown(new KeyboardEvent('keydown', { key: 'k' }))
  expect(top).toBe(800)
  expect(page).toBe(0)
})

it('shows a file sent several times once under its line, its newest send', async () => {
  daemon()
  const sends = [
    { uid: 'M', host: '', fullPath: '/notes/mask/kappa.png', basename: 'kappa.png', timestamp: Date.now() - 3 * minute },
    { uid: 'M', host: '', fullPath: '/runs/old/kappa.png', basename: 'kappa.png', timestamp: Date.now() - 30 * minute },
    { uid: 'M', host: '', fullPath: '/notes/mask/tapestry.html', basename: 'tapestry.html', timestamp: Date.now() - 4 * minute },
  ]
  const view = new ChannelsView()
  const { host } = await mount(undefined, view, [], '', undefined, sends)
  expect([...line(host, 'Choose the mask').querySelectorAll('.kbn-ch-file')].map(el => [el.textContent, el.getAttribute('title')]))
    .toStrictEqual([['kappa.png', 'Sent 3m ago'], ['tapestry.html', 'Sent 4m ago']])
})
