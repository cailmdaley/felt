// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Dock } from './Dock.js'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { Voice, type VoiceHeld, type VoiceStatus } from '../voice.js'

const held: VoiceHeld = { id: 'held', fiber_id: 'uid', origin: 'owner', through: 1, text: 'me: original words', segments: [{ through: 1, text: 'me: original words' }] }
const row = (patch: Partial<VoiceHeld> = {}): VoiceHeld => ({ ...held, ...patch, segments: patch.segments ?? [{ through: patch.through ?? 1, text: patch.text ?? held.text }] })
const growth = (prefix: string, suffix: string): VoiceHeld => row({ through: 2, text: prefix + suffix, segments: [{ through: 1, text: prefix }, { through: 2, text: suffix }] })
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
      server = { ...server, held: server.held!.map(held => ({ ...held, text: body.text, segments: [{ through: body.through, text: body.text }] })) }
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
  dock = new Dock('', vi.fn(), undefined, undefined, { voice: { controller: voice }, meeting: meeting as never })
  const band = dock.bandFor(card({ id: 'task', uid: 'uid', originId: 'owner', shuttleHost: 'owner', shuttleKind: 'oneshot', shuttleAgent: 'codex-sol', sessionUuid: 'session', ...patch }))
  root = band.el; document.body.append(root); await flush()
}

it('fills the editable box and keeps one Listening control as the worker warms', async () => {
  await mount()
  expect(field().value).toBe('me: original words')
  expect(root.querySelector('.kbn-ctl-meet-arm')!.textContent).toBe('Listening · Task')
  expect(root.querySelectorAll('.kbn-ctl-meet')).toHaveLength(1)
  voice.status = { ...server, cold: false }; notify()
  expect(root.querySelector('.kbn-ctl-meet-arm')!.textContent).toBe('Listening · Task')
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
  expect(posts[0].body).toEqual({ id: 'held', after: 0, through: 1, text: 'me: edited words' })
  expect(posts[1].body).toEqual({ id: 'held', after: 0, through: 1 })
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
  releaseRows = [row({ after: 1, through: 2, text: 'me: more speech' })]
  root.querySelector<HTMLButtonElement>('.kbn-ctl-resume')!.click()
  await flush()
  expect(requests().find(row => row.url.endsWith('/release'))!.body).toEqual({ id: 'held', after: 0, through: 1 })
  expect(dispatches()[0].body.user_message).toBe('me: original words')
  expect(field().value).toBe('me: more speech')
  voice.status = { ...server, held: [] }; notify()
  expect(field().value).toBe('')
})

it('a same-through prefix claim removes only consumed voice words before the next button send', async () => {
  server.held = []; voice.status = server
  await mount()
  field().value = 'typed before'; field().dispatchEvent(new Event('input'))
  server.held = [{ ...held, after: 0, through: 2, text: 'S1: first words more words' }]
  voice.status = server; notify()
  field().value += '\ntyped after'; field().dispatchEvent(new Event('input'))
  server.held = [{ ...held, after: 1, through: 2, text: 'S1: more words' }]
  voice.status = server; notify()
  expect(field().value).toBe('typed before\n\nS1: more words\ntyped after')
  root.querySelector<HTMLButtonElement>('.kbn-ctl-resume')!.click()
  await flush()
  expect(dispatches()[0].body.user_message).toBe('typed before\n\nS1: more words\ntyped after')
})

it('acknowledged deletion does not swallow the same words when they are spoken again', async () => {
  server.held = [{ ...held, text: 'S1: hello world' }]; voice.status = server
  await mount()
  field().value = 'S1: hello'; field().dispatchEvent(new Event('input'))
  await flush()
  expect(server.held![0].text).toBe('S1: hello')
  server.held = [growth('S1: hello', ' world')]
  voice.status = server; notify()
  expect(field().value).toBe('S1: hello world')
  root.querySelector<HTMLButtonElement>('.kbn-ctl-resume')!.click()
  await flush()
  expect(dispatches()[0].body.user_message).toBe('S1: hello world')
})

