// Model C+ Grid-Free Jittered-Delaunay Geomorphology Engine.
// Builds an isotropic Lawson-legalized jittered equilateral-triangle mesh per connected
// landmass component (welding isthmus-linked supercontinents seamlessly), then evolves
// topography via Priority-Flood, Braun-Willett implicit stream-power with hillslope-channel
// initiation threshold A_crit, nonlinear crest-preserving cotangent-Laplacian diffusion,
// and thermal talus slumping. Extracts exact flat alpine lakes (tarns), Chaikin-smoothed
// organic drainage rivers, organic city valley pads, and an O(1) barycentric TerrainSampler.
import { DIRECTIONS, RADIUS, hash, key, unworld } from './layout.js'
import { MOUNTAIN_CLASSES, continentOrogeny } from './mountains.js'
import type {
  AtlasLayout,
  FineTile,
  MountainField,
  NaturalSample,
  PlacedCity,
  PlacedContinent,
  RiverSamplePoint,
  RiverSegment,
  SampledRiverPath,
  TerrainParams,
  TerrainSample,
  TerrainSampler,
  TileOwner,
} from './types.js'

export const SEA_Y = -0.28
const SQRT3 = Math.sqrt(3)

export const DEFAULT_TERRAIN_PARAMS: TerrainParams = {
  uplift: 1.0,
  erosionK: 1.0,
  aCrit: 16,
  valleySmooth: 1.0,
  crestSharpness: 0.96,
  talusSlope: 1.0,
  lakeLevel: 1.0,
  iterations: 28,
  seed: 0,
}

const HEX_RING2: ReadonlyArray<readonly [number, number]> = (() => {
  const out: Array<[number, number]> = []
  for (let dq = -2; dq <= 2; dq++) {
    for (let dr = -2; dr <= 2; dr++) {
      if (Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)) <= 2) {
        out.push([dq, dr])
      }
    }
  }
  return out
})()

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return v < lo ? lo : v > hi ? hi : v
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}

function hash2(ix: number, iz: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 1442695041)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function vnoise2(x: number, z: number, seed: number): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = x - ix
  const fz = z - iz
  const ux = fx * fx * (3 - 2 * fx)
  const uz = fz * fz * (3 - 2 * fz)
  const a = hash2(ix, iz, seed)
  const b = hash2(ix + 1, iz, seed)
  const c = hash2(ix, iz + 1, seed)
  const d = hash2(ix + 1, iz + 1, seed)
  return (a + (b - a) * ux + (c - a + (a - b - c + d) * ux) * uz) * 2 - 1
}

/** Rotated multi-octave fBM in [0, 1] with zero XY axis alignment. */
export function fbmRotated(x: number, z: number, seed: number, octaves = 4): number {
  let val = 0
  let amp = 0.5
  let freq = 1
  const c0 = 0.8
  const s0 = 0.6
  let px = x
  let pz = z
  for (let o = 0; o < octaves; o++) {
    val += amp * vnoise2(px * freq + o * 19.1, pz * freq - o * 13.7, seed + o * 31)
    const nx = c0 * px - s0 * pz
    const nz = s0 * px + c0 * pz
    px = nx
    pz = nz
    freq *= 2.03
    amp *= 0.5
  }
  return val * 0.5 + 0.5
}

/** Domain-warped rotated ridged multifractal in ~[0, 1]. */
export function ridgedRotated(x: number, z: number, seed: number, octaves = 4, baseFreq = 0.145): number {
  const px = x * baseFreq
  const pz = z * baseFreq
  let wx = px + 0.72 * vnoise2(px * 0.78 + 5.1, pz * 0.78 - 3.7, seed + 7)
  let wz = pz + 0.72 * vnoise2(px * 0.78 - 9.3, pz * 0.78 + 11.4, seed + 19)
  let val = 0
  let weight = 1
  let amp = 0.54
  let freq = 1
  const c0 = 0.8
  const s0 = 0.6
  for (let o = 0; o < octaves; o++) {
    const n = vnoise2(wx * freq + o * 23.7, wz * freq - o * 17.3, seed + 101 + o * 37)
    let sig = 1 - Math.abs(n)
    sig = sig * sig * weight
    weight = clamp(sig * 1.75, 0, 1)
    val += sig * amp
    const nwx = c0 * wx - s0 * wz
    const nwz = s0 * wx + c0 * wz
    wx = nwx
    wz = nwz
    freq *= 2.05
    amp *= 0.5
  }
  return val
}

function cellKey(cx: number, cz: number): number {
  return (cx + 2048) * 4096 + (cz + 2048)
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

// ---------- 1. Exact Lawson-Legalized Jittered Equilateral Delaunay Mesh ----------

export interface DelaunayMesh {
  V: number
  T: number
  nx: number
  nz: number
  spacing: number
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  vx: Float64Array
  vz: Float64Array
  verts: Int32Array
  cellArea: Float32Array
  nbrPtr: Int32Array
  nbrIdx: Int32Array
  nbrDist: Float32Array
  nbrCot: Float32Array
  flips: number
  violations: number
}

function inCircle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const adx = ax - dx
  const ady = ay - dy
  const bdx = bx - dx
  const bdy = by - dy
  const cdx = cx - dx
  const cdy = cy - dy
  const al = adx * adx + ady * ady
  const bl = bdx * bdx + bdy * bdy
  const cl = cdx * cdx + cdy * cdy
  return adx * (bdy * cl - bl * cdy) - ady * (bdx * cl - bl * cdx) + al * (bdx * cdy - bdy * cdx) > 1e-11
}

function orient2d(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}

