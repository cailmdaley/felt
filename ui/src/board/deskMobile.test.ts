import { describe, expect, it } from 'vitest'
import { activeFolioIndex, folioScrollTarget } from './deskMobile'

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
