// Procedural high-craft architectural miniatures & sub-hex micro-relief for the Fleet diorama.
// Every builder emits instanced primitives into the renderer's batch tables (20–40 parts per structure)
// plus soft radial contact-AO discs so structures sit grounded on the hex terrain.
import * as THREE from 'three'
import { DIRECTIONS, hash, key, world } from './layout.js'
import { fbm2 } from './terrainMesh.js'
import type {
  AreaInput,
  AssetContext,
  AtlasLayout,
  BiomeId,
  CoarseCell,
  FineTile,
  MountainClass,
  MountainField,
  PickOwner,
  PlacedCity,
  RenderTier,
  SeaLane,
  TerrainSampler,
  WorldXZ,
} from './types.js'

function rotPoint(x: number, z: number, dx: number, dz: number, angle: number): [number, number] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [x + dx * c + dz * s, z - dx * s + dz * c]
}

export function buildTree(
  ctx: AssetContext,
  x: number,
  y: number,
  z: number,
  scale = 1,
  owner: PickOwner | null = null,
  species = 'oak',
  tint = 'leaf',
  tier: RenderTier = 'all',
  rot = 0,
): void {
  const { box } = ctx
  if (species === 'cypress') {
    box('trunk', x, y + scale * 0.1, z, 0.08 * scale, 0.2 * scale, 0.08 * scale, owner, 0, rot, tier)
    box('spruce', x, y + scale * 0.32, z, 0.23 * scale, 0.28 * scale, 0.23 * scale, owner, 0, rot, tier)
    box(tint, x, y + scale * 0.56, z, 0.17 * scale, 0.28 * scale, 0.17 * scale, owner, 0, rot, tier)
    box('canopyLight', x, y + scale * 0.77, z, 0.1 * scale, 0.18 * scale, 0.1 * scale, owner, 0, rot, tier)
  } else if (species === 'pine' || species === 'spruce') {
    const baseRole = 'spruce'
    const midRole = tint === 'spruce' ? 'leaf' : tint
    const topRole = tint === 'spruce' ? 'valley' : 'canopyLight'
    box('trunk', x, y + scale * 0.11, z, 0.09 * scale, 0.22 * scale, 0.09 * scale, owner, 0, rot, tier)
    box(baseRole, x, y + scale * 0.28, z, 0.4 * scale, 0.2 * scale, 0.4 * scale, owner, 0, rot, tier)
    box(midRole, x, y + scale * 0.46, z, 0.28 * scale, 0.21 * scale, 0.28 * scale, owner, 0, rot, tier)
    box(topRole, x, y + scale * 0.63, z, 0.16 * scale, 0.19 * scale, 0.16 * scale, owner, 0, rot, tier)
  } else if (species === 'willow') {
    box('trunk', x, y + scale * 0.11, z, 0.09 * scale, 0.22 * scale, 0.09 * scale, owner, 0, rot, tier)
    box('valley', x, y + scale * 0.28, z, 0.5 * scale, 0.17 * scale, 0.5 * scale, owner, 0, rot, tier)
    box('leaf', x - 0.04 * scale, y + scale * 0.41, z + 0.04 * scale, 0.41 * scale, 0.18 * scale, 0.41 * scale, owner, 0, rot, tier)
    box('canopyLight', x + 0.05 * scale, y + scale * 0.51, z - 0.05 * scale, 0.28 * scale, 0.14 * scale, 0.28 * scale, owner, 0, rot, tier)
  } else {
    const shadeRole = tint === 'meadow' ? 'leaf' : 'valley'
    const crownRole = tint === 'meadow' ? 'meadow' : 'canopyLight'
    box('trunk', x, y + scale * 0.12, z, 0.095 * scale, 0.24 * scale, 0.095 * scale, owner, 0, rot, tier)
    box(shadeRole, x, y + scale * 0.31, z, 0.45 * scale, 0.18 * scale, 0.45 * scale, owner, 0, rot, tier)
    box(tint, x - 0.055 * scale, y + scale * 0.44, z + 0.05 * scale, 0.37 * scale, 0.2 * scale, 0.36 * scale, owner, 0, rot, tier)
    box(crownRole, x + 0.055 * scale, y + scale * 0.55, z - 0.05 * scale, 0.29 * scale, 0.16 * scale, 0.28 * scale, owner, 0, rot, tier)
  }
}

function pickBiomeTree(biome: BiomeId, hVal: number, coniferBias = 0): { species: string; tint: string } {
  const c = Math.max(0, Math.min(1, coniferBias))
  if (biome === 'nordic') {
    if (hVal < 0.72 + c * 0.18) return { species: 'pine', tint: hVal < 0.42 ? 'spruce' : 'valley' }
    return { species: 'oak', tint: 'leaf' }
  }
  if (biome === 'savanna') {
    if (hVal < 0.18 + c * 0.42) return { species: 'pine', tint: 'valley' }
    if (hVal < 0.28) return { species: 'cypress', tint: 'leaf' }
    return { species: 'oak', tint: hVal > 0.68 ? 'canopyLight' : 'leaf' }
  }
  if (biome === 'temperate') {
    if (hVal < 0.28 + c * 0.46) return { species: 'pine', tint: hVal < 0.18 + c * 0.22 ? 'spruce' : 'leaf' }
    return { species: 'oak', tint: hVal > 0.72 ? 'canopyLight' : 'leaf' }
  }
  if (hVal < 0.16 + c * 0.48) return { species: 'pine', tint: 'spruce' }
  if (hVal < 0.34) return { species: 'cypress', tint: 'leaf' }
  return { species: 'oak', tint: hVal > 0.7 ? 'canopyLight' : 'leaf' }
}

function buildGroveCluster(
  ctx: AssetContext,
  cx: number,
  cz: number,
  count: number,
  spread: number,
  scaleMin: number,
  scaleMax: number,
  owner: PickOwner,
  biome: BiomeId,
  coniferBias: number,
  tier: RenderTier,
  seedKey: string,
): number {
  const { ao, sampleHeight, isInRiver } = ctx
  const cy = sampleHeight(cx, cz)
  if (cy < 0.045 || isInRiver(cx, cz)) return 0

  let placed = 0
  const baseAng = hash(seedKey + ':ga') * Math.PI * 2
  for (let i = 0; i < count; i++) {
    const a = baseAng + (i / count) * Math.PI * 2 + (hash(seedKey + ':a' + i) - 0.5) * 0.62
    const r = i === 0 ? hash(seedKey + ':r0') * spread * 0.28 : spread * (0.58 + hash(seedKey + ':r' + i) * 0.42)
    const px = cx + Math.cos(a) * r
    const pz = cz + Math.sin(a) * r
    if (isInRiver(px, pz)) continue
    const py = sampleHeight(px, pz)
    if (py < 0.045) continue
    const { species, tint } = pickBiomeTree(biome, hash(seedKey + ':sp' + i), coniferBias)
    const sc = scaleMin + hash(seedKey + ':sc' + i) * (scaleMax - scaleMin)
    const rot = hash(seedKey + ':rt' + i) * 0.8
    buildTree(ctx, px, py, pz, sc, owner, species, tint, tier, rot)
    placed++
  }
  if (placed > 0) {
    ao(cx, cy, cz, Math.max(0.75, spread * 2.45 + scaleMax * 0.45), tier)
  }
  return placed
}

