// Continuous Geological Mountain Ranges, Sculpted Granite Crag Massifs,
// Connecting Ridge Saddles & Conifer Foothills.
// Operates strictly over atlas tiles from layout.ts without modifying hex positions.
import * as THREE from 'three'
import { buildTree } from './assets.js'
import { DIRECTIONS, RADIUS, hash, key, world } from './layout.js'
import { fbm2 } from './terrainMesh.js'
import type {
  AssetContext,
  AtlasLayout,
  CoarseCell,
  FineTile,
  MountainClass,
  MountainField,
  MountainL1Entry,
  MountainL2Cell,
  MountainStats,
  PickOwner,
  PlacedCity,
  PlacedContinent,
  RenderTier,
  RidgeNeighborL1,
  RidgeNeighborL2,
  TerrainSampler,
  WorldXZ,
} from './types.js'

export const HEX_DIST = Math.sqrt(3) * RADIUS
export const MOUNTAIN_CLASSES = new Set<MountainClass>(['ridge', 'peak', 'high_peak'])

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}

function rotPoint(x: number, z: number, dx: number, dz: number, angle: number): [number, number] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [x + dx * c + dz * s, z - dx * s + dz * c]
}

type Vec3 = [number, number, number]

// ---------- 1. Custom Flat-Shaded Faceted Granite Geometries ----------

function buildFacetedGeometry(tris: Array<[Vec3, Vec3, Vec3]>, ref: Vec3 = [0, 0.35, 0]): THREE.BufferGeometry {
  const pos = new Float32Array(tris.length * 9)
  const uvs = new Float32Array(tris.length * 6)
  let pi = 0
  let ui = 0

  for (let i = 0; i < tris.length; i++) {
    let [a, b, c] = tris[i]
    const e1x = b[0] - a[0]
    const e1y = b[1] - a[1]
    const e1z = b[2] - a[2]
    const e2x = c[0] - a[0]
    const e2y = c[1] - a[1]
    const e2z = c[2] - a[2]
    const nx = e1y * e2z - e1z * e2y
    const ny = e1z * e2x - e1x * e2z
    const nz = e1x * e2y - e1y * e2x
    const cx = (a[0] + b[0] + c[0]) / 3 - ref[0]
    const cy = (a[1] + b[1] + c[1]) / 3 - ref[1]
    const cz = (a[2] + b[2] + c[2]) / 3 - ref[2]
    if (nx * cx + ny * cy + nz * cz < 0) {
      const tmp = b
      b = c
      c = tmp
    }
    for (const v of [a, b, c]) {
      pos[pi++] = v[0]
      pos[pi++] = v[1]
      pos[pi++] = v[2]
      const ang = Math.atan2(v[2], v[0])
      uvs[ui++] = (ang / (Math.PI * 2) + 0.5) * 1.5
      uvs[ui++] = clamp(v[1], 0, 1)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return geo
}

function makeCragGeometry(): THREE.BufferGeometry {
  const N = 7
  const rBase = [1.02, 0.88, 1.06, 0.84, 1.0, 0.9, 0.96]
  const rMid = [0.74, 0.58, 0.8, 0.54, 0.72, 0.64, 0.68]
  const yMid = [0.44, 0.34, 0.5, 0.32, 0.46, 0.38, 0.43]
  const rTop = [0.4, 0.26, 0.42, 0.25, 0.36, 0.3, 0.34]
  const yTop = [0.78, 0.68, 0.84, 0.66, 0.8, 0.72, 0.76]

  const base: Vec3[] = []
  const mid: Vec3[] = []
  const top: Vec3[] = []
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + (i % 2 ? 0.1 : -0.08)
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    base.push([ca * rBase[i], -0.06, sa * rBase[i]])
    mid.push([ca * rMid[i] + 0.05, yMid[i], sa * rMid[i] - 0.03])
    top.push([ca * rTop[i] + 0.09, yTop[i], sa * rTop[i] - 0.06])
  }
  const crestA: Vec3 = [-0.1, 0.92, -0.16]
  const crestB: Vec3 = [0.18, 1.0, 0.1]

  const tris: Array<[Vec3, Vec3, Vec3]> = []
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N
    tris.push([base[i], base[j], mid[j]])
    tris.push([base[i], mid[j], mid[i]])
    tris.push([mid[i], mid[j], top[j]])
    tris.push([mid[i], top[j], top[i]])
  }
  const nearCrest = (v: Vec3): Vec3 => {
    const dA = (v[0] - crestA[0]) ** 2 + (v[2] - crestA[2]) ** 2
    const dB = (v[0] - crestB[0]) ** 2 + (v[2] - crestB[2]) ** 2
    return dA <= dB ? crestA : crestB
  }
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N
    const cI = nearCrest(top[i])
    const cJ = nearCrest(top[j])
    if (cI === cJ) {
      tris.push([top[i], top[j], cI])
    } else {
      tris.push([top[i], top[j], cJ])
      tris.push([top[i], cJ, cI])
    }
  }
  return buildFacetedGeometry(tris, [0.04, 0.34, -0.02])
}

function makeRidgeGeometry(): THREE.BufferGeometry {
  const zS = [-0.94, -0.44, 0.04, 0.5, 0.94]
  const wBase = [0.38, 0.6, 0.64, 0.58, 0.36]
  const wMid = [0.22, 0.4, 0.42, 0.36, 0.2]
  const yMid = [0.26, 0.52, 0.58, 0.48, 0.25]
  const yTop = [0.42, 0.88, 1.0, 0.82, 0.4]
  const xCrest = [-0.04, 0.08, -0.06, 0.07, -0.02]

  const L0: Vec3[] = []
  const R0: Vec3[] = []
  const L1: Vec3[] = []
  const R1: Vec3[] = []
  const C: Vec3[] = []
  for (let i = 0; i < zS.length; i++) {
    const z = zS[i]
    L0.push([-wBase[i], -0.06, z])
    R0.push([wBase[i], -0.06, z])
    L1.push([-wMid[i] + xCrest[i] * 0.4, yMid[i], z])
    R1.push([wMid[i] + xCrest[i] * 0.4, yMid[i], z])
    C.push([xCrest[i], yTop[i], z])
  }

  const tris: Array<[Vec3, Vec3, Vec3]> = []
  for (let i = 0; i < zS.length - 1; i++) {
    tris.push([L0[i], L0[i + 1], L1[i + 1]])
    tris.push([L0[i], L1[i + 1], L1[i]])
    tris.push([L1[i], L1[i + 1], C[i + 1]])
    tris.push([L1[i], C[i + 1], C[i]])
    tris.push([R0[i], R1[i + 1], R0[i + 1]])
    tris.push([R0[i], R1[i], R1[i + 1]])
    tris.push([R1[i], C[i + 1], R1[i + 1]])
    tris.push([R1[i], C[i], C[i + 1]])
  }
  const last = zS.length - 1
  tris.push([L0[0], R0[0], R1[0]])
  tris.push([L0[0], R1[0], L1[0]])
  tris.push([L1[0], R1[0], C[0]])

  tris.push([R0[last], L0[last], L1[last]])
  tris.push([R0[last], L1[last], R1[last]])
  tris.push([R1[last], L1[last], C[last]])

  return buildFacetedGeometry(tris, [0, 0.3, 0])
}

