// Continuous Grid-Free Jittered-Delaunay Terrain Mesh, Coastal Bathymetry Apron,
// Alpine Tarn Lake Mesh, Organic Drainage River Ribbon & Draped Hex Borders.
import * as THREE from 'three'
import { SEA_Y, type TerrainPatch } from './geomorphology.js'
import { RADIUS, biomeOf, key, parent, unworld } from './layout.js'
import type {
  Axial,
  BiomeId,
  BiomePalette,
  CoarseCell,
  FineTile,
  LensState,
  MicroHex,
  PickOwner,
  PlacedContinent,
  SchemePalette,
  TerrainSampler,
  TileOwner,
  WorldXZ,
} from './types.js'

export { SEA_Y }

const CORNER_ANGLES = Array.from({ length: 6 }, (_, k) => (k * Math.PI) / 3 - Math.PI / 6)
const CORNER_COS = CORNER_ANGLES.map(Math.cos)
const CORNER_SIN = CORNER_ANGLES.map(Math.sin)

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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Seamless subtle world-space turf/granite micro-grain texture (no baked hex borders). */
export function makeTerrainDetailTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const S = 128
  const c = document.createElement('canvas')
  c.width = c.height = S
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#f6f6f2'
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
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,248,0.13)' : 'rgba(105,120,114,0.11)'
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
  lakeMesh: THREE.Mesh | null
  updateColors(
    p: SchemePalette,
    bp: Record<BiomeId, BiomePalette>,
    lens: LensState | null,
    night: boolean,
    matchesFn: (owner: PickOwner) => boolean,
  ): void
  triCount: number
}

export interface RiverWaterResult {
  mesh: THREE.Mesh
  updateColors(
    p: SchemePalette,
    lens: LensState | null,
    night: boolean,
    matchesFn: (owner: PickOwner) => boolean,
  ): void
}

export interface BuildDelaunayTerrainOptions {
  patches: readonly TerrainPatch[]
  tileMap: ReadonlyMap<string, FineTile>
  l1Map: ReadonlyMap<string, CoarseCell>
  l3Tiles?: readonly MicroHex[] | null
  ownerForL1(c: CoarseCell): PickOwner
  ownerForL2(t: FineTile): PickOwner
  ownerForL3?: ((m: MicroHex) => PickOwner) | null
  contMap: ReadonlyMap<string, PlacedContinent>
  detailTexture?: THREE.CanvasTexture | null
}

const BIOME_LIST: readonly BiomeId[] = ['mediterranean', 'temperate', 'savanna', 'nordic']

function biomeIndex(b: BiomeId): number {
  const idx = BIOME_LIST.indexOf(b)
  return idx >= 0 ? idx : 0
}

/**
 * Build the continuous eroded Delaunay terrain mesh, exact shoreline bathymetry apron,
 * and flat depth-clipped alpine tarn lake mesh across the entire archipelago.
 */