// 1. Orchestrator Citadel
export function buildCitadel(ctx: AssetContext, n: PlacedCity, x: number, y: number, z: number, tier: RenderTier = 'all'): void {
  const { box, cyl, put, ao, hostColor, halo } = ctx
  ao(x, y, z, 1.85, tier)

  box('rock', x, y + 0.04, z, 1.34, 0.08, 1.22, n, 0, 0, tier)
  box('trim', x, y + 0.1, z, 1.22, 0.08, 1.1, n, 0, 0, tier)
  box('trim', x, y + 0.24, z + 0.46, 1.12, 0.22, 0.09, n, 0, 0, tier)
  box('trim', x, y + 0.24, z - 0.46, 1.12, 0.22, 0.09, n, 0, 0, tier)
  box('trim', x - 0.52, y + 0.24, z, 0.09, 0.22, 0.96, n, 0, 0, tier)
  box('trim', x + 0.52, y + 0.24, z, 0.09, 0.22, 0.96, n, 0, 0, tier)

  box('wall', x, y + 0.52, z - 0.04, 0.92, 0.78, 0.76, n, 0, 0, tier)
  box('trim', x, y + 0.93, z - 0.04, 0.98, 0.06, 0.82, n, 0, 0, tier)
  box('wall', x, y + 1.18, z - 0.04, 0.78, 0.46, 0.64, n, 0, 0, tier)

  const roofRole = n.state === 'working' ? 'active' : 'roof'
  for (let k = 0; k < 5; k++) {
    box(roofRole, x, y + 1.44 + k * 0.065, z - 0.04, 0.88 - k * 0.14, 0.065, 0.74 - k * 0.04, n, 0, 0, tier)
  }
  box('copper', x, y + 1.78, z - 0.04, 0.22, 0.045, 0.58, n, 0, 0, tier)

  const turretCoords: ReadonlyArray<[number, number]> = [
    [-0.46, -0.38],
    [0.46, -0.38],
    [-0.46, 0.32],
    [0.46, 0.32],
  ]
  for (const [idx, [tx, tz]] of turretCoords.entries()) {
    const tall = idx < 2 ? 1.58 : 1.32
    box('wall', x + tx, y + 0.12 + tall / 2, z + tz, 0.26, tall, 0.26, n, 0, 0, tier)
    box('trim', x + tx, y + 0.14 + tall, z + tz, 0.31, 0.06, 0.31, n, 0, 0, tier)
    for (const [mx, mz] of [
      [-0.1, -0.1],
      [0.1, -0.1],
      [-0.1, 0.1],
      [0.1, 0.1],
    ] as const) {
      box('white', x + tx + mx, y + 0.21 + tall, z + tz + mz, 0.075, 0.1, 0.075, n, 0, 0, tier)
    }
    if (idx < 2) {
      box('copper', x + tx, y + 0.27 + tall, z + tz, 0.24, 0.09, 0.24, n, 0, 0, tier)
      box('copper', x + tx, y + 0.36 + tall, z + tz, 0.16, 0.09, 0.16, n, 0, 0, tier)
      box('copper', x + tx, y + 0.44 + tall, z + tz, 0.09, 0.08, 0.09, n, 0, 0, tier)
      box('amber', x + tx, y + 0.51 + tall, z + tz, 0.05, 0.06, 0.05, n, 1.0, 0, tier)
    }
  }

  box('trim', x, y + 0.34, z + 0.39, 0.34, 0.44, 0.14, n, 0, 0, tier)
  box('trunk', x, y + 0.28, z + 0.45, 0.2, 0.32, 0.05, n, 0, 0, tier)
  box('white', x, y + 0.48, z + 0.45, 0.26, 0.06, 0.07, n, 0, 0, tier)
  for (let k = 0; k < 3; k++) {
    box('wall', x, y + 0.03 + k * 0.045, z + 0.56 + k * 0.09, 0.46 - k * 0.04, 0.045, 0.14, n, 0, 0, tier)
  }

  const glow = n.state === 'working' ? 2.2 : 1.1
  for (const dx of [-0.24, 0.24]) {
    box('amber', x + dx, y + 0.72, z + 0.35, 0.11, 0.22, 0.03, n, glow, 0, tier)
    box('trim', x + dx, y + 0.59, z + 0.36, 0.15, 0.035, 0.06, n, 0, 0, tier)
    box('amber', x + dx, y + 1.18, z + 0.29, 0.09, 0.18, 0.03, n, glow * 0.9, 0, tier)
  }
  for (const dx of [-0.21, 0.21]) {
    box('metal', x + dx, y + 0.38, z + 0.48, 0.04, 0.04, 0.07, n, 0, 0, tier)
    box('amber', x + dx, y + 0.42, z + 0.5, 0.065, 0.09, 0.065, n, 2.1, 0, tier)
  }

  const hostCol = hostColor(n.origin || n.host)
  cyl('metal', x + 0.46, y + 2.22, z - 0.38, 0.022, 0.96, n, 0, tier)
  box('amber', x + 0.46, y + 2.72, z - 0.38, 0.06, 0.06, 0.06, n, 1.2, 0, tier)
  put('box', 'host', x + 0.63, y + 2.52, z - 0.38, 0.3, 0.2, 0.028, n, 0.08, 0.25, hostCol, tier)
  put('box', 'host', x + 0.84, y + 2.49, z - 0.35, 0.2, 0.15, 0.024, n, -0.14, 0.25, hostCol, tier)

  if (n.state === 'working') {
    const cx = x - 0.26
    const cz = z - 0.24
    box('rock', cx, y + 1.66, cz, 0.16, 0.36, 0.16, n, 0, 0, tier)
    box('metal', cx, y + 1.86, cz, 0.2, 0.05, 0.2, n, 0, 0, tier)
    box('amber', cx, y + 1.89, cz, 0.1, 0.035, 0.1, n, 2.2, 0, tier)
    for (let k = 0; k < 3; k++) {
      const item = put(
        'box',
        'smoke',
        cx + k * 0.045,
        y + 2.02 + k * 0.22,
        cz,
        0.14 + k * 0.04,
        0.13 + k * 0.03,
        0.14 + k * 0.04,
        n,
        k * 0.5,
        0,
        null,
        tier,
      )
      ctx.smokes.push({ item, n, base: item.y, baseX: cx, k, drift: 0.045, rise: 0.48 })
    }
    halo(n, x, y, z, false)
  }
}

// 2. Working Forge / Workshop
export function buildForge(ctx: AssetContext, n: PlacedCity, x: number, y: number, z: number, tier: RenderTier = 'all'): void {
  const { box, cyl, put, ao, smokes, halo } = ctx
  ao(x, y, z, 1.68, tier)

  box('rock', x, y + 0.04, z, 1.18, 0.08, 0.98, n, 0, 0, tier)
  box('trim', x, y + 0.095, z, 1.06, 0.06, 0.88, n, 0, 0, tier)

  const w = 0.88
  const d = 0.72
  const h = 0.82
  box('wall', x - 0.06, y + 0.12 + h / 2, z, w, h, d, n, 0, 0, tier)
  for (const dx of [-w / 2, 0, w / 2]) {
    for (const dz of [-d / 2, d / 2]) {
      box('trunk', x - 0.06 + dx, y + 0.12 + h / 2, z + dz, 0.055, h + 0.02, 0.055, n, 0, 0, tier)
    }
  }
  box('trunk', x - 0.06, y + 0.52, z + d / 2 + 0.01, w + 0.04, 0.048, 0.04, n, 0, 0, tier)
  box('trunk', x - 0.06, y + 0.52, z - d / 2 - 0.01, w + 0.04, 0.048, 0.04, n, 0, 0, tier)

  for (let k = 0; k < 6; k++) {
    box('active', x - 0.06, y + 0.96 + k * 0.068, z, w + 0.24 - k * 0.15, 0.068, d + 0.22, n, 0, 0, tier)
  }
  box('trunk', x - 0.06, y + 1.38, z, 0.12, 0.05, d + 0.26, n, 0, 0, tier)

  for (const dx of [-0.24, 0.2]) {
    box('amber', x - 0.06 + dx, y + 0.66, z + d / 2 + 0.016, 0.16, 0.22, 0.028, n, 2.6, 0, tier)
    box('trunk', x - 0.06 + dx, y + 0.66, z + d / 2 + 0.028, 0.025, 0.22, 0.02, n, 0, 0, tier)
    box('trim', x - 0.06 + dx, y + 0.53, z + d / 2 + 0.03, 0.2, 0.035, 0.06, n, 0, 0, tier)
  }
  box('trunk', x - 0.06, y + 0.3, z + d / 2 + 0.018, 0.18, 0.36, 0.04, n, 0, 0, tier)
  box('amber', x - 0.06, y + 0.34, z + d / 2 + 0.032, 0.11, 0.15, 0.02, n, 2.2, 0, tier)

  const fx = x + 0.48
  const fz = z + 0.04
  box('roof', fx, y + 0.62, fz, 0.36, 0.05, 0.56, n, 0, 0, tier)
  for (const dz of [-0.22, 0.22]) {
    box('trunk', fx + 0.13, y + 0.35, fz + dz, 0.045, 0.52, 0.045, n, 0, 0, tier)
  }
  box('rock', fx - 0.02, y + 0.22, fz - 0.04, 0.26, 0.22, 0.28, n, 0, 0, tier)
  box('amber', fx + 0.02, y + 0.34, fz - 0.04, 0.18, 0.07, 0.2, n, 3.4, 0, tier)
  box('trunk', fx + 0.08, y + 0.16, fz + 0.16, 0.11, 0.12, 0.11, n, 0, 0, tier)
  box('metal', fx + 0.08, y + 0.24, fz + 0.16, 0.14, 0.06, 0.08, n, 0, 0.3, tier)

  const cx = x + 0.34
  const cz = z - 0.24
  box('rock', cx, y + 0.62, cz, 0.3, 1.05, 0.3, n, 0, 0, tier)
  box('active', cx, y + 1.48, cz, 0.24, 0.85, 0.24, n, 0, 0, tier)
  box('metal', cx, y + 1.94, cz, 0.32, 0.1, 0.32, n, 0, 0, tier)
  box('amber', cx, y + 2.0, cz, 0.16, 0.05, 0.16, n, 2.6, 0, tier)
  for (let k = 0; k < 5; k++) {
    const item = put(
      'box',
      'smoke',
      cx + k * 0.075,
      y + 2.18 + k * 0.27,
      cz,
      0.24 + k * 0.055,
      0.22 + k * 0.035,
      0.24 + k * 0.055,
      n,
      k * 0.4,
      0,
      null,
      tier,
    )
    smokes.push({ item, n, base: item.y, baseX: cx, k, drift: 0.06, rise: 0.7 })
  }

  box('trim', x - 0.56, y + 0.16, z + 0.18, 0.22, 0.18, 0.22, n, 0, 0.2, tier)
  box('trunk', x - 0.54, y + 0.32, z + 0.16, 0.17, 0.15, 0.17, n, 0, -0.3, tier)
  cyl('metal', x + 0.58, y + 0.34, z + 0.4, 0.022, 0.58, n, 0, tier)
  box('amber', x + 0.58, y + 0.65, z + 0.4, 0.11, 0.13, 0.11, n, 2.4, 0, tier)
  box('roof', x + 0.58, y + 0.74, z + 0.4, 0.16, 0.04, 0.16, n, 0, 0, tier)

  halo(n, x, y, z, false)
}

