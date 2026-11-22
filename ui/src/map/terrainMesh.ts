// High-frequency eroded isometric terrain mesh for the Fleet atlas.
// Combines a watertight subdivided hexagonal mesh (N=4 -> 96 sub-tris per L2 hex, N=2 -> 24 per L1 hex)
// with domain-warped ridged-multifractal alpine crags, exposed granite escarpments, deep carved bright-blue
// winding rivers, organic hexagonal coastlines with turquoise shoal/foam aprons, flat graded city pads,
// and whisper-faint draped hex seams.
import * as THREE from 'three'
import { DIRECTIONS, RADIUS, biomeOf, hash, key, unworld, world } from './layout.js'
import type {
  AtlasLayout,
  Axial,
  BiomeId,
  BiomePalette,
  CoarseCell,
  FineTile,
  LensState,
  MicroHex,
  MountainL1Entry,
  MountainL2Cell,
  NaturalSample,
  PickOwner,
  PlacedContinent,
  RenderTier,
  RiverSamplePoint,
  RiverSegment,
  SampledRiverPath,
  SchemePalette,
  TerrainSample,
  TerrainSampler,
  TileOwner,
  WorldXZ,
} from './types.js'

export const SEA_Y = -0.28
const SQRT3 = Math.sqrt(3)
const CORNER_ANGLES = Array.from({ length: 6 }, (_, k) => (k * Math.PI) / 3 - Math.PI / 6)
const CORNER_COS = CORNER_ANGLES.map(Math.cos)
const CORNER_SIN = CORNER_ANGLES.map(Math.sin)

const HEX_RING2: Array<[number, number]> = []
for (let dq = -2; dq <= 2; dq++) {
  for (let dr = -2; dr <= 2; dr++) {
    if (Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)) <= 2) {
      HEX_RING2.push([dq, dr])
    }
  }
}

function hash2i(ix: number, iz: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Smooth value noise in [-1, 1]. */
export function noise2(x: number, z: number): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = x - ix
  const fz = z - iz
  const ux = fx * fx * (3 - 2 * fx)
  const uz = fz * fz * (3 - 2 * fz)
  const a = hash2i(ix, iz)
  const b = hash2i(ix + 1, iz)
  const c = hash2i(ix, iz + 1)
  const d = hash2i(ix + 1, iz + 1)
  return (a + (b - a) * ux + (c - a + (a - b - c + d) * ux) * uz) * 2 - 1
}

export function fbm2(x: number, z: number): number {
  return (
    0.55 * noise2(x, z) +
    0.3 * noise2(x * 2.13 + 17.3, z * 2.13 - 9.1) +
    0.15 * noise2(x * 4.35 - 6.4, z * 4.35 + 12.7)
  )
}

function ridged2(x: number, z: number): number {
  const wx = x + noise2(x * 0.42 + 11.4, z * 0.42 - 7.2) * 0.58
  const wz = z + noise2(x * 0.42 - 19.1, z * 0.42 + 14.8) * 0.58
  const r1 = 1.0 - Math.abs(noise2(wx * 0.72, wz * 0.72))
  const r2 = 1.0 - Math.abs(noise2(wx * 1.62 + 31.7, wz * 1.62 - 12.3))
  const r3 = 1.0 - Math.abs(noise2(wx * 3.45 - 8.4, wz * 3.45 + 27.1))
  return r1 * r1 * 0.58 + r2 * r2 * 0.29 + r3 * r3 * 0.13
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * Cleanly flat / gentle low-relief elevation from layout raw height (0.08 -> 0.24)
 * so every hexagon stays geometrically undistorted while mountains & cities rise upward.
 */
export function hexTargetH(rawH: number): number {
  return clamp(0.08 + Math.max(0, rawH - 0.15) * 0.082, 0.08, 0.24)
}

function distSqToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax
  const dz = bz - az
  const lenSq = dx * dx + dz * dz
  if (lenSq < 1e-8) return (px - ax) * (px - ax) + (pz - az) * (pz - az)
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / lenSq, 0, 1)
  const cx = ax + dx * t
  const cz = az + dz * t
  return (px - cx) * (px - cx) + (pz - cz) * (pz - cz)
}

function cellKey(cx: number, cz: number): number {
  return (cx + 2048) * 4096 + (cz + 2048)
}

function evalCentripetalCatmullRom(p0: WorldXZ, p1: WorldXZ, p2: WorldXZ, p3: WorldXZ, u: number): WorldXZ {
  const distPow = (a: WorldXZ, b: WorldXZ): number => Math.max(1e-4, Math.pow(Math.hypot(b.x - a.x, b.z - a.z), 0.5))
  const t0 = 0
  const t1 = t0 + distPow(p0, p1)
  const t2 = t1 + distPow(p1, p2)
  const t3 = t2 + distPow(p2, p3)
  const t = t1 + (t2 - t1) * u

  const lerpPt = (a: WorldXZ, b: WorldXZ, ta: number, tb: number): WorldXZ => {
    const w = (t - ta) / Math.max(1e-6, tb - ta)
    return { x: a.x + (b.x - a.x) * w, z: a.z + (b.z - a.z) * w }
  }
  const A1 = lerpPt(p0, p1, t0, t1)
  const A2 = lerpPt(p1, p2, t1, t2)
  const A3 = lerpPt(p2, p3, t2, t3)
  const B1 = lerpPt(A1, A2, t0, t2)
  const B2 = lerpPt(A2, A3, t1, t3)
  return lerpPt(B1, B2, t1, t2)
}

function sampleCatmullRomPath(ctrlPts: WorldXZ[], stepDist = 0.24): WorldXZ[] {
  if (ctrlPts.length < 2) return ctrlPts.slice()
  const n = ctrlPts.length
  const pFirst: WorldXZ = { x: 2 * ctrlPts[0].x - ctrlPts[1].x, z: 2 * ctrlPts[0].z - ctrlPts[1].z }
  const pLast: WorldXZ = { x: 2 * ctrlPts[n - 1].x - ctrlPts[n - 2].x, z: 2 * ctrlPts[n - 1].z - ctrlPts[n - 2].z }
  const ext = [pFirst, ...ctrlPts, pLast]
  const out: WorldXZ[] = []
  for (let i = 0; i < n - 1; i++) {
    const p0 = ext[i]
    const p1 = ext[i + 1]
    const p2 = ext[i + 2]
    const p3 = ext[i + 3]
    const chord = Math.hypot(p2.x - p1.x, p2.z - p1.z)
    const steps = Math.max(2, Math.ceil(chord / stepDist))
    for (let s = 0; s < steps; s++) {
      out.push(evalCentripetalCatmullRom(p0, p1, p2, p3, s / steps))
    }
  }
  out.push({ x: ctrlPts[n - 1].x, z: ctrlPts[n - 1].z })
  return out
}