function makeSnowGeometry(): THREE.BufferGeometry {
  const zS = [-0.66, -0.28, 0.02, 0.3, 0.64]
  const wL = [0.06, 0.24, 0.28, 0.21, 0.05]
  const wR = [0.05, 0.19, 0.26, 0.23, 0.06]
  const yL = [0.16, 0.04, 0.22, 0.0, 0.14]
  const yR = [0.2, 0.24, 0.0, 0.2, 0.16]
  const yC = [0.34, 0.8, 1.0, 0.74, 0.3]
  const xC = [-0.03, 0.05, -0.04, 0.04, -0.02]

  const L: Vec3[] = []
  const R: Vec3[] = []
  const C: Vec3[] = []
  for (let i = 0; i < zS.length; i++) {
    const z = zS[i]
    L.push([-wL[i] + xC[i] * 0.25, yL[i], z])
    R.push([wR[i] + xC[i] * 0.25, yR[i], z])
    C.push([xC[i], yC[i], z])
  }
  const tris: Array<[Vec3, Vec3, Vec3]> = []
  for (let i = 0; i < zS.length - 1; i++) {
    tris.push([L[i], L[i + 1], C[i + 1]])
    tris.push([L[i], C[i + 1], C[i]])
    tris.push([R[i], C[i + 1], R[i + 1]])
    tris.push([R[i], C[i], C[i + 1]])
  }
  const last = zS.length - 1
  tris.push([L[0], R[0], C[0]])
  tris.push([R[last], L[last], C[last]])
  return buildFacetedGeometry(tris, [0, -0.3, 0])
}

export function createMountainGeometries(): {
  crag: THREE.BufferGeometry
  ridge: THREE.BufferGeometry
  snow: THREE.BufferGeometry
} {
  return {
    crag: makeCragGeometry(),
    ridge: makeRidgeGeometry(),
    snow: makeSnowGeometry(),
  }
}

// ---------- 2. Coherent Geological Mountain Range & Foothill Field ----------

function continentOrogeny(c: PlacedContinent): number {
  if (!c || c.kind === 'shoals') return 0
  const citeScore = clamp(Math.log2(1 + (c.citedBy || 0)) / 11.1, 0, 1)
  const massScore = clamp(Math.log2(1 + (c.total || 0)) / 11.3, 0, 1)
  const peakScore = clamp(((c.peak || 0) - 0.8) / 2.6, 0, 1)
  const linear = 0.46 * citeScore + 0.24 * massScore + 0.3 * peakScore
  return clamp(Math.pow(linear, 1.85), 0, 1)
}

function principalAxis(tiles: FineTile[], seed: number): { cx: number; cz: number; theta: number } {
  let cx = 0
  let cz = 0
  let wSum = 0
  for (const t of tiles) {
    const w = 0.6 + Math.max(0, t.height || 0.5) * 0.4
    cx += t.x * w
    cz += t.z * w
    wSum += w
  }
  cx /= wSum || 1
  cz /= wSum || 1
  let sxx = 0
  let szz = 0
  let sxz = 0
  for (const t of tiles) {
    const w = 0.6 + Math.max(0, t.height || 0.5) * 0.4
    const dx = t.x - cx
    const dz = t.z - cz
    sxx += w * dx * dx
    szz += w * dz * dz
    sxz += w * dx * dz
  }
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz) + (seed - 0.5) * 0.26
  return { cx, cz, theta }
}