// 3. Asking Lighthouse (~2.24u total height)
export function buildLighthouse(ctx: AssetContext, n: PlacedCity, x: number, y: number, z: number, tier: RenderTier = 'all'): void {
  const { box, cyl, put, ao, root, textures, signals, halo } = ctx
  ao(x, y, z, 1.38, tier)

  put('hex', 'rock', x, y + 0.04, z, 0.54, 0.08, 0.54, n, 0, 0, null, tier)
  put('hex', 'trim', x, y + 0.11, z, 0.45, 0.06, 0.45, n, 0, 0, null, tier)

  const cx = x - 0.3
  const cz = z + 0.14
  box('wall', cx, y + 0.265, cz, 0.34, 0.25, 0.3, n, 0, 0, tier)
  box('roof', cx, y + 0.415, cz, 0.4, 0.05, 0.36, n, 0, 0, tier)
  box('roof', cx, y + 0.46, cz, 0.26, 0.04, 0.28, n, 0, 0, tier)
  box('amber', cx, y + 0.27, cz + 0.155, 0.08, 0.1, 0.02, n, 2.2, 0, tier)

  const bands = ['rock', 'white', 'active', 'white']
  for (let k = 0; k < 4; k++) {
    const r = 0.26 - k * 0.0233
    const cy = y + 0.14 + (k + 0.5) * 0.355
    cyl(bands[k], x, cy, z, r, 0.365, n, 0, tier)
    if (k === 0 || k === 2) {
      cyl('metal', x, cy + 0.175, z, r + 0.015, 0.032, n, 0, tier)
    }
    if (k === 1 || k === 3) {
      box('amber', x, cy, z + r + 0.008, 0.042, 0.1, 0.02, n, 1.9, 0, tier)
    }
  }

  cyl('trim', x, y + 1.545, z, 0.23, 0.048, n, 0, tier)
  cyl('metal', x, y + 1.585, z, 0.29, 0.06, n, 0, tier)
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4
    box('metal', x + Math.cos(a) * 0.265, y + 1.66, z + Math.sin(a) * 0.265, 0.022, 0.11, 0.022, n, 0, a, tier)
  }

  cyl('amber', x, y + 1.76, z, 0.19, 0.26, n, 3.2, tier)
  put('dome', 'amber', x, y + 1.88, z, 0.195, 0.12, 0.195, n, 0, 3.2, null, tier)
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3
    box('white', x + Math.cos(a) * 0.195, y + 1.76, z + Math.sin(a) * 0.195, 0.024, 0.28, 0.024, n, 0, a, tier)
  }

  box('copper', x, y + 1.96, z, 0.3, 0.065, 0.3, n, 0, 0, tier)
  box('copper', x, y + 2.025, z, 0.22, 0.065, 0.22, n, 0, 0, tier)
  box('copper', x, y + 2.085, z, 0.13, 0.055, 0.13, n, 0, 0, tier)
  cyl('metal', x, y + 2.165, z, 0.016, 0.13, n, 0, tier)
  box('amber', x, y + 2.24, z, 0.048, 0.048, 0.048, n, 2.5, 0, tier)

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.42, 0.024, 8, 48),
    new THREE.MeshBasicMaterial({ color: '#ffe8a8', transparent: true, opacity: 0.82, depthWrite: false }),
  )
  ring.rotation.x = Math.PI / 2
  ring.position.set(x, y + 1.78, z)
  root.add(ring)
  signals.push({ type: 'ring', m: ring, n })

  const lanternGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: textures.lanternGlow,
      color: '#ffd980',
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  lanternGlow.position.set(x, y + 1.8, z)
  lanternGlow.scale.set(1.45, 1.45, 1)
  root.add(lanternGlow)
  signals.push({ type: 'lantern-glow', m: lanternGlow, n })

  const pivot = new THREE.Group()
  pivot.position.set(x, y + 1.78, z)
  root.add(pivot)
  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(0.54, 3.1, 24, 1, true),
    new THREE.MeshBasicMaterial({
      map: textures.beam,
      color: '#ffe49c',
      transparent: true,
      opacity: 0.56,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  )
  beam.rotation.z = Math.PI / 2
  beam.position.x = 1.55
  pivot.add(beam)
  signals.push({ type: 'beam', m: pivot, mesh: beam, n })

  const ground = new THREE.Mesh(
    new THREE.RingGeometry(0.78, 0.88, 48),
    new THREE.MeshBasicMaterial({ color: '#f5be4e', transparent: true, opacity: 0.72, depthWrite: false }),
  )
  ground.rotation.x = -Math.PI / 2
  ground.position.set(x, y + 0.08, z)
  root.add(ground)
  signals.push({ type: 'ask-ring', m: ground, n })
  halo(n, x, y, z, true)
}

// 4. Tapestry Observatory
export function buildObservatory(
  ctx: AssetContext,
  n: PlacedCity,
  ox: number,
  y: number,
  oz: number,
  seed: number,
  tier: RenderTier = 'all',
): void {
  const { box, cyl, put, ao } = ctx
  ao(ox, y, oz, 0.92, tier)

  put('hex', 'rock', ox, y + 0.04, oz, 0.44, 0.08, 0.44, n, 0, 0, null, tier)
  put('hex', 'wall', ox, y + 0.3, oz, 0.36, 0.46, 0.36, n, 0, 0, null, tier)
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + Math.PI / 4
    box('trim', ox + Math.cos(a) * 0.33, y + 0.26, oz + Math.sin(a) * 0.33, 0.08, 0.38, 0.08, n, 0, a, tier)
  }
  cyl('copper', ox, y + 0.56, oz, 0.38, 0.07, n, 0, tier)
  const domeRole = seed > 0.45 ? 'dome' : 'copper'
  put('dome', domeRole, ox, y + 0.6, oz, 0.34, 0.34, 0.34, n, 0, 0, null, tier)
  box('metal', ox, y + 0.78, oz, 0.05, 0.28, 0.42, n, 0, 0.3, tier)
  box('metal', ox + 0.08, y + 0.84, oz + 0.16, 0.07, 0.07, 0.28, n, -0.45, 0.3, tier)
  box('amber', ox + 0.11, y + 0.9, oz + 0.27, 0.055, 0.055, 0.02, n, 1.4, 0.3, tier)
  box('amber', ox, y + 0.32, oz + 0.34, 0.11, 0.16, 0.025, n, 1.3, 0, tier)
  box('trim', ox, y + 0.07, oz + 0.44, 0.2, 0.06, 0.12, n, 0, 0, tier)
  box('trim', ox, y + 0.035, oz + 0.51, 0.24, 0.04, 0.12, n, 0, 0, tier)
}

