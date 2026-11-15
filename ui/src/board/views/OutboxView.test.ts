// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { OutboxView } from './OutboxView.js'
import type { ViewContext } from './ViewRegistry.js'
import { card, response, settle } from '../testFixtures.js'

const views: OutboxView[] = []
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

/** A daemon that answers the Outbox's reads, records its writes, and fails the ones `fail` names. */
function daemon(fail: string[] = [], stored = new Map<string, string>(), pinned: Record<string, number> = {}) {
  const posts: Array<[string, Record<string, unknown>]> = []
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push([url, JSON.parse(String(init.body))])
      if (fail.some(path => url.endsWith(path))) return new Response('{"error":"disk full"}', { status: 422 })
      return new Response(JSON.stringify({ ok: true, delivered: true }))
    }
    if (url.includes('/outbox/dismissed')) return new Response(JSON.stringify({ dismissed: [], pinned, reach_ms: 14 * day }))
    if (url.includes('/speak')) return new Response(JSON.stringify({ held: [] }))
    if (url.includes('/roles')) return new Response(JSON.stringify([{ slug: 'analyst', id: 'roles/analyst', name: 'Analyst', outcome: '' }]))
    if (url.includes('/fibers/')) return new Response(JSON.stringify({ fibers: [] }), { status: 404 })
    return new Response('{}')
  }))
  return { posts, stored }
}
async function mount(inFlight = [shear, mask, covariance, van, garden], view = new OutboxView()) {
  const openFromDesk = vi.fn(), requestRefresh = vi.fn(), see = vi.fn()
  const ctx = { cards: [], response: response({ now: { drafts: [], inFlight, awaitingReview: [] } }), shuttleBase: '', workspace: { openFromDesk, openPage: vi.fn() }, requestRefresh, openCard: vi.fn(), see } as unknown as ViewContext
  const host = document.createElement('div'); document.body.append(host)
  views.push(view); view.mount(host, ctx)
  await settle(); await settle()
  const reply = host.querySelector<HTMLTextAreaElement>('.kbn-ch-reply-text')!
  return { view, ctx, host, reply, openFromDesk, requestRefresh, see }
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
  expect(posts).toStrictEqual([['/api/v1/outbox/dismiss', { key: `office:role:analyst:${shear.lastActivityAt}`, fiber: 'S' }]])
  daemon(['/api/v1/outbox/dismiss'])
  host.querySelector<HTMLButtonElement>('.kbn-ch-later')!.click()
  expect(host.querySelector('.kbn-ch-empty')?.textContent).toBe('Nobody is waiting on you.')
  await settle()
  expect(rail(host)).toStrictEqual(['Moving house'])
})

it('adds a channel from the finder by pinning it, and renews a pin when a channel is used', async () => {
  const { posts } = daemon([], new Map(), { 'role:analyst': Date.now() - 2 * day })
  const { host } = await mount()
  const finder = host.querySelector<HTMLInputElement>('.kbn-ch-finder')!
  finder.value = 'gard'
  finder.dispatchEvent(new Event('input'))
  expect([...host.querySelectorAll('.kbn-ch-found-pick')].map(el => el.textContent)).toStrictEqual(['Garden plan'])
  finder.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  expect(rail(host)).toStrictEqual(['Analyst', 'Moving house', 'Garden plan'])
  expect(shown(host)).toBe('Garden plan')
  expect(host.querySelector('.kbn-ch-later')!.hasAttribute('hidden')).toBe(true)
  expect(host.querySelector('.kbn-ch-msg-name')?.textContent).toBe('Garden plan')
  host.querySelector<HTMLButtonElement>('[data-channel="role:analyst"]')!.click()
  await settle()
  expect(posts).toStrictEqual([['/api/v1/outbox/pin', { key: 'fiber:G', fiber: 'G' }], ['/api/v1/outbox/pin', { key: 'role:analyst', fiber: 'S' }]])
})

it('hides and shows the rail by its button, by [ and by a sideways swipe, and remembers it', async () => {
  const { stored } = daemon()
  const { view, host } = await mount()
  const layout = host.querySelector('.kbn-ch-layout')!, toggle = host.querySelector<HTMLButtonElement>('.kbn-ch-rail-toggle')!
  expect([layout.hasAttribute('data-rail-hidden'), toggle.textContent]).toStrictEqual([false, 'Hide channels'])
  toggle.click()
  expect([layout.hasAttribute('data-rail-hidden'), toggle.textContent, toggle.getAttribute('aria-expanded')]).toStrictEqual([true, 'Show channels', 'false'])
  expect(stored.get('shuttle.outbox.rail-hidden')).toBe('1')
  expect(view.keydown(new KeyboardEvent('keydown', { key: '[' }))).toBe(true)
  expect(layout.hasAttribute('data-rail-hidden')).toBe(false)
  const swipe = (from: number, to: number) => {
    document.dispatchEvent(Object.assign(new Event('touchstart'), { touches: [{ clientX: from, clientY: 300 }] }))
    document.dispatchEvent(Object.assign(new Event('touchend'), { changedTouches: [{ clientX: to, clientY: 310 }] }))
  }
  swipe(300, 180)
  expect(layout.hasAttribute('data-rail-hidden')).toBe(true)
  // Only a touch that starts at the left edge draws it back.
  swipe(200, 320)
  expect(layout.hasAttribute('data-rail-hidden')).toBe(true)
  swipe(6, 120)
  expect(layout.hasAttribute('data-rail-hidden')).toBe(false)
  host.querySelector('.kbn-outbox')!.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { deltaX: 80, deltaY: 2 }))
  expect(layout.hasAttribute('data-rail-hidden')).toBe(true)
  view.unmount(); views.length = 0
  const again = await mount(undefined, new OutboxView())
  expect(again.host.querySelector('.kbn-ch-layout')!.hasAttribute('data-rail-hidden')).toBe(true)
})

it('marks what is new since the channel was last read, and reads it again when mounted again', async () => {
  const stored = new Map([['shuttle.outbox.channel-seen:role:analyst', String(Date.parse(at(20)))]])
  daemon([], stored)
  const first = await mount()
  expect([...first.host.querySelectorAll('.kbn-ch-msg')].map(el => el.hasAttribute('data-new'))).toStrictEqual([false, true])
  expect([...first.host.querySelectorAll('.kbn-ch-pick')].map(el => el.hasAttribute('data-new'))).toStrictEqual([false, true])
  first.view.unmount(); views.length = 0
  const again = await mount(undefined, first.view)
  expect([...again.host.querySelectorAll('.kbn-ch-msg')].map(el => el.hasAttribute('data-new'))).toStrictEqual([false, false])
})