interface CityPad {
  x: number
  z: number
  y: number
  rFlat: number
  rBlend: number
}

/**
 * Continuous world-space eroded heightfield sampler:
 *  - 19-hex Gaussian elevation interpolation over L2 tiles
 *  - Domain-warped ridged-multifractal alpine crags & eroded mountain ridges
 *  - Centripetal Catmull-Rom carved river valleys & flared estuaries along atlas.rivers
 *  - Flat graded building pads around every Shuttle city
 */
export function createErodedSampler(
  atlas: AtlasLayout,
  tileMap: ReadonlyMap<string, FineTile>,
  contMap: ReadonlyMap<string, PlacedContinent>,
): TerrainSampler {
  const RIVER_CELL = 4.0
  const riverGrid = new Map<number, RiverSegment[]>()
  const riverPaths: SampledRiverPath[] = []

  for (let rIdx = 0; rIdx < (atlas.rivers || []).length; rIdx++) {
    const r = atlas.rivers[rIdx]
    const cont = contMap.get(r.continent)
    const owner: TileOwner = {
      isTile: true,
      continent: r.continent,
      continentName: cont?.name || r.continent,
      areaName: r.fromArea && r.toArea
        ? `${r.fromArea.split('/').at(-1)} → ${r.toArea.split('/').at(-1)} river`
        : 'River valley',
      mass: cont?.total || 0,
      cities: cont?.cities || 0,
      citedBy: cont?.citedBy || 0,
      shared: Boolean(cont?.shared),
    }
    const rawHexPts = r.points || []
    if (rawHexPts.length < 2) continue

    const endHex = rawHexPts[rawHexPts.length - 1]
    const endTile = tileMap.get(key(endHex))
    const isOutlet = Boolean(endTile?.coast)

    const basePts = rawHexPts.map(p => world(p))
    const ctrlPts: WorldXZ[] = []
    for (let i = 0; i < basePts.length; i++) {
      const p = basePts[i]
      if (i === 0 || i === basePts.length - 1) {
        ctrlPts.push({ x: p.x, z: p.z })
      } else {
        const prev = basePts[i - 1]
        const next = basePts[i + 1]
        const dx = next.x - prev.x
        const dz = next.z - prev.z
        const len = Math.hypot(dx, dz) || 1
        const nx = -dz / len
        const nz = dx / len
        const meander = (hash(`${r.continent}:${rIdx}:${i}:me`) - 0.5) * 0.42
        ctrlPts.push({ x: p.x + nx * meander, z: p.z + nz * meander })
      }
    }

    if (isOutlet && endTile) {
      let sx = 0
      let sz = 0
      let sCount = 0
      for (const [dq, dr] of DIRECTIONS) {
        if (!tileMap.has(`${endHex.q + dq},${endHex.r + dr}`)) {
          const nw = world({ q: endHex.q + dq, r: endHex.r + dr })
          sx += nw.x - basePts[basePts.length - 1].x
          sz += nw.z - basePts[basePts.length - 1].z
          sCount++
        }
      }
      if (sCount > 0) {
        const sl = Math.hypot(sx, sz) || 1
        const last = ctrlPts[ctrlPts.length - 1]
        ctrlPts.push({ x: last.x + (sx / sl) * 0.62, z: last.z + (sz / sl) * 0.62 })
      }
    }

    const sampled = sampleCatmullRomPath(ctrlPts, 0.24)
    const totalArc = [0]
    for (let i = 1; i < sampled.length; i++) {
      totalArc.push(
        totalArc[i - 1] + Math.hypot(sampled[i].x - sampled[i - 1].x, sampled[i].z - sampled[i - 1].z),
      )
    }
    const maxArc = Math.max(1e-4, totalArc[totalArc.length - 1])

    const smoothPts: RiverSamplePoint[] = sampled.map((pt, i) => {
      const frac = totalArc[i] / maxArc
      const halfW = isOutlet
        ? 0.15 + frac * 0.08 + smoothstep(0.66, 1.0, frac) * 0.11
        : 0.13 + frac * 0.08
      return { x: pt.x, z: pt.z, frac, halfW, arc: totalArc[i] }
    })
    riverPaths.push({ pts: smoothPts, owner, continent: r.continent, isOutlet })

    for (let i = 1; i < smoothPts.length; i++) {
      const a = smoothPts[i - 1]
      const b = smoothPts[i]
      const segHalfW = (a.halfW + b.halfW) * 0.5
      const seg: RiverSegment = {
        ax: a.x,
        az: a.z,
        bx: b.x,
        bz: b.z,
        halfW: segHalfW,
        frac: (a.frac + b.frac) * 0.5,
        isOutlet,
        owner,
        continent: r.continent,
      }
      const pad = Math.max(1.3, segHalfW * 3.5)
      const minCx = Math.floor((Math.min(a.x, b.x) - pad) / RIVER_CELL)
      const maxCx = Math.floor((Math.max(a.x, b.x) + pad) / RIVER_CELL)
      const minCz = Math.floor((Math.min(a.z, b.z) - pad) / RIVER_CELL)
      const maxCz = Math.floor((Math.max(a.z, b.z) + pad) / RIVER_CELL)
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
          const k = cellKey(cx, cz)
          let arr = riverGrid.get(k)
          if (!arr) {
            arr = []
            riverGrid.set(k, arr)
          }
          arr.push(seg)
        }
      }
    }
  }

  function nearestRiver(x: number, z: number): { dist: number; seg: RiverSegment } | null {
    const arr = riverGrid.get(cellKey(Math.floor(x / RIVER_CELL), Math.floor(z / RIVER_CELL)))
    if (!arr) return null
    let bestD2 = 1.96
    let bestSeg: RiverSegment | null = null
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i]
      const d2 = distSqToSegment(x, z, s.ax, s.az, s.bx, s.bz)
      if (d2 < bestD2) {
        bestD2 = d2
        bestSeg = s
      }
    }
    return bestSeg ? { dist: Math.sqrt(bestD2), seg: bestSeg } : null
  }

  const SIGMA = 0.78 * RADIUS
  const INV_2SIGMA2 = 1 / (2 * SIGMA * SIGMA)

  function sampleNatural(x: number, z: number): NaturalSample {
    const c0 = unworld({ x, z }, RADIUS)
    let sumH = 0
    let sumW = 0
    let landW = 0
    let nearestTile: FineTile | null = tileMap.get(key(c0)) || null
    let nearestD2 = Infinity

    for (let i = 0; i < HEX_RING2.length; i++) {
      const q = c0.q + HEX_RING2[i][0]
      const r = c0.r + HEX_RING2[i][1]
      const hx = SQRT3 * RADIUS * (q + r * 0.5)
      const hz = 1.5 * RADIUS * r
      const dx = x - hx
      const dz = z - hz
      const d2 = dx * dx + dz * dz
      const w = Math.exp(-d2 * INV_2SIGMA2)
      const t = tileMap.get(`${q},${r}`)
      if (t) {
        sumH += w * hexTargetH(t.height)
        landW += w
        if (d2 < nearestD2) {
          nearestD2 = d2
          nearestTile = t
        }
      } else {
        sumH += w * -0.34
      }
      sumW += w
    }

    let baseH = sumW > 0 ? sumH / sumW : -0.34
    const ownTile = tileMap.get(key(c0)) || null
    if (ownTile) {
      const ownH = hexTargetH(ownTile.height)
      const landRatio = sumW > 0 ? landW / sumW : 0
      const flatBlend = smoothstep(0.52, 0.88, landRatio)
      baseH = baseH * (1 - flatBlend * 0.65) + ownH * (flatBlend * 0.65)
    }

    if (ownTile?.isthmus) {
      const oc = world(c0)
      const dOwn = Math.hypot(x - oc.x, z - oc.z)
      if (dOwn < RADIUS * 0.86) {
        baseH = Math.max(baseH, 0.11)
      }
    }

    const landFactor = smoothstep(-0.14, 0.1, baseH)
    const fbm = fbm2(x * 0.48, z * 0.48)
    const ridge = ridged2(x, z)
    const h = baseH + landFactor * (fbm * 0.012)

    return { h, baseH, ridge, ownTile, nearestTile, landRatio: sumW > 0 ? landW / sumW : 0 }
  }

  const PAD_CELL = 4.0
  const padGrid = new Map<number, CityPad[]>()
  const cityElevations = new Map<string, number>()
  for (const n of atlas.fibers || []) {
    const nat = sampleNatural(n.x, n.z)
    const cityY = Math.max(0.1, nat.h)
    cityElevations.set(key(n), cityY)
    const big = Boolean(n.isOrchestrator || n.state === 'ask' || n.state === 'working')
    const pad: CityPad = { x: n.x, z: n.z, y: cityY, rFlat: big ? 0.56 : 0.44, rBlend: big ? 1.06 : 0.88 }
    const minCx = Math.floor((n.x - pad.rBlend) / PAD_CELL)
    const maxCx = Math.floor((n.x + pad.rBlend) / PAD_CELL)
    const minCz = Math.floor((n.z - pad.rBlend) / PAD_CELL)
    const maxCz = Math.floor((n.z + pad.rBlend) / PAD_CELL)
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const k = cellKey(cx, cz)
        let arr = padGrid.get(k)
        if (!arr) {
          arr = []
          padGrid.set(k, arr)
        }
        arr.push(pad)
      }
    }
  }

  function sample(x: number, z: number): TerrainSample {
    const nat = sampleNatural(x, z)
    let h = nat.h
    let isRiver = false
    let riverBank = false
    let riverOwner: TileOwner | null = null
    let riverDist = 99

    const rv = nearestRiver(x, z)
    if (rv && nat.baseH > -0.18) {
      const d = rv.dist
      const hw = rv.seg.halfW || 0.21
      const carveR = Math.max(0.58, hw * 3.15)
      const bankR = Math.max(0.52, hw * 2.85)
      riverDist = d
      if (d < carveR) {
        const u = d / carveR
        const carve = (1 - u * u) * (1 - u * u)
        const estuary = clamp((nat.baseH + 0.16) / 0.26, 0.32, 1)
        const bedDrop = carve * 0.155 * estuary
        h -= bedDrop
        riverBank = d < bankR
        if (d < hw * 1.18) {
          isRiver = true
          riverOwner = rv.seg.owner
        }
      }
    }

    const pads = padGrid.get(cellKey(Math.floor(x / PAD_CELL), Math.floor(z / PAD_CELL)))
    let inPad = false
    if (pads) {
      let bestPad: CityPad | null = null
      let bestD = Infinity
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i]
        const d = Math.hypot(x - p.x, z - p.z)
        if (d < p.rBlend && d < bestD) {
          bestD = d
          bestPad = p
        }
      }
      if (bestPad) {
        if (bestD <= bestPad.rFlat) {
          h = bestPad.y
          isRiver = false
          inPad = true
        } else {
          const t = smoothstep(bestPad.rFlat, bestPad.rBlend, bestD)
          h = bestPad.y * (1 - t) + h * t
          if (t < 0.42) isRiver = false
        }
      }
    }

    return {
      h,
      baseH: nat.baseH,
      ridge: nat.ridge,
      ownTile: nat.ownTile,
      nearestTile: nat.nearestTile,
      isRiver,
      riverBank,
      riverOwner,
      riverDist,
      inPad,
    }
  }

  function sampleHeight(x: number, z: number): number {
    return sample(x, z).h
  }

  function isInRiver(x: number, z: number): boolean {
    const rv = nearestRiver(x, z)
    if (!rv) return false
    return rv.dist < (rv.seg.halfW || 0.21) + 0.15
  }

  function riverSurfaceY(x: number, z: number): number {
    return Math.max(SEA_Y + 0.022, sample(x, z).h + 0.052)
  }

  return {
    sample,
    sampleNatural,
    sampleHeight,
    isInRiver,
    nearestRiver,
    riverSurfaceY,
    cityElevations,
    riverPaths,
  }
}

