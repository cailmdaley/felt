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
  return { key: prefix, weight: Math.floor(random() ** 3 * 90), live: random() < .4, kids, files }
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
    expect(deepest).toBeLessThanOrEqual(16)
  })
  it('lays out a thread by the same pattern at every level', () => {
    const live = (key: string): ThreadSeed => ({ key, weight: 0, live: true, kids: [], files: [] })
    const settled = (key: string): ThreadSeed => ({ ...live(key), live: false })
    const hub: ThreadSeed = { key: 'hub', weight: 0, live: true, files: ['a', 'b'], kids: [
      { ...live('mid'), files: ['c'], kids: [live('leaf'), settled('old')] }, settled('done'),
    ] }
    const roots = assign([{ name: 'p', families: [{ band: 'flying', root: hub }] }]), byKey = new Map([...tilesOf(roots)].map(tile => [tile.key, tile]))
    const digit = (tile: Tile, order: number): number => {
      let cell = tile.cell
      while (cell.order > order + 1) cell = parent(cell)
      return (cell.x % 2) + 2 * (cell.y % 2)
    }
    for (const owner of ['hub', 'mid']) {
      const body = byKey.get(owner)!, order = body.cell.order
      expect(digit(byKey.get(`lead\u0000${owner}`)!, order)).toBe(2)
      expect(byKey.get(`lead\u0000${owner}`)!.cell.order).toBe(order + 1)
      expect(digit(byKey.get(`constitution\u0000${owner}`)!, order)).toBe(1)
      expect(byKey.get(`constitution\u0000${owner}`)!.cell.order).toBe(order + 2)
    }
    expect(digit(byKey.get('mid')!, byKey.get('hub')!.cell.order)).toBe(3)
    expect(digit(byKey.get('done')!, byKey.get('hub')!.cell.order)).toBe(0)
    expect(digit(byKey.get('leaf')!, byKey.get('mid')!.cell.order)).toBe(3)
    expect(digit(byKey.get('old')!, byKey.get('mid')!.cell.order)).toBe(0)
    expect(digit(byKey.get('file\u0000hub\u0000a')!, byKey.get('hub')!.cell.order)).toBe(1)
  })
  it('gathers an area of two or more families, and leaves a lone one in its province', () => {
    const root = (key: string): ThreadSeed => ({ key, weight: 0, live: true, kids: [], files: [] })
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
    const light: ThreadSeed = { key: 'light', weight: 0, live: true, kids: [], files: [] }, heavy: ThreadSeed = { ...light, key: 'heavy', weight: 60 }
    const roots = assign([{ name: 'p', families: [{ band: 'flying', root: light }, { band: 'flying', root: heavy }] }])
    const [a, b] = roots[0].kids
    expect(a.key === 'heavy' ? a.cell.order < b.cell.order : b.cell.order < a.cell.order).toBe(true)
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
      const grown = projects.map((project, n) => n ? project : { ...project, families: [{ ...family, root: { ...family.root, kids: [...family.root.kids, { key: 'brand-new', weight: 0, live: true, kids: [], files: [] }] } }, ...project.families.slice(1)] })
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
