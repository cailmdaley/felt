import type { DocKey } from './documents.js'

/** What is already known of a recording without decoding it again: its peaks and its length. */
export interface AudioSketch { peaks: number[] | null; duration: number | null }

const PEAKS_PREFIX = 'shuttle:audio:peaks:'
const known = new Map<DocKey, AudioSketch>()
const listeners = new Set<(key: DocKey) => void>()

/** Record what a listening page learned, for every map tile that shows the recording. */
export function noteAudioSketch(key: DocKey, peaks: number[] | null, duration: number | null): void {
  const prior = known.get(key)
  const next = { peaks: peaks?.length ? peaks : prior?.peaks ?? null, duration: duration && duration > 0 ? duration : prior?.duration ?? null }
  if (prior && prior.peaks === next.peaks && prior.duration === next.duration) return
  known.set(key, next)
  for (const listener of listeners) listener(key)
}

/** The sketch heard this session, else any peaks this tab decoded before, whatever their revision. */
export function audioSketch(key: DocKey): AudioSketch | null {
  const sketch = known.get(key)
  if (sketch) return sketch
  try {
    const prefix = PEAKS_PREFIX + JSON.stringify([key]).slice(0, -1) + ','
    for (let i = 0; i < sessionStorage.length; i++) {
      const name = sessionStorage.key(i)
      if (!name?.startsWith(prefix)) continue
      const saved = JSON.parse(sessionStorage.getItem(name) ?? 'null') as { peaks?: unknown; duration?: unknown } | null
      if (!saved || !Array.isArray(saved.peaks) || !saved.peaks.every(p => typeof p === 'number' && p >= 0 && p <= 1)) continue
      const found = { peaks: saved.peaks as number[], duration: typeof saved.duration === 'number' && saved.duration > 0 ? saved.duration : null }
      known.set(key, found)
      return found
    }
  } catch { /* Storage is optional. */ }
  return null
}

export function watchAudioSketches(listener: (key: DocKey) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** A few bars, each the loudest of its stretch: enough to tell two recordings apart at a glance. */
export function sketchBars(peaks: readonly number[], bars: number): number[] {
  if (!peaks.length || bars <= 0) return []
  const count = Math.min(bars, peaks.length)
  return Array.from({ length: count }, (_, i) => {
    const start = Math.floor(i * peaks.length / count), end = Math.max(start + 1, Math.floor((i + 1) * peaks.length / count))
    let peak = 0
    for (let j = start; j < end; j++) peak = Math.max(peak, peaks[j])
    return peak
  })
}

export function sketchDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
