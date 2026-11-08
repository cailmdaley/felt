/**
 * Where everything sits on the sphere: the fleet as nested HEALPix cells. Pure.
 *
 * The twelve base pixels are three bands of four. The north holds families in
 * flight, the equator those at rest, the south those wholly finished, so a
 * family's latitude is its state and going south is going into the past. In a
 * band each project holds one cell, its province, and inside it each area the
 * ids name two or more families in holds another; the families lie inside those.
 *
 * A thread with threads gives them the north, west and east quadrants, three
 * quarters of its cell, so what is live gets the area. The south quadrant holds
 * the rest: its tapestry or report at the centre of the cell, its constitution
 * and files to the east of that, its settled threads below. When none of its
 * threads is live the settled ones take the three quadrants instead. A thread
 * with none keeps its north quadrant for its name, its tapestry to the west and
 * its files to the east and south, with its constitution at the east's corner.
 *
 * Sizes are powers of four and siblings are sized to fill their region, the
 * heavier and fuller first, so a buddy allocator, largest first, always fits
 * them. Each sibling follows a path of quadrants drawn from a hash of its
 * persistent id, the eldest choosing first and taking the first free cell of
 * its size along its path. So a new thread takes what is left and moves nobody,
 * a thread that changes state moves almost alone, and a cell that grows or
 * shrinks stays on its own path.
 */
import { EAST, NORTH, SOUTH, WEST, baseCell, child, uniq, type Cell, type Digit } from './healpix.js'

const BANDS = ['flying', 'resting', 'settled'] as const
export type Band = typeof BANDS[number]

export interface ThreadSeed {
  /** The persistent id placement is hashed from. */
  key: string
  weight: number
  /** When it began: elders choose their places first. */
  born: number
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
/** No family is larger than a cell of this order: flat enough to read, with ocean around it. */
const FAMILY_ORDER = 2
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
/** The orders that fill `regions` with `items`, best first: everyone at the smallest size, then larger in turn while room remains. */
function filling(items: readonly Sized[], regions: readonly Cell[]): Map<Sized, number> {
  const top = regions[0].order, room = regions.length * 4 ** -top
  let level = top
  while (items.length * 4 ** -level > room) level++
  const orders = new Map(items.map(item => [item, level]))
  let used = items.length * 4 ** -level, grew = true
  const ranked = [...items].sort((a, b) => claimed(b.span) - claimed(a.span) || a.seed.born - b.seed.born || (a.seed.key < b.seed.key ? -1 : 1))
  while (grew) {
    grew = false
    for (const item of ranked) {
      const order = orders.get(item)!
      if (order <= top || used + 3 * 4 ** -order > room) continue
      orders.set(item, order - 1)
      used += 3 * 4 ** -order
      grew = true
    }
  }
  return orders
}

interface Sized { seed: ThreadSeed; span: number; main: Sized[]; rest: Sized[] }
/** A cell of `count` files in regions that hold `slots(order)` of them at each order below their thread. */
const fileOrder = (start: number, count: number, slots: (order: number) => number): number => {
  let order = start
  while (slots(order) < count) order++
  return order
}
/** Files a childless thread holds at an order below it: its south quadrant, then with three-quarters of its east. */
const leafSlots = (below: number): number => 4 ** (below - 1) + (below > 1 ? 3 * 4 ** (below - 2) : 0)
function sized(seed: ThreadSeed): Sized {
  const kids = seed.kids.map(sized)
  const live = kids.filter(kid => kid.seed.live)
  const main = live.length ? live : kids, rest = live.length ? kids.filter(kid => !kid.seed.live) : []
  const inner = kids.length ? 1 + holding(main.map(kid => claimed(kid.span))) : 0
  const span = Math.max(BASE_SPAN + weightClass(seed.weight), inner, rest.length ? holding(rest.map(kid => claimed(kid.span))) : 0, BASE_SPAN + (seed.files.length > 7 ? 1 : 0))
  return { seed, span, main, rest }
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

interface Claim { key: string; order: number; born?: number }
/** Gives each claim a free cell of its order inside `regions`, largest and then eldest first. Claims must fit, which largest-first guarantees. */
function allot(regions: readonly Cell[], claims: readonly Claim[]): Map<string, Cell> {
  const taken = new Map<number, 'full' | 'part'>(), out = new Map<string, Cell>()
  const base = regions[0].order
  const claim = (cell: Cell, key: string, seed: number, order: number): Cell | null => {
    const id = uniq(cell), state = taken.get(id)
    if (state === 'full' || cell.order > order) return null
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
  for (const { key, order } of [...claims].sort((a, b) => a.order - b.order || (a.born ?? 0) - (b.born ?? 0) || (a.key < b.key ? -1 : 1))) {
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
  const { key, files } = item.seed
  const threads = (kids: readonly Sized[], regions: Cell[]): void => {
    const orders = filling(kids, regions)
    const spots = allot(regions, kids.map(kid => ({ key: kid.seed.key, order: orders.get(kid)!, born: kid.seed.born })))
    for (const kid of kids) placeThread(kid, spots.get(kid.seed.key)!, tile, band)
  }
  const pages = (regions: Cell[], order: number): void => {
    const spots = allot(regions, files.map(file => ({ key: file, order })))
    for (const file of files) hold(`file\u0000${key}\u0000${file}`, 'file', spots.get(file)!)
  }
  const south = child(cell, SOUTH), east = child(cell, EAST)
  if (item.main.length) {
    const shelf = child(south, EAST)
    hold(`lead\u0000${key}`, 'lead', child(south, NORTH))
    hold(`constitution\u0000${key}`, 'constitution', child(shelf, NORTH))
    pages([SOUTH, EAST, WEST].map(digit => child(shelf, digit as Digit)), fileOrder(shelf.order + 1, files.length, order => 3 * 4 ** (order - shelf.order - 1)))
    threads(item.main, [NORTH, WEST, EAST].map(digit => child(cell, digit as Digit)))
    threads(item.rest, [WEST, SOUTH].map(digit => child(south, digit as Digit)))
    return tile
  }
  hold(`lead\u0000${key}`, 'lead', child(cell, WEST))
  hold(`constitution\u0000${key}`, 'constitution', child(east, NORTH))
  pages([south, ...[SOUTH, EAST, WEST].map(digit => child(east, digit as Digit))], fileOrder(south.order, files.length, order => leafSlots(order - cell.order)))
  return tile
}

const firstFace: Record<Band, number> = { flying: 0, resting: 4, settled: 8 }

interface Group { key: string; inner: number; here: Sized[] }
const groupOf = (key: string, here: Sized[]): Group => ({ key, here, inner: holding(here.map(family => claimed(family.span))) })
function placeFamilies(group: Group, tile: Tile): void {
  const spots = allot([tile.cell], group.here.map(family => ({ key: family.seed.key, order: Math.max(FAMILY_ORDER, tile.cell.order + group.inner - claimed(family.span)) })))
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
        ...loose.map(family => ({ key: family.seed.key, order: Math.max(FAMILY_ORDER, cell.order + inner - claimed(family.span)) })),
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
