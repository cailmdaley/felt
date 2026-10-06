// @ts-expect-error Node types are excluded from the browser UI's tsconfig.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { durationFromHead } from './audioDuration.js'

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../../harness/fixtures/${name}`, import.meta.url)))

describe('durations from a recording head', () => {
  it('reads a WAV data chunk over its byte rate', () => {
    const wav = fixture('sine.wav')
    expect(durationFromHead(wav.subarray(0, 65536), wav.length)).toBeCloseTo(1.4, 2)
  })

  it('times a constant-bitrate MP3 by its size', () => {
    const mp3 = fixture('sine.mp3')
    expect(durationFromHead(mp3, mp3.length)).toBeCloseTo(1.4628, 3)
    expect(durationFromHead(mp3)).toBeNull()
  })

  it('counts the frames a Xing header declares, after an ID3 tag', () => {
    const id3 = [0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0]
    // MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo: Xing sits 32 bytes past the header.
    const frame = new Uint8Array(417)
    frame.set([0xff, 0xfb, 0x90, 0x00])
    frame.set([...'Xing'].map(c => c.charCodeAt(0)), 36)
    frame.set([0, 0, 0, 1, 0, 0, 0x01, 0x2c], 40)
    const next = [0xff, 0xfb, 0x90, 0x00]
    const bytes = new Uint8Array([...id3, ...frame, ...next])
    expect(durationFromHead(bytes, 10_000_000)).toBeCloseTo(300 * 1152 / 44100, 6)
  })

  it('reads FLAC stream info and an MP4 movie header', () => {
    const flac = new Uint8Array(42)
    flac.set([...'fLaC'].map(c => c.charCodeAt(0)))
    flac.set([0x80, 0, 0, 34], 4)
    // 44100 Hz (20 bits), 2 channels, 16 bits, 441000 samples.
    flac.set([0x0a, 0xc4, 0x42, 0xf0, 0x00, 0x06, 0xba, 0xa8], 18)
    expect(durationFromHead(flac)).toBeCloseTo(10, 6)
    const mp4 = new Uint8Array(64)
    mp4.set([...'ftyp'].map(c => c.charCodeAt(0)), 4)
    mp4.set([...'mvhd'].map(c => c.charCodeAt(0)), 20)
    mp4.set([0, 0, 0x03, 0xe8, 0, 0, 0x75, 0x30], 36)
    expect(durationFromHead(mp4)).toBe(30)
  })

  it('leaves formats it cannot time to a media element', () => {
    expect(durationFromHead(new TextEncoder().encode('OggS\0\0'))).toBeNull()
    expect(durationFromHead(new Uint8Array(0))).toBeNull()
  })
})
