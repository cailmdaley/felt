// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Dock } from './Dock.js'
import { card } from '../testFixtures.js'
import { Voice, type VoiceStatus } from '../voice.js'

const status: VoiceStatus = { available: true, enabled: false, muted: false, state: 'off', target: { fiber_id: 'a', origin: 'local', name: 'Alpha' }, last: null, error: null }
const notify = (voice: Voice): void => (voice as unknown as { notify: () => void }).notify()
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ text: '{}', digest: null })))
})
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function mount(initial: VoiceStatus | null = { ...status }) {
  const voice = new Voice(''); voice.status = initial
  let recording: { state: 'starting' | 'loading' | 'live' | 'stopping'; title: string; fiber: string; tail: never[]; paused?: boolean; phone?: boolean; recorder?: string; handoff?: { status: string; kind: null; target: null; origin: null; prompt: null } } | null = null
  const meeting = { current: () => recording, canJoin: () => !recording, modes: () => ['call', 'phone'], join: vi.fn(async () => null), stop: vi.fn(), pause: vi.fn(async () => {}) }
  const open = vi.fn()
  const dock = new Dock('', vi.fn(), undefined, undefined, { meeting: meeting as never, voice: { controller: voice } })
  dock.open(card({ id: 'a', name: 'Alpha', uid: 'a', originId: 'local', shuttleKind: 'oneshot', shuttleAgent: 'codex-sol', shuttleHost: 'local' }))
  const band = dock
  band.openFile = open
  document.body.append(band.el)
  const root = band.el
  const main = () => root.querySelector<HTMLButtonElement>('.kbn-ctl-meet-arm')!
  const dropdown = () => root.querySelector<HTMLButtonElement>('.kbn-ctl-meet-dropdown')!
  const menuItems = () => [...root.querySelectorAll<HTMLButtonElement>('[role=menuitem]')]
  const pause = () => root.querySelector<HTMLButtonElement>('.kbn-ctl-meet-pause')!
  const stop = () => root.querySelector<HTMLButtonElement>('.kbn-ctl-meet-stop')!
  return { voice, meeting, dock, band, root, main, dropdown, menuItems, pause, stop, open, setRecording(value: typeof recording) { recording = value; dock.syncMeeting() } }
}

it('is one Listen that follows, and splits into Pause and Stop once on', async () => {
  const v = mount()
  const set = vi.spyOn(v.voice, 'set').mockImplementation(async values => { v.voice.status = { ...v.voice.status!, ...values, state: 'listening' }; notify(v.voice) })
  expect(v.root.querySelectorAll('.kbn-ctl-meet')).toHaveLength(1)
  expect(v.main().textContent).toBe('Listen')
  expect(v.pause().hidden).toBe(true)
  expect(v.stop().hidden).toBe(true)
  v.main().click()
  expect(set).toHaveBeenCalledWith({ enabled: true, muted: false })
  expect(v.meeting.join).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(v.main().textContent).toBe('Following · Alpha'))
  expect(v.pause().hidden).toBe(false)
  expect(v.stop().hidden).toBe(false)
  v.pause().click()
  expect(set).toHaveBeenLastCalledWith({ muted: true })
  await vi.waitFor(() => expect(v.root.querySelector('.kbn-ctl-meet-paused')).not.toBeNull())
  expect(v.pause().getAttribute('aria-label')).toBe('Resume listening')
  v.stop().click()
  await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith({ enabled: false }))
  await vi.waitFor(() => expect(v.main().textContent).toBe('Listen'))
  v.dock.reset()
})

it('names the card words reach while following another', () => {
  const v = mount()
  v.voice.status = { ...status, enabled: true, state: 'listening', target: { fiber_id: 'b', origin: 'local', name: 'Bravo' } }; notify(v.voice)
  expect(v.main().textContent).toBe('Following · Bravo')
  expect(v.main().title).toContain('words go to Bravo')
  v.dock.reset()
})

it('keeps the menu quiet: transcript, a meeting here with its audio, and quiet seconds', () => {
  const v = mount()
  v.dropdown().click()
  expect(v.menuItems().map(x => x.textContent)).toEqual(['Record a meeting on Alpha'])
  expect(v.root.querySelector('[aria-label="Meeting audio"]')).not.toBeNull()
  expect(v.root.querySelector('[aria-label="Quiet seconds"]')).not.toBeNull()
  expect(v.root.querySelector('[role=menuitemcheckbox]')).toBeNull()
  v.dropdown().click()
  v.voice.status = { ...status, enabled: true, state: 'listening' }; notify(v.voice)
  v.dropdown().click()
  expect(v.menuItems().map(x => x.textContent)).toEqual(['Open transcript', 'Record a meeting on Alpha'])
  expect(v.root.textContent).not.toContain('Held')
  v.dock.reset()
})