export function buildJitteredLawsonDelaunay(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  spacing: number,
  jitterFrac = 0.36,
  seed = 0,
): DelaunayMesh {
  const spanX = Math.max(spacing * 4, maxX - minX)
  const spanZ = Math.max(spacing * 4, maxZ - minZ)
  const rowDy = spacing * SQRT3 * 0.5
  const nx = Math.max(5, Math.ceil(spanX / spacing) + 2)
  const nz = Math.max(5, Math.ceil(spanZ / rowDy) + 2)
  const V = nx * nz
  const vx = new Float64Array(V)
  const vz = new Float64Array(V)

  const actualW = (nx - 0.5) * spacing
  const actualH = (nz - 1) * rowDy
  const originX = (minX + maxX) * 0.5 - actualW * 0.5
  const originZ = (minZ + maxZ) * 0.5 - actualH * 0.5

  const s1 = 9187 + seed * 7919
  const s2 = 3571 + seed * 6101
  for (let j = 0; j < nz; j++) {
    const z0 = originZ + j * rowDy
    const xShift = j & 1 ? 0.5 * spacing : 0
    const interiorZ = j > 0 && j < nz - 1
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i
      const x0 = originX + i * spacing + xShift
      if (interiorZ && i > 0 && i < nx - 1) {
        const u1 = hash2(i, j, s1)
        const u2 = hash2(i, j, s2)
        const r = jitterFrac * spacing * Math.sqrt(u1)
        const a = 2 * Math.PI * u2
        vx[idx] = x0 + r * Math.cos(a)
        vz[idx] = z0 + r * Math.sin(a)
      } else {
        vx[idx] = x0
        vz[idx] = z0
      }
    }
  }

  const cols = nx - 1
  const rows = nz - 1
  const T = 2 * cols * rows
  const verts = new Int32Array(3 * T)
  const twin = new Int32Array(3 * T).fill(-1)

  for (let j = 0; j < rows; j++) {
    const odd = (j & 1) === 1
    for (let i = 0; i < cols; i++) {
      const t0i = 2 * (j * cols + i)
      const t1i = t0i + 1
      const v00 = j * nx + i
      const v10 = v00 + 1
      const v01 = (j + 1) * nx + i
      const v11 = v01 + 1

      if (!odd) {
        verts[3 * t0i + 0] = v00
        verts[3 * t0i + 1] = v10
        verts[3 * t0i + 2] = v01
        verts[3 * t1i + 0] = v10
        verts[3 * t1i + 1] = v11
        verts[3 * t1i + 2] = v01

        twin[3 * t0i + 1] = 3 * t1i + 2
        twin[3 * t1i + 2] = 3 * t0i + 1

        if (i + 1 < cols) {
          const rT0 = 2 * (j * cols + i + 1)
          twin[3 * t1i + 0] = 3 * rT0 + 2
          twin[3 * rT0 + 2] = 3 * t1i + 0
        }
        if (j + 1 < rows) {
          const bT0 = 2 * ((j + 1) * cols + i)
          twin[3 * t1i + 1] = 3 * bT0 + 0
          twin[3 * bT0 + 0] = 3 * t1i + 1
        }
      } else {
        verts[3 * t0i + 0] = v00
        verts[3 * t0i + 1] = v10
        verts[3 * t0i + 2] = v11
        verts[3 * t1i + 0] = v00
        verts[3 * t1i + 1] = v11
        verts[3 * t1i + 2] = v01

        twin[3 * t0i + 2] = 3 * t1i + 0
        twin[3 * t1i + 0] = 3 * t0i + 2

        if (i + 1 < cols) {
          const rT1 = 2 * (j * cols + i + 1) + 1
          twin[3 * t0i + 1] = 3 * rT1 + 2
          twin[3 * rT1 + 2] = 3 * t0i + 1
        }
        if (j + 1 < rows) {
          const bT0 = 2 * ((j + 1) * cols + i)
          twin[3 * t1i + 1] = 3 * bT0 + 0
          twin[3 * bT0 + 0] = 3 * t1i + 1
        }
      }
    }
  }

  // Lawson Edge-Flip Legalization via dirty-edge ring buffer
  const E = 3 * T
  const inQueue = new Uint8Array(E)
  const queue = new Int32Array(E)
  let qHead = 0
  let qTail = 0
  for (let e = 0; e < E; e++) {
    const tw = twin[e]
    if (tw > e) {
      queue[qTail++] = e
      inQueue[e] = 1
    }
  }

  let flips = 0
  const maxFlips = E * 6
  while (qHead !== qTail && flips < maxFlips) {
    const e0 = queue[qHead++]
    if (qHead === E) qHead = 0
    inQueue[e0] = 0

    const e1 = twin[e0]
    if (e1 < 0) continue

    const tA = (e0 / 3) | 0
    const kA = e0 - 3 * tA
    const a1 = 3 * tA + (kA === 2 ? 0 : kA + 1)
    const a2 = 3 * tA + (kA === 0 ? 2 : kA - 1)

    const tB = (e1 / 3) | 0
    const kB = e1 - 3 * tB
    const b1 = 3 * tB + (kB === 2 ? 0 : kB + 1)
    const b2 = 3 * tB + (kB === 0 ? 2 : kB - 1)

    const va = verts[e0]
    const vb = verts[a1]
    const vc = verts[a2]
    const vd = verts[b2]

    if (!inCircle(vx[va], vz[va], vx[vb], vz[vb], vx[vc], vz[vc], vx[vd], vz[vd])) {
      continue
    }
    if (
      orient2d(vx[vd], vz[vd], vx[vc], vz[vc], vx[va], vz[va]) <= 1e-10 ||
      orient2d(vx[vc], vz[vc], vx[vd], vz[vd], vx[vb], vz[vb]) <= 1e-10
    ) {
      continue
    }

    const twA1 = twin[a1]
    const twA2 = twin[a2]
    const twB1 = twin[b1]
    const twB2 = twin[b2]

    verts[e0] = vd
    verts[a1] = vc
    verts[a2] = va
    verts[e1] = vc
    verts[b1] = vd
    verts[b2] = vb

    twin[a1] = twA2
    if (twA2 >= 0) twin[twA2] = a1
    twin[a2] = twB1
    if (twB1 >= 0) twin[twB1] = a2
    twin[b1] = twB2
    if (twB2 >= 0) twin[twB2] = b1
    twin[b2] = twA1
    if (twA1 >= 0) twin[twA1] = b2

    flips++

    if (twA2 >= 0 && !inQueue[a1]) {
      inQueue[a1] = 1
      queue[qTail++] = a1
      if (qTail === E) qTail = 0
    }
    if (twB1 >= 0 && !inQueue[a2]) {
      inQueue[a2] = 1
      queue[qTail++] = a2
      if (qTail === E) qTail = 0
    }
    if (twB2 >= 0 && !inQueue[b1]) {
      inQueue[b1] = 1
      queue[qTail++] = b1
      if (qTail === E) qTail = 0
    }
    if (twA1 >= 0 && !inQueue[b2]) {
      inQueue[b2] = 1
      queue[qTail++] = b2
      if (qTail === E) qTail = 0
    }
  }

  let violations = 0
  for (let e0 = 0; e0 < E; e0++) {
    const e1 = twin[e0]
    if (e1 <= e0) continue
    const tA = (e0 / 3) | 0
    const kA = e0 - 3 * tA
    const a1 = 3 * tA + (kA === 2 ? 0 : kA + 1)
    const a2 = 3 * tA + (kA === 0 ? 2 : kA - 1)
    const tB = (e1 / 3) | 0
    const kB = e1 - 3 * tB
    const b2 = 3 * tB + (kB === 0 ? 2 : kB - 1)
    if (
      inCircle(
        vx[verts[e0]],
        vz[verts[e0]],
        vx[verts[a1]],
        vz[verts[a1]],
        vx[verts[a2]],
        vz[verts[a2]],
        vx[verts[b2]],
        vz[verts[b2]],
      )
    ) {
      violations++
    }
  }

  // CSR neighbor graph + cotangent Laplacian weights + barycentric dual cell areas
  const deg = new Int32Array(V)
  const cellArea = new Float32Array(V)
  for (let t = 0; t < T; t++) {
    deg[verts[3 * t]] += 2
    deg[verts[3 * t + 1]] += 2
    deg[verts[3 * t + 2]] += 2
  }
  const rawPtr = new Int32Array(V + 1)
  let acc = 0
  for (let i = 0; i < V; i++) {
    rawPtr[i] = acc
    acc += deg[i]
  }
  rawPtr[V] = acc

  const rawNbr = new Int32Array(acc)
  const rawCot = new Float32Array(acc)
  const cur = rawPtr.subarray(0, V).slice()

  for (let t = 0; t < T; t++) {
    const a = verts[3 * t]
    const b = verts[3 * t + 1]
    const c = verts[3 * t + 2]
    const ax = vx[a]
    const az = vz[a]
    const bx = vx[b]
    const bz = vz[b]
    const cx = vx[c]
    const cz = vz[c]
    const area2 = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax))
    const a3 = area2 / 6
    cellArea[a] += a3
    cellArea[b] += a3
    cellArea[c] += a3

    const den = area2 > 1e-10 ? area2 : 1e-10
    const cotC = clamp(((ax - cx) * (bx - cx) + (az - cz) * (bz - cz)) / den, 0.05, 6) * 0.5
    const cotA = clamp(((bx - ax) * (cx - ax) + (bz - az) * (cz - az)) / den, 0.05, 6) * 0.5
    const cotB = clamp(((cx - bx) * (ax - bx) + (cz - bz) * (az - bz)) / den, 0.05, 6) * 0.5

    rawNbr[cur[a]] = b
    rawCot[cur[a]++] = cotC
    rawNbr[cur[b]] = a
    rawCot[cur[b]++] = cotC
    rawNbr[cur[b]] = c
    rawCot[cur[b]++] = cotA
    rawNbr[cur[c]] = b
    rawCot[cur[c]++] = cotA
    rawNbr[cur[c]] = a
    rawCot[cur[c]++] = cotB
    rawNbr[cur[a]] = c
    rawCot[cur[a]++] = cotB
  }

  const nbrPtr = new Int32Array(V + 1)
  const nbrIdx = new Int32Array(acc)
  const nbrDist = new Float32Array(acc)
  const nbrCot = new Float32Array(acc)
  let outK = 0

  for (let u = 0; u < V; u++) {
    nbrPtr[u] = outK
    const p0 = rawPtr[u]
    const p1 = rawPtr[u + 1]
    for (let i = p0 + 1; i < p1; i++) {
      const kn = rawNbr[i]
      const kw = rawCot[i]
      let j = i - 1
      while (j >= p0 && rawNbr[j] > kn) {
        rawNbr[j + 1] = rawNbr[j]
        rawCot[j + 1] = rawCot[j]
        j--
      }
      rawNbr[j + 1] = kn
      rawCot[j + 1] = kw
    }
    const ux = vx[u]
    const uz = vz[u]
    let i = p0
    while (i < p1) {
      const v = rawNbr[i]
      let wSum = rawCot[i++]
      while (i < p1 && rawNbr[i] === v) wSum += rawCot[i++]
      nbrIdx[outK] = v
      nbrDist[outK] = Math.max(1e-6, Math.hypot(vx[v] - ux, vz[v] - uz))
      nbrCot[outK] = wSum
      outK++
    }
  }
  nbrPtr[V] = outK

  return {
    V,
    T,
    nx,
    nz,
    spacing,
    minX: originX,
    maxX: originX + actualW,
    minZ: originZ,
    maxZ: originZ + actualH,
    vx,
    vz,
    verts,
    cellArea,
    nbrPtr,
    nbrIdx: nbrIdx.subarray(0, outK),
    nbrDist: nbrDist.subarray(0, outK),
    nbrCot: nbrCot.subarray(0, outK),
    flips,
    violations,
  }
}

// ---------- 2. Graph Hydrology Primitives (Priority-Flood, Flow Tree, Dijkstra Coast Dist) ----------

function runPriorityFlood(
  h: Float32Array,
  land: Uint8Array,
  nbrPtr: Int32Array,
  nbrIdx: Int32Array,
  filled: Float32Array,
  closed: Uint8Array,
  heapVal: Float32Array,
  heapIdx: Int32Array,
  eps: number,
): void {
  const V = h.length
  closed.fill(0)
  let hsize = 0
  for (let u = 0; u < V; u++) {
    if (land[u] === 0) {
      closed[u] = 1
      const hv = h[u]
      filled[u] = hv
      let c = hsize++
      heapVal[c] = hv
      heapIdx[c] = u
      while (c > 0) {
        const p = (c - 1) >> 1
        if (heapVal[p] <= heapVal[c]) break
        const tv = heapVal[p]
        const ti = heapIdx[p]
        heapVal[p] = heapVal[c]
        heapIdx[p] = heapIdx[c]
        heapVal[c] = tv
        heapIdx[c] = ti
        c = p
      }
    }
  }

  while (hsize > 0) {
    const curW = heapVal[0]
    const u = heapIdx[0]
    hsize--
    if (hsize > 0) {
      heapVal[0] = heapVal[hsize]
      heapIdx[0] = heapIdx[hsize]
      let c = 0
      while (true) {
        const l = (c << 1) + 1
        const r = l + 1
        let s = c
        if (l < hsize && heapVal[l] < heapVal[s]) s = l
        if (r < hsize && heapVal[r] < heapVal[s]) s = r
        if (s === c) break
        const tv = heapVal[c]
        const ti = heapIdx[c]
        heapVal[c] = heapVal[s]
        heapIdx[c] = heapIdx[s]
        heapVal[s] = tv
        heapIdx[s] = ti
        c = s
      }
    }
    const p0 = nbrPtr[u]
    const p1 = nbrPtr[u + 1]
    for (let p = p0; p < p1; p++) {
      const v = nbrIdx[p]
      if (closed[v] === 0) {
        closed[v] = 1
        const hv = h[v]
        const nv = hv <= curW + eps ? curW + eps : hv
        filled[v] = nv
        let c = hsize++
        heapVal[c] = nv
        heapIdx[c] = v
        while (c > 0) {
          const pr = (c - 1) >> 1
          if (heapVal[pr] <= heapVal[c]) break
          const tv = heapVal[pr]
          const ti = heapIdx[pr]
          heapVal[pr] = heapVal[c]
          heapIdx[pr] = heapIdx[c]
          heapVal[c] = tv
          heapIdx[c] = ti
          c = pr
        }
      }
    }
  }
}