// 5. Resting Cottage
export function buildCottage(
  ctx: AssetContext,
  n: PlacedCity,
  x: number,
  y: number,
  z: number,
  seed: number,
  tier: RenderTier = 'l12',
): void {
  const { box, cyl, ao } = ctx
  const angle = (Math.floor(seed * 6) * Math.PI) / 3
  const rot = (dx: number, dz: number): [number, number] => rotPoint(x, z, dx, dz, angle)
  ao(x, y, z, 1.36, tier)

  const w = 0.78
  const d = 0.62
  const h = 0.58
  box('rock', x, y + 0.035, z, w + 0.2, 0.07, d + 0.18, n, 0, angle, tier)
  box('trim', x, y + 0.08, z, w + 0.12, 0.05, d + 0.1, n, 0, angle, tier)
  box('wall', x, y + 0.1 + h / 2, z, w, h, d, n, 0, angle, tier)

  for (const dx of [-w / 2, w / 2]) {
    for (const dz of [-d / 2, d / 2]) {
      const [px, pz] = rot(dx, dz)
      box('trunk', px, y + 0.1 + h / 2, pz, 0.048, h, 0.048, n, 0, angle, tier)
    }
  }

  const pitch = 0.055 + hash(n.id + 'pitch') * 0.025
  for (let k = 0; k < 5; k++) {
    box('roof', x, y + h + 0.12 + k * pitch, z, w + 0.18 - k * 0.14, 0.065, d + 0.16, n, 0, angle, tier)
  }
  box('copper', x, y + h + 0.13 + 5 * pitch, z, 0.11, 0.045, d + 0.18, n, 0, angle, tier)

  const [dmX, dmZ] = rot(0.14, d * 0.24)
  box('wall', dmX, y + h + 0.2, dmZ, 0.22, 0.18, 0.22, n, 0, angle, tier)
  box('roof', dmX, y + h + 0.31, dmZ, 0.26, 0.05, 0.26, n, 0, angle, tier)
  const [dmWX, dmWZ] = rot(0.14, d * 0.35 + 0.01)
  box('amber', dmWX, y + h + 0.2, dmWZ, 0.09, 0.1, 0.02, n, 0.95, angle, tier)

  const [chX, chZ] = rot(-0.24, -0.16)
  box('rock', chX, y + h + 0.28, chZ, 0.15, 0.38, 0.15, n, 0, angle, tier)
  box('trim', chX, y + h + 0.48, chZ, 0.18, 0.045, 0.18, n, 0, angle, tier)

  for (const dx of [-w * 0.27, w * 0.27]) {
    const [wx, wz] = rot(dx, d / 2 + 0.014)
    box('amber', wx, y + h * 0.62, wz, 0.13, 0.17, 0.024, n, 0.85, angle, tier)
    const [sx, sz] = rot(dx, d / 2 + 0.032)
    box('trim', sx, y + h * 0.62 - 0.1, sz, 0.17, 0.035, 0.055, n, 0, angle, tier)
    box('leaf', sx, y + h * 0.62 - 0.07, sz, 0.14, 0.035, 0.04, n, 0, angle, tier)
  }
  const [doorX, doorZ] = rot(0, d / 2 + 0.018)
  box('trunk', doorX, y + 0.24, doorZ, 0.14, 0.3, 0.04, n, 0, angle, tier)
  const [hoodX, hoodZ] = rot(0, d / 2 + 0.06)
  box('roof', hoodX, y + 0.41, hoodZ, 0.22, 0.04, 0.12, n, 0, angle, tier)

  for (const dx of [-0.36, -0.18, 0.18, 0.36]) {
    const [fx, fz] = rot(dx, d / 2 + 0.24)
    box('trim', fx, y + 0.1, fz, 0.035, 0.14, 0.035, n, 0, angle, tier)
  }
  for (const dx of [-0.27, 0.27]) {
    const [rx, rz] = rot(dx, d / 2 + 0.24)
    box('trim', rx, y + 0.13, rz, 0.2, 0.028, 0.025, n, 0, angle, tier)
    const [gx, gz] = rot(dx, d / 2 + 0.14)
    box('leaf', gx, y + 0.08, gz, 0.16, 0.07, 0.1, n, 0, angle, tier)
  }

  const [lx, lz] = rot(0.42, d / 2 + 0.2)
  cyl('metal', lx, y + 0.26, lz, 0.018, 0.46, n, 0, tier)
  box('amber', lx, y + 0.51, lz, 0.095, 0.11, 0.095, n, 1.9, angle, tier)
  box('roof', lx, y + 0.58, lz, 0.14, 0.038, 0.14, n, 0, angle, tier)
}