export function computeMountainField(
  atlas: AtlasLayout,
  tileMap: ReadonlyMap<string, FineTile>,
  cityAt: ReadonlyMap<string, PlacedCity>,
): MountainField {
  const roadSet = new Set<string>()
  for (const r of atlas.roads || []) {
    for (const p of r.points || []) roadSet.add(key(p))
  }

  const l2 = new Map<string, MountainL2Cell>()
  const stats: MountainStats[] = []

  for (const c of atlas.continents || []) {
    const orogeny = continentOrogeny(c)
    const contTiles = atlas.level2.filter(t => t.continent === c.id)
    if (!contTiles.length) continue

    const eligibleSet = new Set<string>()
    const eligibleTiles: FineTile[] = []
    for (const t of contTiles) {
      const tk = key(t)
      if (cityAt.has(tk) || t.coast || t.river || t.isthmus || roadSet.has(tk)) continue
      eligibleSet.add(tk)
      eligibleTiles.push(t)
    }

    let minH = Infinity
    let maxH = -Infinity
    for (const t of eligibleTiles) {
      if (t.height < minH) minH = t.height
      if (t.height > maxH) maxH = t.height
    }
    const hSpan = Math.max(0.25, maxH - minH)

    const seenComp = new Set<string>()
    const comps: FineTile[][] = []
    for (const t of eligibleTiles) {
      const tk = key(t)
      if (seenComp.has(tk)) continue
      const q: FineTile[] = [t]
      const comp: FineTile[] = []
      seenComp.add(tk)
      while (q.length) {
        const cur = q.pop()!
        comp.push(cur)
        for (const [dq, dr] of DIRECTIONS) {
          const nk = `${cur.q + dq},${cur.r + dr}`
          if (eligibleSet.has(nk) && !seenComp.has(nk)) {
            seenComp.add(nk)
            const nt = tileMap.get(nk)
            if (nt) q.push(nt)
          }
        }
      }
      comps.push(comp)
    }

    const rawStrength = new Map<string, number>()
    const rawTangent = new Map<string, number>()
    const contSeed = hash(c.id + ':tectonics')

    if (orogeny >= 0.08) {
      for (let ci = 0; ci < comps.length; ci++) {
        const comp = comps[ci]
        if (comp.length < 3) continue
        if (orogeny < 0.45 && comp.length < 6) continue

        const cSeed = hash(`${c.id}:comp:${ci}`)
        const { cx, cz, theta } = principalAxis(comp, cSeed)
        const cosT = Math.cos(theta)
        const sinT = Math.sin(theta)

        let uMin = Infinity
        let uMax = -Infinity
        let vMin = Infinity
        let vMax = -Infinity
        const proj = new Map<string, { u: number; v: number }>()
        for (const t of comp) {
          const dx = t.x - cx
          const dz = t.z - cz
          const u = dx * cosT + dz * sinT
          const v = -dx * sinT + dz * cosT
          if (u < uMin) uMin = u
          if (u > uMax) uMax = u
          if (v < vMin) vMin = v
          if (v > vMax) vMax = v
          proj.set(key(t), { u, v })
        }
        const uSpan = Math.max(4, uMax - uMin)
        const vSpan = Math.max(3, vMax - vMin)

        const wideExpanse = comp.length > 52
        const dualSpine = comp.length >= 105 && orogeny >= 0.62
        const arcs: Array<{ vOff: number; amp: number; freq: number; phase: number; halfW: number; weight: number }> = []
        if (dualSpine) {
          arcs.push({
            vOff: -vSpan * 0.16,
            amp: Math.min(3.4, vSpan * 0.17),
            freq: (Math.PI * 1.45) / uSpan,
            phase: contSeed * 6.28,
            halfW: 2.35 + orogeny * 0.85,
            weight: 1.0,
          })
          arcs.push({
            vOff: vSpan * 0.22,
            amp: Math.min(2.6, vSpan * 0.14),
            freq: (Math.PI * 1.75) / uSpan,
            phase: contSeed * 6.28 + 2.3,
            halfW: 1.95 + orogeny * 0.55,
            weight: 0.84,
          })
        } else {
          arcs.push({
            vOff: (cSeed - 0.5) * Math.min(1.6, vSpan * 0.14),
            amp: Math.min(wideExpanse ? 3.8 : 2.2, vSpan * 0.22),
            freq: (Math.PI * (wideExpanse ? 1.55 : 1.15)) / uSpan,
            phase: (contSeed + cSeed) * 6.28,
            halfW: wideExpanse ? 2.15 + orogeny * 1.1 : 2.3 + orogeny * 1.15,
            weight: 1.0,
          })
        }

        for (const t of comp) {
          const tk = key(t)
          const { u, v } = proj.get(tk)!
          const uNorm = (u - uMin) / uSpan
          const endTaper = wideExpanse
            ? smoothstep(0.02, 0.18, uNorm) * smoothstep(0.02, 0.18, 1 - uNorm)
            : smoothstep(-0.04, 0.12, uNorm) * smoothstep(-0.04, 0.12, 1 - uNorm)

          let eligNbs = 0
          for (const [dq, dr] of DIRECTIONS) {
            if (eligibleSet.has(`${t.q + dq},${t.r + dr}`)) eligNbs++
          }
          const interiorFactor = clamp((eligNbs - 1) / 4.2, 0.22, 1.0)

          const warp = fbm2(t.x * 0.11 + contSeed * 19, t.z * 0.11 - contSeed * 13) * 1.55
          let bestSpine = 0
          let bestTan = theta
          for (const arc of arcs) {
            const vSpine = arc.vOff + arc.amp * Math.sin(arc.freq * (u - uMin) + arc.phase) + warp
            const dPerp = Math.abs(v - vSpine)
            const s = Math.exp(-(dPerp * dPerp) / (arc.halfW * arc.halfW)) * arc.weight
            if (s > bestSpine) {
              bestSpine = s
              const dvdu = arc.amp * arc.freq * Math.cos(arc.freq * (u - uMin) + arc.phase)
              bestTan = theta + Math.atan(dvdu)
            }
          }

          const ridgeWave = 0.5 + 0.5 * (1 - Math.abs(fbm2(t.x * 0.21 - 7.3, t.z * 0.21 + 4.1)))
          const hNorm = clamp((t.height - minH) / hSpan, 0, 1)

          const coreField = wideExpanse
            ? bestSpine * (0.56 + 0.26 * hNorm + 0.18 * interiorFactor) * ridgeWave * (0.35 + 0.65 * endTaper)
            : (0.64 * bestSpine + 0.36 * interiorFactor) * (0.7 + 0.3 * hNorm) * ridgeWave * (0.55 + 0.45 * endTaper)

          const strength = clamp(coreField * (0.44 + 0.66 * orogeny), 0, 1)
          rawStrength.set(tk, strength)
          rawTangent.set(tk, bestTan)
        }
      }
    }

    const smoothStrength = new Map<string, number>()
    for (const t of eligibleTiles) {
      const tk = key(t)
      const self = rawStrength.get(tk) || 0
      let nbSum = 0
      let nbCnt = 0
      for (const [dq, dr] of DIRECTIONS) {
        const nk = `${t.q + dq},${t.r + dr}`
        if (eligibleSet.has(nk)) {
          nbSum += rawStrength.get(nk) || 0
          nbCnt++
        }
      }
      const avgNb = nbCnt ? nbSum / nbCnt : 0
      smoothStrength.set(tk, self * 0.72 + avgNb * 0.28)
    }

    const mThresh = orogeny < 0.25 ? 0.31 : orogeny < 0.55 ? 0.37 : 0.35
    const isMtn = new Set<string>()
    for (const t of eligibleTiles) {
      const tk = key(t)
      if ((smoothStrength.get(tk) || 0) >= mThresh) isMtn.add(tk)
    }

    const toAdd: string[] = []
    const toRemove: string[] = []
    for (const tk of isMtn) {
      const t = tileMap.get(tk)!
      let mNbs = 0
      for (const [dq, dr] of DIRECTIONS) {
        if (isMtn.has(`${t.q + dq},${t.r + dr}`)) mNbs++
      }
      if (mNbs === 0) {
        let bestBridge: string | null = null
        let bestScore = 0.22
        for (const [dq, dr] of DIRECTIONS) {
          const bk = `${t.q + dq},${t.r + dr}`
          if (!eligibleSet.has(bk) || isMtn.has(bk)) continue
          const bt = tileMap.get(bk)!
          let touchesOther = false
          for (const [dq2, dr2] of DIRECTIONS) {
            const ck = `${bt.q + dq2},${bt.r + dr2}`
            if (ck !== tk && isMtn.has(ck)) {
              touchesOther = true
              break
            }
          }
          const bs = smoothStrength.get(bk) || 0
          if (touchesOther && bs > bestScore) {
            bestScore = bs
            bestBridge = bk
          }
        }
        if (bestBridge) {
          toAdd.push(bestBridge)
        } else {
          let bestNb: string | null = null
          let bestNbS = 0.26
          for (const [dq, dr] of DIRECTIONS) {
            const nk = `${t.q + dq},${t.r + dr}`
            const s = smoothStrength.get(nk) || 0
            if (eligibleSet.has(nk) && s > bestNbS) {
              bestNbS = s
              bestNb = nk
            }
          }
          if (bestNb && (smoothStrength.get(tk) || 0) > mThresh + 0.08) {
            toAdd.push(bestNb)
          } else {
            toRemove.push(tk)
          }
        }
      }
    }
    for (const bk of toAdd) {
      isMtn.add(bk)
      smoothStrength.set(bk, Math.max(smoothStrength.get(bk) || 0, mThresh + 0.02))
    }
    for (const rk of toRemove) isMtn.delete(rk)

    if (orogeny < 0.2 && isMtn.size > 4) {
      const sorted = [...isMtn].sort((a, b) => (smoothStrength.get(b) || 0) - (smoothStrength.get(a) || 0))
      for (const dropK of sorted.slice(3)) isMtn.delete(dropK)
    }

    for (const tk of [...isMtn]) {
      const t = tileMap.get(tk)!
      let mNbs = 0
      for (const [dq, dr] of DIRECTIONS) {
        if (isMtn.has(`${t.q + dq},${t.r + dr}`)) mNbs++
      }
      if (mNbs === 0) isMtn.delete(tk)
    }

    let mMax = 0.01
    for (const tk of isMtn) {
      const s = smoothStrength.get(tk) || 0
      if (s > mMax) mMax = s
    }

    const contMtnClass = new Map<string, MountainClass>()
    const contMtnStrength = new Map<string, number>()
    for (const tk of isMtn) {
      const t = tileMap.get(tk)!
      const raw = smoothStrength.get(tk) || 0
      let mNbs = 0
      for (const [dq, dr] of DIRECTIONS) {
        if (isMtn.has(`${t.q + dq},${t.r + dr}`)) mNbs++
      }
      const rel = clamp((raw - mThresh) / Math.max(0.14, mMax - mThresh), 0, 1)
      const localRelief = 0.5 + 0.5 * fbm2(t.x * 0.36 + 3.1, t.z * 0.36 - 5.7)
      const spineBoost = mNbs >= 4 ? 0.14 : mNbs === 3 ? 0.08 : mNbs === 2 ? 0.03 : -0.05
      const shaped = Math.pow(clamp(rel * 0.72 + localRelief * 0.28, 0, 1), 1.15)
      const s = clamp((0.32 + shaped * 0.58 + spineBoost) * (0.56 + 0.46 * orogeny), 0.3, 1.0)
      contMtnStrength.set(tk, s)

      let mClass: MountainClass = 'ridge'
      if (s >= 0.8 && orogeny >= 0.62 && mNbs >= 2) mClass = 'high_peak'
      else if (s >= 0.57 && orogeny >= 0.36) mClass = 'peak'
      contMtnClass.set(tk, mClass)
    }

    let cRidge = 0
    let cPeak = 0
    let cHigh = 0
    let cFoot = 0
    for (const t of contTiles) {
      const tk = key(t)
      if (isMtn.has(tk)) {
        const mClass = contMtnClass.get(tk)!
        const mStrength = contMtnStrength.get(tk)!
        if (mClass === 'high_peak') cHigh++
        else if (mClass === 'peak') cPeak++
        else cRidge++

        const ridgeNeighbors: RidgeNeighborL2[] = []
        const foothillDirs: number[] = []
        let axX = 0
        let axZ = 0
        for (let dir = 0; dir < 6; dir++) {
          const [dq, dr] = DIRECTIONS[dir]
          const nk = `${t.q + dq},${t.r + dr}`
          const nb = tileMap.get(nk)
          if (!nb) continue
          if (isMtn.has(nk)) {
            ridgeNeighbors.push({
              dir,
              key: nk,
              tile: nb,
              strength: contMtnStrength.get(nk)!,
              mClass: contMtnClass.get(nk)!,
            })
            const ang = Math.atan2(nb.x - t.x, nb.z - t.z)
            axX += Math.cos(2 * ang)
            axZ += Math.sin(2 * ang)
          } else if (!cityAt.has(nk) && !nb.river && !nb.isthmus) {
            foothillDirs.push(dir)
          }
        }
        const ridgeAxis = axX * axX + axZ * axZ > 1e-4 ? 0.5 * Math.atan2(axZ, axX) : (rawTangent.get(tk) ?? 0)

        l2.set(tk, {
          tile: t,
          key: tk,
          continent: c.id,
          orogeny,
          mStrength,
          mClass,
          ridgeNeighbors,
          foothillDirs,
          mountainDirs: [],
          ridgeAxis,
        })
      } else if (!cityAt.has(tk) && !t.river && !t.isthmus) {
        const mountainDirs: number[] = []
        let maxAdj = 0
        for (let dir = 0; dir < 6; dir++) {
          const [dq, dr] = DIRECTIONS[dir]
          const nk = `${t.q + dq},${t.r + dr}`
          if (isMtn.has(nk)) {
            mountainDirs.push(dir)
            maxAdj = Math.max(maxAdj, contMtnStrength.get(nk) || 0.4)
          }
        }
        if (mountainDirs.length > 0) {
          cFoot++
          l2.set(tk, {
            tile: t,
            key: tk,
            continent: c.id,
            orogeny,
            mStrength: clamp(maxAdj * 0.45, 0.16, 0.35),
            mClass: 'foothill',
            ridgeNeighbors: [],
            foothillDirs: [],
            mountainDirs,
            ridgeAxis: 0,
          })
        }
      }
    }

    const seenM = new Set<string>()
    const chainSizes: number[] = []
    for (const tk of isMtn) {
      if (seenM.has(tk)) continue
      const q = [tk]
      seenM.add(tk)
      let sz = 0
      while (q.length) {
        const cur = q.pop()!
        sz++
        const cell = l2.get(cur)!
        for (const nb of cell.ridgeNeighbors) {
          if (!seenM.has(nb.key)) {
            seenM.add(nb.key)
            q.push(nb.key)
          }
        }
      }
      chainSizes.push(sz)
    }
    chainSizes.sort((a, b) => b - a)
    stats.push({
      continent: c.id,
      orogeny: Number(orogeny.toFixed(2)),
      totalL2: contTiles.length,
      ridge: cRidge,
      peak: cPeak,
      high_peak: cHigh,
      foothill: cFoot,
      mountains: cRidge + cPeak + cHigh,
      chains: chainSizes.length,
      largestChain: chainSizes[0] || 0,
      chainSizes,
    })
  }

  // ---------- 3. Project L2 Mountain Ranges onto World Zoom (LOD 0 / Level 1) ----------
  const l2ByL1 = new Map<string, FineTile[]>()
  for (const t of atlas.level2) {
    if (!t.cell) continue
    let arr = l2ByL1.get(t.cell)
    if (!arr) {
      arr = []
      l2ByL1.set(t.cell, arr)
    }
    arr.push(t)
  }

  interface RawL1 {
    cell: CoarseCell
    key: string
    continent: string
    orogeny: number
    mStrength: number
    mClass: MountainClass
    mCount: number
    cx: number
    cz: number
  }
  const l1Raw = new Map<string, RawL1>()
  const l1MtnKeys = new Set<string>()

  for (const c of atlas.level1) {
    const ck = key(c)
    if (c.isthmus) continue
    const chList = l2ByL1.get(ck) || []
    let mCount = 0
    let fCount = 0
    let maxS = 0
    let sumS = 0
    let highCount = 0
    let wx = 0
    let wz = 0
    let wSum = 0
    let orogeny = 0

    for (const t of chList) {
      const mc = l2.get(key(t))
      if (!mc) continue
      orogeny = Math.max(orogeny, mc.orogeny)
      if (MOUNTAIN_CLASSES.has(mc.mClass)) {
        mCount++
        maxS = Math.max(maxS, mc.mStrength)
        sumS += mc.mStrength
        if (mc.mClass === 'high_peak') highCount++
        const w = 0.5 + mc.mStrength
        wx += t.x * w
        wz += t.z * w
        wSum += w
      } else if (mc.mClass === 'foothill') {
        fCount++
      }
    }

    if (mCount >= 1 && (mCount >= 2 || maxS >= 0.44)) {
      const meanS = sumS / mCount
      const densityBoost = mCount >= 3 ? 0.08 : mCount === 2 ? 0.03 : -0.05
      const s = clamp(maxS * 0.62 + meanS * 0.38 + densityBoost, 0.34, 1.0)
      const mClass: MountainClass =
        highCount >= 2 || (highCount >= 1 && s >= 0.8 && orogeny >= 0.62)
          ? 'high_peak'
          : s >= 0.57 && orogeny >= 0.36
            ? 'peak'
            : 'ridge'
      const mx = wSum ? (wx / wSum) * 0.62 + c.x * 0.38 : c.x
      const mz = wSum ? (wz / wSum) * 0.62 + c.z * 0.38 : c.z
      l1MtnKeys.add(ck)
      l1Raw.set(ck, {
        cell: c,
        key: ck,
        continent: c.continent,
        orogeny,
        mStrength: s,
        mClass,
        mCount,
        cx: mx,
        cz: mz,
      })
    } else if (fCount >= 1) {
      l1Raw.set(ck, {
        cell: c,
        key: ck,
        continent: c.continent,
        orogeny,
        mStrength: 0.24,
        mClass: 'foothill',
        mCount: 0,
        cx: c.x,
        cz: c.z,
      })
    }
  }

  const l1 = new Map<string, MountainL1Entry>()
  for (const [ck, entry] of l1Raw.entries()) {
    const c = entry.cell
    const isM = l1MtnKeys.has(ck)
    const ridgeNeighbors: RidgeNeighborL1[] = []
    const mountainDirs: number[] = []
    let axX = 0
    let axZ = 0

    for (let dir = 0; dir < 6; dir++) {
      const [dq, dr] = DIRECTIONS[dir]
      const nk = `${c.q + dq},${c.r + dr}`
      if (l1MtnKeys.has(nk)) {
        const nb = l1Raw.get(nk)!
        if (nb.continent !== entry.continent) continue
        if (isM) {
          ridgeNeighbors.push({
            dir,
            key: nk,
            cell: nb.cell,
            strength: nb.mStrength,
            mClass: nb.mClass,
            cx: nb.cx,
            cz: nb.cz,
          })
          const ang = Math.atan2(nb.cx - entry.cx, nb.cz - entry.cz)
          axX += Math.cos(2 * ang)
          axZ += Math.sin(2 * ang)
        } else {
          mountainDirs.push(dir)
        }
      }
    }

    const ridgeAxis =
      axX * axX + axZ * axZ > 1e-4 ? 0.5 * Math.atan2(axZ, axX) : hash(ck + ':l1ax') * Math.PI

    l1.set(ck, {
      ...entry,
      ridgeNeighbors,
      mountainDirs,
      ridgeAxis,
    })
  }

  for (const st of stats) {
    let l1M = 0
    for (const e of l1.values()) {
      if (e.continent === st.continent && MOUNTAIN_CLASSES.has(e.mClass)) l1M++
    }
    st.l1Mountains = l1M
  }

  return { l2, l1, stats }
}

