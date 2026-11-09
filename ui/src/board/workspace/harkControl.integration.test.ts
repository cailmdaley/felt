// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Dock } from './Dock.js'
import { card, voiceStatus } from '../testFixtures.js'
import { Voice, type VoiceStatus } from '../voice.js'

const target = { fiber_id: 'a', origin: 'owner', name: 'Alpha' }
let current: VoiceStatus
let dock: Dock
let voice: Voice
const fetcher = vi.fn()
const notify = () => (voice as unknown as { notify(): void }).notify()
const q = <T extends HTMLElement = HTMLElement>(selector: string) => dock.el.querySelector<T>(selector)!
const dropdown = () => q<HTMLButtonElement>('.listen-dropdown').click()
const mic = () => q<HTMLButtonElement>('.listen-mic')
const items = () => [...dock.el.querySelectorAll<HTMLButtonElement>('[role^=menuitem]')]
const item = (label: string) => items().find(button => button.textContent === label)!
function mount(over: Partial<VoiceStatus> = {}) {
  current = voiceStatus({ target, ...over })
  voice = new Voice(''); voice.status = current
  dock = new Dock('', vi.fn(), undefined, undefined, { voice: { controller: voice } })
  dock.setFiberSlug(id => id.split('/').at(-1))
  dock.open(card({ id: 'work/a', uid: 'a', originId: 'owner', name: 'Alpha', shuttleKind: 'oneshot' }))
  document.body.append(dock.el)
  fetcher.mockClear()
}
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/agents')) return Response.json([])
    if (init?.method === 'POST') {
      current = { ...current, ...JSON.parse(String(init.body)) }
      current.state = current.enabled ? 'listening' : 'off'
    }
    return Response.json(current)
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { dock?.reset(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals() })

