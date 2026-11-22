import { describe, expect, it } from 'vitest'
import { localHour, zone } from '../board/civilDay.js'
import {
  BIOME_IDS,
  biomeOf,
  birth,
  children,
  distance,
  key,
  landCells,
  layout,
  nest,
  normalizeBiome,
  parent,
  unworld,
} from './layout.js'
import { cityState, collectHosts, hostColor, mergeCompositeSnapshot } from './states.js'
import type { TerrainBundle } from './types.js'

function syntheticBundle(): TerrainBundle {
  return {
    origins: { alpha: { stale: false, fibers: 12 }, beta: { stale: false, fibers: 8 } },
    continents: [
      {
        id: 'atlas',
        name: 'Atlas',
        kind: 'project',
        shared: true,
        total: 420,
        cities: 8,
        citedBy: 950,
        maxDepth: 6,
        topLevelBreadth: 12,
        recentRatio: 0.25,
      },
      {
        id: 'beacon',
        name: 'Beacon',
        kind: 'project',
        shared: false,
        total: 260,
        cities: 5,
        citedBy: 480,
        maxDepth: 4,
        topLevelBreadth: 9,
        recentRatio: 0.42,
      },
      {
        id: 'harbor',
        name: 'Harbor',
        kind: 'project',
        shared: true,
        total: 140,
        cities: 3,
        citedBy: 210,
        maxDepth: 3,
        topLevelBreadth: 6,
        recentRatio: 0.14,
      },
      {
        id: 'guild',
        name: 'Guild',
        kind: 'guild',
        shared: false,
        total: 180,
        cities: 2,
        citedBy: 310,
        maxDepth: 4,
        topLevelBreadth: 5,
        recentRatio: 0.3,
      },
      {
        id: 'shoals',
        name: 'Shoals',
        kind: 'shoals',
        shared: false,
        total: 4,
        cities: 0,
        citedBy: 5,
        maxDepth: 1,
        topLevelBreadth: 1,
        recentRatio: 0.5,
      },
    ],
    areas: [
      { id: 'atlas/core', name: 'Core', continent: 'atlas', mass: 220, cities: 5, citedBy: 620, maxDepth: 6, sampleFibers: ['Core spec'] },
      { id: 'atlas/sim', name: 'Sim', continent: 'atlas', mass: 120, cities: 2, citedBy: 210, maxDepth: 4, sampleFibers: ['Sim run'] },
      { id: 'atlas/docs', name: 'Docs', continent: 'atlas', mass: 80, cities: 1, citedBy: 120, maxDepth: 3, sampleFibers: ['Docs index'] },
      { id: 'beacon/engine', name: 'Engine', continent: 'beacon', mass: 170, cities: 3, citedBy: 330, maxDepth: 4, sampleFibers: ['Engine loop'] },
      { id: 'beacon/ui', name: 'UI', continent: 'beacon', mass: 90, cities: 2, citedBy: 150, maxDepth: 3, sampleFibers: ['UI layout'] },
      { id: 'harbor/dock', name: 'Dock', continent: 'harbor', mass: 140, cities: 3, citedBy: 210, maxDepth: 3, sampleFibers: ['Dock API'] },
      { id: 'guild/roles', name: 'Roles', continent: 'guild', mass: 180, cities: 2, citedBy: 310, maxDepth: 4, sampleFibers: ['Operator'] },
    ],
    areaLinks: [
      { a: 'atlas/core', b: 'atlas/sim', w: 28 },
      { a: 'atlas/sim', b: 'atlas/docs', w: 14 },
      { a: 'beacon/engine', b: 'beacon/ui', w: 18 },
    ],
    domainLinks: [
      { a: 'atlas', b: 'beacon', w: 32 },
      { a: 'atlas', b: 'harbor', w: 16 },
      { a: 'beacon', b: 'harbor', w: 6 },
    ],
    cities: [
      { id: 'atlas/core/lead', uid: '01ARZ3NDEKTSV4RRFFQ69G5FA1', name: 'Atlas Lead', continent: 'atlas', area: 'atlas/core', parent: null, citedBy: 14, isOrchestrator: true, state: 'working', host: 'alpha' },
      { id: 'atlas/core/solver', uid: '01ARZ3NDEKTSV4RRFFQ69G5FA2', name: 'Solver', continent: 'atlas', area: 'atlas/core', parent: 'atlas/core/lead', citedBy: 8, state: 'ask', host: 'alpha' },
      { id: 'atlas/core/check', uid: '01ARZ3NDEKTSV4RRFFQ69G5FA3', name: 'Check', continent: 'atlas', area: 'atlas/core', parent: 'atlas/core/lead', citedBy: 1, state: 'resting', host: 'beta' },
      { id: 'atlas/core/audit', uid: '01ARZ3NDEKTSV4RRFFQ69G5FA4', name: 'Audit', continent: 'atlas', area: 'atlas/core', parent: 'atlas/core/lead', citedBy: 3, state: 'closed', tempered: true, host: 'alpha' },
      { id: 'atlas/core/draft', uid: '01ARZ3NDEKTSV4RRFFQ69G5FA5', name: 'Draft', continent: 'atlas', area: 'atlas/core', parent: 'atlas/core/lead', citedBy: 0, state: 'draft', host: 'beta' },
      { id: 'atlas/sim/sweep', uid: '01ARZ3NDEKTSV4RRFFQ69G5FA6', name: 'Sweep', continent: 'atlas', area: 'atlas/sim', parent: 'atlas/core/lead', citedBy: 5, state: 'working', host: 'beta' },
      { id: 'atlas/sim/plot', uid: '01ARZ3NDEKTSV4RRFFQ69G5FA7', name: 'Plot', continent: 'atlas', area: 'atlas/sim', parent: 'atlas/sim/sweep', citedBy: 1, state: 'resting', host: 'alpha' },
      { id: 'atlas/docs/guide', uid: '01ARZ3NDEKTSV4RRFFQ69G5FA8', name: 'Guide', continent: 'atlas', area: 'atlas/docs', parent: null, citedBy: 4, state: 'resting', host: 'alpha' },
      { id: 'beacon/engine/core', uid: '01ARZ3NDEKTSV4RRFFQ69G5FA9', name: 'Engine Core', continent: 'beacon', area: 'beacon/engine', parent: null, citedBy: 9, isOrchestrator: true, state: 'working', host: 'beta' },
      { id: 'beacon/engine/io', uid: '01ARZ3NDEKTSV4RRFFQ69G5FAA', name: 'IO', continent: 'beacon', area: 'beacon/engine', parent: 'beacon/engine/core', citedBy: 2, state: 'ask', host: 'beta' },
      { id: 'beacon/engine/bench', uid: '01ARZ3NDEKTSV4RRFFQ69G5FAB', name: 'Bench', continent: 'beacon', area: 'beacon/engine', parent: 'beacon/engine/core', citedBy: 1, state: 'closed', tempered: false, host: 'alpha' },
      { id: 'beacon/ui/board', uid: '01ARZ3NDEKTSV4RRFFQ69G5FAC', name: 'Board', continent: 'beacon', area: 'beacon/ui', parent: 'beacon/engine/core', citedBy: 6, state: 'working', host: 'alpha' },
      { id: 'beacon/ui/theme', uid: '01ARZ3NDEKTSV4RRFFQ69G5FAD', name: 'Theme', continent: 'beacon', area: 'beacon/ui', parent: 'beacon/ui/board', citedBy: 1, state: 'resting', host: 'alpha' },
      { id: 'harbor/dock/api', uid: '01ARZ3NDEKTSV4RRFFQ69G5FAE', name: 'Dock API', continent: 'harbor', area: 'harbor/dock', parent: null, citedBy: 7, isOrchestrator: true, state: 'resting', host: 'gamma' },
      { id: 'harbor/dock/sync', uid: '01ARZ3NDEKTSV4RRFFQ69G5FAF', name: 'Sync', continent: 'harbor', area: 'harbor/dock', parent: 'harbor/dock/api', citedBy: 2, state: 'working', host: 'gamma' },
      { id: 'harbor/dock/auth', uid: '01ARZ3NDEKTSV4RRFFQ69G5FAG', name: 'Auth', continent: 'harbor', area: 'harbor/dock', parent: 'harbor/dock/api', citedBy: 1, state: 'resting', host: 'alpha' },
      { id: 'guild/roles/op', uid: '01ARZ3NDEKTSV4RRFFQ69G5FAH', name: 'Operator', continent: 'guild', area: 'guild/roles', parent: null, citedBy: 8, state: 'resting', host: 'alpha' },
      { id: 'guild/roles/watch', uid: '01ARZ3NDEKTSV4RRFFQ69G5FAJ', name: 'Watch', continent: 'guild', area: 'guild/roles', parent: null, citedBy: 3, state: 'working', host: 'beta' },
    ],
  }
}