function runFlowAndArea(
  filled: Float32Array,
  land: Uint8Array,
  cellArea: Float32Array,
  nbrPtr: Int32Array,
  nbrIdx: Int32Array,
  nbrDist: Float32Array,
  receiver: Int32Array,
  recDist: Float32Array,
  donorCount: Int32Array,
  donorPtr: Int32Array,
  donors: Int32Array,
  cursor: Int32Array,
  order: Int32Array,
  stack: Int32Array,
  area: Float32Array,
): number {
  const V = filled.length
  donorCount.fill(0)
  for (let u = 0; u < V; u++) {
    if (land[u] === 0) {
      receiver[u] = u
      recDist[u] = 1
      continue
    }
    const wu = filled[u]
    let bestS = -1
    let bestV = u
    let bestD = 1
    const p0 = nbrPtr[u]
    const p1 = nbrPtr[u + 1]
    for (let p = p0; p < p1; p++) {
      const v = nbrIdx[p]
      const diff = wu - filled[v]
      if (diff > 0) {
        const d = nbrDist[p]
        const s = diff / d
        if (s > bestS) {
          bestS = s
          bestV = v
          bestD = d
        }
      }
    }
    receiver[u] = bestV
    recDist[u] = bestD
    if (bestV !== u) donorCount[bestV]++
  }

  let acc = 0
  for (let u = 0; u < V; u++) {
    donorPtr[u] = acc
    cursor[u] = acc
    acc += donorCount[u]
  }
  donorPtr[V] = acc

  for (let u = 0; u < V; u++) {
    const r = receiver[u]
    if (r !== u) donors[cursor[r]++] = u
  }

  let ordLen = 0
  for (let u = 0; u < V; u++) {
    if (receiver[u] === u) {
      let sp = 0
      stack[sp++] = u
      while (sp > 0) {
        const cur = stack[--sp]
        order[ordLen++] = cur
        const p0 = donorPtr[cur]
        const p1 = donorPtr[cur + 1]
        for (let p = p0; p < p1; p++) stack[sp++] = donors[p]
      }
    }
  }

  area.set(cellArea)
  for (let k = ordLen - 1; k >= 0; k--) {
    const u = order[k]
    const r = receiver[u]
    if (r !== u) area[r] += area[u]
  }
  return ordLen
}

/** Exact multi-source Dijkstra distance to shoreline on the Delaunay CSR graph. */
function computeShoreDistances(
  mesh: DelaunayMesh,
  land: Uint8Array,
): { distInland: Float32Array; distSea: Float32Array } {
  const { V, nbrPtr, nbrIdx, nbrDist } = mesh
  const distInland = new Float32Array(V)
  const distSea = new Float32Array(V)

  const runSide = (targetSide: number, out: Float32Array): void => {
    out.fill(1e9)
    let cap = Math.max(V * 4, nbrIdx.length, 64)
    let heapVal = new Float32Array(cap)
    let heapIdx = new Int32Array(cap)
    let hsize = 0

    const push = (val: number, idx: number): void => {
      if (hsize >= cap) {
        cap *= 2
        const nextVal = new Float32Array(cap)
        const nextIdx = new Int32Array(cap)
        nextVal.set(heapVal)
        nextIdx.set(heapIdx)
        heapVal = nextVal
        heapIdx = nextIdx
      }
      let c = hsize++
      heapVal[c] = val
      heapIdx[c] = idx
      while (c > 0) {
        const p = (c - 1) >> 1
        if (heapVal[p] <= heapVal[c]) break
        const tv = heapVal[p]
        const ti = heapIdx[p]
        heapVal[p] = heapVal[c]
        heapIdx[p] = heapIdx[c]
        heapVal[c] = tv
        heapIdx[c] = ti
        c = p
      }
    }

    for (let u = 0; u < V; u++) {
      if (land[u] !== targetSide) {
        out[u] = 0
        continue
      }
      const p0 = nbrPtr[u]
      const p1 = nbrPtr[u + 1]
      let minShore = 1e9
      for (let p = p0; p < p1; p++) {
        if (land[nbrIdx[p]] !== targetSide) {
          const halfD = nbrDist[p] * 0.5
          if (halfD < minShore) minShore = halfD
        }
      }
      if (minShore < 1e8) {
        out[u] = minShore
        push(minShore, u)
      }
    }

    while (hsize > 0) {
      const curD = heapVal[0]
      const u = heapIdx[0]
      hsize--
      if (hsize > 0) {
        heapVal[0] = heapVal[hsize]
        heapIdx[0] = heapIdx[hsize]
        let c = 0
        while (true) {
          const l = (c << 1) + 1
          const r = l + 1
          let s = c
          if (l < hsize && heapVal[l] < heapVal[s]) s = l
          if (r < hsize && heapVal[r] < heapVal[s]) s = r
          if (s === c) break
          const tv = heapVal[c]
          const ti = heapIdx[c]
          heapVal[c] = heapVal[s]
          heapIdx[c] = heapIdx[s]
          heapVal[s] = tv
          heapIdx[s] = ti
          c = s
        }
      }
      if (curD > out[u] + 1e-5) continue
      const p0 = nbrPtr[u]
      const p1 = nbrPtr[u + 1]
      for (let p = p0; p < p1; p++) {
        const v = nbrIdx[p]
        if (land[v] !== targetSide) continue
        const nd = curD + nbrDist[p]
        if (nd < out[v]) {
          out[v] = nd
          push(nd, v)
        }
      }
    }
  }

  runSide(1, distInland)
  runSide(0, distSea)
  return { distInland, distSea }
}

// ---------- 3. Landmass Patch Data & Spatial Barycentric Sampler ----------

export interface LakeComponent {
  id: number
  waterY: number
  triIndices: Int32Array
  continentId: string
  centerX: number
  centerZ: number
  vertexCount: number
}

export interface TerrainPatch {
  id: string
  continentIds: string[]
  mesh: DelaunayMesh
  land: Uint8Array
  distInland: Float32Array
  distSea: Float32Array
  h: Float32Array
  slope: Float32Array
  ao: Float32Array
  mtnEnv: Float32Array
  lakeId: Int32Array
  lakeY: Float32Array
  riverMix: Float32Array
  cityCore: Uint8Array
  receiver: Int32Array
  area: Float32Array
  maxLandHeight: number
  lakes: LakeComponent[]
  flowAngles: Float32Array
  // Spatial triangle lookup grid
  gridCellSize: number
  gridNx: number
  gridNz: number
  gridPtr: Int32Array
  gridTris: Int32Array
}

export interface GeomorphologyStats {
  solveMs: number
  patchCount: number
  totalVerts: number
  totalLandVerts: number
  totalTris: number
  lakeCount: number
  riverCount: number
  delaunayViolations: number
}

export interface GeomorphologyResult {
  patches: TerrainPatch[]
  sampler: TerrainSampler
  stats: GeomorphologyStats
  params: TerrainParams
}

interface RidgeSegment {
  ax: number
  az: number
  bx: number
  bz: number
  ux: number
  uz: number
  nx: number
  nz: number
  len: number
  ampA: number
  ampB: number
  sigmaScarp: number
  sigmaDip: number
}

interface CityPad {
  x: number
  z: number
  y: number
  rFlat: number
  rBlend: number
}

function quantile(arr: number[], q: number): number {
  if (!arr.length) return 0
  const s = arr.slice().sort((a, b) => a - b)
  const idx = clamp(Math.floor(q * (s.length - 1)), 0, s.length - 1)
  return s[idx]
}

function buildSpatialGrid(mesh: DelaunayMesh): {
  gridCellSize: number
  gridNx: number
  gridNz: number
  gridPtr: Int32Array
  gridTris: Int32Array
} {
  const { T, vx, vz, verts, minX, maxX, minZ, maxZ, spacing } = mesh
  const gridCellSize = Math.max(0.85, spacing * 3.5)
  const invCell = 1 / gridCellSize
  const gridNx = Math.max(1, Math.ceil((maxX - minX) * invCell) + 1)
  const gridNz = Math.max(1, Math.ceil((maxZ - minZ) * invCell) + 1)
  const nCells = gridNx * gridNz
  const counts = new Int32Array(nCells)

  for (let t = 0; t < T; t++) {
    const a = verts[3 * t]
    const b = verts[3 * t + 1]
    const c = verts[3 * t + 2]
    const x0 = Math.min(vx[a], vx[b], vx[c])
    const x1 = Math.max(vx[a], vx[b], vx[c])
    const z0 = Math.min(vz[a], vz[b], vz[c])
    const z1 = Math.max(vz[a], vz[b], vz[c])
    const i0 = clamp(Math.floor((x0 - minX) * invCell), 0, gridNx - 1)
    const i1 = clamp(Math.floor((x1 - minX) * invCell), 0, gridNx - 1)
    const j0 = clamp(Math.floor((z0 - minZ) * invCell), 0, gridNz - 1)
    const j1 = clamp(Math.floor((z1 - minZ) * invCell), 0, gridNz - 1)
    for (let j = j0; j <= j1; j++) {
      const row = j * gridNx
      for (let i = i0; i <= i1; i++) counts[row + i]++
    }
  }

  const gridPtr = new Int32Array(nCells + 1)
  let acc = 0
  for (let k = 0; k < nCells; k++) {
    gridPtr[k] = acc
    acc += counts[k]
  }
  gridPtr[nCells] = acc

  const gridTris = new Int32Array(acc)
  const cur = gridPtr.subarray(0, nCells).slice()
  for (let t = 0; t < T; t++) {
    const a = verts[3 * t]
    const b = verts[3 * t + 1]
    const c = verts[3 * t + 2]
    const x0 = Math.min(vx[a], vx[b], vx[c])
    const x1 = Math.max(vx[a], vx[b], vx[c])
    const z0 = Math.min(vz[a], vz[b], vz[c])
    const z1 = Math.max(vz[a], vz[b], vz[c])
    const i0 = clamp(Math.floor((x0 - minX) * invCell), 0, gridNx - 1)
    const i1 = clamp(Math.floor((x1 - minX) * invCell), 0, gridNx - 1)
    const j0 = clamp(Math.floor((z0 - minZ) * invCell), 0, gridNz - 1)
    const j1 = clamp(Math.floor((z1 - minZ) * invCell), 0, gridNz - 1)
    for (let j = j0; j <= j1; j++) {
      const row = j * gridNx
      for (let i = i0; i <= i1; i++) {
        gridTris[cur[row + i]++] = t
      }
    }
  }

  return { gridCellSize, gridNx, gridNz, gridPtr, gridTris }
}

interface BaryHit {
  h: number
  slope: number
  lakeY: number | null
  isLake: boolean
  landFrac: number
}