it('starts unmuted, mutes with a slash, unmutes, and stops only from the menu', async () => {
  mount({ muted: true })
  expect(mic().getAttribute('aria-label')).toBe('Listen')
  expect(q('.ws-voice-strip').hidden).toBe(true)
  mic().click()
  await vi.waitFor(() => expect(mic().getAttribute('aria-label')).toBe('Mute'))
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ enabled: true, muted: false, source: 'desktop' })
  expect(mic().querySelectorAll('path')).toHaveLength(1)
  mic().click()
  await vi.waitFor(() => expect(mic().getAttribute('aria-label')).toBe('Unmute'))
  expect(mic().querySelectorAll('path')).toHaveLength(2)
  mic().click()
  await vi.waitFor(() => expect(mic().getAttribute('aria-label')).toBe('Mute'))
  dropdown(); item('Stop listening').click()
  await vi.waitFor(() => expect(mic().getAttribute('aria-label')).toBe('Listen'))
  expect(q('.ws-voice-strip').hidden).toBe(true)
})
it('offers only routing, cadence, day transcript and Stop', () => {
  mount(); dropdown()
  expect(items().map(item => item.textContent)).toEqual(['Follow me', 'System audio', 'Pin to this card', "Today's transcript", 'Stop listening'])
  expect(item('Follow me').getAttribute('aria-checked')).toBe('true')
  expect(item('System audio').getAttribute('aria-checked')).toBe('false')
  expect(item('Stop listening').disabled).toBe(true)
  expect(q('[aria-label="Quiet seconds (following)"]')).not.toBeNull()
})
it('pins atomically to this card and resumes following without disabling Listen', async () => {
  mount({ enabled: true, state: 'listening', recorder: 'recorder' })
  dropdown(); item('Pin to this card').click()
  await vi.waitFor(() => expect(voice.status?.follow).toBe(false))
  expect(JSON.parse(fetcher.mock.calls.find(([url, init]) => url === '/api/v1/voice' && init?.method === 'POST')![1].body))
    .toEqual({ follow: false, target, recorder: 'recorder' })
  expect(q('.ws-voice-strip').textContent).toBe('📌 a')
  dropdown()
  expect(items().some(item => item.textContent === 'Pin to this card')).toBe(false)
  expect(item('Follow me').getAttribute('aria-checked')).toBe('false')
  item('Follow me').click()
  await vi.waitFor(() => expect(voice.status?.follow).toBe(true))
  expect(voice.status?.enabled).toBe(true)
  expect(q('.ws-voice-strip').textContent).toBe('a')
})
it('offers pin here when pinned elsewhere, including another host with the same id', () => {
  mount({ follow: false, target: { ...target, origin: 'elsewhere' } }); dropdown()
  expect(item('Pin to this card')).toBeDefined()
})
it('toggles system transcription live on the recorder, retaining mute and pin', async () => {
  mount({ enabled: true, muted: true, follow: false, recorder: 'audio-host' }); dropdown()
  item('System audio').click()
  await vi.waitFor(() => expect(voice.status?.system_audio).toBe(true))
  expect(voice.status).toMatchObject({ enabled: true, muted: true, follow: false })
  const write = fetcher.mock.calls.find(([url]) => url === '/api/v1/voice')!
  expect(JSON.parse(write[1].body)).toEqual({ system_audio: true, recorder: 'audio-host' })
})
it.each([{ source: 'phone' as const }, { sources: ['phone'] as VoiceStatus['sources'] }])('hides System audio when the recorder cannot use it: %j', over => {
  mount(over); dropdown(); expect(items().some(item => item.textContent === 'System audio')).toBe(false)
})
it.each([true, false])('edits only the current quiet threshold on the recorder (follow=%s)', async follow => {
  mount({ follow, recorder: 'audio host' }); dropdown()
  const quiet = q<HTMLInputElement>('input[type=number]')
  await vi.waitFor(() => expect(quiet.disabled).toBe(false))
  expect(quiet.value).toBe(follow ? '15' : '120')
  expect(fetcher).not.toHaveBeenCalled()
  quiet.value = '0.5'; quiet.dispatchEvent(new Event('change', { bubbles: true }))
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  expect(fetcher.mock.calls[0][0]).toBe('/api/v1/voice')
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ [follow ? 'quiet_seconds' : 'pinned_quiet_seconds']: 0.5, recorder: 'audio host' })
})
it('shows recorder and delivery failures in red without hiding mute or destination', () => {
  mount({ enabled: true, muted: true, state: 'failed', error: 'Mic refused' })
  expect(q('.listen-control').classList.contains('listen-failed')).toBe(true)
  expect(mic().getAttribute('aria-label')).toBe('Unmute')
  expect(q('.ws-voice-strip').textContent).toBe('a')
  dropdown(); expect(q('.voice-error').textContent).toBe('Mic refused')
  voice.status = { ...voice.status!, state: 'listening', error: null, last: { fiber_id: 'a', at: '', status: 'failed', detail: 'Worker gone' } }; notify()
  dropdown(); expect(q('.voice-error').textContent).toContain('Worker gone')
})
it('controls a phone recording from desktop without acquiring this browser’s mic', async () => {
  mount({ enabled: true, source: 'phone', muted: true, recorder: 'phone-recorder' })
  mic().click()
  await vi.waitFor(() => expect(voice.status?.muted).toBe(false))
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ muted: false, recorder: 'phone-recorder' })
  expect(q('.listen-failed')).toBeNull()
})
it('surfaces the daemon reason for a rejected control', async () => {
  mount()
  fetcher.mockResolvedValue(Response.json({ error: 'Hark unavailable' }, { status: 422 }))
  mic().click()
  await vi.waitFor(() => expect(mic().title).toContain('Hark unavailable'))
  expect(q('.listen-failed')).not.toBeNull()
})
it('closes a stale menu on target or recorder changes and restores focus on Escape', () => {
  mount(); dropdown()
  voice.status = { ...voice.status!, recorder: 'different' }; notify()
  expect(q('[role=menu]')).toBeNull()
  dropdown()
  q('[role=menu]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(q('[role=menu]')).toBeNull()
  expect(document.activeElement).toBe(q('.listen-dropdown'))
})
it('pins to the highlighted thread, as the band\'s other verbs act on it', async () => {
  mount({ enabled: true, state: 'listening', recorder: 'recorder' })
  dock.setActionCard(card({ id: 'work/a/sub', uid: 'sub', originId: 'owner', name: 'Sub', shuttleKind: 'oneshot' }))
  dropdown(); item('Pin to this card').click()
  await vi.waitFor(() => expect(voice.status?.follow).toBe(false))
  expect(JSON.parse(fetcher.mock.calls.find(([url, init]) => url === '/api/v1/voice' && init?.method === 'POST')![1].body).target)
    .toEqual({ fiber_id: 'sub', origin: 'owner', name: 'Sub' })
})