export function buildDelaunayTerrain(opts: BuildDelaunayTerrainOptions): ErodedTerrainResult {
  const { patches, tileMap, l1Map, l3Tiles = null, ownerForL1, ownerForL2, ownerForL3 = null, contMap, detailTexture = null } = opts

  // Pre-build owner caches for fast vertex metadata & O(1) raycast picking
  const l2OwnerCache = new Map<string, { idx: number; owner: PickOwner; biomeIdx: number }>()
  const ownerList: PickOwner[] = []

  const getL2OwnerEntry = (t: FineTile): { idx: number; owner: PickOwner; biomeIdx: number } => {
    const tk = key(t)
    const hit = l2OwnerCache.get(tk)
    if (hit) return hit
    const owner = ownerForL2(t)
    const idx = ownerList.length
    ownerList.push(owner)
    const entry = { idx, owner, biomeIdx: biomeIndex(biomeOf(t.continent, contMap)) }
    l2OwnerCache.set(tk, entry)
    return entry
  }

  const l1OwnerCache = new Map<string, PickOwner>()
  const getL1Owner = (c: CoarseCell): PickOwner => {
    const ck = key(c)
    const hit = l1OwnerCache.get(ck)
    if (hit) return hit
    const o = ownerForL1(c)
    l1OwnerCache.set(ck, o)
    return o
  }

  const l3ByKey = new Map<string, PickOwner>()
  if (l3Tiles && ownerForL3) {
    for (const m of l3Tiles) l3ByKey.set(key(m), ownerForL3(m))
  }

  // Resolve nearest L2 tile for any (x, z) on a patch (used for coastline/shelf vertices too)
  const resolveNearestL2 = (x: number, z: number, fallbackContId: string): { idx: number; biomeIdx: number } => {
    const c0 = unworld({ x, z }, RADIUS)
    const direct = tileMap.get(key(c0))
    if (direct) {
      const e = getL2OwnerEntry(direct)
      return { idx: e.idx, biomeIdx: e.biomeIdx }
    }
    let bestT: FineTile | null = null
    let bestD2 = Infinity
    for (let dq = -2; dq <= 2; dq++) {
      for (let dr = -2; dr <= 2; dr++) {
        if (Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)) > 2) continue
        const t = tileMap.get(`${c0.q + dq},${c0.r + dr}`)
        if (t) {
          const d2 = (x - t.x) * (x - t.x) + (z - t.z) * (z - t.z)
          if (d2 < bestD2) {
            bestD2 = d2
            bestT = t
          }
        }
      }
    }
    if (bestT) {
      const e = getL2OwnerEntry(bestT)
      return { idx: e.idx, biomeIdx: e.biomeIdx }
    }
    return { idx: -1, biomeIdx: biomeIndex(biomeOf(fallbackContId, contMap)) }
  }

  // First pass: count kept terrain triangles, shoal triangles, and lake triangles
  const SHELF_CULL = 2.35
  const patchKeptTris: number[][] = []
  const patchShoalTris: number[][] = []
  let totalTris = 0
  let totalShoalTris = 0
  let totalLakeTris = 0

  for (const patch of patches) {
    const { mesh, distSea, distInland, h, land } = patch
    const kept: number[] = []
    const shoals: number[] = []
    for (let t = 0; t < mesh.T; t++) {
      const a = mesh.verts[3 * t]
      const b = mesh.verts[3 * t + 1]
      const c = mesh.verts[3 * t + 2]
      const hasLand = land[a] === 1 || land[b] === 1 || land[c] === 1
      const minDs = Math.min(distSea[a], distSea[b], distSea[c])
      if (hasLand || minDs <= SHELF_CULL) {
        kept.push(t)
      }
      const minDi = Math.min(distInland[a], distInland[b], distInland[c])
      const minH = Math.min(h[a], h[b], h[c])
      if (minDs <= 2.3 && (minDi <= 0.65 || minH <= SEA_Y + 0.08)) {
        shoals.push(t)
      }
    }
    patchKeptTris.push(kept)
    patchShoalTris.push(shoals)
    totalTris += kept.length
    totalShoalTris += shoals.length
    for (const lake of patch.lakes) totalLakeTris += lake.triIndices.length
  }

  // Allocate terrain mesh buffers (non-indexed for crisp alpine facets + smooth lowlands)
  const totalVerts = totalTris * 3
  const positions = new Float32Array(totalVerts * 3)
  const normals = new Float32Array(totalVerts * 3)
  const uvs = new Float32Array(totalVerts * 2)
  const colors = new Float32Array(totalVerts * 3)

  // Compact per-vertex shading metadata for ultra-fast Day/Night & Lens color updates
  const vOwnerIdx = new Int32Array(totalVerts)
  const vBiomeIdx = new Uint8Array(totalVerts)
  const vHAbove = new Float32Array(totalVerts)
  const vHNorm = new Float32Array(totalVerts)
  const vSlope = new Float32Array(totalVerts)
  const vAo = new Float32Array(totalVerts)
  const vRiverMix = new Float32Array(totalVerts)
  const vFlags = new Uint8Array(totalVerts) // bit 0: isLakeBed, bit 1: isLand
  const vNoise = new Float32Array(totalVerts)
  const vFine = new Float32Array(totalVerts)
  const vStrata = new Float32Array(totalVerts)

  const patchOwnerIdx: Int32Array[] = []
  let vi = 0
  const uvScale = 0.22

  for (let pi = 0; pi < patches.length; pi++) {
    const patch = patches[pi]
    const { mesh, h, slope, ao, land, riverMix, lakeId, maxLandHeight, continentIds } = patch
    const { V, vx, vz, verts } = mesh
    const fallbackCont = continentIds[0] || ''
    const kept = patchKeptTris[pi]

    // Precompute smooth area-weighted vertex normals for this patch
    const smoothNx = new Float32Array(V)
    const smoothNy = new Float32Array(V)
    const smoothNz = new Float32Array(V)
    for (let k = 0; k < kept.length; k++) {
      const t = kept[k]
      const a = verts[3 * t]
      const b = verts[3 * t + 1]
      const c = verts[3 * t + 2]
      // Note: mesh triangles are CCW in (x, z), so in Three.js Y-up right-handed coords,
      // (A, C, B) faces +Y!
      const e1x = vx[c] - vx[a]
      const e1y = h[c] - h[a]
      const e1z = vz[c] - vz[a]
      const e2x = vx[b] - vx[a]
      const e2y = h[b] - h[a]
      const e2z = vz[b] - vz[a]
      let nx = e1y * e2z - e1z * e2y
      let ny = e1z * e2x - e1x * e2z
      let nz = e1x * e2y - e1y * e2x
      if (ny < 0) {
        nx = -nx
        ny = -ny
        nz = -nz
      }
      smoothNx[a] += nx
      smoothNy[a] += ny
      smoothNz[a] += nz
      smoothNx[b] += nx
      smoothNy[b] += ny
      smoothNz[b] += nz
      smoothNx[c] += nx
      smoothNy[c] += ny
      smoothNz[c] += nz
    }
    for (let u = 0; u < V; u++) {
      const l = Math.hypot(smoothNx[u], smoothNy[u], smoothNz[u]) || 1
      smoothNx[u] /= l
      smoothNy[u] /= l
      smoothNz[u] /= l
    }

    // Resolve per-vertex owner & biome once per patch vertex
    const pOwnerIdx = new Int32Array(V)
    const pBiomeIdx = new Uint8Array(V)
    for (let u = 0; u < V; u++) {
      const resolved = resolveNearestL2(vx[u], vz[u], fallbackCont)
      pOwnerIdx[u] = resolved.idx
      pBiomeIdx[u] = resolved.biomeIdx
    }
    patchOwnerIdx.push(pOwnerIdx)

    const hScaleRef = Math.max(2.15, maxLandHeight)

    for (let k = 0; k < kept.length; k++) {
      const t = kept[k]
      const a = verts[3 * t]
      const b = verts[3 * t + 1]
      const c = verts[3 * t + 2]

      // Emit in Y-up front-facing winding (a, c, b)
      const e1x = vx[c] - vx[a]
      const e1y = h[c] - h[a]
      const e1z = vz[c] - vz[a]
      const e2x = vx[b] - vx[a]
      const e2y = h[b] - h[a]
      const e2z = vz[b] - vz[a]
      let fnx = e1y * e2z - e1z * e2y
      let fny = e1z * e2x - e1x * e2z
      let fnz = e1x * e2y - e1y * e2x
      const fl = Math.hypot(fnx, fny, fnz) || 1
      fnx /= fl
      fny /= fl
      fnz /= fl
      let i0 = a
      let i1 = c
      let i2 = b
      if (fny < 0) {
        fnx = -fnx
        fny = -fny
        fnz = -fnz
        i1 = b
        i2 = c
      }

      const avgHAbove = (h[i0] + h[i1] + h[i2]) / 3 - SEA_Y
      // Crisp chiseled granite faceting on steep alpine cliffs, silky smooth shading in green valleys!
      const isCrag = fny < 0.84 || (avgHAbove > 1.15 && fny < 0.92)
      const flatW = isCrag ? 0.56 : 0.06
      const smoothW = 1 - flatW
      const triSlope = Math.hypot(fnx, fnz) / Math.max(0.12, fny)

      const ids = [i0, i1, i2]
      for (let m = 0; m < 3; m++) {
        const u = ids[m]
        const px = vx[u]
        const py = h[u]
        const pz = vz[u]
        positions[vi * 3] = px
        positions[vi * 3 + 1] = py
        positions[vi * 3 + 2] = pz
        uvs[vi * 2] = px * uvScale
        uvs[vi * 2 + 1] = pz * uvScale

        const nx = fnx * flatW + smoothNx[u] * smoothW
        const ny = fny * flatW + smoothNy[u] * smoothW
        const nz = fnz * flatW + smoothNz[u] * smoothW
        const nl = Math.hypot(nx, ny, nz) || 1
        normals[vi * 3] = nx / nl
        normals[vi * 3 + 1] = ny / nl
        normals[vi * 3 + 2] = nz / nl

        const hAbove = py - SEA_Y
        vOwnerIdx[vi] = pOwnerIdx[u]
        vBiomeIdx[vi] = pBiomeIdx[u]
        vHAbove[vi] = hAbove
        vHNorm[vi] = Math.max(0, hAbove / hScaleRef)
        vSlope[vi] = Math.max(slope[u], triSlope * 0.82)
        vAo[vi] = ao[u]
        vRiverMix[vi] = riverMix[u]
        vFlags[vi] = (lakeId[u] >= 0 ? 1 : 0) | (land[u] === 1 ? 2 : 0)
        vNoise[vi] = noise2(px * 0.24, pz * 0.24)
        vFine[vi] = noise2(px * 1.35 + 9.2, pz * 1.35 - 4.7)
        vStrata[vi] = 0.95 + 0.05 * Math.sin(py * 12.5 + px * 0.32 - pz * 0.24)
        vi++
      }
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
  mesh.userData.tier = 'all'

  // Exact hex picking across all 3 LOD tiers (L1 World, L2 Continent, L3 Street)
  mesh.userData.ownerForHit = (hit: THREE.Intersection, lodTier: number): PickOwner | null => {
    if (hit.point.y < SEA_Y - 0.05) return null
    const px = hit.point.x
    const pz = hit.point.z
    if (lodTier === 2 && l3ByKey.size) {
      const mCoord = unworld({ x: px, z: pz }, RADIUS * 0.5)
      const l3Owner = l3ByKey.get(key(mCoord))
      if (l3Owner) return l3Owner
    }
    const c2 = unworld({ x: px, z: pz }, RADIUS)
    const t2 = tileMap.get(key(c2))
    if (lodTier === 0) {
      const c1 = t2 ? l1Map.get(t2.cell) : l1Map.get(key(parent(c2)))
      if (c1) return getL1Owner(c1)
    }
    if (t2) return getL2OwnerEntry(t2).owner
    // Fallback for slight coastline organic overhang outside hex boundary
    if (hit.faceIndex !== undefined && hit.faceIndex !== null) {
      const oIdx = vOwnerIdx[hit.faceIndex * 3]
      if (oIdx >= 0 && oIdx < ownerList.length) return ownerList[oIdx]
    }
    return null
  }

  // ---------- Coastal Bathymetry & Surf-Foam Apron (exact Delaunay shoreline!) ----------
  const SHOAL_Y = SEA_Y + 0.01
  const shoalVertCount = totalShoalTris * 3
  const shoalPos = new Float32Array(shoalVertCount * 3)
  const shoalCol = new Float32Array(shoalVertCount * 4)
  const shoalDist = new Float32Array(shoalVertCount)
  const shoalOwnerIdx = new Int32Array(shoalVertCount)
  let si = 0

  for (let pi = 0; pi < patches.length; pi++) {
    const patch = patches[pi]
    const { mesh: pm, distSea, distInland } = patch
    const { vx, vz, verts } = pm
    const pOwner = patchOwnerIdx[pi]
    const shoals = patchShoalTris[pi]

    for (let k = 0; k < shoals.length; k++) {
      const t = shoals[k]
      const a = verts[3 * t]
      const b = verts[3 * t + 1]
      const c = verts[3 * t + 2]
      // Front-facing +Y winding (a, c, b)
      const ids = [a, c, b]
      for (let m = 0; m < 3; m++) {
        const u = ids[m]
        const px = vx[u]
        const pz = vz[u]
        shoalPos[si * 3] = px
        shoalPos[si * 3 + 1] = SHOAL_Y
        shoalPos[si * 3 + 2] = pz
        // Signed coastal distance: 0 right at shoreline, positive out to sea, negative inland
        shoalDist[si] = distSea[u] > 0 ? distSea[u] : -distInland[u]
        shoalOwnerIdx[si] = pOwner[u]
        si++
      }
    }
  }

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
  shoalMesh.userData.tier = 'all'

  // ---------- Flat Depth-Clipped Alpine Tarn Lakes Mesh ----------
  let lakeMesh: THREE.Mesh | null = null
  let lakeColAttr: THREE.BufferAttribute | null = null
  let lakeDepths: Float32Array | null = null
  let lakeOwnerIdxs: Int32Array | null = null
  let lakeVertCount = 0

  if (totalLakeTris > 0) {
    lakeVertCount = totalLakeTris * 3
    const lakePos = new Float32Array(lakeVertCount * 3)
    const lakeCol = new Float32Array(lakeVertCount * 3)
    lakeDepths = new Float32Array(lakeVertCount)
    lakeOwnerIdxs = new Int32Array(lakeVertCount)
    let li = 0

    for (let pi = 0; pi < patches.length; pi++) {
      const patch = patches[pi]
      const { mesh: pm, h } = patch
      const { vx, vz, verts } = pm
      const pOwner = patchOwnerIdx[pi]
      for (const lake of patch.lakes) {
        const wy = lake.waterY
        const tris = lake.triIndices
        for (let k = 0; k < tris.length; k++) {
          const t = tris[k]
          const a = verts[3 * t]
          const b = verts[3 * t + 1]
          const c = verts[3 * t + 2]
          const ids = [a, c, b]
          for (let m = 0; m < 3; m++) {
            const u = ids[m]
            const px = vx[u]
            const pz = vz[u]
            lakePos[li * 3] = px
            lakePos[li * 3 + 1] = wy
            lakePos[li * 3 + 2] = pz
            lakeDepths[li] = Math.max(0, wy - h[u])
            lakeOwnerIdxs[li] = pOwner[u]
            li++
          }
        }
      }
    }

    const lakeGeo = new THREE.BufferGeometry()
    lakeGeo.setAttribute('position', new THREE.BufferAttribute(lakePos, 3))
    lakeColAttr = new THREE.BufferAttribute(lakeCol, 3)
    lakeGeo.setAttribute('color', lakeColAttr)
    lakeGeo.computeVertexNormals()
    const lakeMat = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      vertexColors: true,
      roughness: 0.14,
      metalness: 0.16,
      transparent: true,
      opacity: 0.93,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    })
    lakeMesh = new THREE.Mesh(lakeGeo, lakeMat)
    lakeMesh.receiveShadow = true
    lakeMesh.renderOrder = 1
    lakeMesh.userData.tier = 'all'
  }

  // ---------- Fast Sunlit Cartographic Color & Hover-Lens Updater ----------
  const cTmp = new THREE.Color()
  const cCliff = new THREE.Color()
  const cGrey = new THREE.Color()
  const cShared = new THREE.Color()
  const cShallow = new THREE.Color()
  const cFoam = new THREE.Color()
  const cSea = new THREE.Color()
  const cRiverBed = new THREE.Color()
  const cLakeShallow = new THREE.Color()
  const cLakeDeep = new THREE.Color()
  const cShelf = new THREE.Color()
  const cFoamShallow = new THREE.Color()

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
    cRiverBed.set(night ? '#263844' : '#4a5a5c')
    cLakeShallow.set(night ? '#2e6f82' : '#5ab7c2')
    cLakeDeep.set(night ? '#19445c' : '#35809c')

    const makePal = (src: BiomePalette) => ({
      sand: new THREE.Color(src.sand),
      rock: new THREE.Color(src.rock),
      granite: new THREE.Color(src.granite),
      slate: new THREE.Color(src.slate),
      snow: new THREE.Color(src.snow),
      valley: new THREE.Color(src.valley),
      meadow: new THREE.Color(src.meadow),
      land: new THREE.Color(src.land),
      highland: new THREE.Color(src.highland),
      alpine: new THREE.Color(src.alpine),
      peak: new THREE.Color(src.peak),
    })

    const pals = [
      makePal(bp.mediterranean),
      makePal(bp.temperate),
      makePal(bp.savanna),
      makePal(bp.nordic),
    ]

    // Precompute lens match status per unique owner once (fast!)
    const ownerHit = new Uint8Array(ownerList.length)
    const ownerHL = new Uint8Array(ownerList.length)
    if (lens) {
      for (let i = 0; i < ownerList.length; i++) {
        const o = ownerList[i]
        const hit = matchesFn(o)
        ownerHit[i] = hit ? 1 : 0
        if (hit && (lens.type === 'shared' || lens.type === 'search') && o.isTile) {
          ownerHL[i] = 1
        }
      }
    }

    const colArr = colorAttr.array as Float32Array
    const dimMul = night ? 0.18 : 0.26
    const sharedMix = lens?.type === 'search' ? 0.22 : 0.13

    for (let i = 0; i < totalVerts; i++) {
      const pal = pals[vBiomeIdx[i]]
      const hAbove = vHAbove[i]
      const hn = vHNorm[i]
      const sl = vSlope[i]
      const flags = vFlags[i]
      const isLand = (flags & 2) !== 0
      const isLakeBed = (flags & 1) !== 0
      const rMix = vRiverMix[i]
      const nVal = vNoise[i]
      const fineN = vFine[i]

      if (!isLand || hAbove <= 0.01) {
        // Underwater shelf blends seamlessly from turquoise shallow into sandy beach edge
        const tShore = smoothstep(-0.34, 0.02, hAbove)
        cTmp.copy(cShallow).lerp(pal.sand, tShore * 0.85)
      } else {
        // Organic sunlit elevation ramp: valley -> land -> meadow -> highland -> alpine
        const hnMod = clamp(hn + nVal * 0.055, 0, 1.2)
        cTmp.copy(pal.valley).lerp(pal.land, clamp(hnMod / 0.16, 0, 1))
        if (hnMod > 0.13) {
          cTmp.lerp(pal.meadow, clamp((hnMod - 0.13) / 0.16, 0, 1) * (0.62 + nVal * 0.28))
        }
        if (hnMod > 0.27) {
          cTmp.lerp(pal.highland, clamp((hnMod - 0.27) / 0.2, 0, 1))
        }
        if (hnMod > 0.44) {
          cTmp.lerp(pal.alpine, clamp((hnMod - 0.44) / 0.22, 0, 1))
        }

        // Golden coastal beach sand on gentle shores
        if (hAbove < 0.16 && sl < 0.58) {
          const sandW = (1 - hAbove / 0.16) * (1 - sl / 0.58) * 0.92
          cTmp.lerp(pal.sand, sandW)
        }

        // Lush riparian green banks & dark pebble riverbeds
        if (rMix > 0.04 && !isLakeBed) {
          cTmp.lerp(pal.valley, clamp(rMix * 0.72, 0, 0.72))
          if (rMix > 0.55) {
            cTmp.lerp(cRiverBed, clamp((rMix - 0.55) * 1.25, 0, 0.55))
          }
        }
        if (isLakeBed) {
          cTmp.lerp(cRiverBed, 0.58)
        }

        // Exposed granite & slate rock escarpments on steep slopes with dramatic alpine strata
        if (sl > 0.29 || (hn > 0.46 && hAbove > 1.25)) {
          const slopeRock = clamp((sl - 0.29) / 0.38, 0, 1)
          const altRock = clamp((hn - 0.46) / 0.26, 0, 1) * 0.72
          const rockT = Math.max(slopeRock, altRock) * 0.95
          const slateT = clamp((sl - 0.55) / 0.62, 0, 1)
          cCliff.copy(pal.granite).lerp(pal.slate, slateT)
          cCliff.multiplyScalar(vStrata[i])
          cTmp.lerp(cCliff, rockT)
        }

        // Crisp alpine snow-dusted summits & high arêtes (sheds cleanly off sheer granite cliffs!)
        if (hn > 0.62 && hAbove > 1.75) {
          const snowElev = clamp((hn - 0.62) / 0.24, 0, 1)
          const snowHold = clamp(1 - (sl - 0.48) / 0.68, 0, 1)
          const crestCap = clamp((hn - 0.82) / 0.16, 0, 1) * 0.58
          const snowW = clamp(snowElev * (0.22 + 0.78 * snowHold) + crestCap, 0, 1)
          cTmp.lerp(pal.snow, snowW)
        }

        // Subtle local concavity AO & micro-grain
        cTmp.multiplyScalar(vAo[i] * (1 + fineN * 0.036))
      }

      if (lens) {
        const oIdx = vOwnerIdx[i]
        const isHit = oIdx >= 0 && ownerHit[oIdx] === 1
        if (!isHit) {
          const lum = cTmp.r * 0.2126 + cTmp.g * 0.7152 + cTmp.b * 0.0722
          cGrey.setScalar(lum)
          cTmp.lerp(cGrey, 0.82).multiplyScalar(dimMul)
        } else if (ownerHL[oIdx] === 1) {
          cTmp.lerp(cShared, sharedMix)
        }
      }

      colArr[i * 3] = cTmp.r
      colArr[i * 3 + 1] = cTmp.g
      colArr[i * 3 + 2] = cTmp.b
    }
    colorAttr.needsUpdate = true

    // Update coastal shoal & surf foam vertex colors
    const sArr = shoalColAttr.array as Float32Array
    cShelf.copy(cShallow).lerp(cSea, 0.56)
    cFoamShallow.copy(cFoam).lerp(cShallow, 0.62)
    for (let i = 0; i < shoalVertCount; i++) {
      const oIdx = shoalOwnerIdx[i]
      const owner = oIdx >= 0 ? ownerList[oIdx] : null
      const isHit = !lens || (oIdx >= 0 && ownerHit[oIdx] === 1)
      const dim = isHit ? 1 : night ? 0.22 : 0.3
      const sharedEdge = Boolean(owner?.shared && lens?.type === 'shared')
      const d = shoalDist[i]
      let alpha: number

      if (d <= 0.16) {
        const f = clamp(d / 0.16, 0, 1)
        cTmp.copy(cFoam).lerp(cFoamShallow, f)
        if (sharedEdge) cTmp.lerp(cShared, 0.44 - f * 0.12)
        alpha = ((night ? 0.48 : 0.78) * (1 - f) + (night ? 0.36 : 0.58) * f) * dim
      } else if (d <= 0.62) {
        const f = (d - 0.16) / 0.46
        cTmp.copy(cFoamShallow).lerp(cShallow, f)
        if (sharedEdge) cTmp.lerp(cShared, 0.32 - f * 0.1)
        alpha = ((night ? 0.36 : 0.58) * (1 - f) + (night ? 0.25 : 0.38) * f) * dim
      } else if (d <= 1.38) {
        const f = (d - 0.62) / 0.76
        cTmp.copy(cShallow).lerp(cShelf, f)
        if (sharedEdge) cTmp.lerp(cShared, 0.22 * (1 - f))
        alpha = ((night ? 0.25 : 0.38) * (1 - f) + (night ? 0.1 : 0.16) * f) * dim
      } else if (d <= 2.18) {
        const f = smoothstep(1.38, 2.18, d)
        cTmp.copy(cShelf).lerp(cSea, f)
        alpha = (night ? 0.1 : 0.16) * (1 - f) * dim
      } else {
        cTmp.copy(cSea)
        alpha = 0
      }

      if (lens && !isHit) {
        const lum = cTmp.r * 0.2126 + cTmp.g * 0.7152 + cTmp.b * 0.0722
        cGrey.setScalar(lum)
        cTmp.lerp(cGrey, 0.82).multiplyScalar(night ? 0.22 : 0.32)
      }
      sArr[i * 4] = cTmp.r
      sArr[i * 4 + 1] = cTmp.g
      sArr[i * 4 + 2] = cTmp.b
      sArr[i * 4 + 3] = alpha
    }
    shoalColAttr.needsUpdate = true

    // Update alpine tarn lake vertex colors
    if (lakeColAttr && lakeDepths && lakeOwnerIdxs) {
      const lArr = lakeColAttr.array as Float32Array
      for (let i = 0; i < lakeVertCount; i++) {
        const depth = lakeDepths[i]
        const dt = clamp(depth / 0.22, 0, 1)
        cTmp.copy(cLakeShallow).lerp(cLakeDeep, dt)
        if (depth < 0.045) {
          cTmp.lerp(cFoam, (1 - depth / 0.045) * (night ? 0.18 : 0.34))
        }
        if (lens) {
          const oIdx = lakeOwnerIdxs[i]
          const isHit = oIdx >= 0 && ownerHit[oIdx] === 1
          if (!isHit) {
            const lum = cTmp.r * 0.2126 + cTmp.g * 0.7152 + cTmp.b * 0.0722
            cGrey.setScalar(lum)
            cTmp.lerp(cGrey, 0.82).multiplyScalar(dimMul)
          }
        }
        lArr[i * 3] = cTmp.r
        lArr[i * 3 + 1] = cTmp.g
        lArr[i * 3 + 2] = cTmp.b
      }
      lakeColAttr.needsUpdate = true
    }
  }

  return { mesh, shoalMesh, lakeMesh, updateColors, triCount: totalTris }
}

