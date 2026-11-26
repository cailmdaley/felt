// Pure axial geometry for the whole-loom atlas. Three aperture-4 LOD tiers,
// one orientation: level-1 coarse cells dilate by 2 into level-2 fine tiles,
// and deep nested level-2 tiles dilate by 2 again into level-3 micro-hexes
// (determinant four per tier, zero rotation at every scale).
import type {
  AreaInput,
  AtlasLayout,
  Axial,
  BiomeId,
  CoarseCell,
  FineTile,
  GraphLink,
  HeightMode,
  Isthmus,
  LandRoad,
  MapConfig,
  MapSeaEntry,
  MicroHex,
  PlacedArea,
  PlacedCity,
  PlacedContinent,
  RiverRoute,
  SeaLane,
  SeaLanePoint,
  TerrainBundle,
  WorldXZ,
} from './types.js'

export const DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [1, -1],
]
export const SUB_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
]
export const BIOME_IDS: readonly BiomeId[] = ['mediterranean', 'temperate', 'savanna', 'nordic']
export const RADIUS = 1.12

export const key = ({ q, r }: Axial): string => `${q},${r}`
export const distance = (a: Axial, b: Axial = { q: 0, r: 0 }): number =>
  Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r))
export const nest = ({ q, r }: Axial, level = 1): Axial => ({
  q: q * 2 ** level,
  r: r * 2 ** level,
})
export const world = ({ q, r }: Axial, radius = RADIUS): WorldXZ => ({
  x: Math.sqrt(3) * radius * (q + r / 2),
  z: 1.5 * radius * r,
})

export function hash(s: string): number {
  let h = 2166136261
  const str = String(s)
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619)
  }
  return (h >>> 0) / 4294967296
}

export function round({ q, r }: Axial): Axial {
  let x = Math.round(q)
  let z = Math.round(r)
  const y = Math.round(-q - r)
  const dx = Math.abs(x - q)
  const dz = Math.abs(z - r)
  const dy = Math.abs(y + q + r)
  if (dx > dy && dx > dz) x = -y - z
  else if (dy <= dz) z = -x - y
  return { q: x + 0, r: z + 0 }
}

/** The parent cell in the next-coarser aperture-4 tier: nearest dilated centre. */
export const parent = ({ q, r }: Axial): Axial => round({ q: q / 2, r: r / 2 })

/** The four exact child cells in the next-finer aperture-4 tier (parent(c) == p). */
export const children = (p: Axial): Axial[] => {
  const f = nest(p)
  return SUB_OFFSETS.map(([dq, dr]) => ({ q: f.q + dq, r: f.r + dr }))
}

export const unworld = ({ x, z }: WorldXZ, radius = RADIUS): Axial =>
  round({ q: ((Math.sqrt(3) / 3) * x - z / 3) / radius, r: ((2 / 3) * z) / radius })

export function disk(radius: number): Axial[] {
  const out: Axial[] = []
  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      if (distance({ q, r }) <= radius) out.push({ q, r })
    }
  }
  return out.sort(
    (a, b) =>
      distance(a) - distance(b) || Math.atan2(world(a).z, world(a).x) - Math.atan2(world(b).z, world(b).x),
  )
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export function birth(node: { uid?: string; id?: string; createdAt?: string }): number {
  const uid = node.uid || node.id || ''
  if (/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(uid)) {
    let n = 0
    for (const c of uid.slice(0, 10).toUpperCase()) n = n * 32 + ALPHABET.indexOf(c)
    return n
  }
  const parsed = Date.parse(node.createdAt || '')
  return Number.isFinite(parsed) ? parsed : -62135596800000
}

const eldest = (a: { uid?: string; id: string; createdAt?: string }, b: { uid?: string; id: string; createdAt?: string }): number =>
  birth(a) - birth(b) || String(a.uid || a.id).localeCompare(String(b.uid || b.id))
const add = (a: Axial, b: Axial): Axial => ({ q: a.q + b.q, r: a.r + b.r })
const sub = (a: Axial, b: Axial): Axial => ({ q: a.q - b.q, r: a.r - b.r })
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const pairKey = (a: string, b: string): string => [a, b].sort(cmp).join('↔')

const radiusFor = (n: number): number => {
  let r = 0
  while (3 * r * r + 3 * r + 1 < n) r++
  return r
}

/**
 * Land footprint scales with top-level breadth (sprawl vs. compact depth) plus
 * log mass; vertical elevation is driven orthogonally by heightMode.
 */
export function landCells(c: {
  kind?: string
  total?: number
  cities?: number
  topLevelBreadth?: number
}): number {
  if (c.kind === 'shoals') return 2
  const L = Math.log2(1 + (c.total || 0))
  const base = Math.round(2.4 * L ** 1.5)
  const breadth = c.topLevelBreadth ?? Math.max(1, Math.round(L))
  const B = Math.log2(1 + breadth)
  const raw = Math.round(1.9 * L ** 1.48 + 1.55 * B ** 1.55)
  const r0 = radiusFor(Math.max(3, base, Math.ceil((c.cities || 0) / 3.2)))
  const minRing = r0 > 0 ? 3 * (r0 - 1) * (r0 - 1) + 3 * (r0 - 1) + 2 : 1
  const maxRing = 3 * r0 * r0 + 3 * r0 + 1
  const extremeFlat = breadth > 2.2 * L && breadth >= 45
  const extremeDeep = breadth <= 3 && (c.total || 0) >= 100
  const clamped = extremeFlat || extremeDeep ? raw : Math.min(maxRing, Math.max(minRing, raw))
  return Math.max(3, clamped, Math.ceil((c.cities || 0) / 3.2))
}

/**
 * Minimum coarse distance between two continent centres: each continent's
 * core land stays within rc+1 of its centre, leaving a 3-coarse-cell channel
 * that either remains open ocean (>=2 fine sea hexes) or is bridged by a
 * plate-tectonic peninsula/isthmus when strongly linked within a supercontinent.
 */
const buffer = (a: { rc: number }, b: { rc: number }): number => a.rc + b.rc + 5

const BIOME_ALIASES: Record<string, BiomeId> = {
  mediterranean: 'mediterranean',
  science: 'mediterranean',
  temperate: 'temperate',
  'mill-ai': 'temperate',
  forest: 'temperate',
  savanna: 'savanna',
  'life-guild': 'savanna',
  autumn: 'savanna',
  nordic: 'nordic',
  boreal: 'nordic',
  taiga: 'nordic',
}

/** Map a sea/biome label (or fallback continent id) deterministically to one of the 4 biome palettes. */
export function normalizeBiome(label: string | undefined, fallbackKey: string): BiomeId {
  const norm = label?.trim().toLowerCase()
  if (norm && BIOME_ALIASES[norm]) return BIOME_ALIASES[norm]
  const seedKey = norm || fallbackKey
  return BIOME_IDS[Math.floor(hash(`biome:${seedKey}`) * BIOME_IDS.length) % BIOME_IDS.length]
}

interface ResolvedSeaInfo {
  sea: string | null
  biome: BiomeId
  anchor?: WorldXZ
}

function resolveSeaEntry(id: string, entry: MapSeaEntry | undefined): ResolvedSeaInfo {
  if (!entry) {
    return { sea: null, biome: normalizeBiome(undefined, id) }
  }
  if (typeof entry === 'string') {
    return { sea: entry, biome: normalizeBiome(entry, id) }
  }
  const sea = entry.sea ?? entry.biome ?? null
  const biome = normalizeBiome(entry.biome ?? entry.sea, id)
  const anchor =
    typeof entry.x === 'number' && Number.isFinite(entry.x) && typeof entry.z === 'number' && Number.isFinite(entry.z)
      ? { x: entry.x, z: entry.z }
      : undefined
  return { sea, biome, anchor }
}