/** Seamless subtle world-space turf/granite micro-grain texture (no baked hex borders). */
export function makeTerrainDetailTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const S = 128
  const c = document.createElement('canvas')
  c.width = c.height = S
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#f5f5f1'
  ctx.fillRect(0, 0, S, S)
  let a = 424242 >>> 0
  const rnd = (): number => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let i = 0; i < 420; i++) {
    const x = Math.floor(rnd() * S)
    const y = Math.floor(rnd() * S)
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,248,0.14)' : 'rgba(105,120,114,0.12)'
    ctx.fillRect(x, y, 2, 2)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy())
  return tex
}

export interface ErodedTerrainResult {
  mesh: THREE.Mesh
  shoalMesh: THREE.Mesh
  updateColors(
    p: SchemePalette,
    bp: Record<BiomeId, BiomePalette>,
    lens: LensState | null,
    night: boolean,
    matchesFn: (owner: PickOwner) => boolean,
  ): void
  triCount: number
}

interface CornerVert {
  x: number
  z: number
  key: string
  isCoast: boolean
}

interface SectorVert {
  x: number
  y: number
  z: number
  flags: number
  k: string
}

interface ShoalVert {
  x: number
  z: number
  t: number
  owner: PickOwner | null
}

type TerrainHex = CoarseCell | FineTile

