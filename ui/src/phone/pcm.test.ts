import { describe, expect, it } from 'vitest'
import { CHUNK_SAMPLES, Chunker, Resampler, floatToS16LE, lowPassTaps, mixToMono } from './pcm'

function tone(rate: number, hz: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate)
  return out
}

function rms(samples: Float32Array): number {
  let sum = 0
  for (const s of samples) sum += s * s
  return Math.sqrt(sum / samples.length)
}

/** Feed `input` through a fresh resampler in uneven pieces, as a worklet would. */
function resampleInPieces(input: Float32Array, inRate: number, pieces: number[]): Float32Array {
  const resampler = new Resampler(inRate)
  const out: number[] = []
  let offset = 0
  let turn = 0
  while (offset < input.length) {
    const size = pieces[turn++ % pieces.length]
    out.push(...resampler.process(input.subarray(offset, offset + size)))
    offset += size
  }
  return Float32Array.from(out)
}

/** Amplitude and phase-free match of `samples` to a sine at `hz`, by projection. */
function sineAmplitude(samples: Float32Array, rate: number, hz: number): number {
  let sin = 0
  let cos = 0
  for (let i = 0; i < samples.length; i++) {
    sin += samples[i] * Math.sin((2 * Math.PI * hz * i) / rate)
    cos += samples[i] * Math.cos((2 * Math.PI * hz * i) / rate)
  }
  return (2 / samples.length) * Math.hypot(sin, cos)
}

describe('low-pass taps', () => {
  it('are symmetric with unit DC gain', () => {
    const taps = lowPassTaps(48_000, 7_000, 97)
    expect(taps.length).toBe(97)
    expect(taps.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    for (let k = 0; k < taps.length; k++) expect(taps[k]).toBeCloseTo(taps[taps.length - 1 - k], 7)
  })
})

describe('resampler', () => {
  it('turns a second at 48 kHz into a second at 16 kHz and keeps a speech-band tone', () => {
    const out = resampleInPieces(tone(48_000, 1_000, 1), 48_000, [128])
    expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(1)
    // Past the filter's warm-up, the tone is all there and nothing else is.
    const settled = out.subarray(200)
    expect(sineAmplitude(settled, 16_000, 1_000)).toBeCloseTo(0.5, 2)
    expect(rms(settled)).toBeCloseTo(0.5 / Math.SQRT2, 2)
  })

  it('handles 44.1 kHz, the other common device rate', () => {
    const out = resampleInPieces(tone(44_100, 440, 2), 44_100, [128, 441, 7])
    expect(Math.abs(out.length - 32_000)).toBeLessThanOrEqual(1)
    expect(sineAmplitude(out.subarray(200), 16_000, 440)).toBeCloseTo(0.5, 2)
  })

  it('filters what would alias: a 10 kHz tone at 48 kHz all but vanishes', () => {
    const input = tone(48_000, 10_000, 1)
    const out = resampleInPieces(input, 48_000, [128]).subarray(200)
    expect(rms(out)).toBeLessThan(0.01 * rms(input))
  })

  it('leaves no seams at chunk boundaries: any chunking gives the same stream', () => {
    const input = tone(48_000, 1_234, 0.5)
    const whole = new Resampler(48_000).process(input)
    const pieces = resampleInPieces(input, 48_000, [128, 3, 1000, 17])
    expect(pieces.length).toBe(whole.length)
    for (let i = 0; i < whole.length; i++) expect(pieces[i]).toBeCloseTo(whole[i], 5)
  })

  it('passes 16 kHz through unchanged', () => {
    const input = tone(16_000, 300, 0.1)
    const out = new Resampler(16_000).process(input)
    expect(out.length).toBe(input.length)
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(input[i], 6)
  })

  it('refuses a nonsense rate', () => {
    expect(() => new Resampler(0)).toThrow()
  })
})

describe('s16le packing', () => {
  it('scales, rounds and clips into little-endian 16-bit', () => {
    const buffer = floatToS16LE(Float32Array.from([0, 1, -1, 0.5, 2, -2, -0.5]))
    const view = new DataView(buffer)
    const values = Array.from({ length: 7 }, (_, i) => view.getInt16(i * 2, true))
    expect(values).toEqual([0, 32767, -32768, 16384, 32767, -32768, -16384])
    // Little-endian on the wire whatever the host: 32767 is ff 7f.
    expect(new Uint8Array(buffer).slice(2, 4)).toEqual(Uint8Array.from([0xff, 0x7f]))
  })
})

describe('mono and chunking', () => {
  it('averages channels', () => {
    expect(Array.from(mixToMono([Float32Array.from([1, 0]), Float32Array.from([0, 1])]))).toEqual([0.5, 0.5])
    const only = Float32Array.from([0.25])
    expect(mixToMono([only])).toBe(only)
  })

  it('emits 100 ms chunks of s16 with their peak, carrying the remainder', () => {
    const chunker = new Chunker()
    const first = chunker.push(new Float32Array(CHUNK_SAMPLES - 10).fill(0.25))
    expect(first).toEqual([])
    const chunks = chunker.push(new Float32Array(40).fill(-0.5))
    expect(chunks).toHaveLength(1)
    expect(chunks[0].pcm.byteLength).toBe(CHUNK_SAMPLES * 2)
    expect(chunks[0].peak).toBeCloseTo(0.5, 6)
    // The 30 samples past the chunk open the next one.
    const next = chunker.push(new Float32Array(CHUNK_SAMPLES - 30))
    expect(next).toHaveLength(1)
    expect(new DataView(next[0].pcm).getInt16(0, true)).toBe(-16384)
  })
})
