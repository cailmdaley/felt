// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PhoneListening } from './phoneListening'
import { Mic, type MicHandlers } from '../phone/mic'
import { RelayLink } from '../phone/relay'
import { Dock } from './workspace/Dock'
import { Voice, type VoiceStatus } from './voice'
import { card, voiceStatus, settle } from './testFixtures'

vi.mock('../phone/relay', () => ({ RelayLink: vi.fn(function () { return { open: vi.fn(), close: vi.fn(), send: vi.fn(), nudge: vi.fn() } }) }))
let dock: Dock
let phone: PhoneListening
let voice: Voice
let handlers: MicHandlers
let current: VoiceStatus
const fetcher = vi.fn()
const opened = { close: vi.fn(), health: vi.fn(() => 'ok' as const), revive: vi.fn(async () => 'ok' as const) }
const mic = () => dock.el.querySelector<HTMLButtonElement>('.listen-mic')!
function mount() {
  current = voiceStatus({ sources: ['phone'] })
  voice = new Voice('https://hub.example'); voice.status = current
  phone = new PhoneListening('https://hub.example')
  voice.subscribe(() => phone.observe(voice.status))
  dock = new Dock('', vi.fn(), undefined, undefined, { voice: { controller: voice }, phone })
  dock.open(card({ id: 'science/task', uid: 'task', originId: 'worker-owner', shuttleKind: 'oneshot' }))
  document.body.append(dock.el)
  fetcher.mockClear()
}
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('AudioContext', class { resume = vi.fn(async () => {}); close = vi.fn(async () => {}) })
  vi.spyOn(Mic, 'open').mockImplementation((_context, value) => { handlers = value; return Promise.resolve(opened as unknown as Mic) })
  fetcher.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (_url.endsWith('/agents')) return Response.json([])
    if (_url.includes('/config/voice')) return Response.json({ text: '{}', digest: null })
    const values = JSON.parse(String(init?.body ?? '{}'))
    current = { ...current, ...values, source: 'phone', recorder: 'recorder-host', launch: 'voice-L1', state: 'listening' }
    return Response.json(current)
  })
  vi.stubGlobal('fetch', fetcher)
  mount()
})
afterEach(() => { dock.reset(); phone.unmount(); voice.dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals() })

it('opens audio inside the click, then starts voice and binds PCM to the returned recorder and launch', async () => {
  mic().click()
  expect(Mic.open).toHaveBeenCalledOnce()
  expect(fetcher).not.toHaveBeenCalled()
  await settle()
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ enabled: true, source: 'phone', muted: false })
  expect(RelayLink).toHaveBeenCalledWith(expect.objectContaining({ url: 'wss://hub.example/api/v1/voice/audio?launch=voice-L1&recorder=recorder-host' }))
  const pcm = new ArrayBuffer(32)
  handlers.onChunk(pcm)
  expect(vi.mocked(RelayLink).mock.results[0].value.send).toHaveBeenCalledWith(pcm)
  expect(mic().getAttribute('aria-label')).toBe('Mute')
  expect(fetcher.mock.calls.every(([url]) => url.includes('/voice'))).toBe(true)
})
it('mutes and unmutes a phone through the same recorder controls, without reopening audio', async () => {
  mic().click(); await settle()
  mic().click(); await settle()
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ muted: true, recorder: 'recorder-host' })
  expect(mic().getAttribute('aria-label')).toBe('Unmute')
  expect(mic().querySelectorAll('path')).toHaveLength(2)
  mic().click(); await settle()
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ muted: false, recorder: 'recorder-host' })
  expect(Mic.open).toHaveBeenCalledOnce()
  dock.el.querySelector<HTMLButtonElement>('.listen-dropdown')!.click()
  expect([...dock.el.querySelectorAll('[role^=menuitem]')].map(el => el.textContent)).toEqual(['Follow me', 'Pin to this card', "Today's transcript", 'Stop listening'])
})
it('closes local audio when Stop is confirmed and does not stop it for mute or a failed status read', async () => {
  mic().click(); await settle()
  phone.observe(null)
  expect(opened.close).not.toHaveBeenCalled()
  mic().click(); await settle()
  expect(opened.close).not.toHaveBeenCalled()
  dock.el.querySelector<HTMLButtonElement>('.listen-dropdown')!.click()
  ;[...dock.el.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(el => el.textContent === 'Stop listening')!.click()
  await settle()
  expect(opened.close).toHaveBeenCalledOnce()
  expect(voice.status?.enabled).toBe(false)
})
it('never starts a recorder after mic permission fails', async () => {
  vi.mocked(Mic.open).mockRejectedValueOnce(Object.assign(new Error('Denied'), { name: 'NotAllowedError' }))
  mic().click(); await settle()
  expect(fetcher).not.toHaveBeenCalled()
  expect(mic().title).toContain('Microphone permission was denied')
  expect(dock.el.querySelector('.listen-failed')).not.toBeNull()
})
it('releases the mic on a failed start and shows the recorder reason', async () => {
  fetcher.mockResolvedValueOnce(Response.json({ error: 'Recorder unreachable' }, { status: 502 }))
  mic().click(); await settle()
  expect(opened.close).toHaveBeenCalledOnce()
  expect(RelayLink).not.toHaveBeenCalled()
  expect(mic().title).toContain('Recorder unreachable')
})
it('rejects an unbound launch and releases audio on replacement', async () => {
  const opening = phone.begin()
  const generation = await opening.ready
  expect(() => opening.bind(generation, voiceStatus({ enabled: true, source: 'phone', recorder: 'recorder-host' }))).toThrow('phone listening launch')
  expect(opened.close).toHaveBeenCalledOnce()
  opened.close.mockClear()
  mic().click(); await settle()
  phone.observe({ ...voice.status!, launch: 'voice-replacement' })
  expect(opened.close).toHaveBeenCalledOnce()
})
it('shows a terminal PCM refusal as a red mic with the relay reason', async () => {
  mic().click(); await settle()
  const options = vi.mocked(RelayLink).mock.calls[0][0]
  options.onLink('refused', 'Launch no longer accepts audio')
  expect(dock.el.querySelector('.listen-failed')).not.toBeNull()
  dock.el.querySelector<HTMLButtonElement>('.listen-dropdown')!.click()
  expect(dock.el.querySelector('.voice-error')!.textContent).toBe('Launch no longer accepts audio')
  expect(opened.close).toHaveBeenCalledOnce()
})
it('keeps its audio when the console changes cards', async () => {
  mic().click(); await settle()
  dock.open(card({ id: 'elsewhere', shuttleKind: 'oneshot' }))
  expect(opened.close).not.toHaveBeenCalled()
  expect(phone.session.busy).toBe(true)
})
