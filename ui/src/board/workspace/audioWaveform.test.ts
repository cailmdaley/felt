import { afterEach, describe, expect, it, vi } from 'vitest'
import { peek, resetDocumentResources, RESOURCE_FRESH_MS } from '../documentResources.js'
import { resetLanes } from '../requestLanes.js'
import { audioPeaks, loadWaveform } from './audioWaveform.js'

const ranged = (init?: RequestInit): boolean => new Headers(init?.headers).has('Range')
/** A peek answers with the recording's head; a whole read with its bytes. */
const recording = (etag: () => string, size = 2) => vi.fn(async (_src: string, init?: RequestInit) => ranged(init)
  ? new Response(new Uint8Array([1, 2]), { status: 206, headers: { ETag: etag(), 'Content-Range': `bytes 0-1/${size}` } })
  : new Response(new Uint8Array([1, 2]), { headers: { ETag: etag() } }))

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); resetDocumentResources(); resetLanes() })
describe('audio waveform', () => {
  it('keeps maximum amplitude across time buckets and stereo channels', () => {
    expect(audioPeaks([new Float32Array([0, -.8, .2, 0]), new Float32Array([.5, 0, 0, -.6])], 2)).toEqual([.8, .6])
    expect(audioPeaks([])).toEqual([])
  })
  it('does not read a large recording beyond its peek', async () => {
    const fetcher = recording(() => 'W/"large"', 61 * 1024 * 1024)
    vi.stubGlobal('fetch', fetcher)
    expect(await loadWaveform('large', '/large.wav', new AbortController().signal)).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('decodes once per document and validator, then again for a revision', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const decode = vi.fn(async () => ({ duration: 2, numberOfChannels: 1, getChannelData: () => new Float32Array([.25, -.5]) }))
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode })
    let etag = 'W/"revision-a"'
    vi.stubGlobal('fetch', recording(() => etag))
    const signal = new AbortController().signal
    expect(await loadWaveform('test', '/test.wav', signal)).toEqual({ duration: 2, peaks: [.25, .5] })
    await loadWaveform('test', '/test.wav', signal)
    expect(decode).toHaveBeenCalledTimes(1)
    etag = 'W/"revision-b"'
    vi.setSystemTime(Date.now() + RESOURCE_FRESH_MS + 1)
    await loadWaveform('test', '/test.wav', signal)
    expect(decode).toHaveBeenCalledTimes(2)
  })
  it('returns a progress fallback after decoding failure', async () => {
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = vi.fn(async () => { throw new Error('Codec') }) })
    vi.stubGlobal('fetch', recording(() => 'W/"invalid"'))
    expect(await loadWaveform('invalid', '/invalid.mp3', new AbortController().signal)).toBeNull()
  })
  it('draws a channel of thirteen recordings without opening a realtime audio context', async () => {
    const realtime = vi.fn()
    const offline: number[] = []
    vi.stubGlobal('AudioContext', class { constructor() { realtime() } })
    vi.stubGlobal('OfflineAudioContext', class {
      constructor(_channels: number, _length: number, rate: number) { offline.push(rate) }
      decodeAudioData = vi.fn(async () => ({ duration: 1, numberOfChannels: 1, getChannelData: () => new Float32Array([.5]) }))
    })
    vi.stubGlobal('fetch', vi.fn(async (src: string, init?: RequestInit) =>
      new Response(new Uint8Array([1]), { status: ranged(init) ? 206 : 200, headers: { ETag: `W/"count-${src}"` } })))
    const signal = new AbortController().signal
    const waveforms = await Promise.all(Array.from({ length: 13 }, (_, i) => loadWaveform(`take-${i}`, `/take-${i}.mp3`, signal)))
    expect(waveforms.every(waveform => waveform?.duration === 1)).toBe(true)
    expect(realtime).not.toHaveBeenCalled()
    expect(offline).toEqual(Array(13).fill(8000))
  })
  it('drops a waveform lookup its page abandoned while it waited in the queue', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const fetcher = vi.fn(async (src: string) => { if (src.includes('busy')) await gate; return new Response(new Uint8Array([1]), { status: 206, headers: { ETag: 'W/"sha256-w"' } }) })
    vi.stubGlobal('fetch', fetcher)
    const busy = [peek('/api/v1/file?path=/busy-a'), peek('/api/v1/file?path=/busy-b')]
    const page = new AbortController()
    const waveform = loadWaveform('gone', '/api/v1/file?path=/gone.mp3', page.signal, false)
    page.abort()
    expect(await waveform).toBeNull()
    release(); await Promise.all(busy)
    expect(fetcher.mock.calls.map(([src]) => src)).not.toContain('/api/v1/file?path=/gone.mp3')
  })

  it('draws a neighbour only from a waveform already decoded, never downloading it', async () => {
    const decode = vi.fn(async () => ({ duration: 3, numberOfChannels: 1, getChannelData: () => new Float32Array([.5]) }))
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode })
    const fetcher = recording(() => 'W/"neighbour-a"')
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    expect(await loadWaveform('neighbour', '/neighbour.mp3', signal, false)).toBeNull()
    expect(fetcher.mock.calls.filter(([, init]) => !ranged(init))).toHaveLength(0)
    expect(await loadWaveform('neighbour', '/neighbour.mp3', signal)).toEqual({ duration: 3, peaks: [.5] })
    expect(await loadWaveform('neighbour', '/neighbour.mp3', signal, false)).toEqual({ duration: 3, peaks: [.5] })
    expect(decode).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
