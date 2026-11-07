/**
 * Where everything sits on the sphere: the fleet as nested HEALPix cells. Pure.
 *
 * The twelve base pixels are three bands of four. The north holds families in
 * flight, the equator those at rest, the south those wholly finished, so a
 * family's latitude is its state and going south is going into the past. In a
 * band each project holds one cell, its province, and inside it each area the
 * ids name two or more families in holds another; the families lie inside those.
 *
 * A thread's cell always splits the same way: live threads to the north,
 * settled ones to the south, its tapestry or report to the west, its files to
 * the east with its constitution at the north corner of those. A cell is as
 * big as it must be to hold what it holds, and heavier work takes more of it.
 *
 * Sizes are powers of four and each set of siblings sums to at most its region,
 * so a buddy allocator, largest first, always fits them. Each sibling follows
 * a path of quadrants drawn from a hash of its persistent id, taking the first
 * free cell of its size along it. So a place depends on who is there and not on
 * the order they came: a new neighbour takes empty cells, a thread that changes
 * state moves alone, and a cell that grows or shrinks stays on its own path.
 */
import { EAST, NORTH, SOUTH, WEST, baseCell, child, uniq, type Cell, type Digit } from './healpix.js'

export const BANDS = ['flying', 'resting', 'settled'] as const
export type Band = typeof BANDS[number]

export interface ThreadSeed {
  /** The persistent id placement is hashed from. */
  key: string
  weight: number
  /** It or something under it is still in play. */
  live: boolean
  kids: readonly ThreadSeed[]
  /** Persistent ids of its sent files. */
  files: readonly string[]
}
export interface FamilySeed { band: Band; root: ThreadSeed; area?: string }
export interface ProjectSeed { name: string; families: readonly FamilySeed[] }

export type TileKind = 'province' | 'area' | 'thread' | 'lead' | 'constitution' | 'file'
export interface Tile {
  /** The seed's key, its kind and owner where a key alone would not be unique. */
  key: string
  kind: TileKind
  cell: Cell
  parent: Tile | null
  kids: Tile[]
  band: Band
}

/** A bare thread's span: its cell in orders above its smallest item. */
const BASE_SPAN = 2
const HEAVIEST = 3
const SHARE_POWER = .6
/** Compressed mass of work as extra orders: a quadruple of work is one more order, up to a limit, so nothing vanishes. */
export const weightClass = (weight: number): number => Math.min(HEAVIEST, Math.floor(Math.log2(1 + weight) / 2))

/**
 * What a sibling claims of its parent, as a span: a compression of what it
 * holds, so a hub of a hundred threads outweighs a lone thread without
 * reducing it to a speck. Only shares matter, since a cell's insides scale with it.
 */
const claimed = (span: number): number => Math.ceil(span * SHARE_POWER)

/** The span of the smallest region that holds cells of these spans. */
function holding(spans: readonly number[]): number {
  const total = spans.reduce((sum, span) => sum + 4 ** span, 0)
  let span = 0
  while (4 ** span < total) span++
  return span
}
/** The smallest span at which a thread's three file quadrants hold `count` files. */
const fileSpan = (count: number): number => {
  let span = 0
  while (3 * 4 ** span < count) span++
  return span
}

interface Sized { seed: ThreadSeed; span: number; north: Sized[]; south: Sized[]; northSpan: number; southSpan: number }
function sized(seed: ThreadSeed): Sized {
  const kids = seed.kids.map(sized)
  const north = kids.filter(kid => kid.seed.live), south = kids.filter(kid => !kid.seed.live)
  const northSpan = holding(north.map(kid => claimed(kid.span))), southSpan = holding(south.map(kid => claimed(kid.span)))
  const span = Math.max(BASE_SPAN + weightClass(seed.weight), north.length ? northSpan + 1 : 0, south.length ? southSpan + 1 : 0, BASE_SPAN + fileSpan(seed.files.length))
  return { seed, span, north, south, northSpan, southSpan }
}

/** FNV-1a through a finalizer, so that one id's quadrants are independent order by order. */
function hashed(text: string): number {
  let hash = 0x811c9dc5
  for (let n = 0; n < text.length; n++) hash = Math.imul(hash ^ text.charCodeAt(n), 0x01000193)
  return mix(hash)
}
function mix(value: number): number {
  let hash = value ^ value >>> 16
  hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  return (hash ^ hash >>> 16) >>> 0
}
const QUADRANTS: readonly (readonly Digit[])[] = [...function* () {
  const digits: Digit[] = [0, 1, 2, 3]
  for (const a of digits) for (const b of digits) for (const c of digits) for (const d of digits) if (new Set([a, b, c, d]).size === 4) yield [a, b, c, d]
}()]

