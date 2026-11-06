// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Dock } from './Dock.js'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { Voice, type VoiceHeld, type VoiceStatus } from '../voice.js'

const held: VoiceHeld = { id: 'held', fiber_id: 'uid', origin: 'owner', through: 1, text: 'me: original words' }
const initial = (): VoiceStatus => ({ available: true, enabled: true, muted: false, state: 'listening', target: { fiber_id: 'uid', origin: 'owner', name: 'Task' }, cold: true, held: [{ ...held }], pending: null, last: null, error: null })
const flush = async (): Promise<void> => { for (let i = 0; i < 70; i++) await Promise.resolve() }
const response = (body: unknown, code = 200): Response => new Response(JSON.stringify(body), { status: code })
let voice: Voice, dock: Dock, root: HTMLElement, server: VoiceStatus
let releaseStatus: number
let releaseRows: VoiceHeld[]
const notify = (): void => (voice as unknown as { notify(): void }).notify()
const field = (): HTMLTextAreaElement => root.querySelector('textarea')!
const requests = (): Array<{ url: string; body: Record<string, unknown> }> => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST').map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body)) }))
const dispatches = () => requests().filter(row => row.url.includes('/dispatch'))

beforeEach(() => {
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value), removeItem: (key: string) => void stored.delete(key) })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('confirm', () => true)
  server = initial(); releaseStatus = 200; releaseRows = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/voice/release')) {
      if (releaseStatus === 200 || releaseStatus === 409) server = { ...server, held: releaseRows }
      return response(server, releaseStatus)
    }
    if (url.endsWith('/voice/draft')) {
      const body = JSON.parse(String(init?.body))
      server = { ...server, held: server.held!.map(row => ({ ...row, text: body.text })) }
      return response(server)
    }
    if (url.endsWith('/voice')) return response(server)
    return response({})
  }))
  voice = new Voice(''); voice.status = server
})
afterEach(() => { dock?.reset(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function mount(patch: Partial<KanbanCard> = {}): Promise<void> {
  const meeting = { current: () => null, canJoin: () => true, modes: () => ['call'], join: vi.fn() }
  dock = new Dock('', vi.fn(), undefined, undefined, { voice: { controller: voice, open: vi.fn() }, meeting: meeting as never })
  const band = dock.bandFor(card({ id: 'task', uid: 'uid', originId: 'owner', shuttleHost: 'owner', shuttleKind: 'oneshot', shuttleAgent: 'codex-sol', sessionUuid: 'session', ...patch }))
  root = band.el; document.body.append(root); await flush()
}

it('fills the editable box and says Voice · Held on the existing Hark control', async () => {
  await mount()
  expect(field().value).toBe('me: original words')
  expect(root.querySelector('.kbn-ctl-meet-arm')!.textContent).toBe('Voice · Held')
  expect(root.querySelectorAll('.kbn-ctl-meet')).toHaveLength(1)
  voice.status = { ...server, cold: false }; notify()
  expect(root.querySelector('.kbn-ctl-meet-arm')!.textContent).toBe('Here')
})

it.each([
  ['Send', true, 'previous', '.kbn-ctl-resume'],
  ['Resume', false, 'previous', '.kbn-ctl-resume'],
  ['New session', false, 'fresh', '.kbn-ctl-send:not(.kbn-ctl-resume)'],
] as const)('%s releases held words before delivering the edited box once', async (_verb, live, mode, selector) => {
  await mount({ workerState: live ? 'running' : undefined })
  field().value = 'me: edited words'; field().dispatchEvent(new Event('input'))
  root.querySelector<HTMLButtonElement>(`.kbn-ctl-sends ${selector}`)!.click()
  await flush()
  const posts = requests()
  expect(posts.map(row => row.url)).toEqual(['/api/v1/voice/draft', '/api/v1/voice/release', '/api/v1/dispatch'])
  expect(posts[0].body).toEqual({ id: 'held', through: 1, text: 'me: edited words' })
  expect(posts[1].body).toEqual({ id: 'held', through: 1 })
  expect(dispatches()[0].body).toMatchObject({ user_message: 'me: edited words', resume_mode: mode })
  expect(field().value).toBe('')
  voice.status = { ...server, held: [] }; notify()
  expect(dispatches()).toHaveLength(1)
})

it('a name winning the checkpoint prevents a button from delivering a second time', async () => {
  await mount()
  releaseStatus = 409
  root.querySelector<HTMLButtonElement>('.kbn-ctl-resume')!.click()
  await flush()
  expect(requests().map(row => row.url)).toEqual(['/api/v1/voice/release'])
  expect(dispatches()).toHaveLength(0)
  expect(field().value).toBe('')
  expect(root.textContent).toContain('already been sent')
})

it('a failed claim does not dispatch or consume the composer draft', async () => {
  await mount()
  releaseStatus = 503
  root.querySelector<HTMLButtonElement>('.kbn-ctl-resume')!.click()
  await flush()
  expect(dispatches()).toHaveLength(0)
  expect(field().value).toBe('me: original words')
  expect(root.textContent).toContain('503')
})

it('keeps later speech in the box after releasing and sending only the shown checkpoint', async () => {
  await mount()
  releaseRows = [{ ...held, through: 2, text: 'me: more speech' }]
  root.querySelector<HTMLButtonElement>('.kbn-ctl-resume')!.click()
  await flush()
  expect(requests().find(row => row.url.endsWith('/release'))!.body).toEqual({ id: 'held', through: 1 })
  expect(dispatches()[0].body.user_message).toBe('me: original words')
  expect(field().value).toBe('me: more speech')
  voice.status = { ...server, held: [] }; notify()
  expect(field().value).toBe('')
})