// 6. Tempered Village
export function buildTemperedVillage(
  ctx: AssetContext,
  n: PlacedCity,
  x: number,
  y: number,
  z: number,
  rawH = 0.5,
  tier: RenderTier = 'l12',
): void {
  const { box, put, ao } = ctx
  const seed = hash(n.id + ':v')
  const turn = (Math.floor(hash(n.id + 'turn') * 6) * Math.PI) / 3
  const rot = (dx: number, dz: number): [number, number] => rotPoint(x, z, dx, dz, turn)
  const variant = Math.floor(seed * 4)
  n.scenery = ['village', 'plaza', 'courtyard', 'village'][variant]
  const biome = ctx.biomeOf(n.continent)

  if (hash(n.id + ':green') < 0.56) {
    const [cx, cz] = rot(-0.24, -0.18)
    ao(cx, y, cz, 0.72, tier)
    box('rock', cx, y + 0.025, cz, 0.36, 0.03, 0.3, n, 0, turn, tier)
    box('trim', cx, y + 0.045, cz, 0.32, 0.032, 0.26, n, 0, turn, tier)
    box('wall', cx, y + 0.145, cz, 0.27, 0.17, 0.22, n, 0, turn, tier)
    box(seed > 0.38 ? 'roof' : 'copper', cx, y + 0.245, cz, 0.32, 0.042, 0.26, n, 0, turn, tier)
    const [hx, hz] = rot(-0.2, 0.06)
    box('leaf', hx, y + 0.055, hz, 0.28, 0.065, 0.08, n, 0, turn, tier)
    const [gx, gz] = rot(0.18, 0.18)
    buildGroveCluster(ctx, gx, gz, seed > 0.44 ? 3 : 2, 0.2, 0.62, 0.84, n, biome, 0.12, tier, n.id + ':gg')
    if (hash(n.id + ':ob') < 0.14) {
      const [ox, oz] = rot(0.24, -0.22)
      put('hex', 'rock', ox, y + 0.03, oz, 0.2, 0.06, 0.2, n, turn, 0, null, tier)
      box('rock', ox, y + 0.21, oz, 0.095, 0.3, 0.095, n, 0, turn, tier)
      box('shared', ox, y + 0.27, oz, 0.11, 0.038, 0.11, n, 0.85, turn, tier)
      box('white', ox, y + 0.38, oz, 0.08, 0.05, 0.08, n, 0, turn, tier)
      box('white', ox, y + 0.43, oz, 0.045, 0.05, 0.045, n, 0, turn, tier)
    }
    return
  }
  ao(x, y, z, 1.05, tier)

  const lowCottage = (dx: number, dz: number, w: number, d: number, h: number, roofRole = 'roof', rRot = 0, lit = false): void => {
    const [cx, cz] = rot(dx, dz)
    const ang = turn + rRot
    box('trim', cx, y + 0.052, cz, w + 0.05, 0.036, d + 0.05, n, 0, ang, tier)
    box('wall', cx, y + 0.068 + h / 2, cz, w, h, d, n, 0, ang, tier)
    box(roofRole, cx, y + 0.078 + h, cz, w + 0.07, 0.044, d + 0.07, n, 0, ang, tier)
    box(roofRole, cx, y + 0.114 + h, cz, w * 0.62, 0.036, d * 0.66, n, 0, ang, tier)
    if (lit) {
      const [wx, wz] = rotPoint(cx, cz, 0, d * 0.5 + 0.008, ang)
      box('amber', wx, y + 0.07 + h * 0.54, wz, 0.065, 0.075, 0.018, n, 0.72, ang, tier)
    }
  }

  if (variant === 0) {
    box('rock', x, y + 0.018, z, 0.84, 0.032, 0.8, n, 0, turn, tier)
    box('trim', x, y + 0.03, z, 0.74, 0.026, 0.7, n, 0, turn, tier)
    box('sand', x, y + 0.042, z, 0.58, 0.018, 0.54, n, 0, turn, tier)
    lowCottage(-0.2, -0.15, 0.34, 0.28, 0.21, 'roof', 0, true)
    lowCottage(0.2, -0.12, 0.28, 0.26, 0.18, 'copper', Math.PI / 2, false)
    const [tx, tz] = rot(0.16, 0.2)
    buildTree(ctx, tx, y + 0.035, tz, 0.44, n, seed > 0.5 ? 'cypress' : 'oak', 'leaf', tier)
    const [gx, gz] = rot(-0.16, 0.22)
    box('leaf', gx, y + 0.062, gz, 0.28, 0.055, 0.11, n, 0, turn, tier)
  } else if (variant === 1) {
    box('rock', x, y + 0.018, z, 0.86, 0.032, 0.82, n, 0, turn, tier)
    box('trim', x, y + 0.03, z, 0.76, 0.026, 0.72, n, 0, turn, tier)
    box('sand', x, y + 0.042, z, 0.6, 0.018, 0.56, n, 0, turn, tier)
    lowCottage(-0.22, 0, 0.28, 0.48, 0.2, 'roof', 0, true)
    const [px, pz] = rot(0.06, -0.04)
    box('trim', px, y + 0.068, pz, 0.22, 0.045, 0.22, n, 0, turn, tier)
    box('river', px, y + 0.095, pz, 0.14, 0.025, 0.14, n, 0.2, turn, tier)
    const [wx, wz] = rot(0.14, -0.32)
    box('trim', wx, y + 0.075, wz, 0.36, 0.07, 0.055, n, 0, turn, tier)
    const [tx, tz] = rot(0.22, 0.2)
    buildTree(ctx, tx, y + 0.035, tz, 0.42, n, 'oak', 'meadow', tier)
  } else if (variant === 2) {
    box('meadow', x, y + 0.02, z, 0.76, 0.032, 0.72, n, 0, turn, tier)
    box('rock', x, y + 0.032, z, 0.58, 0.022, 0.54, n, 0, turn, tier)
    box('trim', x, y + 0.042, z, 0.5, 0.018, 0.46, n, 0, turn, tier)
    lowCottage(0, -0.16, 0.42, 0.26, 0.19, seed > 0.5 ? 'roof' : 'copper', 0, true)
    const [hx, hz] = rot(0, 0.28)
    box('leaf', hx, y + 0.058, hz, 0.34, 0.055, 0.08, n, 0, turn, tier)
    const [t1x, t1z] = rot(-0.23, 0.16)
    const [t2x, t2z] = rot(0.23, 0.16)
    buildTree(ctx, t1x, y + 0.03, t1z, 0.46, n, 'cypress', 'valley', tier)
    buildTree(ctx, t2x, y + 0.03, t2z, 0.4, n, 'oak', 'leaf', tier)
  } else {
    box('rock', x, y + 0.018, z, 0.84, 0.032, 0.8, n, 0, turn, tier)
    box('trim', x, y + 0.03, z, 0.74, 0.026, 0.7, n, 0, turn, tier)
    lowCottage(0, -0.2, 0.48, 0.26, 0.2, 'roof', 0, true)
    lowCottage(-0.2, 0.12, 0.26, 0.28, 0.17, 'copper', Math.PI / 2, false)
    const [hx, hz] = rot(0.28, 0.06)
    box('leaf', hx, y + 0.062, hz, 0.09, 0.055, 0.26, n, 0, turn, tier)
    const [tx, tz] = rot(0.18, 0.2)
    buildTree(ctx, tx, y + 0.035, tz, 0.42, n, 'cypress', 'leaf', tier)
  }

  if (y > 0.04 && rawH < 1.38) {
    const ang = turn + 0.65
    const gx = x + Math.cos(ang) * 0.66
    const gz = z + Math.sin(ang) * 0.66
    buildGroveCluster(ctx, gx, gz, seed > 0.52 ? 3 : 2, 0.2, 0.56, 0.76, n, biome, 0.16, tier, n.id + ':vg')
  }
}

// 7. Discarded closed work: weathered corner ruins
export function buildDiscardedRuin(ctx: AssetContext, n: PlacedCity, x: number, y: number, z: number, tier: RenderTier = 'l12'): void {
  const { box, ao } = ctx
  const seed = hash(n.id + ':r')
  const angle = (Math.floor(seed * 6) * Math.PI) / 3 + 0.35
  n.scenery = 'ruin'
  const rx = x + Math.cos(angle) * 0.37
  const rz = z + Math.sin(angle) * 0.37
  ao(rx, y, rz, 0.52, tier)
  box('rock', rx, y + 0.085, rz, 0.19, 0.17, 0.16, n, 0, angle, tier)
  box('wall', rx + Math.cos(angle + 1.35) * 0.16, y + 0.06, rz + Math.sin(angle + 1.35) * 0.16, 0.16, 0.12, 0.14, n, 0, angle + 0.45, tier)
  box('rock', rx + Math.cos(angle - 1.25) * 0.15, y + 0.045, rz + Math.sin(angle - 1.25) * 0.15, 0.14, 0.09, 0.12, n, 0, angle - 0.35, tier)
  box('leaf', rx - Math.cos(angle) * 0.13, y + 0.045, rz - Math.sin(angle) * 0.13, 0.15, 0.08, 0.15, n, 0, 0, tier)
}

// 8. Harbor Pier & Waterfront Warehouse
export function buildHarborPier(
  ctx: AssetContext,
  shorePt: WorldXZ,
  seaPt: WorldXZ,
  owner: PickOwner,
  tier: RenderTier = 'all',
): void {
  const { box, cyl, ao } = ctx
  const angle = Math.atan2(seaPt.x - shorePt.x, seaPt.z - shorePt.z)
  const ux = Math.sin(angle)
  const uz = Math.cos(angle)
  const px = -uz
  const pz = ux

  const wx = shorePt.x - ux * 0.18
  const wz = shorePt.z - uz * 0.18
  const wy = Math.max(-0.14, ctx.sampleHeight(wx, wz) - 0.02)
  ao(wx, wy, wz, 0.92, tier)
  box('rock', wx, wy + 0.05, wz, 0.44, 0.1, 0.34, owner, 0, angle, tier)
  box('wall', wx, wy + 0.21, wz, 0.38, 0.24, 0.28, owner, 0, angle, tier)
  box('roof', wx, wy + 0.35, wz, 0.44, 0.055, 0.34, owner, 0, angle, tier)
  box('roof', wx, wy + 0.4, wz, 0.28, 0.045, 0.3, owner, 0, angle, tier)
  box('amber', wx + ux * 0.15, wy + 0.22, wz + uz * 0.15, 0.09, 0.1, 0.03, owner, 1.4, angle, tier)

  const dockX = shorePt.x + ux * 0.56
  const dockZ = shorePt.z + uz * 0.56
  const dockY = -0.14
  box('trunk', dockX, dockY, dockZ, 0.26, 0.045, 0.96, owner, 0, angle, tier)
  box('trim', dockX, dockY + 0.025, dockZ, 0.22, 0.02, 0.92, owner, 0, angle, tier)

  for (const t of [-0.34, 0, 0.34]) {
    for (const s of [-0.11, 0.11]) {
      const bx = dockX + ux * t + px * s
      const bz = dockZ + uz * t + pz * s
      cyl('trunk', bx, dockY - 0.08, bz, 0.024, 0.24, owner, 0, tier)
    }
  }
  const headX = shorePt.x + ux * 0.96
  const headZ = shorePt.z + uz * 0.96
  cyl('metal', headX + px * 0.09, dockY + 0.16, headZ + pz * 0.09, 0.018, 0.28, owner, 0, tier)
  box('amber', headX + px * 0.09, dockY + 0.32, headZ + pz * 0.09, 0.075, 0.09, 0.075, owner, 2.2, angle, tier)
  box('trim', dockX - ux * 0.14 - px * 0.06, dockY + 0.07, dockZ - uz * 0.14 - pz * 0.06, 0.1, 0.09, 0.1, owner, 0, angle + 0.2, tier)

  if (owner?.shared) {
    const cx = shorePt.x - ux * 0.24 + px * 0.44
    const cz = shorePt.z - uz * 0.24 + pz * 0.44
    const cy = ctx.sampleHeight(cx, cz)
    if (cy > 0.02) buildSharedBoundaryCairn(ctx, cx, cy, cz, owner, angle, tier)
  }
}

