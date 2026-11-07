// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readVoiceTranscript, TranscriptPanel, transcriptLine, type VoiceTranscriptRow } from './voiceTranscript'

const row: VoiceTranscriptRow = { t: '2026-11-07T18:30:04-08:00', speaker: 'me', text: 'A thought <not markup>', fiber_id: 'uid', origin: 'owner', name: 'A card', launch: 'voice-L1' }
const slug = (id: string) => id === 'uid' ? 'a-card' : undefined
const fetcher = vi.fn()
let panel: TranscriptPanel | undefined
beforeEach(() => {
  vi.stubGlobal('fetch', fetcher)
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')) } })
  fetcher.mockImplementation(async () => Response.json({ date: '2026-11-07', rows: [row, { ...row, fiber_id: null, origin: null, name: null, text: 'Unrouted speech' }], recorder: 'audio-host' }))
})
afterEach(() => { panel?.dispose(); panel = undefined; document.body.replaceChildren(); Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); Reflect.deleteProperty(HTMLDialogElement.prototype, 'close'); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals() })
it('reads the day from the recorder rather than the worker owner, with an optional fiber filter', async () => {
  await readVoiceTranscript('https://hub.invalid', 'audio-host', 'work/card')
  expect(fetcher).toHaveBeenCalledWith('https://hub.invalid/api/v1/voice/transcript?recorder=audio-host&fiber=work%2Fcard', { cache: 'no-store' })
  await readVoiceTranscript('')
  expect(fetcher).toHaveBeenLastCalledWith('/api/v1/voice/transcript', { cache: 'no-store' })
})
it('renders time, speaker, slug and text, including speech with no route', () => {
  expect(transcriptLine(row, slug)).toBe('18:30:04 me → a-card: A thought <not markup>')
  expect(transcriptLine({ ...row, fiber_id: null }, slug)).toContain('me → —:')
  expect(transcriptLine({ ...row, fiber_id: 'outside/card' }, slug)).toContain('me → card:')
})
it('opens a readable day panel, filters only when asked, and treats speech as text', async () => {
  const opener = document.createElement('button'); document.body.append(opener)
  panel = new TranscriptPanel('', 'audio-host', 'uid', slug, opener)
  await vi.waitFor(() => expect(panel!.el.querySelectorAll('[role=log] p')).toHaveLength(2))
  expect(panel.el.querySelector('not')).toBeNull()
  expect(panel.el.textContent).toContain('A thought <not markup>')
  const filter = panel.el.querySelector<HTMLInputElement>('input')!
  fetcher.mockResolvedValueOnce(Response.json({ date: '2026-11-07', rows: [row], recorder: 'audio-host' }))
  filter.checked = true; filter.dispatchEvent(new Event('change'))
  await vi.waitFor(() => expect(panel!.el.querySelectorAll('[role=log] p')).toHaveLength(1))
  expect(fetcher).toHaveBeenLastCalledWith('/api/v1/voice/transcript?recorder=audio-host&fiber=uid', { cache: 'no-store' })
  panel.el.dispatchEvent(new Event('cancel', { cancelable: true }))
  expect(document.querySelector('dialog')).toBeNull()
  expect(document.activeElement).toBe(opener)
})
it('shows an empty day and a failed read without consulting /file', async () => {
  const opener = document.createElement('button'); document.body.append(opener)
  fetcher.mockResolvedValueOnce(Response.json({ date: '2026-11-07', rows: [], recorder: 'audio-host' }))
  panel = new TranscriptPanel('', 'audio-host', 'uid', slug, opener)
  await vi.waitFor(() => expect(panel!.el.textContent).toContain('No speech recorded.'))
  fetcher.mockResolvedValueOnce(Response.json({ error: 'Recorder unreachable' }, { status: 502 }))
  panel.el.querySelector('input')!.dispatchEvent(new Event('change'))
  await vi.waitFor(() => expect(panel!.el.textContent).toContain('Recorder unreachable'))
  expect(fetcher.mock.calls.every(([url]) => url.includes('/voice/transcript'))).toBe(true)
})
