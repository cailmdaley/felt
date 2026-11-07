import { describe, expect, it } from 'vitest'
import reference from './fixtures/healpy-ref.json'
import { baseCell, cellAt, cellArea, cellCount, cellOf, cellRadius, centre, child, contains, facePoint, ipixOf, outline, parent, uniq, type Cell, type Digit, type Vec } from './healpix.js'

const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const points = (flat: Float64Array): Vec[] => Array.from({ length: flat.length / 3 }, (_, n) => [flat[3 * n], flat[3 * n + 1], flat[3 * n + 2]])
/** A spherical polygon's area, by its triangles from the first vertex (Van Oosterom & Strackee). */
function area(polygon: Vec[]): number {
  let sum = 0
  for (let n = 1; n + 1 < polygon.length; n++) {
    const [a, b, c] = [polygon[0], polygon[n], polygon[n + 1]]
    sum += 2 * Math.atan2(dot(a, cross(b, c)), 1 + dot(a, b) + dot(b, c) + dot(c, a))
  }
  return Math.abs(sum)
}
const allCells = (order: number): Cell[] => Array.from({ length: cellCount(order) }, (_, n) => cellOf(order, n))

describe('against healpy 1.20', () => {
  it('puts every reference pixel centre where healpy does', () => {
    for (const [order, ipix, x, y, z] of reference.centres) {
      const at = centre(cellOf(order, ipix))
      expect(at[0]).toBeCloseTo(x, 11)
      expect(at[1]).toBeCloseTo(y, 11)
      expect(at[2]).toBeCloseTo(z, 11)
    }
  })
  it('draws the curved outlines healpy draws, point for point', () => {
    for (const [order, ipix, want] of reference.boundaries as Array<[number, number, number[][]]>) {
      const got = points(outline(cellOf(order, ipix), 2))
      expect(got).toHaveLength(8)
      got.forEach((point, n) => point.forEach((value, axis) => expect(value).toBeCloseTo(want[n][axis], 10)))
    }
  })
  it('finds the pixel of a direction as ang2pix does', () => {
    for (const [order, z, phi, ipix] of reference.query) expect(ipixOf(cellAt(facePoint(z, phi), order))).toBe(ipix)
  })
  it('bounds a cell\'s radius above max_pixrad at every reference order', () => {
    for (const [order, radius] of Object.entries(reference.maxrad)) expect(cellRadius(Number(order))).toBeGreaterThan(radius)
  })
})

describe('the tessellation', () => {
  it('has 12·4^order cells, every index round-tripping', () => {
    for (const order of [0, 1, 2, 3]) {
      expect(cellCount(order)).toBe(12 * 4 ** order)
      for (const cell of allCells(order)) expect(cellOf(order, ipixOf(cell))).toEqual(cell)
    }
    expect(cellCount(12)).toBe(201_326_592)
    const deep = cellOf(20, 12_345_678_901_234)
    expect(ipixOf(deep)).toBe(12_345_678_901_234)
  })
  it('gives every cell the same area, 4π over the count, through the true boundaries', () => {
    for (const order of [0, 1, 2]) {
      for (const cell of allCells(order)) expect(area(points(outline(cell, 96)))).toBeCloseTo(cellArea(order), 2 + order)
    }
    const total = allCells(1).reduce((sum, cell) => sum + area(points(outline(cell, 48))), 0)
    expect(total).toBeCloseTo(4 * Math.PI, 2)
  })
  it('shares boundaries between neighbours exactly', () => {
    const key = (a: number, b: number, c: number): string => [a, b, c].map(v => (Math.abs(v) < 1e-12 ? 0 : v).toFixed(9)).join()
    const order = 2, step = 4, edges = new Map<string, number>()
    for (const cell of allCells(order)) {
      const flat = outline(cell, step)
      const n = flat.length / 3
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        const a = key(flat[3 * i], flat[3 * i + 1], flat[3 * i + 2]), b = key(flat[3 * j], flat[3 * j + 1], flat[3 * j + 2])
        if (a === b) continue // a degenerate step at a pole
        const edge = a < b ? `${a}|${b}` : `${b}|${a}`
        edges.set(edge, (edges.get(edge) ?? 0) + 1)
      }
    }
    for (const count of edges.values()) expect(count).toBe(2)
  })
  it('keeps four children inside their parent, nested as digits', () => {
    for (const cell of allCells(1)) {
      const kids = ([0, 1, 2, 3] as Digit[]).map(digit => child(cell, digit))
      expect(kids.map(ipixOf)).toEqual([0, 1, 2, 3].map(digit => 4 * ipixOf(cell) + digit))
      for (const kid of kids) {
        expect(parent(kid)).toEqual(cell)
        expect(contains(cell, kid)).toBe(true)
        const mid = centre(kid)
        expect(cellAt(facePoint(mid[2], Math.atan2(mid[1], mid[0])), 1)).toEqual(cell)
      }
    }
  })
  it('names the children by compass: north is highest, south lowest, east and west between', () => {
    const face = baseCell(4), z = (digit: Digit) => centre(child(face, digit))[2]
    expect(z(3)).toBeGreaterThan(z(1))
    expect(z(1)).toBeCloseTo(z(2), 12)
    expect(z(2)).toBeGreaterThan(z(0))
  })
  it('keeps every outline within the cell radius of its centre', () => {
    for (const order of [0, 1, 2, 3]) {
      for (const cell of allCells(order)) {
        const mid = centre(cell)
        for (const point of points(outline(cell, 8))) expect(Math.acos(Math.min(1, dot(mid, point)))).toBeLessThanOrEqual(cellRadius(order))
      }
    }
  })
  it('gives each cell of an order one NUNIQ', () => {
    const seen = new Set([0, 1, 2, 3].flatMap(order => allCells(order).map(uniq)))
    expect(seen.size).toBe(12 + 48 + 192 + 768)
  })
})
