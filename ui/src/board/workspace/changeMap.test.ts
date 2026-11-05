import { expect, it } from 'vitest'
import { squarify } from './changeMap.js'

it('tiles the available rectangle in proportion to line counts, in either orientation', () => {
  for (const [width, height] of [[900, 500], [320, 600]]) {
    const weights = [5000, 3000, 1500, 400, 100, 0]
    const rects = squarify(weights, width, height)
    expect(rects).toHaveLength(5)
    for (const r of rects) {
      expect(r.width * r.height / (width * height)).toBeCloseTo(weights[r.index] / 10000)
      expect(r.x + r.width).toBeLessThanOrEqual(width + 0.001)
      expect(r.y + r.height).toBeLessThanOrEqual(height + 0.001)
    }
  }
})
