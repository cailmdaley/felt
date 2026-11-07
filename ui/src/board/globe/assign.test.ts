import { describe, expect, it } from 'vitest'
import { assign, tilesOf, weightClass, type Band, type ProjectSeed, type ThreadSeed, type Tile } from './assign.js'
import { contains, parent, uniq, type Cell } from './healpix.js'

/** A small seeded generator, so a failing fleet can be named. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = (t + Math.imul(t ^ t >>> 7, 61 | t)) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}
function thread(random: () => number, prefix: string, depth: number): ThreadSeed {
  const kidCount = depth > 2 ? 0 : Math.floor(random() * random() * 14)
  const kids = Array.from({ length: kidCount }, (_, n) => thread(random, `${prefix}/${n}`, depth + 1))
  const files = Array.from({ length: Math.floor(random() * random() * 9) }, (_, n) => `${prefix}#${n}`)
  return { key: prefix, weight: Math.floor(random() ** 3 * 90), born: Math.floor(random() * 1e9), live: random() < .4, kids, files }
}
function fleet(seed: number, families = 60): ProjectSeed[] {
  const random = rng(seed), bands: Band[] = ['flying', 'resting', 'settled', 'settled']
  return ['science', 'ai-futures', 'life', 'work'].map(name => ({
    name,
    families: Array.from({ length: Math.ceil(random() * families) }, (_, n) => ({ band: bands[Math.floor(random() * 4)], root: thread(random, `${name}/${n}`, 0), area: random() < .5 ? `area-${n % 3}` : undefined })),
  }))
}
const cells = (roots: Tile[]): Map<string, Cell> => new Map([...tilesOf(roots)].map(tile => [tile.key, tile.cell]))
const nested = (a: Cell, b: Cell): boolean => contains(a, b) || contains(b, a)

const seed = (key: string, over: Partial<ThreadSeed> = {}): ThreadSeed => ({ key, weight: 0, born: 0, live: true, kids: [], files: [], ...over })

describe('placing the fleet', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const roots = assign(fleet(seed)), all = [...tilesOf(roots)]
    it(`keeps every tile inside its parent, fleet ${seed}`, () => {
      for (const tile of all) if (tile.parent) {
        expect(contains(tile.parent.cell, tile.cell)).toBe(true)
        if (tile.parent.kind === 'province' || tile.parent.kind === 'area') expect(tile.cell.order).toBeGreaterThanOrEqual(tile.parent.cell.order)
        else expect(tile.cell.order).toBeGreaterThan(tile.parent.cell.order)
      }
    })
    it(`never lets two siblings overlap, fleet ${seed}`, () => {
      for (const siblings of [roots, ...all.map(tile => tile.kids)]) {
        const seen = new Set<number>()
        for (const tile of siblings) { expect(seen.has(uniq(tile.cell))).toBe(false); seen.add(uniq(tile.cell)) }
        expect(siblings.some(a => siblings.some(b => a !== b && contains(a.cell, b.cell)))).toBe(false)
      }
    })
    it(`holds each band to its latitudes, fleet ${seed}`, () => {
      for (const tile of roots) expect(Math.floor(tile.cell.face / 4)).toBe({ flying: 0, resting: 1, settled: 2 }[tile.band])
    })
  }
  it('stays within a few orders, even for a thousand threads', () => {
    const deepest = Math.max(...[...tilesOf(assign(fleet(9, 200)))].map(tile => tile.cell.order))
    expect(deepest).toBeLessThanOrEqual(18)
  })
  const byKeyOf = (root: ThreadSeed): Map<string, Tile> => new Map([...tilesOf(assign([{ name: 'p', families: [{ band: 'flying', root }] }]))].map(tile => [tile.key, tile]))
  /** The quadrant digits from an ancestor's order down to a tile. */
  const path = (tile: Tile, order: number): number[] => {
    const digits: number[] = []
    for (let cell = tile.cell; cell.order > order; cell = parent(cell)) digits.unshift((cell.x % 2) + 2 * (cell.y % 2))
    return digits
  }
  it('gives a thread\'s live threads three quadrants, and its pages and history the fourth', () => {
    const hub = seed('hub', { files: ['a', 'b'], kids: [seed('mid', { files: ['c'], kids: [seed('leaf'), seed('old', { live: false })] }), seed('done', { live: false })] })
    const tiles = byKeyOf(hub)
    for (const owner of ['hub', 'mid']) {
      const order = tiles.get(owner)!.cell.order
      expect(path(tiles.get(`lead\u0000${owner}`)!, order)).toEqual([0, 3])
      expect(path(tiles.get(`constitution\u0000${owner}`)!, order)).toEqual([0, 1, 3])
    }
    const order = tiles.get('hub')!.cell.order
    expect([3, 2, 1]).toContain(path(tiles.get('mid')!, order)[0])
    expect(path(tiles.get('done')!, order)[0]).toBe(0)
    expect([2, 0]).toContain(path(tiles.get('done')!, order)[1])
    expect(path(tiles.get('file\u0000hub\u0000a')!, order).slice(0, 2)).toEqual([0, 1])
  })
  it('lets a thread with no live threads spread what it has', () => {
    const tiles = byKeyOf(seed('hub', { kids: [seed('a', { live: false }), seed('b', { live: false }), seed('c', { live: false })] }))
    const order = tiles.get('hub')!.cell.order
    expect(['a', 'b', 'c'].map(key => path(tiles.get(key)!, order)).every(digits => digits.length === 1 && digits[0] !== 0)).toBe(true)
  })
  it('fills a childless thread with its pages, largest when fewest', () => {
    const lone = byKeyOf(seed('t', { files: ['a'] })), order = lone.get('t')!.cell.order
    expect(path(lone.get('lead\u0000t')!, order)).toEqual([2])
    expect(path(lone.get('constitution\u0000t')!, order)).toEqual([1, 3])
    expect(path(lone.get('file\u0000t\u0000a')!, order)).toEqual([0])
    const many = byKeyOf(seed('t', { files: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }))
    const cells = [...many.values()].filter(tile => tile.kind === 'file')
    expect(new Set(cells.map(tile => tile.cell.order)).size).toBe(1)
    expect(cells[0].cell.order).toBe(many.get('t')!.cell.order + 2)
  })
  it('fills the live region of a family', () => {
    for (const count of [3, 5, 8, 12, 17, 30, 45]) {
      const tiles = byKeyOf(seed('hub', { kids: Array.from({ length: count }, (_, n) => seed(`k${n}`, { born: n })) }))
      const hub = tiles.get('hub')!.cell.order
      const share = Array.from({ length: count }, (_, n) => 4 ** (hub - tiles.get(`k${n}`)!.cell.order)).reduce((sum, area) => sum + area, 0)
      expect(share).toBeGreaterThan(.75 * .75)
      expect(share).toBeLessThanOrEqual(.75)
    }
  })
  it('gathers an area of two or more families, and leaves a lone one in its province', () => {
    const root = (key: string): ThreadSeed => seed(key)
    const roots = assign([{ name: 'p', families: [
      { band: 'settled', root: root('a'), area: 'felt' }, { band: 'settled', root: root('b'), area: 'felt' }, { band: 'settled', root: root('c'), area: 'solo' }, { band: 'settled', root: root('d') },
    ] }])
    const kinds = roots[0].kids.map(kid => `${kid.kind}:${kid.kids.length ? kid.kids.filter(inner => inner.kind === 'thread').length : ''}`).sort()
    expect(roots[0].kids.filter(kid => kid.kind === 'area')).toHaveLength(1)
    expect(roots[0].kids.find(kid => kid.kind === 'area')!.kids.map(kid => kid.key).sort()).toEqual(['a', 'b'])
    expect(kinds).toContain('thread:0')
  })
  it('gives more work more area, and compresses it', () => {
    expect([0, 3, 15, 63, 4000].map(weightClass)).toEqual([0, 1, 2, 3, 3])
    const kids = [seed('heavy', { weight: 60, born: 9 }), ...[1, 2, 3, 4].map(n => seed(`light-${n}`, { born: n }))]
    const tiles = byKeyOf(seed('hub', { kids }))
    expect(tiles.get('heavy')!.cell.order).toBeLessThan(Math.max(...[1, 2, 3, 4].map(n => tiles.get(`light-${n}`)!.cell.order)))
  })
})