function samplePatchBarycentric(patch: TerrainPatch, x: number, z: number): BaryHit | null {
  const { mesh, h, slope, lakeId, lakeY, land, gridCellSize, gridNx, gridNz, gridPtr, gridTris } = patch
  if (x < mesh.minX || x > mesh.maxX || z < mesh.minZ || z > mesh.maxZ) return null
  const ci = clamp(Math.floor((x - mesh.minX) / gridCellSize), 0, gridNx - 1)
  const cj = clamp(Math.floor((z - mesh.minZ) / gridCellSize), 0, gridNz - 1)
  const cellIdx = cj * gridNx + ci
  const p0 = gridPtr[cellIdx]
  const p1 = gridPtr[cellIdx + 1]
  const { vx, vz, verts } = mesh

  for (let p = p0; p < p1; p++) {
    const t = gridTris[p]
    const a = verts[3 * t]
    const b = verts[3 * t + 1]
    const c = verts[3 * t + 2]
    const ax = vx[a]
    const az = vz[a]
    const bx = vx[b]
    const bz = vz[b]
    const cx = vx[c]
    const cz = vz[c]
    const denom = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
    if (Math.abs(denom) < 1e-12) continue
    const invD = 1 / denom
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) * invD
    if (l1 < -1e-4) continue
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) * invD
    if (l2 < -1e-4) continue
    const l3 = 1 - l1 - l2
    if (l3 < -1e-4) continue

    const hh = l1 * h[a] + l2 * h[b] + l3 * h[c]
    const sl = l1 * slope[a] + l2 * slope[b] + l3 * slope[c]
    const lf = l1 * land[a] + l2 * land[b] + l3 * land[c]
    let ly: number | null = null
    if (lakeId[a] >= 0) ly = lakeY[a]
    else if (lakeId[b] >= 0) ly = lakeY[b]
    else if (lakeId[c] >= 0) ly = lakeY[c]
    const isLake = ly !== null && hh < ly - 0.005
    return { h: hh, slope: sl, lakeY: isLake ? ly : null, isLake, landFrac: lf }
  }
  return null
}

// ---------- 4. Connected Landmass Grouping & Full Archipelago Solver ----------

function groupConnectedComponents(atlas: AtlasLayout, tileMap: ReadonlyMap<string, FineTile>): FineTile[][] {
  const seen = new Set<string>()
  const comps: FineTile[][] = []
  for (const t of atlas.level2) {
    const tk = key(t)
    if (seen.has(tk)) continue
    seen.add(tk)
    const q: FineTile[] = [t]
    const comp: FineTile[] = []
    while (q.length) {
      const cur = q.pop()!
      comp.push(cur)
      for (const [dq, dr] of DIRECTIONS) {
        const nk = `${cur.q + dq},${cur.r + dr}`
        if (!seen.has(nk)) {
          const nt = tileMap.get(nk)
          if (nt) {
            seen.add(nk)
            q.push(nt)
          }
        }
      }
    }
    comps.push(comp)
  }
  comps.sort((a, b) => b.length - a.length || key(a[0]).localeCompare(key(b[0])))
  return comps
}

function chaikinSmooth(
  pts: Array<{ x: number; z: number; area: number }>,
  passes = 2,
): Array<{ x: number; z: number; area: number }> {
  let cur = pts
  for (let p = 0; p < passes; p++) {
    if (cur.length < 3) break
    const nxt: Array<{ x: number; z: number; area: number }> = [cur[0]]
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i]
      const b = cur[i + 1]
      nxt.push({
        x: 0.75 * a.x + 0.25 * b.x,
        z: 0.75 * a.z + 0.25 * b.z,
        area: 0.75 * a.area + 0.25 * b.area,
      })
      nxt.push({
        x: 0.25 * a.x + 0.75 * b.x,
        z: 0.25 * a.z + 0.75 * b.z,
        area: 0.25 * a.area + 0.75 * b.area,
      })
    }
    nxt.push(cur[cur.length - 1])
    cur = nxt
  }
  return cur
}