/**
 * Build continuous Chaikin-smoothed organic drainage river ribbons tucked neatly
 * inside carved valleys, tapering from alpine brooks to flared coastal estuaries.
 */
export function buildRiverWaterMesh(
  sampler: TerrainSampler,
  riverTexture: THREE.CanvasTexture | null,
): RiverWaterResult {
  const positions: number[] = []
  const uvs: number[] = []
  const owners: TileOwner[] = []

  for (const rp of sampler.riverPaths) {
    const pts = rp.pts
    if (pts.length < 2) continue

    const rawY = pts.map((p, idx) => {
      const hCenter = sampler.sampleHeight(p.x, p.z)
      // Sample slight lateral edges so ribbons never dip beneath banked slopes
      const prev = pts[Math.max(0, idx - 1)]
      const next = pts[Math.min(pts.length - 1, idx + 1)]
      const tx = next.x - prev.x
      const tz = next.z - prev.z
      const tLen = Math.hypot(tx, tz) || 1
      const nx = -tz / tLen
      const nz = tx / tLen
      const hw = (p.halfW || 0.14) * 0.85
      const hL = sampler.sampleHeight(p.x - nx * hw, p.z - nz * hw)
      const hR = sampler.sampleHeight(p.x + nx * hw, p.z + nz * hw)
      const bedY = Math.max(hCenter, Math.max(hL, hR) * 0.55 + hCenter * 0.45)
      let wy = Math.max(SEA_Y + 0.024, bedY + 0.048)
      if (rp.isOutlet && p.frac > 0.8) {
        const mouthBlend = smoothstep(0.8, 1.0, p.frac)
        wy = wy * (1 - mouthBlend) + (SEA_Y + 0.016) * mouthBlend
      }
      return wy
    })

    // Enforce gentle downhill monotonicity & 3-point smoothing
    const monoY = rawY.slice()
    for (let i = 1; i < monoY.length; i++) {
      if (monoY[i] > monoY[i - 1] + 0.018) monoY[i] = monoY[i - 1] + 0.018
    }
    const smoothY = monoY.map((y, i) => {
      const yPrev = monoY[Math.max(0, i - 1)]
      const yNext = monoY[Math.min(monoY.length - 1, i + 1)]
      return Math.max(rawY[i] - 0.012, yPrev * 0.25 + y * 0.5 + yNext * 0.25)
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
      const halfW = p.halfW || 0.14
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
  const colors = new Float32Array(positions.length)
  const colorAttr = new THREE.Float32BufferAttribute(colors, 3)
  geo.setAttribute('color', colorAttr)
  geo.computeVertexNormals()

  const mat = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    vertexColors: true,
    map: riverTexture || null,
    roughness: 0.2,
    metalness: 0.14,
    emissive: '#1e5b6e',
    emissiveIntensity: 0.09,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })

  const mesh = new THREE.Mesh(geo, mat)
  mesh.receiveShadow = true
  mesh.renderOrder = 2
  mesh.userData.tier = 'all'
  mesh.userData.isRiverMesh = true
  mesh.userData.ownerForHit = (hit: THREE.Intersection): PickOwner | null => {
    if (hit.faceIndex === undefined || hit.faceIndex === null) return null
    return owners[hit.faceIndex] || null
  }

  const cBase = new THREE.Color()
  const cDim = new THREE.Color()
  const cGrey = new THREE.Color()
  const cShared = new THREE.Color()
  const cHit = new THREE.Color()

  function updateColors(
    p: SchemePalette,
    lens: LensState | null,
    night: boolean,
    matchesFn: (owner: PickOwner) => boolean,
  ): void {
    cBase.set(night ? '#255c78' : '#4696ab')
    cShared.set(p.shared)
    const dimMul = night ? 0.18 : 0.26
    const lum = cBase.r * 0.2126 + cBase.g * 0.7152 + cBase.b * 0.0722
    cGrey.setScalar(lum)
    cDim.copy(cBase).lerp(cGrey, 0.82).multiplyScalar(dimMul)

    mat.emissive.set(night ? '#123850' : '#1e5b6e')
    mat.roughness = night ? 0.22 : 0.2
    mat.metalness = 0.14
    mat.emissiveIntensity = lens ? 0.03 : night ? 0.16 : 0.09

    const arr = colorAttr.array as Float32Array
    const sharedMix = lens?.type === 'search' ? 0.16 : 0.1
    for (let f = 0; f < owners.length; f++) {
      const owner = owners[f]
      const isHit = !lens || matchesFn(owner)
      let col: THREE.Color
      if (!isHit) {
        col = cDim
      } else if (lens && (lens.type === 'shared' || lens.type === 'search') && owner.isTile) {
        col = cHit.copy(cBase).lerp(cShared, sharedMix)
      } else {
        col = cBase
      }
      const base = f * 9
      arr[base] = col.r
      arr[base + 1] = col.g
      arr[base + 2] = col.b
      arr[base + 3] = col.r
      arr[base + 4] = col.g
      arr[base + 5] = col.b
      arr[base + 6] = col.r
      arr[base + 7] = col.g
      arr[base + 8] = col.b
    }
    colorAttr.needsUpdate = true
  }

  return { mesh, updateColors }
}

/** Whisper-faint draped cartographic hex seams conforming smoothly to the eroded Delaunay surface. */
export function buildDrapedHexBorders<T extends Axial>(
  hexList: T[],
  hexRadius: number,
  toWorld: (h: T) => WorldXZ,
  sampler: TerrainSampler,
): THREE.LineSegments {
  const verts: number[] = []
  const seen = new Set<string>()
  const LIFT = 0.022
  const STEPS = 4

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

      let prevX = ax
      let prevZ = az
      let prevY = sampler.sampleHeight(ax, az)
      const prevLy = sampler.lakeSurfaceY(ax, az)
      if (prevLy !== null && prevLy > prevY) prevY = prevLy

      for (let s = 1; s <= STEPS; s++) {
        const f = s / STEPS
        const cx = ax + (bx - ax) * f
        const cz = az + (bz - az) * f
        let cy = sampler.sampleHeight(cx, cz)
        const cLy = sampler.lakeSurfaceY(cx, cz)
        if (cLy !== null && cLy > cy) cy = cLy
        if (prevY > SEA_Y + 0.02 || cy > SEA_Y + 0.02) {
          verts.push(
            prevX,
            Math.max(SEA_Y + 0.02, prevY) + LIFT,
            prevZ,
            cx,
            Math.max(SEA_Y + 0.02, cy) + LIFT,
            cz,
          )
        }
        prevX = cx
        prevZ = cz
        prevY = cy
      }
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
