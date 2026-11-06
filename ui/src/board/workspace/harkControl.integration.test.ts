// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Dock } from './Dock.js'
import { card } from '../testFixtures.js'
import { Voice, type VoiceStatus } from '../voice.js'

const status: VoiceStatus = { available: true, enabled: false, muted: false, state: 'off', target: { fiber_id: 'a', origin: 'local', name: 'Alpha' }, pending: null, last: null, error: null }
const notify = (voice: Voice): void => (voice as unknown as { notify: () => void }).notify()
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ text: '{}', digest: null })))
})
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function mount() {
  const voice = new Voice(''); voice.status = { ...status }
  let recording: { state: 'starting' | 'loading' | 'live' | 'stopping'; title: string; fiber: string; tail: never[]; paused?: boolean; phone?: boolean; recorder?: string; handoff?: { status: string; kind: null; target: null; origin: null; prompt: null } } | null = null
  const meeting = { current: () => recording, canJoin: () => !recording, modes: () => ['call', 'phone'], join: vi.fn(), stop: vi.fn(), pause: vi.fn(async () => {}) }
  const open = vi.fn()
  const dock = new Dock('', vi.fn(), undefined, undefined, { meeting: meeting as never, voice: { controller: voice } })
  const band = dock.bandFor(card({ id: 'a', name: 'Alpha', uid: 'a', originId: 'local', shuttleKind: 'oneshot', shuttleAgent: 'codex-sol', shuttleHost: 'local' }))
  band.openFile = open
  document.body.append(band.el)
  const root = band.el
  const main = () => root.querySelector<HTMLButtonElement>('.kbn-ctl-meet-arm')!
  const dropdown = () => root.querySelector<HTMLButtonElement>('.kbn-ctl-meet-dropdown')!
  const menuItems = () => [...root.querySelectorAll<HTMLButtonElement>('[role=menuitem]')]
  const follow = () => root.querySelector<HTMLButtonElement>('[role=menuitemcheckbox]')!
  return { voice, meeting, dock, root, main, dropdown, menuItems, follow, open, setRecording(value: typeof recording) { recording = value; dock.syncMeeting() } }
}

it('keeps one control and shows audio only when not following', () => {
  const v = mount()
  const check = (label: string) => {
    expect(v.root.querySelectorAll('.kbn-ctl-meet')).toHaveLength(1)
    expect(v.root.querySelector('.voice-chip, .kbn-ctl-meet-chip')).toBeNull()
    expect(v.main().textContent).toBe(label)
  }
  check('Listen')
  v.dropdown().click()
  expect(v.follow().textContent).toBe('Follow me')
  expect(v.follow().getAttribute('aria-checked')).toBe('false')
  expect(v.root.querySelector('[aria-label="Listening audio"]')).not.toBeNull()
  expect(v.root.querySelector('[aria-label="Aqua seconds"]')).toBeNull()
  v.dropdown().click()
  v.voice.status = { ...status, enabled: true, state: 'listening', pending: { fiber_id: 'a', words: 2, text: 'hello there' } }; notify(v.voice)
  check('Listening · Alpha')
  expect(v.root.querySelector('.voice-pending')!.textContent).toBe('hello there')
  v.dropdown().click()
  expect(v.follow().getAttribute('aria-checked')).toBe('true')
  expect(v.root.querySelector('[aria-label="Listening audio"]')).toBeNull()
  expect(v.menuItems().map(x => x.textContent)).toEqual(['Open transcript', 'Pause', 'Stop'])
  expect(v.root.querySelector('[aria-label="Aqua seconds"]')).not.toBeNull()
  v.dropdown().click()
  v.voice.status = { ...v.voice.status, muted: true }; notify(v.voice); check('Paused · Alpha')
  v.setRecording({ state: 'live', title: 'Standup', fiber: 'other', tail: [] }); check('Listening · other')
  v.dropdown().click()
  expect(v.menuItems().map(x => x.textContent)).toEqual(['Open transcript', 'Pause', 'Stop', 'Listen here'])
  expect(v.root.querySelector('[aria-label="Aqua seconds"]')).toBeNull()
  expect(v.root.querySelector('[aria-label="Listening audio"]')).toBeNull()
  v.menuItems().find(x => x.textContent === 'Pause')!.click()
  expect(v.meeting.pause).toHaveBeenCalledWith(expect.objectContaining({ fiber: 'other' }), true)
  v.setRecording({ state: 'live', title: 'Standup', fiber: 'other', tail: [], paused: true }); check('Paused · other')
  v.dock.reset()
})

