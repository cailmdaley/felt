const MAX_BYTES = 60 * 1024 * 1024
const BINS = 1000
/** Samples per second the waveform is decoded at: enough for 1000 peaks, a fifth of a CD's memory. */
const DECODE_RATE = 8000
const CACHE_PREFIX = 'shuttle:audio:peaks:'
export interface Waveform { peaks: number[]; duration: number }
const cache = new Map<string, Promise<Waveform | null>>()
const durations = new Map<string, number>()
const reads = new Map<string, Promise<number | null>>()

/**
 * Listening pages read in the background through two shared slots, newest
 * request first. Over HTTP/1.1 a browser holds six connections per host, and
 * a channel of songs (whole-file waveform reads, a duration for every sibling
 * on every mounted page) would otherwise hold them all while Play waits.
 */
const READ_SLOTS = 2
const waiting: Array<() => void> = []
let reading = 0
function nextRead(): void { while (reading < READ_SLOTS && waiting.length) waiting.pop()!() }
function queuedRead<T>(signal: AbortSignal, read: () => Promise<T>, skipped: T): Promise<T> {
  return new Promise<T>(resolve => {
    if (signal.aborted) { resolve(skipped); return }
    const start = (): void => {
      signal.removeEventListener('abort', skip)
      reading++
      void read().catch(() => skipped).then(resolve).finally(() => { reading--; nextRead() })
    }
    const skip = (): void => {
      const index = waiting.indexOf(start)
      if (index >= 0) { waiting.splice(index, 1); resolve(skipped) }
    }
    signal.addEventListener('abort', skip, { once: true })
    waiting.push(start)
    nextRead()
  })
}

/** A sibling's duration from one transient metadata read; `revision` names the bytes it describes. */
export function loadDuration(src: string, revision: string, signal: AbortSignal): Promise<number | null> {
  const identity = JSON.stringify([src, revision])
  const known = durations.get(identity)
  if (known !== undefined) return Promise.resolve(known)
  return queuedRead(signal, () => {
    const saved = durations.get(identity)
    if (saved !== undefined) return Promise.resolve(saved)
    let read = reads.get(identity)
    if (!read) {
      read = readDuration(src).then(duration => {
        reads.delete(identity)
        if (duration !== null) durations.set(identity, duration)
        return duration
      })
      reads.set(identity, read)
    }
    return read
  }, null)
}

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

async function boundedBytes(response: Response): Promise<ArrayBuffer> {
  if (Number(response.headers.get('Content-Length')) > MAX_BYTES) throw new Error('Audio too large to decode')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Audio stream unavailable')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw new Error('Audio too large to decode')
      chunks.push(value)
    }
  } finally { await reader.cancel(); reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes.buffer
}

/**
 * Decode once per identity and revision, and only when asked: without
 * `decode`, only a waveform already decoded this session is returned.
 * Playback keeps its native range URL.
 */
export function loadWaveform(key: string, src: string, signal: AbortSignal, decode = true): Promise<Waveform | null> {
  return queuedRead(signal, () => readWaveform(key, src, signal, decode), null)
}

async function readWaveform(key: string, src: string, signal: AbortSignal, decode: boolean): Promise<Waveform | null> {
  try {
    const head = await fetch(src, { method: 'HEAD', signal })
    if (!head.ok || Number(head.headers.get('Content-Length')) > MAX_BYTES) return null
    const etag = head.headers.get('ETag')
    // Without a revision token a retained page can cache, but a fresh mount must re-read.
    const identity = JSON.stringify([key, etag])
    if (etag && cache.has(identity)) return cache.get(identity)!
    if (etag) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(CACHE_PREFIX + identity) ?? 'null') as Waveform | null
        if (saved && Number.isFinite(saved.duration) && saved.duration > 0 && Array.isArray(saved.peaks) && saved.peaks.length <= BINS && saved.peaks.every(p => Number.isFinite(p) && p >= 0 && p <= 1)) {
          const result = Promise.resolve(saved)
          cache.set(identity, result)
          return saved
        }
      } catch { /* Storage is optional. */ }
    }
    if (!decode || typeof OfflineAudioContext === 'undefined') return null
    const read = (async (): Promise<Waveform | null> => {
      try {
        const response = await fetch(src, { signal })
        if (!response.ok) return null
        const bytes = await boundedBytes(response)
        // An offline context decodes without opening an audio device session;
        // a low rate keeps a long recording's decoded samples small.
        const buffer = await new OfflineAudioContext(1, 1, DECODE_RATE).decodeAudioData(bytes)
        if (signal.aborted) return null
        const result = { duration: buffer.duration, peaks: audioPeaks(Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))) }
        if (etag) try {
          const storageKey = CACHE_PREFIX + identity
          const keys = Object.keys(sessionStorage).filter(k => k.startsWith(CACHE_PREFIX))
          while (keys.length >= 20) sessionStorage.removeItem(keys.shift()!)
          sessionStorage.setItem(storageKey, JSON.stringify(result))
        } catch { /* Quota or storage denial does not interrupt listening. */ }
        return result
      } catch { return null }
    })()
    if (etag) {
      cache.set(identity, read)
      while (cache.size > 40) cache.delete(cache.keys().next().value!)
      void read.then(result => { if (!result && cache.get(identity) === read) cache.delete(identity) })
    }
    return read
  } catch { return null }
}
