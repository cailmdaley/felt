import { describe, expect, it } from 'vitest'
import { blocks, boxFits, overlaps, placeNames, within, wrap } from './labels.js'

const measure = (text: string): number => text.length * 7
const diamond = (x: number, y: number, r: number): number[] => [x, y - r, x - r, y, x, y + r, x + r, y]

describe('laying a name into a tile', () => {
  it('wraps greedily and never splits a word', () => {
    expect(wrap('Audit the tile manifest', 80, measure)).toEqual(['Audit the', 'tile', 'manifest'])
    expect(wrap('supercalifragilistic', 10, measure)).toEqual(['supercalifragilistic'])
  })
  it('offers each line count once, narrower as it grows', () => {
    const options = blocks('Audit the tile manifest against the archive', measure, 15, 'row')
    expect(options[0].lines).toHaveLength(1)
    for (let n = 1; n < options.length; n++) {
      expect(options[n].lines.length).toBeGreaterThan(options[n - 1].lines.length)
      expect(options[n].width).toBeLessThan(options[n - 1].width)
    }
    for (const option of options) expect(option.lines.join(' ')).toBe('Audit the tile manifest against the archive')
  })
  it('knows inside from outside, and a box from its corners', () => {
    const tile = diamond(100, 100, 60)
    expect(within(tile, 100, 100)).toBe(true)
    expect(within(tile, 150, 150)).toBe(false)
    expect(boxFits(tile, { x: 100, y: 100 }, 40, 16)).toBe(true)
    expect(boxFits(tile, { x: 100, y: 100 }, 100, 16)).toBe(false)
  })
  it('shows a name whole or not at all, wrapping it when that is what fits', () => {
    const options = blocks('Audit the tile manifest against the archive', measure, 15, 'row')
    const small = placeNames([{ owner: 'a', polygon: diamond(100, 100, 40), anchors: [{ x: 100, y: 100 }], blocks: options }], { left: 0, top: 0, right: 500, bottom: 500 }, 9)
    expect(small).toHaveLength(0)
    const fair = placeNames([{ owner: 'a', polygon: diamond(100, 100, 130), anchors: [{ x: 100, y: 100 }], blocks: options }], { left: 0, top: 0, right: 500, bottom: 500 }, 9)
    expect(fair).toHaveLength(1)
    expect(fair[0].block.lines.length).toBeGreaterThan(1)
  })
  it('sets a name free of any tile, and only once for its owner', () => {
    const block = blocks('asks', measure, 15, 'note'), frame = { left: 0, top: 0, right: 300, bottom: 300 }
    const placed = placeNames([
      { owner: 'a', polygon: null, anchors: [{ x: 50, y: 50 }], blocks: block },
      { owner: 'a', polygon: diamond(200, 200, 90), anchors: [{ x: 200, y: 200 }], blocks: block },
    ], frame, 9)
    expect(placed.map(item => item.at)).toEqual([{ x: 50, y: 50 }])
  })
  it('keeps names apart and inside the frame', () => {
    const block = blocks('one name', measure, 15, 'row')
    const frame = { left: 0, top: 0, right: 300, bottom: 300 }
    const big = diamond(150, 150, 400)
    const placed = placeNames([
      { owner: 'first', polygon: big, anchors: [{ x: 150, y: 150 }], blocks: block },
      { owner: 'second', polygon: big, anchors: [{ x: 160, y: 152 }], blocks: block },
      { owner: 'third', polygon: big, anchors: [{ x: 160, y: 152 }, { x: 150, y: 200 }], blocks: block },
      { owner: 'edge', polygon: big, anchors: [{ x: 10, y: 10 }], blocks: block },
    ], frame, 9)
    expect(placed.map(item => item.owner)).toEqual(['first', 'third'])
    expect(overlaps(placed[0].box, placed[1].box)).toBe(false)
  })
})