// ---------- 4. Sculpted Rocky Crag Massif, Saddle & Foothill 3D Builders ----------

function massifHeight(mClass: MountainClass, mStrength: number, scale: number, seedKey = ''): number {
  const jitter = seedKey ? (hash(seedKey + ':hv') - 0.5) * 0.24 : 0
  if (mClass === 'high_peak') return (1.58 + (mStrength - 0.75) * 2.2 + jitter) * scale
  if (mClass === 'peak') return (1.04 + (mStrength - 0.45) * 1.35 + jitter * 0.85) * scale
  return (0.64 + mStrength * 0.72 + jitter * 0.65) * scale
}

type MassifCell = MountainL2Cell | MountainL1Entry

function cellPosition(cell: MassifCell, posOverride: WorldXZ | null): WorldXZ {
  if (posOverride) return posOverride
  if ('tile' in cell) return { x: cell.tile.x, z: cell.tile.z }
  return { x: cell.cx, z: cell.cz }
}

export function buildMountainMassif(
  ctx: AssetContext,
  cell: MassifCell,
  y: number,
  owner: PickOwner,
  tier: RenderTier = 'l12',
  scale = 1,
  posOverride: WorldXZ | null = null,
): void {
  const { put, ao, sampleHeight, isInRiver } = ctx
  const { x, z } = cellPosition(cell, posOverride)
  const seedKey = `${tier}:${cell.key}`
  const h0 = hash(seedKey + 'm0')
  const h1 = hash(seedKey + 'm1')
  const h2 = hash(seedKey + 'm2')
  const h3 = hash(seedKey + 'm3')
  const axis = cell.ridgeAxis || h0 * Math.PI
  const rot = (dx: number, dz: number): [number, number] => rotPoint(x, z, dx * scale, dz * scale, axis)
  const H = massifHeight(cell.mClass, cell.mStrength, scale, seedKey)

  ao(x, y, z, 1.5 * scale, tier)

  const emitCrag = (role: string, dx: number, dz: number, rX: number, h: number, rZ: number, rotOff = 0, yOff = 0): void => {
    const [px, pz] = rot(dx, dz)
    put('crag', role, px, y + yOff, pz, rX * scale, h, rZ * scale, owner, axis + rotOff, 0, null, tier)
  }
  const emitRidge = (role: string, dx: number, dz: number, w: number, h: number, len: number, rotOff = 0, yOff = 0): void => {
    const [px, pz] = rot(dx, dz)
    put('ridge', role, px, y + yOff, pz, w * scale, h, len * scale, owner, axis + rotOff, 0, null, tier)
  }
  const emitSnow = (dx: number, dz: number, sx: number, sy: number, sz: number, rotOff = 0, yBase = 0): void => {
    const [px, pz] = rot(dx, dz)
    put('snow', 'snow', px, y + yBase, pz, sx * scale, sy, sz * scale, owner, axis + rotOff, 0, null, tier)
  }

  emitCrag('slate', 0.0, 0.0, 0.94, H * 0.44, 0.88, h0 * 1.8)
  emitCrag('rock', -0.26, 0.16, 0.56, H * 0.35, 0.52, 0.8 + h1)
  emitCrag('slate', 0.26, -0.18, 0.54, H * 0.37, 0.5, -0.6 + h2)

  const offX = (h1 - 0.5) * 0.2
  const offZ = (h2 - 0.5) * 0.2
  const mainRidgeAngle = (h0 - 0.5) * 0.34
  const mainRidgeH = H * 0.97
  const mainCragH = H * (0.94 + h3 * 0.12)
  emitRidge('granite', offX, offZ, 0.88 + h3 * 0.14, mainRidgeH, 1.02, mainRidgeAngle)
  emitCrag('granite', offX - 0.14, offZ + 0.12, 0.68, mainCragH, 0.64, 0.45 + h1 * 1.4)

  const s1H = H * (0.6 + h1 * 0.18)
  const s2H = H * (0.52 + h2 * 0.2)
  emitCrag('slate', -0.34, -0.22, 0.52, s1H, 0.48, 1.6 + h0)
  emitCrag('granite', 0.34, 0.2, 0.48, s2H, 0.46, 2.7 + h3)
  if (cell.mClass !== 'ridge' || tier === 'l12') {
    emitRidge('slate', 0.16, -0.3, 0.52, H * (0.48 + h3 * 0.16), 0.68, Math.PI * 0.42 + (h2 - 0.5) * 0.35)
  }

  if (cell.mClass === 'high_peak') {
    emitSnow(offX + 0.01, offZ, 0.62, mainRidgeH * 0.38, 0.8, mainRidgeAngle, mainRidgeH * 0.65)
    if (h3 > 0.42) {
      emitSnow(offX - 0.12, offZ + 0.1, 0.46, mainCragH * 0.34, 0.54, 0.5 + h1 * 1.2, mainCragH * 0.68)
    }
  } else if (cell.mClass === 'peak' && cell.mStrength >= 0.74 && h2 > 0.45) {
    emitSnow(offX + 0.01, offZ, 0.44, mainRidgeH * 0.3, 0.56, mainRidgeAngle, mainRidgeH * 0.72)
  }

  const ridgeDirSet = new Set(cell.ridgeNeighbors.map(nb => nb.dir))
  const openDirs: number[] = []
  for (let d = 0; d < 6; d++) {
    if (!ridgeDirSet.has(d)) openDirs.push(d)
  }

  if (tier === 'l12') {
    const pineCount = openDirs.length >= 3 ? 9 : openDirs.length >= 1 ? 7 : 4
    for (let j = 0; j < pineCount; j++) {
      let ang: number
      if (openDirs.length > 0) {
        const dIdx = openDirs[j % openDirs.length]
        const [dq, dr] = DIRECTIONS[dIdx]
        const dirW = world({ q: dq, r: dr })
        ang = Math.atan2(dirW.z, dirW.x) + (hash(`${seedKey}:pa${j}`) - 0.5) * 0.84
      } else {
        ang = axis + j * ((Math.PI * 2) / pineCount) + 0.4
      }
      const innerGully = j % 3 === 0
      const dist =
        (innerGully ? 0.58 + hash(`${seedKey}:pr${j}`) * 0.18 : 0.76 + hash(`${seedKey}:pr${j}`) * 0.26) * scale
      const px = x + Math.cos(ang) * dist
      const pz = z + Math.sin(ang) * dist
      if (isInRiver(px, pz)) continue
      const py = sampleHeight(px, pz)
      if (py < 0.04) continue
      const ledgeLift = innerGully ? (0.1 + hash(`${seedKey}:pl${j}`) * 0.14) * scale : 0
      const treeScale = (0.48 + hash(`${seedKey}:ps${j}`) * 0.3) * scale
      buildTree(ctx, px, py + ledgeLift, pz, treeScale, owner, 'pine', j % 4 === 0 ? 'valley' : 'spruce', tier)
    }
  } else {
    const pineCount = openDirs.length ? Math.min(4, openDirs.length + 1) : 2
    for (let j = 0; j < pineCount; j++) {
      const dIdx = openDirs.length ? openDirs[j % openDirs.length] : j * 2
      const [dq, dr] = DIRECTIONS[dIdx]
      const dirW = world({ q: dq, r: dr })
      const ang = Math.atan2(dirW.z, dirW.x) + (hash(`${seedKey}:l0p${j}`) - 0.5) * 0.55
      const dist = (0.82 + hash(`${seedKey}:l0r${j}`) * 0.24) * scale
      const px = x + Math.cos(ang) * dist
      const pz = z + Math.sin(ang) * dist
      const py = sampleHeight(px, pz)
      if (py < 0.04) continue
      buildTree(ctx, px, py, pz, (0.64 + hash(`${seedKey}:l0s${j}`) * 0.26) * scale, owner, 'pine', 'spruce', tier)
    }
  }
}

