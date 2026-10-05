// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AudioPage } from './AudioPage.js'
import { loadWaveform } from './audioWaveform.js'
import type { WorkspaceDocument } from './documents.js'
import { resetDocumentResources } from '../documentResources.js'
import { resetLanes } from '../requestLanes.js'

vi.mock('./audioWaveform.js', async original => ({ ...await original<typeof import('./audioWaveform.js')>(), loadWaveform: vi.fn(async () => null) }))
const doc: WorkspaceDocument = { key: 'host-a:/song.wav', owner: 'host-a', path: '/song.wav', name: 'Song', kind: 'audio', provenance: [] }
let page: AudioPage
let context: { fillStyle: string; scale: ReturnType<typeof vi.fn>; fillRect: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; beginPath: ReturnType<typeof vi.fn>; rect: ReturnType<typeof vi.fn>; clip: ReturnType<typeof vi.fn>; restore: ReturnType<typeof vi.fn> }
beforeEach(() => {
  vi.clearAllMocks()
  context = { fillStyle: '', scale: vi.fn(), fillRect: vi.fn(), save: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), restore: vi.fn() }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  vi.stubGlobal('ResizeObserver', undefined)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => { page?.dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); resetDocumentResources(); resetLanes() })

it('publishes the cached peaks and duration for its frame poster without a second load', async () => {
  const peaks = [0.1, 0.8, 0.3]
  vi.mocked(loadWaveform).mockResolvedValueOnce({ peaks, duration: 61 })
  const root = document.createElement('section')
  const audio = document.createElement('audio')
  root.append(audio); document.body.append(root)
  Object.defineProperty(audio, 'duration', { value: 61 })
  const poster = vi.fn()
  page = new AudioPage(audio, doc, '', vi.fn(), poster)
  audio.dispatchEvent(new Event('loadedmetadata'))
  await Promise.resolve()
  expect(poster).toHaveBeenLastCalledWith(peaks, 61)
  root.dispatchEvent(new Event('workspace-theme-change', { bubbles: true }))
  expect(poster).toHaveBeenLastCalledWith(peaks, 61)
  expect(poster).toHaveBeenCalledTimes(3)
  expect(loadWaveform).toHaveBeenCalledTimes(1)
  page.dispose()
})

it('redraws retained paused canvas with computed played ink after its channel changes, not unrelated channels', async () => {
  const root = document.createElement('section'), other = document.createElement('section')
  const audio = document.createElement('audio'); root.append(audio); document.body.append(root, other)
  const load = vi.spyOn(audio, 'load').mockImplementation(() => {})
  page = new AudioPage(audio, doc, '', vi.fn())
  const canvas = page.el.querySelector<HTMLCanvasElement>('canvas')!
  Object.defineProperty(canvas, 'clientWidth', { value: 300 })
  Object.defineProperty(canvas, 'clientHeight', { value: 100 })
  Object.defineProperty(audio, 'duration', { value: 100 })
  audio.currentTime = 25
  canvas.style.color = 'rgb(10, 20, 30)'
  canvas.style.setProperty('--ws-ink', 'red')
  canvas.style.setProperty('--ws-ink-muted', 'gray')
  audio.dispatchEvent(new Event('loadedmetadata'))
  await Promise.resolve()
  expect(page.el.dataset.part).toBe('audio-page'); expect(canvas.dataset.part).toBe('audio-waveform')
  expect(context.fillStyle).toBe('rgb(10, 20, 30)')
  expect(audio.paused).toBe(true)
  const draws = context.fillRect.mock.calls.length
  canvas.style.color = 'rgb(240, 230, 220)'
  other.dispatchEvent(new Event('workspace-theme-change', { bubbles: true }))
  expect(context.fillRect).toHaveBeenCalledTimes(draws)
  root.dispatchEvent(new Event('workspace-theme-change', { bubbles: true }))
  expect(context.fillStyle).toBe('rgb(240, 230, 220)')
  expect(audio.currentTime).toBe(25); expect(audio.paused).toBe(true)
  expect(load).not.toHaveBeenCalled()
  const changedDraws = context.fillRect.mock.calls.length
  page.dispose()
  root.dispatchEvent(new Event('workspace-theme-change', { bubbles: true }))
  expect(context.fillRect).toHaveBeenCalledTimes(changedDraws)
})

it('times a channel of songs from the peeks that name them, two at a time and with no media elements', async () => {
  const songs: WorkspaceDocument[] = Array.from({ length: 13 }, (_, i) => ({ ...doc, key: `host-a:/song-${i}.wav`, path: `/song-${i}.wav`, name: `song-${i}.wav` }))
  // A WAV head: 1000 bytes a second over a 75 000-byte data chunk.
  const wav = new Uint8Array(44)
  const view = new DataView(wav.buffer)
  wav.set([...'RIFF'].map(c => c.charCodeAt(0)), 0); wav.set([...'WAVE'].map(c => c.charCodeAt(0)), 8)
  wav.set([...'fmt '].map(c => c.charCodeAt(0)), 12); view.setUint32(16, 16, true); view.setUint32(28, 1000, true)
  wav.set([...'data'].map(c => c.charCodeAt(0)), 36); view.setUint32(40, 75_000, true)
  let active = 0, most = 0
  const fetcher = vi.fn(async (_src: string) => {
    most = Math.max(most, ++active)
    await new Promise(resolve => setTimeout(resolve, 0))
    active--
    return new Response(wav, { status: 206, headers: { ETag: 'W/"song"', 'Content-Range': 'bytes 0-43/75044' } })
  })
  vi.stubGlobal('fetch', fetcher)
  const create = vi.spyOn(document, 'createElement')
  // The selected page and its two receded neighbours, as the reader mounts them.
  const pages = songs.slice(0, 3).map(song => {
    const root = document.createElement('section'), audio = document.createElement('audio')
    root.append(audio); document.body.append(root)
    const listening = new AudioPage(audio, song, '', vi.fn())
    listening.updateDocuments(songs)
    return listening
  })
  await vi.waitFor(() => {
    for (const listening of pages) expect([...listening.el.querySelectorAll('.ws-audio-duration')].map(span => span.textContent)).toEqual(Array(12).fill('1:15'))
  })
  expect(fetcher).toHaveBeenCalledTimes(songs.length)
  expect(most).toBeLessThanOrEqual(2)
  expect(create.mock.calls.filter(([tag]) => tag === 'audio')).toHaveLength(pages.length)
  for (const listening of pages) listening.dispose()
})

it('decodes its recording only once it is selected', async () => {
  const audio = document.createElement('audio')
  document.body.append(audio)
  page = new AudioPage(audio, doc, '', vi.fn())
  expect(vi.mocked(loadWaveform).mock.calls.at(-1)?.[3]).toBe(false)
  const calls = vi.mocked(loadWaveform).mock.calls.length
  page.setSelected(false)
  expect(loadWaveform).toHaveBeenCalledTimes(calls)
  page.setSelected(true)
  expect(vi.mocked(loadWaveform).mock.calls.at(-1)?.[3]).toBe(true)
  page.setSelected(true)
  expect(loadWaveform).toHaveBeenCalledTimes(calls + 1)
})
