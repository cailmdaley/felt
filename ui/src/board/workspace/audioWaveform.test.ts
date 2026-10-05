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
  it('decodes and closes once per key + ETag, then invalidates on a revision', async () => {
    const decode = vi.fn(async () => ({ duration: 2, numberOfChannels: 1, getChannelData: () => new Float32Array([.25, -.5]) }))
    const close = vi.fn(async () => {})
    vi.stubGlobal('AudioContext', class { decodeAudioData = decode; close = close })
    let etag = 'revision-a'
    const fetcher = vi.fn(async (_src, options) => new Response(options?.method === 'HEAD' ? null : new Uint8Array([1, 2]), { headers: { ETag: etag } }))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    expect(await loadWaveform('test', '/test.wav', signal)).toEqual({ duration: 2, peaks: [.25, .5] })
    await loadWaveform('test', '/test.wav', signal)
    expect(decode).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1)
    etag = 'revision-b'
    await loadWaveform('test', '/test.wav', signal)
    expect(decode).toHaveBeenCalledTimes(2)
  })
  it('returns a progress fallback after decoding failure and still closes the context', async () => {
    const close = vi.fn(async () => {})
    vi.stubGlobal('AudioContext', class { decodeAudioData = vi.fn(async () => { throw new Error('Codec') }); close = close })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))))
    expect(await loadWaveform('invalid', '/invalid.mp3', new AbortController().signal)).toBeNull()
    expect(close).toHaveBeenCalledOnce()
  })
})
