import type { DocKey, WorkspaceDocument } from './documents.js'
import { fileBytesUrl } from '../utils.js'
import { loadWaveform } from './audioWaveform.js'
import './audio.css'

const KEEP_POSITION = 'shuttle:audio:keep-position'
export function keepAudioPosition(): boolean {
  try { return localStorage.getItem(KEEP_POSITION) === 'true' } catch { return false }
}
export function mediaTime(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
export function seekAudio(audio: HTMLMediaElement, seconds: number): void {
  if (Number.isFinite(audio.duration)) audio.currentTime = Math.max(0, Math.min(audio.duration, seconds))
}
export function toggleAudio(audio: HTMLMediaElement): void {
  if (audio.paused) void audio.play().catch(() => {})
  else audio.pause()
}

/** Listening controls decorate, but never replace, the owner-routed native player. */
export class AudioPage {
  readonly el = document.createElement('section')
  private readonly waveform = document.createElement('canvas')
  private readonly hover = document.createElement('output')
  private readonly clock = document.createElement('output')
  private readonly play: HTMLButtonElement
  private readonly compare = document.createElement('section')
  private readonly list = document.createElement('ul')
  private readonly controller = new AbortController()
  private readonly metadata = new Map<DocKey, HTMLAudioElement>()
  private readonly observer: ResizeObserver | null
  private peaks: number[] | null = null
  private waveformDuration: number | null = null
  private publishedPeaks: number[] | null = null
  private publishedDuration: number | null = null
  private signature = ''
  private animation = 0
  private cancelDrag: (() => void) | null = null
  private disposed = false

  private readonly audio: HTMLAudioElement
  private readonly doc: WorkspaceDocument
  private readonly base: string
  private readonly onSelect: (key: DocKey) => void
  private readonly onPoster?: (peaks: number[] | null, duration: number | null) => void

  constructor(audio: HTMLAudioElement, doc: WorkspaceDocument,
    base: string, onSelect: (key: DocKey) => void,
    onPoster?: (peaks: number[] | null, duration: number | null) => void) {
    this.audio = audio; this.doc = doc; this.base = base; this.onSelect = onSelect; this.onPoster = onPoster
    this.el.className = 'ws-audio-page'
    this.el.dataset.part = 'audio-page'
    this.el.setAttribute('aria-label', 'Audio listening controls')
    this.waveform.className = 'ws-audio-waveform'
    this.waveform.dataset.part = 'audio-waveform'
    this.waveform.tabIndex = 0
    this.waveform.setAttribute('role', 'slider')
    this.waveform.setAttribute('aria-label', 'Playback position')
    this.waveform.setAttribute('aria-valuemin', '0')
    this.hover.className = 'ws-audio-hover'
    this.hover.hidden = true
    const plot = document.createElement('div')
    plot.className = 'ws-audio-plot'
    plot.append(this.waveform, this.hover)
    const row = document.createElement('div')
    row.className = 'ws-audio-transport'
    this.play = this.button('Play', () => toggleAudio(audio))
    this.play.className = 'ws-audio-play'
    const back = this.button('−10 s', () => seekAudio(audio, audio.currentTime - 10), 'Back 10 seconds')
    const forward = this.button('+10 s', () => seekAudio(audio, audio.currentTime + 10), 'Forward 10 seconds')
    this.clock.className = 'ws-audio-clock'
    const rate = document.createElement('select')
    rate.setAttribute('aria-label', 'Playback rate')
    for (const value of [1, 1.25, 1.5, 0.75]) {
      const option = document.createElement('option')
      option.value = String(value); option.textContent = `${value}×`; rate.append(option)
    }
    rate.value = String(audio.playbackRate)
    rate.addEventListener('change', () => { audio.playbackRate = Number(rate.value) })
    row.append(this.play, back, forward, this.clock, rate)
    const heading = document.createElement('header')
    const title = document.createElement('h2'); title.textContent = 'Compare'
    const keep = document.createElement('label'); keep.className = 'ws-audio-keep'
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = keepAudioPosition()
    toggle.addEventListener('change', () => { try { localStorage.setItem(KEEP_POSITION, String(toggle.checked)) } catch { /* Storage is optional. */ } })
    keep.append(toggle, 'Keep position')
    heading.append(title, keep)
    this.compare.className = 'ws-audio-compare'; this.compare.append(heading, this.list)
    this.el.append(plot, row, this.compare)
    audio.hidden = true
    audio.controls = false
    audio.before(this.el)
    for (const event of ['timeupdate', 'loadedmetadata', 'durationchange', 'play', 'pause', 'ended', 'seeked']) audio.addEventListener(event, this.update)
    for (const event of ['loadedmetadata', 'durationchange']) audio.addEventListener(event, this.posterMetadata)
    this.waveform.addEventListener('pointerdown', this.pointerDown)
    this.waveform.addEventListener('pointermove', event => {
      const rect = this.waveform.getBoundingClientRect()
      const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
      this.hover.hidden = false
      this.hover.textContent = mediaTime(fraction * audio.duration)
      this.hover.style.left = `${fraction * 100}%`
    })
    this.waveform.addEventListener('pointerleave', () => { this.hover.hidden = true })
    this.waveform.addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation()
        seekAudio(audio, event.key === 'Home' ? 0 : event.key === 'End' ? audio.duration : audio.currentTime + (event.key === 'ArrowLeft' ? -5 : 5))
      }
    })
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(this.draw)
    this.observer?.observe(this.waveform)
    document.addEventListener('workspace-theme-change', this.themeChanged)
    this.update()
    void loadWaveform(doc.key, fileBytesUrl(base, doc.path, doc.owner), this.controller.signal).then(data => {
      if (this.disposed) return
      this.peaks = data?.peaks ?? null
      this.waveformDuration = data?.duration ?? null
      this.el.dataset.waveform = this.peaks ? 'decoded' : 'progress'
      this.draw()
      this.publishPoster()
    })
  }

  updateDocuments(documents: WorkspaceDocument[]): void {
    const others = documents.filter(d => d.kind === 'audio' && d.key !== this.doc.key)
    const signature = JSON.stringify(others.map(d => [d.key, d.provenance]))
    if (signature === this.signature) return
    this.signature = signature
    for (const media of this.metadata.values()) { media.removeAttribute('src'); media.load() }
    this.metadata.clear()
    this.list.replaceChildren()
    this.compare.hidden = others.length === 0
    for (const doc of others) {
      const item = document.createElement('li')
      const select = this.button('', () => this.onSelect(doc.key))
      const label = document.createElement('span')
      const embed = doc.provenance.find(p => p.kind === 'embed' && p.title)
      label.textContent = embed?.kind === 'embed' ? embed.title! : doc.name
      const duration = document.createElement('span'); duration.className = 'ws-audio-duration'; duration.textContent = '—'
      select.append(label, duration); item.append(select); this.list.append(item)
      const media = document.createElement('audio')
      media.preload = 'metadata'
      media.addEventListener('loadedmetadata', () => { duration.textContent = mediaTime(media.duration) }, { once: true })
      media.src = fileBytesUrl(this.base, doc.path, doc.owner)
      this.metadata.set(doc.key, media)
    }
  }

  dispose(): void {
    this.disposed = true
    this.cancelDrag?.()
    this.controller.abort(); this.observer?.disconnect(); cancelAnimationFrame(this.animation)
    document.removeEventListener('workspace-theme-change', this.themeChanged)
    for (const event of ['timeupdate', 'loadedmetadata', 'durationchange', 'play', 'pause', 'ended', 'seeked']) this.audio.removeEventListener(event, this.update)
    for (const event of ['loadedmetadata', 'durationchange']) this.audio.removeEventListener(event, this.posterMetadata)
    for (const media of this.metadata.values()) { media.removeAttribute('src'); media.load() }
    this.metadata.clear()
    this.el.remove()
  }

  private button(text: string, action: () => void, label = text): HTMLButtonElement {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = text
    if (label) button.setAttribute('aria-label', label)
    button.addEventListener('click', action)
    return button
  }
  private readonly update = (): void => {
    this.play.textContent = this.audio.paused ? 'Play' : 'Pause'
    this.play.setAttribute('aria-label', this.audio.paused ? 'Play' : 'Pause')
    this.clock.textContent = `${mediaTime(this.audio.currentTime)} / ${Number.isFinite(this.audio.duration) ? mediaTime(this.audio.duration) : '—'}`
    this.waveform.setAttribute('aria-valuemax', String(Number.isFinite(this.audio.duration) ? this.audio.duration : 0))
    this.waveform.setAttribute('aria-valuenow', String(this.audio.currentTime))
    this.waveform.setAttribute('aria-valuetext', this.clock.textContent)
    this.draw()
    cancelAnimationFrame(this.animation)
    if (!this.audio.paused && !this.disposed) this.animation = requestAnimationFrame(this.update)
  }
  private readonly posterMetadata = (): void => this.publishPoster()
  private publishPoster(force = false): void {
    const mediaDuration = Number.isFinite(this.audio.duration) && this.audio.duration > 0 ? this.audio.duration : null
    const duration = mediaDuration ?? this.waveformDuration
    if (!force && this.publishedPeaks === this.peaks && this.publishedDuration === duration) return
    this.publishedPeaks = this.peaks
    this.publishedDuration = duration
    this.onPoster?.(this.peaks, duration)
  }
  private readonly themeChanged = (event: Event): void => {
    if (event.target instanceof Element && event.target.contains(this.el)) {
      this.draw()
      this.publishPoster(true)
    }
  }
  private readonly draw = (): void => {
    const canvas = this.waveform, context = canvas.getContext('2d')
    if (!context) return
    const width = canvas.clientWidth, height = canvas.clientHeight, ratio = window.devicePixelRatio || 1
    if (!width || !height) return
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio)
    context.scale(ratio, ratio)
    const style = getComputedStyle(canvas)
    const played = Number.isFinite(this.audio.duration) && this.audio.duration > 0 ? this.audio.currentTime / this.audio.duration : 0
    const ink = style.color || '#30281e'
    const soft = style.getPropertyValue('--ws-ink-muted').trim() || '#928675'
    const paint = (color: string): void => {
      context.fillStyle = color
      if (!this.peaks?.length) { context.fillRect(0, height / 2 - 2, width, 4); return }
      const bins = Math.min(this.peaks.length, Math.floor(width / 3))
      for (let i = 0; i < bins; i++) {
        const start = Math.floor(i * this.peaks.length / bins), end = Math.ceil((i + 1) * this.peaks.length / bins)
        const peak = Math.max(...this.peaks.slice(start, end))
        const h = Math.max(2, peak * (height - 16))
        context.fillRect(i * width / bins, (height - h) / 2, Math.max(1, width / bins - 1), h)
      }
    }
    paint(soft)
    context.save(); context.beginPath(); context.rect(0, 0, width * played, height); context.clip(); paint(ink); context.restore()
    context.fillStyle = ink; context.fillRect(Math.min(width - 1, width * played), 4, 1, height - 8)
  }
  private readonly pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !Number.isFinite(this.audio.duration)) return
    event.preventDefault()
    const canvas = this.waveform, startX = event.clientX, before = this.audio.currentTime
    let latched = false
    canvas.setPointerCapture(event.pointerId)
    const seek = (x: number): void => {
      const rect = canvas.getBoundingClientRect()
      seekAudio(this.audio, (x - rect.left) / rect.width * this.audio.duration)
      this.update()
    }
    const move = (e: PointerEvent): void => {
      if (!latched && Math.abs(e.clientX - startX) < 4) return
      latched = true; seek(e.clientX)
    }
    const finish = (): void => {
      canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, true)
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      this.cancelDrag = null
    }
    const up = (e: PointerEvent): void => { seek(e.clientX); finish() }
    const cancel = (): void => { seekAudio(this.audio, before); finish(); this.update() }
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel() } }
    this.cancelDrag?.(); this.cancelDrag = cancel
    canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, true)
  }
}