export interface BuildErodedTerrainOptions<T extends TerrainHex> {
  radius: number
  subdiv?: number
  sampler: TerrainSampler
  ownerForTile(t: T): PickOwner
  contMap: ReadonlyMap<string, PlacedContinent>
  detailTexture?: THREE.CanvasTexture | null
  tier?: RenderTier
  l3Tiles?: MicroHex[] | null
  ownerForL3?: ((m: MicroHex) => PickOwner) | null
  mountainMap?: ReadonlyMap<string, MountainL1Entry | MountainL2Cell> | null
}

/**
 * Build a watertight high-frequency eroded hexagonal terrain mesh + coastal shoal apron.
 * subdiv=4 -> 96 sub-triangles per hex (LOD 1-2)
 * subdiv=2 -> 24 sub-triangles per hex (LOD 0)
 */
export function buildErodedTerrain<T extends TerrainHex>(
  tiles: T[],
  opts: BuildErodedTerrainOptions<T>,
): ErodedTerrainResult {
  const {
    radius: R,
    subdiv = 4,
    sampler,
    ownerForTile,
    contMap,
    detailTexture = null,
    tier = 'l12',
    l3Tiles = null,
    ownerForL3 = null,
    mountainMap = null,
  } = opts

  const tileByKey = new Map<string, T>()
  for (const t of tiles) tileByKey.set(key(t), t)

  const neighborOf = (t: T, dirIdx: number): T | null => {
    const [dq, dr] = DIRECTIONS[dirIdx]
    return tileByKey.get(`${t.q + dq},${t.r + dr}`) || null
  }

  const cornerCache = new Map<string, CornerVert>()
  function getCorner(t: T, k: number): CornerVert {
    const nomX = t.x + R * CORNER_COS[k]
    const nomZ = t.z + R * CORNER_SIN[k]
    const ck = `${Math.round(nomX * 120)},${Math.round(nomZ * 120)}`
    const existing = cornerCache.get(ck)
    if (existing) return existing

    const nb0 = neighborOf(t, k)
    const nb1 = neighborOf(t, (k + 5) % 6)
    const inc: T[] = [t]
    if (nb0) inc.push(nb0)
    if (nb1) inc.push(nb1)
    const isCoast = inc.length < 3

    let vx = nomX
    let vz = nomZ
    if (isCoast) {
      let cxAvg = 0
      let czAvg = 0
      for (const h of inc) {
        cxAvg += h.x
        czAvg += h.z
      }
      cxAvg /= inc.length
      czAvg /= inc.length
      const dx = nomX - cxAvg
      const dz = nomZ - czAvg
      const dLen = Math.hypot(dx, dz) || 1
      const wiggle = fbm2(nomX * 0.65, nomZ * 0.65)
      const push = (inc.length === 1 ? -0.055 : 0.01) * R + wiggle * 0.052 * R
      vx = nomX + (dx / dLen) * push
      vz = nomZ + (dz / dLen) * push
    }

    const v: CornerVert = { x: vx, z: vz, key: `c:${ck}`, isCoast }
    cornerCache.set(ck, v)
    return v
  }

  const N = subdiv
  const TRIS_PER_HEX = 6 * N * N
  const totalTris = tiles.length * TRIS_PER_HEX
  const totalVerts = totalTris * 3

  const positions = new Float32Array(totalVerts * 3)
  const normals = new Float32Array(totalVerts * 3)
  const uvs = new Float32Array(totalVerts * 2)
  const colors = new Float32Array(totalVerts * 3)

  const triHexIdx = new Uint32Array(totalTris)
  const triNy = new Float32Array(totalTris)
  const vertFlags = new Uint8Array(totalVerts)
  const vertKeys = new Array<string>(totalVerts)
  const flatNormals = new Float32Array(totalTris * 3)
  const smoothAccum = new Map<string, [number, number, number]>()

  const hexOwners = new Array<PickOwner>(tiles.length)
  const hexBiomes = new Array<BiomeId>(tiles.length)
  const hexTiles = tiles
  const coastEdges: Array<{
    t: T
    owner: PickOwner
    p0: { x: number; z: number; key: string }
    pm: { x: number; z: number; key: string }
    p1: { x: number; z: number; key: string }
  }> = []

  let vi = 0
  let ti = 0
  const uvScale = 0.22

  function pushTri(hexIdx: number, A: SectorVert, B: SectorVert, C: SectorVert): void {
    const e1x = B.x - A.x
    const e1y = B.y - A.y
    const e1z = B.z - A.z
    const e2x = C.x - A.x
    const e2y = C.y - A.y
    const e2z = C.z - A.z
    let nx = e1y * e2z - e1z * e2y
    let ny = e1z * e2x - e1x * e2z
    let nz = e1x * e2y - e1y * e2x
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len
    ny /= len
    nz /= len
    if (ny < 0) {
      nx = -nx
      ny = -ny
      nz = -nz
    }

    flatNormals[ti * 3] = nx
    flatNormals[ti * 3 + 1] = ny
    flatNormals[ti * 3 + 2] = nz
    triHexIdx[ti] = hexIdx
    triNy[ti] = ny
    ti++

    const verts = [A, B, C]
    for (let m = 0; m < 3; m++) {
      const p = verts[m]
      positions[vi * 3] = p.x
      positions[vi * 3 + 1] = p.y
      positions[vi * 3 + 2] = p.z
      uvs[vi * 2] = p.x * uvScale
      uvs[vi * 2 + 1] = p.z * uvScale
      vertFlags[vi] = p.flags
      vertKeys[vi] = p.k

      let acc = smoothAccum.get(p.k)
      if (!acc) {
        acc = [0, 0, 0]
        smoothAccum.set(p.k, acc)
      }
      acc[0] += nx
      acc[1] += ny
      acc[2] += nz
      vi++
    }
  }

  const grid: SectorVert[][] = Array.from({ length: N + 1 }, () => new Array<SectorVert>(N + 1))

  for (let hIdx = 0; hIdx < tiles.length; hIdx++) {
    const t = tiles[hIdx]
    const owner = ownerForTile(t)
    hexOwners[hIdx] = owner
    hexBiomes[hIdx] = biomeOf(t.continent, contMap)

    const corners = new Array<CornerVert>(6)
    for (let k = 0; k < 6; k++) corners[k] = getCorner(t, k)

    for (let k = 0; k < 6; k++) {
      const kn = (k + 1) % 6
      const cA = corners[k]
      const cB = corners[kn]
      const nb = neighborOf(t, k)
      const edgeIsCoast = !nb

      for (let i = 0; i <= N; i++) {
        for (let j = 0; j <= N - i; j++) {
          const v = i / N
          const w = j / N
          const u = 1 - v - w
          const px = u * t.x + v * cA.x + w * cB.x
          const pz = u * t.z + v * cA.z + w * cB.z

          const s = sampler.sample(px, pz)
          let py = s.h

          if (edgeIsCoast && u === 0) {
            py = SEA_Y - 0.1 + noise2(px * 1.1, pz * 1.1) * 0.02
          } else if (edgeIsCoast && u < 0.55) {
            const blend = smoothstep(0, 0.55, u)
            const shoreH = SEA_Y - 0.09
            py = shoreH * (1 - blend) + py * blend
          } else if ((v === 1 && cA.isCoast) || (w === 1 && cB.isCoast)) {
            py = SEA_Y - 0.09
          } else if ((cA.isCoast && w === 0 && v > 0.5) || (cB.isCoast && v === 0 && w > 0.5)) {
            const dCoast = cA.isCoast && w === 0 ? 1 - v : 1 - w
            const blend = smoothstep(0, 0.5, dCoast)
            py = (SEA_Y - 0.09) * (1 - blend) + py * blend
          }

          const flags = (s.riverBank ? 1 : 0) | (s.isRiver ? 2 : 0) | (s.inPad ? 4 : 0)
          const vk = `${Math.round(px * 80)},${Math.round(pz * 80)}`
          grid[i][j] = { x: px, y: py, z: pz, flags, k: vk }
        }
      }

      if (edgeIsCoast) {
        coastEdges.push({
          t,
          owner,
          p0: { x: cA.x, z: cA.z, key: cA.key },
          pm: {
            x: (cA.x + cB.x) * 0.5,
            z: (cA.z + cB.z) * 0.5,
            key: `m:${Math.round((cA.x + cB.x) * 60)},${Math.round((cA.z + cB.z) * 60)}`,
          },
          p1: { x: cB.x, z: cB.z, key: cB.key },
        })
      }

      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N - i; j++) {
          const A = grid[i][j]
          const B = grid[i + 1][j]
          const C = grid[i][j + 1]
          pushTri(hIdx, A, C, B)
          if (i + j + 1 < N) {
            const D = grid[i + 1][j + 1]
            pushTri(hIdx, B, C, D)
          }
        }
      }
    }
  }

  for (const acc of smoothAccum.values()) {
    const l = Math.hypot(acc[0], acc[1], acc[2]) || 1
    acc[0] /= l
    acc[1] /= l
    acc[2] /= l
  }
  for (let tIdx = 0; tIdx < totalTris; tIdx++) {
    const fnx = flatNormals[tIdx * 3]
    const fny = flatNormals[tIdx * 3 + 1]
    const fnz = flatNormals[tIdx * 3 + 2]
    const avgY =
      (positions[tIdx * 3 * 3 + 1] + positions[(tIdx * 3 + 1) * 3 + 1] + positions[(tIdx * 3 + 2) * 3 + 1]) / 3
    const isCrag = fny < 0.76 || avgY > 0.96
    const flatWeight = isCrag ? 0.44 : 0.14
    const smoothWeight = 1 - flatWeight
    for (let m = 0; m < 3; m++) {
      const vIdx = tIdx * 3 + m
      const sn = smoothAccum.get(vertKeys[vIdx])!
      const nx = fnx * flatWeight + sn[0] * smoothWeight
      const ny = fny * flatWeight + sn[1] * smoothWeight
      const nz = fnz * flatWeight + sn[2] * smoothWeight
      const l = Math.hypot(nx, ny, nz) || 1
      normals[vIdx * 3] = nx / l
      normals[vIdx * 3 + 1] = ny / l
      normals[vIdx * 3 + 2] = nz / l
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  const colorAttr = new THREE.BufferAttribute(colors, 3)
  geo.setAttribute('color', colorAttr)
  geo.computeBoundingSphere()

  const mat = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    vertexColors: true,
    map: detailTexture,
    roughness: 0.88,
    metalness: 0.02,
  })

  const mesh = new THREE.Mesh(geo, mat)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.userData.isTerrainMesh = true
  mesh.userData.tier = tier

  const l3ByKey = new Map<string, { m: MicroHex; owner: PickOwner }>()
  if (l3Tiles && ownerForL3) {
    for (const m of l3Tiles) l3ByKey.set(key(m), { m, owner: ownerForL3(m) })
  }

  mesh.userData.ownerForHit = (hit: THREE.Intersection, lodTier: number): PickOwner | null => {
    if (hit.faceIndex === undefined || hit.faceIndex === null) return null
    const hexIdx = triHexIdx[hit.faceIndex]
    const baseOwner = hexOwners[hexIdx] || null
    if (lodTier === 2 && l3ByKey.size && (!baseOwner || baseOwner.isTile)) {
      const mCoord = unworld({ x: hit.point.x, z: hit.point.z }, RADIUS * 0.5)
      const l3Entry = l3ByKey.get(key(mCoord))
      if (l3Entry) return l3Entry.owner
    }
    return baseOwner
  }

  // Non-overlapping planar coastal bathymetry & surf-foam apron
  interface CoastSeg {
    ax: number
    az: number
    bx: number
    bz: number
    owner: PickOwner
  }
  const COAST_CELL = Math.max(2.0, R * 2.5)
  const coastGrid = new Map<number, CoastSeg[]>()
  for (const ce of coastEdges) {
    const pushSeg = (p0: WorldXZ, p1: WorldXZ): void => {
      const seg: CoastSeg = { ax: p0.x, az: p0.z, bx: p1.x, bz: p1.z, owner: ce.owner }
      const pad = R * 2.4
      const minCx = Math.floor((Math.min(p0.x, p1.x) - pad) / COAST_CELL)
      const maxCx = Math.floor((Math.max(p0.x, p1.x) + pad) / COAST_CELL)
      const minCz = Math.floor((Math.min(p0.z, p1.z) - pad) / COAST_CELL)
      const maxCz = Math.floor((Math.max(p0.z, p1.z) + pad) / COAST_CELL)
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
          const gk = cellKey(cx, cz)
          let arr = coastGrid.get(gk)
          if (!arr) {
            arr = []
            coastGrid.set(gk, arr)
          }
          arr.push(seg)
        }
      }
    }
    pushSeg(ce.p0, ce.pm)
    pushSeg(ce.pm, ce.p1)
  }

  function nearestCoast(x: number, z: number): { dist: number; owner: PickOwner | null } {
    const arr = coastGrid.get(cellKey(Math.floor(x / COAST_CELL), Math.floor(z / COAST_CELL)))
    if (!arr) return { dist: 99, owner: null }
    let bestD2 = Infinity
    let bestOwner: PickOwner | null = null
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i]
      const d2 = distSqToSegment(x, z, s.ax, s.az, s.bx, s.bz)
      if (d2 < bestD2) {
        bestD2 = d2
        bestOwner = s.owner
      }
    }
    return { dist: Math.sqrt(bestD2), owner: bestOwner }
  }

  interface ShoalHex {
    q: number
    r: number
    x: number
    z: number
    isLand: boolean
    ring: number
  }
  const shoalHexes: ShoalHex[] = []
  const shoalSeen = new Set<string>()
  const ring1List: ShoalHex[] = []
  for (const ce of coastEdges) {
    const tk = key(ce.t)
    if (!shoalSeen.has(tk)) {
      shoalSeen.add(tk)
      shoalHexes.push({ q: ce.t.q, r: ce.t.r, x: ce.t.x, z: ce.t.z, isLand: true, ring: 0 })
    }
    for (let dir = 0; dir < 6; dir++) {
      const [dq, dr] = DIRECTIONS[dir]
      const nq = ce.t.q + dq
      const nr = ce.t.r + dr
      const nk = `${nq},${nr}`
      if (tileByKey.has(nk) || shoalSeen.has(nk)) continue
      shoalSeen.add(nk)
      const wx = SQRT3 * R * (nq + nr * 0.5)
      const wz = 1.5 * R * nr
      const entry: ShoalHex = { q: nq, r: nr, x: wx, z: wz, isLand: false, ring: 1 }
      shoalHexes.push(entry)
      ring1List.push(entry)
    }
  }
  for (const h1 of ring1List) {
    for (let dir = 0; dir < 6; dir++) {
      const [dq, dr] = DIRECTIONS[dir]
      const nq = h1.q + dq
      const nr = h1.r + dr
      const nk = `${nq},${nr}`
      if (tileByKey.has(nk) || shoalSeen.has(nk)) continue
      shoalSeen.add(nk)
      const wx = SQRT3 * R * (nq + nr * 0.5)
      const wz = 1.5 * R * nr
      shoalHexes.push({ q: nq, r: nr, x: wx, z: wz, isLand: false, ring: 2 })
    }
  }

  function getShoalCorner(h: ShoalHex, k: number): WorldXZ {
    const nomX = h.x + R * CORNER_COS[k]
    const nomZ = h.z + R * CORNER_SIN[k]
    const ck = `${Math.round(nomX * 120)},${Math.round(nomZ * 120)}`
    const cached = cornerCache.get(ck)
    if (cached) return cached
    return { x: nomX, z: nomZ }
  }

  const SHOAL_Y = SEA_Y + 0.01
  const shelfR = R > 1.5 ? 1.45 : R
  const shoalPosList: number[] = []
  const shoalDistList: number[] = []
  const shoalOwnerList: Array<PickOwner | null> = []
  const M_INNER = R > 1.5 ? 2 : 3
  const M_OUTER = 2
  const sGrid: ShoalVert[][] = Array.from({ length: M_INNER + 1 }, () => new Array<ShoalVert>(M_INNER + 1))

  for (let hi = 0; hi < shoalHexes.length; hi++) {
    const h = shoalHexes[hi]
    const M = h.ring <= 1 ? M_INNER : M_OUTER
    const corners = new Array<WorldXZ>(6)
    for (let k = 0; k < 6; k++) corners[k] = getShoalCorner(h, k)

    for (let k = 0; k < 6; k++) {
      const cA = corners[k]
      const cB = corners[(k + 1) % 6]
      let anyVisible = false
      for (let i = 0; i <= M; i++) {
        for (let j = 0; j <= M - i; j++) {
          const v = i / M
          const w = j / M
          const u = 1 - v - w
          const px = u * h.x + v * cA.x + w * cB.x
          const pz = u * h.z + v * cA.z + w * cB.z
          const nc = nearestCoast(px, pz)
          const sd = (h.isLand ? -nc.dist : nc.dist) + 0.15 * R
          const normT = sd / shelfR
          if (normT < 2.05) anyVisible = true
          sGrid[i][j] = { x: px, z: pz, t: normT, owner: nc.owner }
        }
      }
      if (!anyVisible) continue

      const emitTri = (A: ShoalVert, B: ShoalVert, C: ShoalVert): void => {
        if (A.t >= 2.02 && B.t >= 2.02 && C.t >= 2.02) return
        for (const p of [A, B, C]) {
          shoalPosList.push(p.x, SHOAL_Y, p.z)
          shoalDistList.push(p.t)
          shoalOwnerList.push(p.owner)
        }
      }

      for (let i = 0; i < M; i++) {
        for (let j = 0; j < M - i; j++) {
          const A = sGrid[i][j]
          const B = sGrid[i + 1][j]
          const C = sGrid[i][j + 1]
          emitTri(A, C, B)
          if (i + j + 1 < M) {
            const D = sGrid[i + 1][j + 1]
            emitTri(B, C, D)
          }
        }
      }
    }
  }

  const shoalVertCount = shoalDistList.length
  const shoalPos = new Float32Array(shoalPosList)
  const shoalCol = new Float32Array(shoalVertCount * 4)
  const shoalDist = new Float32Array(shoalDistList)
  const shoalVertOwners = shoalOwnerList

  const shoalGeo = new THREE.BufferGeometry()
  shoalGeo.setAttribute('position', new THREE.BufferAttribute(shoalPos, 3))
  const shoalColAttr = new THREE.BufferAttribute(shoalCol, 4)
  shoalGeo.setAttribute('color', shoalColAttr)
  shoalGeo.computeVertexNormals()
  const shoalMat = new THREE.MeshBasicMaterial({
    color: '#ffffff',
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  })
  const shoalMesh = new THREE.Mesh(shoalGeo, shoalMat)
  shoalMesh.renderOrder = 1
  shoalMesh.userData.tier = tier

  const cTmp = new THREE.Color()
  const cCliff = new THREE.Color()
  const cGrey = new THREE.Color()
  const cShared = new THREE.Color()
  const cShallow = new THREE.Color()
  const cFoam = new THREE.Color()
  const cSea = new THREE.Color()
  const cGranite = new THREE.Color()
  const cGraniteDark = new THREE.Color()
  const cSnow = new THREE.Color()

  function updateColors(
    p: SchemePalette,
    bp: Record<BiomeId, BiomePalette>,
    lens: LensState | null,
    night: boolean,
    matchesFn: (owner: PickOwner) => boolean,
  ): void {
    cShallow.set(p.shallow)
    cFoam.set(p.foam)
    cSea.set(p.sea)
    cShared.set(p.shared)
    cGranite.set(night ? '#4a5864' : '#737a80')
    cGraniteDark.set(night ? '#323e49' : '#525960')
    cSnow.set(night ? '#ccd8e0' : '#f8fafc')

    const makePal = (src: Pick<BiomePalette, 'sand' | 'rock' | 'valley' | 'meadow' | 'land' | 'highland' | 'alpine' | 'peak'>) => ({
      sand: new THREE.Color(src.sand),
      rock: new THREE.Color(src.rock),
      valley: new THREE.Color(src.valley),
      meadow: new THREE.Color(src.meadow),
      land: new THREE.Color(src.land),
      highland: new THREE.Color(src.highland),
      alpine: new THREE.Color(src.alpine),
      peak: new THREE.Color(src.peak),
    })
    const defPal = makePal(p)
    const biomePal: Record<BiomeId, ReturnType<typeof makePal>> = {
      mediterranean: makePal(bp.mediterranean),
      temperate: makePal(bp.temperate),
      savanna: makePal(bp.savanna),
      nordic: makePal(bp.nordic),
    }

    const colArr = colorAttr.array as Float32Array
    const posArr = positions
    const dimMul = night ? 0.18 : 0.26
    const sharedMix = lens?.type === 'search' ? 0.22 : 0.13

    for (let tIdx = 0; tIdx < totalTris; tIdx++) {
      const hexIdx = triHexIdx[tIdx]
      const tile = hexTiles[hexIdx]
      const owner = hexOwners[hexIdx]
      const pal = biomePal[hexBiomes[hexIdx]] || defPal
      const ny = triNy[tIdx]

      const isHit = !lens || (Boolean(owner) && matchesFn(owner))
      const isHighlight = Boolean(lens && isHit && (lens.type === 'shared' || lens.type === 'search') && owner?.isTile)
      const steepCliff = smoothstep(0.78, 0.54, ny)

      for (let m = 0; m < 3; m++) {
        const vIdx = tIdx * 3 + m
        const vx = posArr[vIdx * 3]
        const vy = posArr[vIdx * 3 + 1]
        const vz = posArr[vIdx * 3 + 2]
        const flags = vertFlags[vIdx]
        const isRiverBank = (flags & 1) !== 0
        const isRiverBed = (flags & 2) !== 0

        const nVal = noise2(vx * 0.34, vz * 0.34)
        const fineN = noise2(vx * 1.45 + 9.2, vz * 1.45 - 4.7)
        const rawH = tile.height || 0.5

        if (vy <= SEA_Y + 0.04) {
          cTmp.copy(cShallow).lerp(pal.sand, smoothstep(SEA_Y - 0.1, SEA_Y + 0.04, vy))
        } else if (vy <= 0.04 && tile.coast) {
          cTmp.copy(pal.sand)
        } else {
          const meadowMix = clamp(0.46 + nVal * 0.48, 0, 1)
          cTmp.copy(pal.land).lerp(pal.meadow, meadowMix)

          if (isRiverBank) {
            const bankTone = 0.8 * (1 - smoothstep(1.15, 1.75, rawH))
            cTmp.lerp(pal.valley, bankTone)
            cTmp.multiplyScalar(night ? 0.94 : 0.92)
          } else if (tile.valley) {
            cTmp.lerp(pal.valley, 0.68 * (1 - smoothstep(1.15, 1.75, rawH)))
          }
          if (isRiverBed) {
            cTmp.lerp(cGraniteDark, 0.56)
          }
          if (tile.coast && vy < 0.115) {
            cTmp.lerp(pal.sand, 1 - smoothstep(0.01, 0.115, vy))
          }

          const mCell = mountainMap ? mountainMap.get(key(tile)) : null
          if (mCell && (mCell.mClass === 'ridge' || mCell.mClass === 'peak' || mCell.mClass === 'high_peak')) {
            cTmp.lerp(pal.highland, 0.56)
            cCliff.copy(cGranite).lerp(pal.rock, 0.3)
            const screeMix = clamp(0.42 + mCell.mStrength * 0.34 + fineN * 0.08, 0.32, 0.78)
            cTmp.lerp(cCliff, screeMix)
          } else if (mCell && mCell.mClass === 'foothill') {
            cTmp.lerp(pal.valley, 0.44)
            cTmp.lerp(pal.highland, 0.22)
          } else if (rawH > 1.08) {
            cTmp.lerp(pal.highland, smoothstep(1.08, 1.85, rawH) * 0.36)
          }
          if (steepCliff > 0.001) {
            cCliff.copy(cGraniteDark).lerp(pal.rock, 0.36)
            cTmp.lerp(cCliff, steepCliff * 0.65)
          }
        }

        cTmp.multiplyScalar(1 + fineN * 0.045)

        if (lens) {
          if (!isHit) {
            const lum = cTmp.r * 0.2126 + cTmp.g * 0.7152 + cTmp.b * 0.0722
            cGrey.setScalar(lum)
            cTmp.lerp(cGrey, 0.82).multiplyScalar(dimMul)
          } else if (isHighlight) {
            cTmp.lerp(cShared, sharedMix)
          }
        }

        colArr[vIdx * 3] = cTmp.r
        colArr[vIdx * 3 + 1] = cTmp.g
        colArr[vIdx * 3 + 2] = cTmp.b
      }
    }
    colorAttr.needsUpdate = true

    const sArr = shoalColAttr.array as Float32Array
    const cMid = cTmp
    const cShelf = new THREE.Color().copy(cShallow).lerp(cSea, 0.56)
    const cFoamShallow = new THREE.Color().copy(cFoam).lerp(cShallow, 0.62)
    for (let idx = 0; idx < shoalVertCount; idx++) {
      const owner = shoalVertOwners[idx]
      const isHit = !lens || (Boolean(owner) && matchesFn(owner!))
      const dim = isHit ? 1 : night ? 0.22 : 0.3
      const sharedEdge = Boolean(owner?.shared && lens?.type === 'shared')
      const d = shoalDist[idx]
      let alpha: number

      if (d <= 0.14) {
        const f = clamp(d / 0.14, 0, 1)
        cMid.copy(cFoam).lerp(cFoamShallow, f)
        if (sharedEdge) cMid.lerp(cShared, 0.44 - f * 0.12)
        alpha = ((night ? 0.46 : 0.76) * (1 - f) + (night ? 0.36 : 0.58) * f) * dim
      } else if (d <= 0.56) {
        const f = (d - 0.14) / 0.42
        cMid.copy(cFoamShallow).lerp(cShallow, f)
        if (sharedEdge) cMid.lerp(cShared, 0.32 - f * 0.1)
        alpha = ((night ? 0.36 : 0.58) * (1 - f) + (night ? 0.26 : 0.4) * f) * dim
      } else if (d <= 1.24) {
        const f = (d - 0.56) / 0.68
        cMid.copy(cShallow).lerp(cShelf, f)
        if (sharedEdge) cMid.lerp(cShared, 0.22 * (1 - f))
        alpha = ((night ? 0.26 : 0.4) * (1 - f) + (night ? 0.12 : 0.18) * f) * dim
      } else if (d <= 1.96) {
        const f = smoothstep(1.24, 1.96, d)
        cMid.copy(cShelf).lerp(cSea, f)
        alpha = (night ? 0.12 : 0.18) * (1 - f) * dim
      } else {
        cMid.copy(cSea)
        alpha = 0.0
      }

      if (lens && !isHit) {
        const lum = cMid.r * 0.2126 + cMid.g * 0.7152 + cMid.b * 0.0722
        cGrey.setScalar(lum)
        cMid.lerp(cGrey, 0.82).multiplyScalar(night ? 0.22 : 0.32)
      }
      sArr[idx * 4] = cMid.r
      sArr[idx * 4 + 1] = cMid.g
      sArr[idx * 4 + 2] = cMid.b
      sArr[idx * 4 + 3] = alpha
    }
    shoalColAttr.needsUpdate = true
  }

  return { mesh, shoalMesh, updateColors, triCount: totalTris }
}

