import { describe, expect, it } from 'vitest'
import { mapTerrainFixture } from '../../harness/map-fixtures.js'
import {
  DEFAULT_TERRAIN_PARAMS,
  SEA_Y,
  buildJitteredLawsonDelaunay,
  flowEightFoldBias,
  solveArchipelagoGeomorphology,
} from './geomorphology.js'
import { key, layout, world } from './layout.js'
import { computeMountainField } from './mountains.js'
import type { AtlasLayout, FineTile, PlacedCity, PlacedContinent, TerrainBundle } from './types.js'

describe('Model C+ jittered-Delaunay geomorphology engine', () => {
  it('produces zero Delaunay circumcircle violations with Lawson legalization', () => {
    const mesh = buildJitteredLawsonDelaunay(-12, 12, -10, 10, 0.35, 0.36, 42)
    expect(mesh.V).toBeGreaterThan(2000)
    expect(mesh.T).toBeGreaterThan(4000)
    expect(mesh.violations).toBe(0)
    expect(mesh.flips).toBeGreaterThan(0)
    for (let u = 0; u < mesh.V; u++) {
      expect(Number.isFinite(mesh.vx[u])).toBe(true)
      expect(Number.isFinite(mesh.vz[u])).toBe(true)
      expect(mesh.cellArea[u]).toBeGreaterThan(0)
    }
  })

  it('solves the multi-continent fixture deterministically, fast, with zero NaN and low 8-fold directional bias', () => {
    const bundle = mapTerrainFixture()
    const atlas = layout(bundle)
    const tileMap = new Map(atlas.tiles.map(t => [key(t), t]))
    const contMap = new Map(atlas.continents.map(c => [c.id, c]))
    const cityAt = new Map(atlas.fibers.map(n => [key(n), n]))
    const mField = computeMountainField(atlas, tileMap, cityAt)

    const runA = solveArchipelagoGeomorphology(atlas, tileMap, contMap, mField, DEFAULT_TERRAIN_PARAMS)
    const runB = solveArchipelagoGeomorphology(atlas, tileMap, contMap, mField, DEFAULT_TERRAIN_PARAMS)

    expect(runA.stats.delaunayViolations).toBe(0)
    expect(runA.patches.length).toBeGreaterThanOrEqual(4)
    expect(runA.patches.length).toBe(runB.patches.length)
    expect(runA.stats.totalVerts).toBeGreaterThan(15000)
    expect(runA.stats.solveMs).toBeLessThan(3000)

    // Determinism check: identical vertex heights across runs
    for (let i = 0; i < runA.patches.length; i++) {
      const hA = runA.patches[i].h
      const hB = runB.patches[i].h
      expect(hA.length).toBe(hB.length)
      for (let u = 0; u < hA.length; u++) {
        expect(Number.isFinite(hA[u])).toBe(true)
        expect(hA[u]).toBe(hB[u])
      }
    }

    // Isotropic irregular drainage: 8-fold harmonic |mean(cos(8*theta))| stays well below 0.08
    const bias8 = Math.abs(flowEightFoldBias(runA.patches))
    expect(bias8).toBeLessThan(0.08)

    // Alpine peaks, organic drainage rivers, and alpine tarns are extracted
    const maxLandH = Math.max(...runA.patches.map(p => p.maxLandHeight))
    expect(maxLandH).toBeGreaterThan(2.0)
    expect(runA.stats.lakeCount).toBeGreaterThanOrEqual(1)
    expect(runA.stats.riverCount).toBeGreaterThanOrEqual(2)
  })

  it('keeps every city pad dry, flat, and grounded in the barycentric sampler', () => {
    const bundle = mapTerrainFixture()
    const atlas = layout(bundle)
    const tileMap = new Map(atlas.tiles.map(t => [key(t), t]))
    const contMap = new Map(atlas.continents.map(c => [c.id, c]))
    const cityAt = new Map(atlas.fibers.map(n => [key(n), n]))
    const mField = computeMountainField(atlas, tileMap, cityAt)
    const result = solveArchipelagoGeomorphology(atlas, tileMap, contMap, mField)
    const { sampler } = result

    for (const city of atlas.fibers) {
      const cy = sampler.cityElevations.get(key(city))
      expect(cy).toBeDefined()
      expect(cy!).toBeGreaterThan(SEA_Y + 0.15)
      const sampled = sampler.sampleHeight(city.x, city.z)
      expect(Number.isFinite(sampled)).toBe(true)
      expect(Math.abs(sampled - cy!)).toBeLessThan(0.08)
      expect(sampler.isInLake(city.x, city.z)).toBe(false)
    }
  })

  it('responds cleanly to TerrainParams adjustments (uplift and lakeLevel)', () => {
    const bundle = mapTerrainFixture()
    const atlas = layout(bundle)
    const tileMap = new Map(atlas.tiles.map(t => [key(t), t]))
    const contMap = new Map(atlas.continents.map(c => [c.id, c]))
    const cityAt = new Map(atlas.fibers.map(n => [key(n), n]))
    const mField = computeMountainField(atlas, tileMap, cityAt)

    const lowRelief = solveArchipelagoGeomorphology(atlas, tileMap, contMap, mField, {
      uplift: 0.5,
      lakeLevel: 0.0,
      iterations: 16,
    })
    const highRelief = solveArchipelagoGeomorphology(atlas, tileMap, contMap, mField, {
      uplift: 1.5,
      lakeLevel: 1.3,
      iterations: 16,
    })

    const lowPeak = Math.max(...lowRelief.patches.map(p => p.maxLandHeight))
    const highPeak = Math.max(...highRelief.patches.map(p => p.maxLandHeight))
    expect(highPeak).toBeGreaterThan(lowPeak * 1.8)
    expect(lowRelief.stats.lakeCount).toBe(0)
    expect(highRelief.stats.lakeCount).toBeGreaterThanOrEqual(1)
  })

  it('handles an empty bundle and out-of-patch sea fallbacks cleanly', () => {
    const emptyBundle: TerrainBundle = {
      continents: [],
      areas: [],
      cities: [],
      areaLinks: [],
      domainLinks: [],
    }
    const atlas = layout(emptyBundle)
    const tileMap = new Map(atlas.tiles.map(t => [key(t), t]))
    const contMap = new Map(atlas.continents.map(c => [c.id, c]))
    const cityAt = new Map(atlas.fibers.map(n => [key(n), n]))
    const mField = computeMountainField(atlas, tileMap, cityAt)
    const res = solveArchipelagoGeomorphology(atlas, tileMap, contMap, mField)

    expect(res.patches.length).toBe(0)
    expect(res.stats.delaunayViolations).toBe(0)
    expect(res.stats.totalVerts).toBe(0)
    expect(res.sampler.sampleHeight(0, 0)).toBeLessThan(SEA_Y)
    expect(res.sampler.sampleHeight(9999, 9999)).toBeLessThan(SEA_Y)
    expect(res.sampler.sampleSlope(9999, 9999)).toBe(0)
    expect(res.sampler.isInWater(9999, 9999)).toBe(true)
    expect(res.sampler.isInLake(9999, 9999)).toBe(false)
  })

  it('solves 1-hex, 2-hex, and 3-hex islets with zero NaNs, zero Delaunay violations, and dry land', () => {
    const makeTile = (q: number, r: number, continent: string, height: number): FineTile => {
      const w = world({ q, r })
      return {
        q,
        r,
        x: w.x,
        z: w.z,
        level: 2,
        continent,
        area: `${continent}-area`,
        subArea: null,
        subAreaName: null,
        cell: '0,0',
        height,
        valley: false,
        river: false,
        coast: true,
        isthmus: false,
        depth: 1,
        citedBy: 2,
        recentRatio: 0.4,
        decisionCount: 0,
        splitL3: false,
      }
    }

    for (const tileCount of [1, 2, 3]) {
      const coords = [
        { q: 0, r: 0 },
        { q: 1, r: 0 },
        { q: 0, r: 1 },
      ].slice(0, tileCount)
      const tiles: FineTile[] = coords.map((c, idx) => makeTile(c.q, c.r, `islet-${tileCount}`, 0.45 + idx * 0.08))
      const cont: PlacedContinent = {
        id: `islet-${tileCount}`,
        name: `Islet ${tileCount}`,
        kind: 'project',
        sea: 'inner',
        biome: 'mediterranean',
        total: tileCount * 4,
        cities: 0,
        citedBy: 4,
        maxDepth: 1,
        topLevelBreadth: 1,
        coarse: 1,
        rc: 1,
        q: 0,
        r: 0,
        fq: 0,
        fr: 0,
        x: 0,
        z: 0,
        areas: [],
        subAreas: [],
        highland: 0,
        fibers: [],
        peak: 0.6,
        land: tileCount,
        active: 0,
        ask: 0,
        review: 0,
      }
      const atlas: AtlasLayout = {
        continents: [cont],
        cells: [],
        level1: [],
        level2: tiles,
        level3: [],
        tiles,
        fibers: [],
        roads: [],
        lanes: [],
        rivers: [],
        isthmuses: [],
        heightMode: 'citations',
      }
      const tileMap = new Map(tiles.map(t => [key(t), t]))
      const contMap = new Map([[cont.id, cont]])
      const mField = computeMountainField(atlas, tileMap, new Map())
      const res = solveArchipelagoGeomorphology(atlas, tileMap, contMap, mField)

      expect(res.patches.length).toBe(1)
      expect(res.stats.delaunayViolations).toBe(0)
      for (const hVal of res.patches[0].h) {
        expect(Number.isFinite(hVal)).toBe(true)
      }
      for (const t of tiles) {
        const h = res.sampler.sampleHeight(t.x, t.z)
        expect(Number.isFinite(h)).toBe(true)
        expect(h).toBeGreaterThan(SEA_Y)
        expect(res.sampler.isInWater(t.x, t.z)).toBe(false)
      }
      // Out-of-patch sea fallback
      expect(res.sampler.sampleHeight(500, 500)).toBeLessThan(SEA_Y)
      expect(res.sampler.sampleSlope(500, 500)).toBe(0)
      expect(res.sampler.isInWater(500, 500)).toBe(true)
      expect(res.sampler.isInLake(500, 500)).toBe(false)
    }
  })

  it('does not let a larger concave continent AABB shadow a smaller island tucked inside its bay', () => {
    const makeTile = (q: number, r: number, continent: string, height = 0.55): FineTile => {
      const w = world({ q, r })
      return {
        q,
        r,
        x: w.x,
        z: w.z,
        level: 2,
        continent,
        area: `${continent}-area`,
        subArea: null,
        subAreaName: null,
        cell: `${Math.floor(q / 2)},${Math.floor(r / 2)}`,
        height,
        valley: false,
        river: false,
        coast: false,
        isthmus: false,
        depth: 2,
        citedBy: 4,
        recentRatio: 0.5,
        decisionCount: 0,
        splitL3: false,
      }
    }

    // Large C-shaped concave continent spanning q in [-5..5], r in [-5..5], leaving the center bay open
    const bigTiles: FineTile[] = []
    for (let q = -5; q <= 5; q++) {
      bigTiles.push(makeTile(q, -5, 'crescent', 0.65))
      bigTiles.push(makeTile(q, -4, 'crescent', 0.6))
      bigTiles.push(makeTile(q, 5, 'crescent', 0.65))
      bigTiles.push(makeTile(q, 4, 'crescent', 0.6))
    }
    for (let r = -3; r <= 3; r++) {
      bigTiles.push(makeTile(-5, r, 'crescent', 0.65))
      bigTiles.push(makeTile(-4, r, 'crescent', 0.6))
    }

    // Smaller independent island positioned right inside crescent's rectangular AABB bay
    const smallCoords = [
      { q: 1, r: 0 },
      { q: 2, r: 0 },
      { q: 1, r: 1 },
      { q: 2, r: -1 },
    ]
    const smallTiles = smallCoords.map(c => makeTile(c.q, c.r, 'bay-isle', 0.52))
    const bayCityTile = smallTiles[0]
    const bayCity: PlacedCity = {
      id: 'bay-city',
      name: 'Bay Citadel',
      continent: 'bay-isle',
      area: 'bay-isle-area',
      state: 'working',
      host: 'host-a',
      depth: 1,
      summitTier: 1,
      q: bayCityTile.q,
      r: bayCityTile.r,
      x: bayCityTile.x,
      z: bayCityTile.z,
      local: { q: 0, r: 0 },
      elevation: bayCityTile.height,
      shared: false,
    }

    const contBig: PlacedContinent = {
      id: 'crescent',
      name: 'Crescent',
      kind: 'project',
      sea: 'inner',
      biome: 'temperate',
      total: 40,
      cities: 0,
      citedBy: 10,
      maxDepth: 2,
      topLevelBreadth: 4,
      coarse: 12,
      rc: 5,
      q: -4,
      r: 0,
      fq: -4,
      fr: 0,
      x: -4,
      z: 0,
      areas: [],
      subAreas: [],
      highland: 0.4,
      fibers: [],
      peak: 0.7,
      land: bigTiles.length,
      active: 0,
      ask: 0,
      review: 0,
    }
    const contSmall: PlacedContinent = {
      id: 'bay-isle',
      name: 'Bay Isle',
      kind: 'project',
      sea: 'inner',
      biome: 'mediterranean',
      total: 8,
      cities: 1,
      citedBy: 3,
      maxDepth: 1,
      topLevelBreadth: 1,
      coarse: 2,
      rc: 1,
      q: bayCityTile.q,
      r: bayCityTile.r,
      fq: bayCityTile.q,
      fr: bayCityTile.r,
      x: bayCityTile.x,
      z: bayCityTile.z,
      areas: [],
      subAreas: [],
      highland: 0.2,
      fibers: [bayCity],
      peak: 0.55,
      land: smallTiles.length,
      active: 1,
      ask: 0,
      review: 0,
    }

    const allTiles = [...bigTiles, ...smallTiles]
    const atlas: AtlasLayout = {
      continents: [contBig, contSmall],
      cells: [],
      level1: [],
      level2: allTiles,
      level3: [],
      tiles: allTiles,
      fibers: [bayCity],
      roads: [],
      lanes: [],
      rivers: [],
      isthmuses: [],
      heightMode: 'citations',
    }
    const tileMap = new Map(allTiles.map(t => [key(t), t]))
    const contMap = new Map([
      [contBig.id, contBig],
      [contSmall.id, contSmall],
    ])
    const cityAt = new Map([[key(bayCity), bayCity]])
    const mField = computeMountainField(atlas, tileMap, cityAt)
    const res = solveArchipelagoGeomorphology(atlas, tileMap, contMap, mField)

    expect(res.patches.length).toBe(2)
    // Verify small island lies inside crescent's rectangular AABB
    const crescentPatch = res.patches.find(p => p.continentIds.includes('crescent'))!
    expect(bayCity.x).toBeGreaterThan(crescentPatch.mesh.minX)
    expect(bayCity.x).toBeLessThan(crescentPatch.mesh.maxX)
    expect(bayCity.z).toBeGreaterThan(crescentPatch.mesh.minZ)
    expect(bayCity.z).toBeLessThan(crescentPatch.mesh.maxZ)

    // Every tile and the city on the enclosed small island must sample dry land, never shadowed sea
    for (const t of smallTiles) {
      expect(res.sampler.sampleHeight(t.x, t.z)).toBeGreaterThan(SEA_Y)
      expect(res.sampler.isInWater(t.x, t.z)).toBe(false)
    }
    expect(res.sampler.sampleHeight(bayCity.x, bayCity.z)).toBeGreaterThan(SEA_Y + 0.15)
    expect(res.sampler.isInWater(bayCity.x, bayCity.z)).toBe(false)
  })

  it('welds isthmus land bridges into a continuous dry crossing above sea level', () => {
    const bundle = mapTerrainFixture()
    const atlas = layout(bundle)
    const tileMap = new Map(atlas.tiles.map(t => [key(t), t]))
    const contMap = new Map(atlas.continents.map(c => [c.id, c]))
    const cityAt = new Map(atlas.fibers.map(n => [key(n), n]))
    const mField = computeMountainField(atlas, tileMap, cityAt)
    const res = solveArchipelagoGeomorphology(atlas, tileMap, contMap, mField)

    const isthmusTiles = atlas.tiles.filter(t => t.isthmus)
    expect(isthmusTiles.length).toBeGreaterThan(0)
    for (const t of isthmusTiles) {
      expect(res.sampler.sampleHeight(t.x, t.z)).toBeGreaterThan(SEA_Y)
      expect(res.sampler.isInWater(t.x, t.z)).toBe(false)
    }
    // Check midpoints between adjacent isthmus tiles stay dry too (no seam)
    const isthSet = new Map(isthmusTiles.map(t => [key(t), t]))
    const dirs = [
      [1, 0],
      [1, -1],
      [0, -1],
      [-1, 0],
      [-1, 1],
      [0, 1],
    ] as const
    let pairsChecked = 0
    for (const t of isthmusTiles) {
      for (const [dq, dr] of dirs) {
        const nb = isthSet.get(`${t.q + dq},${t.r + dr}`)
        if (!nb) continue
        const mx = (t.x + nb.x) * 0.5
        const mz = (t.z + nb.z) * 0.5
        expect(res.sampler.sampleHeight(mx, mz)).toBeGreaterThan(SEA_Y)
        pairsChecked++
      }
    }
    expect(pairsChecked).toBeGreaterThan(0)
  })
})