export function buildRidgeSaddle(
  ctx: AssetContext,
  cellA: MassifCell,
  cellB: MassifCell,
  yA: number,
  yB: number,
  owner: PickOwner,
  tier: RenderTier = 'l12',
  scale = 1,
  posA: WorldXZ | null = null,
  posB: WorldXZ | null = null,
): void {
  const { put, sampleHeight, isInRiver } = ctx
  const pA = cellPosition(cellA, posA)
  const pB = cellPosition(cellB, posB)
  const dx = pB.x - pA.x
  const dz = pB.z - pA.z
  const dist = Math.hypot(dx, dz)
  if (dist < 0.1) return

  const ux = dx / dist
  const uz = dz / dist
  const nx = -uz
  const nz = ux
  const edgeAngle = Math.atan2(dx, dz)

  const pairSeed = `${tier}:sad:${cellA.key}|${cellB.key}`
  const h0 = hash(pairSeed + '0')
  const h1 = hash(pairSeed + '1')
  const h2 = hash(pairSeed + '2')

  const hA = massifHeight(cellA.mClass, cellA.mStrength, scale, `${tier}:${cellA.key}`)
  const hB = massifHeight(cellB.mClass, cellB.mStrength, scale, `${tier}:${cellB.key}`)
  const saddleH = Math.min(hA, hB) * (0.6 + h0 * 0.16)
  const midX = (pA.x + pB.x) * 0.5 + nx * (h1 - 0.5) * 0.22 * scale
  const midZ = (pA.z + pB.z) * 0.5 + nz * (h1 - 0.5) * 0.22 * scale
  const midY = Math.max(0.05, sampleHeight(midX, midZ))

  const spanLen = (dist * 0.58) / scale
  put(
    'ridge',
    h0 > 0.45 ? 'granite' : 'slate',
    midX,
    midY,
    midZ,
    0.88 * scale,
    saddleH,
    spanLen * scale,
    owner,
    edgeAngle + (h2 - 0.5) * 0.14,
    0,
    null,
    tier,
  )

  const side = h1 > 0.5 ? 1 : -1
  const bx2 = midX + nx * side * 0.28 * scale + ux * (h2 - 0.5) * 0.24 * scale
  const bz2 = midZ + nz * side * 0.28 * scale + uz * (h2 - 0.5) * 0.24 * scale
  const by2 = Math.max(0.05, sampleHeight(bx2, bz2))
  put(
    'crag',
    h0 > 0.45 ? 'slate' : 'granite',
    bx2,
    by2,
    bz2,
    0.56 * scale,
    saddleH * (0.7 + h2 * 0.16),
    0.54 * scale,
    owner,
    edgeAngle + side * 0.9,
    0,
    null,
    tier,
  )

  if (cellA.mClass === 'high_peak' && cellB.mClass === 'high_peak' && h0 > 0.35) {
    put(
      'snow',
      'snow',
      midX,
      midY + saddleH * 0.69,
      midZ,
      0.38 * scale,
      saddleH * 0.32,
      spanLen * 0.54 * scale,
      owner,
      edgeAngle + (h2 - 0.5) * 0.14,
      0,
      null,
      tier,
    )
  }

  if (tier === 'l12') {
    for (const sSign of [-1, 1]) {
      for (let k = 0; k < 2; k++) {
        const fDist = (0.58 + k * 0.18 + hash(`${pairSeed}:fd${sSign}:${k}`) * 0.18) * scale
        const along = (hash(`${pairSeed}:fa${sSign}:${k}`) - 0.5) * 0.44 * scale
        const px = midX + nx * sSign * fDist + ux * along
        const pz = midZ + nz * sSign * fDist + uz * along
        if (isInRiver(px, pz)) continue
        const py = sampleHeight(px, pz)
        if (py < 0.04) continue
        const lift = k === 0 ? 0.08 * scale : 0
        buildTree(ctx, px, py + lift, pz, (0.46 + hash(`${pairSeed}:fs${sSign}:${k}`) * 0.26) * scale, owner, 'pine', 'spruce', tier)
      }
    }
  }
  void yA
  void yB
}