export function solveArchipelagoGeomorphology(
  atlas: AtlasLayout,
  tileMap: ReadonlyMap<string, FineTile>,
  contMap: ReadonlyMap<string, PlacedContinent>,
  mountainField: MountainField,
  partialParams: Partial<TerrainParams> = {},
): GeomorphologyResult {
  const tStart = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const params: TerrainParams = {
    uplift: clamp(partialParams.uplift ?? DEFAULT_TERRAIN_PARAMS.uplift, 0.3, 2.2),
    erosionK: clamp(partialParams.erosionK ?? DEFAULT_TERRAIN_PARAMS.erosionK, 0.2, 2.4),
    aCrit: clamp(partialParams.aCrit ?? DEFAULT_TERRAIN_PARAMS.aCrit, 3, 45),
    valleySmooth: clamp(partialParams.valleySmooth ?? DEFAULT_TERRAIN_PARAMS.valleySmooth, 0.2, 2.5),
    crestSharpness: clamp(partialParams.crestSharpness ?? DEFAULT_TERRAIN_PARAMS.crestSharpness, 0.3, 1.0),
    talusSlope: clamp(partialParams.talusSlope ?? DEFAULT_TERRAIN_PARAMS.talusSlope, 0.5, 1.8),
    lakeLevel: clamp(partialParams.lakeLevel ?? DEFAULT_TERRAIN_PARAMS.lakeLevel, 0.0, 2.0),
    iterations: Math.round(clamp(partialParams.iterations ?? DEFAULT_TERRAIN_PARAMS.iterations, 8, 60)),
    seed: Math.round(partialParams.seed ?? DEFAULT_TERRAIN_PARAMS.seed),
  }

  const comps = groupConnectedComponents(atlas, tileMap)
  const patches: TerrainPatch[] = []
  const cityElevations = new Map<string, number>()
  const riverPaths: SampledRiverPath[] = []
  const RIVER_CELL = 4.0
  const riverGrid = new Map<number, RiverSegment[]>()
  const PAD_CELL = 4.0
  const padGrid = new Map<number, CityPad[]>()

  let totalVerts = 0
  let totalLandVerts = 0
  let totalTris = 0
  let totalLakes = 0
  let totalViolations = 0

  const citiesByCont = new Map<string, PlacedCity[]>()
  for (const c of atlas.fibers || []) {
    let arr = citiesByCont.get(c.continent)
    if (!arr) {
      arr = []
      citiesByCont.set(c.continent, arr)
    }
    arr.push(c)
  }

  const makeRiverOwner = (contId: string): TileOwner => {
    const cont = contMap.get(contId)
    return {
      isTile: true,
      continent: contId,
      continentName: cont?.name || contId,
      areaName: 'Carved alpine valley river',
      mass: cont?.total || 0,
      cities: cont?.cities || 0,
      citedBy: cont?.citedBy || 0,
      shared: Boolean(cont?.shared),
    }
  }

  for (let compIdx = 0; compIdx < comps.length; compIdx++) {
    const compTiles = comps[compIdx]
    const compTileMap = new Map<string, FineTile>()
    const compContSet = new Set<string>()
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    let maxRawH = 0.4

    for (const t of compTiles) {
      compTileMap.set(key(t), t)
      compContSet.add(t.continent)
      if (t.x < minX) minX = t.x
      if (t.x > maxX) maxX = t.x
      if (t.z < minZ) minZ = t.z
      if (t.z > maxZ) maxZ = t.z
      if (t.height > maxRawH) maxRawH = t.height
    }

    const continentIds = [...compContSet].sort()
    const compCities: PlacedCity[] = []
    let maxOrogeny = 0
    for (const cid of continentIds) {
      const c = contMap.get(cid)
      if (c) maxOrogeny = Math.max(maxOrogeny, continentOrogeny(c))
      const cl = citiesByCont.get(cid)
      if (cl) compCities.push(...cl)
    }

    const margin = RADIUS * 2.55
    minX -= margin
    maxX += margin
    minZ -= margin
    maxZ += margin

    // Adaptive spacing: crisp sub-hex detail while solving the entire archipelago in <350ms
    let spacing = compTiles.length >= 110 ? 0.34 : compTiles.length >= 35 ? 0.305 : 0.255
    const boxArea = (maxX - minX) * (maxZ - minZ)
    const maxVertsPatch = compTiles.length >= 220 ? 19500 : 14500
    const estVerts = boxArea / (spacing * spacing * SQRT3 * 0.5)
    if (estVerts > maxVertsPatch) {
      spacing = Math.sqrt(boxArea / (maxVertsPatch * SQRT3 * 0.5))
    }

    const compSeed = params.seed + Math.floor(hash(continentIds.join('+')) * 10000)
    const mesh = buildJitteredLawsonDelaunay(minX, maxX, minZ, maxZ, spacing, 0.36, compSeed)
    totalVerts += mesh.V
    totalTris += mesh.T
    totalViolations += mesh.violations

    const { V, nx, nz, vx, vz, cellArea, nbrPtr, nbrIdx, nbrDist, nbrCot } = mesh

    // 1. Organic land mask from exact L2 hex footprint + noise-warped coastline
    const land = new Uint8Array(V)
    const seedOff = (compSeed % 997) * 0.13
    for (let u = 0; u < V; u++) {
      const j = (u / nx) | 0
      const i = u - j * nx
      if (i === 0 || i === nx - 1 || j === 0 || j === nz - 1) {
        land[u] = 0
        continue
      }
      const x = vx[u]
      const z = vz[u]
      const c0 = unworld({ x, z }, RADIUS)
      const ownTile = compTileMap.get(key(c0))
      // Fast-path: interior non-coast land hex is guaranteed land without 19-hex scan
      if (ownTile && !ownTile.coast && !ownTile.isthmus) {
        land[u] = 1
        continue
      }
      let minLandD2 = 1e9
      let minSeaD2 = 1e9
      const ownIsIsthmus = Boolean(ownTile?.isthmus)

      for (let k = 0; k < HEX_RING2.length; k++) {
        const q = c0.q + HEX_RING2[k][0]
        const r = c0.r + HEX_RING2[k][1]
        const hx = SQRT3 * RADIUS * (q + r * 0.5)
        const hz = 1.5 * RADIUS * r
        const dx = x - hx
        const dz = z - hz
        const d2 = dx * dx + dz * dz
        if (compTileMap.has(`${q},${r}`)) {
          if (d2 < minLandD2) minLandD2 = d2
        } else {
          if (d2 < minSeaD2) minSeaD2 = d2
        }
      }

      if (minLandD2 > 1e8) {
        land[u] = 0
        continue
      }
      const dLand = Math.sqrt(minLandD2)
      const dSea = minSeaD2 < 1e8 ? Math.sqrt(minSeaD2) : RADIUS * 3.8
      let rawSd = 0.5 * (dSea - dLand) + 0.09

      // Keep isthmuses & city sites solidly above water
      let warpMask = ownIsIsthmus ? 0.12 : 1.0
      if (ownIsIsthmus && dLand < RADIUS * 0.92) {
        rawSd = Math.max(rawSd, 0.34)
      }
      for (let ci = 0; ci < compCities.length; ci++) {
        const dc = Math.hypot(x - compCities[ci].x, z - compCities[ci].z)
        if (dc < RADIUS * 1.15) {
          warpMask *= smoothstep(RADIUS * 0.55, RADIUS * 1.15, dc)
          if (dc < RADIUS * 0.72) rawSd = Math.max(rawSd, 0.36)
        }
      }

      const coastWarp = (fbmRotated(x * 0.36 + seedOff, z * 0.36 - seedOff, compSeed + 17, 3) - 0.5) * 0.62 * warpMask
      land[u] = rawSd + coastWarp > 0 ? 1 : 0
    }

    // Flood-fill outer ocean from boundary so tiny enclosed saltwater pinholes become land
    const oceanReached = new Uint8Array(V)
    const bfsQ = new Int32Array(V)
    let bHead = 0
    let bTail = 0
    for (let u = 0; u < V; u++) {
      const j = (u / nx) | 0
      const i = u - j * nx
      if ((i === 0 || i === nx - 1 || j === 0 || j === nz - 1) && land[u] === 0) {
        oceanReached[u] = 1
        bfsQ[bTail++] = u
      }
    }
    while (bHead < bTail) {
      const u = bfsQ[bHead++]
      const p0 = nbrPtr[u]
      const p1 = nbrPtr[u + 1]
      for (let p = p0; p < p1; p++) {
        const v = nbrIdx[p]
        if (land[v] === 0 && oceanReached[v] === 0) {
          oceanReached[v] = 1
          bfsQ[bTail++] = v
        }
      }
    }
    for (let u = 0; u < V; u++) {
      if (land[u] === 0 && oceanReached[u] === 0) land[u] = 1
    }

    const { distInland, distSea } = computeShoreDistances(mesh, land)

    // 2. Build asymmetric curved tectonic cordillera segments from mountainField.l2
    const ridgeSegs: RidgeSegment[] = []
    const segGrid = new Map<number, RidgeSegment[]>()
    const SEG_CELL = 4.0
    const addSeg = (seg: RidgeSegment): void => {
      ridgeSegs.push(seg)
      const pad = 6.2
      const i0 = Math.floor((Math.min(seg.ax, seg.bx) - pad) / SEG_CELL)
      const i1 = Math.floor((Math.max(seg.ax, seg.bx) + pad) / SEG_CELL)
      const j0 = Math.floor((Math.min(seg.az, seg.bz) - pad) / SEG_CELL)
      const j1 = Math.floor((Math.max(seg.az, seg.bz) + pad) / SEG_CELL)
      for (let ix = i0; ix <= i1; ix++) {
        for (let iz = j0; iz <= j1; iz++) {
          const gk = cellKey(ix, iz)
          let arr = segGrid.get(gk)
          if (!arr) {
            arr = []
            segGrid.set(gk, arr)
          }
          arr.push(seg)
        }
      }
    }

    for (const t of compTiles) {
      const tk = key(t)
      const mc = mountainField.l2.get(tk)
      if (!mc || !MOUNTAIN_CLASSES.has(mc.mClass)) continue
      const ampA =
        mc.mStrength * (0.68 + 0.56 * mc.orogeny) * (mc.mClass === 'high_peak' ? 1.24 : mc.mClass === 'peak' ? 1.08 : 0.92)
      let addedEdge = false
      for (const nb of mc.ridgeNeighbors) {
        if (tk < nb.key) {
          const nbCell = mountainField.l2.get(nb.key)
          if (!nbCell) continue
          const dx = nb.tile.x - t.x
          const dz = nb.tile.z - t.z
          const len = Math.hypot(dx, dz) || 1
          const ux = dx / len
          const uz = dz / len
          // Orient scarp normal generally southward (+z, facing camera) for dramatic relief
          let nxS = -uz
          let nzS = ux
          if (nzS < 0 || (Math.abs(nzS) < 0.1 && nxS < 0)) {
            nxS = -nxS
            nzS = -nzS
          }
          const ampB =
            nbCell.mStrength *
            (0.68 + 0.56 * nbCell.orogeny) *
            (nbCell.mClass === 'high_peak' ? 1.24 : nbCell.mClass === 'peak' ? 1.08 : 0.92)
          addSeg({
            ax: t.x,
            az: t.z,
            bx: nb.tile.x,
            bz: nb.tile.z,
            ux,
            uz,
            nx: nxS,
            nz: nzS,
            len,
            ampA,
            ampB,
            sigmaScarp: 1.15,
            sigmaDip: 2.05,
          })
          addedEdge = true
        }
      }
      if (!addedEdge && mc.ridgeNeighbors.length === 0) {
        addSeg({
          ax: t.x,
          az: t.z,
          bx: t.x + 0.01,
          bz: t.z,
          ux: 1,
          uz: 0,
          nx: 0,
          nz: 1,
          len: 0.01,
          ampA,
          ampB: ampA,
          sigmaScarp: 1.25,
          sigmaDip: 1.85,
        })
      }
    }

    // 3. Build tectonic uplift, initial elevation, erodibility & talus fields
    const mtnEnv = new Float32Array(V)
    const uplift = new Float32Array(V)
    const h = new Float32Array(V)
    const erod = new Float32Array(V)
    const talus = new Float32Array(V)
    const valleyBay = new Float32Array(V)

    let landAreaSum = 0
    let landCount = 0

    for (let u = 0; u < V; u++) {
      if (land[u] === 0) continue
      landAreaSum += cellArea[u]
      landCount++

      const x = vx[u]
      const z = vz[u]
      const wx = (fbmRotated(x * 0.16 + 3.1 + seedOff, z * 0.16 - 4.7 - seedOff, compSeed + 2111, 3) - 0.5) * 2.0
      const wz = (fbmRotated(x * 0.16 - 8.3 - seedOff, z * 0.16 + 6.2 + seedOff, compSeed + 3137, 3) - 0.5) * 2.0

      // Organic noise-warped valley embayment around cities
      let vb = 0
      for (let ci = 0; ci < compCities.length; ci++) {
        const c = compCities[ci]
        const big = Boolean(c.isOrchestrator)
        const rBay = RADIUS * (big ? 2.15 : 1.85)
        const dxC = x - c.x + wx * 0.45
        const dzC = z - c.z + wz * 0.45
        const dC = Math.hypot(dxC, dzC)
        if (dC < rBay) {
          const t = 1 - (dC / rBay) * (dC / rBay)
          const w = t * t * (3 - 2 * t)
          if (w > vb) vb = w
        }
      }
      valleyBay[u] = vb

      // Evaluate asymmetric cordillera envelope from nearby ridge segments
      let me = 0
      const segs = segGrid.get(cellKey(Math.floor(x / SEG_CELL), Math.floor(z / SEG_CELL)))
      if (segs) {
        const xw = x + wx * 0.34
        const zw = z + wz * 0.34
        for (let s = 0; s < segs.length; s++) {
          const sg = segs[s]
          const rx = xw - sg.ax
          const rz = zw - sg.az
          const proj = clamp((rx * sg.ux + rz * sg.uz) / sg.len, 0, 1)
          const cx = sg.ax + sg.ux * (proj * sg.len)
          const cz = sg.az + sg.uz * (proj * sg.len)
          const ex = xw - cx
          const ez = zw - cz
          // Signed perpendicular distance for asymmetric scarp vs dip slope
          const dn = ex * sg.nx + ez * sg.nz
          const dPerp2 = ex * ex + ez * ez
          const sig = dn > 0 ? sg.sigmaScarp : sg.sigmaDip
          const amp = sg.ampA + (sg.ampB - sg.ampA) * proj
          const val = amp * Math.exp(-dPerp2 / (2 * sig * sig))
          if (val > me) me = val
        }
      }

      // Gentle citation/height modulation from underlying L2 tile
      const c0 = unworld({ x, z }, RADIUS)
      const tile = compTileMap.get(key(c0))
      const hNorm = tile ? clamp((tile.height - 0.15) / Math.max(0.5, maxRawH), 0, 1) : 0.2
      const isthmusDamp = tile?.isthmus ? 0.18 : 1.0

      me = Math.min(1.32, me) * (1 - 0.84 * vb) * isthmusDamp
      mtnEnv[u] = me

      const ct = smoothstep(0, 2.25, distInland[u])
      const fbmLo = fbmRotated(x * 0.13 + seedOff, z * 0.13 - seedOff, compSeed + 2025, 4)
      const ridgedBroad = ridgedRotated(x + seedOff * 2, z - seedOff * 2, compSeed + 1337, 4, 0.22)
      const ridgedSharp = Math.pow(clamp(ridgedBroad * 1.15, 0, 1.2), 1.45)
      const bedrock = fbmRotated(x * 0.24 + 4.2, z * 0.24 - 7.1, compSeed + 777, 3)

      const uVal =
        0.042 * ct * (0.62 + 0.52 * fbmLo + 0.26 * hNorm) + 1.18 * me * ct * (0.16 + 0.96 * ridgedSharp)
      uplift[u] = uVal * 0.32 * params.uplift
      h[u] =
        (0.11 * ct * (0.66 + 0.48 * fbmLo + 0.28 * hNorm) + 1.56 * me * ct * (0.15 + 0.98 * ridgedSharp)) * params.uplift

      const kVal = (0.44 - 0.17 * Math.min(1, me)) * (0.76 + 0.48 * bedrock) * params.erosionK
      erod[u] = kVal * (1 - 0.46 * vb)
      talus[u] = (0.56 + 1.05 * Math.min(1, me)) * params.talusSlope
    }
    totalLandVerts += landCount

    const meanLandArea = landAreaSum / Math.max(1, landCount)
    const aCrit = params.aCrit * meanLandArea

    // Pre-allocated solver buffers (zero GC pressure inside the hot loop)
    const hNew = new Float32Array(V)
    const hTmp = new Float32Array(V)
    const filled = new Float32Array(V)
    const closed = new Uint8Array(V)
    const heapVal = new Float32Array(V)
    const heapIdx = new Int32Array(V)
    const receiver = new Int32Array(V)
    const recDist = new Float32Array(V)
    const donorCount = new Int32Array(V)
    const donorPtr = new Int32Array(V + 1)
    const donors = new Int32Array(V)
    const cursor = new Int32Array(V)
    const order = new Int32Array(V)
    const stack = new Int32Array(V)
    const area = new Float32Array(V)

    const dt = 0.78
    const mExp = 0.48
    const dHill = 0.00028 * params.valleySmooth
    const dValley = 0.0028 * params.valleySmooth
    const crestMult = 0.985 * params.crestSharpness

    // 4. Geomorphology evolution loop (Model C+)
    for (let it = 0; it < params.iterations; it++) {
      runPriorityFlood(h, land, nbrPtr, nbrIdx, filled, closed, heapVal, heapIdx, 1e-4)
      const ordLen = runFlowAndArea(
        filled,
        land,
        cellArea,
        nbrPtr,
        nbrIdx,
        nbrDist,
        receiver,
        recDist,
        donorCount,
        donorPtr,
        donors,
        cursor,
        order,
        stack,
        area,
      )

      // Braun-Willett implicit stream power with hillslope threshold A_crit
      hNew.set(h)
      for (let k = 0; k < ordLen; k++) {
        const u = order[k]
        const r = receiver[u]
        if (r === u || land[u] === 0) continue
        const aEff = area[u] - aCrit
        if (aEff > 0) {
          const alpha = (erod[u] * Math.pow(aEff, mExp) * dt) / recDist[u]
          hNew[u] = (h[u] + dt * uplift[u] + alpha * hNew[r]) / (1 + alpha)
        } else {
          hNew[u] = h[u] + dt * uplift[u]
        }
      }

      // Nonlinear cotangent-Laplacian diffusion (2 CFL-safe substeps)
      let src = hNew
      let dst = hTmp
      for (let sub = 0; sub < 2; sub++) {
        for (let u = 0; u < V; u++) {
          if (land[u] === 0) {
            dst[u] = src[u]
            continue
          }
          const hu = src[u]
          const p0 = nbrPtr[u]
          const p1 = nbrPtr[u + 1]
          let lapNum = 0
          let wSum = 0
          for (let p = p0; p < p1; p++) {
            const w = nbrCot[p]
            lapNum += w * (src[nbrIdx[p]] - hu)
            wSum += w
          }
          const invA = 1 / (cellArea[u] > 1e-6 ? cellArea[u] : 1e-6)
          const lap = lapNum * invA
          const lowW = hu < 1.15 ? 1 - hu / 1.15 : 0
          const isVal = lap > 0 || area[u] > aCrit * 2.2 ? 1 : 0
          let crest = 0
          if (lap < 0 && hu > 0.28) {
            crest = Math.min(1, (hu - 0.28) / 0.55) * Math.min(1, 0.45 + 0.85 * mtnEnv[u])
          }
          let dk = (dHill * (0.55 + 1.15 * lowW) + dValley * isVal * (0.3 + 0.7 * lowW)) * (1 - crestMult * crest)
          const cap = 0.38 / Math.max(wSum * invA, 1e-6)
          if (dk > cap) dk = cap
          dst[u] = hu + dk * lap
        }
        const tmp = src
        src = dst
        dst = tmp
      }

      // Thermal talus rockfall slump on irregular Delaunay edges
      h.set(src)
      for (let u = 0; u < V; u++) {
        if (land[u] === 0) continue
        const hu = src[u]
        const sMax = talus[u]
        const p0 = nbrPtr[u]
        const p1 = nbrPtr[u + 1]
        let maxEx = 0
        let sumEx = 0
        for (let p = p0; p < p1; p++) {
          const diff = hu - src[nbrIdx[p]]
          const lim = sMax * nbrDist[p]
          if (diff > lim) {
            const ex = diff - lim
            sumEx += ex
            if (ex > maxEx) maxEx = ex
          }
        }
        if (sumEx > 0) {
          const move = 0.145 * maxEx
          h[u] -= move
          const invS = move / sumEx
          for (let p = p0; p < p1; p++) {
            const v = nbrIdx[p]
            if (land[v] === 1) {
              const diff = hu - src[v]
              const lim = sMax * nbrDist[p]
              if (diff > lim) h[v] += (diff - lim) * invS
            }
          }
        }
      }
    }

    // 5. Normalize elevations & sculpt coastal shelf + high-alpine granite rock facets
    const landVals: number[] = []
    for (let u = 0; u < V; u++) {
      if (land[u] === 1) landVals.push(h[u])
    }
    const peakRef = Math.max(0.25, quantile(landVals, 0.998))
    const hasMountains = ridgeSegs.length > 0
    const targetPeak = hasMountains
      ? (1.85 + 1.75 * maxOrogeny) * params.uplift
      : (0.42 + 0.48 * clamp(maxRawH, 0.2, 1.5)) * params.uplift
    const hScale = targetPeak / peakRef

    for (let u = 0; u < V; u++) {
      if (land[u] === 1) {
        const hs = Math.max(0, h[u]) * hScale
        const beach = smoothstep(0, 1.18, distInland[u])
        h[u] = SEA_Y + hs * (0.04 + 0.96 * beach) + 0.045 * beach
      } else {
        h[u] = SEA_Y - 0.56 * (1 - Math.exp(-distSea[u] / 2.25))
      }
    }

    // Crisp high-frequency granite rock-facet cragginess on steep alpine slopes & arêtes
    if (hasMountains && params.crestSharpness > 0.45) {
      const rockDetail = new Float32Array(V)
      for (let u = 0; u < V; u++) {
        if (land[u] === 0) continue
        const hAbove = h[u] - SEA_Y
        if (hAbove < 0.72) continue
        const p0 = nbrPtr[u]
        const p1 = nbrPtr[u + 1]
        let maxSl = 0
        for (let p = p0; p < p1; p++) {
          const sl = Math.abs(h[u] - h[nbrIdx[p]]) / nbrDist[p]
          if (sl > maxSl) maxSl = sl
        }
        if (maxSl > 0.48) {
          const rf = ridgedRotated(vx[u] + 19.3, vz[u] - 11.7, compSeed + 4219, 3, 0.62)
          const w = smoothstep(0.48, 1.15, maxSl) * smoothstep(0.72, 1.7, hAbove) * (1 - valleyBay[u])
          rockDetail[u] = w * 0.22 * params.crestSharpness * (rf - 0.34)
        }
      }
      for (let u = 0; u < V; u++) h[u] += rockDetail[u]
    }

    // 6. Seat natural foothill glacial tarns (alpine lakes) tucked into valley benches
    if (hasMountains && params.lakeLevel > 0.05 && compTiles.length >= 50 && maxOrogeny >= 0.34) {
      // One flow pass to rank high-drainage foothill valley benches
      runPriorityFlood(h, land, nbrPtr, nbrIdx, filled, closed, heapVal, heapIdx, 1e-4)
      runFlowAndArea(
        filled,
        land,
        cellArea,
        nbrPtr,
        nbrIdx,
        nbrDist,
        receiver,
        recDist,
        donorCount,
        donorPtr,
        donors,
        cursor,
        order,
        stack,
        area,
      )

      const maxLakesForPatch = compTiles.length >= 160 ? 3 : compTiles.length >= 90 ? 2 : 1
      const cands: Array<{ u: number; score: number }> = []
      for (let u = 0; u < V; u++) {
        if (land[u] === 0 || distInland[u] < 2.6) continue
        if (mtnEnv[u] < 0.14 || mtnEnv[u] > 0.55) continue
        if (valleyBay[u] > 0.25) continue
        const hAbove = h[u] - SEA_Y
        if (hAbove < 0.32 || hAbove > 1.75) continue
        // Stay clear of cities
        let nearCity = false
        for (let ci = 0; ci < compCities.length; ci++) {
          if (Math.hypot(vx[u] - compCities[ci].x, vz[u] - compCities[ci].z) < 2.55) {
            nearCity = true
            break
          }
        }
        if (nearCity) continue
        const score = Math.log1p(area[u] / Math.max(0.05, meanLandArea)) * (0.65 + 0.5 * mtnEnv[u])
        if (score > 1.8) cands.push({ u, score })
      }
      cands.sort((a, b) => b.score - a.score)

      const chosenTarns: Array<{ x: number; z: number; rx: number; rz: number; ang: number }> = []
      for (const cand of cands) {
        if (chosenTarns.length >= maxLakesForPatch) break
        const cx = vx[cand.u]
        const cz = vz[cand.u]
        if (chosenTarns.some(l => Math.hypot(l.x - cx, l.z - cz) < 5.6)) continue
        const ang = (hash(`tarn:${compIdx}:${chosenTarns.length}:${compSeed}`) - 0.5) * Math.PI
        const scaleL = 0.85 + 0.35 * Math.min(1.4, params.lakeLevel)
        chosenTarns.push({
          x: cx,
          z: cz,
          rx: (1.05 + hash(`trx:${compIdx}:${chosenTarns.length}:${compSeed}`) * 0.35) * scaleL,
          rz: (0.66 + hash(`trz:${compIdx}:${chosenTarns.length}:${compSeed}`) * 0.22) * scaleL,
          ang,
        })
      }

      for (const tarn of chosenTarns) {
        const ca = Math.cos(tarn.ang)
        const sa = Math.sin(tarn.ang)
        const ringVals: number[] = []
        const rBuf = new Float32Array(V)
        const maxR = Math.max(tarn.rx, tarn.rz) * 2.2
        for (let u = 0; u < V; u++) {
          if (land[u] === 0) {
            rBuf[u] = 99
            continue
          }
          if (Math.abs(vx[u] - tarn.x) > maxR || Math.abs(vz[u] - tarn.z) > maxR) {
            rBuf[u] = 99
            continue
          }
          const wx = (fbmRotated(vx[u] * 0.55 + 11.3, vz[u] * 0.55 - 6.7, compSeed + 4099, 3) - 0.5) * 1.15
          const wz = (fbmRotated(vx[u] * 0.55 - 7.4, vz[u] * 0.55 + 13.1, compSeed + 5151, 3) - 0.5) * 1.15
          const dx = vx[u] - tarn.x + wx * 0.45
          const dz = vz[u] - tarn.z + wz * 0.45
          const lx = dx * ca + dz * sa
          const lz = -dx * sa + dz * ca
          const r = Math.hypot(lx / tarn.rx, lz / tarn.rz)
          rBuf[u] = r
          if (r >= 0.82 && r <= 1.28) ringVals.push(h[u])
        }
        if (ringVals.length < 6) continue
        const spillEst = quantile(ringVals, 0.2)
        const scourDepth = 0.24 * clamp(params.lakeLevel, 0.3, 1.8)
        const bedTarget = Math.max(SEA_Y + 0.14, spillEst - scourDepth)
        for (let u = 0; u < V; u++) {
          const r = rBuf[u]
          if (r > 1.75 || land[u] === 0) continue
          const bowlRaw = clamp(1 - r * r, 0, 1)
          const bowl = bowlRaw * bowlRaw * (3 - 2 * bowlRaw)
          // Never scoop out steep uphill headwalls above the valley bench
          const benchW = clamp((spillEst + 0.42 - h[u]) / 0.42, 0, 1)
          const wCarve = 0.86 * bowl * benchW
          const rim = Math.exp(-Math.pow((r - 1.08) / 0.28, 2)) * (1 - valleyBay[u]) * benchW
          h[u] = h[u] * (1 - wCarve) + bedTarget * wCarve + 0.08 * params.lakeLevel * rim
        }
      }
    }

    // 7. Smooth flat alluvial city terraces blended organically into surrounding terrain
    const cityCore = new Uint8Array(V)
    for (const c of compCities) {
      const big = Boolean(c.isOrchestrator)
      const rFlat = big ? 0.58 : 0.48
      const rBlend = big ? 1.28 : 1.12
      const ringVals: number[] = []
      for (let u = 0; u < V; u++) {
        if (land[u] === 0) continue
        const d = Math.hypot(vx[u] - c.x, vz[u] - c.z)
        if (d <= rBlend) ringVals.push(h[u])
      }
      const rawTarget = ringVals.length ? quantile(ringVals, 0.48) : SEA_Y + 0.35
      const targetH = clamp(rawTarget, SEA_Y + 0.22, SEA_Y + 1.18)
      cityElevations.set(key(c), targetH)

      const pad: CityPad = { x: c.x, z: c.z, y: targetH, rFlat, rBlend }
      const minCx = Math.floor((c.x - rBlend) / PAD_CELL)
      const maxCx = Math.floor((c.x + rBlend) / PAD_CELL)
      const minCz = Math.floor((c.z - rBlend) / PAD_CELL)
      const maxCz = Math.floor((c.z + rBlend) / PAD_CELL)
      for (let ix = minCx; ix <= maxCx; ix++) {
        for (let iz = minCz; iz <= maxCz; iz++) {
          const gk = cellKey(ix, iz)
          let arr = padGrid.get(gk)
          if (!arr) {
            arr = []
            padGrid.set(gk, arr)
          }
          arr.push(pad)
        }
      }

      for (let u = 0; u < V; u++) {
        if (land[u] === 0) continue
        const dx = vx[u] - c.x
        const dz = vz[u] - c.z
        const d = Math.hypot(dx, dz)
        if (d > rBlend + 0.25) continue
        if (d <= rFlat) {
          h[u] = targetH
          cityCore[u] = 1
        } else {
          // Subtle noise-perturbed outer feather so city meadow blends organically into hillsides
          const edgeJ = (vnoise2(vx[u] * 1.1, vz[u] * 1.1, compSeed + 901) * 0.14)
          const t = smoothstep(rFlat, rBlend + edgeJ, d)
          h[u] = targetH * (1 - t) + h[u] * t
          if (d <= rFlat + 0.15) cityCore[u] = 1
        }
      }
    }

    // 8. Final exact Priority-Flood for alpine tarns & organic drainage river extraction
    const hPf = new Float32Array(V)
    for (let u = 0; u < V; u++) hPf[u] = land[u] === 1 ? h[u] : SEA_Y

    const wFlat = new Float32Array(V)
    runPriorityFlood(hPf, land, nbrPtr, nbrIdx, wFlat, closed, heapVal, heapIdx, 0.0)
    runPriorityFlood(hPf, land, nbrPtr, nbrIdx, filled, closed, heapVal, heapIdx, 1e-4)
    runFlowAndArea(
      filled,
      land,
      cellArea,
      nbrPtr,
      nbrIdx,
      nbrDist,
      receiver,
      recDist,
      donorCount,
      donorPtr,
      donors,
      cursor,
      order,
      stack,
      area,
    )

    // Connected-component alpine lake extraction (keep clear of city cores & tiny puddles)
    const lakeId = new Int32Array(V).fill(-1)
    const lakeY = new Float32Array(V).fill(SEA_Y)
    const lakes: LakeComponent[] = []
    if (params.lakeLevel > 0.02) {
      const lakeRaw = new Uint8Array(V)
      for (let u = 0; u < V; u++) {
        if (land[u] === 1 && cityCore[u] === 0 && wFlat[u] > SEA_Y + 0.1 && wFlat[u] - h[u] > 0.024) {
          let nearCity = false
          for (let ci = 0; ci < compCities.length; ci++) {
            if (Math.hypot(vx[u] - compCities[ci].x, vz[u] - compCities[ci].z) < 1.65) {
              nearCity = true
              break
            }
          }
          if (!nearCity) lakeRaw[u] = 1
        }
      }
      const visited = new Uint8Array(V)
      const qStack: number[] = []
      for (let u = 0; u < V; u++) {
        if (lakeRaw[u] === 0 || visited[u] === 1) continue
        const comp: number[] = []
        visited[u] = 1
        qStack.length = 0
        qStack.push(u)
        while (qStack.length) {
          const cur = qStack.pop()!
          comp.push(cur)
          const p0 = nbrPtr[cur]
          const p1 = nbrPtr[cur + 1]
          for (let p = p0; p < p1; p++) {
            const nb = nbrIdx[p]
            if (lakeRaw[nb] === 1 && visited[nb] === 0) {
              visited[nb] = 1
              qStack.push(nb)
            }
          }
        }
        if (comp.length < 8) continue
        let maxDepth = 0
        const wVals: number[] = []
        let cx = 0
        let cz = 0
        for (const node of comp) {
          const d = wFlat[node] - h[node]
          if (d > maxDepth) maxDepth = d
          wVals.push(wFlat[node])
          cx += vx[node]
          cz += vz[node]
        }
        if (maxDepth < 0.032) continue
        cx /= comp.length
        cz /= comp.length
        const surfY = quantile(wVals, 0.85)
        const lid = lakes.length
        for (const node of comp) {
          lakeId[node] = lid
          lakeY[node] = surfY
        }
        const cTile = compTileMap.get(key(unworld({ x: cx, z: cz }, RADIUS)))
        lakes.push({
          id: lid,
          waterY: surfY,
          triIndices: new Int32Array(0),
          continentId: cTile?.continent || continentIds[0],
          centerX: cx,
          centerZ: cz,
          vertexCount: comp.length,
        })
      }

      // Collect Delaunay triangles touching each lake component (exact depth-clipped contour!)
      if (lakes.length > 0) {
        const triBuckets: number[][] = lakes.map(() => [])
        for (let t = 0; t < mesh.T; t++) {
          const a = mesh.verts[3 * t]
          const b = mesh.verts[3 * t + 1]
          const c = mesh.verts[3 * t + 2]
          let lid = lakeId[a]
          if (lid < 0) lid = lakeId[b]
          if (lid < 0) lid = lakeId[c]
          if (lid >= 0) {
            triBuckets[lid].push(t)
          }
        }
        for (let lid = 0; lid < lakes.length; lid++) {
          lakes[lid].triIndices = new Int32Array(triBuckets[lid])
        }
      }
      totalLakes += lakes.length
    }

    // 9. Trace Chaikin-smoothed organic drainage rivers through the Delaunay graph
    const riverMix = new Float32Array(V)
    const aRiverMin = Math.max(4.2, aCrit * 2.5)
    const isRiv = new Uint8Array(V)
    for (let u = 0; u < V; u++) {
      if (land[u] === 1 && area[u] >= aRiverMin && lakeId[u] < 0) {
        isRiv[u] = 1
      }
    }
    const rivDonors = new Int32Array(V)
    for (let u = 0; u < V; u++) {
      if (isRiv[u] === 1) {
        const r = receiver[u]
        if (r !== u && isRiv[r] === 1) rivDonors[r]++
      }
    }

    for (let s = 0; s < V; s++) {
      if (isRiv[s] === 0) continue
      if (rivDonors[s] !== 0 && rivDonors[s] < 2) continue

      const rawPts: Array<{ x: number; z: number; area: number; u: number }> = [
        { x: vx[s], z: vz[s], area: area[s], u: s },
      ]
      let cur = s
      let steps = 0
      let reachesSea = false
      let endsInLake = false
      let endsAtConfluence = false
      while (steps < V) {
        const nxt = receiver[cur]
        if (nxt === cur) break
        rawPts.push({ x: vx[nxt], z: vz[nxt], area: area[nxt], u: nxt })
        if (land[nxt] === 0) {
          reachesSea = true
          break
        }
        if (lakeId[nxt] >= 0) {
          endsInLake = true
          break
        }
        if (rivDonors[nxt] >= 2) {
          endsAtConfluence = true
          break
        }
        if (isRiv[nxt] === 0) break
        cur = nxt
        steps++
      }

      if (rawPts.length < 5) continue
      let totalLen = 0
      for (let i = 1; i < rawPts.length; i++) {
        totalLen += Math.hypot(rawPts[i].x - rawPts[i - 1].x, rawPts[i].z - rawPts[i - 1].z)
      }
      if (totalLen < 2.8 && !endsInLake) continue
      if (!reachesSea && !endsInLake && !endsAtConfluence) continue

      const startsAtHeadwater = rivDonors[s] === 0

      // Gently depress river channel & immediate banks into a smooth green valley trough
      for (const rp of rawPts) {
        const u = rp.u
        if (land[u] === 1 && lakeId[u] < 0) {
          const strength = clamp(Math.pow(Math.max(0, rp.area / aRiverMin - 0.55), 0.42) * 0.58, 0.28, 1.0)
          if (strength > riverMix[u]) riverMix[u] = strength
          if (cityCore[u] === 0) {
            h[u] = Math.max(SEA_Y + 0.012, h[u] - 0.062 * strength)
          }
          const p0 = nbrPtr[u]
          const p1 = nbrPtr[u + 1]
          for (let p = p0; p < p1; p++) {
            const nb = nbrIdx[p]
            if (land[nb] === 1 && lakeId[nb] < 0 && cityCore[nb] === 0) {
              if (strength * 0.48 > riverMix[nb]) riverMix[nb] = strength * 0.48
              h[nb] = Math.max(SEA_Y + 0.014, h[nb] - 0.022 * strength)
            }
          }
        }
      }

      const smoothed = chaikinSmooth(rawPts, 2)
      const cumArc = [0]
      for (let i = 1; i < smoothed.length; i++) {
        cumArc.push(
          cumArc[i - 1] + Math.hypot(smoothed[i].x - smoothed[i - 1].x, smoothed[i].z - smoothed[i - 1].z),
        )
      }
      const maxArc = Math.max(1e-4, cumArc[cumArc.length - 1])
      const midPt = smoothed[(smoothed.length / 2) | 0]
      const midTile = compTileMap.get(key(unworld({ x: midPt.x, z: midPt.z }, RADIUS)))
      const rContId = midTile?.continent || continentIds[0]
      const owner = makeRiverOwner(rContId)

      const samplePts: RiverSamplePoint[] = smoothed.map((pt, idx) => {
        const frac = cumArc[idx] / maxArc
        const widthFactor = Math.min(3.4, Math.pow(Math.max(0, pt.area / aRiverMin - 0.65), 0.44))
        const mouthFlare = reachesSea ? smoothstep(0.75, 1.0, frac) * 0.09 : 0
        const headTaper = startsAtHeadwater ? 0.2 + 0.8 * smoothstep(0, 0.24, frac) : 1.0
        const halfW = (0.062 + 0.044 * widthFactor + mouthFlare) * headTaper
        return { x: pt.x, z: pt.z, frac, halfW, arc: cumArc[idx] }
      })

      riverPaths.push({ pts: samplePts, owner, continent: rContId, isOutlet: reachesSea })

      for (let i = 1; i < samplePts.length; i++) {
        const a = samplePts[i - 1]
        const b = samplePts[i]
        const segHalfW = (a.halfW + b.halfW) * 0.5
        const seg: RiverSegment = {
          ax: a.x,
          az: a.z,
          bx: b.x,
          bz: b.z,
          halfW: segHalfW,
          frac: (a.frac + b.frac) * 0.5,
          isOutlet: reachesSea,
          owner,
          continent: rContId,
        }
        const pad = Math.max(0.95, segHalfW * 3.2)
        const minCx = Math.floor((Math.min(a.x, b.x) - pad) / RIVER_CELL)
        const maxCx = Math.floor((Math.max(a.x, b.x) + pad) / RIVER_CELL)
        const minCz = Math.floor((Math.min(a.z, b.z) - pad) / RIVER_CELL)
        const maxCz = Math.floor((Math.max(a.z, b.z) + pad) / RIVER_CELL)
        for (let ix = minCx; ix <= maxCx; ix++) {
          for (let iz = minCz; iz <= maxCz; iz++) {
            const gk = cellKey(ix, iz)
            let arr = riverGrid.get(gk)
            if (!arr) {
              arr = []
              riverGrid.set(gk, arr)
            }
            arr.push(seg)
          }
        }
      }
    }

    // 10. Compute per-vertex slope |∇h|, local concavity AO, max height, and flow azimuth angles
    const slope = new Float32Array(V)
    const ao = new Float32Array(V)
    let maxLandHeight = 0.5
    const angles: number[] = []

    for (let u = 0; u < V; u++) {
      const hu = h[u]
      if (land[u] === 1 && hu - SEA_Y > maxLandHeight) maxLandHeight = hu - SEA_Y
      const p0 = nbrPtr[u]
      const p1 = nbrPtr[u + 1]
      // Least-squares gradient estimate on irregular 1-ring
      let sxx = 0
      let sxz = 0
      let szz = 0
      let sxh = 0
      let szh = 0
      let hSum = 0
      let nCnt = 0
      for (let p = p0; p < p1; p++) {
        const v = nbrIdx[p]
        const dx = vx[v] - vx[u]
        const dz = vz[v] - vz[u]
        const dh = h[v] - hu
        const w = 1 / Math.max(0.04, nbrDist[p] * nbrDist[p])
        sxx += w * dx * dx
        sxz += w * dx * dz
        szz += w * dz * dz
        sxh += w * dx * dh
        szh += w * dz * dh
        hSum += h[v]
        nCnt++
      }
      const det = sxx * szz - sxz * sxz
      if (Math.abs(det) > 1e-8) {
        const gx = (szz * sxh - sxz * szh) / det
        const gz = (sxx * szh - sxz * sxh) / det
        slope[u] = Math.hypot(gx, gz)
      }
      const avgNb = nCnt > 0 ? hSum / nCnt : hu
      // Concave valley/cirque -> subtle darkening (0.76), convex ridge -> sunlit highlight (1.05)
      const rel = clamp((hu - avgNb) / Math.max(0.18, spacing * 0.85), -1, 1)
      ao[u] = clamp(0.95 + rel * 0.14, 0.76, 1.06)

      if (land[u] === 1 && receiver[u] !== u) {
        const r = receiver[u]
        const deg = ((Math.atan2(vz[r] - vz[u], vx[r] - vx[u]) * 180) / Math.PI + 360) % 180
        angles.push(deg)
      }
    }

    const spatial = buildSpatialGrid(mesh)
    patches.push({
      id: continentIds.join('+'),
      continentIds,
      mesh,
      land,
      distInland,
      distSea,
      h,
      slope,
      ao,
      mtnEnv,
      lakeId,
      lakeY,
      riverMix,
      cityCore,
      receiver,
      area,
      maxLandHeight,
      lakes,
      flowAngles: new Float32Array(angles),
      ...spatial,
    })
  }

  // ---------- 5. Build Fast O(1) Barycentric Archipelago TerrainSampler ----------

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

  function queryPatches(x: number, z: number): BaryHit | null {
    let best: BaryHit | null = null
    for (let i = 0; i < patches.length; i++) {
      const hit = samplePatchBarycentric(patches[i], x, z)
      if (!hit) continue
      if (hit.landFrac >= 0.99) return hit
      if (!best || hit.landFrac > best.landFrac + 1e-4 || (Math.abs(hit.landFrac - best.landFrac) <= 1e-4 && hit.h > best.h)) {
        best = hit
      }
    }
    return best
  }

  function sampleNatural(x: number, z: number): NaturalSample {
    const hit = queryPatches(x, z)
    const c0 = unworld({ x, z }, RADIUS)
    const ownTile = tileMap.get(key(c0)) || null
    let nearestTile = ownTile
    if (!nearestTile) {
      let bestD2 = Infinity
      for (let i = 0; i < HEX_RING2.length; i++) {
        const t = tileMap.get(`${c0.q + HEX_RING2[i][0]},${c0.r + HEX_RING2[i][1]}`)
        if (t) {
          const d2 = (x - t.x) * (x - t.x) + (z - t.z) * (z - t.z)
          if (d2 < bestD2) {
            bestD2 = d2
            nearestTile = t
          }
        }
      }
    }
    const hVal = hit ? hit.h : SEA_Y - 0.56
    const sl = hit ? hit.slope : 0
    return {
      h: hVal,
      baseH: hVal,
      ridge: sl,
      slope: sl,
      ownTile,
      nearestTile,
      landRatio: hit ? hit.landFrac : 0,
    }
  }

  function sample(x: number, z: number): TerrainSample {
    const hit = queryPatches(x, z)
    const c0 = unworld({ x, z }, RADIUS)
    const ownTile = tileMap.get(key(c0)) || null
    const hVal = hit ? hit.h : SEA_Y - 0.56
    const sl = hit ? hit.slope : 0
    const isLake = Boolean(hit?.isLake)
    const lakeY = hit?.lakeY ?? null

    let isRiver = false
    let riverBank = false
    let riverOwner: TileOwner | null = null
    let riverDist = 99
    const rv = nearestRiver(x, z)
    if (rv && hVal > SEA_Y - 0.12) {
      riverDist = rv.dist
      const hw = rv.seg.halfW || 0.14
      if (rv.dist < hw * 2.5) riverBank = true
      if (rv.dist < hw * 1.25) {
        isRiver = true
        riverOwner = rv.seg.owner
      }
    }

    let inPad = false
    const pads = padGrid.get(cellKey(Math.floor(x / PAD_CELL), Math.floor(z / PAD_CELL)))
    if (pads) {
      for (let i = 0; i < pads.length; i++) {
        if (Math.hypot(x - pads[i].x, z - pads[i].z) <= pads[i].rFlat) {
          inPad = true
          isRiver = false
          break
        }
      }
    }

    return {
      h: hVal,
      baseH: hVal,
      ridge: sl,
      slope: sl,
      ownTile,
      nearestTile: ownTile,
      isRiver,
      riverBank,
      riverOwner,
      riverDist,
      isLake,
      lakeY,
      inPad,
    }
  }

  function sampleHeight(x: number, z: number): number {
    const hit = queryPatches(x, z)
    return hit ? hit.h : SEA_Y - 0.56
  }

  function sampleSlope(x: number, z: number): number {
    const hit = queryPatches(x, z)
    return hit ? hit.slope : 0
  }

  function isInRiver(x: number, z: number): boolean {
    const rv = nearestRiver(x, z)
    if (!rv) return false
    return rv.dist < (rv.seg.halfW || 0.14) + 0.12
  }

  function isInLake(x: number, z: number): boolean {
    const hit = queryPatches(x, z)
    return Boolean(hit?.isLake)
  }

  function isInWater(x: number, z: number): boolean {
    const hit = queryPatches(x, z)
    if (!hit || hit.h <= SEA_Y + 0.025 || hit.isLake) return true
    return isInRiver(x, z)
  }

  function lakeSurfaceY(x: number, z: number): number | null {
    const hit = queryPatches(x, z)
    return hit?.isLake ? hit.lakeY : null
  }

  function riverSurfaceY(x: number, z: number): number {
    const hVal = sampleHeight(x, z)
    return Math.max(SEA_Y + 0.022, hVal + 0.042)
  }

  const sampler: TerrainSampler = {
    sample,
    sampleNatural,
    sampleHeight,
    sampleSlope,
    isInRiver,
    isInLake,
    isInWater,
    nearestRiver,
    riverSurfaceY,
    lakeSurfaceY,
    cityElevations,
    riverPaths,
  }

  const tEnd = typeof performance !== 'undefined' ? performance.now() : Date.now()
  return {
    patches,
    sampler,
    params,
    stats: {
      solveMs: Number((tEnd - tStart).toFixed(1)),
      patchCount: patches.length,
      totalVerts,
      totalLandVerts,
      totalTris,
      lakeCount: totalLakes,
      riverCount: riverPaths.length,
      delaunayViolations: totalViolations,
    },
  }
}

/** Measure 8-fold grid alignment bias |mean(cos(8*theta))| over flow angles in degrees. */
export function flowEightFoldBias(patches: readonly TerrainPatch[]): number {
  let sum = 0
  let count = 0
  for (const p of patches) {
    const arr = p.flowAngles
    for (let i = 0; i < arr.length; i++) {
      sum += Math.cos((arr[i] * Math.PI * 8) / 180)
      count++
    }
  }
  return count > 0 ? sum / count : 0
}
