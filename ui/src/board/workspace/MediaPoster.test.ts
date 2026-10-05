// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createMediaPoster } from './MediaPoster.js'

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

it('shows an audio glyph and duration until it can paint the shared peaks across the poster', () => {
  const context = { fillStyle: '', clearRect: vi.fn(), fillRect: vi.fn() }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  const poster = createMediaPoster('audio')
  expect(poster.el.textContent).toContain('♪')
  poster.setAudio(null, 61)
  expect(poster.el.textContent).toContain('1:01')
  poster.setAudio([0.1, 0.8, 0.3], 61)
  expect(poster.el.classList.contains('ws-media-poster-ready')).toBe(true)
  expect(poster.el.querySelector('canvas')?.width).toBe(1000)
  expect(context.fillRect).toHaveBeenCalled()
  poster.setAudio(null, 61)
  expect(poster.el.classList.contains('ws-media-poster-ready')).toBe(false)
  expect(poster.el.textContent).toContain('1:01')
})

it('uses a loaded video frame and keeps the play glyph as its fallback', () => {
  const context = { drawImage: vi.fn() }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  const poster = createMediaPoster('video')
  expect(poster.el.textContent).toContain('▹')
  const video = document.createElement('video')
  Object.defineProperties(video, {
    videoWidth: { value: 640 }, videoHeight: { value: 360 },
    readyState: { value: HTMLMediaElement.HAVE_CURRENT_DATA },
  })
  expect(poster.captureVideo(video)).toBe(true)
  expect(poster.el.classList.contains('ws-media-poster-ready')).toBe(true)
  expect(context.drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 360)
})