export function buildFoothill(
  ctx: AssetContext,
  cell: MassifCell,
  y: number,
  owner: PickOwner,
  tier: RenderTier = 'l12',
  scale = 1,
): void {
  const { put, ao, sampleHeight, isInRiver } = ctx
  const { x, z } = cellPosition(cell, null)
  const seedKey = `${tier}:fh:${cell.key}`
  const h0 = hash(seedKey + '0')
  const h1 = hash(seedKey + '1')

  let mx = 0
  let mz = 0
  for (const d of cell.mountainDirs || []) {
    const [dq, dr] = DIRECTIONS[d]
    const dw = world({ q: dq, r: dr })
    mx += dw.x
    mz += dw.z
  }
  const mLen = Math.hypot(mx, mz) || 1
  mx /= mLen
  mz /= mLen
  const mAngle = Math.atan2(mx, mz)

  if (tier === 'l0') {
    const ox = x + mx * 0.55 * scale
    const oz = z + mz * 0.55 * scale
    const oy = sampleHeight(ox, oz)
    if (oy > 0.04) {
      put('crag', 'slate', ox, oy, oz, 0.62 * scale, 0.48 * scale, 0.58 * scale, owner, mAngle + h0, 0, null, tier)
    }
    for (let j = 0; j < 5; j++) {
      const ang = mAngle + Math.PI + (j - 2) * 0.78 + (hash(`${seedKey}:la${j}`) - 0.5) * 0.35
      const r = (0.34 + hash(`${seedKey}:lr${j}`) * 0.54) * scale
      const px = x + Math.cos(ang) * r
      const pz = z + Math.sin(ang) * r
      const py = sampleHeight(px, pz)
      if (py < 0.04) continue
      buildTree(ctx, px, py, pz, (0.58 + hash(`${seedKey}:ls${j}`) * 0.26) * scale, owner, 'pine', j % 3 === 0 ? 'valley' : 'spruce', tier)
    }
    return
  }

  const outcropCount = cell.mountainDirs.length >= 2 ? 3 : 2
  for (let i = 0; i < outcropCount; i++) {
    const spread = (i - (outcropCount - 1) * 0.5) * 0.55 + (hash(`${seedKey}:oa${i}`) - 0.5) * 0.32
    const c = Math.cos(spread)
    const s = Math.sin(spread)
    const dx = mx * c - mz * s
    const dz = mx * s + mz * c
    const dist = (0.34 + hash(`${seedKey}:od${i}`) * 0.28) * scale
    const ox = x + dx * dist
    const oz = z + dz * dist
    if (isInRiver(ox, oz)) continue
    const oy = sampleHeight(ox, oz)
    if (oy < 0.04) continue
    const oh = (0.28 + cell.mStrength * 0.4 + hash(`${seedKey}:oh${i}`) * 0.16) * scale
    const orad = (0.34 + hash(`${seedKey}:or${i}`) * 0.18) * scale
    put('crag', i === 0 ? 'granite' : 'slate', ox, oy, oz, orad, oh, orad * 0.92, owner, mAngle + i * 1.4 + h0, 0, null, tier)
  }

  ao(x, y, z, 1.32 * scale, tier)
  const treeCount = 7 + Math.floor(h1 * 3)
  for (let j = 0; j < treeCount; j++) {
    const a = h0 * 6.28 + j * 2.39996 + (hash(`${seedKey}:ta${j}`) - 0.5) * 0.44
    const r = (0.12 + Math.sqrt((j + 0.35) / treeCount) * 0.66) * scale
    const px = x + Math.cos(a) * r
    const pz = z + Math.sin(a) * r
    if (isInRiver(px, pz)) continue
    const py = sampleHeight(px, pz)
    if (py < 0.04) continue

    const towardMtn = ((px - x) * mx + (pz - z) * mz) / (scale || 1)
    const spHash = hash(`${seedKey}:sp${j}`)
    let species = 'pine'
    let tint = 'spruce'
    if (towardMtn < -0.2 && spHash > 0.52) {
      species = 'oak'
      tint = spHash > 0.78 ? 'canopyLight' : 'leaf'
    } else {
      species = 'pine'
      tint = towardMtn > 0.0 || spHash < 0.68 ? 'spruce' : 'valley'
    }
    const sc = (0.56 + hash(`${seedKey}:ts${j}`) * 0.28) * scale
    buildTree(ctx, px, py, pz, sc, owner, species, tint, tier)
  }
}