it('never renders unconfirmed delivery and shows a definite failure', async () => {
  const v = mount()
  v.voice.status = { ...status, enabled: true, state: 'listening', last: { fiber_id: 'a', at: '2026-11-06T10:00:00Z', status: 'unconfirmed', detail: 'May have arrived' } }; notify(v.voice)
  vi.spyOn(v.voice, 'set').mockRejectedValue(new Error('Recorder unavailable'))
  v.dropdown().click()
  expect(v.root.textContent).not.toContain('unconfirmed')
  expect(v.root.textContent).not.toContain('May have arrived')
  v.menuItems().find(x => x.textContent === 'Pause')!.click()
  await Promise.resolve(); await Promise.resolve()
  expect(v.main().textContent).toBe('Failed')
  v.dropdown().click(); expect(v.root.textContent).toContain('Recorder unavailable')
  v.dock.reset()
})

it('shows a failed fixed Pause immediately and closes a stale menu on state changes', async () => {
  const v = mount()
  const recording = { state: 'live' as const, title: 'Standup', fiber: 'other', tail: [] as never[] }
  v.setRecording(recording)
  v.meeting.pause.mockRejectedValueOnce(new Error('Cannot pause'))
  v.dropdown().click()
  v.menuItems().find(x => x.textContent === 'Pause')!.click()
  await vi.waitFor(() => expect(v.main().textContent).toBe('Failed'))
  v.dropdown().click()
  expect(v.root.textContent).toContain('Cannot pause')
  v.setRecording({ ...recording, paused: true })
  expect(v.root.querySelector('[role=menu]')).toBeNull()
  v.dropdown().click()
  v.voice.status = { ...status, enabled: true, state: 'yielded' }; notify(v.voice)
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

it('disables pause until fixed listening is live', () => {
  const v = mount()
  v.setRecording({ state: 'loading', title: 'Standup', fiber: 'a', tail: [] })
  v.dropdown().click()
  expect(v.menuItems().find(x => x.textContent === 'Pause')?.disabled).toBe(true)
  v.dock.reset()
})

it('omits pause for phone listening', () => {
  const v = mount()
  v.setRecording({ state: 'live', title: 'Call', fiber: 'a', tail: [], phone: true })
  v.dropdown().click()
  expect(v.menuItems().find(x => x.textContent === 'Pause')).toBeUndefined()
  v.dock.reset()
})

it('allows disabling following when the recorder is unavailable', () => {
  const v = mount()
  v.voice.status = { ...status, available: false, enabled: true }; notify(v.voice)
  const set = vi.spyOn(v.voice, 'set').mockResolvedValue()
  v.dropdown().click()
  expect(v.follow().disabled).toBe(false)
  v.follow().click()
  expect(set).toHaveBeenCalledWith({ enabled: false })
  v.dock.reset()
})

it('shows definite fixed delivery failures but hides ambiguous delivery', () => {
  const v = mount()
  const recording = { state: 'live' as const, title: 'Standup', fiber: 'a', tail: [] as never[], handoff: { status: 'reported-failure', kind: null, target: null, origin: null, prompt: null } }
  v.setRecording(recording)
  expect(v.main().textContent).toBe('Failed')
  v.dropdown().click()
  expect(v.root.textContent).toContain('Delivery failed')
  v.dropdown().click()
  v.setRecording({ ...recording, handoff: { ...recording.handoff, status: 'unconfirmed' } })
  expect(v.main().textContent).toBe('Listening · Alpha')
  v.dropdown().click()
  expect(v.root.textContent).not.toContain('unconfirmed')
  v.dock.reset()
})

it('keeps the menu open for Tab navigation through its inputs', async () => {
  const v = mount()
  v.dropdown().click()
  v.follow().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  expect(v.root.querySelector('[role=menu]')).not.toBeNull()
  await vi.waitFor(() => expect(v.root.querySelector<HTMLInputElement>('[aria-label="Quiet seconds"]')?.disabled).toBe(false))
  v.root.querySelector<HTMLInputElement>('[aria-label="Quiet seconds"]')!.focus()
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Quiet seconds')
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
  await vi.waitFor(() => expect(v.root.querySelector<HTMLInputElement>('[aria-label="Aqua seconds"]')?.disabled).toBe(false))
  expect(fetcher.mock.calls[0][0]).toBe('/api/v1/config/voice?origin=audio-host')
  const aqua = v.root.querySelector<HTMLInputElement>('[aria-label="Aqua seconds"]')!
  aqua.value = '7'; aqua.dispatchEvent(new Event('change', { bubbles: true }))
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

it('stops following by turning Follow me off', () => {
  const v = mount()
  v.voice.status = { ...status, enabled: true, state: 'listening' }; notify(v.voice)
  const set = vi.spyOn(v.voice, 'set').mockResolvedValue()
  v.dropdown().click(); v.menuItems().find(x => x.textContent === 'Stop')!.click()
  expect(set).toHaveBeenCalledWith({ enabled: false })
  v.dock.reset()
})

it('saves quiet seconds without replacing other settings', async () => {
  const v = mount()
  v.voice.status = { ...status, enabled: true, state: 'listening' }; notify(v.voice)
  const fetcher = vi.mocked(fetch)
  fetcher.mockClear()
  fetcher.mockResolvedValueOnce(Response.json({ text: JSON.stringify({ enabled: true, words: 42 }), digest: 'before' }))
  fetcher.mockResolvedValueOnce(Response.json({ digest: 'after' }))
  fetcher.mockResolvedValueOnce(Response.json({ digest: 'after-aqua' }))
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
  const aqua = v.root.querySelector<HTMLInputElement>('[aria-label="Aqua seconds"]')!
  await vi.waitFor(() => expect(aqua.disabled).toBe(false))
  expect(aqua.value).toBe('5')
  aqua.value = '3'
  aqua.dispatchEvent(new Event('change', { bubbles: true }))
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3))
  const aquaBody = JSON.parse(fetcher.mock.calls[2][1]!.body as string)
  expect(aquaBody.expected_digest).toBe('after')
  expect(JSON.parse(aquaBody.text)).toEqual({ enabled: true, words: 42, quiet_seconds: 7, run_quiet_seconds: 3 })
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

it('shows routed raw preview above the box without turning it into held or sent text', async () => {
  const v = mount()
  v.voice.status = { ...status, enabled: true, state: 'listening', held: [], pending: { fiber_id: 'a', words: 2, text: 'finalized words' }, preview: { fiber_id: 'a', origin: 'local', text: 'raw words still being revised' } }; notify(v.voice)
  expect(v.root.querySelector('.voice-pending')!.textContent).toBe('raw words still being revised')
  expect(v.root.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('')
  v.voice.status = { ...v.voice.status, preview: { fiber_id: 'a', origin: 'remote', text: 'another host' } }; notify(v.voice)
  expect(v.root.querySelector('.voice-pending')!.textContent).toBe('finalized words')
  v.voice.status = { ...v.voice.status, preview: null }; notify(v.voice)
  expect(v.root.querySelector('.voice-pending')!.textContent).toBe('finalized words')
  v.voice.status = { ...v.voice.status, preview: { fiber_id: 'a', origin: 'local', text: 'do not send this' } }; notify(v.voice)
  const release = vi.spyOn(v.voice, 'releaseHeld')
  v.root.querySelector<HTMLButtonElement>('.kbn-ctl-sends .kbn-ctl-send:not(.kbn-ctl-resume)')!.click()
  for (let i = 0; i < 40; i++) await Promise.resolve()
  expect(release).not.toHaveBeenCalled()
  const dispatch = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes('/dispatch'))
  expect(JSON.parse(String(dispatch?.[1]?.body)).user_message).toBe('')
  expect(v.root.querySelector('.voice-pending')!.textContent).toBe('do not send this')
  v.dock.reset()
})
