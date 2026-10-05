import { afterEach, describe, expect, it, vi } from 'vitest'
import { audioPeaks, loadWaveform } from './audioWaveform.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('audio waveform', () => {
  it('keeps maximum amplitude across time buckets and stereo channels', () => {
    expect(audioPeaks([new Float32Array([0, -.8, .2, 0]), new Float32Array([.5, 0, 0, -.6])], 2)).toEqual([.8, .6])
    expect(audioPeaks([])).toEqual([])
  })
  it('does not fetch large files beyond the metadata probe', async () => {
    const fetcher = vi.fn(async () => new Response(null, { headers: { 'Content-Length': String(61 * 1024 * 1024) } }))
    vi.stubGlobal('fetch', fetcher)
    expect(await loadWaveform('large', '/large.wav', new AbortController().signal)).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('decodes once per key + ETag, then invalidates on a revision', async () => {
    const decode = vi.fn(async () => ({ duration: 2, numberOfChannels: 1, getChannelData: () => new Float32Array([.25, -.5]) }))
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode })
    let etag = 'revision-a'
    const fetcher = vi.fn(async (_src, options) => new Response(options?.method === 'HEAD' ? null : new Uint8Array([1, 2]), { headers: { ETag: etag } }))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    expect(await loadWaveform('test', '/test.wav', signal)).toEqual({ duration: 2, peaks: [.25, .5] })
    await loadWaveform('test', '/test.wav', signal)
    expect(decode).toHaveBeenCalledTimes(1)
    etag = 'revision-b'
    await loadWaveform('test', '/test.wav', signal)
    expect(decode).toHaveBeenCalledTimes(2)
  })
  it('returns a progress fallback after decoding failure', async () => {
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = vi.fn(async () => { throw new Error('Codec') }) })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))))
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
    vi.stubGlobal('fetch', vi.fn(async (src: string, options?: RequestInit) =>
      new Response(options?.method === 'HEAD' ? null : new Uint8Array([1]), { headers: { ETag: `count-${src}` } })))
    const signal = new AbortController().signal
    const waveforms = await Promise.all(Array.from({ length: 13 }, (_, i) => loadWaveform(`take-${i}`, `/take-${i}.mp3`, signal)))
    expect(waveforms.every(waveform => waveform?.duration === 1)).toBe(true)
    expect(realtime).not.toHaveBeenCalled()
    expect(offline).toEqual(Array(13).fill(8000))
  })
  it('draws a neighbour only from a waveform already decoded, never downloading it', async () => {
    const decode = vi.fn(async () => ({ duration: 3, numberOfChannels: 1, getChannelData: () => new Float32Array([.5]) }))
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode })
    const fetcher = vi.fn(async (_src: string, options?: RequestInit) => new Response(options?.method === 'HEAD' ? null : new Uint8Array([1]), { headers: { ETag: 'neighbour-a' } }))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    expect(await loadWaveform('neighbour', '/neighbour.mp3', signal, false)).toBeNull()
    expect(fetcher.mock.calls.filter(([, options]) => options?.method !== 'HEAD')).toHaveLength(0)
    expect(await loadWaveform('neighbour', '/neighbour.mp3', signal)).toEqual({ duration: 3, peaks: [.5] })
    expect(await loadWaveform('neighbour', '/neighbour.mp3', signal, false)).toEqual({ duration: 3, peaks: [.5] })
    expect(decode).toHaveBeenCalledTimes(1)
  })
})