it.each(['fetch', 'json'])('retains the edited draft when release commits but its %s response is lost', async failure => {
  await mount()
  field().value = 'S1: an irreplaceable correction'; field().dispatchEvent(new Event('input'))
  await flush()
  const fetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/release')) {
      server = { ...server, held: [] }
      if (failure === 'fetch') throw new TypeError('connection lost')
      return new Response('incomplete JSON')
    }
    return fetch(url, init)
  }))
  root.querySelector<HTMLButtonElement>('.kbn-ctl-resume')!.click()
  await flush()
  expect(dispatches()).toHaveLength(0)
  voice.status = server; notify()
  expect(field().value).toBe('S1: an irreplaceable correction')
  expect(root.textContent).toContain('Check the worker')
  // Rebuilding the composer must not turn the retained draft into an auto-send.
  dock.reset(); root.remove(); await mount()
  expect(field().value).toBe('S1: an irreplaceable correction')
  voice.status = server; notify(); await flush()
  expect(dispatches()).toHaveLength(0)
})

it('appends exact segments when an edit acknowledgement includes fresh speech', async () => {
  server.held = [{ ...held, text: 'S1: hello world' }]; voice.status = server
  await mount()
  const fetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/draft')) {
      // The edit is accepted, then another finalized segment arrives before
      // the response snapshot is read. The raw words happen to match.
      server.held = [growth('S1: hello', ' world')]
      return response(server)
    }
    return fetch(url, init)
  }))
  field().value = 'S1: hello'; field().dispatchEvent(new Event('input'))
  await flush()
  expect(field().value).toBe('S1: hello world')
  root.querySelector<HTMLButtonElement>('.kbn-ctl-resume')!.click()
  await flush()
  expect(dispatches()[0].body.user_message).toBe('S1: hello world')
})

it('edits and releases the consumed-prefix boundary from the exact shown suffix', async () => {
  server.held = [{ ...held, after: 1, through: 2, text: 'S1: remaining words' }]; voice.status = server
  await mount()
  field().value = 'S1: corrected remainder'; field().dispatchEvent(new Event('input'))
  root.querySelector<HTMLButtonElement>('.kbn-ctl-resume')!.click()
  await flush()
  expect(requests().find(row => row.url.endsWith('/draft'))!.body).toEqual({ id: 'held', after: 1, through: 2, text: 'S1: corrected remainder' })
  expect(requests().find(row => row.url.endsWith('/release'))!.body).toEqual({ id: 'held', after: 1, through: 2 })
  expect(dispatches()[0].body.user_message).toBe('S1: corrected remainder')
})

it('a partial name claim racing release fences the stale box, but leaves its suffix sendable', async () => {
  server.held = [{ ...held, after: 0, through: 2, text: 'S1: first words more words' }]; voice.status = server
  await mount()
  const fetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/release')) {
      const body = JSON.parse(String(init?.body))
      server.held = [{ ...held, after: 1, through: 2, text: 'S1: more words' }]
      if (body.after !== 1) return response({}, 409)
      server.held = []
      return response(server)
    }
    return fetch(url, init)
  }))
  root.querySelector<HTMLButtonElement>('.kbn-ctl-resume')!.click()
  await flush()
  expect(dispatches()).toHaveLength(0)
  expect(field().value).toBe('S1: more words')
  expect(requests().find(row => row.url.endsWith('/release'))!.body).toEqual({ id: 'held', after: 0, through: 2 })
  root.querySelector<HTMLButtonElement>('.kbn-ctl-resume')!.click()
  await flush()
  expect(dispatches()).toHaveLength(1)
  expect(dispatches()[0].body.user_message).toBe('S1: more words')
  expect(requests().filter(row => row.url.endsWith('/release')).at(-1)!.body).toEqual({ id: 'held', after: 1, through: 2 })
})