interface Claim { key: string; order: number }
/** Gives each claim a free cell of its order inside `regions`. Claims must fit, which largest-first guarantees given the spans above. */
function allot(regions: readonly Cell[], claims: readonly Claim[]): Map<string, Cell> {
  const taken = new Map<number, 'full' | 'part'>(), out = new Map<string, Cell>()
  const base = regions[0].order
  const claim = (cell: Cell, key: string, seed: number, order: number): Cell | null => {
    const id = uniq(cell), state = taken.get(id)
    if (state === 'full') return null
    if (cell.order === order) {
      if (state) return null
      taken.set(id, 'full')
      return cell
    }
    for (const digit of QUADRANTS[mix(seed + cell.order - base) % 24]) {
      const found = claim(child(cell, digit), key, seed, order)
      if (found) { taken.set(id, 'part'); return found }
    }
    return null
  }
  for (const { key, order } of [...claims].sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : 1))) {
    const seed = hashed(key), start = seed % regions.length
    for (let n = 0; n < regions.length; n++) {
      const found = claim(regions[(start + n) % regions.length], key, seed, order)
      if (found) { out.set(key, found); break }
    }
  }
  return out
}

function placeThread(item: Sized, cell: Cell, parent: Tile, band: Band): Tile {
  const tile: Tile = { key: item.seed.key, kind: 'thread', cell, parent, kids: [], band }
  parent.kids.push(tile)
  const hold = (key: string, kind: TileKind, at: Cell): void => { tile.kids.push({ key, kind, cell: at, parent: tile, kids: [], band }) }
  const west = child(cell, WEST), east = child(cell, EAST)
  hold(`lead\u0000${item.seed.key}`, 'lead', west)
  hold(`constitution\u0000${item.seed.key}`, 'constitution', child(east, NORTH))
  const fileOrder = east.order + 1 + fileSpan(item.seed.files.length)
  const spots = allot([SOUTH, EAST, WEST].map(digit => child(east, digit as Digit)), item.seed.files.map(key => ({ key, order: fileOrder })))
  for (const key of item.seed.files) hold(`file\u0000${item.seed.key}\u0000${key}`, 'file', spots.get(key)!)
  for (const [kids, region, span] of [[item.north, child(cell, NORTH), item.northSpan], [item.south, child(cell, SOUTH), item.southSpan]] as const) {
    const spots = allot([region], kids.map(kid => ({ key: kid.seed.key, order: region.order + span - claimed(kid.span) })))
    for (const kid of kids) placeThread(kid, spots.get(kid.seed.key)!, tile, band)
  }
  return tile
}

const firstFace: Record<Band, number> = { flying: 0, resting: 4, settled: 8 }

interface Group { key: string; inner: number; here: Sized[] }
const groupOf = (key: string, here: Sized[]): Group => ({ key, here, inner: holding(here.map(family => claimed(family.span))) })
function placeFamilies(group: Group, tile: Tile): void {
  const spots = allot([tile.cell], group.here.map(family => ({ key: family.seed.key, order: tile.cell.order + group.inner - claimed(family.span) })))
  for (const family of group.here) placeThread(family, spots.get(family.seed.key)!, tile, tile.band)
}

/** The fleet's tiles: one root for each project's province in each band, with everything under them. */
export function assign(projects: readonly ProjectSeed[]): Tile[] {
  const roots: Tile[] = []
  for (const band of BANDS) {
    const provinces = projects.flatMap(({ name, families }) => {
      const here = families.filter(family => family.band === band)
      if (!here.length) return []
      const byArea = new Map<string, FamilySeed[]>()
      for (const family of here) if (family.area) byArea.set(family.area, [...byArea.get(family.area) ?? [], family])
      const areas = [...byArea].filter(([, members]) => members.length > 1).map(([area, members]) => groupOf(area, members.map(family => sized(family.root))))
      const loose = here.filter(family => !family.area || (byArea.get(family.area)?.length ?? 0) < 2).map(family => sized(family.root))
      const inner = holding([...areas.map(area => claimed(area.inner)), ...loose.map(family => claimed(family.span))])
      return [{ name, areas, loose, inner }]
    })
    if (!provinces.length) continue
    const spans = provinces.map(province => claimed(province.inner))
    let scale = Math.max(...spans)
    while (4 * 4 ** scale < spans.reduce((sum, span) => sum + 4 ** span, 0)) scale++
    const faces = [0, 1, 2, 3].map(k => baseCell(firstFace[band] + k))
    const spots = allot(faces, provinces.map(province => ({ key: province.name, order: scale - claimed(province.inner) })))
    for (const { name, areas, loose, inner } of provinces) {
      const cell = spots.get(name)!
      const province: Tile = { key: `province\u0000${band}\u0000${name}`, kind: 'province', cell, parent: null, kids: [], band }
      roots.push(province)
      const inside = allot([cell], [
        ...areas.map(area => ({ key: `area\u0000${area.key}`, order: cell.order + inner - claimed(area.inner) })),
        ...loose.map(family => ({ key: family.seed.key, order: cell.order + inner - claimed(family.span) })),
      ])
      for (const family of loose) placeThread(family, inside.get(family.seed.key)!, province, band)
      for (const area of areas) {
        const tile: Tile = { key: `area\u0000${band}\u0000${name}\u0000${area.key}`, kind: 'area', cell: inside.get(`area\u0000${area.key}`)!, parent: province, kids: [], band }
        province.kids.push(tile)
        placeFamilies(area, tile)
      }
    }
  }
  return roots
}

/** Every tile under the roots, parents first. */
export function* tilesOf(roots: readonly Tile[]): Generator<Tile> {
  for (const root of roots) {
    yield root
    yield* tilesOf(root.kids)
  }
}
