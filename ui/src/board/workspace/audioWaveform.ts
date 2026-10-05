const MAX_BYTES = 60 * 1024 * 1024
const BINS = 1000
const CACHE_PREFIX = 'shuttle:audio:peaks:'
export interface Waveform { peaks: number[]; duration: number }
const cache = new Map<string, Promise<Waveform | null>>()

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

/** Decode once per identity and revision; playback keeps its native range URL. */
export async function loadWaveform(key: string, src: string, signal: AbortSignal): Promise<Waveform | null> {
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
    const read = (async (): Promise<Waveform | null> => {
      let context: AudioContext | null = null
      try {
        const response = await fetch(src, { signal })
        if (!response.ok) return null
        const bytes = await boundedBytes(response)
        context = new AudioContext()
        const buffer = await context.decodeAudioData(bytes)
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
      finally { if (context) await context.close().catch(() => {}) }
    })()
    if (etag) {
      cache.set(identity, read)
      while (cache.size > 40) cache.delete(cache.keys().next().value!)
      void read.then(result => { if (!result && cache.get(identity) === read) cache.delete(identity) })
    }
    return read
  } catch { return null }
}
