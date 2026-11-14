// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { OutboxView } from './OutboxView.js'
import type { ViewContext } from './ViewRegistry.js'
import { FiberSends } from '../fiberSends.js'
import { docKey } from '../workspace/documents.js'
import { card, response, settle } from '../testFixtures.js'

const views: OutboxView[] = []
afterEach(() => { views.forEach(view => view.unmount()); views.length = 0; document.body.replaceChildren(); vi.unstubAllGlobals() })

function mount() {
  const ask = card({ id: 'ask', uid: 'A', ask: { text: 'Which mask?', at: new Date().toISOString() } })
  const openFromDesk = vi.fn(), openPage = vi.fn()
  const ctx = { cards: [ask], response: response(), shuttleBase: '', workspace: { openFromDesk, openPage }, requestRefresh: vi.fn(), openCard: vi.fn() } as unknown as ViewContext
  const host = document.createElement('div'); document.body.append(host)
  const view = new OutboxView(); views.push(view); view.mount(host, ctx)
  return { view, ctx, host, ask, openFromDesk, openPage }
}

it('opens the card by the Desk path, supports row keys, and keeps focus through a poll', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('dismissed') ? { dismissed: [], reach_ms: 14 * 86_400_000 } : { held: [] }))))
  const { view, ctx, ask, openFromDesk, host } = mount()
  await settle()
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'j' }))).toBe(true)
  const focused = document.activeElement
  view.refresh(ctx); await settle()
  expect(document.activeElement).toBe(focused)
  expect(view.keydown(new KeyboardEvent('keydown', { key: 'o' }))).toBe(true)
  expect(openFromDesk).toHaveBeenCalledWith(ask)
  expect(host.textContent).toContain('Which mask?')
})

it('opens an attributed file in its viewer and releases held speech by reaching its card', async () => {
  let held = [{ fiber_id: 'A', name: 'Speaker', n: 2, first: 'Ready to discuss', at: Date.now() }]
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('dismissed') ? { dismissed: [], reach_ms: 14 * 86_400_000 } : { held }))))
  const { view, ctx, host, ask, openPage, openFromDesk } = mount()
  await settle()
  const sends = new FiberSends('')
  sends.files = [{ uid: 'A', host: 'host', fullPath: '/plot.png', basename: 'plot.png', timestamp: Date.now() }]
  vi.spyOn(sends, 'refresh').mockResolvedValue()
  ctx.sends = sends; view.refresh(ctx); await settle()
  const file = [...host.querySelectorAll<HTMLButtonElement>('.kbn-outbox-open')].find(el => el.textContent?.includes('plot.png'))!
  file.click()
  expect(openPage).toHaveBeenCalledWith(ask, docKey('host', '/plot.png', ask.originId))
  const spoken = [...host.querySelectorAll<HTMLButtonElement>('.kbn-outbox-open')].find(el => el.textContent?.includes('Ready to discuss'))!
  spoken.click()
  expect(openFromDesk).toHaveBeenCalledWith(ask)
  held = []; view.refresh(ctx); await settle()
  expect(host.textContent).not.toContain('Ready to discuss')
})

it('dismisses immediately, restores a failed write, and confirms a successful write on refresh', async () => {
  let finish!: (response: Response) => void
  let dismissed: string[] = []
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return new Promise<Response>(resolve => { finish = resolve })
    return Promise.resolve(new Response(JSON.stringify(url.includes('dismissed') ? { dismissed, reach_ms: 14 * 86_400_000 } : { held: [] })))
  })
  vi.stubGlobal('fetch', fetcher)
  const { view, ctx, host, ask } = mount()
  await settle()
  host.querySelector<HTMLButtonElement>('.kbn-outbox-dismiss')!.click()
  expect(host.textContent).not.toContain('Which mask?')
  finish(new Response('{"error":"disk full"}', { status: 422 })); await settle()
  expect(host.textContent).toContain('Which mask?')
  view.keydown(new KeyboardEvent('keydown', { key: 'j' }))
  view.keydown(new KeyboardEvent('keydown', { key: 'x' }))
  expect(host.textContent).not.toContain('Which mask?')
  const key = `ask:A:${ask.ask!.at}`
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string)).toStrictEqual({ key, fiber: 'A' })
  finish(new Response('{"ok":true}')); await settle()
  view.refresh(ctx); await settle()
  expect(host.textContent).not.toContain('Which mask?')
  dismissed = [key]; view.refresh(ctx); await settle()
  expect(host.textContent).not.toContain('Which mask?')
})
