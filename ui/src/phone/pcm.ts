/**
 * The phone mic's audio arithmetic: the browser's float samples at the
 * device's own rate in, hark's s16le 16 kHz mono out. Pure, so the worklet
 * runs it and the suite tests it.
 */

export const TARGET_RATE = 16_000
/** 100 ms of 16 kHz audio: one WebSocket frame. */
export const CHUNK_SAMPLES = 1_600

/**
 * Low-pass windowed-sinc taps for a cutoff of `cutoffHz` at `rate`, odd in
 * length and normalized to unit DC gain.
 */
export function lowPassTaps(rate: number, cutoffHz: number, length: number): Float32Array {
  const taps = new Float32Array(length)
  const fc = cutoffHz / rate
  const middle = (length - 1) / 2
  let sum = 0
  for (let k = 0; k < length; k++) {
    const x = k - middle
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)
    const blackman = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (length - 1)) +
      0.08 * Math.cos((4 * Math.PI * k) / (length - 1))
    taps[k] = sinc * blackman
    sum += taps[k]
  }
  for (let k = 0; k < length; k++) taps[k] /= sum
  return taps
}

/**
 * A streaming resampler. Downsampling first low-passes the input below the
 * output's Nyquist (a Blackman-windowed sinc, about 2 taps per kHz of input
 * rate, cut at 7 kHz for a 16 kHz output), then reads the filtered stream by
 * linear interpolation at the output spacing. Upsampling only interpolates;
 * equal rates pass through.
 * State carries across calls, so chunk boundaries leave no seams.
 */
export class Resampler {
  readonly inRate: number
  readonly outRate: number
  private readonly taps: Float32Array | null
  private readonly history: Float32Array
  private readonly step: number
  /** Position of the next output sample, in filtered samples from the start
   *  of the current input chunk; -1 is the previous chunk's last one. */
  private position = 0
  private previous = 0

  constructor(inRate: number, outRate = TARGET_RATE) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error(`invalid sample rates ${inRate} → ${outRate}`)
    this.inRate = inRate
    this.outRate = outRate
    this.step = inRate / outRate
    if (inRate > outRate) {
      const length = 2 * Math.floor(inRate / 1000) + 1
      this.taps = lowPassTaps(inRate, 0.4375 * outRate, length)
      this.history = new Float32Array(length - 1)
    } else {
      this.taps = null
      this.history = new Float32Array(0)
    }
  }

  process(input: Float32Array): Float32Array {
    if (this.inRate === this.outRate) return Float32Array.from(input)
    const filtered = this.filter(input)
    const n = filtered.length
    if (n === 0) return new Float32Array(0)
    const out: number[] = []
    while (Math.floor(this.position) + 1 <= n - 1) {
      const i = Math.floor(this.position)
      const frac = this.position - i
      const a = i < 0 ? this.previous : filtered[i]
      const b = filtered[i + 1]
      out.push(a + (b - a) * frac)
      this.position += this.step
    }
    this.position -= n
    this.previous = filtered[n - 1]
    return Float32Array.from(out)
  }

  private filter(input: Float32Array): Float32Array {
    const taps = this.taps
    if (!taps) return input
    const keep = this.history.length
    const extended = new Float32Array(keep + input.length)
    extended.set(this.history)
    extended.set(input, keep)
    const out = new Float32Array(input.length)
    const length = taps.length
    for (let n = 0; n < input.length; n++) {
      // extended[n + keep] is input[n]; the filter reaches back length - 1.
      let acc = 0
      const end = n + keep
      for (let k = 0; k < length; k++) acc += taps[k] * extended[end - k]
      out[n] = acc
    }
    this.history.set(extended.subarray(extended.length - keep))
    return out
  }
}

/** Float samples in [-1, 1] as signed 16-bit little-endian PCM, clipped. */
export function floatToS16LE(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buffer)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true)
  }
  return buffer
}

/** Mix a frame's channels down to one. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  const out = new Float32Array(channels[0].length)
  for (const channel of channels) for (let i = 0; i < out.length; i++) out[i] += channel[i]
  for (let i = 0; i < out.length; i++) out[i] /= channels.length
  return out
}

/** A chunk ready to send, and how loud it was (peak, 0–1). */
export interface PcmChunk {
  pcm: ArrayBuffer
  peak: number
}

/** Gathers resampled audio into fixed-size chunks. */
export class Chunker {
  readonly size: number
  private readonly pending: Float32Array
  private filled = 0

  constructor(size = CHUNK_SAMPLES) {
    this.size = size
    this.pending = new Float32Array(size)
  }

  push(samples: Float32Array): PcmChunk[] {
    const chunks: PcmChunk[] = []
    let offset = 0
    while (offset < samples.length) {
      const take = Math.min(this.size - this.filled, samples.length - offset)
      this.pending.set(samples.subarray(offset, offset + take), this.filled)
      this.filled += take
      offset += take
      if (this.filled === this.size) {
        let peak = 0
        for (let i = 0; i < this.size; i++) peak = Math.max(peak, Math.abs(this.pending[i]))
        chunks.push({ pcm: floatToS16LE(this.pending), peak: Math.min(1, peak) })
        this.filled = 0
      }
    }
    return chunks
  }
}