describe('map layout geometry & determinism', () => {
  it('aperture-4 dilates without rotating: parent(nest(p)) == p and children(p) all have parent p', () => {
    expect(nest({ q: 1, r: 0 })).toEqual({ q: 2, r: 0 })
    expect(nest({ q: 0, r: 1 })).toEqual({ q: 0, r: 2 })
    expect(nest({ q: 3, r: -2 }, 3)).toEqual({ q: 24, r: -16 })
    for (let q = -6; q <= 6; q++) {
      for (let r = -6; r <= 6; r++) {
        const p = { q, r }
        expect(parent(nest(p))).toEqual(p)
        for (const c of children(p)) {
          expect(parent(c)).toEqual(p)
        }
      }
    }
    expect(birth({ uid: '7ZZZZZZZZZ0000000000000000' })).toBeGreaterThan(Date.now())
  })

  it('younger ULID arrivals move zero existing city hexes', () => {
    const base = syntheticBundle()
    const before = layout(base)
    const beforeCoords = new Map(before.fibers.map(n => [n.id, key(n)]))

    const younger = Array.from({ length: 6 }, (_, i) => ({
      id: `atlas/core/new-child-${i}`,
      uid: `7ZZZZZZZZZ000000000000000${i}`,
      name: `New Child ${i}`,
      continent: 'atlas',
      area: 'atlas/core',
      parent: 'atlas/core/lead',
      citedBy: 1,
      state: 'working',
      host: 'gamma',
    }))
    const grown: TerrainBundle = {
      ...base,
      cities: [...base.cities, ...younger],
      continents: base.continents.map(c => (c.id === 'atlas' ? { ...c, total: c.total + 6, cities: c.cities + 6 } : c)),
    }
    const after = layout(grown)
    const afterCoords = new Map(after.fibers.map(n => [n.id, key(n)]))

    let moved = 0
    for (const [id, coord] of beforeCoords) {
      if (afterCoords.get(id) !== coord) moved++
    }
    expect(moved).toBe(0)
    expect(new Set(afterCoords.values()).size).toBe(base.cities.length + younger.length)
  })

  it('is invariant to input ordering and state/host edits', () => {
    const base = syntheticBundle()
    const before = layout(base)
    const beforeCoords = new Map(before.fibers.map(n => [n.id, key(n)]))

    const permuted: TerrainBundle = {
      ...base,
      continents: [...base.continents].reverse(),
      areas: [...base.areas].reverse(),
      cities: [...base.cities].reverse().map(n => ({ ...n, state: 'ask', host: 'delta' })),
    }
    const after = layout(permuted)
    const afterCoords = new Map(after.fibers.map(n => [n.id, key(n)]))

    expect(afterCoords).toEqual(beforeCoords)
  })

  it('maintains exact aperture-4 L1 -> L2 -> L3 parent consistency and land-only roads/rivers', () => {
    const atlas = layout(syntheticBundle())
    expect(atlas.level2.length).toBe(atlas.level1.length * 4)
    const l1Keys = new Set(atlas.level1.map(c => key(c)))
    const l2Map = new Map(atlas.level2.map(t => [key(t), t]))

    for (const t of atlas.level2) {
      expect(key(parent(t))).toBe(t.cell)
      expect(l1Keys.has(t.cell)).toBe(true)
    }
    for (const m of atlas.level3) {
      expect(key(parent(m))).toBe(m.parentTile)
      expect(l2Map.get(m.parentTile)?.splitL3).toBe(true)
      expect(key(parent(parent(m)))).toBe(m.cell)
    }
    for (const p of [...atlas.roads, ...atlas.rivers]) {
      for (const x of p.points) expect(l2Map.has(key(x))).toBe(true)
      for (let i = 1; i < p.points.length; i++) {
        expect(distance(p.points[i - 1], p.points[i])).toBe(1)
      }
    }
    for (const l of atlas.lanes) {
      for (const pt of l.points.filter(x => x.sea)) {
        expect(l2Map.has(key(unworld(pt)))).toBe(false)
      }
    }
    expect(landCells({ total: 240, topLevelBreadth: 72, cities: 8, kind: 'project' })).toBeGreaterThan(
      landCells({ total: 240, topLevelBreadth: 3, cities: 8, kind: 'project' }) + 12,
    )
  })

  it('assigns biomes/seas generically without hardcoded project names and respects mapConfig.seas & pins', () => {
    // Deterministic fallback into the 4 canonical biome palettes for arbitrary ids
    for (const id of ['alpha-project', 'beta-lab', 'gamma-ops', 'delta-notes']) {
      const b = normalizeBiome(undefined, id)
      expect(BIOME_IDS).toContain(b)
      expect(normalizeBiome(undefined, id)).toBe(b)
    }
    // Accepts canonical biome names and regional aliases
    expect(normalizeBiome('science', 'x')).toBe('mediterranean')
    expect(normalizeBiome('mill-ai', 'x')).toBe('temperate')
    expect(normalizeBiome('life-guild', 'x')).toBe('savanna')
    expect(normalizeBiome('nordic', 'x')).toBe('nordic')

    // Honors optional mapConfig.seas and pins from terrain payload
    const base = syntheticBundle()
    const withConfig: TerrainBundle = {
      ...base,
      mapConfig: {
        seas: {
          atlas: { sea: 'science', x: -10, z: 8 },
          beacon: { sea: 'mill-ai', x: 10, z: -6 },
          harbor: 'nordic',
        },
      },
    }
    const atlas = layout(withConfig)
    const contMap = new Map(atlas.continents.map(c => [c.id, c]))
    expect(biomeOf('atlas', contMap)).toBe('mediterranean')
    expect(biomeOf('beacon', contMap)).toBe('temperate')
    expect(biomeOf('harbor', contMap)).toBe('nordic')
    expect(BIOME_IDS).toContain(biomeOf('guild', contMap))

    // Pins translate continent and detect ocean-buffer collisions
    const shoals = contMap.get('shoals')!
    const pinned = layout(withConfig, { pins: { shoals: { q: shoals.q - 10, r: shoals.r } } })
    expect(pinned.continents.find(c => c.id === 'shoals')?.q).toBe(shoals.q - 10)
    const atlasCont = contMap.get('atlas')!
    expect(() => layout(withConfig, { pins: { beacon: { q: atlasCont.q, r: atlasCont.r } } })).toThrow(/Ocean buffer/)
  })
})

