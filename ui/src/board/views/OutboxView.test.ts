// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { OutboxView } from './OutboxView.js'
import type { ViewContext } from './ViewRegistry.js'
import { card, response, settle } from '../testFixtures.js'

const views: OutboxView[] = []
afterEach(() => { views.forEach(view => view.unmount()); views.length = 0; document.body.replaceChildren(); vi.unstubAllGlobals() })

const minute = 60_000
const at = (minutes: number): string => new Date(Date.now() - minutes * minute).toISOString()
const mask = card({ id: 'mask', uid: 'M', status: 'active', shuttleRole: 'analyst', ask: { text: 'Keep the conservative mask?', at: at(40) } })
const tail = card({ id: 'tail', uid: 'T', status: 'active', shuttleRole: 'analyst', ask: { text: 'Check the tail?', at: at(5) } })
const van = card({ id: 'van', uid: 'V', name: 'Moving house', status: 'active', ask: { text: 'Which van?', at: at(20) } })

/** A daemon that answers the Outbox's reads, records its writes, and fails the ones `fail` names. */
function daemon(fail: string[] = []) {
  const posts: Array<[string, Record<string, unknown>]> = []
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push([url, JSON.parse(String(init.body))])
      if (fail.some(path => url.endsWith(path))) return new Response('{"error":"disk full"}', { status: 422 })
      return new Response(JSON.stringify({ ok: true, delivered: true }))
    }
    if (url.includes('/outbox/dismissed')) return new Response(JSON.stringify({ dismissed: [], reach_ms: 14 * 86_400_000 }))
    if (url.includes('/speak')) return new Response(JSON.stringify({ held: [] }))
    if (url.includes('/roles')) return new Response(JSON.stringify([{ slug: 'analyst', id: 'roles/analyst', name: 'Analyst', outcome: '' }]))
    if (url.includes('/fibers/')) return new Response(JSON.stringify({ fibers: [] }), { status: 404 })
    return new Response('{}')
  }))
  return posts
}
async function mount() {
  const openFromDesk = vi.fn(), requestRefresh = vi.fn(), see = vi.fn()
  const ctx = { cards: [], response: response({ now: { drafts: [], inFlight: [mask, tail, van], awaitingReview: [] } }), shuttleBase: '', workspace: { openFromDesk, openPage: vi.fn() }, requestRefresh, openCard: vi.fn(), see } as unknown as ViewContext
  const host = document.createElement('div'); document.body.append(host)
  const view = new OutboxView(); views.push(view); view.mount(host, ctx)
  await settle(); await settle()
  const reply = host.querySelector<HTMLTextAreaElement>('.kbn-aud-reply-text')!
  return { view, ctx, host, reply, openFromDesk, requestRefresh, see }
}
const rail = (host: HTMLElement) => [...host.querySelectorAll('.kbn-aud-office-name')].map(el => el.textContent)
const shown = (host: HTMLElement) => host.querySelector('.kbn-aud-name')?.textContent

it('reads one office at a time, longest waiting first, with its asks on top and voice on the card that asked', async () => {
  daemon()
  const { view, host, see } = await mount()
  expect(rail(host)).toStrictEqual(['Analyst', 'Moving house'])
  expect(shown(host)).toBe('Analyst')
  expect([...host.querySelectorAll('.kbn-aud-text')].map(el => el.textContent?.trim())).toStrictEqual(['Keep the conservative mask?', 'Check the tail?'])
  expect(host.querySelector('.kbn-aud-reply-to')?.textContent).toBe('mask')
  expect(see).toHaveBeenLastCalledWith(mask)
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'j' }))).toBe(true)
  expect(shown(host)).toBe('Moving house')
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'k' }))).toBe(true)
  expect(shown(host)).toBe('Analyst')
})

it('sends a reply to the chosen card through the delivery route, then comes to the next office', async () => {
  const posts = daemon()
  const { view, host, reply, requestRefresh } = await mount()
  ;[...host.querySelectorAll<HTMLButtonElement>('.kbn-aud-from')].find(el => el.textContent === 'tail')!.click()
  expect(host.querySelector('.kbn-aud-reply-to')?.textContent).toBe('tail')
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true)
  expect(document.activeElement).toBe(reply)
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true)
  expect(document.activeElement).toBe(host.querySelector('.kbn-aud-letter'))
  reply.focus()
  reply.value = 'Yes, check it.'
  reply.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await settle()
  expect(posts).toStrictEqual([['/api/v1/deliver', { fiber_id: 'tail', origin: 'local', text: 'Yes, check it.', from: 'human' }]])
  expect(requestRefresh).toHaveBeenCalled()
  expect(shown(host)).toBe('Moving house')
  expect(reply.value).toBe('')
})

it('keeps the words when a reply fails', async () => {
  daemon(['/api/v1/deliver'])
  const { host, reply } = await mount()
  reply.value = 'Keep it.'
  host.querySelector<HTMLFormElement>('.kbn-aud-reply')!.requestSubmit()
  await settle()
  expect(reply.value).toBe('Keep it.')
  expect(shown(host)).toBe('Analyst')
  expect(host.querySelector('.kbn-aud-note')?.textContent).toContain('Not sent')
})

it('sets an office aside under a key that names its newest block, and restores it when the write fails', async () => {
  const posts = daemon()
  const { host } = await mount()
  host.querySelector<HTMLButtonElement>('.kbn-aud-later')!.click()
  expect(rail(host)).toStrictEqual(['Moving house'])
  await settle()
  expect(posts).toStrictEqual([['/api/v1/outbox/dismiss', { key: `office:role:analyst:${Date.parse(tail.ask!.at)}` }]])
  daemon(['/api/v1/outbox/dismiss'])
  host.querySelector<HTMLButtonElement>('.kbn-aud-later')!.click()
  expect(host.querySelector('.kbn-aud-empty')?.textContent).toBe('Nobody is waiting on you.')
  await settle()
  expect(rail(host)).toStrictEqual(['Moving house'])
})

it('marks what is new since the office was last read', async () => {
  daemon()
  localStorage.setItem('shuttle.outbox.office-seen:role:analyst', String(Date.parse(at(20))))
  const { host } = await mount()
  expect([...host.querySelectorAll('.kbn-aud-block')].map(el => el.hasAttribute('data-new'))).toStrictEqual([false, true])
  expect([...host.querySelectorAll('.kbn-aud-office')].map(el => el.hasAttribute('data-new'))).toStrictEqual([false, true])
})
