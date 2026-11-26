import type { TerrainBundle } from '../src/map/types.js'

/**
 * Hygiene-safe synthetic archipelago for `?page=map` in the mocked-daemon harness.
 * Stages the exact fleet distribution that motivated separating urgent live asks
 * from awaiting-review deliverables and idle live workers:
 * - Meridian: 0 urgent asks, 12 awaiting-review pavilions, 2 idle live workers
 * - Solstice: 1 urgent question lighthouse, 9 awaiting-review pavilions, 1 idle orchestrator
 * - Pelagic:  1 urgent blocked lighthouse, 3 awaiting-review pavilions
 * - Vesper:   0 urgent asks, 2 awaiting-review pavilions, active forges & cottages
 * - Guild:    resting seats and standing runner
 */
export function mapTerrainFixture(): TerrainBundle {
  const meridianReviews = [
    ['meridian/catalog/psf-fit', '01KVMP00000000000000000101', 'PSF residual fit', 'meridian/catalog', 'meridian/catalog/lead', 'umber', true],
    ['meridian/catalog/mask-audit', '01KVMP00000000000000000102', 'Survey mask audit', 'meridian/catalog', 'meridian/catalog/lead', 'umber', false],
    ['meridian/catalog/star-cut', '01KVMP00000000000000000103', 'Star-galaxy cut check', 'meridian/catalog', 'meridian/catalog/lead', 'basalt', false],
    ['meridian/catalog/depth-map', '01KVMP00000000000000000104', 'Depth weight map', 'meridian/catalog', 'meridian/catalog/lead', 'basalt', true],
    ['meridian/shear/bmodes', '01KVMP00000000000000000105', 'B-mode null suite', 'meridian/shear', 'meridian/shear/lead', 'umber', true],
    ['meridian/shear/cov-blocks', '01KVMP00000000000000000106', 'Covariance block test', 'meridian/shear', 'meridian/shear/lead', 'basalt', false],
    ['meridian/shear/tomo-bins', '01KVMP00000000000000000107', 'Tomographic bin edges', 'meridian/shear', 'meridian/shear/lead', 'umber', false],
    ['meridian/shear/blind-check', '01KVMP00000000000000000108', 'Blinding ledger check', 'meridian/shear', 'meridian/shear/lead', 'cedar', false],
    ['meridian/photoz/som-cal', '01KVMP00000000000000000109', 'SOM calibration report', 'meridian/photoz', 'meridian/catalog/lead', 'umber', true],
    ['meridian/photoz/outlier', '01KVMP00000000000000000110', 'Outlier tail sweep', 'meridian/photoz', 'meridian/catalog/lead', 'cedar', false],
    ['meridian/photoz/shift-prior', '01KVMP00000000000000000111', 'Mean-z shift prior', 'meridian/photoz', 'meridian/catalog/lead', 'basalt', false],
    ['meridian/docs/release-note', '01KVMP00000000000000000112', 'Data release summary', 'meridian/docs', 'meridian/catalog/lead', 'umber', false],
  ] as const

  const solsticeReviews = [
    ['solstice/spectra/beam-win', '01KVMP00000000000000000201', 'Beam window function', 'solstice/spectra', 'solstice/spectra/lead', 'basalt', true],
    ['solstice/spectra/fg-clean', '01KVMP00000000000000000202', 'Foreground cleaning pass', 'solstice/spectra', 'solstice/spectra/lead', 'basalt', false],
    ['solstice/spectra/bandpower', '01KVMP00000000000000000203', 'Bandpower binning check', 'solstice/spectra', 'solstice/spectra/lead', 'umber', false],
    ['solstice/spectra/transfer', '01KVMP00000000000000000204', 'Transfer function verify', 'solstice/spectra', 'solstice/spectra/lead', 'cedar', false],
    ['solstice/cross/kappa-gal', '01KVMP00000000000000000205', 'Kappa-galaxy cross run', 'solstice/cross', 'solstice/spectra/lead', 'basalt', true],
    ['solstice/cross/bias-fit', '01KVMP00000000000000000206', 'Linear bias amplitude', 'solstice/cross', 'solstice/spectra/lead', 'umber', false],
    ['solstice/cross/jackknife', '01KVMP00000000000000000207', 'Jackknife variance check', 'solstice/cross', 'solstice/spectra/lead', 'basalt', false],
    ['solstice/mocks/sim-grid', '01KVMP00000000000000000208', 'Synthetic mock grid', 'solstice/mocks', 'solstice/spectra/lead', 'cedar', false],
    ['solstice/mocks/noise-real', '01KVMP00000000000000000209', 'Noise realization pack', 'solstice/mocks', 'solstice/spectra/lead', 'umber', false],
  ] as const

  return {
    generatedAt: '2026-11-26T22:00:00Z',
    origins: {
      umber: { stale: false, fibers: 28 },
      basalt: { stale: false, fibers: 19 },
      cedar: { stale: false, fibers: 11 },
    },
    mapConfig: {
      seas: {
        meridian: { sea: 'science', biome: 'mediterranean', x: -16, z: 4 },
        solstice: { sea: 'science', biome: 'temperate', x: 14, z: 6 },
        pelagic: { sea: 'northern', biome: 'nordic', x: -2, z: -18 },
        vesper: { sea: 'southern', biome: 'savanna', x: 22, z: -14 },
        guild: { sea: 'west', biome: 'savanna', x: -34, z: -8 },
      },
    },
    continents: [
      { id: 'meridian', name: 'Meridian', kind: 'project', shared: true, total: 540, cities: 18, citedBy: 1240, maxDepth: 6, topLevelBreadth: 12, recentRatio: 0.34, decisionCount: 16 },
      { id: 'solstice', name: 'Solstice', kind: 'project', shared: true, total: 430, cities: 15, citedBy: 980, maxDepth: 5, topLevelBreadth: 10, recentRatio: 0.42, decisionCount: 12 },
      { id: 'pelagic', name: 'Pelagic', kind: 'project', shared: false, total: 240, cities: 7, citedBy: 410, maxDepth: 4, topLevelBreadth: 7, recentRatio: 0.28, decisionCount: 6 },
      { id: 'vesper', name: 'Vesper', kind: 'project', shared: false, total: 195, cities: 6, citedBy: 290, maxDepth: 3, topLevelBreadth: 6, recentRatio: 0.31, decisionCount: 4 },
      { id: 'guild', name: 'Guild', kind: 'guild', shared: false, total: 160, cities: 3, citedBy: 310, maxDepth: 3, topLevelBreadth: 5, recentRatio: 0.2, decisionCount: 9 },
      { id: 'shoals', name: 'Shoals', kind: 'shoals', shared: false, total: 6, cities: 0, citedBy: 8, maxDepth: 1, topLevelBreadth: 1, recentRatio: 0.4, decisionCount: 0 },
    ],
    areas: [
      { id: 'meridian/catalog', name: 'Catalog', continent: 'meridian', mass: 190, cities: 6, citedBy: 520, maxDepth: 6, shared: true, sampleFibers: ['PSF residual fit', 'Survey mask audit'] },
      { id: 'meridian/shear', name: 'Shear', continent: 'meridian', mass: 165, cities: 6, citedBy: 440, maxDepth: 5, shared: true, sampleFibers: ['B-mode null suite', 'Covariance block test'] },
      { id: 'meridian/photoz', name: 'Photo-z', continent: 'meridian', mass: 115, cities: 4, citedBy: 190, maxDepth: 4, shared: true, sampleFibers: ['SOM calibration report'] },
      { id: 'meridian/docs', name: 'Docs', continent: 'meridian', mass: 70, cities: 2, citedBy: 90, maxDepth: 3, shared: true, sampleFibers: ['Data release summary'] },
      { id: 'solstice/spectra', name: 'Spectra', continent: 'solstice', mass: 195, cities: 7, citedBy: 510, maxDepth: 5, shared: true, sampleFibers: ['Beam window function'] },
      { id: 'solstice/cross', name: 'Cross', continent: 'solstice', mass: 135, cities: 5, citedBy: 310, maxDepth: 4, shared: true, sampleFibers: ['Kappa-galaxy cross run'] },
      { id: 'solstice/mocks', name: 'Mocks', continent: 'solstice', mass: 100, cities: 3, citedBy: 160, maxDepth: 3, shared: true, sampleFibers: ['Synthetic mock grid'] },
      { id: 'pelagic/engine', name: 'Engine', continent: 'pelagic', mass: 150, cities: 4, citedBy: 260, maxDepth: 4, sampleFibers: ['Scheduler queue'] },
      { id: 'pelagic/ui', name: 'Interface', continent: 'pelagic', mass: 90, cities: 3, citedBy: 150, maxDepth: 3, sampleFibers: ['Map triage'] },
      { id: 'vesper/chains', name: 'Chains', continent: 'vesper', mass: 115, cities: 4, citedBy: 180, maxDepth: 3, sampleFibers: ['Posterior sampling'] },
      { id: 'vesper/plots', name: 'Figures', continent: 'vesper', mass: 80, cities: 2, citedBy: 110, maxDepth: 2, sampleFibers: ['Corner comparison'] },
      { id: 'guild/roles', name: 'Roles', continent: 'guild', mass: 160, cities: 3, citedBy: 310, maxDepth: 3, sampleFibers: ['Steward', 'Reviewer'] },
    ],
    areaLinks: [
      { a: 'meridian/catalog', b: 'meridian/shear', w: 32 },
      { a: 'meridian/shear', b: 'meridian/photoz', w: 22 },
      { a: 'meridian/catalog', b: 'meridian/docs', w: 12 },
      { a: 'solstice/spectra', b: 'solstice/cross', w: 26 },
      { a: 'solstice/cross', b: 'solstice/mocks', w: 18 },
      { a: 'pelagic/engine', b: 'pelagic/ui', w: 19 },
      { a: 'vesper/chains', b: 'vesper/plots', w: 15 },
    ],
    domainLinks: [
      { a: 'meridian', b: 'solstice', w: 28 },
      { a: 'meridian', b: 'pelagic', w: 14 },
      { a: 'solstice', b: 'vesper', w: 12 },
      { a: 'pelagic', b: 'vesper', w: 9 },
    ],
    cities: [
      // Meridian: 0 asks, 12 awaiting_review, 2 idle live workers (must render working, NOT lighthouses!), 2 active forges, 2 settled
      { id: 'meridian/catalog/lead', uid: '01KVMP00000000000000000001', name: 'Meridian Steward', continent: 'meridian', area: 'meridian/catalog', parent: null, citedBy: 22, isOrchestrator: true, hasTapestry: true, state: 'working', column: 'in_flight', turn: 'idle', host: 'umber', origin: 'umber', channel: 'meridian' },
      { id: 'meridian/shear/lead', uid: '01KVMP00000000000000000002', name: 'Shear Coordinator', continent: 'meridian', area: 'meridian/shear', parent: 'meridian/catalog/lead', citedBy: 14, isOrchestrator: true, state: 'working', column: 'in_flight', turn: 'working', host: 'basalt', origin: 'basalt', channel: 'meridian' },
      { id: 'meridian/shear/emcee', uid: '01KVMP00000000000000000003', name: 'Likelihood sweep', continent: 'meridian', area: 'meridian/shear', parent: 'meridian/shear/lead', citedBy: 7, state: 'working', column: 'in_flight', turn: 'idle', host: 'basalt', origin: 'basalt', channel: 'meridian' },
      { id: 'meridian/photoz/drift', uid: '01KVMP00000000000000000004', name: 'Redshift drift check', continent: 'meridian', area: 'meridian/photoz', parent: 'meridian/catalog/lead', citedBy: 5, state: 'working', column: 'in_flight', turn: 'working', host: 'umber', origin: 'umber', channel: 'meridian' },
      { id: 'meridian/docs/glossary', uid: '01KVMP00000000000000000005', name: 'Pipeline glossary', continent: 'meridian', area: 'meridian/docs', parent: 'meridian/catalog/lead', citedBy: 3, state: 'closed', column: 'tempered', tempered: true, host: 'umber', origin: 'umber' },
      { id: 'meridian/catalog/legacy', uid: '01KVMP00000000000000000006', name: 'Old tile index', continent: 'meridian', area: 'meridian/catalog', parent: 'meridian/catalog/lead', citedBy: 1, state: 'closed', column: 'discarded', tempered: false, host: 'umber', origin: 'umber' },
      ...meridianReviews.map(([id, uid, name, area, parent, host, hasTapestry]) => ({
        id,
        uid,
        name,
        continent: 'meridian',
        area,
        parent,
        citedBy: 4,
        state: 'review' as const,
        column: 'awaiting_review',
        turn: 'none',
        status: 'closed',
        host,
        origin: host,
        channel: 'meridian',
        hasTapestry,
        outcome: `${name} completed its verification suite and is ready for a human verdict.`,
      })),

      // Solstice: 1 urgent live question (Lighthouse!), 9 awaiting_review, 1 idle orchestrator, 2 working, 2 resting
      { id: 'solstice/spectra/lead', uid: '01KVMP00000000000000000010', name: 'Solstice Steward', continent: 'solstice', area: 'solstice/spectra', parent: null, citedBy: 18, isOrchestrator: true, hasTapestry: true, state: 'working', column: 'in_flight', turn: 'idle', host: 'basalt', origin: 'basalt', channel: 'solstice' },
      { id: 'solstice/cross/mask-choice', uid: '01KVMP00000000000000000011', name: 'Apodization threshold ask', continent: 'solstice', area: 'solstice/cross', parent: 'solstice/spectra/lead', citedBy: 11, state: 'ask', column: 'in_flight', turn: 'question', host: 'basalt', origin: 'basalt', channel: 'solstice', outcome: 'Waiting on whether to tighten the galactic plane mask before the final run.' },
      { id: 'solstice/spectra/cov-run', uid: '01KVMP00000000000000000012', name: 'Sim covariance run', continent: 'solstice', area: 'solstice/spectra', parent: 'solstice/spectra/lead', citedBy: 6, state: 'working', column: 'in_flight', turn: 'working', host: 'cedar', origin: 'cedar', channel: 'solstice' },
      { id: 'solstice/cross/nulls', uid: '01KVMP00000000000000000013', name: 'Curl-mode check', continent: 'solstice', area: 'solstice/cross', parent: 'solstice/spectra/lead', citedBy: 4, state: 'working', column: 'in_flight', turn: 'working', host: 'umber', origin: 'umber', channel: 'solstice' },
      { id: 'solstice/mocks/seed-bank', uid: '01KVMP00000000000000000014', name: 'Seed bank archive', continent: 'solstice', area: 'solstice/mocks', parent: 'solstice/spectra/lead', citedBy: 2, state: 'resting', column: 'resting', turn: 'none', host: 'cedar', origin: 'cedar' },
      { id: 'solstice/spectra/notes', uid: '01KVMP00000000000000000015', name: 'Window memo', continent: 'solstice', area: 'solstice/spectra', parent: 'solstice/spectra/lead', citedBy: 2, state: 'closed', column: 'tempered', tempered: true, host: 'umber', origin: 'umber' },
      ...solsticeReviews.map(([id, uid, name, area, parent, host, hasTapestry]) => ({
        id,
        uid,
        name,
        continent: 'solstice',
        area,
        parent,
        citedBy: 3,
        state: 'review' as const,
        column: 'awaiting_review',
        turn: 'none',
        status: 'closed',
        host,
        origin: host,
        channel: 'solstice',
        hasTapestry,
        outcome: `${name} produced clean diagnostics and awaits review.`,
      })),

      // Pelagic: 1 urgent blocked lighthouse, 3 awaiting_review, 1 working, 2 resting
      { id: 'pelagic/engine/lead', uid: '01KVMP00000000000000000020', name: 'Pelagic Dispatcher', continent: 'pelagic', area: 'pelagic/engine', parent: null, citedBy: 12, isOrchestrator: true, state: 'working', column: 'in_flight', turn: 'working', host: 'umber', origin: 'umber', channel: 'pelagic' },
      { id: 'pelagic/engine/auth-block', uid: '01KVMP00000000000000000021', name: 'Remote tunnel blocked', continent: 'pelagic', area: 'pelagic/engine', parent: 'pelagic/engine/lead', citedBy: 8, state: 'ask', column: 'in_flight', turn: 'blocked', host: 'cedar', origin: 'cedar', channel: 'pelagic', outcome: 'Worker launch blocked waiting on credential refresh.' },
      { id: 'pelagic/ui/triage', uid: '01KVMP00000000000000000022', name: 'Map triage pass', continent: 'pelagic', area: 'pelagic/ui', parent: 'pelagic/engine/lead', citedBy: 5, state: 'review', column: 'awaiting_review', turn: 'none', status: 'closed', host: 'umber', origin: 'umber', channel: 'pelagic', outcome: 'Separated urgent asks from review pavilions.' },
      { id: 'pelagic/ui/palette', uid: '01KVMP00000000000000000023', name: 'Night palette balance', continent: 'pelagic', area: 'pelagic/ui', parent: 'pelagic/engine/lead', citedBy: 3, state: 'review', column: 'awaiting_review', turn: 'none', status: 'closed', host: 'umber', origin: 'umber', channel: 'pelagic', outcome: 'Balanced coastal contrast at night.' },
      { id: 'pelagic/engine/cache', uid: '01KVMP00000000000000000024', name: 'Snapshot ETag cache', continent: 'pelagic', area: 'pelagic/engine', parent: 'pelagic/engine/lead', citedBy: 4, state: 'review', column: 'awaiting_review', turn: 'none', status: 'closed', host: 'basalt', origin: 'basalt', channel: 'pelagic', outcome: 'ETag cache verified under load.' },
      { id: 'pelagic/ui/shortcuts', uid: '01KVMP00000000000000000025', name: 'Keyboard legend', continent: 'pelagic', area: 'pelagic/ui', parent: 'pelagic/engine/lead', citedBy: 2, state: 'resting', column: 'resting', turn: 'none', host: 'umber', origin: 'umber' },
      { id: 'pelagic/engine/hooks', uid: '01KVMP00000000000000000026', name: 'Hook audit', continent: 'pelagic', area: 'pelagic/engine', parent: 'pelagic/engine/lead', citedBy: 2, state: 'closed', column: 'tempered', tempered: true, host: 'umber', origin: 'umber' },

      // Vesper: 0 urgent asks, 2 awaiting_review, 2 working, 2 resting/closed
      { id: 'vesper/chains/lead', uid: '01KVMP00000000000000000030', name: 'Chain Runner', continent: 'vesper', area: 'vesper/chains', parent: null, citedBy: 9, isOrchestrator: true, state: 'working', column: 'in_flight', turn: 'working', host: 'basalt', origin: 'basalt', channel: 'vesper' },
      { id: 'vesper/chains/gelman', uid: '01KVMP00000000000000000031', name: 'Convergence check', continent: 'vesper', area: 'vesper/chains', parent: 'vesper/chains/lead', citedBy: 5, state: 'review', column: 'awaiting_review', turn: 'none', status: 'closed', host: 'basalt', origin: 'basalt', channel: 'vesper', outcome: 'All chains reached R-1 < 0.01.' },
      { id: 'vesper/plots/contours', uid: '01KVMP00000000000000000032', name: 'Contour figure set', continent: 'vesper', area: 'vesper/plots', parent: 'vesper/chains/lead', citedBy: 4, state: 'review', column: 'awaiting_review', turn: 'none', status: 'closed', host: 'umber', origin: 'umber', channel: 'vesper', hasTapestry: true, outcome: 'Publication contour figures rendered.' },
      { id: 'vesper/chains/prior', uid: '01KVMP00000000000000000033', name: 'Prior sensitivity', continent: 'vesper', area: 'vesper/chains', parent: 'vesper/chains/lead', citedBy: 3, state: 'working', column: 'in_flight', turn: 'working', host: 'cedar', origin: 'cedar' },
      { id: 'vesper/plots/draft', uid: '01KVMP00000000000000000034', name: 'Slide export notes', continent: 'vesper', area: 'vesper/plots', parent: 'vesper/chains/lead', citedBy: 1, state: 'resting', column: 'resting', turn: 'none', host: 'umber', origin: 'umber' },
      { id: 'vesper/chains/aborted', uid: '01KVMP00000000000000000035', name: 'Test burn-in', continent: 'vesper', area: 'vesper/chains', parent: 'vesper/chains/lead', citedBy: 1, state: 'closed', column: 'discarded', tempered: false, host: 'basalt', origin: 'basalt' },

      // Guild
      { id: 'guild/roles/steward', uid: '01KVMP00000000000000000040', name: 'Fleet Steward', continent: 'guild', area: 'guild/roles', parent: null, citedBy: 10, isOrchestrator: true, state: 'resting', column: 'roles', turn: 'none', host: 'umber', origin: 'umber' },
      { id: 'guild/roles/digest', uid: '01KVMP00000000000000000041', name: 'Daily Digest', continent: 'guild', area: 'guild/roles', parent: null, citedBy: 6, state: 'working', column: 'in_flight', turn: 'working', kind: 'standing', host: 'umber', origin: 'umber' },
      { id: 'guild/roles/archivist', uid: '01KVMP00000000000000000042', name: 'Archivist', continent: 'guild', area: 'guild/roles', parent: null, citedBy: 4, state: 'resting', column: 'roles', turn: 'none', host: 'basalt', origin: 'basalt' },
    ],
  }
}