describe('cityState & composite snapshot merge', () => {
  it('preserves column + turn priority so asking workers stay ask even when runtime.state is running', () => {
    expect(cityState({ column: 'in_flight', turn: 'question' })).toBe('ask')
    expect(cityState({ column: 'in_flight', turn: 'blocked' })).toBe('ask')
    expect(cityState({ column: 'in_flight', turn: 'idle' })).toBe('ask')
    expect(cityState({ column: 'awaiting_review', turn: null })).toBe('ask')
    expect(cityState({ column: 'in_flight', turn: null })).toBe('working')
    expect(cityState({ column: 'tempered', turn: 'question' })).toBe('closed')
    expect(cityState({ column: 'discarded' })).toBe('closed')
    expect(cityState({ column: 'drafts' })).toBe('draft')
    expect(cityState({ column: 'resting' })).toBe('resting')

    const base = syntheticBundle()
    const merged = mergeCompositeSnapshot(base.cities, {
      origins: { delta: { stale: false, fibers: 2 } },
      fibers: [
        {
          uid: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
          column: 'in_flight',
          turn: 'question',
          origin: 'delta',
          runtime: { state: 'running' },
        },
        {
          uid: '01ARZ3NDEKTSV4RRFFQ69G5FA3',
          column: 'in_flight',
          turn: null,
          origin: 'beta',
          runtime: { state: 'running' },
        },
      ],
    })
    expect(merged.matched).toBe(2)
    expect(merged.changed).toBe(true)
    expect(merged.cities.find(c => c.id === 'atlas/core/lead')?.state).toBe('ask')
    expect(merged.cities.find(c => c.id === 'atlas/core/lead')?.host).toBe('delta')
    expect(merged.cities.find(c => c.id === 'atlas/core/check')?.state).toBe('working')

    // Host list and deterministic dot colors
    const hosts = collectHosts({ origins: merged.origins, cities: merged.cities })
    expect(hosts).toEqual(['alpha', 'beta', 'delta', 'gamma'])
    expect(hostColor('alpha')).toBe(hostColor('alpha'))
    expect(hostColor('alpha')).toMatch(/^#[0-9a-f]{6}$/i)
  })
})

describe('localHour', () => {
  it('returns fractional 24-hour wall-clock hour in [0, 24) across zones and DST', () => {
    const summer = Date.UTC(2026, 6, 15, 14, 30, 0)
    expect(localHour(summer, zone('UTC'))).toBeCloseTo(14.5, 6)
    expect(localHour(summer, zone('America/Los_Angeles'))).toBeCloseTo(7.5, 6)
    expect(localHour(summer, zone('Europe/Paris'))).toBeCloseTo(16.5, 6)

    const winter = Date.UTC(2026, 0, 15, 14, 30, 0)
    expect(localHour(winter, zone('America/Los_Angeles'))).toBeCloseTo(6.5, 6)

    // Wraps cleanly past midnight into [0, 24).
    const lateUtc = Date.UTC(2026, 6, 15, 23, 45, 0)
    expect(localHour(lateUtc, zone('Asia/Tokyo'))).toBeCloseTo(8.75, 6)
    expect(localHour(Date.UTC(2026, 6, 15, 0, 0, 0), zone('UTC'))).toBe(0)
  })
})
