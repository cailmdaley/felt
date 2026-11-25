// @vitest-environment jsdom
// Listen's writes and pushes against the real Voice, with a stubbed fetch.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ListenControl } from './ListenControl.js'
import { Voice, type VoiceStatus } from '../voice.js'
import { card, settle, voiceStatus } from '../testFixtures.js'

const swg = { fiber_id: 'swg', origin: 'far-host', name: 'SWG meeting', pinned: false, slug: 'cmbx/meetings/swg' }
let control: ListenControl
let voice: Voice
let posts: Array<{ url: string; body: Record<string, unknown> }>
let hang: (url: string, body: Record<string, unknown>) => boolean
const menu = () => document.querySelector<HTMLElement>('[role="menu"][aria-label="Listening options"]')
const item = (name: string) => [...menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent === name)!
const opener = () => control.el.querySelector<HTMLButtonElement>('[aria-label="Listening options"]')!
const mic = () => control.el.querySelector<HTMLButtonElement>('.listen-mic')!

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  posts = []; hang = () => false
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    posts.push({ url, body })
    if (hang(url, body)) return new Promise(() => {})
    const next: VoiceStatus = { ...voice.status!, ...(body as Partial<VoiceStatus>), recorder: 'near-host' }
    return Promise.resolve({ ok: true, status: 200, json: async () => next })
  }))
  voice = new Voice('')
  voice.status = voiceStatus({ enabled: true, follow: true, state: 'listening', recorder: 'near-host', target: swg, mode: 'following' })
  control = new ListenControl({ card: () => card({ id: 'swg', name: 'SWG meeting', originId: 'far-host' }), voice, shuttleBase: '', fiberSlug: id => id })
  document.body.append(control.el)
})
afterEach(() => { control.dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('a voice write that never answers gives up, so later Listen actions still reach the daemon', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  // Any earlier write on the chain (a set, or the board's own claim of /voice/target) whose fetch never settles.
  hang = (_url, body) => body.muted === true
  mic().click(); await settle()
  expect(posts.map(p => p.body)).toEqual([{ muted: true, recorder: 'near-host' }])
  expect(mic().disabled).toBe(true)

  opener().click(); item('Stop listening').click(); await settle()
  opener().click(); item('Start meeting on this card').click(); await settle()
  await vi.advanceTimersByTimeAsync(60_000)

  expect(posts.map(p => p.body)).toContainEqual({ enabled: false, recorder: 'near-host' })
})

it('a pushed route the board already holds does not close the open menu', async () => {
  opener().click()
  expect(menu()).not.toBeNull()
  // The voice/events stream pushes the same route with `cold` added; GET /voice serves it without.
  ;(voice as unknown as { pushed: (e: Event) => void }).pushed(new MessageEvent('target', { data: JSON.stringify({ ...swg, cold: false }) }))
  expect(menu()).not.toBeNull()
})

it('speech said into the muted mic shows how much, marked while it grows, and Recover asks the recorder for it', async () => {
  const held = () => control.el.querySelector<HTMLElement>('.listen-held')!
  const recover = () => control.el.querySelector<HTMLButtonElement>('.listen-recover')!
  const read = (seconds: number, recovering = false) => {
    voice.status = { ...voice.status!, muted: true, muted_speech: { seconds, since: '2026-11-25T21:52:03+01:00', recovering } }
    ;(voice as unknown as { notify(): void }).notify()
  }
  expect(held().hidden).toBe(true)
  read(236)
  expect(held().hidden).toBe(false)
  expect(held().textContent).toBe('4 min said while mutedRecover')
  expect(held().hasAttribute('data-arriving')).toBe(true)
  read(236)
  expect(held().hasAttribute('data-arriving')).toBe(false)
  read(42)
  expect(held().textContent).toBe('42 s said while mutedRecover')

  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    const next: VoiceStatus = { ...voice.status!, muted_speech: { ...voice.status!.muted_speech!, recovering: true } }
    return Promise.resolve({ ok: true, status: 200, json: async () => next })
  }))
  recover().click(); await settle()
  expect(posts.at(-1)).toEqual({ url: '/api/v1/voice/recover', body: { recorder: 'near-host' } })
  expect(held().textContent).toBe('Recovering 42 s said while muted…Recover')
  expect(recover().hidden).toBe(true)

  voice.status = { ...voice.status!, enabled: false }
  ;(voice as unknown as { notify(): void }).notify()
  expect(held().hidden).toBe(true)
})
