// Data-driven geological orogeny, mountain ridge spines, and slope-aware timberline conifer forests.
// Mountains rise organically out of the continuous Delaunay geomorphology mesh; this module
// computes the tectonic spine field and populates alpine/foothill conifer belts respecting
// terrain elevation, slope, and lakes.
import { buildTree } from './assets.js'
import { DIRECTIONS, RADIUS, hash, key } from './layout.js'
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

export function continentOrogeny(c: PlacedContinent): number {
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

  // Project L2 mountain field onto L1 coarse cells for World-zoom forest & biome cues
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

/**
 * Populate slope-checked foothill & timberline conifer belts on mountain flanks
 * (never floating on steep granite cliffs or submerged in alpine lakes).
 */
export function buildAlpineConiferBelts(
  ctx: AssetContext,
  mField: MountainField,
  ownerForTile: (t: FineTile) => PickOwner,
  tier: RenderTier = 'l12',
): void {
  const { ao, sampleHeight, sampleSlope, isInWater } = ctx

  for (const cell of mField.l2.values()) {
    const t = cell.tile
    const owner = ownerForTile(t)
    const isFoothill = cell.mClass === 'foothill'
    const seedKey = `${tier}:af:${cell.key}`
    const h0 = hash(seedKey + '0')
    const h1 = hash(seedKey + '1')

    const count = isFoothill ? 6 + Math.floor(h1 * 3) : 4 + Math.floor(h1 * 2)
    let placed = 0
    let sumX = 0
    let sumZ = 0
    let sumY = 0

    for (let j = 0; j < count; j++) {
      const a = h0 * 6.28 + j * 2.39996 + (hash(`${seedKey}:ta${j}`) - 0.5) * 0.48
      const r = (0.14 + Math.sqrt((j + 0.35) / count) * 0.72) * (isFoothill ? 1.0 : 0.92)
      const px = t.x + Math.cos(a) * r
      const pz = t.z + Math.sin(a) * r
      if (isInWater(px, pz)) continue
      const py = sampleHeight(px, pz)
      // Stay below high alpine snowline and above coastal beach
      if (py < -0.06 || py > 1.38) continue
      const sl = sampleSlope(px, pz)
      if (sl > 0.62) continue

      const spHash = hash(`${seedKey}:sp${j}`)
      const isOak = isFoothill && py < 0.42 && spHash > 0.66
      const species = isOak ? 'oak' : 'pine'
      const tint = isOak ? (spHash > 0.84 ? 'canopyLight' : 'leaf') : spHash < 0.68 ? 'spruce' : 'valley'
      // Timberline dwarfing: conifers get slightly more compact higher up the slope
      const altScale = 1 - smoothstep(0.65, 1.38, py) * 0.32
      const sc = (0.54 + hash(`${seedKey}:ts${j}`) * 0.28) * altScale
      buildTree(ctx, px, py, pz, sc, owner, species, tint, tier, spHash * Math.PI * 2)
      placed++
      sumX += px
      sumZ += pz
      sumY += py
    }
    if (placed >= 2) {
      ao(sumX / placed, sumY / placed, sumZ / placed, isFoothill ? 1.15 : 0.85, tier)
    }
  }
}
