import './mediaPoster.css'

export interface MediaPoster {
  el: HTMLElement
  setAudio(peaks: number[] | null, duration: number | null): void
  captureVideo(video: HTMLVideoElement): boolean
}

/** A still surface for media pages whenever their live controls are receded. */
export function createMediaPoster(kind: 'audio' | 'video'): MediaPoster {
  const el = document.createElement('div')
  el.className = `ws-media-poster ws-media-poster-${kind}`
  el.setAttribute('aria-hidden', 'true')

  const canvas = document.createElement('canvas')
  canvas.className = 'ws-media-poster-canvas'
  canvas.setAttribute('aria-hidden', 'true')
  const fallback = document.createElement('div')
  fallback.className = 'ws-media-poster-fallback'
  const glyph = document.createElement('span')
  glyph.className = 'ws-media-poster-glyph'
  glyph.textContent = kind === 'audio' ? '♪' : '▹'
  fallback.append(glyph)
  let durationLabel: HTMLElement | null = null
  if (kind === 'audio') {
    durationLabel = document.createElement('span')
    durationLabel.className = 'ws-media-poster-duration'
    fallback.append(durationLabel)
  }
  el.append(canvas, fallback)

  return {
    el,
    setAudio(peaks, duration) {
      if (kind !== 'audio') return
      if (durationLabel) {
        durationLabel.textContent = Number.isFinite(duration) && duration! > 0 ? formatDuration(duration!) : ''
        durationLabel.hidden = !durationLabel.textContent
      }
      if (!peaks?.length || !drawPeaks(canvas, peaks)) el.classList.remove('ws-media-poster-ready')
      else el.classList.add('ws-media-poster-ready')
    },
    captureVideo(video) {
      if (kind !== 'video' || !video.videoWidth || !video.videoHeight || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false
      const scale = Math.min(1, 1600 / video.videoWidth, 1000 / video.videoHeight)
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
      const context = canvas.getContext('2d')
      if (!context) return false
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        el.classList.add('ws-media-poster-ready')
        return true
      } catch {
        el.classList.remove('ws-media-poster-ready')
        return false
      }
    },
  }
}

function drawPeaks(canvas: HTMLCanvasElement, peaks: number[]): boolean {
  const width = 1000, height = 180
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return false
  context.clearRect(0, 0, width, height)
  context.fillStyle = getComputedStyle(canvas).color || '#928675'
  const bins = Math.min(peaks.length, Math.floor(width / 3))
  for (let i = 0; i < bins; i++) {
    const start = Math.floor(i * peaks.length / bins)
    const end = Math.ceil((i + 1) * peaks.length / bins)
    let peak = 0
    for (let j = start; j < end; j++) peak = Math.max(peak, peaks[j])
    const barHeight = Math.max(2, peak * (height - 24))
    const step = width / bins
    context.fillRect(i * step, (height - barHeight) / 2, Math.max(1, step * .7), barHeight)
  }
  return true
}

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