export function buildSharedBoundaryCairn(
  ctx: AssetContext,
  x: number,
  y: number,
  z: number,
  owner: PickOwner,
  angle = 0,
  tier: RenderTier = 'all',
): void {
  const { box, put, ao } = ctx
  ao(x, y, z, 0.56, tier)
  put('hex', 'rock', x, y + 0.035, z, 0.2, 0.07, 0.2, owner, angle, 0, null, tier)
  box('trim', x, y + 0.16, z, 0.125, 0.22, 0.125, owner, 0, angle, tier)
  box('shared', x, y + 0.23, z, 0.145, 0.05, 0.145, owner, 0.65, angle, tier)
  box('wall', x, y + 0.29, z, 0.1, 0.06, 0.1, owner, 0, angle, tier)
}

// 9. White-Sailed Boats gliding along cross-ocean sea lanes
export function buildSailboatsForLane(ctx: AssetContext, lane: SeaLane, laneIdx: number): void {
  const { box, boats } = ctx
  const seaPts = lane.points.filter(p => p.sea)
  if (seaPts.length < 4) return
  const boatCount = lane.points.length >= 16 ? 2 : 1
  for (let b = 0; b < boatCount; b++) {
    const phase0 = (laneIdx * 0.37 + b * 0.5) % 1
    const dir = b % 2 === 0 ? 1 : -1
    const p0 = seaPts[Math.floor(phase0 * (seaPts.length - 1))]
    const y0 = -0.23
    const hull = box('trunk', p0.x, y0 + 0.03, p0.z, 0.18, 0.06, 0.46, null, 0, 0, 'all')
    const deck = box('trim', p0.x, y0 + 0.065, p0.z - 0.04, 0.14, 0.035, 0.22, null, 0, 0, 'all')
    const mast = box('trunk', p0.x, y0 + 0.24, p0.z + 0.02, 0.028, 0.36, 0.028, null, 0, 0, 'all')
    const mainSail = box('white', p0.x, y0 + 0.24, p0.z - 0.03, 0.045, 0.24, 0.24, null, 0.18, 0, 'all')
    const jibSail = box('white', p0.x, y0 + 0.21, p0.z + 0.13, 0.035, 0.17, 0.14, null, 0.18, 0, 'all')
    const wake = box('foam', p0.x, y0 - 0.015, p0.z - 0.26, 0.2, 0.01, 0.34, null, 0, 0, 'all')
    boats.push({
      pts: seaPts,
      phase0,
      speed: (0.026 + (laneIdx % 3) * 0.006) * dir,
      hull,
      deck,
      mast,
      mainSail,
      jibSail,
      wake,
      y0,
    })
  }
}

// 10. Clumped Biome Forest Belts, Sunlit Cultivated Fields & Decision Cairns
export function buildCountryside(
  ctx: AssetContext,
  t: FineTile,
  x: number,
  y: number,
  rawH: number,
  z: number,
  owner: PickOwner,
  area: Pick<AreaInput, 'recentRatio' | 'decisionCount'> | undefined,
  tier: RenderTier,
): void {
  const { box, put, ao, sampleHeight, isInRiver, isNearMountain } = ctx
  const k = key(t)
  const seed = hash(k + 'notes')
  const turn = (Math.floor(hash(k + 'nturn') * 6) * Math.PI) / 3
  const biome = ctx.biomeOf(t.continent)
  const recentRatio = t.recentRatio ?? area?.recentRatio ?? 0
  const decisionCount = t.decisionCount ?? area?.decisionCount ?? 0
  const groundAt = (px: number, pz: number): number => sampleHeight(px, pz)

  if (isInRiver(x, z)) return

  const obeliskChance = Math.min(0.11, 0.024 + decisionCount * 0.0038)
  if (decisionCount > 0 && !t.coast && !t.river && hash(k + 'obelisk') < obeliskChance) {
    const ox = x + (hash(k + 'ox') - 0.5) * 0.18
    const oz = z + (hash(k + 'oz') - 0.5) * 0.18
    if (isInRiver(ox, oz)) return
    const oy = groundAt(ox, oz)
    if (oy < 0.04) return
    ao(ox, oy, oz, 0.84, tier)
    put('hex', 'rock', ox, oy + 0.032, oz, 0.34, 0.064, 0.34, owner, turn, 0, null, tier)
    put('hex', 'trim', ox, oy + 0.075, oz, 0.24, 0.045, 0.24, owner, turn, 0, null, tier)
    box('rock', ox, oy + 0.28, oz, 0.125, 0.39, 0.125, owner, 0, turn, tier)
    box('shared', ox, oy + 0.35, oz, 0.145, 0.052, 0.145, owner, 0.78, turn, tier)
    box('white', ox, oy + 0.5, oz, 0.1, 0.055, 0.1, owner, 0, turn, tier)
    box('white', ox, oy + 0.555, oz, 0.055, 0.055, 0.055, owner, 0, turn, tier)
    for (let s = 0; s < 3; s++) {
      const a = turn + s * ((Math.PI * 2) / 3) + 0.4
      const sx = ox + Math.cos(a) * 0.36
      const sz = oz + Math.sin(a) * 0.36
      if (isInRiver(sx, sz)) continue
      const sy = groundAt(sx, sz)
      if (sy < 0.04) continue
      if (s === 0) {
        buildTree(ctx, sx, sy, sz, 0.64, owner, biome === 'nordic' ? 'pine' : 'cypress', 'leaf', tier, turn)
      } else {
        box('trim', sx, sy + 0.06, sz, 0.08, 0.12, 0.07, owner, 0, a, tier)
      }
    }
    return
  }

  const nearMtn = Boolean(isNearMountain(t))
  const groveNoise = fbm2(x * 0.22 + 5.7, z * 0.22 - 3.9)
  const maturityBoost = recentRatio < 0.22 ? 0.34 : -0.05
  const valleyBoost = t.valley ? 0.22 : 0
  const foothillBoost = nearMtn ? 0.3 : 0
  const citeBoost = (t.citedBy || 0) > 12 ? 0.1 : 0
  const coastPenalty = t.coast ? -0.24 : 0
  const woodScore = groveNoise + maturityBoost + valleyBoost + foothillBoost + citeBoost + coastPenalty

  if (recentRatio >= 0.22 && !t.coast && !t.river && woodScore < 0.28 && seed > 0.56) {
    const gy = groundAt(x, z)
    if (gy < 0.045) return
    ao(x, gy, z, 0.96, tier)
    const [wx, wz] = rotPoint(x, z, 0, -0.44, turn)
    if (!isInRiver(wx, wz)) {
      const wy = groundAt(wx, wz)
      box('rock', wx, wy + 0.032, wz, 0.78, 0.064, 0.08, owner, 0, turn, tier)
      box('trim', wx, wy + 0.068, wz, 0.76, 0.02, 0.07, owner, 0, turn, tier)
    }
    for (let j = 0; j < 3; j++) {
      const off = (j - 1) * 0.25 + 0.04
      const [tx, tz] = rotPoint(x, z, 0, off, turn)
      if (isInRiver(tx, tz)) continue
      const ty = groundAt(tx, tz)
      box('trim', tx, ty + 0.018, tz, 0.76 - j * 0.06, 0.032, 0.2, owner, 0, turn, tier)
      box(j % 2 === 0 ? 'crop' : 'meadow', tx, ty + 0.04, tz, 0.7 - j * 0.06, 0.028, 0.15, owner, 0, turn, tier)
      box('canopyLight', tx, ty + 0.062, tz, 0.56 - j * 0.06, 0.034, 0.055, owner, 0, turn, tier)
    }
    for (let j = 0; j < 2; j++) {
      const [ox, oz] = rotPoint(x, z, j === 0 ? 0.42 : -0.4, j === 0 ? 0.16 : -0.14, turn)
      if (!isInRiver(ox, oz)) {
        const oy = groundAt(ox, oz)
        if (oy > 0.045) buildTree(ctx, ox, oy, oz, 0.56 + j * 0.08, owner, 'oak', 'canopyLight', tier, turn + j * 0.4)
      }
    }
    return
  }

  const coniferBias = Math.max(0, Math.min(1, (rawH - 0.52) * 0.85 + (nearMtn ? 0.42 : 0)))
  if (woodScore > 0.4) {
    const subCount = seed > 0.32 ? 3 : 2
    for (let s = 0; s < subCount; s++) {
      const a = turn + s * ((Math.PI * 2) / subCount) + (hash(k + 'sa' + s) - 0.5) * 0.55
      const d = subCount === 2 ? 0.34 : 0.39
      const sx = x + Math.cos(a) * d
      const sz = z + Math.sin(a) * d
      buildGroveCluster(ctx, sx, sz, 3, 0.25, 0.64, 0.92, owner, biome, coniferBias, tier, `${k}:dg${s}`)
    }
  } else if (woodScore > 0.06) {
    const subCount = seed > 0.42 ? 2 : 1
    for (let s = 0; s < subCount; s++) {
      const a = turn + s * Math.PI + (hash(k + 'ma' + s) - 0.5) * 0.7
      const d = subCount === 1 ? 0.14 : 0.34
      const sx = x + Math.cos(a) * d
      const sz = z + Math.sin(a) * d
      buildGroveCluster(ctx, sx, sz, 3, 0.24, 0.58, 0.84, owner, biome, coniferBias, tier, `${k}:mg${s}`)
    }
  } else if (!t.coast && seed > 0.8) {
    const a = turn + seed * 3.1
    buildGroveCluster(
      ctx,
      x + Math.cos(a) * 0.24,
      z + Math.sin(a) * 0.24,
      2,
      0.18,
      0.56,
      0.74,
      owner,
      biome,
      coniferBias * 0.5,
      tier,
      k + ':cp',
    )
  }
  void y
}