export function buildDetailMountainRanges(
  ctx: AssetContext,
  mField: MountainField,
  tileHeights: ReadonlyMap<string, number>,
  ownerForTile: (t: FineTile) => PickOwner,
): void {
  for (const cell of mField.l2.values()) {
    const t = cell.tile
    const y = tileHeights.get(cell.key) ?? 0.14
    const owner = ownerForTile(t)

    if (MOUNTAIN_CLASSES.has(cell.mClass)) {
      buildMountainMassif(ctx, cell, y, owner, 'l12', 1.0)
      for (const nb of cell.ridgeNeighbors) {
        if (cell.key < nb.key) {
          const nbCell = mField.l2.get(nb.key)
          if (!nbCell) continue
          const yB = tileHeights.get(nb.key) ?? y
          buildRidgeSaddle(ctx, cell, nbCell, y, yB, owner, 'l12', 1.0)
        }
      }
    } else if (cell.mClass === 'foothill') {
      buildFoothill(ctx, cell, y, owner, 'l12', 1.0)
    }
  }
}

export function buildWorldCordilleras(
  ctx: AssetContext,
  mField: MountainField,
  terrainSampler: TerrainSampler,
  l0OwnerFor: (c: CoarseCell) => PickOwner,
): void {
  const L0_SCALE = 1.82
  for (const entry of mField.l1.values()) {
    const c = entry.cell
    const owner = l0OwnerFor(c)
    const cy = terrainSampler.sampleHeight(entry.cx, entry.cz)
    if (cy < 0.02) continue

    if (MOUNTAIN_CLASSES.has(entry.mClass)) {
      buildMountainMassif(ctx, entry, cy, owner, 'l0', L0_SCALE, { x: entry.cx, z: entry.cz })
      for (const nb of entry.ridgeNeighbors) {
        if (entry.key < nb.key) {
          const nbEntry = mField.l1.get(nb.key)
          if (!nbEntry) continue
          const nbY = terrainSampler.sampleHeight(nbEntry.cx, nbEntry.cz)
          buildRidgeSaddle(
            ctx,
            entry,
            nbEntry,
            cy,
            Math.max(0.04, nbY),
            owner,
            'l0',
            L0_SCALE,
            { x: entry.cx, z: entry.cz },
            { x: nbEntry.cx, z: nbEntry.cz },
          )
        }
      }
    } else if (entry.mClass === 'foothill') {
      buildFoothill(ctx, entry, cy, owner, 'l0', L0_SCALE * 0.92)
    }
  }
}