it('turns following off when a meeting starts, so one mode holds the mic', async () => {
  const v = mount()
  const set = vi.spyOn(v.voice, 'set').mockResolvedValue()
  v.voice.status = { ...status, enabled: true, state: 'listening' }; notify(v.voice)
  v.dropdown().click()
  v.menuItems().find(x => x.textContent === 'Record a meeting on Alpha')!.click()
  expect(v.meeting.join).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'call', expect.objectContaining({ systemAudio: true }))
  await vi.waitFor(() => expect(set).toHaveBeenCalledWith({ enabled: false }))
  v.dock.reset()
})

it('reads a meeting as a meeting, wherever it is joined', () => {
  const v = mount()
  v.setRecording({ state: 'live', title: 'Standup', fiber: 'a', tail: [] })
  expect(v.main().textContent).toBe('Meeting · Alpha')
  expect(v.root.querySelector('.kbn-ctl-meet')!.getAttribute('data-mode')).toBe('meeting')
  v.setRecording({ state: 'live', title: 'Call', fiber: 'life/vizier', tail: [] })
  expect(v.main().textContent).toBe('Meeting · vizier')
  expect(v.main().title).toContain('every word goes to vizier')
  v.dock.reset()
})

it('pauses a meeting, and Stop ends it and leaves the mic off', async () => {
  const v = mount()
  const set = vi.spyOn(v.voice, 'set').mockResolvedValue()
  v.voice.status = { ...status, enabled: true, state: 'yielded' }; notify(v.voice)
  v.setRecording({ state: 'live', title: 'Standup', fiber: 'other', tail: [] })
  v.pause().click()
  expect(v.meeting.pause).toHaveBeenCalledWith(expect.objectContaining({ fiber: 'other' }), true)
  v.stop().click()
  expect(v.meeting.stop).toHaveBeenCalledWith(expect.objectContaining({ fiber: 'other' }))
  await vi.waitFor(() => expect(set).toHaveBeenCalledWith({ enabled: false }))
  v.dock.reset()
})

it('disables pause until a meeting is live, and omits it on a phone recording', () => {
  const v = mount()
  v.setRecording({ state: 'loading', title: 'Standup', fiber: 'a', tail: [] })
  expect(v.pause().disabled).toBe(true)
  v.setRecording({ state: 'live', title: 'Call', fiber: 'a', tail: [], phone: true })
  expect(v.pause().hidden).toBe(true)
  v.dock.reset()
})

it('shows a definite failure, keeps Stop reachable, and never shows unconfirmed delivery', async () => {
  const v = mount()
  v.voice.status = { ...status, enabled: true, state: 'listening', last: { fiber_id: 'a', at: '2026-11-06T10:00:00Z', status: 'unconfirmed', detail: 'May have arrived' } }; notify(v.voice)
  expect(v.main().textContent).toBe('Following · Alpha')
  vi.spyOn(v.voice, 'set').mockRejectedValue(new Error('Recorder unavailable'))
  v.pause().click()
  await vi.waitFor(() => expect(v.main().textContent).toBe('Failed'))
  expect(v.stop().hidden).toBe(false)
  v.dropdown().click()
  expect(v.root.textContent).toContain('Recorder unavailable')
  expect(v.root.textContent).not.toContain('May have arrived')
  v.dock.reset()
})

it('closes a stale menu when the meeting changes', () => {
  const v = mount()
  const recording = { state: 'live' as const, title: 'Standup', fiber: 'other', tail: [] as never[] }
  v.setRecording(recording)
  v.dropdown().click()
  expect(v.root.querySelector('[role=menu]')).not.toBeNull()
  v.setRecording({ ...recording, paused: true })
  expect(v.root.querySelector('[role=menu]')).toBeNull()
  v.dock.reset()
})

it('routes cadence edits to the active recorder', async () => {
  const v = mount()
  const fetcher = vi.mocked(fetch)
  fetcher.mockClear()
  fetcher.mockResolvedValueOnce(Response.json({ text: '{}', digest: 'before' }))
  fetcher.mockResolvedValueOnce(Response.json({ digest: 'after' }))
  v.setRecording({ state: 'live', title: 'Standup', fiber: 'other', tail: [], recorder: 'recorder host' })
  v.dropdown().click()
  await vi.waitFor(() => expect(v.root.querySelector<HTMLInputElement>('[aria-label="Quiet seconds"]')?.disabled).toBe(false))
  expect(fetcher.mock.calls[0][0]).toBe('/api/v1/config/voice?origin=recorder%20host')
  const quiet = v.root.querySelector<HTMLInputElement>('[aria-label="Quiet seconds"]')!
  quiet.value = '8'; quiet.dispatchEvent(new Event('change', { bubbles: true }))
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  const body = JSON.parse(fetcher.mock.calls[1][1]!.body as string)
  expect(body.origin).toBe('recorder host')
  expect(body.expected_digest).toBe('before')
  v.dock.reset()
})