// 11. World-Zoom (LOD 0) Biome Woodland Carpets, Cultivated Patchwork & Shared Headland Cairns
export function buildWorldWoodlands(
  ctx: AssetContext,
  atlas: AtlasLayout,
  mountainField: MountainField,
  terrainSampler: TerrainSampler,
  l0OwnerFor: (c: CoarseCell) => PickOwner,
): void {
  const { box, ao } = ctx
  const MOUNTAIN_CLASSES = new Set<MountainClass>(['ridge', 'peak', 'high_peak'])

  const l0HeroCities: WorldXZ[] = []
  for (const n of atlas.fibers || []) {
    if (n.state === 'ask' || n.state === 'working' || n.isOrchestrator) {
      l0HeroCities.push({ x: n.x, z: n.z })
    }
  }
  const nearHeroCity = (px: number, pz: number): boolean => l0HeroCities.some(c => Math.hypot(px - c.x, pz - c.z) < 1.95)

  const l1Set = new Set(atlas.level1.map(c => key(c)))
  const cairnsByCont = new Map<string, number>()

  for (const c of atlas.level1) {
    if (c.isthmus) continue
    const ck = key(c)
    const mEntry = mountainField.l1.get(ck)
    if (mEntry && MOUNTAIN_CLASSES.has(mEntry.mClass)) continue

    const owner = l0OwnerFor(c)
    const biome = ctx.biomeOf(c.continent)
    const recentRatio = c.recentRatio ?? 0
    const isFoothill = mEntry?.mClass === 'foothill'
    const seed = hash(ck + ':l0w')
    const turn = (Math.floor(hash(ck + ':l0t') * 6) * Math.PI) / 3

    const macroNoise = fbm2(c.x * 0.14 + 3.1, c.z * 0.14 - 2.7)
    const maturityBoost = recentRatio < 0.22 ? 0.36 : 0.06
    const valleyBoost = c.valley || c.river ? 0.22 : 0
    const coastPenalty = c.coast ? -0.18 : 0
    const woodScore = macroNoise + maturityBoost + valleyBoost + coastPenalty

    if (isFoothill) {
      if (seed > 0.35 && !nearHeroCity(c.x, c.z)) {
        const a = turn + 1.2
        const px = c.x + Math.cos(a) * 0.65
        const pz = c.z + Math.sin(a) * 0.65
        const py = terrainSampler.sampleHeight(px, pz)
        if (py > 0.05 && !nearHeroCity(px, pz)) {
          buildGroveCluster(ctx, px, pz, 2, 0.42, 1.05, 1.38, owner, biome, 0.25, 'l0', ck + ':fhbl')
        }
      }
      continue
    }

    if (owner.shared && c.coast) {
      let seaDirs = 0
      let outX = 0
      let outZ = 0
      for (const [dq, dr] of DIRECTIONS) {
        if (!l1Set.has(`${c.q + dq},${c.r + dr}`)) {
          seaDirs++
          const dw = world({ q: dq, r: dr })
          outX += dw.x
          outZ += dw.z
        }
      }
      const prevCount = cairnsByCont.get(c.continent) || 0
      if (seaDirs >= 3 && prevCount < 3 && seed > 0.52) {
        const ol = Math.hypot(outX, outZ) || 1
        const hx = c.x + (outX / ol) * 0.92
        const hz = c.z + (outZ / ol) * 0.92
        const hy = terrainSampler.sampleHeight(hx, hz)
        if (hy > 0.04 && !nearHeroCity(hx, hz)) {
          buildSharedBoundaryCairn(ctx, hx, hy, hz, owner, Math.atan2(outX, outZ), 'l0')
          cairnsByCont.set(c.continent, prevCount + 1)
        }
      }
    }

    if (recentRatio >= 0.22 && !c.coast && woodScore < 0.24 && seed > 0.34 && !nearHeroCity(c.x, c.z)) {
      const cy = terrainSampler.sampleHeight(c.x, c.z)
      if (cy > 0.05) {
        ao(c.x, cy, c.z, 2.25, 'l0')
        for (let j = 0; j < 3; j++) {
          const off = (j - 1) * 0.52
          const [tx, tz] = rotPoint(c.x, c.z, 0, off, turn)
          const ty = terrainSampler.sampleHeight(tx, tz)
          if (ty < 0.04) continue
          box('trim', tx, ty + 0.03, tz, 1.56 - j * 0.12, 0.05, 0.4, owner, 0, turn, 'l0')
          box(j % 2 === 0 ? 'crop' : 'meadow', tx, ty + 0.065, tz, 1.44 - j * 0.12, 0.045, 0.3, owner, 0, turn, 'l0')
        }
        const [ox, oz] = rotPoint(c.x, c.z, 0.78, 0.42, turn)
        const oy = terrainSampler.sampleHeight(ox, oz)
        if (oy > 0.05 && !nearHeroCity(ox, oz)) {
          buildTree(ctx, ox, oy, oz, 1.18, owner, 'oak', 'canopyLight', 'l0', turn)
        }
      }
      continue
    }

    if (woodScore > -0.04 || (!c.coast && seed > 0.34)) {
      const puffCount = woodScore > 0.34 ? 7 : woodScore > 0.1 ? 5 : 4
      const coniferBias = biome === 'nordic' ? 0.58 : c.height > 1.15 ? 0.4 : 0.14
      let placed = 0
      const baseAng = turn + seed * 1.9
      for (let j = 0; j < puffCount; j++) {
        const a = baseAng + j * 2.39996 + (hash(ck + ':la' + j) - 0.5) * 0.45
        const r = j === 0 ? hash(ck + ':lr0') * 0.25 : Math.sqrt((j + 0.3) / puffCount) * 1.38
        const px = c.x + Math.cos(a) * r
        const pz = c.z + Math.sin(a) * r
        if (nearHeroCity(px, pz)) continue
        const py = terrainSampler.sampleHeight(px, pz)
        if (py < 0.06) continue
        const { species, tint } = pickBiomeTree(biome, hash(ck + ':lsp' + j), coniferBias)
        const sc = 1.52 + hash(ck + ':lsc' + j) * 0.56
        buildTree(ctx, px, py, pz, sc, owner, species, tint, 'l0', Math.floor(hash(ck + ':lrt' + j) * 4) * Math.PI * 0.25)
        placed++
      }
      if (placed > 0) {
        const cy = terrainSampler.sampleHeight(c.x, c.z)
        if (cy > 0.04) ao(c.x, cy, c.z, 2.95, 'l0')
      }
    }
  }
}