describe('stability', () => {
  it('does not depend on the order the feed arrives in', () => {
    const projects = fleet(11), shuffled = [...projects].reverse().map(project => ({ ...project, families: [...project.families].reverse() }))
    expect(cells(assign(shuffled))).toEqual(cells(assign(projects)))
  })
  it('is a pure function of the fleet', () => {
    expect(cells(assign(fleet(12)))).toEqual(cells(assign(fleet(12))))
  })
  it('leaves other families unmoved when a thread is added', () => {
    for (let seed = 20; seed < 32; seed++) {
      const projects = fleet(seed), before = cells(assign(projects))
      const family = projects[0].families[0]
      const grown = projects.map((project, n) => n ? project : { ...project, families: [{ ...family, root: { ...family.root, kids: [...family.root.kids, { key: 'brand-new', weight: 0, born: 2e9, live: true, kids: [], files: [] }] } }, ...project.families.slice(1)] })
      const after = cells(assign(grown))
      let moved = 0, total = 0
      for (const [key, cell] of before) {
        if (key.startsWith(family.root.key) || key.includes(`\u0000${family.root.key}`)) continue
        total++
        const now = after.get(key)!
        if (uniq(now) !== uniq(cell) && !nested(now, cell)) moved++
      }
      expect(moved / total).toBeLessThan(.04)
    }
  })
  it('keeps most siblings still as a family changes, and two in three new threads move nobody', () => {
    const place = (list: ThreadSeed[]): Map<string, number> => new Map([...tilesOf(assign([{ name: 'p', families: [{ band: 'flying', root: seed('hub', { kids: list }) }] }]))].filter(tile => tile.kind === 'thread').map(tile => [tile.key, uniq(tile.cell)]))
    let added = 0, settled = 0, still = 0, sizes = 0
    for (let count = 2; count < 50; count++, sizes++) {
      const kids = Array.from({ length: count }, (_, n) => seed(`thread-${n * 7}`, { born: n }))
      const before = place(kids), moved = (after: Map<string, number>): number => [...before].filter(([key, cell]) => key !== 'hub' && after.get(key) !== cell).length
      const fresh = moved(place([...kids, seed('new', { born: 99 })])), middle = Math.floor(count / 2)
      if (!fresh) still++
      added += fresh / count
      settled += Math.max(0, moved(place(kids.map((kid, n) => n === middle ? { ...kid, live: false } : kid))) - 1) / count
    }
    expect(still / sizes).toBeGreaterThan(.6)
    expect(added / sizes).toBeLessThan(.15)
    expect(settled / sizes).toBeLessThan(.25)
  })
  it('moves a family that changes state alone, nearly always', () => {
    const shares: number[] = []
    for (let seed = 60; seed < 72; seed++) {
      const projects = fleet(seed), before = cells(assign(projects))
      const family = projects[1].families[0], band: Band = family.band === 'flying' ? 'settled' : 'flying'
      const changed = projects.map((project, n) => n === 1 ? { ...project, families: [{ ...family, band }, ...project.families.slice(1)] } : project)
      const after = cells(assign(changed))
      const others = [...before].filter(([key]) => !key.startsWith(family.root.key) && !key.includes(`\u0000${family.root.key}`) && after.has(key))
      const moved = others.filter(([key, cell]) => { const now = after.get(key)!; return uniq(now) !== uniq(cell) && !nested(now, cell) })
      shares.push(moved.length / others.length)
    }
    // A band that crosses a size limit rescales in place, which is the worst case here.
    expect(shares.sort((a, b) => a - b)[6]).toBeLessThan(.02)
    expect(shares.at(-1)).toBeLessThan(.4)
  })
  it('keeps a brand-new file from moving anything but its own thread\'s insides', () => {
    const projects = fleet(7), before = cells(assign(projects)), family = projects[2].families[0]
    const key = family.root.key
    const added = projects.map((project, n) => n === 2 ? { ...project, families: [{ ...family, root: { ...family.root, files: [...family.root.files, 'one-more'] } }, ...project.families.slice(1)] } : project)
    const after = cells(assign(added))
    for (const [tile, cell] of before) if (!tile.includes(key)) expect(uniq(after.get(tile)!)).toBe(uniq(cell))
  })
})
