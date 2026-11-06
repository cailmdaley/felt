// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { Voice, VoiceRequestError, type VoiceHeld, type VoiceStatus } from '../voice.js'
import { HeldVoiceComposer } from './heldVoiceComposer.js'

const target = card({ id: 'task', uid: 'uid', originId: 'owner' })
const held = (patch: Partial<VoiceHeld> = {}): VoiceHeld => ({ id: 'held-1', fiber_id: 'uid', origin: 'owner', through: 1, text: 'me: first words', ...patch })
const status = (rows: VoiceHeld[], patch: Partial<VoiceStatus> = {}): VoiceStatus => ({ available: true, enabled: true, muted: false, state: 'listening', target: { fiber_id: 'uid', origin: 'owner', name: 'Task' }, pending: null, last: null, error: null, cold: true, held: rows, ...patch })
let voice: Voice, field: HTMLTextAreaElement, composer: HeldVoiceComposer
const failed = vi.fn()
const notify = (): void => (voice as unknown as { notify(): void }).notify()
const paint = (rows: VoiceHeld[], patch: Partial<VoiceStatus> = {}): void => { voice.status = status(rows, patch); notify() }
const mount = (text = ''): void => {
  field = document.createElement('textarea'); field.value = text; document.body.append(field)
  field.addEventListener('input', () => localStorage.setItem('draft', field.value))
  composer = new HeldVoiceComposer(field, voice, target, 'draft', () => localStorage.setItem('draft', field.value), failed)
}
const input = (text: string): void => { field.value = text; field.dispatchEvent(new Event('input')) }
beforeEach(() => {
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value), removeItem: (key: string) => void stored.delete(key) })
  failed.mockClear()
  voice = new Voice('')
  vi.spyOn(voice, 'editHeld').mockResolvedValue()
  vi.spyOn(voice, 'releaseHeld').mockResolvedValue()
})
afterEach(() => { composer?.dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('held speech in the ordinary composer', () => {
  it('appends speech beside typed text without moving a selection, and retains typed suffixes on name delivery', () => {
    mount('typed before')
    field.focus(); field.setSelectionRange(2, 6, 'backward')
    paint([held()])
    expect(field.value).toBe('typed before\n\nme: first words')
    expect([field.selectionStart, field.selectionEnd, field.selectionDirection]).toEqual([2, 6, 'backward'])
    input(field.value + '\ntyped after')
    expect(voice.editHeld).not.toHaveBeenCalled()
    field.setSelectionRange(3, 3)
    paint([held({ through: 2, text: 'me: first words more speech' })])
    expect(field.value).toBe('typed before\n\nme: first words more speech\ntyped after')
    expect(field.selectionStart).toBe(3)
    paint([])
    expect(field.value).toBe('typed before\ntyped after')
  })

  it('keeps edits authoritative while speech grows and sends only the held part to the draft endpoint', () => {
    paint([held()]); mount('typed before')
    input(field.value.replace('first words', 'edited words'))
    expect(voice.editHeld).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'held-1', through: 1 }), 'me: edited words')
    // A poll can include the new line before the edit acknowledgement.
    paint([held({ through: 2, text: 'me: first words and more' })])
    expect(field.value).toBe('typed before\n\nme: edited words and more')
    input('a prefix\n' + field.value)
    paint([])
    expect(field.value).toBe('a prefix\ntyped before')
  })

  it('recognizes an edited prefix echoed with later speech, without inserting it twice', () => {
    paint([held()]); mount()
    input('me: correction')
    paint([held({ through: 2, text: 'me: correction new words' })])
    expect(field.value).toBe('me: correction new words')
    expect(field.selectionStart).toBe('me: correction'.length)
  })

  it('retains held ownership after deleting all speech, so deleted words cannot return', () => {
    paint([held()]); mount()
    input('')
    expect(voice.editHeld).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'held-1', through: 1 }), '')
    paint([held({ text: '' })])
    expect(composer.begin().held).toEqual({ id: 'held-1', through: 1 })
    composer.finish()
    paint([held({ through: 2, text: ' more' })])
    expect(field.value).toBe(' more')
  })

  it('survives a mute, target switch, failed poll, and composer rebuild without duplicate text', () => {
    paint([held()]); mount('typed')
    input(field.value.replace('first', 'edited'))
    paint([held()], { enabled: false, muted: true, target: { fiber_id: 'elsewhere', origin: 'remote', name: 'Elsewhere' } })
    expect(field.value).toBe('typed\n\nme: edited words')
    voice.status = null; notify()
    expect(field.value).toBe('typed\n\nme: edited words')
    composer.dispose(); field.remove()
    mount(localStorage.getItem('draft')!)
    paint([held({ through: 2, text: 'me: edited words more' })])
    expect(field.value).toBe('typed\n\nme: edited words more')
    paint([])
    expect(field.value).toBe('typed')
  })

  it('does not attach a different host\'s held words to the same fiber identifier', () => {
    paint([held({ origin: 'remote' })]); mount('typed')
    expect(field.value).toBe('typed')
  })

  it('releases exactly the composed checkpoint and preserves new speech received during a send', async () => {
    paint([held()]); mount('typed')
    const composed = composer.begin()
    paint([held({ through: 2, text: 'me: first words newer words' })])
    expect(field.value).toBe(composed.text)
    vi.mocked(voice.releaseHeld).mockImplementation(async () => { paint([held({ through: 2, text: 'me: newer words' })]) })
    await composer.release(composed)
    composer.finish()
    expect(voice.releaseHeld).toHaveBeenCalledWith({ id: 'held-1', through: 1 })
    expect(field.value).toBe('typed\n\nme: first words\n\nme: newer words')
    composer.sent(composed.text)
    expect(field.value).toBe('me: newer words')
    paint([])
    expect(field.value).toBe('')
  })

  it('rebinds only the remaining suffix when a name consumes the prefix before the next poll', () => {
    paint([held()]); mount('typed')
    paint([held({ through: 2, text: 'me: more after the name' })])
    expect(field.value).toBe('typed\n\nme: more after the name')
    paint([])
    expect(field.value).toBe('typed')
  })

  it('keeps the user\'s draft after an ordinary release failure', async () => {
    paint([held()]); mount('typed')
    const composed = composer.begin()
    vi.mocked(voice.releaseHeld).mockRejectedValue(new VoiceRequestError(503))
    await expect(composer.release(composed)).rejects.toThrow('503')
    composer.finish()
    expect(field.value).toBe('typed\n\nme: first words')
    expect(composer.begin().held).toEqual({ id: 'held-1', through: 1 })
  })

  it('removes just the voice text on a name/button claim conflict, even if the refresh fails', async () => {
    paint([held()]); mount('typed')
    const composed = composer.begin()
    vi.mocked(voice.releaseHeld).mockRejectedValue(new VoiceRequestError(409))
    await expect(composer.release(composed)).rejects.toThrow('already been sent')
    composer.finish()
    expect(field.value).toBe('typed')
    expect(composer.begin().held).toBeNull()
  })
})