// 12. Riparian Groves & Reed Tufts along Catmull-Rom river bends
export function buildRiparianFlora(
  ctx: AssetContext,
  sampler: TerrainSampler,
  atlas: AtlasLayout,
  mountainField: MountainField,
  placedBridgePts: WorldXZ[] = [],
): void {
  const { box, ao, sampleHeight, isInRiver } = ctx
  const MOUNTAIN_CLASSES = new Set<MountainClass>(['ridge', 'peak', 'high_peak'])

  const cities = atlas.fibers || []
  const nearBlocked = (px: number, pz: number): boolean => {
    for (let i = 0; i < placedBridgePts.length; i++) {
      const b = placedBridgePts[i]
      if (Math.hypot(px - b.x, pz - b.z) < 0.88) return true
    }
    for (let i = 0; i < cities.length; i++) {
      const c = cities[i]
      if (Math.hypot(px - c.x, pz - c.z) < 0.96) return true
    }
    return false
  }

  const placedTrees: WorldXZ[] = []
  const tooCloseTree = (px: number, pz: number): boolean => placedTrees.some(p => Math.hypot(px - p.x, pz - p.z) < 0.58)

  for (let rIdx = 0; rIdx < sampler.riverPaths.length; rIdx++) {
    const rp = sampler.riverPaths[rIdx]
    const pts = rp.pts
    if (pts.length < 3) continue
    const biome = ctx.biomeOf(rp.continent)

    let nextTreeArc = 0.65
    let nextReedArc = 0.45

    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i]
      const prev = pts[i - 1]
      const next = pts[i + 1]
      const tx = next.x - prev.x
      const tz = next.z - prev.z
      const tLen = Math.hypot(tx, tz) || 1
      const nx = -tz / tLen
      const nz = tx / tLen
      const hw = p.halfW || 0.21

      if (p.arc >= nextReedArc) {
        nextReedArc = p.arc + 0.62 + hash(`rd:${rIdx}:${i}`) * 0.48
        const side = hash(`rds:${rIdx}:${i}`) > 0.5 ? 1 : -1
        const dist = hw + 0.13 + hash(`rdd:${rIdx}:${i}`) * 0.08
        const rx = p.x + nx * side * dist
        const rz = p.z + nz * side * dist
        if (!nearBlocked(rx, rz)) {
          const ry = sampleHeight(rx, rz)
          if (ry > 0.01) {
            for (let b = 0; b < 3; b++) {
              const bx = rx + (b - 1) * 0.055 * (tx / tLen)
              const bz = rz + (b - 1) * 0.055 * (tz / tLen)
              const bh = 0.14 + (b === 1 ? 0.07 : 0.02)
              box(b === 1 ? 'canopyLight' : 'valley', bx, ry + bh * 0.5, bz, 0.052, bh, 0.052, rp.owner, 0, b * 0.4, 'l12')
            }
          }
        }
      }

      if (p.arc >= nextTreeArc) {
        nextTreeArc = p.arc + 0.96 + hash(`rt:${rIdx}:${i}`) * 0.72
        for (const side of [-1, 1]) {
          const hSide = hash(`rts:${rIdx}:${i}:${side}`)
          if (hSide < 0.36) continue
          const bankDist = Math.max(0.44, Math.min(0.68, hw + 0.27 + hash(`rtd:${rIdx}:${i}:${side}`) * 0.18))
          const px = p.x + nx * side * bankDist
          const pz = p.z + nz * side * bankDist
          if (isInRiver(px, pz) || nearBlocked(px, pz) || tooCloseTree(px, pz)) continue
          const s = sampler.sample(px, pz)
          if (s.h < 0.045 || s.inPad) continue
          const mClass = s.ownTile ? mountainField.l2.get(key(s.ownTile))?.mClass : undefined
          if (mClass && MOUNTAIN_CLASSES.has(mClass)) continue

          const species = hSide > 0.62 ? 'willow' : biome === 'nordic' ? 'pine' : 'oak'
          const tint = species === 'pine' ? 'valley' : hSide > 0.8 ? 'canopyLight' : 'leaf'
          const sc = 0.58 + hash(`rtsc:${rIdx}:${i}:${side}`) * 0.24
          ao(px, s.h, pz, 0.78, 'l12')
          buildTree(ctx, px, s.h, pz, sc, rp.owner, species, tint, 'l12', hSide * 3.1)
          placedTrees.push({ x: px, z: pz })
        }
      }
    }
  }
}

// 13. Arched Stone & Timber River Bridge where overland roads cross rivers
export function buildRiverBridge(
  ctx: AssetContext,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  waterY: number,
  owner: PickOwner | null,
  tier: RenderTier = 'l12',
): void {
  const { box, sampleHeight } = ctx
  const dx = bx - ax
  const dz = bz - az
  const rawLen = Math.hypot(dx, dz)
  if (rawLen < 0.05) return

  const ux = dx / rawLen
  const uz = dz / rawLen
  const px = -uz
  const pz = ux
  const rot = Math.atan2(dx, dz)
  const mx = (ax + bx) * 0.5
  const mz = (az + bz) * 0.5
  const spanLen = Math.max(0.76, Math.min(1.65, rawLen + 0.18))
  const halfSpan = spanLen * 0.5

  const endAx = mx - ux * halfSpan
  const endAz = mz - uz * halfSpan
  const endBx = mx + ux * halfSpan
  const endBz = mz + uz * halfSpan
  const bankA = sampleHeight(endAx, endAz)
  const bankB = sampleHeight(endBx, endBz)
  const effWaterY = Math.max(waterY, Math.max(bankA, bankB) - 0.02)
  const abutY = Math.max(effWaterY + 0.068, Math.max(bankA, bankB) + 0.032)
  const crownY = Math.max(effWaterY + 0.135, abutY + 0.055)

  const deckW = 0.25
  const railOff = 0.12

  for (const sgn of [-1, 1]) {
    const px0 = mx + ux * sgn * (halfSpan - 0.06)
    const pz0 = mz + uz * sgn * (halfSpan - 0.06)
    const pierH = Math.max(0.14, abutY - (waterY - 0.11))
    box('rock', px0, abutY - pierH * 0.5, pz0, deckW + 0.08, pierH, 0.17, owner, 0, rot, tier)
    box('trim', px0, abutY + 0.012, pz0, deckW + 0.1, 0.028, 0.19, owner, 0, rot, tier)
    for (const side of [-1, 1]) {
      const bx0 = px0 + px * side * (railOff + 0.015)
      const bz0 = pz0 + pz * side * (railOff + 0.015)
      box('wall', bx0, abutY + 0.068, bz0, 0.052, 0.095, 0.052, owner, 0, rot, tier)
    }
  }

  const centerLen = spanLen * 0.44
  const rampLen = spanLen * 0.34
  const rampDrop = Math.max(0.025, crownY - abutY)
  const rampSlope = Math.atan2(rampDrop, rampLen)

  box('rock', mx, crownY - 0.028, mz, deckW + 0.02, 0.044, centerLen + 0.04, owner, 0, rot, tier)
  box('road', mx, crownY, mz, deckW - 0.03, 0.026, centerLen + 0.04, owner, 0, rot, tier)

  for (const sgn of [-1, 1]) {
    const off = sgn * (centerLen * 0.5 + rampLen * 0.44)
    const rx = mx + ux * off
    const rz = mz + uz * off
    const ry = (crownY + abutY) * 0.5
    const archItem = box('rock', rx, ry - 0.025, rz, deckW + 0.01, 0.042, rampLen + 0.04, owner, 0, rot, tier)
    archItem.slope = sgn * rampSlope
    const deckItem = box('road', rx, ry, rz, deckW - 0.03, 0.026, rampLen + 0.04, owner, 0, rot, tier)
    deckItem.slope = sgn * rampSlope
  }

  for (const side of [-1, 1]) {
    const ox = px * side * railOff
    const oz = pz * side * railOff
    box('trim', mx + ox, crownY + 0.042, mz + oz, 0.034, 0.058, centerLen + 0.04, owner, 0, rot, tier)
    box('trunk', mx + ox, crownY + 0.074, mz + oz, 0.04, 0.018, centerLen + 0.04, owner, 0, rot, tier)
    for (const sgn of [-1, 1]) {
      const off = sgn * (centerLen * 0.5 + rampLen * 0.44)
      const rx = mx + ux * off + ox
      const rz = mz + uz * off + oz
      const ry = (crownY + abutY) * 0.5
      const wall = box('trim', rx, ry + 0.04, rz, 0.034, 0.054, rampLen + 0.03, owner, 0, rot, tier)
      wall.slope = sgn * rampSlope
      const cap = box('trunk', rx, ry + 0.07, rz, 0.04, 0.016, rampLen + 0.03, owner, 0, rot, tier)
      cap.slope = sgn * rampSlope
    }
  }
}