/** Resolve a continent's biome from a continent lookup map or deterministic fallback hash. */
export function biomeOf(
  continentId: string | undefined,
  contMap?: ReadonlyMap<string, { biome?: BiomeId }>,
): BiomeId {
  if (!continentId) return 'mediterranean'
  const mapped = contMap?.get(continentId)?.biome
  if (mapped) return mapped
  return normalizeBiome(undefined, continentId)
}

interface WorkingContinent {
  id: string
  name: string
  kind: string
  shared?: boolean
  stores?: string[]
  total: number
  cities: number
  citedBy?: number
  maxDepth?: number
  topLevelBreadth: number
  decisionCount?: number
  recentRatio?: number
  lastUpdated?: string | null
  sea: string
  explicitSea: string | null
  biome: BiomeId
  anchor?: WorldXZ
  coarse: number
  rc: number
  q: number
  r: number
}

// Deterministic regional-sea + domain-wikilink spring layout: continents
// organize by optional mapConfig sea anchors while domain wikilinks pull linked
// partners together naturally.
function placeProjects(projects: WorkingContinent[], links: GraphLink[]): Axial[] {
  const n = projects.length
  if (n === 0) return []
  const idx = new Map(projects.map((c, i) => [c.id, i]))
  const max = Math.max(1, ...links.map(l => l.w))
  const pull = new Map<string, number>()
  for (const l of links) {
    const ia = idx.get(l.a)
    const ib = idx.get(l.b)
    if (ia !== undefined && ib !== undefined) {
      pull.set(`${Math.min(ia, ib)},${Math.max(ia, ib)}`, (l.w / max) ** 0.75)
    }
  }
  const s = (i: number, j: number): number => pull.get(`${Math.min(i, j)},${Math.max(i, j)}`) || 0
  const P = projects.map((c, i) => {
    if (c.anchor) return { x: c.anchor.x, z: c.anchor.z }
    const a = i * 2.39996
    const d = i ? 7 * Math.sqrt(i) * 3 : 0
    return { x: Math.cos(a) * d, z: Math.sin(a) * d }
  })
  const sameSeaOf = (i: number, j: number): boolean =>
    Boolean(projects[i].explicitSea && projects[i].explicitSea === projects[j].explicitSea)
  const want = (i: number, j: number): number =>
    (sameSeaOf(i, j) ? 1.08 : 1.32) * buffer(projects[i], projects[j])

  for (let it = 0; it < 1400; it++) {
    const cool = it < 1000 ? 1 : Math.max(0, (1400 - it) / 400)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = P[j].x - P[i].x
        const dz = P[j].z - P[i].z
        const d = Math.hypot(dx, dz) || 1e-6
        const w = want(i, j)
        const ux = dx / d
        const uz = dz / d
        let f = 0
        if (d < w) {
          f = -(w - d) * 0.52
        } else {
          const k = s(i, j)
          const sameSea = sameSeaOf(i, j)
          const linkPull = sameSea ? Math.max(k, 0.25) : k * 0.35
          f = linkPull ? 0.11 * linkPull * (d - w) * cool : -Math.min(0.8, 10 / (d * d)) * cool
        }
        P[i].x += ux * f
        P[i].z += uz * f
        P[j].x -= ux * f
        P[j].z -= uz * f
      }
    }
    for (let i = 0; i < n; i++) {
      const anc = projects[i].anchor
      if (anc) {
        P[i].x += (anc.x - P[i].x) * 0.045 * cool
        P[i].z += (anc.z - P[i].z) * 0.045 * cool
      } else {
        P[i].x *= 1 - 0.006 * cool
        P[i].z *= 1 - 0.006 * cool
      }
    }
  }
  return P.map(p => round({ q: (Math.sqrt(3) / 3) * p.x - p.z / 3, r: (2 / 3) * p.z }))
}

// The nearest lattice cell (by hex distance, then address) that keeps every
// core continent buffer open; continents already placed never move.
function settle(c: WorkingContinent, placed: WorkingContinent[]): void {
  const ok = (p: Axial): boolean => placed.every(o => distance(p, o) >= buffer(c, o))
  for (let ring = 0; ring < 200; ring++) {
    const hits = disk(ring)
      .filter(d => distance(d) === ring)
      .map(d => ({ q: c.q + d.q, r: c.r + d.r }))
      .filter(ok)
    if (hits.length) {
      const best = hits.sort((a, b) => cmp(key(a), key(b)))[0]
      c.q = best.q
      c.r = best.r
      return
    }
  }
  throw new Error(`Cannot settle ${c.id}`)
}

function shortest(
  from: Axial,
  goal: (p: Axial) => boolean,
  cells: Set<string> | Map<string, unknown>,
  cost: (p: Axial) => number = () => 1,
): Axial[] {
  const start = key(from)
  const dist = new Map<string, number>([[start, 0]])
  const prev = new Map<string, Axial | null>([[start, null]])
  const open: Array<[number, Axial]> = [[0, from]]
  while (open.length) {
    let bi = 0
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i
    const [d, p] = open.splice(bi, 1)[0]
    if (d > (dist.get(key(p)) ?? Infinity)) continue
    if (goal(p)) {
      const out: Axial[] = []
      let x: Axial | null = p
      while (x) {
        out.unshift(x)
        x = prev.get(key(x)) ?? null
      }
      return out
    }
    for (const [dq, dr] of DIRECTIONS) {
      const np = { q: p.q + dq, r: p.r + dr }
      const k = key(np)
      if (!cells.has(k)) continue
      const nd = d + cost(np)
      if (nd < (dist.get(k) ?? Infinity)) {
        dist.set(k, nd)
        prev.set(k, p)
        open.push([nd, np])
      }
    }
  }
  throw new Error('Disconnected land path')
}

interface IsthmusCandidate {
  a: string
  b: string
  w: number
  sea: string
  dist: number
  score: number
}

// Select intra-supercontinent isthmus links: strong cross-links within a regional sea
// join major provinces (coarse >= 6) into connected multi-province supercontinents.
function selectIsthmusLinks(
  continents: WorkingContinent[],
  allDomainLinks: GraphLink[],
): IsthmusCandidate[] {
  const linkWeight = new Map<string, number>()
  for (const l of allDomainLinks) linkWeight.set(pairKey(l.a, l.b), l.w)
  const chosen: IsthmusCandidate[] = []
  const hasExplicitSeas = continents.some(c => c.explicitSea !== null)
  const seas = new Map<string, WorkingContinent[]>()
  for (const c of continents) {
    if (c.kind === 'shoals' || c.coarse < 6) continue
    const groupKey = hasExplicitSeas ? c.explicitSea : '__all__'
    if (!groupKey) continue
    let list = seas.get(groupKey)
    if (!list) {
      list = []
      seas.set(groupKey, list)
    }
    list.push(c)
  }
  const minWeight = hasExplicitSeas ? 7 : 12
  for (const [sea, provs] of seas) {
    if (provs.length < 2) continue
    const candidates: IsthmusCandidate[] = []
    for (let i = 0; i < provs.length; i++) {
      for (let j = i + 1; j < provs.length; j++) {
        const a = provs[i]
        const b = provs[j]
        const pk = pairKey(a.id, b.id)
        const w = linkWeight.get(pk) || 0
        const dist = distance(a, b) - a.rc - b.rc
        if (w >= minWeight && dist <= 9) {
          const score = (a.kind === 'project' && b.kind === 'project' ? 200 : 0) + w * 2 - dist * 12
          candidates.push({ a: a.id, b: b.id, w, sea: hasExplicitSeas ? sea : a.sea, dist, score })
        }
      }
    }
    candidates.sort((x, y) => y.score - x.score || cmp(pairKey(x.a, x.b), pairKey(y.a, y.b)))
    const comp = new Map(provs.map(c => [c.id, c.id]))
    const find = (x: string): string => {
      const p = comp.get(x)!
      if (p === x) return x
      const r = find(p)
      comp.set(x, r)
      return r
    }
    for (const e of candidates) {
      const ra = find(e.a)
      const rb = find(e.b)
      if (ra !== rb) {
        comp.set(ra, rb)
        chosen.push(e)
      }
    }
  }
  return chosen
}

