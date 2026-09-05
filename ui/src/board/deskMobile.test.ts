import { describe, expect, it } from 'vitest'
import {
  activeFolioIndex,
  DEFAULT_BAND_STATE,
  folioScrollTarget,
  parseBandState,
  readBandState,
  writeBandState,
  type BandState,
} from './deskMobile'

describe('activeFolioIndex', () => {
  it('reads the leaf under the viewport', () => {
    expect(activeFolioIndex(0, 390, 3)).toBe(0)
    expect(activeFolioIndex(390, 390, 3)).toBe(1)
    expect(activeFolioIndex(780, 390, 3)).toBe(2)
  })

  it('rounds to the nearest leaf rather than flooring', () => {
    expect(activeFolioIndex(388, 390, 3)).toBe(1)
    expect(activeFolioIndex(200, 390, 3)).toBe(1)
    expect(activeFolioIndex(194, 390, 3)).toBe(0)
  })

  it('clamps rubber-banded offsets at both ends', () => {
    expect(activeFolioIndex(-80, 390, 3)).toBe(0)
    expect(activeFolioIndex(2000, 390, 3)).toBe(2)
  })

  it('survives a zero-width or empty pager', () => {
    expect(activeFolioIndex(120, 0, 3)).toBe(0)
    expect(activeFolioIndex(120, 390, 0)).toBe(0)
    expect(activeFolioIndex(Number.NaN, 390, 3)).toBe(0)
  })
})

describe('folioScrollTarget', () => {
  it('puts the requested leaf flush at the left edge', () => {
    expect(folioScrollTarget(0, 390, 3)).toBe(0)
    expect(folioScrollTarget(2, 390, 3)).toBe(780)
  })
  it('clamps out-of-range requests', () => {
    expect(folioScrollTarget(9, 390, 3)).toBe(780)
    expect(folioScrollTarget(-2, 390, 3)).toBe(0)
  })
})

describe('band collapse state', () => {
  it('defaults to Pinned open, Resting folded', () => {
    expect(DEFAULT_BAND_STATE).toEqual({ pinned: true, resting: false })
    expect(parseBandState(null)).toEqual(DEFAULT_BAND_STATE)
  })

  it('falls back per key on partial or malformed payloads', () => {
    expect(parseBandState('{"resting":true}')).toEqual({ pinned: true, resting: true })
    expect(parseBandState('{"pinned":"yes"}')).toEqual(DEFAULT_BAND_STATE)
    expect(parseBandState('not json')).toEqual(DEFAULT_BAND_STATE)
    expect(parseBandState('[]')).toEqual(DEFAULT_BAND_STATE)
  })

  it('round-trips through a storage stub', () => {
    const map = new Map<string, string>()
    const store = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    }
    const next: BandState = { pinned: false, resting: true }
    writeBandState(next, store)
    expect(readBandState(store)).toEqual(next)
  })

  it('degrades to defaults when storage throws', () => {
    const store = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }
    expect(readBandState(store)).toEqual(DEFAULT_BAND_STATE)
    expect(() => writeBandState({ pinned: false, resting: false }, store)).not.toThrow()
  })
})