it('closes the open menu when focus and click return to the trigger', () => {
  const v = mount()
  v.dropdown().click()
  expect(v.root.querySelector('[role=menu]')).not.toBeNull()
  v.dropdown().focus()
  v.dropdown().click()
  expect(v.root.querySelector('[role=menu]')).toBeNull()
  v.dock.reset()
})

it('closes the menu when the following recorder changes', () => {
  const v = mount()
  v.voice.status = { ...status, enabled: true, state: 'listening', recorder: 'first' }; notify(v.voice)
  v.dropdown().click()
  expect(v.root.querySelector('[role=menu]')).not.toBeNull()
  v.voice.status = { ...v.voice.status, recorder: 'second' }; notify(v.voice)
  expect(v.root.querySelector('[role=menu]')).toBeNull()
  v.dock.reset()
})

it('routes following cadence edits to the recorder, not the board host', async () => {
  const v = mount()
  v.voice.status = { ...status, enabled: true, state: 'listening', recorder: 'audio-host' }; notify(v.voice)
  const fetcher = vi.mocked(fetch)
  fetcher.mockClear()
  fetcher.mockResolvedValueOnce(Response.json({ text: '{}', digest: 'before' }))
  fetcher.mockResolvedValueOnce(Response.json({ digest: 'after' }))
  v.dropdown().click()
  await vi.waitFor(() => expect(v.root.querySelector<HTMLInputElement>('[aria-label="Quiet seconds"]')?.disabled).toBe(false))
  expect(fetcher.mock.calls[0][0]).toBe('/api/v1/config/voice?origin=audio-host')
  const quiet = v.root.querySelector<HTMLInputElement>('[aria-label="Quiet seconds"]')!
  quiet.value = '7'; quiet.dispatchEvent(new Event('change', { bubbles: true }))
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  const body = JSON.parse(fetcher.mock.calls[1][1]!.body as string)
  expect(body.origin).toBe('audio-host')
  expect(body.expected_digest).toBe('before')
  v.dock.reset()
})

it('opens the actual following transcript on its recorder even without a target', async () => {
  const v = mount()
  v.voice.status = { ...status, enabled: true, state: 'listening', target: null, recorder: 'audio-host' }; notify(v.voice)
  const fetcher = vi.mocked(fetch)
  fetcher.mockImplementation(async (url: RequestInfo | URL) => String(url).includes('/voice/transcript')
    ? Response.json({ path: '/hark/voice/current.txt', launch: 'voice-1', recorder: 'audio-host' })
    : Response.json({ text: '{}', digest: null }))
  v.dropdown().click()
  v.menuItems().find(x => x.textContent === 'Open transcript')!.click()
  await vi.waitFor(() => expect(v.open).toHaveBeenCalledWith('/hark/voice/current.txt', 'Listening transcript', 'audio-host'))
  v.dock.reset()
})

it('saves quiet seconds without replacing other settings', async () => {
  const v = mount()
  v.voice.status = { ...status, enabled: true, state: 'listening' }; notify(v.voice)
  const fetcher = vi.mocked(fetch)
  fetcher.mockClear()
  fetcher.mockResolvedValueOnce(Response.json({ text: JSON.stringify({ enabled: true, words: 42, run_quiet_seconds: 5 }), digest: 'before' }))
  fetcher.mockResolvedValueOnce(Response.json({ digest: 'after' }))
  fetcher.mockResolvedValueOnce(Response.json({ digest: 'again' }))
  v.dropdown().click()
  await vi.waitFor(() => expect(v.root.querySelector<HTMLInputElement>('[aria-label="Quiet seconds"]')?.disabled).toBe(false))
  const quiet = v.root.querySelector<HTMLInputElement>('[aria-label="Quiet seconds"]')!
  expect(quiet.value).toBe('15')
  quiet.value = '7'
  quiet.dispatchEvent(new Event('change', { bubbles: true }))
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  const body = JSON.parse(fetcher.mock.calls[1][1]!.body as string)
  expect(body.expected_digest).toBe('before')
  expect(JSON.parse(body.text)).toEqual({ enabled: true, words: 42, quiet_seconds: 7 })
  await vi.waitFor(() => expect(quiet.disabled).toBe(false))
  quiet.value = '3'
  quiet.dispatchEvent(new Event('change', { bubbles: true }))
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3))
  const again = JSON.parse(fetcher.mock.calls[2][1]!.body as string)
  expect(again.expected_digest).toBe('after')
  expect(JSON.parse(again.text)).toEqual({ enabled: true, words: 42, quiet_seconds: 3 })
  v.dock.reset()
})

it('lets the audio select handle arrow keys', () => {
  const v = mount()
  v.dropdown().click()
  const audio = v.root.querySelector<HTMLSelectElement>('.kbn-ctl-meet-audio')!
  const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
  audio.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
  v.dock.reset()
})
