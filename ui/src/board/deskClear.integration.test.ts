// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import type { KanbanResponse } from './KanbanTypes.js'
import { card, response, settle } from './testFixtures.js'
import { MOBILE_MEDIA } from './mobile.js'

interface Internals {
  render(data: KanbanResponse): void
  readBoard(data: KanbanResponse): void
  lastResponse: KanbanResponse | null
  startPolling(): void
  fetchAndRender(): Promise<void>
}
const posted = Date.now() - 5 * 60_000
// An active constitution, never closed, whose deep thread posted to the human; another works.
const hub = card({ id: 'hub', uid: 'hub-uid', status: 'active', shuttleKind: 'oneshot', workerState: 'running', runtimePhase: 'working' })
const deep = card({ id: 'hub/a/b', uid: 'deep-uid', orchestrator: 'a-uid', status: 'active', shuttleKind: 'oneshot', workerState: 'running', runtimePhase: 'working' })
const mid = card({ id: 'hub/a', uid: 'a-uid', orchestrator: 'hub-uid', status: 'active', shuttleKind: 'oneshot' })
const data = () => response({ now: { drafts: [], inFlight: [hub], awaitingReview: [] }, threads: [mid, deep] })
let board: KanbanModal, inside: Internals, cleared = false

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === MOBILE_MEDIA && false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  cleared = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (url.endsWith('/api/v1/channels/dismiss')) cleared = true
      return new Response('{"ok":true}')
    }
    if (url.includes('/board/family')) return new Response(JSON.stringify({
      family: { uid: 'hub-uid' },
      reach_ms: 14 * 86_400_000,
      records: [{ id: 'p1', kind: 'post', fiber: 'deep-uid', to: { label: 'Sam' }, text: 'The cut is in.', timestamp: posted }],
      // The daemon honours the clear: the line stops waiting.
      waiting: cleared ? {} : { 'deep-uid': { id: 'p1', at: posted } },
    }))
    return new Response(JSON.stringify({ fibers: [], files: [] }))
  }))
  window.history.replaceState(null, '', '/')
  board = new KanbanModal({ shuttleBase: '' }); inside = board as unknown as Internals
  vi.spyOn(inside, 'startPolling').mockImplementation(() => {})
  vi.spyOn(inside, 'fetchAndRender').mockResolvedValue()
  board.mount(document.body)
  inside.lastResponse = data(); inside.render(inside.lastResponse)
})
afterEach(() => { board?.unmount(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('clears a post three levels down from its family card, and does nothing else: one write, the dismissal, no lifecycle request', async () => {
  inside.readBoard(inside.lastResponse!)
  await settle(); await settle(); await settle()
  const line = document.querySelector<HTMLElement>('[data-column="waiting"] .kbn-family-line[data-card-uid="deep-uid"]')!
  expect(line.querySelector('.thread-row-doing')!.textContent!.trim()).toBe('The cut is in.')
  const from = vi.mocked(fetch).mock.calls.length
  line.querySelector<HTMLButtonElement>('.kbn-ch-clear')!.click()
  await settle(); await settle()
  const asked = vi.mocked(fetch).mock.calls.slice(from).map(([url, init]) => [String(url), init?.method ?? 'GET'])
  expect(asked.filter(([, method]) => method === 'POST')).toStrictEqual([['/api/v1/channels/dismiss', 'POST']])
  expect(asked.filter(([url]) => /\/api\/v1\/(transition|lifecycle|kill|dispatch)\b/.test(url))).toStrictEqual([])
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/channels/dismiss'))![1]!.body))).toStrictEqual({ key: `clear:deep-uid:${posted}`, fiber: 'deep-uid' })
  // The family works again, and the reader opened nothing.
  expect(document.querySelector('[data-column="working"] .kbn-family[data-card-uid="hub-uid"]')).not.toBeNull()
  expect(document.querySelector('.kbn-modal')!.classList.contains('kbn-reader-open')).toBe(false)
})

it('offers to undo a clear for a few seconds: undo writes the unclear, and the post waits again', async () => {
  inside.readBoard(inside.lastResponse!)
  await settle(); await settle(); await settle()
  document.querySelector<HTMLButtonElement>('.kbn-family-line[data-card-uid="deep-uid"] .kbn-ch-clear')!.click()
  await settle(); await settle()
  const undo = document.querySelector<HTMLButtonElement>('.shuttle-toast .toast-undo')!
  expect(undo.closest('.shuttle-toast')!.textContent).toContain('Cleared')
  cleared = false
  const from = vi.mocked(fetch).mock.calls.length
  undo.click()
  await settle(); await settle()
  const writes = vi.mocked(fetch).mock.calls.slice(from).filter(([, init]) => init?.method === 'POST')
  expect(writes.map(([url, init]) => [String(url), JSON.parse(String(init!.body))])).toStrictEqual([['/api/v1/channels/dismiss', { key: `unclear:deep-uid:${posted}`, fiber: 'deep-uid' }]])
  expect(document.querySelector('[data-column="waiting"] .kbn-family-line[data-card-uid="deep-uid"] .kbn-ch-clear')).not.toBeNull()
  expect(document.querySelector('.shuttle-toast')).toBeNull()
})
