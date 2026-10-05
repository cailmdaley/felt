/**
 * A recording's duration from its first bytes, so a list of songs is timed
 * from the peeks that already name them rather than by loading each one into
 * a media element. WAV, MP3 (Xing, Info or VBRI frame counts, else its
 * constant bitrate over the file's size), FLAC and MP4 audio whose `moov`
 * leads the file. Anything else is null, and the caller asks a media element.
 */
export function durationFromHead(bytes: Uint8Array, size?: number): number | null {
  const seconds = wav(bytes, size) ?? flac(bytes) ?? mp4(bytes) ?? mp3(bytes, size)
  return seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

const ascii = (bytes: Uint8Array, at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length))
const u32be = (b: Uint8Array, at: number): number => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const u32le = (b: Uint8Array, at: number): number => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0

function wav(b: Uint8Array, size?: number): number | null {
  if (b.length < 12 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WAVE') return null
  let byteRate = 0
  for (let at = 12; at + 8 <= b.length;) {
    const id = ascii(b, at, 4)
    const length = u32le(b, at + 4)
    if (id === 'fmt ' && at + 16 <= b.length) byteRate = u32le(b, at + 16)
    if (id === 'data') {
      if (!byteRate) return null
      // A streaming writer leaves the length open; the file's size bounds it.
      const data = length === 0 || length === 0xffffffff ? (size ?? 0) - at - 8 : Math.min(length, size === undefined ? length : size - at - 8)
      return data > 0 ? data / byteRate : null
    }
    at += 8 + length + (length & 1)
  }
  return null
}

function flac(b: Uint8Array): number | null {
  if (b.length < 26 || ascii(b, 0, 4) !== 'fLaC' || (b[4] & 0x7f) !== 0) return null
  const d = 8
  const rate = (b[d + 10] << 12) | (b[d + 11] << 4) | (b[d + 12] >> 4)
  const samples = (b[d + 13] & 0x0f) * 2 ** 32 + u32be(b, d + 14)
  return rate && samples ? samples / rate : null
}

function mp4(b: Uint8Array): number | null {
  if (b.length < 12 || ascii(b, 4, 4) !== 'ftyp') return null
  for (let at = 0; at + 32 <= b.length; at++) {
    if (b[at] !== 0x6d || ascii(b, at, 4) !== 'mvhd') continue
    const version = b[at + 4]
    if (version === 1) {
      if (at + 36 > b.length) return null
      const scale = u32be(b, at + 24)
      return scale ? (u32be(b, at + 28) * 2 ** 32 + u32be(b, at + 32)) / scale : null
    }
    const scale = u32be(b, at + 16)
    return scale ? u32be(b, at + 20) / scale : null
  }
  return null
}

const BITRATES = {
  v1l1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  v1l2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2l1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  v2l23: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }

interface Frame { at: number; length: number; bitrate: number; rate: number; samples: number; mpeg1: boolean; mono: boolean }
function frame(b: Uint8Array, at: number): Frame | null {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return null
  const version = (b[at + 1] >> 3) & 3
  const layer = (b[at + 1] >> 1) & 3
  const bitrateIndex = b[at + 2] >> 4
  const rateIndex = (b[at + 2] >> 2) & 3
  if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null
  const mpeg1 = version === 3
  const table = mpeg1 ? (layer === 3 ? BITRATES.v1l1 : layer === 2 ? BITRATES.v1l2 : BITRATES.v1l3) : (layer === 3 ? BITRATES.v2l1 : BITRATES.v2l23)
  const bitrate = table[bitrateIndex] * 1000
  const rate = RATES[version][rateIndex]
  const padding = (b[at + 2] >> 1) & 1
  const samples = layer === 3 ? 384 : layer === 2 || mpeg1 ? 1152 : 576
  const length = layer === 3 ? (Math.floor(12 * bitrate / rate) + padding) * 4 : Math.floor(samples / 8 * bitrate / rate) + padding
  return { at, length, bitrate, rate, samples, mpeg1, mono: (b[at + 3] >> 6) === 3 }
}

function mp3(b: Uint8Array, size?: number): number | null {
  let start = 0
  if (ascii(b, 0, 3) === 'ID3' && b.length >= 10) {
    start = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f)) + (b[5] & 0x10 ? 10 : 0)
  }
  // The first frame is the one a second frame follows, so stray sync bytes are passed over.
  let first: Frame | null = null
  for (let at = start; at + 4 <= b.length && at < start + 4096; at++) {
    const candidate = frame(b, at)
    if (!candidate) continue
    const next = candidate.at + candidate.length
    if (next + 4 > b.length || frame(b, next)) { first = candidate; break }
  }
  if (!first) return null
  const side = first.mpeg1 ? (first.mono ? 17 : 32) : (first.mono ? 9 : 17)
  const xing = first.at + 4 + side
  if (xing + 12 <= b.length && ['Xing', 'Info'].includes(ascii(b, xing, 4)) && (u32be(b, xing + 4) & 1)) {
    return u32be(b, xing + 8) * first.samples / first.rate
  }
  const vbri = first.at + 36
  if (vbri + 18 <= b.length && ascii(b, vbri, 4) === 'VBRI') return u32be(b, vbri + 14) * first.samples / first.rate
  return size !== undefined && size > first.at ? (size - first.at) * 8 / first.bitrate : null
}