it('a partial name claim racing an edit rejects the stale full-box draft without replacing the suffix', async () => {
  server.held = [{ ...held, after: 0, through: 2, text: 'S1: first words more words' }]; voice.status = server
  await mount()
  const fetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/draft')) {
      server.held = [{ ...held, after: 1, through: 2, text: 'S1: more words' }]
      return response({}, 409)
    }
    return fetch(url, init)
  }))
  field().value = 'S1: edited first words more words'; field().dispatchEvent(new Event('input'))
  await flush()
  expect(requests().find(row => row.url.endsWith('/draft'))!.body).toEqual({ id: 'held', after: 0, through: 2, text: 'S1: edited first words more words' })
  expect(field().value).toBe('S1: more words')
  expect(server.held![0].text).toBe('S1: more words')
  expect(dispatches()).toHaveLength(0)
})

it('does not swallow repeated speech when a poll beats the deletion acknowledgement', async () => {
  server.held = [{ ...held, text: 'S1: hello world' }]; voice.status = server
  await mount()
  let acknowledge!: () => void
  const fetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/draft')) {
      await new Promise<void>(resolve => { acknowledge = resolve })
      return response(server)
    }
    return fetch(url, init)
  }))
  field().value = 'S1: hello'; field().dispatchEvent(new Event('input'))
  await flush()
  // The accepted deletion plus fresh words share the obsolete raw prefix.
  server.held = [growth('S1: hello', ' world again')]
  voice.status = server; notify()
  expect(field().value).toBe('S1: hello world again')
  acknowledge(); await flush()
  expect(field().value).toBe('S1: hello world again')
  root.querySelector<HTMLButtonElement>('.kbn-ctl-resume')!.click()
  await flush()
  expect(dispatches()[0].body.user_message).toBe('S1: hello world again')
})

it.each(['fetch', 'json'])('a poll confirms a committed deletion after its %s edit response is lost', async failure => {
  server.held = [{ ...held, text: 'S1: hello world' }]; voice.status = server
  await mount()
  const fetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/draft')) {
      server.held = [row({ text: JSON.parse(String(init?.body)).text })]
      if (failure === 'fetch') throw new TypeError('edit response lost')
      return new Response('incomplete JSON')
    }
    return fetch(url, init)
  }))
  field().value = 'S1: hello'; field().dispatchEvent(new Event('input'))
  await flush()
  expect(field().value).toBe('S1: hello')
  voice.status = server; notify()
  server.held = [growth('S1: hello', ' world')]
  voice.status = server; notify()
  expect(field().value).toBe('S1: hello world')
  root.querySelector<HTMLButtonElement>('.kbn-ctl-resume')!.click()
  await flush()
  expect(dispatches()[0].body.user_message).toBe('S1: hello world')
})

it.each(['fetch', 'json'])('appends repeated finalized words before the first poll after a lost %s edit response', async failure => {
  server.held = [row({ text: 'S1: hello world' })]; voice.status = server
  await mount()
  const fetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/draft')) {
      server.held = [growth(JSON.parse(String(init?.body)).text, ' world')]
      if (failure === 'fetch') throw new TypeError('edit response lost')
      return new Response('incomplete JSON')
    }
    return fetch(url, init)
  }))
  field().value = 'S1: hello'; field().dispatchEvent(new Event('input'))
  await flush()
  expect(field().value).toBe('S1: hello')
  // No same-through confirmation poll occurs between the lost ACK and growth.
  voice.status = server; notify()
  expect(field().value).toBe('S1: hello world')
  root.querySelector<HTMLButtonElement>('.kbn-ctl-resume')!.click()
  await flush()
  expect(requests().find(row => row.url.endsWith('/release'))!.body).toEqual({ id: 'held', after: 0, through: 2 })
  expect(dispatches()[0].body.user_message).toBe('S1: hello world')
})

it('an authoritative poll does not overwrite a local edit whose failed request did not commit', async () => {
  server.held = [{ ...held, text: 'S1: hello world' }]; voice.status = server
  await mount()
  const fetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/draft')) throw new TypeError('edit did not reach the recorder')
    return fetch(url, init)
  }))
  field().value = 'S1: local correction'; field().dispatchEvent(new Event('input'))
  await flush()
  voice.status = server; notify()
  expect(field().value).toBe('S1: local correction')
  server.held = [growth('S1: hello world', ' more words')]
  voice.status = server; notify()
  expect(field().value).toBe('S1: local correction more words')
})