/**
 * Build a single continuous Catmull-Rom winding river ribbon mesh tucked inside carved valleys,
 * smoothly tapering from narrow headwaters to flared coastal estuaries.
 */
export function buildRiverWaterMesh(
  sampler: TerrainSampler,
  riverTexture: THREE.CanvasTexture | null,
): THREE.Mesh {
  const positions: number[] = []
  const uvs: number[] = []
  const owners: TileOwner[] = []

  for (const rp of sampler.riverPaths) {
    const pts = rp.pts
    if (pts.length < 2) continue

    const rawY = pts.map(p => {
      const sCenter = sampler.sample(p.x, p.z)
      let wy = Math.max(SEA_Y + 0.02, sCenter.h + 0.052)
      if (rp.isOutlet && p.frac > 0.82) {
        const mouthBlend = smoothstep(0.82, 1.0, p.frac)
        wy = wy * (1 - mouthBlend) + (SEA_Y + 0.015) * mouthBlend
      }
      return wy
    })
    const smoothY = rawY.map((y, i) => {
      const yPrev = rawY[Math.max(0, i - 1)]
      const yNext = rawY[Math.min(rawY.length - 1, i + 1)]
      return yPrev * 0.25 + y * 0.5 + yNext * 0.25
    })

    const leftPts: Array<{ x: number; y: number; z: number }> = []
    const rightPts: Array<{ x: number; y: number; z: number }> = []
    const vCoords: number[] = []
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      const prev = pts[Math.max(0, i - 1)]
      const next = pts[Math.min(pts.length - 1, i + 1)]

      const tx = next.x - prev.x
      const tz = next.z - prev.z
      const tLen = Math.hypot(tx, tz) || 1
      const nx = -tz / tLen
      const nz = tx / tLen
      const halfW = p.halfW || 0.21
      const waterY = smoothY[i]

      leftPts.push({ x: p.x - nx * halfW, y: waterY, z: p.z - nz * halfW })
      rightPts.push({ x: p.x + nx * halfW, y: waterY, z: p.z + nz * halfW })
      vCoords.push((p.arc || 0) * 0.45)
    }

    for (let i = 0; i < pts.length - 1; i++) {
      const l0 = leftPts[i]
      const r0 = rightPts[i]
      const l1 = leftPts[i + 1]
      const r1 = rightPts[i + 1]
      const v0 = vCoords[i]
      const v1 = vCoords[i + 1]

      positions.push(l0.x, l0.y, l0.z, r0.x, r0.y, r0.z, l1.x, l1.y, l1.z)
      uvs.push(0, v0, 1, v0, 0, v1)
      owners.push(rp.owner)

      positions.push(r0.x, r0.y, r0.z, r1.x, r1.y, r1.z, l1.x, l1.y, l1.z)
      uvs.push(1, v0, 1, v1, 0, v1)
      owners.push(rp.owner)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.computeVertexNormals()

  const mat = new THREE.MeshStandardMaterial({
    color: '#4696ab',
    map: riverTexture || null,
    roughness: 0.2,
    metalness: 0.14,
    emissive: '#1e5b6e',
    emissiveIntensity: 0.09,
    side: THREE.DoubleSide,
  })

  const mesh = new THREE.Mesh(geo, mat)
  mesh.receiveShadow = true
  mesh.userData.tier = 'l12'
  mesh.userData.isRiverMesh = true
  mesh.userData.ownerForHit = (hit: THREE.Intersection): PickOwner | null => {
    if (hit.faceIndex === undefined || hit.faceIndex === null) return null
    return owners[hit.faceIndex] || null
  }
  return mesh
}

/** Whisper-faint draped cartographic hex seams conforming to the eroded terrain surface. */
export function buildDrapedHexBorders<T extends Axial>(
  hexList: T[],
  hexRadius: number,
  toWorld: (h: T) => WorldXZ,
  sampler: TerrainSampler,
): THREE.LineSegments {
  const verts: number[] = []
  const seen = new Set<string>()
  const LIFT = 0.016

  for (const h of hexList) {
    const c = toWorld(h)
    for (let k = 0; k < 6; k++) {
      const kn = (k + 1) % 6
      const ax = c.x + hexRadius * CORNER_COS[k]
      const az = c.z + hexRadius * CORNER_SIN[k]
      const bx = c.x + hexRadius * CORNER_COS[kn]
      const bz = c.z + hexRadius * CORNER_SIN[kn]
      const mx = (ax + bx) * 0.5
      const mz = (az + bz) * 0.5
      const ek = `${Math.round(mx * 40)},${Math.round(mz * 40)}`
      if (seen.has(ek)) continue
      seen.add(ek)

      const ay = sampler.sampleHeight(ax, az)
      const my = sampler.sampleHeight(mx, mz)
      const by = sampler.sampleHeight(bx, bz)
      if (ay < SEA_Y + 0.02 && my < SEA_Y + 0.02 && by < SEA_Y + 0.02) continue

      verts.push(
        ax,
        Math.max(SEA_Y + 0.02, ay) + LIFT,
        az,
        mx,
        Math.max(SEA_Y + 0.02, my) + LIFT,
        mz,
        mx,
        Math.max(SEA_Y + 0.02, my) + LIFT,
        mz,
        bx,
        Math.max(SEA_Y + 0.02, by) + LIFT,
        bz,
      )
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  const mat = new THREE.LineBasicMaterial({
    color: '#1e3236',
    transparent: true,
    opacity: 0.09,
    depthWrite: false,
  })
  return new THREE.LineSegments(geo, mat)
}