export interface LayoutOptions {
  pins?: Record<string, Axial>
  lanes?: number
  heightMode?: HeightMode
  mapConfig?: MapConfig
}

interface ContinentPassState {
  C: Axial
  F: Axial
  h: number
  local: PlacedCity[]
  used: Set<string>
  blob: Map<string, Axial>
  areas: PlacedArea[]
  rest: AreaInput[]
  areaFor: Map<string, string>
  isthmusLocal: Set<string>
}

/**
 * Cities claim fine sites eldest-first near their family's coarse anchor; no
 * state, host, title, input order or land shape takes part, so younger
 * arrivals and state changes never move an existing city. Continent centres
 * come from the spring layout (or pins, in coarse axial coordinates).
 */
export function layout(
  bundle: TerrainBundle,
  { pins: optPins, lanes: laneCount = 10, heightMode = 'citations', mapConfig: optMapConfig }: LayoutOptions = {},
): AtlasLayout {
  const cities = bundle.cities || []
  if (new Set(cities.map(n => n.id)).size !== cities.length) throw new Error('Duplicate city id')
  const rawContinents = bundle.continents || []
  if (rawContinents.length === 0) {
    return {
      continents: [],
      fibers: [],
      tiles: [],
      cells: [],
      level1: [],
      level2: [],
      level3: [],
      roads: [],
      rivers: [],
      lanes: [],
      isthmuses: [],
      heightMode,
    }
  }

  const mapConfig = optMapConfig ?? bundle.mapConfig
  const pins: Record<string, Axial> = { ...(mapConfig?.pins ?? {}), ...(optPins ?? {}) }
  const seasConfig = mapConfig?.seas

  const areasBy = new Map<string, AreaInput[]>()
  for (const a of bundle.areas || []) {
    let arr = areasBy.get(a.continent)
    if (!arr) {
      arr = []
      areasBy.set(a.continent, arr)
    }
    arr.push(a)
  }

  const workingContinents: WorkingContinent[] = rawContinents
    .map(c => {
      const topLevelBreadth = c.topLevelBreadth ?? (areasBy.get(c.id)?.length || 1)
      const coarse = landCells({ ...c, topLevelBreadth })
      const resolved = resolveSeaEntry(c.id, seasConfig?.[c.id])
      return {
        ...c,
        sea: resolved.sea ?? resolved.biome,
        explicitSea: resolved.sea,
        biome: resolved.biome,
        anchor: resolved.anchor,
        topLevelBreadth,
        coarse,
        rc: radiusFor(coarse),
        q: 0,
        r: 0,
      }
    })
    .sort((a, b) => b.rc - a.rc || cmp(a.id, b.id))

  const byId = new Map(workingContinents.map(c => [c.id, c]))
  const projects = workingContinents.filter(c => c.kind === 'project')
  const domainLinks = bundle.domainLinks || []
  const domain = domainLinks.filter(
    l => byId.get(l.a)?.kind === 'project' && byId.get(l.b)?.kind === 'project',
  )
  placeProjects(projects, domain).forEach((p, i) => {
    projects[i].q = p.q
    projects[i].r = p.r
  })

  const placed: WorkingContinent[] = []
  for (const c of projects) {
    if (!pins[c.id]) settle(c, placed)
    placed.push(c)
  }

  const west = projects.length
    ? Math.min(...projects.map(c => world(c, 1).x - c.rc * 1.8))
    : 0
  const nonProjects = workingContinents.filter(c => c.kind !== 'project')
  // Place guild continents before shoals so shoals can anchor off a guild if one exists.
  nonProjects.sort((a, b) => (a.kind === 'guild' ? 0 : 1) - (b.kind === 'guild' ? 0 : 1) || cmp(a.id, b.id))
  for (const c of nonProjects) {
    const guild = workingContinents.find(x => x.kind === 'guild')
    const sameSeaProjects = projects.filter(p => p.sea === c.sea)
    const targetZ = sameSeaProjects.length
      ? sameSeaProjects.reduce((acc, p) => acc + world(p, 1).z, 0) / sameSeaProjects.length
      : 0
    let p: Axial
    if (c.anchor) {
      p = unworld(c.anchor, 1)
    } else if (c.kind === 'guild' || !guild || guild.id === c.id) {
      p = unworld({ x: west - (c.rc + 3) * 1.6, z: targetZ }, 1)
    } else {
      const gw = world(guild, 1)
      p = unworld({ x: gw.x + 2, z: gw.z + (guild.rc + c.rc + 5) * 1.55 }, 1)
    }
    c.q = p.q
    c.r = p.r
    if (!pins[c.id]) settle(c, placed)
    placed.push(c)
  }

  for (const [id, p] of Object.entries(pins)) {
    const c = byId.get(id)
    if (c) {
      c.q = p.q
      c.r = p.r
    }
  }

  for (let i = 0; i < workingContinents.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = workingContinents[i]
      const b = workingContinents[j]
      if (distance(a, b) < buffer(a, b)) throw new Error(`Ocean buffer violated: ${a.id} / ${b.id}`)
    }
  }

  const cityById = new Map(cities.map(n => [n.id, n]))
  const hasChildCity = new Set<string>()
  for (const n of cities) {
    if (n.parent) {
      const par = cityById.get(n.parent)
      if (par && birth(n) - birth(par) < 365 * 86400e3) {
        hasChildCity.add(n.parent)
      }
    }
  }

  // Summit-vs-foothills placement priority within each area:
  // Tier 0: high-citation summit fibers (citedBy >= 6) & orchestrators claim area peaks first.
  // Tier 1: mid-citation (citedBy >= 3) & parent fibers claim upper-ridge slopes next.
  // Tier 2: low-citation leaf tasks prefer lower-elevation foothill hexes.
  const summitTier = (n: { id: string; isOrchestrator?: boolean; citedBy?: number }): number =>
    n.isOrchestrator || (n.citedBy || 0) >= 6
      ? 0
      : (n.citedBy || 0) >= 3 || hasChildCity.has(n.id)
        ? 1
        : 2

  const fibers: PlacedCity[] = []
  const tiles: FineTile[] = []
  const cells: CoarseCell[] = []
  const level3: MicroHex[] = []
  const roads: LandRoad[] = []
  const rivers: RiverRoute[] = []
  const land = new Map<string, FineTile>()

  // ---- Pass 1: Stable city placement + core continent blobs + district Voronoi ----
  const stateByCont = new Map<string, ContinentPassState>()
  const globalCoarseOwner = new Map<string, string>()

  for (const c of workingContinents) {
    const C: Axial = { q: c.q, r: c.r }
    const F = nest(C)
    const h = hash(c.id)
    const byEldest = cities.filter(n => n.continent === c.id).sort(eldest)
    const used = new Set<string>()
    const families = new Map<string, Axial>()
    const slots = disk(Math.max(1, Math.floor(c.rc * 0.6)))
    const candidates: Axial[] = []
    for (const p of disk(2 * c.rc + 1)) {
      if (distance(parent(p)) <= c.rc) candidates.push(p)
    }
    for (const n of byEldest) {
      if (!families.has(n.area)) families.set(n.area, slots[families.size % slots.length])
    }
    const localSorted = byEldest.slice().sort((a, b) => summitTier(a) - summitTier(b) || eldest(a, b))
    const localPlaced: PlacedCity[] = []
    const rootDepth = c.id.split('/').length

    for (const n of localSorted) {
      const anchor = nest(families.get(n.area)!)
      const tier = summitTier(n)
      let best: Axial | null = null
      let bd = Infinity
      for (const p of candidates) {
        if (used.has(key(p))) continue
        const da = distance(p, anchor)
        const d =
          tier < 2
            ? da * 1000 + distance(p) * 12 + ((hash(n.area + key(p)) * 9) | 0)
            : (da < 2 ? (2 - da) * 2400 : (da - 2) * 1000) -
              Math.min(6, distance(p)) * 14 +
              ((hash(n.area + key(p)) * 9) | 0)
        if (d < bd || (d === bd && best !== null && key(p) < key(best))) {
          bd = d
          best = p
        }
      }
      if (!best) throw new Error(`Continent capacity exceeded: ${c.id}`)
      used.add(key(best))
      const abs = add(F, best)
      const depth = n.depth ?? Math.max(0, n.id.split('/').length - rootDepth)
      const placedCity: PlacedCity = {
        ...n,
        depth,
        summitTier: tier,
        ...abs,
        ...world(abs),
        local: best,
        elevation: 0.26,
        shared: Boolean(c.shared),
      }
      fibers.push(placedCity)
      localPlaced.push(placedCity)
    }

    const blob = new Map<string, Axial>()
    const noisy = (p: Axial): number => {
      const a = Math.atan2(world(p).z, world(p).x)
      return (
        distance(p) +
        c.rc * (0.16 * Math.sin(3 * a + h * 6.3) + 0.11 * Math.cos(5 * a + h * 2.1)) +
        hash(c.id + key(p)) * 0.45
      )
    }
    for (const p of disk(c.rc + 1)
      .sort((a, b) => noisy(a) - noisy(b) || cmp(key(a), key(b)))
      .slice(0, c.coarse)) {
      blob.set(key(p), p)
    }
    for (const k of used) {
      const [q, r] = k.split(',').map(Number)
      const p = parent({ q, r })
      blob.set(key(p), p)
    }
    for (const p of blob.values()) globalCoarseOwner.set(key(add(C, p)), c.id)

    const all = (areasBy.get(c.id) || [])
      .slice()
      .sort((a, b) => (b.citedBy || 0) - (a.citedBy || 0) || b.mass - a.mass || cmp(a.id, b.id))
    const named = all.slice(0, c.kind === 'guild' ? all.length : 7)
    const namedSet = new Set(named)
    const rest = all.filter(a => !namedSet.has(a))
    const areas: PlacedArea[] = named.map(a => ({
      ...a,
      citedBy: a.citedBy || 0,
      maxDepth: a.maxDepth || 0,
      topLevelBreadth: a.topLevelBreadth || 1,
      decisionCount: a.decisionCount || 0,
      recentRatio: a.recentRatio ?? c.recentRatio ?? 0,
      anchor: { q: 0, r: 0 },
      weight: 1,
      cells: 0,
      x: 0,
      z: 0,
      slug: a.id.split('/').at(-1) || a.id,
      elevation: 0.5,
    }))
    if (rest.length) {
      const restMass = rest.reduce((acc, a) => acc + a.mass, 0)
      areas.push({
        id: `${c.id}#outskirts`,
        name: 'Outskirts',
        continent: c.id,
        mass: restMass,
        cities: rest.reduce((acc, a) => acc + a.cities, 0),
        citedBy: rest.reduce((acc, a) => acc + (a.citedBy || 0), 0),
        maxDepth: rest.reduce((m, a) => Math.max(m, a.maxDepth || 0), 0),
        topLevelBreadth: rest.length,
        decisionCount: rest.reduce((acc, a) => acc + (a.decisionCount || 0), 0),
        recentRatio: Number(
          (
            rest.reduce((acc, a) => acc + (a.recentRatio ?? c.recentRatio ?? 0) * a.mass, 0) /
            Math.max(1, restMass)
          ).toFixed(3),
        ),
        lastUpdated:
          rest
            .map(a => a.lastUpdated)
            .filter((v): v is string => Boolean(v))
            .sort()
            .at(-1) ||
          c.lastUpdated ||
          null,
        shared: rest.every(a => Boolean(a.shared)),
        folded: rest.length,
        sampleFibers: rest.flatMap(a => a.sampleFibers || []).slice(0, 8),
        fiberItems: rest.flatMap(a => a.fiberItems || []).slice(0, 32),
        anchor: { q: 0, r: 0 },
        weight: 1,
        cells: 0,
        x: 0,
        z: 0,
        slug: 'outskirts',
        elevation: 0.5,
      })
    }
    if (areas.length === 0) {
      areas.push({
        id: c.id,
        name: c.name,
        continent: c.id,
        mass: Math.max(1, c.total),
        cities: c.cities,
        citedBy: c.citedBy || 0,
        maxDepth: c.maxDepth || 0,
        topLevelBreadth: 1,
        decisionCount: c.decisionCount || 0,
        recentRatio: c.recentRatio || 0,
        lastUpdated: c.lastUpdated || null,
        shared: Boolean(c.shared),
        anchor: { q: 0, r: 0 },
        weight: 1,
        cells: 0,
        x: 0,
        z: 0,
        slug: c.id.split('/').at(-1) || c.id,
        elevation: 0.5,
      })
    }

    const areaFor = new Map(rest.map(a => [a.id, `${c.id}#outskirts`]))
    const areaSlots = disk(Math.max(1, Math.round(c.rc * 0.62))).filter(p => blob.has(key(p)))
    const usedAnchors = new Set<string>()
    let spare = 0
    for (const a of areas) {
      const fam = families.get(a.id)
      if (fam && blob.has(key(fam)) && !usedAnchors.has(key(fam))) {
        a.anchor = fam
      } else {
        while (spare < areaSlots.length && usedAnchors.has(key(areaSlots[spare]))) spare++
        a.anchor = areaSlots[spare % Math.max(1, areaSlots.length)] || slots[0] || { q: 0, r: 0 }
      }
      usedAnchors.add(key(a.anchor))
      a.weight = 0.7 + Math.log2(1 + a.mass) / Math.log2(2 + c.total)
      a.cells = 0
    }
    stateByCont.set(c.id, {
      C,
      F,
      h,
      local: localPlaced,
      used,
      blob,
      areas,
      rest,
      areaFor,
      isthmusLocal: new Set(),
    })
  }

  // ---- Pass 1.5: Plate Tectonics — Organic Peninsulas & Supercontinent Isthmuses ----
  const isthmusCandidates = selectIsthmusLinks(workingContinents, domainLinks)
  const isthmuses: Isthmus[] = []
  const isthmusPairSet = new Set<string>()
  const clearOfOthers = (absP: Axial, idA: string, idB: string): boolean => {
    for (let dq = -1; dq <= 1; dq++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (distance({ q: dq, r: dr }) > 1) continue
        const ow = globalCoarseOwner.get(key({ q: absP.q + dq, r: absP.r + dr }))
        if (ow && ow !== idA && ow !== idB) return false
      }
    }
    return true
  }

  for (const link of isthmusCandidates) {
    const cA = byId.get(link.a)
    const cB = byId.get(link.b)
    if (!cA || !cB) continue
    const sA = stateByCont.get(cA.id)!
    const sB = stateByCont.get(cB.id)!
    const cellsA = [...sA.blob.values()].map(p => add(sA.C, p))
    const cellsB = [...sB.blob.values()].map(p => add(sB.C, p))
    let startA: Axial | null = null
    let goalB: Axial | null = null
    let bestD = Infinity
    for (const a of cellsA) {
      for (const b of cellsB) {
        const d = distance(a, b)
        if (d < bestD || (d === bestD && startA && goalB && cmp(key(a) + key(b), key(startA) + key(goalB)) < 0)) {
          bestD = d
          startA = a
          goalB = b
        }
      }
    }
    if (!startA || !goalB) continue
    const mid: Axial = { q: Math.round((startA.q + goalB.q) / 2), r: Math.round((startA.r + goalB.r) / 2) }
    const searchRadius = distance(startA, goalB) + 4
    const validCoarse = new Set<string>()
    for (const d of disk(searchRadius)) {
      const p = add(mid, d)
      if (clearOfOthers(p, cA.id, cB.id)) validCoarse.add(key(p))
    }
    let spine: Axial[] | null = null
    try {
      spine = shortest(
        startA,
        p => key(p) === key(goalB!),
        validCoarse,
        p => {
          const ow = globalCoarseOwner.get(key(p))
          if (ow === cA.id || ow === cB.id) return 0.6
          return 1 + hash(cA.id + cB.id + key(p)) * 0.25
        },
      )
    } catch {
      continue
    }
    if (!spine || spine.length < 2) continue

    const bridgeMap = new Map<string, Axial>(spine.map(p => [key(p), p]))
    for (const endIdx of [1, spine.length - 2]) {
      const center = spine[endIdx]
      if (!center) continue
      const hostCont = endIdx === 1 ? cA.id : cB.id
      for (const [dq, dr] of DIRECTIONS) {
        const nb = { q: center.q + dq, r: center.r + dr }
        const nbK = key(nb)
        if (bridgeMap.has(nbK) || globalCoarseOwner.has(nbK)) continue
        if (!clearOfOthers(nb, cA.id, cB.id)) continue
        const touchesHost = DIRECTIONS.some(
          ([q2, r2]) => globalCoarseOwner.get(key({ q: nb.q + q2, r: nb.r + r2 })) === hostCont,
        )
        if (touchesHost) {
          bridgeMap.set(nbK, nb)
          break
        }
      }
    }

    const bridgeCells = [...bridgeMap.values()]
    for (const absP of bridgeCells) {
      const k = key(absP)
      const existing = globalCoarseOwner.get(k)
      if (existing === cA.id) {
        sA.isthmusLocal.add(key(sub(absP, sA.C)))
        continue
      }
      if (existing === cB.id) {
        sB.isthmusLocal.add(key(sub(absP, sB.C)))
        continue
      }
      const dA = distance(absP, startA)
      const dB = distance(absP, goalB)
      if (dA <= dB) {
        const lp = sub(absP, sA.C)
        const lk = key(lp)
        sA.blob.set(lk, lp)
        sA.isthmusLocal.add(lk)
        globalCoarseOwner.set(k, cA.id)
      } else {
        const lp = sub(absP, sB.C)
        const lk = key(lp)
        sB.blob.set(lk, lp)
        sB.isthmusLocal.add(lk)
        globalCoarseOwner.set(k, cB.id)
      }
    }
    isthmusPairSet.add(pairKey(cA.id, cB.id))
    isthmuses.push({ a: cA.id, b: cB.id, sea: cA.sea, weight: link.w, cells: bridgeCells })
  }

  // Compute global fine tile ownership across all continents so coastlines wrap around joined supercontinents
  const globalFineOwner = new Map<string, string>()
  for (const c of workingContinents) {
    const { C, blob } = stateByCont.get(c.id)!
    for (const p of blob.values()) {
      const absC = add(C, p)
      for (const s of children(absC)) globalFineOwner.set(key(s), c.id)
    }
  }

  // ---- Pass 2: Elevation fields, rivers, L1/L2/L3 terrain hexes, and intra-continent roads ----
  const placedContinents: PlacedContinent[] = []
  const placedContById = new Map<string, PlacedContinent>()
  const areaLinks = bundle.areaLinks || []

  for (const c of workingContinents) {
    const { C, F, local, used, blob, areas, rest, areaFor, isthmusLocal } = stateByCont.get(c.id)!
    const owner = new Map<string, PlacedArea>()
    for (const a of areas) a.cells = 0
    for (const [k, p] of blob) {
      let best = areas[0]
      let bd = Infinity
      for (const a of areas) {
        const d = distance(p, a.anchor) / a.weight
        if (d < bd - 1e-9) {
          bd = d
          best = a
        }
      }
      owner.set(k, best)
      best.cells++
    }

    const contCited = c.citedBy ?? areas.reduce((acc, a) => acc + (a.citedBy || 0), 0)
    const contDepth = c.maxDepth ?? areas.reduce((m, a) => Math.max(m, a.maxDepth || 0), 0)
    const contRecent =
      c.recentRatio ??
      areas.reduce((acc, a) => acc + (a.recentRatio || 0) * a.mass, 0) / Math.max(1, c.total || 1)
    const highland =
      heightMode === 'depth'
        ? Math.min(1, Math.max(0, contDepth / 7.5))
        : heightMode === 'recency'
          ? Math.min(1, Math.max(0, contRecent * 1.35))
          : Math.min(1, Math.max(0, Math.log2(1 + contCited) / 11.2))
    const anchorKeys = new Set(areas.map(a => key(a.anchor)))
    const cellHeight = new Map<string, number>()

    for (const [k, p] of blob) {
      const absC = add(C, p)
      const a = owner.get(k)!
      const coast = DIRECTIONS.some(([q, r]) => !globalCoarseOwner.has(key(add(absC, { q, r }))))
      const edge = Math.max(0, 1 - distance(p) / (c.rc + 1.5))
      let cellSignal: number
      let contSignal: number
      if (heightMode === 'depth') {
        const areaDepth = a.maxDepth || 0
        cellSignal = Math.pow(areaDepth, 1.15) * 1.24
        contSignal = Math.pow(contDepth, 1.05) * 0.96
      } else if (heightMode === 'recency') {
        const areaRecent = a.recentRatio ?? contRecent ?? 0
        const recentDensity = Math.log2(1 + (areaRecent * a.mass) / Math.max(1, a.cells * 0.45))
        cellSignal = Math.pow(areaRecent, 1.45) * 11.2 + recentDensity * 0.58
        contSignal = Math.pow(contRecent, 1.45) * 12.6
      } else {
        const areaCited = a.citedBy || 0
        cellSignal = Math.log2(1 + areaCited / Math.max(1, a.cells * 0.45))
        contSignal = Math.log2(1 + contCited)
      }
      const near = Math.max(0, 1 - distance(p, a.anchor) / (1.42 + Math.sqrt(a.cells) * 0.78))
      const ridge = hash(c.id + k + 'ridge') * 0.08 * (0.35 + highland)
      let height =
        0.26 +
        0.2 * edge +
        (0.28 * cellSignal + 0.1 * contSignal) * (0.34 + 0.66 * near * near) * (0.55 + 0.45 * edge) +
        ridge
      if (isthmusLocal.has(k)) height = Math.min(height, 0.38 + hash(k + 'isth') * 0.06)
      else if (coast) height = Math.min(height, 0.35 + hash(k) * 0.05)
      cellHeight.set(k, height)
    }

    // 2-pass hexagonal Laplacian smoothing on coarse elevation field
    for (let pass = 0; pass < 2; pass++) {
      const next = new Map<string, number>()
      for (const [k, p] of blob) {
        const absC = add(C, p)
        const h0 = cellHeight.get(k)!
        const coast = DIRECTIONS.some(([q, r]) => !globalCoarseOwner.has(key(add(absC, { q, r }))))
        let nSum = 0
        for (const [dq, dr] of DIRECTIONS) {
          const nh = cellHeight.get(key(add(p, { q: dq, r: dr })))
          const foreignLand = nh === undefined && globalCoarseOwner.has(key(add(absC, { q: dq, r: dr })))
          nSum += nh !== undefined ? nh : foreignLand ? 0.34 : 0.2
        }
        const nAvg = nSum / 6
        const alpha = anchorKeys.has(k) && !coast ? 0.08 : coast ? 0.46 : 0.4
        next.set(k, h0 * (1 - alpha) + nAvg * alpha)
      }
      for (const [k, v] of next) cellHeight.set(k, v)
    }

    // Level-2 fine land: every exact aperture-4 child of a Level-1 coarse cell
    const fine = new Map<string, Axial>()
    for (const p of blob.values()) {
      for (const s of children(p)) fine.set(key(s), s)
    }
    const fineAnchorKeys = new Set(areas.map(a => key(nest(a.anchor))))
    const fineCoast = new Set<string>()
    for (const [k, s] of fine) {
      const absS = add(F, s)
      if (DIRECTIONS.some(([q, r]) => !globalFineOwner.has(key(add(absS, { q, r }))))) fineCoast.add(k)
    }

    const fineHeight = new Map<string, number>()
    for (const [k, s] of fine) {
      const ps = parent(s)
      const a = owner.get(key(ps))
      const dAnchor = a ? distance(s, nest(a.anchor)) : 2
      const W = world(s)
      let sum = 0
      let wt = 0
      for (const d of [[0, 0], ...DIRECTIONS] as const) {
        const cp = { q: ps.q + d[0], r: ps.r + d[1] }
        const ch = cellHeight.get(key(cp))
        if (ch === undefined) continue
        const cw = world(nest(cp))
        const dd = Math.hypot(cw.x - W.x, cw.z - W.z)
        const w = Math.exp((-dd * dd) / 5.2)
        sum += ch * w
        wt += w
      }
      let height = (wt > 0 ? sum / wt : 0.3) + (hash(c.id + k) - 0.5) * 0.022
      if (dAnchor === 0 && !fineCoast.has(k)) height += 0.13 * (0.35 + highland)
      else if (dAnchor >= 2 && !fineCoast.has(k)) height *= 0.92 - Math.min(0.12, (dAnchor - 2) * 0.028)
      if (fineCoast.has(k)) height = Math.min(height, 0.24 + Math.min(0.2, height * 0.12) + hash(k) * 0.028)
      fineHeight.set(k, height)
    }

    for (let pass = 0; pass < 2; pass++) {
      const next = new Map<string, number>()
      for (const [k, s] of fine) {
        const absS = add(F, s)
        const h0 = fineHeight.get(k)!
        const isCoast = fineCoast.has(k)
        let nSum = 0
        for (const [dq, dr] of DIRECTIONS) {
          const nh = fineHeight.get(key(add(s, { q: dq, r: dr })))
          const foreignLand = nh === undefined && globalFineOwner.has(key(add(absS, { q: dq, r: dr })))
          nSum += nh !== undefined ? nh : foreignLand ? 0.3 : 0.18
        }
        const nAvg = nSum / 6
        const alpha = fineAnchorKeys.has(k) && !isCoast ? 0.06 : isCoast ? 0.45 : 0.42
        next.set(k, h0 * (1 - alpha) + nAvg * alpha)
      }
      for (const [k, v] of next) fineHeight.set(k, v)
    }

    for (const a of areas) {
      a.anchorAbs = add(C, a.anchor)
      const aw = world(nest(a.anchorAbs))
      a.x = aw.x
      a.z = aw.z
      a.slug = a.id.includes('#') ? 'outskirts' : a.id.split('/').at(-1) || a.id
      a.elevation = fineHeight.get(key(nest(a.anchor))) ?? cellHeight.get(key(a.anchor)) ?? 0.5
    }

    // Rivers = Knowledge/Data Flow downhill from higher-elevation peaks
    const valley = new Map<string, number>()
    const cityAt = used
    const flow = (p: Axial): number => 1 + (fineHeight.get(key(p)) ?? 0.3) * 4 + (cityAt.has(key(p)) ? 30 : 0)
    const pairs = areaLinks
      .map(l => ({ ...l, a: areaFor.get(l.a) || l.a, b: areaFor.get(l.b) || l.b }))
      .filter(l => l.a !== l.b && areas.some(a => a.id === l.a) && areas.some(a => a.id === l.b))
      .sort((x, y) => y.w - x.w || cmp(x.a + x.b, y.a + y.b))
    const seen = new Set<string>()
    const chosen: Array<[PlacedArea, PlacedArea, number]> = []
    for (const l of pairs) {
      const A0 = areas.find(a => a.id === l.a)!
      const B0 = areas.find(a => a.id === l.b)!
      const k = [key(A0.anchor), key(B0.anchor)].sort().join('|')
      if (key(A0.anchor) === key(B0.anchor) || seen.has(k)) continue
      seen.add(k)
      const hA = fineHeight.get(key(nest(A0.anchor))) ?? 0
      const hB = fineHeight.get(key(nest(B0.anchor))) ?? 0
      const [high, low] = (A0.citedBy || 0) >= (B0.citedBy || 0) && hA >= hB - 0.1 ? [A0, B0] : [B0, A0]
      chosen.push([high, low, l.w])
      if (chosen.length >= (c.coarse >= 40 ? 3 : c.coarse >= 18 ? 1 : 0)) break
    }
    let longest: Axial[] | null = null
    for (const [A, B, w] of chosen) {
      const from = nest(A.anchor)
      const to = nest(B.anchor)
      if (!fine.has(key(from)) || !fine.has(key(to))) continue
      const path = shortest(from, p => key(p) === key(to), fine, flow)
      rivers.push({
        continent: c.id,
        link: [A.id, B.id],
        fromArea: A.id,
        toArea: B.id,
        weight: w,
        points: path.map(p => add(F, p)),
      })
      if (!longest || path.length > longest.length) longest = path
      for (const p of path) valley.set(key(p), 0)
    }
    if (longest) {
      const coastFine = (p: Axial): boolean => fineCoast.has(key(p))
      const mouth = shortest(longest[longest.length - 1], coastFine, fine, flow)
      rivers.push({ continent: c.id, link: null, weight: 0, points: mouth.map(p => add(F, p)) })
      for (const p of mouth) valley.set(key(p), 0)
    }
    for (const [k, s] of fine) {
      if (!valley.has(k) && DIRECTIONS.some(([q, r]) => valley.get(key(add(s, { q, r }))) === 0)) {
        valley.set(k, 1)
      }
    }

    const regionFibers = fibers.filter(n => n.continent === c.id)
    const byID = new Map(regionFibers.map(n => [n.id, n]))
    const cityByFine = new Map(regionFibers.map(n => [key(n), n]))

    // Level-1 coarse cells (LOD 0)
    for (const [k, p] of blob) {
      const a = owner.get(k)!
      const abs = add(C, p)
      const wPos = world(nest(abs))
      const coast = DIRECTIONS.some(([q, r]) => !globalCoarseOwner.has(key(add(abs, { q, r }))))
      const isthmus = isthmusLocal.has(k)
      const childKeys = children(p).map(key)
      const hasRiver = childKeys.some(ck => valley.get(ck) === 0)
      const hasValley = childKeys.some(ck => valley.has(ck))
      let height = cellHeight.get(k)!
      if (hasRiver) height = Math.max(0.18, Math.min(height - 0.16, 0.52 + height * 0.25))
      cells.push({
        ...abs,
        fq: abs.q * 2,
        fr: abs.r * 2,
        x: wPos.x,
        z: wPos.z,
        level: 1,
        continent: c.id,
        area: a.id,
        height,
        coast,
        isthmus,
        valley: hasValley,
        river: hasRiver,
        citedBy: a.citedBy || 0,
        maxDepth: a.maxDepth || 0,
        recentRatio: a.recentRatio || 0,
        decisionCount: a.decisionCount || 0,
        mass: a.mass / Math.max(1, a.cells),
      })
    }

    // Unpack smaller depth-1 directories inside Outskirts
    const subAreas: PlacedArea[] = []
    if (rest && rest.length) {
      const outTiles: Array<{ k: string; s: Axial; abs: Axial; x: number; z: number; h: number }> = []
      for (const [k, s] of fine) {
        const cp = parent(s)
        const a = owner.get(key(cp))
        if (a && a.id === `${c.id}#outskirts` && !isthmusLocal.has(key(cp))) {
          const abs = add(F, s)
          const wPos = world(abs)
          outTiles.push({ k, s, abs, x: wPos.x, z: wPos.z, h: fineHeight.get(k) ?? 0.4 })
        }
      }
      if (outTiles.length) {
        const cxOut = outTiles.reduce((acc, t) => acc + t.x, 0) / outTiles.length
        const czOut = outTiles.reduce((acc, t) => acc + t.z, 0) / outTiles.length
        outTiles.sort(
          (a, b) => Math.atan2(a.z - czOut, a.x - cxOut) - Math.atan2(b.z - czOut, b.x - cxOut) || cmp(a.k, b.k),
        )
        const maxSubs = Math.min(rest.length, Math.max(1, outTiles.length))
        for (let i = 0; i < maxSubs; i++) {
          const sa = rest[i]
          const slot = outTiles[Math.floor(((i + 0.5) * outTiles.length) / maxSubs) % outTiles.length]
          subAreas.push({
            ...sa,
            slug: sa.id.split('/').at(-1) || sa.id,
            x: slot.x,
            z: slot.z,
            elevation: slot.h,
            isOutskirtsSub: true,
            citedBy: sa.citedBy || 0,
            maxDepth: sa.maxDepth || 0,
            topLevelBreadth: sa.topLevelBreadth || 1,
            decisionCount: sa.decisionCount || 0,
            recentRatio: sa.recentRatio ?? c.recentRatio ?? 0,
            anchor: slot.s,
            weight: 1,
            cells: 1,
          })
        }
      }
    }

    // Level-2 fine tiles (LOD 1) + Level-3 micro-hex subdivision (LOD 2)
    const areaTileSeq = new Map<string, number>()
    for (const [k, s] of fine) {
      const v = valley.get(k)
      const abs = add(F, s)
      let height = fineHeight.get(k)!
      if (v === 0) height = Math.max(0.14, Math.min(height - 0.2, 0.45 + height * 0.22))
      else if (v === 1) height = Math.max(0.2, height - 0.1)
      const cp = parent(s)
      const a = owner.get(key(cp))!
      const coast = fineCoast.has(k)
      const isthmus = isthmusLocal.has(key(cp))
      const city = cityByFine.get(key(abs))
      const wPos = world(abs)
      let tileSubArea: PlacedArea | null = null
      if (a.id.endsWith('#outskirts') && subAreas.length && !isthmus) {
        let bestSa = subAreas[0]
        let bestD = Infinity
        for (const sa of subAreas) {
          const d = Math.hypot(wPos.x - sa.x, wPos.z - sa.z)
          if (d < bestD) {
            bestD = d
            bestSa = sa
          }
        }
        tileSubArea = bestSa
      }
      const effArea = tileSubArea || a
      const splitL3 = !isthmus && (Boolean(city) || (v !== 0 && (effArea.mass || 0) > 0))
      const tile: FineTile = {
        ...abs,
        ...wPos,
        level: 2,
        continent: c.id,
        area: a.id,
        subArea: tileSubArea?.id || null,
        subAreaName: tileSubArea?.name || null,
        cell: key(add(C, cp)),
        height,
        valley: v !== undefined,
        river: v === 0,
        coast,
        isthmus,
        citedBy: city?.citedBy ?? effArea.citedBy ?? 0,
        depth: city?.depth ?? effArea.maxDepth ?? 0,
        recentRatio: effArea.recentRatio || 0,
        decisionCount: effArea.decisionCount || 0,
        splitL3,
      }
      tiles.push(tile)
      land.set(key(abs), tile)

      if (splitL3) {
        const seq = areaTileSeq.get(effArea.id) || 0
        areaTileSeq.set(effArea.id, seq + 1)
        const fItems = effArea.fiberItems && effArea.fiberItems.length ? effArea.fiberItems : null
        for (const [idx, m] of children(abs).entries()) {
          const mw = world(m, RADIUS / 2)
          const mh = Math.max(0.14, height + (hash(c.id + key(m) + 'l3') - 0.45) * 0.08 + (idx === 0 ? 0.04 : 0))
          const fItem = fItems ? fItems[(seq * 4 + idx) % fItems.length] : null
          const isCityCore = Boolean(city && idx === 0)
          const subLabel = isCityCore
            ? city!.name
            : fItem?.name ||
              (city
                ? `${city.name} · #${idx + 1}`
                : effArea.sampleFibers?.[idx % Math.max(1, effArea.sampleFibers.length)] || effArea.name)
          level3.push({
            ...m,
            x: mw.x,
            z: mw.z,
            level: 3,
            parentTile: key(abs),
            cell: tile.cell,
            continent: c.id,
            area: a.id,
            subArea: effArea.id,
            subAreaName: effArea.name,
            height: mh,
            valley: tile.valley,
            river: tile.river,
            coast: tile.coast,
            citedBy: isCityCore ? city!.citedBy || 0 : (fItem?.citedBy ?? tile.citedBy),
            depth: Math.max(2, tile.depth),
            recentRatio: tile.recentRatio,
            cityId: isCityCore ? city!.id : null,
            subFiberId: isCityCore ? city!.id : fItem?.id || `${effArea.id}#${seq * 4 + idx + 1}`,
            subStatus: isCityCore ? city!.state : fItem?.status || 'fiber',
            subLabel,
          })
        }
      }
    }

    // Roads = Orchestration Hierarchy strictly (parent -> child threads)
    for (const n of regionFibers) {
      if (n.state === 'closed') continue
      const p = n.parent ? byID.get(n.parent) : undefined
      const from: Axial = p ? p.local : { q: 0, r: 0 }
      if (key(from) === key(n.local) || !fine.has(key(from)) || !fine.has(key(n.local))) continue
      roads.push({
        continent: c.id,
        from: p?.id || null,
        to: n.id,
        points: shortest(from, q => key(q) === key(n.local), fine, q => 1 + (valley.get(key(q)) === 0 ? 6 : 0)).map(
          q => add(F, q),
        ),
      })
    }

    const peakVal = fine.size ? Math.max(...[...fine.keys()].map(k => fineHeight.get(k) ?? 0.3)) : 0.3
    const placedCont: PlacedContinent = {
      id: c.id,
      name: c.name,
      kind: c.kind,
      shared: Boolean(c.shared),
      stores: c.stores,
      total: c.total,
      cities: c.cities,
      maxDepth: c.maxDepth,
      decisionCount: c.decisionCount,
      recentRatio: c.recentRatio,
      lastUpdated: c.lastUpdated,
      sea: c.sea,
      biome: c.biome,
      topLevelBreadth: c.topLevelBreadth,
      coarse: c.coarse,
      rc: c.rc,
      q: c.q,
      r: c.r,
      fq: F.q,
      fr: F.r,
      ...world(F),
      areas,
      subAreas,
      highland,
      citedBy: contCited,
      fibers: regionFibers,
      peak: peakVal,
      land: fine.size,
      active: local.filter(n => n.state === 'working').length,
      ask: local.filter(n => n.state === 'ask').length,
      review: local.filter(n => n.state === 'review').length,
    }
    placedContinents.push(placedCont)
    placedContById.set(c.id, placedCont)
  }

  if (fibers.length !== cities.length) throw new Error('Unknown continent in input')

  // ---- Pass 3: Overland Stone Roads crossing each Isthmus Peninsula ----
  for (const isth of isthmuses) {
    const cA = placedContById.get(isth.a)
    const cB = placedContById.get(isth.b)
    if (!cA || !cB) continue
    const pairFine = new Map<string, FineTile>()
    for (const t of tiles) if (t.continent === cA.id || t.continent === cB.id) pairFine.set(key(t), t)
    const midCell = isth.cells[Math.floor(isth.cells.length / 2)]
    const midFine = nest(midCell)
    const pickHub = (c: PlacedContinent): { id?: string; q: number; r: number } => {
      const liveCities = c.fibers.filter(n => n.state !== 'closed')
      const pool = liveCities.length ? liveCities : c.fibers
      if (pool.length) {
        return pool.slice().sort((x, y) => distance(x, midFine) - distance(y, midFine) || cmp(x.id, y.id))[0]
      }
      return nest({ q: c.q, r: c.r })
    }
    const hubA = pickHub(cA)
    const hubB = pickHub(cB)
    const startPt: Axial = { q: hubA.q, r: hubA.r }
    const goalPt: Axial = { q: hubB.q, r: hubB.r }
    if (pairFine.has(key(startPt)) && pairFine.has(key(goalPt)) && key(startPt) !== key(goalPt)) {
      try {
        const path = shortest(
          startPt,
          p => key(p) === key(goalPt),
          pairFine,
          p => {
            const t = pairFine.get(key(p))
            return (t?.isthmus ? 0.75 : 1.1) + (t?.river ? 4 : 0) + (t?.coast ? 0.4 : 0)
          },
        )
        isth.road = path
        roads.push({
          continent: cA.id,
          toContinent: cB.id,
          isthmus: true,
          from: hubA.id || cA.id,
          to: hubB.id || cB.id,
          points: path,
        })
      } catch {
        // Ignore if no land path connects hubs.
      }
    }
  }

  // ---- Pass 4: Cross-Ocean Sea Lanes between distinct sea-separated landmasses ----
  const DASH_CYCLE = 1.8
  const HALF_STEP = DASH_CYCLE / 2
  const lanes: SeaLane[] = []
  const crossOceanLinks = [...domain]
    .filter(l => !isthmusPairSet.has(pairKey(l.a, l.b)) && l.w >= 2)
    .sort((a, b) => b.w - a.w || cmp(a.a + a.b, b.a + b.b))
    .slice(0, laneCount)

  for (const l of crossOceanLinks) {
    const A = placedContById.get(l.a)
    const B = placedContById.get(l.b)
    if (!A || !B) continue
    const shoresA = tiles.filter(t => t.continent === A.id && t.coast && !t.isthmus)
    const shoresB = tiles.filter(t => t.continent === B.id && t.coast && !t.isthmus)
    if (!shoresA.length || !shoresB.length) continue
    const topA = shoresA
      .slice()
      .sort((x, y) => Math.hypot(x.x - B.x, x.z - B.z) - Math.hypot(y.x - B.x, y.z - B.z))
      .slice(0, 12)
    const topB = shoresB
      .slice()
      .sort((x, y) => Math.hypot(x.x - A.x, x.z - A.z) - Math.hypot(y.x - A.x, y.z - A.z))
      .slice(0, 12)

    const sampleArc = (a: WorldXZ, b: WorldXZ, sign: number, mag = 0.16) => {
      const dx = b.x - a.x
      const dz = b.z - a.z
      const len = Math.hypot(dx, dz) || 1
      const bend = sign * mag * len
      const cx = (a.x + b.x) / 2 - (dz / len) * bend
      const cz = (a.z + b.z) / 2 + (dx / len) * bend
      const evalArc = (t: number): WorldXZ => ({
        x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * cx + t * t * b.x,
        z: (1 - t) ** 2 * a.z + 2 * (1 - t) * t * cz + t * t * b.z,
      })
      const SAMPLES = 256
      const cum = [0]
      const ts = [0]
      let prev = evalArc(0)
      let totalLen = 0
      for (let i = 1; i <= SAMPLES; i++) {
        const t = i / SAMPLES
        const cur = evalArc(t)
        totalLen += Math.hypot(cur.x - prev.x, cur.z - prev.z)
        cum.push(totalLen)
        ts.push(t)
        prev = cur
      }
      const steps = Math.max(6, Math.round(totalLen / HALF_STEP))
      const stepLen = totalLen / steps
      const points: SeaLanePoint[] = []
      let si = 0
      let seaCount = 0
      let landHits = 0
      for (let i = 0; i <= steps; i++) {
        const targetS = i * stepLen
        while (si < SAMPLES - 1 && cum[si + 1] < targetS) si++
        const seg = cum[si + 1] - cum[si]
        const frac = seg > 1e-9 ? (targetS - cum[si]) / seg : 0
        const t = ts[si] + frac * (ts[si + 1] - ts[si])
        const { x, z } = evalArc(t)
        const cell = unworld({ x, z })
        const isSea = !land.has(key(cell)) && !DIRECTIONS.some(([q, r]) => land.has(key(add(cell, { q, r }))))
        if (isSea) seaCount++
        else if (i > 1 && i < steps - 1) landHits++
        points.push({ x, z, sea: isSea })
      }
      const score = seaCount * 3 - landHits * 18 - totalLen * 0.35
      return { totalLen, stepLen, points, seaCount, landHits, score }
    }

    const pref = hash(l.a + l.b) > 0.5 ? 1 : -1
    let best: ReturnType<typeof sampleArc> | null = null
    for (let ia = 0; ia < topA.length; ia += 3) {
      for (let ib = 0; ib < topB.length; ib += 3) {
        for (const sign of [pref, -pref]) {
          const cand = sampleArc(topA[ia], topB[ib], sign, 0.16)
          if (!best || cand.score > best.score) best = cand
        }
      }
    }
    if (best) {
      lanes.push({
        a: l.a,
        b: l.b,
        weight: l.w,
        arcLength: Number(best.totalLen.toFixed(2)),
        step: Number(best.stepLen.toFixed(3)),
        points: best.points,
      })
    }
  }

  return {
    continents: placedContinents,
    fibers,
    tiles,
    cells,
    level1: cells,
    level2: tiles,
    level3,
    roads,
    rivers,
    lanes,
    isthmuses,
    heightMode,
  }
}
