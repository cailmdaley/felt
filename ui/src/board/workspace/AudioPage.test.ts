// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AudioPage } from './AudioPage.js'
import { loadWaveform } from './audioWaveform.js'
import type { WorkspaceDocument } from './documents.js'

vi.mock('./audioWaveform.js', () => ({ loadWaveform: vi.fn(async () => null) }))
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
afterEach(() => { page?.dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

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
