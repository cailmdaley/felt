import { bytes, fact, knownFact, peek, peekVersion, queued, RESOURCE_PRIORITY, type ResourcePriority } from '../documentResources.js'
import { durationFromHead } from './audioDuration.js'

const MAX_BYTES = 60 * 1024 * 1024
const BINS = 1000
/** Samples per second the waveform is decoded at: enough for 1000 peaks, a fifth of a CD's memory. */
const DECODE_RATE = 8000
const CACHE_PREFIX = 'shuttle:audio:peaks:'
export interface Waveform { peaks: number[]; duration: number }

/**
 * A recording's duration, from the peek that names it when its header says,
 * else from one metadata read. A listed duration need not revalidate, so any
 * peek already held will do, until the channel reports a new `revision` of
 * the file (its modification time or receipts); then the peek is read afresh.
 */
export async function loadDuration(src: string, signal: AbortSignal, options: { revision?: string; priority?: ResourcePriority } = {}): Promise<number | null> {
  const moved = options.revision !== undefined && revisions.has(src) && revisions.get(src) !== options.revision
  if (options.revision !== undefined) revisions.set(src, options.revision)
  while (revisions.size > 2000) revisions.delete(revisions.keys().next().value!)
  const head = await peek(src, options.priority ?? RESOURCE_PRIORITY.duration, moved ? { fresh: true, signal } : { stale: true, signal })
  if (!head || signal.aborted) return null
  return fact(src, 'duration', peekVersion(head), async () =>
    durationFromHead(head.bytes, head.size) ?? queued(RESOURCE_PRIORITY.duration, () => readDuration(src), signal))
}
/** The revision each recording's duration was last asked under. */
const revisions = new Map<string, string>()

/** A read that stalls gives up its slot rather than holding the queue. */
const DURATION_TIMEOUT_MS = 15000
const DURATION_ENDS = ['loadedmetadata', 'error', 'stalled'] as const

function readDuration(src: string): Promise<number | null> {
  return new Promise(resolve => {
    const media = document.createElement('audio')
    const finish = (): void => {
      clearTimeout(timer)
      const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : null
      for (const event of DURATION_ENDS) media.removeEventListener(event, finish)
      media.removeAttribute('src'); media.load()
      resolve(duration)
    }
    const timer = setTimeout(finish, DURATION_TIMEOUT_MS)
    media.preload = 'metadata'
    for (const event of DURATION_ENDS) media.addEventListener(event, finish)
    media.src = src
  })
}

/** Maximum amplitude across channels in each evenly sized time bucket. */
export function audioPeaks(channels: Float32Array[], bins = BINS): number[] {
  const length = channels[0]?.length ?? 0
  const peaks = Array.from({ length: Math.min(bins, length) }, () => 0)
  for (const samples of channels) for (let i = 0; i < samples.length; i++) {
    const bucket = Math.min(peaks.length - 1, Math.floor(i * peaks.length / length))
    peaks[bucket] = Math.max(peaks[bucket], Math.abs(samples[i]))
  }
  return peaks.map(peak => Math.round(Math.min(1, peak) * 1000) / 1000)
}

/**
 * Decode once per document and validator, and only when asked: without
 * `decode`, only a waveform already decoded (this session, or kept in session
 * storage) is returned. The selected page decodes in the foreground; playback
 * keeps its native range URL.
 */
export async function loadWaveform(key: string, src: string, signal: AbortSignal, decode = true): Promise<Waveform | null> {
  const head = await peek(src, decode ? RESOURCE_PRIORITY.selected : RESOURCE_PRIORITY.neighbour)
  if (!head || signal.aborted || (head.size ?? 0) > MAX_BYTES) return null
  const validator = peekVersion(head)
  const storageKey = CACHE_PREFIX + JSON.stringify([key, validator])
  const saved = savedWaveform(storageKey)
  if (saved) return fact(src, 'waveform', validator, async () => saved)
  if (!decode) return knownFact<Waveform>(src, 'waveform', validator) ?? null
  if (typeof OfflineAudioContext === 'undefined') return null
  return fact(src, 'waveform', validator, async () => {
    const data = await bytes(src, RESOURCE_PRIORITY.selected, { maxBytes: MAX_BYTES, signal })
    if (!data || signal.aborted) return null
    // An offline context decodes without opening an audio device session;
    // a low rate keeps a long recording's decoded samples small.
    const buffer = await new OfflineAudioContext(1, 1, DECODE_RATE).decodeAudioData(data)
    const result = { duration: buffer.duration, peaks: audioPeaks(Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))) }
    try {
      const keys = Object.keys(sessionStorage).filter(k => k.startsWith(CACHE_PREFIX))
      while (keys.length >= 20) sessionStorage.removeItem(keys.shift()!)
      sessionStorage.setItem(storageKey, JSON.stringify(result))
    } catch { /* Quota or storage denial does not interrupt listening. */ }
    return result
  })
}

function savedWaveform(storageKey: string): Waveform | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as Waveform | null
    if (saved && Number.isFinite(saved.duration) && saved.duration > 0 && Array.isArray(saved.peaks) && saved.peaks.length <= BINS && saved.peaks.every(p => Number.isFinite(p) && p >= 0 && p <= 1)) return saved
  } catch { /* Storage is optional. */ }
  return null
}
