import * as THREE from 'three'
import { localHour } from '../board/civilDay.js'
import { daemonErrorMessage, daemonFetch, isDaemonBooting, responseError } from '../board/daemonApi.js'
import {
  buildCitadel,
  buildCottage,
  buildCountryside,
  buildDiscardedRuin,
  buildForge,
  buildHarborPier,
  buildLighthouse,
  buildObservatory,
  buildRiparianFlora,
  buildRiverBridge,
  buildSailboatsForLane,
  buildTemperedVillage,
  buildTree,
  buildWorldWoodlands,
} from '../map/assets.js'
import {
  DIRECTIONS,
  RADIUS,
  biomeOf,
  distance,
  hash,
  key,
  layout,
  nest,
  world,
} from '../map/layout.js'
import '../map/map.css'
import {
  buildDetailMountainRanges,
  buildWorldCordilleras,
  computeMountainField,
  createMountainGeometries,
} from '../map/mountains.js'
import { collectHosts, hostColor, mergeCompositeSnapshot } from '../map/states.js'
import {
  SEA_Y,
  buildDrapedHexBorders,
  buildErodedTerrain,
  buildRiverWaterMesh,
  createErodedSampler,
  makeTerrainDetailTexture,
  type ErodedTerrainResult,
} from '../map/terrainMesh.js'
import type {
  AreaInput,
  AssetContext,
  AtlasLayout,
  Axial,
  BatchGroup,
  BatchItem,
  BiomeId,
  BiomePalette,
  BoatEntry,
  CoarseCell,
  ContinentSelection,
  FineTile,
  GeometryKind,
  HeightMode,
  LensState,
  LightingMode,
  MapTextures,
  MicroHex,
  MountainField,
  PickOwner,
  PinSelectionItem,
  PlacedArea,
  PlacedCity,
  PlacedContinent,
  RenderTier,
  SchemePalette,
  SignalEntry,
  SmokeEntry,
  TerrainBundle,
  TerrainSampler,
  TileOwner,
  WorldXZ,
} from '../map/types.js'
import { go } from './go.js'
import { threadHref, type PageRoute } from './route.js'

export const MAP_POLL_MS = 30_000
export const TERRAIN_TIMEOUT_MS = 45_000
const AUTO_LIGHT_MS = 60_000

function isNightHour(hour: number): boolean {
  return hour < 7 || hour >= 18
}

export interface MapPageOptions {
  base: string
  route: PageRoute
  navigate(href: string): void
}

const TERRAIN_ROLES = new Set([
  'land',
  'meadow',
  'valley',
  'highland',
  'alpine',
  'peak',
  'sand',
  'rock',
  'granite',
  'slate',
  'snow',
])

const BIOME_ROLES = new Set([
  'sand',
  'rock',
  'valley',
  'meadow',
  'land',
  'highland',
  'alpine',
  'peak',
  'leaf',
  'canopyLight',
  'crop',
  'granite',
  'slate',
  'snow',
  'spruce',
  'wall',
  'trim',
  'roof',
  'copper',
])

const SCHEMES: Record<'day' | 'night', SchemePalette> = {
  day: {
    sea: '#68aeb4',
    shallow: '#86cbc0',
    foam: '#c7ece0',
    sand: '#dfcf9c',
    rock: '#afa080',
    granite: '#8e9599',
    slate: '#646d73',
    snow: '#f1f5f8',
    spruce: '#234b35',
    land: '#79945a',
    meadow: '#a2b074',
    valley: '#588456',
    highland: '#969e74',
    alpine: '#cbbda0',
    peak: '#f4efe2',
    lane: '#e4f4ee',
    shared: '#d9a048',
    wall: '#f2e5be',
    trim: '#c4ae7f',
    roof: '#b85636',
    active: '#c45f33',
    dome: '#4c8b82',
    copper: '#ad6f4b',
    leaf: '#4e6d42',
    canopyLight: '#89ad58',
    crop: '#ceb066',
    trunk: '#7a6a4c',
    road: '#c6b898',
    river: '#4696ab',
    metal: '#82704a',
    window: '#627b76',
    amber: '#ffc568',
    white: '#fff5d6',
    smoke: '#dfd4bc',
    host: '#8b9e91',
    ao: '#1a2d30',
  },
  night: {
    sea: '#1b374b',
    shallow: '#284b5c',
    foam: '#416370',
    sand: '#5c6964',
    rock: '#41515f',
    granite: '#50606c',
    slate: '#374653',
    snow: '#c4d3df',
    spruce: '#183735',
    land: '#4d5e63',
    meadow: '#546567',
    valley: '#3b5e5d',
    highland: '#637074',
    alpine: '#7d8888',
    peak: '#b6c2c0',
    lane: '#8ab6c8',
    shared: '#e5ae52',
    wall: '#8b8b7a',
    trim: '#505b60',
    roof: '#3a4651',
    active: '#bd6b3a',
    dome: '#39716f',
    copper: '#9e7755',
    leaf: '#284445',
    canopyLight: '#3d645b',
    crop: '#64634b',
    trunk: '#39494d',
    road: '#736854',
    river: '#255c78',
    metal: '#b39159',
    window: '#e5af62',
    amber: '#ffd080',
    white: '#eee4c8',
    smoke: '#99a5a5',
    host: '#a4a784',
    ao: '#08131c',
  },
}

const BIOMES: Record<'day' | 'night', Record<BiomeId, BiomePalette>> = {
  day: {
    mediterranean: {
      sand: '#e6d5a4',
      rock: '#8c8e88',
      granite: '#989a95',
      slate: '#6e7270',
      snow: '#f3f6f8',
      spruce: '#284c32',
      valley: '#5a7c4b',
      meadow: '#b0b470',
      land: '#87985c',
      highland: '#a8a67e',
      alpine: '#d6ccb6',
      peak: '#f8f5ed',
      leaf: '#4e7342',
      canopyLight: '#8da952',
      crop: '#d5b970',
      wall: '#f6ecd4',
      trim: '#cab88f',
      roof: '#c85a35',
      copper: '#b4764c',
    },
    temperate: {
      sand: '#d2c89c',
      rock: '#768582',
      granite: '#889397',
      slate: '#5c6870',
      snow: '#eef4f8',
      spruce: '#1d4933',
      valley: '#2c6e50',
      meadow: '#5aa068',
      land: '#3b8558',
      highland: '#527b61',
      alpine: '#96a89b',
      peak: '#eef5f0',
      leaf: '#2d6b47',
      canopyLight: '#66ae61',
      crop: '#b4bd64',
      wall: '#efe4c4',
      trim: '#b8a883',
      roof: '#a3553e',
      copper: '#68847c',
    },
    savanna: {
      sand: '#edd496',
      rock: '#9c8874',
      granite: '#9e9286',
      slate: '#746a62',
      snow: '#f5f2ea',
      spruce: '#425a34',
      valley: '#9f8d45',
      meadow: '#e2c268',
      land: '#c8a454',
      highland: '#b98850',
      alpine: '#d5b38c',
      peak: '#f6ebd6',
      leaf: '#c67836',
      canopyLight: '#e0a844',
      crop: '#dfb052',
      wall: '#f2dfb8',
      trim: '#c5a774',
      roof: '#9b4a2b',
      copper: '#a86c40',
    },
    nordic: {
      sand: '#bdc4bc',
      rock: '#738290',
      granite: '#8592a0',
      slate: '#586675',
      snow: '#eef5fc',
      spruce: '#1e424b',
      valley: '#3f6871',
      meadow: '#749398',
      land: '#5b7c84',
      highland: '#728092',
      alpine: '#adb8c4',
      peak: '#eff5fb',
      leaf: '#335c64',
      canopyLight: '#649488',
      crop: '#929e76',
      wall: '#e6ecef',
      trim: '#9caab4',
      roof: '#465464',
      copper: '#5c6d7a',
    },
  },
  night: {
    mediterranean: {
      sand: '#656d5d',
      rock: '#4c575c',
      granite: '#58646c',
      slate: '#3d4953',
      snow: '#c7d5e0',
      spruce: '#1a3633',
      valley: '#39554b',
      meadow: '#5e6d57',
      land: '#4d5f54',
      highland: '#68726a',
      alpine: '#8d958e',
      peak: '#cbd3ce',
      leaf: '#2d4d42',
      canopyLight: '#466a54',
      crop: '#6a674d',
      wall: '#94927f',
      trim: '#5a6367',
      roof: '#51474e',
      copper: '#a27c5a',
    },
    temperate: {
      sand: '#52655e',
      rock: '#3c5059',
      granite: '#4d5e6a',
      slate: '#344450',
      snow: '#bed0de',
      spruce: '#143331',
      valley: '#1f4f4b',
      meadow: '#366a5b',
      land: '#295950',
      highland: '#3d635d',
      alpine: '#687e7d',
      peak: '#b5ccc9',
      leaf: '#1d463f',
      canopyLight: '#346a5a',
      crop: '#4e634e',
      wall: '#8c8c7b',
      trim: '#4f5c62',
      roof: '#484852',
      copper: '#5f7d78',
    },
    savanna: {
      sand: '#746850',
      rock: '#5a514c',
      granite: '#615c5a',
      slate: '#454244',
      snow: '#cacdc9',
      spruce: '#2a3d34',
      valley: '#595840',
      meadow: '#7a6c4a',
      land: '#6a5e46',
      highland: '#6f5948',
      alpine: '#8d7a68',
      peak: '#cabfa8',
      leaf: '#7d5438',
      canopyLight: '#927042',
      crop: '#7a6846',
      wall: '#928872',
      trim: '#5d574d',
      roof: '#52413e',
      copper: '#9b7350',
    },
    nordic: {
      sand: '#4d5d69',
      rock: '#3e4f62',
      granite: '#506174',
      slate: '#364658',
      snow: '#c3d5e7',
      spruce: '#152e3a',
      valley: '#284957',
      meadow: '#415f6c',
      land: '#355161',
      highland: '#48586c',
      alpine: '#728395',
      peak: '#c1d1e2',
      leaf: '#214450',
      canopyLight: '#315f67',
      crop: '#475856',
      wall: '#838f98',
      trim: '#495865',
      roof: '#313f4f',
      copper: '#4f606e',
    },
  },
}

function visH(rawH: number): number {
  const scaled = Math.max(0.15, Math.min(1.05, rawH * 0.38 + 0.06))
  return Math.round(scaled / 0.085) * 0.085
}

function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hexVerts(S: number, r: number): Array<[number, number]> {
  return Array.from({ length: 6 }, (_, k) => [S * (0.5 + r * Math.cos((k * Math.PI) / 3)), S * (0.5 - r * Math.sin((k * Math.PI) / 3))])
}

function strokeHexBevel(ctx: CanvasRenderingContext2D, S: number, lightA = 0.36, darkA = 0.22, r = 0.472, lw = 2.2): void {
  const v = hexVerts(S, r)
  ctx.lineWidth = lw
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (let k = 0; k < 6; k++) {
    const a = v[k]
    const b = v[(k + 1) % 6]
    const sunlit = k >= 3
    ctx.beginPath()
    ctx.moveTo(a[0], a[1])
    ctx.lineTo(b[0], b[1])
    ctx.strokeStyle = sunlit ? `rgba(255,253,242,${lightA})` : `rgba(38,54,50,${darkA})`
    ctx.stroke()
  }
  const outer = hexVerts(S, 0.492)
  ctx.beginPath()
  outer.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])))
  ctx.closePath()
  ctx.lineWidth = 1.2
  ctx.strokeStyle = 'rgba(36,52,48,.16)'
  ctx.stroke()
}

function smartTruncate(text: string | undefined, maxChars = 30): string {
  const s = String(text || '').trim().replace(/\s+/g, ' ')
  if (s.length <= maxChars) return s
  const slice = s.slice(0, maxChars - 1)
  const lastSpace = slice.lastIndexOf(' ')
  const cut = lastSpace >= Math.floor(maxChars * 0.45) ? slice.slice(0, lastSpace) : slice
  return cut.replace(/[,:;—–-]+$/, '').trimEnd() + '…'
}

function formatCount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function scoreQuery(qRaw: string, text: string | undefined): number {
  const q = qRaw.toLowerCase().trim()
  const t = String(text || '').toLowerCase()
  if (!q || !t) return 0
  if (t === q) return 120
  if (t.startsWith(q) || t.startsWith('/' + q)) return 95
  const idx = t.indexOf(q)
  if (idx !== -1) {
    const prev = idx > 0 ? t[idx - 1] : ' '
    const atWord = /[\s/_-]/.test(prev)
    return (atWord ? 86 : 72) - Math.min(20, idx * 0.3)
  }
  const tokens = q.split(/[\s/_-]+/).filter(Boolean)
  if (tokens.length > 1 && tokens.every(tok => t.includes(tok))) return 64
  return 0
}

function normEntityId(s: string | undefined): string {
  return String(s || '').toLowerCase().replace(/^\/+|\/+$/g, '').replace(/#outskirts$/, '')
}

function tierVisible(tier: RenderTier, lod: number): boolean {
  if (tier === 'all') return true
  if (tier === 'l0') return lod === 0
  if (tier === 'l1_only') return lod === 1
  if (tier === 'l12') return lod >= 1
  if (tier === 'l2_only') return lod === 2
  return true
}

type SearchResultItem =
  | { kind: 'continent'; score: number; title: string; badge: string; badgeClass: string; meta: string; target: PlacedContinent; areaMeta?: PlacedArea }
  | { kind: 'city'; score: number; title: string; badge: string; badgeClass: string; meta: string; target: PlacedCity; areaMeta?: PlacedArea }
  | { kind: 'area'; score: number; title: string; badge: string; badgeClass: string; meta: string; target: PlacedArea; continent: PlacedContinent; areaMeta?: PlacedArea }

interface LabelEntry {
  kind: 'continent' | 'area' | 'node' | 'subthread'
  isIslet?: boolean
  isSub?: boolean
  qualifiesOverview?: boolean
  textLen: number
  el: HTMLElement
  p: THREE.Vector3
  northP?: THREE.Vector3
  region?: string
  continent?: PlacedContinent
  area?: PlacedArea
  node?: PlacedCity
  sub?: MicroHex
}

/**
 * The interactive 3D Fleet Map page (`/map`).
 * Fetches terrain from `/api/v1/map/terrain`, renders the 3-tier aperture-4
 * diorama with hardware MSAA & texel-snapped orthographic panning, and polls
 * `/api/v1/fibers/composite` every 30s with ETag revalidation while visible.
 */
export class MapPage {
  readonly el = document.createElement('div')
  private readonly opts: MapPageOptions
  private readonly canvasHost = document.createElement('main')
  private readonly labelsEl = document.createElement('div')
  private readonly jumpsNav = document.createElement('nav')
  private readonly worldBtn = document.createElement('button')
  private readonly searchTrigger = document.createElement('button')
  private readonly topRight = document.createElement('div')
  private readonly modeGroup = document.createElement('div')
  private readonly modeButtons = new Map<LightingMode, HTMLButtonElement>()
  private readonly drawerEl = document.createElement('aside')
  private readonly rdBack = document.createElement('button')
  private readonly rdClose = document.createElement('button')
  private readonly rdTabs = document.createElement('div')
  private readonly rdActions = document.createElement('div')
  private readonly rdBadge = document.createElement('span')
  private readonly rdTitle = document.createElement('h2')
  private readonly rdPath = document.createElement('div')
  private readonly rdMeta = document.createElement('div')
  private readonly rdBody = document.createElement('div')
  private readonly searchModal = document.createElement('div')
  private readonly searchInput = document.createElement('input')
  private readonly searchCount = document.createElement('span')
  private readonly searchClose = document.createElement('button')
  private readonly searchList = document.createElement('ul')
  private readonly footerEl = document.createElement('footer')
  private readonly stateLensesEl = document.createElement('div')
  private readonly hostsDivider = document.createElement('div')
  private readonly hostsWrap = document.createElement('div')
  private readonly hostsTrigger = document.createElement('button')
  private readonly hostLensesEl = document.createElement('div')
  private readonly clearLensBtn = document.createElement('button')
  private readonly tooltipEl = document.createElement('div')
  private readonly toastEl = document.createElement('div')
  private readonly loadingEl = document.createElement('div')
  private readonly loadingMsg = document.createElement('div')
  private readonly retryBtn = document.createElement('button')

  private bundle: TerrainBundle | null = null
  private atlas: AtlasLayout | null = null
  private areaMap = new Map<string, AreaInput>()
  private contMap = new Map<string, PlacedContinent>()
  private tileMap = new Map<string, FineTile>()
  private heights = new Map<string, number>()
  private rawHeights = new Map<string, number>()
  private knownHostsKey = ''
  private hasSharedTerritories = false

  private night = true
  private lighting: LightingMode = 'auto'
  private heightMode: HeightMode = 'citations'
  private lens: LensState | null = null
  private locked: LensState | null = null
  private lodTier = 0
  private pinned: PinSelectionItem | null = null
  private pinnedPos: { x: number; y: number; z: number } | null = null
  private drawerTab: 'thread' | 'channel' = 'thread'
  private searchOpen = false
  private searchResults: SearchResultItem[] = []
  private searchIndex = 0

  // Three.js engine state (created once terrain loads)
  private renderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.OrthographicCamera | null = null
  private pixelRT: THREE.WebGLRenderTarget | null = null
  private postScene: THREE.Scene | null = null
  private postCam: THREE.OrthographicCamera | null = null
  private postMat: THREE.ShaderMaterial | null = null
  private postQuad: THREE.Mesh | null = null
  private hemi: THREE.HemisphereLight | null = null
  private sun: THREE.DirectionalLight | null = null
  private terrainDetailTex: THREE.CanvasTexture | null = null
  private textures: MapTextures | null = null
  private haloTexture: THREE.CanvasTexture | null = null
  private geos: Record<GeometryKind, THREE.BufferGeometry> | null = null

  private root: THREE.Group | null = null
  private batches = new Map<string, BatchGroup>()
  private instances: THREE.InstancedMesh[] = []
  private terrainMeshes: ErodedTerrainResult[] = []
  private riverMesh: THREE.Mesh | null = null
  private borderLines: THREE.LineSegments[] = []
  private seaLaneLines: THREE.Mesh[] = []
  private smokes: SmokeEntry[] = []
  private boats: BoatEntry[] = []
  private signals: SignalEntry[] = []
  private pickables: THREE.Object3D[] = []
  private labelEls: LabelEntry[] = []
  private terrainSampler: TerrainSampler | null = null
  private pinGroup: THREE.Group | null = null
  private mountainField: MountainField | null = null
  private seaMesh: THREE.Mesh | null = null

  private dpr = 1
  private rtW = 1
  private rtH = 1
  private rtFilter: THREE.TextureFilter = THREE.LinearFilter

  private readonly dummy = new THREE.Object3D()
  private readonly tmpCol = new THREE.Color()
  private readonly tmpGrey = new THREE.Color()
  private readonly tmpShared = new THREE.Color()
  private readonly sunDir = new THREE.Vector3(-72, 62, 48).normalize()
  private readonly sunRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-72, 62, 48).normalize()).normalize()
  private readonly sunUp = new THREE.Vector3()
  private readonly shadowCenter = new THREE.Vector3()
  private readonly direction = new THREE.Vector3(0, 82, 100).normalize()
  private readonly right = new THREE.Vector3()
  private readonly camUp = new THREE.Vector3()
  private readonly forward = new THREE.Vector3()
  private readonly target = new THREE.Vector3(0, 0, 0)
  private readonly current = new THREE.Vector3(0, 0, 0)
  private readonly camCenter = new THREE.Vector3()
  private readonly renderCenter = new THREE.Vector3()
  private readonly ray = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()

  private span = 180
  private wantedSpan = 180
  private drawerShift = 0
  private lastFrameMs = 0
  private simTime = 0
  private rafId: number | null = null

  private down: { x: number; y: number; onLabel: boolean } | null = null
  private dragged = false
  private suppressClick = false

  private etag: string | null = null
  private pollTimer: number | undefined
  private autoLightTimer: number | undefined
  private toastTimer: number | undefined
  private suppressClickTimer: number | undefined
  private focusTimer: number | undefined
  private abortController: AbortController | null = null
  private resizeObserver: ResizeObserver | null = null
  private disposed = false

  constructor(opts: MapPageOptions) {
    this.opts = opts
    this.sunUp.crossVectors(this.sunDir, this.sunRight).normalize()
    this.right.crossVectors(new THREE.Vector3(0, 1, 0), this.direction).normalize()
    this.camUp.crossVectors(this.direction, this.right).normalize()
    this.forward.set(0, 0, -1 / this.direction.y)

    this.el.className = 'pg-map'
    this.buildDom()
    this.bindUiEvents()
    this.applyInitialTheme()
  }

  start(): void {
    document.title = 'Fleet Map'
    void this.loadTerrain()
  }

  dispose(): void {
    this.disposed = true
    this.stopLoop()
    clearTimeout(this.pollTimer)
    clearInterval(this.autoLightTimer)
    clearTimeout(this.toastTimer)
    clearTimeout(this.suppressClickTimer)
    clearTimeout(this.focusTimer)
    this.abortController?.abort()
    this.abortController = null

    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('keydown', this.onWindowKeydown)
    window.removeEventListener('wheel', this.onWheel)
    window.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerCancel)
    window.removeEventListener('click', this.onWindowClickCapture, true)
    document.removeEventListener('click', this.onDocumentClick)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null

    this.disposeSceneRoot()
    if (this.geos) {
      for (const g of Object.values(this.geos)) g.dispose()
      this.geos = null
    }
    if (this.textures) {
      for (const tex of Object.values(this.textures)) tex.dispose()
      this.textures = null
    }
    this.terrainDetailTex?.dispose()
    this.terrainDetailTex = null
    this.haloTexture?.dispose()
    this.haloTexture = null
    this.pixelRT?.dispose()
    this.pixelRT = null
    if (this.postQuad) {
      this.postQuad.geometry.dispose()
      this.postQuad = null
    }
    this.postMat?.dispose()
    this.postMat = null
    if (this.renderer) {
      this.renderer.dispose()
      this.renderer.domElement.remove()
      this.renderer = null
    }
  }

  private viewportSize(): { width: number; height: number } {
    const w = this.el.clientWidth || window.innerWidth || 1280
    const h = this.el.clientHeight || window.innerHeight || 800
    return { width: Math.max(1, w), height: Math.max(1, h) }
  }

  private applyInitialTheme(): void {
    this.night = isNightHour(localHour())
    this.el.classList.toggle('night', this.night)
  }

  private buildDom(): void {
    this.canvasHost.className = 'map-canvas-host'
    this.canvasHost.setAttribute('aria-label', 'Interactive fleet archipelago')
    this.labelsEl.className = 'map-labels'

    // Top-left nav
    this.jumpsNav.className = 'map-jumps'
    this.jumpsNav.setAttribute('aria-label', 'Map controls')
    this.worldBtn.className = 'selected'
    this.worldBtn.dataset.jump = 'World'
    this.worldBtn.title = 'Reset to World view'
    this.worldBtn.textContent = '↖ World'
    const sep = document.createElement('span')
    this.searchTrigger.title = 'Search continents, districts & threads (/)'
    const kbd = document.createElement('kbd')
    kbd.textContent = '/'
    this.searchTrigger.append(kbd, document.createTextNode(' Search'))
    this.jumpsNav.append(this.worldBtn, sep, this.searchTrigger)

    // Top-right lighting toggle
    this.topRight.className = 'map-top-right'
    this.modeGroup.className = 'map-mode'
    this.modeGroup.setAttribute('aria-label', 'Lighting')
    for (const [mode, label] of [
      ['auto', 'Auto'],
      ['day', 'Day'],
      ['night', 'Night'],
    ] as const) {
      const btn = document.createElement('button')
      btn.dataset.mode = mode
      btn.textContent = label
      if (mode === this.lighting) btn.classList.add('selected')
      btn.onclick = () => this.setMode(mode)
      this.modeButtons.set(mode, btn)
      this.modeGroup.append(btn)
    }
    this.topRight.append(this.modeGroup)

    // Reader drawer
    this.drawerEl.className = 'map-drawer'
    this.drawerEl.setAttribute('aria-label', 'Selected territory or thread')
    this.drawerEl.setAttribute('aria-hidden', 'true')
    const rdHeader = document.createElement('header')
    rdHeader.className = 'rd-header'
    const rdNavRow = document.createElement('div')
    rdNavRow.className = 'rd-nav-row'
    this.rdBack.className = 'rd-back'
    this.rdBack.title = 'Back to map (Esc)'
    this.rdBack.textContent = '← Back to map'
    const rdNavRight = document.createElement('div')
    rdNavRight.className = 'rd-nav-right'
    this.rdTabs.className = 'rd-tabs'
    this.rdTabs.setAttribute('role', 'tablist')
    this.rdTabs.setAttribute('aria-label', 'Reader view')
    this.rdActions.className = 'rd-actions'
    this.rdClose.className = 'rd-close'
    this.rdClose.title = 'Close drawer (Esc)'
    this.rdClose.textContent = '×'
    rdNavRight.append(this.rdTabs, this.rdActions, this.rdClose)
    rdNavRow.append(this.rdBack, rdNavRight)
    const rdTitleRow = document.createElement('div')
    rdTitleRow.className = 'rd-title-row'
    this.rdBadge.className = 'rd-badge'
    this.rdTitle.className = 'rd-title'
    rdTitleRow.append(this.rdBadge, this.rdTitle)
    this.rdPath.className = 'rd-path'
    this.rdMeta.className = 'rd-meta'
    rdHeader.append(rdNavRow, rdTitleRow, this.rdPath, this.rdMeta)
    this.rdBody.className = 'rd-body'
    this.drawerEl.append(rdHeader, this.rdBody)

    // Search modal
    this.searchModal.className = 'map-search-modal'
    this.searchModal.setAttribute('role', 'dialog')
    this.searchModal.setAttribute('aria-label', 'Search atlas')
    this.searchModal.setAttribute('aria-hidden', 'true')
    const searchBar = document.createElement('div')
    searchBar.className = 'search-bar'
    const slashSpan = document.createElement('span')
    slashSpan.className = 'search-slash'
    slashSpan.textContent = '/'
    this.searchInput.className = 'map-search-input'
    this.searchInput.type = 'text'
    this.searchInput.placeholder = 'Search continents, /districts, or Shuttle threads…'
    this.searchInput.autocomplete = 'off'
    this.searchInput.spellcheck = false
    this.searchCount.className = 'map-search-count'
    this.searchClose.className = 'map-search-close'
    this.searchClose.title = 'Close search (Esc)'
    this.searchClose.textContent = 'ESC'
    searchBar.append(slashSpan, this.searchInput, this.searchCount, this.searchClose)
    this.searchList.className = 'map-search-results'
    this.searchList.setAttribute('role', 'listbox')
    this.searchModal.append(searchBar, this.searchList)

    // Bottom lens footer
    this.footerEl.className = 'map-footer'
    const lensTitle = document.createElement('div')
    lensTitle.className = 'lens-title'
    lensTitle.append(document.createTextNode('HOVER TO SEE'), document.createElement('br'))
    const lensSub = document.createElement('span')
    lensSub.textContent = 'click to hold'
    lensTitle.append(lensSub)
    this.stateLensesEl.className = 'lenses'
    this.hostsDivider.className = 'divider'
    this.hostsWrap.className = 'hosts-wrap'
    this.hostsTrigger.className = 'hosts-btn'
    this.hostsTrigger.setAttribute('aria-haspopup', 'true')
    this.hostsTrigger.setAttribute('aria-expanded', 'false')
    this.renderHostsTriggerLabel(null)
    this.hostLensesEl.className = 'hosts-popover'
    this.hostLensesEl.setAttribute('role', 'menu')
    this.hostLensesEl.setAttribute('aria-label', 'Filter by host')
    this.hostsWrap.append(this.hostsTrigger, this.hostLensesEl)
    this.clearLensBtn.className = 'map-clear-lens'
    this.clearLensBtn.title = 'Clear lens'
    this.clearLensBtn.textContent = '×'
    this.footerEl.append(lensTitle, this.stateLensesEl, this.hostsDivider, this.hostsWrap, this.clearLensBtn)

    // Tooltip, Toast, Loading overlay
    this.tooltipEl.className = 'map-tooltip'
    this.tooltipEl.setAttribute('role', 'tooltip')
    this.toastEl.className = 'map-toast'
    this.toastEl.setAttribute('role', 'status')
    this.loadingEl.className = 'map-loading'
    this.loadingMsg.className = 'map-loading-msg'
    this.loadingMsg.textContent = 'Charting the fleet…'
    this.retryBtn.className = 'map-retry'
    this.retryBtn.textContent = 'Retry'
    this.retryBtn.hidden = true
    this.loadingEl.append(this.loadingMsg, this.retryBtn)

    this.el.append(
      this.canvasHost,
      this.labelsEl,
      this.jumpsNav,
      this.topRight,
      this.drawerEl,
      this.searchModal,
      this.footerEl,
      this.tooltipEl,
      this.toastEl,
      this.loadingEl,
    )
  }

  private bindUiEvents(): void {
    this.worldBtn.onclick = () => this.jump('World')
    this.retryBtn.onclick = () => void this.loadTerrain()
    this.rdBack.onclick = e => {
      e.stopPropagation()
      this.clearPin()
    }
    this.rdClose.onclick = e => {
      e.stopPropagation()
      this.clearPin()
    }
    this.hostsTrigger.onclick = e => {
      e.stopPropagation()
      const open = this.hostsWrap.classList.toggle('open')
      this.hostsTrigger.setAttribute('aria-expanded', String(open))
    }
    this.clearLensBtn.onclick = () => {
      this.locked = null
      if (this.searchOpen) this.closeSearch()
      else this.setLens(null)
    }
    this.searchTrigger.onclick = e => {
      e.stopPropagation()
      if (this.searchOpen) this.closeSearch()
      else this.openSearch(this.searchInput.value)
    }
    this.searchClose.onclick = e => {
      e.stopPropagation()
      this.closeSearch()
    }
    this.searchInput.addEventListener('input', () => this.updateSearch(this.searchInput.value))
    this.searchInput.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (this.searchResults.length) {
          this.searchIndex = (this.searchIndex + 1) % this.searchResults.length
          this.renderSearchResults()
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (this.searchResults.length) {
          this.searchIndex = (this.searchIndex - 1 + this.searchResults.length) % this.searchResults.length
          this.renderSearchResults()
        }
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (this.searchResults[this.searchIndex]) this.activateSearchResult(this.searchResults[this.searchIndex])
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.closeSearch()
      }
    })

    document.addEventListener('click', this.onDocumentClick)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('keydown', this.onWindowKeydown)
    window.addEventListener('resize', this.onResize)
    window.addEventListener('wheel', this.onWheel, { passive: false })
    window.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerCancel)
    window.addEventListener('click', this.onWindowClickCapture, true)

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.onResize())
      this.resizeObserver.observe(this.el)
    }
  }

  private renderHostsTriggerLabel(activeLens: LensState | null): void {
    const isHost = activeLens?.type === 'host'
    this.hostsTrigger.classList.toggle('selected', Boolean(isHost))
    this.hostsTrigger.replaceChildren()
    this.hostsTrigger.append(document.createTextNode(isHost ? `Hosts · ${activeLens.value} ` : 'Hosts '))
    const caret = document.createElement('span')
    caret.className = 'caret'
    caret.textContent = '▾'
    this.hostsTrigger.append(caret)
  }

  private rebuildStateLenses(hasShared: boolean): void {
    this.hasSharedTerritories = hasShared
    this.stateLensesEl.replaceChildren()
    const items: Array<[string, string, 'state' | 'shared', string]> = [
      ['◈', 'Working', 'state', 'working'],
      ['✧', 'Asking', 'state', 'ask'],
      ['⌂', 'Resting', 'state', 'resting'],
      ['◉', 'Tapestry', 'state', 'tapestry'],
    ]
    if (hasShared) {
      items.push(['❖', 'Shared', 'shared', 'shared'])
    }
    for (const [icon, label, type, value] of items) {
      this.appendLensButton(this.stateLensesEl, icon, label, type, value, null)
    }
  }

  private rebuildHostLenses(hosts: string[]): void {
    const nextKey = hosts.join('\0')
    if (nextKey === this.knownHostsKey) return
    this.knownHostsKey = nextKey
    this.hostLensesEl.replaceChildren()
    const visible = hosts.length > 0
    this.hostsDivider.hidden = !visible
    this.hostsWrap.hidden = !visible
    for (const h of hosts) {
      this.appendLensButton(this.hostLensesEl, '·', h, 'host', h, hostColor(h))
    }
  }

  private appendLensButton(
    container: HTMLElement,
    icon: string,
    label: string,
    type: 'state' | 'shared' | 'host',
    value: string,
    dotColor: string | null,
  ): void {
    const b = document.createElement('button')
    if (dotColor) {
      const dot = document.createElement('span')
      dot.className = 'host-dot'
      dot.style.background = dotColor
      b.append(dot, document.createTextNode(label))
    } else {
      const bold = document.createElement('b')
      bold.textContent = icon
      b.append(bold, document.createTextNode(label))
    }
    b.dataset.lens = value
    b.setAttribute('aria-pressed', String(this.locked?.value === value))
    if (this.lens?.value === value) b.classList.add('selected')
    const chosen: LensState =
      type === 'shared'
        ? { type: 'shared', value: 'shared' }
        : type === 'host'
          ? { type: 'host', value }
          : { type: 'state', value }
    b.onmouseenter = () => {
      if (!this.searchOpen) this.setLens(chosen)
    }
    b.onmouseleave = () => {
      if (!this.searchOpen) this.setLens(this.locked)
    }
    b.onfocus = () => {
      if (!this.searchOpen) this.setLens(chosen)
    }
    b.onblur = () => {
      if (!this.searchOpen) this.setLens(this.locked)
    }
    b.onclick = e => {
      e.stopPropagation()
      this.locked = this.locked?.value === value ? null : chosen
      this.setLens(this.locked)
      this.hostsWrap.classList.remove('open')
      this.hostsTrigger.setAttribute('aria-expanded', 'false')
    }
    container.append(b)
  }

  private setLens(value: LensState | null): void {
    this.lens = value
    this.el.classList.toggle('lens-active', Boolean(value))
    this.el.querySelectorAll<HTMLElement>('[data-lens]').forEach(b => {
      b.classList.toggle('selected', b.dataset.lens === value?.value)
      b.setAttribute('aria-pressed', String(b.dataset.lens === this.locked?.value))
    })
    this.renderHostsTriggerLabel(value)
    this.applyColors()
  }

  private async loadTerrain(): Promise<void> {
    if (this.disposed) return
    this.loadingEl.hidden = false
    this.retryBtn.hidden = true
    this.loadingMsg.textContent = 'Charting the fleet…'

    this.abortController?.abort()
    const ctrl = new AbortController()
    this.abortController = ctrl

    let timedOut = false
    const timeoutId = window.setTimeout(() => {
      timedOut = true
      ctrl.abort('timeout')
    }, TERRAIN_TIMEOUT_MS)

    try {
      const url = `${this.opts.base.replace(/\/+$/, '')}/api/v1/map/terrain`
      const resp = await daemonFetch(url, { signal: ctrl.signal })
      if (!resp.ok) {
        throw new Error(await responseError(resp, 'Could not load map terrain'))
      }
      const data = (await resp.json()) as TerrainBundle
      if (this.disposed) return

      this.bundle = {
        ...data,
        continents: Array.isArray(data.continents) ? data.continents : [],
        areas: Array.isArray(data.areas) ? data.areas : [],
        cities: Array.isArray(data.cities) ? data.cities.map(n => ({ ...n })) : [],
        areaLinks: Array.isArray(data.areaLinks) ? data.areaLinks : [],
        domainLinks: Array.isArray(data.domainLinks) ? data.domainLinks : [],
      }
      this.areaMap = new Map(this.bundle.areas.map(a => [a.id, a]))

      if (!this.initThree()) {
        this.loadingMsg.textContent = 'WebGL is unavailable in this environment.'
        this.retryBtn.hidden = true
        return
      }

      this.assemble()
      this.setMode('auto')
      this.jump('World')
      this.current.copy(this.target)
      this.span = this.wantedSpan
      this.syncLOD()
      this.loadingEl.hidden = true

      this.startLoop()
      this.scheduleCompositePoll(true)
      clearInterval(this.autoLightTimer)
      this.autoLightTimer = window.setInterval(() => {
        if (this.lighting === 'auto') this.setMode('auto')
      }, AUTO_LIGHT_MS)
    } catch (err) {
      if (this.disposed) return
      if (timedOut || ctrl.signal.reason === 'timeout') {
        this.loadingMsg.textContent = 'Timed out loading fleet map after 45s.'
        this.retryBtn.hidden = false
        return
      }
      if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return
      this.loadingMsg.textContent = isDaemonBooting(err)
        ? 'The daemon is starting…'
        : `Could not load fleet map: ${daemonErrorMessage(err)}`
      this.retryBtn.hidden = false
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private initThree(): boolean {
    if (this.renderer) return true
    try {
      const { width, height } = this.viewportSize()
      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false })
      this.dpr = Math.min(window.devicePixelRatio || 1, 2)
      renderer.setPixelRatio(this.dpr)
      renderer.setSize(width, height)
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = THREE.PCFSoftShadowMap
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.12
      this.canvasHost.replaceChildren(renderer.domElement)
      renderer.domElement.addEventListener('pointerleave', () => {
        this.tooltipEl.style.display = 'none'
      })

      const scene = new THREE.Scene()
      const camera = new THREE.OrthographicCamera(-120, 120, 75, -75, 0.1, 750)

      const msaaSamples = renderer.capabilities.isWebGL2 ? Math.min(4, renderer.capabilities.maxSamples || 4) : 0
      const supportsHalfFloat =
        renderer.capabilities.isWebGL2 && Boolean(renderer.extensions.get('EXT_color_buffer_float'))
      this.rtW = Math.max(1, Math.round(width * this.dpr))
      this.rtH = Math.max(1, Math.round(height * this.dpr))
      this.rtFilter = THREE.LinearFilter
      const pixelRT = new THREE.WebGLRenderTarget(this.rtW, this.rtH, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        type: supportsHalfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
        samples: msaaSamples,
        depthBuffer: true,
        stencilBuffer: false,
      })

      const postScene = new THREE.Scene()
      const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
      const postMat = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: pixelRT.texture },
          uNight: { value: 1.0 },
        },
        vertexShader: `
          varying vec2 vUv;
          void main(){
            vUv=uv;
            gl_Position=vec4(position.xy,0.0,1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D tDiffuse;
          uniform float uNight;
          varying vec2 vUv;
          void main(){
            vec4 raw=texture2D(tDiffuse,vUv);
            gl_FragColor=raw;
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
            vec3 c=gl_FragColor.rgb;
            float lum=dot(c,vec3(0.299,0.587,0.114));
            vec3 shadowTint=mix(vec3(0.988,0.996,1.012),vec3(0.972,0.994,1.024),uNight);
            vec3 hiTint=mix(vec3(1.012,1.004,0.990),vec3(1.018,1.004,0.980),uNight);
            c*=mix(shadowTint,hiTint,smoothstep(0.18,0.80,lum));
            gl_FragColor=vec4(clamp(c,0.0,1.0),1.0);
          }
        `,
        depthTest: false,
        depthWrite: false,
        toneMapped: true,
      })
      const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat)
      postScene.add(postQuad)

      const hemi = new THREE.HemisphereLight('#fff4dc', '#4a6062', 1.05)
      scene.add(hemi)
      const sun = new THREE.DirectionalLight('#fff0cc', 3.25)
      sun.position.copy(this.sunDir).multiplyScalar(240)
      sun.castShadow = true
      sun.shadow.mapSize.set(4096, 4096)
      Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 150, bottom: -150, near: 10, far: 480 })
      sun.shadow.bias = -0.00022
      sun.shadow.normalBias = 0.015
      sun.shadow.radius = 2.0
      scene.add(sun)
      scene.add(sun.target)

      const aoPlane = new THREE.PlaneGeometry(1, 1)
      aoPlane.rotateX(-Math.PI / 2)
      this.geos = {
        box: new THREE.BoxGeometry(1, 1, 1),
        hex: new THREE.CylinderGeometry(0.985, 1, 1, 6),
        hexSkirt: new THREE.CylinderGeometry(0.97, 1, 1, 6),
        cyl: new THREE.CylinderGeometry(1, 1, 1, 12),
        dome: new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2),
        peak: new THREE.ConeGeometry(1, 1, 5),
        ao: aoPlane,
        ...createMountainGeometries(),
      }

      this.terrainDetailTex = makeTerrainDetailTexture(renderer)
      this.textures = this.buildTextures(renderer)
      this.renderer = renderer
      this.scene = scene
      this.camera = camera
      this.pixelRT = pixelRT
      this.postScene = postScene
      this.postCam = postCam
      this.postMat = postMat
      this.postQuad = postQuad
      this.hemi = hemi
      this.sun = sun
      return true
    } catch {
      return false
    }
  }

  private makeCanvasTex(
    renderer: THREE.WebGLRenderer,
    S: number,
    draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
    opts: { w?: number; h?: number; nearest?: boolean; repeat?: [number, number] } = {},
  ): THREE.CanvasTexture {
    const c = document.createElement('canvas')
    c.width = opts.w || S
    c.height = opts.h || S
    const ctx = c.getContext('2d')!
    draw(ctx, c.width, c.height)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.magFilter = opts.nearest ? THREE.NearestFilter : THREE.LinearFilter
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
    if (opts.repeat) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping
      tex.repeat.set(opts.repeat[0], opts.repeat[1])
    }
    return tex
  }

  private buildTextures(renderer: THREE.WebGLRenderer): MapTextures {
    const T_MAP: MapTextures = {}
    const inHex = (x: number, y: number, S: number, r = 0.43): boolean => Math.hypot(x - S / 2, y - S / 2) < S * r
    for (const [role, seed, base, tufts, dappleA] of [
      ['land', 101, '#f2f4ed', 14, 0.26],
      ['meadow', 202, '#f6f6ec', 24, 0.32],
      ['valley', 303, '#eef4ee', 18, 0.28],
    ] as const) {
      T_MAP[role] = this.makeCanvasTex(renderer, 128, (ctx, S) => {
        const rnd = prng(seed)
        ctx.fillStyle = base
        ctx.fillRect(0, 0, S, S)
        for (let i = 0; i < 24; i++) {
          const x = rnd() * S
          const y = rnd() * S
          const rx = 6 + rnd() * 13
          const ry = 4 + rnd() * 9
          ctx.fillStyle = rnd() > 0.48 ? `rgba(255,254,238,${dappleA})` : `rgba(162,184,154,${dappleA * 0.85})`
          ctx.beginPath()
          ctx.ellipse(x, y, rx, ry, rnd() * Math.PI, 0, Math.PI * 2)
          ctx.fill()
        }
        for (let i = 0; i < 220; i++) {
          const x = Math.floor(rnd() * S)
          const y = Math.floor(rnd() * S)
          ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,246,.22)' : 'rgba(132,156,128,.16)'
          ctx.fillRect(x, y, 2, 2)
        }
        for (let i = 0; i < tufts; i++) {
          const x = S * 0.14 + rnd() * S * 0.72
          const y = S * 0.14 + rnd() * S * 0.72
          if (!inHex(x, y, S, 0.41)) continue
          ctx.strokeStyle = 'rgba(104,132,98,.34)'
          ctx.lineWidth = 1.35
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.moveTo(x - 2.2, y - 2.5)
          ctx.lineTo(x, y + 1)
          ctx.lineTo(x + 2.4, y - 2.2)
          ctx.stroke()
          ctx.strokeStyle = 'rgba(255,255,232,.40)'
          ctx.lineWidth = 1.0
          ctx.beginPath()
          ctx.moveTo(x, y + 1)
          ctx.lineTo(x + 0.4, y - 3.4)
          ctx.stroke()
        }
        strokeHexBevel(ctx, S, 0.36, 0.2)
      })
    }

    T_MAP.highland = this.makeCanvasTex(renderer, 128, (ctx, S) => {
      const rnd = prng(404)
      ctx.fillStyle = '#f1f2ec'
      ctx.fillRect(0, 0, S, S)
      for (let i = 0; i < 7; i++) {
        const y = 10 + i * 17 + rnd() * 5
        ctx.fillStyle = i % 2 ? 'rgba(255,254,244,.26)' : 'rgba(176,184,172,.22)'
        ctx.fillRect(0, y, S, 5 + rnd() * 5)
      }
      for (let i = 0; i < 190; i++) {
        const x = Math.floor(rnd() * S)
        const y = Math.floor(rnd() * S)
        const sz = rnd() > 0.8 ? 2 : 1.5
        ctx.fillStyle = rnd() > 0.48 ? 'rgba(255,255,248,.32)' : 'rgba(118,128,118,.25)'
        ctx.fillRect(x, y, sz, sz)
      }
      strokeHexBevel(ctx, S, 0.42, 0.26)
    })

    T_MAP.alpine = this.makeCanvasTex(renderer, 128, (ctx, S) => {
      const rnd = prng(505)
      ctx.fillStyle = '#f1f2ef'
      ctx.fillRect(0, 0, S, S)
      const v = hexVerts(S, 0.48)
      const cx = S * 0.46
      const cy = S * 0.46
      for (let k = 0; k < 6; k++) {
        const a = v[k]
        const b = v[(k + 1) % 6]
        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.lineTo(a[0], a[1])
        ctx.lineTo(b[0], b[1])
        ctx.closePath()
        ctx.fillStyle = k >= 3 ? 'rgba(255,255,250,.26)' : 'rgba(148,160,166,.22)'
        ctx.fill()
      }
      for (let i = 0; i < 220; i++) {
        const x = Math.floor(rnd() * S)
        const y = Math.floor(rnd() * S)
        ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,.36)' : 'rgba(112,122,128,.26)'
        ctx.fillRect(x, y, 2, 2)
      }
      strokeHexBevel(ctx, S, 0.48, 0.3)
    })

    T_MAP.peak = this.makeCanvasTex(renderer, 128, (ctx, S) => {
      const rnd = prng(606)
      ctx.fillStyle = '#f7f9f7'
      ctx.fillRect(0, 0, S, S)
      const v = hexVerts(S, 0.48)
      const cx = S * 0.45
      const cy = S * 0.44
      for (let k = 0; k < 6; k++) {
        const a = v[k]
        const b = v[(k + 1) % 6]
        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.lineTo(a[0], a[1])
        ctx.lineTo(b[0], b[1])
        ctx.closePath()
        ctx.fillStyle = k >= 3 ? 'rgba(255,255,255,.34)' : 'rgba(164,180,192,.24)'
        ctx.fill()
      }
      for (let i = 0; i < 150; i++) {
        const x = Math.floor(rnd() * S)
        const y = Math.floor(rnd() * S)
        ctx.fillStyle = rnd() > 0.55 ? 'rgba(255,255,255,.42)' : 'rgba(145,158,168,.20)'
        ctx.fillRect(x, y, 2, 1.5)
      }
      strokeHexBevel(ctx, S, 0.52, 0.28)
    })

    T_MAP.rock = this.makeCanvasTex(renderer, 128, (ctx, S) => {
      const rnd = prng(707)
      ctx.fillStyle = '#edece6'
      ctx.fillRect(0, 0, S, S)
      for (let i = 0; i < 10; i++) {
        const y = i * 13 + rnd() * 3
        const h = 4 + rnd() * 5
        ctx.fillStyle = i % 2 ? 'rgba(255,253,246,.24)' : 'rgba(118,128,136,.24)'
        ctx.fillRect(0, y, S, h)
        ctx.fillStyle = 'rgba(84,94,104,.22)'
        ctx.fillRect(0, y + h, S, 1.2)
      }
      for (let i = 0; i < 200; i++) {
        const x = Math.floor(rnd() * S)
        const y = Math.floor(rnd() * S)
        ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,254,248,.24)' : 'rgba(98,108,116,.24)'
        ctx.fillRect(x, y, 2, 2)
      }
    })

    T_MAP.sand = this.makeCanvasTex(renderer, 128, (ctx, S) => {
      const rnd = prng(808)
      ctx.fillStyle = '#f6f3e8'
      ctx.fillRect(0, 0, S, S)
      for (let i = 0; i < 300; i++) {
        const x = Math.floor(rnd() * S)
        const y = Math.floor(rnd() * S)
        ctx.fillStyle = rnd() > 0.48 ? 'rgba(255,252,238,.36)' : 'rgba(168,150,114,.24)'
        ctx.fillRect(x, y, 2, 2)
      }
      strokeHexBevel(ctx, S, 0.34, 0.18)
    })

    T_MAP.foam = this.makeCanvasTex(renderer, 128, (ctx, S) => {
      const rnd = prng(909)
      ctx.fillStyle = '#f4f8f6'
      ctx.fillRect(0, 0, S, S)
      for (let i = 0; i < 180; i++) {
        const x = Math.floor(rnd() * S)
        const y = Math.floor(rnd() * S)
        ctx.fillStyle = rnd() > 0.45 ? 'rgba(255,255,255,.38)' : 'rgba(155,186,184,.22)'
        ctx.fillRect(x, y, 2, 2)
      }
    })

    T_MAP.shallow = this.makeCanvasTex(renderer, 128, (ctx, S) => {
      const rnd = prng(1010)
      ctx.fillStyle = '#eef6f4'
      ctx.fillRect(0, 0, S, S)
      for (let i = 0; i < 16; i++) {
        const x = rnd() * S
        const y = rnd() * S
        const len = 10 + rnd() * 18
        ctx.strokeStyle = i % 2 ? 'rgba(255,255,255,.32)' : 'rgba(130,174,178,.24)'
        ctx.lineWidth = 1.5
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(x - len / 2, y)
        ctx.quadraticCurveTo(x, y - 2.5, x + len / 2, y)
        ctx.stroke()
      }
    })

    T_MAP.sea = this.makeCanvasTex(
      renderer,
      256,
      (ctx, S) => {
        const rnd = prng(1111)
        ctx.fillStyle = '#f6f8f8'
        ctx.fillRect(0, 0, S, S)
        for (let i = 0; i < 900; i++) {
          const x = Math.floor(rnd() * S)
          const y = Math.floor(rnd() * S)
          ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,.042)' : 'rgba(92,132,150,.036)'
          ctx.fillRect(x, y, 2, 1)
        }
        ctx.lineCap = 'round'
        for (let i = 0; i < 44; i++) {
          const x = rnd() * S
          const y = rnd() * S
          const w = 7 + rnd() * 9
          for (const ox of [-S, 0, S]) {
            for (const oy of [-S, 0, S]) {
              ctx.strokeStyle = 'rgba(255,255,255,.11)'
              ctx.lineWidth = 1.0
              ctx.beginPath()
              ctx.moveTo(x + ox - w * 0.5, y + oy)
              ctx.quadraticCurveTo(x + ox, y + oy - 1.3, x + ox + w * 0.5, y + oy)
              ctx.stroke()
              ctx.strokeStyle = 'rgba(84,124,146,.075)'
              ctx.lineWidth = 0.9
              ctx.beginPath()
              ctx.moveTo(x + ox - w * 0.42, y + oy + 1.2)
              ctx.quadraticCurveTo(x + ox, y + oy + 0.1, x + ox + w * 0.42, y + oy + 1.2)
              ctx.stroke()
            }
          }
        }
      },
      { repeat: [64, 64] },
    )

    T_MAP.laneDash = this.makeCanvasTex(renderer, 64, (ctx, S) => {
      ctx.clearRect(0, 0, S, S)
      const gX = ctx.createLinearGradient(0, 0, S, 0)
      gX.addColorStop(0, 'rgba(255,255,255,0)')
      gX.addColorStop(0.16, 'rgba(255,255,255,1)')
      gX.addColorStop(0.84, 'rgba(255,255,255,1)')
      gX.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = gX
      ctx.fillRect(0, 0, S, S)
      ctx.globalCompositeOperation = 'destination-in'
      const gY = ctx.createLinearGradient(0, 0, 0, S)
      gY.addColorStop(0, 'rgba(255,255,255,0)')
      gY.addColorStop(0.14, 'rgba(255,255,255,1)')
      gY.addColorStop(0.86, 'rgba(255,255,255,1)')
      gY.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = gY
      ctx.fillRect(0, 0, S, S)
    })

    T_MAP.river = this.makeCanvasTex(
      renderer,
      64,
      (ctx, S) => {
        const rnd = prng(1212)
        ctx.fillStyle = '#d9ecee'
        ctx.fillRect(0, 0, S, S)
        const depth = ctx.createLinearGradient(0, 0, S, 0)
        depth.addColorStop(0, 'rgba(242,252,250,.48)')
        depth.addColorStop(0.14, 'rgba(210,238,240,.22)')
        depth.addColorStop(0.38, 'rgba(92,138,152,.22)')
        depth.addColorStop(0.5, 'rgba(76,120,136,.30)')
        depth.addColorStop(0.62, 'rgba(92,138,152,.22)')
        depth.addColorStop(0.86, 'rgba(210,238,240,.22)')
        depth.addColorStop(1, 'rgba(242,252,250,.48)')
        ctx.fillStyle = depth
        ctx.fillRect(0, 0, S, S)
        for (let i = 0; i < 12; i++) {
          const x = 9 + rnd() * (S - 18)
          const y = rnd() * S
          const h = 11 + rnd() * 16
          const w = 1.4 + rnd() * 1.6
          ctx.fillStyle = rnd() > 0.45 ? 'rgba(240,252,252,.24)' : 'rgba(176,220,228,.20)'
          for (const oy of [-S, 0, S]) ctx.fillRect(x, y + oy, w, h)
        }
      },
      { repeat: [1, 2] },
    )

    T_MAP.lanternGlow = this.makeCanvasTex(renderer, 128, (ctx, S) => {
      const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
      g.addColorStop(0, 'rgba(255,252,228,.98)')
      g.addColorStop(0.22, 'rgba(255,224,132,.78)')
      g.addColorStop(0.52, 'rgba(255,192,82,.30)')
      g.addColorStop(1, 'rgba(255,176,60,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, S, S)
    })

    T_MAP.beam = this.makeCanvasTex(
      renderer,
      64,
      (ctx, W, H) => {
        const g = ctx.createLinearGradient(0, 0, 0, H)
        g.addColorStop(0, 'rgba(255,248,214,.88)')
        g.addColorStop(0.22, 'rgba(255,226,144,.52)')
        g.addColorStop(0.58, 'rgba(255,200,96,.18)')
        g.addColorStop(1, 'rgba(255,186,72,0)')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, W, H)
      },
      { w: 64, h: 128 },
    )

    T_MAP.ao = this.makeCanvasTex(renderer, 64, (ctx, S) => {
      const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.08, S / 2, S / 2, S * 0.48)
      g.addColorStop(0, 'rgba(255,255,255,.72)')
      g.addColorStop(0.45, 'rgba(255,255,255,.38)')
      g.addColorStop(0.82, 'rgba(255,255,255,.08)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, S, S)
    })

    return T_MAP
  }

  private put = (
    kind: GeometryKind,
    role: string,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    owner: PickOwner | null = null,
    rotation = 0,
    glow = 0,
    custom: string | null = null,
    tier: RenderTier = 'all',
  ): BatchItem => {
    const k = [kind, role, glow, custom || '', tier].join('/')
    let group = this.batches.get(k)
    if (!group) {
      group = { kind, role, glow, custom, tier, items: [] }
      this.batches.set(k, group)
    }
    const biome = owner?.continent ? biomeOf(owner.continent, this.contMap) : null
    const item: BatchItem = { x, y, z, sx, sy, sz, owner, biome, rotation }
    group.items.push(item)
    return item
  }

  private box = (
    role: string,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    owner: PickOwner | null = null,
    g = 0,
    rot = 0,
    tier: RenderTier = 'all',
  ): BatchItem => this.put('box', role, x, y, z, w, h, d, owner, rot, g, null, tier)

  private cyl = (
    role: string,
    x: number,
    y: number,
    z: number,
    r: number,
    h: number,
    owner: PickOwner | null = null,
    g = 0,
    tier: RenderTier = 'all',
  ): BatchItem => this.put('cyl', role, x, y, z, r, h, r, owner, 0, g, null, tier)

  private ao = (x: number, y: number, z: number, r = 1.2, tier: RenderTier = 'all'): BatchItem =>
    this.put('ao', 'ao', x, y + 0.012, z, r, 1, r, null, 0, 0, null, tier)

  private heightAt(p: Axial): number {
    return this.heights.get(key(p)) ?? 0.26
  }

  private rawHeightAt(p: Axial): number {
    return this.rawHeights.get(key(p)) ?? 0.5
  }

  private halo = (n: PlacedCity, x: number, y: number, z: number, ask = false): void => {
    if (!this.root) return
    if (!this.haloTexture) {
      const c = document.createElement('canvas')
      c.width = c.height = 128
      const ctx = c.getContext('2d')!
      const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
      g.addColorStop(0, 'rgba(255,204,96,.82)')
      g.addColorStop(0.36, 'rgba(255,180,68,.42)')
      g.addColorStop(0.72, 'rgba(255,162,52,.14)')
      g.addColorStop(1, 'rgba(255,155,48,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 128, 128)
      this.haloTexture = new THREE.CanvasTexture(c)
    }
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(ask ? 4.8 : 5.2, ask ? 4.8 : 5.2),
      new THREE.MeshBasicMaterial({ map: this.haloTexture, transparent: true, depthWrite: false, opacity: 0.86 }),
    )
    m.rotation.x = -Math.PI / 2
    m.position.set(x, y + 0.055, z)
    this.root.add(m)
    this.signals.push({ type: 'halo', m, n, ask })
    if (!ask) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.76, 0.9, 36),
        new THREE.MeshBasicMaterial({ color: '#f2b254', transparent: true, opacity: 0.72, depthWrite: false }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.set(x, y + 0.062, z)
      this.root.add(ring)
      this.signals.push({ type: 'forge-ring', m: ring, n })

      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.haloTexture,
          color: '#ffc86b',
          transparent: true,
          opacity: 0.95,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      glow.position.set(x, y + 1.38, z)
      glow.scale.set(2.75, 2.75, 1)
      this.root.add(glow)
      this.signals.push({ type: 'forge-glow', m: glow, n })
    }
  }

  private getAssetCtx(): AssetContext {
    return {
      box: this.box,
      cyl: this.cyl,
      put: this.put,
      ao: this.ao,
      root: this.root!,
      textures: this.textures!,
      hostColor: h => (h ? hostColor(h) : null),
      biomeOf: id => biomeOf(id, this.contMap),
      smokes: this.smokes,
      boats: this.boats,
      signals: this.signals,
      halo: this.halo,
      sampleHeight: (x, z) => (this.terrainSampler ? this.terrainSampler.sampleHeight(x, z) : 0.26),
      isInRiver: (x, z) => (this.terrainSampler ? this.terrainSampler.isInRiver(x, z) : false),
      isNearMountain: t => {
        if (!this.mountainField?.l2) return false
        for (const [dq, dr] of DIRECTIONS) {
          if (this.mountainField.l2.has(`${t.q + dq},${t.r + dr}`)) return true
        }
        return false
      },
    }
  }

  private emitRoadPath(
    points: Axial[],
    w: number,
    role = 'road',
    g = 0,
    owner: PickOwner | null = null,
    tier: RenderTier = 'l12',
    placedBridges: Set<string> | null = null,
    assetCtx: AssetContext | null = null,
    placedBridgePts: WorldXZ[] | null = null,
  ): void {
    const stepsPerEdge = 6
    let wetRun: { ax: number; az: number; bx: number; bz: number; waterY: number } | null = null
    const flushWet = (): void => {
      if (!wetRun) return
      const { ax, az, bx, bz, waterY } = wetRun
      wetRun = null
      const spanLen = Math.hypot(bx - ax, bz - az)
      if (spanLen < 0.05) return
      if (assetCtx && placedBridges) {
        const segs = Math.max(1, Math.ceil(spanLen / 1.45))
        for (let k = 0; k < segs; k++) {
          const f0 = k / segs
          const f1 = (k + 1) / segs
          const sax = ax + (bx - ax) * f0
          const saz = az + (bz - az) * f0
          const sbx = ax + (bx - ax) * f1
          const sbz = az + (bz - az) * f1
          const mx = (sax + sbx) * 0.5
          const mz = (saz + sbz) * 0.5
          const bKey = `${Math.round(mx * 1.35)},${Math.round(mz * 1.35)}`
          if (!placedBridges.has(bKey)) {
            placedBridges.add(bKey)
            if (placedBridgePts) placedBridgePts.push({ x: mx, z: mz })
            const wy = this.terrainSampler
              ? Math.max(
                  waterY,
                  this.terrainSampler.riverSurfaceY(mx, mz),
                  this.terrainSampler.riverSurfaceY(sax, saz),
                  this.terrainSampler.riverSurfaceY(sbx, sbz),
                )
              : waterY
            buildRiverBridge(assetCtx, sax, saz, sbx, sbz, wy, owner, tier)
          }
        }
      }
    }

    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]
      const b = points[i]
      const A = world(a)
      const B = world(b)
      const tileA = this.tileMap.get(key(a))
      const tileB = this.tileMap.get(key(b))
      const nearRiverTile = Boolean(tileA?.river || tileB?.river)
      for (let s = 0; s < stepsPerEdge; s++) {
        const f0 = s / stepsPerEdge
        const f1 = (s + 1) / stepsPerEdge
        const ax = A.x + (B.x - A.x) * f0
        const az = A.z + (B.z - A.z) * f0
        const bx = A.x + (B.x - A.x) * f1
        const bz = A.z + (B.z - A.z) * f1
        const mx = (ax + bx) * 0.5
        const mz = (az + bz) * 0.5
        const inRiv =
          Boolean(this.terrainSampler?.isInRiver(mx, mz)) ||
          (nearRiverTile && Boolean(this.terrainSampler?.isInRiver(ax, az) && this.terrainSampler?.isInRiver(bx, bz)))
        if (inRiv) {
          const wy = this.terrainSampler ? this.terrainSampler.riverSurfaceY(mx, mz) : 0.1
          if (!wetRun) wetRun = { ax, az, bx, bz, waterY: wy }
          else {
            wetRun.bx = bx
            wetRun.bz = bz
            wetRun.waterY = Math.max(wetRun.waterY, wy)
          }
        } else {
          flushWet()
          const ah = (this.terrainSampler ? this.terrainSampler.sampleHeight(ax, az) : this.heightAt(a)) + 0.026
          const bh = (this.terrainSampler ? this.terrainSampler.sampleHeight(bx, bz) : this.heightAt(b)) + 0.026
          const length = Math.hypot(bx - ax, bz - az)
          if (!length) continue
          const item = this.box(role, mx, (ah + bh) / 2, mz, w, 0.024, length + 0.05, owner, g, Math.atan2(bx - ax, bz - az), tier)
          item.slope = -Math.atan2(bh - ah, length)
        }
      }
    }
    flushWet()
  }

  private buildCityStructure(n: PlacedCity): void {
    const { x, z } = n
    const y = this.heightAt(n)
    const rh = this.rawHeightAt(n)
    const seed = hash(n.id)
    n.elevation = y
    n.shared = Boolean(this.contMap.get(n.continent)?.shared || this.areaMap.get(n.area)?.shared)
    const working = n.state === 'working'
    const asking = n.state === 'ask'
    const settled = n.state === 'closed' || n.state === 'settled'

    const lensRing = new THREE.Mesh(
      new THREE.RingGeometry(0.94, 1.04, 36),
      new THREE.MeshBasicMaterial({ color: '#ffce63', transparent: true, opacity: 1, depthWrite: false }),
    )
    lensRing.rotation.x = -Math.PI / 2
    lensRing.position.set(x, y + 0.1, z)
    this.root!.add(lensRing)
    this.signals.push({ type: 'lens-ring', m: lensRing, n })

    const ctx = this.getAssetCtx()
    if (settled) {
      if (n.tempered === false) buildDiscardedRuin(ctx, n, x, y, z, 'l12')
      else buildTemperedVillage(ctx, n, x, y, z, rh, 'l12')
      return
    }
    const tier: RenderTier = asking || working || n.isOrchestrator ? 'all' : 'l12'
    if (asking) {
      buildLighthouse(ctx, n, x, y, z, tier)
    } else if (n.isOrchestrator) {
      buildCitadel(ctx, n, x, y, z, tier)
    } else if (working) {
      buildForge(ctx, n, x, y, z, tier)
    } else {
      buildCottage(ctx, n, x, y, z, seed, tier)
    }
    if (n.hasTapestry && !settled) {
      const ox = x - 0.58
      const oz = z - 0.36
      const oy = this.terrainSampler ? Math.max(SEA_Y + 0.08, this.terrainSampler.sampleHeight(ox, oz)) : y
      buildObservatory(ctx, n, ox, oy, oz, seed, tier)
    }
    const tx = x + 0.64
    const tz = z - 0.54
    if (!this.terrainSampler?.isInRiver(tx, tz)) {
      const ty = this.terrainSampler ? this.terrainSampler.sampleHeight(tx, tz) : y
      if (ty > 0.03) {
        const sp = seed > 0.62 ? 'cypress' : seed > 0.32 ? 'oak' : 'pine'
        buildTree(ctx, tx, ty, tz, 0.62 + seed * 0.22, n, sp, 'leaf', 'l12')
      }
    }
  }

  private disposeSceneRoot(): void {
    if (!this.root || !this.scene) return
    const sharedGeos = this.geos ? new Set<THREE.BufferGeometry>(Object.values(this.geos)) : new Set<THREE.BufferGeometry>()
    this.scene.remove(this.root)
    this.root.traverse(o => {
      if (o instanceof THREE.InstancedMesh) o.dispose()
      const meshObj = o as { material?: THREE.Material | THREE.Material[]; geometry?: THREE.BufferGeometry }
      if (meshObj.material) {
        if (Array.isArray(meshObj.material)) meshObj.material.forEach(m => m.dispose())
        else meshObj.material.dispose()
      }
      if (meshObj.geometry && !sharedGeos.has(meshObj.geometry)) {
        meshObj.geometry.dispose()
      }
    })
    this.root = null
    this.seaMesh = null
  }

  private applyMatrix(item: BatchItem): void {
    this.dummy.position.set(item.x, item.y, item.z)
    this.dummy.scale.set(item.sx, item.sy, item.sz)
    this.dummy.rotation.set(item.slope || 0, item.rotation, 0, 'YXZ')
    this.dummy.updateMatrix()
  }

  private syncLOD(): void {
    this.lodTier = this.span > 115 ? 0 : this.span > 24 ? 1 : 2
    for (const m of this.instances) {
      const b = m.userData.batch as BatchGroup
      m.visible = tierVisible(b.tier, this.lodTier)
    }
    for (const tm of this.terrainMeshes) {
      const vis = tierVisible(tm.mesh.userData.tier as RenderTier, this.lodTier)
      tm.mesh.visible = vis
      tm.shoalMesh.visible = vis
    }
    if (this.riverMesh) {
      this.riverMesh.visible = tierVisible(this.riverMesh.userData.tier as RenderTier, this.lodTier)
    }
    for (const bl of this.borderLines) {
      bl.visible = tierVisible(bl.userData.tier as RenderTier, this.lodTier)
    }
    this.pickables = [
      ...this.instances.filter(m => {
        const b = m.userData.batch as BatchGroup
        return m.visible && b.pickable !== false && b.items.some(i => i.owner)
      }),
      ...this.terrainMeshes.filter(tm => tm.mesh.visible).map(tm => tm.mesh),
      ...(this.riverMesh && this.riverMesh.visible ? [this.riverMesh] : []),
    ]
  }

  private assemble(): void {
    if (!this.bundle || !this.scene || !this.geos || !this.textures) return
    this.disposeSceneRoot()
    this.root = new THREE.Group()
    this.scene.add(this.root)
    this.batches = new Map()
    this.instances = []
    this.terrainMeshes = []
    this.riverMesh = null
    this.borderLines = []
    this.seaLaneLines = []
    this.smokes = []
    this.boats = []
    this.signals = []
    this.pickables = []

    const atlas = layout(this.bundle, { heightMode: this.heightMode })
    this.atlas = atlas
    this.contMap = new Map(atlas.continents.map(c => [c.id, c]))
    this.rawHeights = new Map(atlas.tiles.map(t => [key(t), t.height]))
    this.tileMap = new Map(atlas.tiles.map(t => [key(t), t]))

    const hasShared = atlas.continents.some(c => Boolean(c.shared))
    if (this.stateLensesEl.childElementCount === 0 || hasShared !== this.hasSharedTerritories) {
      this.rebuildStateLenses(hasShared)
    }
    this.rebuildHostLenses(collectHosts(this.bundle))

    const cityAt = new Map(atlas.fibers.map(n => [key(n), n]))
    const subAreaById = new Map<string, PlacedArea>()
    for (const c of atlas.continents) {
      for (const sa of c.subAreas || []) subAreaById.set(sa.id, sa)
    }

    this.terrainSampler = createErodedSampler(atlas, this.tileMap, this.contMap)
    this.heights = new Map()
    for (const t of atlas.tiles) {
      const tk = key(t)
      this.heights.set(tk, this.terrainSampler.cityElevations.get(tk) ?? this.terrainSampler.sampleHeight(t.x, t.z))
    }
    this.mountainField = computeMountainField(atlas, this.tileMap, cityAt)

    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(2400, 2400),
      new THREE.MeshStandardMaterial({
        color: SCHEMES.day.sea,
        map: this.textures.sea,
        roughness: 0.38,
        metalness: 0.04,
      }),
    )
    sea.rotation.x = -Math.PI / 2
    sea.position.y = SEA_Y
    sea.receiveShadow = true
    this.root.add(sea)
    this.seaMesh = sea

    const assetCtx = this.getAssetCtx()

    const l0OwnerFor = (c: CoarseCell): TileOwner => {
      const cont = this.contMap.get(c.continent)
      const area = this.areaMap.get(c.area) || {
        id: c.area,
        name: 'Outskirts',
        continent: c.continent,
        mass: cont?.total || 1,
        cities: 0,
        citedBy: cont?.citedBy || 0,
        maxDepth: cont?.maxDepth || 1,
        shared: cont?.shared,
        sampleFibers: [],
      }
      return {
        isTile: true,
        level: 1,
        id: c.area,
        continent: c.continent,
        continentName: cont?.name || c.continent,
        areaName: c.isthmus ? `${area.name} (Isthmus peninsula)` : area.name,
        mass: area.mass,
        cities: area.cities,
        citedBy: c.citedBy || area.citedBy || 0,
        maxDepth: c.maxDepth || area.maxDepth || 0,
        recentRatio: c.recentRatio ?? area.recentRatio ?? 0,
        shared: Boolean(cont?.shared),
        elevation: c.height,
        sampleFibers: area.sampleFibers || [],
      }
    }

    const l2OwnerFor = (t: FineTile): PickOwner => {
      const city = cityAt.get(key(t))
      if (city) return city
      const cont = this.contMap.get(t.continent)
      const area = (t.subArea && subAreaById.get(t.subArea)) ||
        this.areaMap.get(t.area) || {
          id: t.area,
          name: 'Outskirts',
          continent: t.continent,
          mass: cont?.total || 1,
          cities: 0,
          citedBy: cont?.citedBy || 0,
          maxDepth: cont?.maxDepth || 1,
          shared: cont?.shared,
          sampleFibers: [],
        }
      return {
        isTile: true,
        level: 2,
        id: area.id,
        continent: t.continent,
        continentName: cont?.name || t.continent,
        areaName: t.isthmus ? `${area.name} (Isthmus peninsula)` : area.name,
        mass: area.mass,
        cities: area.cities,
        citedBy: t.citedBy || area.citedBy || 0,
        maxDepth: t.depth || area.maxDepth || 0,
        recentRatio: t.recentRatio ?? area.recentRatio ?? 0,
        shared: Boolean(cont?.shared),
        elevation: t.height,
        sampleFibers: area.sampleFibers || [],
      }
    }

    const l3OwnerFor = (m: MicroHex): PickOwner => {
      const city = m.cityId ? cityAt.get(m.parentTile) : undefined
      if (city) return city
      const cont = this.contMap.get(m.continent)
      const area = (m.subArea && subAreaById.get(m.subArea)) ||
        this.areaMap.get(m.subArea) ||
        this.areaMap.get(m.area) || {
          id: m.area,
          name: 'Outskirts',
          continent: m.continent,
          mass: cont?.total || 1,
          cities: 0,
          citedBy: cont?.citedBy || 0,
          maxDepth: cont?.maxDepth || 2,
          shared: cont?.shared,
          sampleFibers: [],
        }
      return {
        isTile: true,
        level: 3,
        id: area.id,
        continent: m.continent,
        continentName: cont?.name || m.continent,
        areaName: area.name,
        subAreaName: m.subAreaName || area.name,
        fiberName: m.subLabel || area.name,
        fiberId: m.subFiberId || null,
        fiberStatus: m.subStatus || 'fiber',
        mass: area.mass,
        cities: area.cities,
        citedBy: m.citedBy || 0,
        maxDepth: m.depth || area.maxDepth || 2,
        recentRatio: m.recentRatio ?? area.recentRatio ?? 0,
        shared: Boolean(cont?.shared),
        elevation: m.height,
        sampleFibers: area.sampleFibers || [],
      }
    }

    const terrainL0 = buildErodedTerrain(atlas.level1, {
      radius: RADIUS * 2,
      subdiv: 2,
      sampler: this.terrainSampler,
      ownerForTile: l0OwnerFor,
      contMap: this.contMap,
      detailTexture: this.terrainDetailTex,
      tier: 'l0',
      mountainMap: this.mountainField.l1,
    })
    this.root.add(terrainL0.mesh, terrainL0.shoalMesh)
    this.terrainMeshes.push(terrainL0)

    const terrainL12 = buildErodedTerrain(atlas.level2, {
      radius: RADIUS,
      subdiv: 4,
      sampler: this.terrainSampler,
      ownerForTile: l2OwnerFor,
      contMap: this.contMap,
      detailTexture: this.terrainDetailTex,
      tier: 'l12',
      l3Tiles: atlas.level3,
      ownerForL3: l3OwnerFor,
      mountainMap: this.mountainField.l2,
    })
    this.root.add(terrainL12.mesh, terrainL12.shoalMesh)
    this.terrainMeshes.push(terrainL12)

    this.riverMesh = buildRiverWaterMesh(this.terrainSampler, this.textures.river)
    this.root.add(this.riverMesh)

    const bL0 = buildDrapedHexBorders(atlas.level1, RADIUS * 2, p => world(nest(p)), this.terrainSampler)
    bL0.userData = { tier: 'l0' }
    this.root.add(bL0)
    this.borderLines.push(bL0)

    const bL1 = buildDrapedHexBorders(atlas.level2, RADIUS, p => world(p), this.terrainSampler)
    bL1.userData = { tier: 'l1_only' }
    this.root.add(bL1)
    this.borderLines.push(bL1)

    const bL2 = buildDrapedHexBorders(atlas.level3, RADIUS * 0.5, p => world(p, RADIUS * 0.5), this.terrainSampler)
    bL2.userData = { tier: 'l2_only' }
    this.root.add(bL2)
    this.borderLines.push(bL2)

    this.pinGroup = new THREE.Group()
    const pinInner = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1.12, 36),
      new THREE.MeshBasicMaterial({
        color: '#ffd369',
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    pinInner.rotation.x = -Math.PI / 2
    const pinOuter = new THREE.Mesh(
      new THREE.RingGeometry(1.16, 1.34, 36),
      new THREE.MeshBasicMaterial({
        color: '#fff2b8',
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    pinOuter.rotation.x = -Math.PI / 2
    this.pinGroup.add(pinInner, pinOuter)
    this.pinGroup.userData = { inner: pinInner, outer: pinOuter }
    this.pinGroup.visible = false
    this.root.add(this.pinGroup)

    buildWorldCordilleras(assetCtx, this.mountainField, this.terrainSampler, l0OwnerFor)
    buildWorldWoodlands(assetCtx, atlas, this.mountainField, this.terrainSampler, l0OwnerFor)
    buildDetailMountainRanges(assetCtx, this.mountainField, this.heights, l2OwnerFor)

    for (const t of atlas.level2) {
      const tk = key(t)
      if (!cityAt.has(tk) && !this.mountainField.l2.has(tk)) {
        const owner = l2OwnerFor(t)
        const area = (t.subArea && subAreaById.get(t.subArea)) || this.areaMap.get(t.area)
        buildCountryside(assetCtx, t, t.x, this.heightAt(t), t.height, t.z, owner, area, 'l12')
      }
    }

    const placedBridges = new Set<string>()
    const placedBridgePts: WorldXZ[] = []
    for (const r of atlas.roads) {
      const c = this.contMap.get(r.continent)
      const cTo = r.toContinent ? this.contMap.get(r.toContinent) : undefined
      const label = r.isthmus
        ? `Overland isthmus road (${c?.name || r.continent} ↔ ${cTo?.name || r.toContinent})`
        : 'Orchestration road (parent → child)'
      const owner: TileOwner = {
        isTile: true,
        continent: r.continent,
        continentName: c?.name || r.continent,
        areaName: label,
        mass: c?.total || 0,
        cities: c?.cities || 0,
        citedBy: c?.citedBy || 0,
        shared: Boolean(c?.shared || cTo?.shared),
      }
      const w = r.isthmus ? 0.105 : 0.078
      this.emitRoadPath(r.points, w, 'road', 0, owner, 'l12', placedBridges, assetCtx, placedBridgePts)
    }

    buildRiparianFlora(assetCtx, this.terrainSampler, atlas, this.mountainField, placedBridgePts)

    for (const isth of atlas.isthmuses || []) {
      const cA = this.contMap.get(isth.a)
      const cB = this.contMap.get(isth.b)
      const owner: TileOwner = {
        isTile: true,
        continent: isth.a,
        continentName: `${cA?.name || isth.a} ↔ ${cB?.name || isth.b}`,
        areaName: 'Overland isthmus stone road',
        mass: (cA?.total || 0) + (cB?.total || 0),
        cities: (cA?.cities || 0) + (cB?.cities || 0),
        citedBy: (cA?.citedBy || 0) + (cB?.citedBy || 0),
        shared: Boolean(cA?.shared || cB?.shared),
      }
      for (let i = 1; i < isth.cells.length; i++) {
        const a = isth.cells[i - 1]
        const b = isth.cells[i]
        if (distance(a, b) !== 1) continue
        const A = world(nest(a))
        const B = world(nest(b))
        const ah = this.terrainSampler.sampleHeight(A.x, A.z) + 0.028
        const bh = this.terrainSampler.sampleHeight(B.x, B.z) + 0.028
        const length = Math.hypot(B.x - A.x, B.z - A.z)
        if (!length) continue
        const item = this.box(
          'road',
          (A.x + B.x) / 2,
          (ah + bh) / 2,
          (A.z + B.z) / 2,
          0.15,
          0.028,
          length + 0.04,
          owner,
          0,
          Math.atan2(B.x - A.x, B.z - A.z),
          'l0',
        )
        item.slope = -Math.atan2(bh - ah, length)
      }
    }

    // Portolan dashed ribbon sea lanes + harbor piers + sailboats
    const placedHarbors = new Set<string>()
    const lanePos: number[] = []
    const laneUvs: number[] = []
    const LANE_Y = SEA_Y + 0.025
    const LANE_HALF_W = 0.08
    const DASH_LEN = 1.22
    const GAP_LEN = 0.74
    const PERIOD = DASH_LEN + GAP_LEN

    const emitDashedRibbon = (run: WorldXZ[]): void => {
      if (run.length < 2) return
      const cum = [0]
      for (let i = 1; i < run.length; i++) {
        cum.push(cum[i - 1] + Math.hypot(run[i].x - run[i - 1].x, run[i].z - run[i - 1].z))
      }
      const total = cum[cum.length - 1]
      if (total < 0.6) return
      const sampleAt = (s: number) => {
        const sc = Math.max(0, Math.min(total, s))
        let i = 0
        while (i < cum.length - 2 && cum[i + 1] < sc) i++
        const segL = cum[i + 1] - cum[i] || 1
        const f = (sc - cum[i]) / segL
        const a = run[i]
        const b = run[i + 1]
        const tx = (b.x - a.x) / segL
        const tz = (b.z - a.z) / segL
        return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, nx: -tz, nz: tx }
      }
      for (let s0 = 0.25; s0 < total - 0.25; s0 += PERIOD) {
        const s1 = Math.min(total - 0.2, s0 + DASH_LEN)
        if (s1 - s0 < 0.25) continue
        const steps = Math.max(1, Math.ceil((s1 - s0) / 0.45))
        let prev = sampleAt(s0)
        let prevV = 0
        for (let k = 1; k <= steps; k++) {
          const v = k / steps
          const cur = sampleAt(s0 + (s1 - s0) * v)
          const pLx = prev.x - prev.nx * LANE_HALF_W
          const pLz = prev.z - prev.nz * LANE_HALF_W
          const pRx = prev.x + prev.nx * LANE_HALF_W
          const pRz = prev.z + prev.nz * LANE_HALF_W
          const cLx = cur.x - cur.nx * LANE_HALF_W
          const cLz = cur.z - cur.nz * LANE_HALF_W
          const cRx = cur.x + cur.nx * LANE_HALF_W
          const cRz = cur.z + cur.nz * LANE_HALF_W
          lanePos.push(pLx, LANE_Y, pLz, pRx, LANE_Y, pRz, cLx, LANE_Y, cLz)
          laneUvs.push(0, prevV, 1, prevV, 0, v)
          lanePos.push(pRx, LANE_Y, pRz, cRx, LANE_Y, cRz, cLx, LANE_Y, cLz)
          laneUvs.push(1, prevV, 1, v, 0, v)
          prev = cur
          prevV = v
        }
      }
    }

    for (const [laneIdx, l] of atlas.lanes.entries()) {
      const pts = l.points
      let run: WorldXZ[] = []
      const flushRun = (): void => {
        emitDashedRibbon(run)
        run = []
      }
      for (const p of pts) {
        if (p.sea) run.push(p)
        else flushRun()
      }
      flushRun()
      if (pts.length >= 4) {
        const cA = this.contMap.get(l.a)
        const cB = this.contMap.get(l.b)
        const portKeyA = `${Math.round(pts[0].x * 0.5)},${Math.round(pts[0].z * 0.5)}`
        if (!placedHarbors.has(portKeyA)) {
          placedHarbors.add(portKeyA)
          const ownerA: TileOwner = {
            isTile: true,
            continent: l.a,
            continentName: cA?.name || l.a,
            areaName: `Harbor Pier (${cA?.name || l.a} ↔ ${cB?.name || l.b} sea lane)`,
            mass: cA?.total || 0,
            cities: cA?.cities || 0,
            citedBy: cA?.citedBy || 0,
            shared: Boolean(cA?.shared),
          }
          buildHarborPier(assetCtx, pts[0], pts[Math.min(2, pts.length - 1)], ownerA, 'all')
        }
        const lastIdx = pts.length - 1
        const portKeyB = `${Math.round(pts[lastIdx].x * 0.5)},${Math.round(pts[lastIdx].z * 0.5)}`
        if (!placedHarbors.has(portKeyB)) {
          placedHarbors.add(portKeyB)
          const ownerB: TileOwner = {
            isTile: true,
            continent: l.b,
            continentName: cB?.name || l.b,
            areaName: `Harbor Pier (${cB?.name || l.b} ↔ ${cA?.name || l.a} sea lane)`,
            mass: cB?.total || 0,
            cities: cB?.cities || 0,
            citedBy: cB?.citedBy || 0,
            shared: Boolean(cB?.shared),
          }
          buildHarborPier(assetCtx, pts[lastIdx], pts[Math.max(0, lastIdx - 2)], ownerB, 'all')
        }
        buildSailboatsForLane(assetCtx, l, laneIdx)
      }
    }

    if (lanePos.length) {
      const laneGeo = new THREE.BufferGeometry()
      laneGeo.setAttribute('position', new THREE.Float32BufferAttribute(lanePos, 3))
      laneGeo.setAttribute('uv', new THREE.Float32BufferAttribute(laneUvs, 2))
      const laneMat = new THREE.MeshBasicMaterial({
        color: SCHEMES.day.lane,
        map: this.textures.laneDash,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      const laneMesh = new THREE.Mesh(laneGeo, laneMat)
      laneMesh.renderOrder = 2
      this.root.add(laneMesh)
      this.seaLaneLines.push(laneMesh)
    }

    for (const n of atlas.fibers) this.buildCityStructure(n)

    for (const batch of this.batches.values()) {
      let material: THREE.Material
      if (batch.role === 'ao') {
        material = new THREE.MeshBasicMaterial({
          color: '#ffffff',
          map: this.textures.ao,
          transparent: true,
          opacity: 0.72,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        })
      } else {
        const rockRole = batch.role === 'rock' || batch.role === 'granite' || batch.role === 'slate'
        const tex =
          batch.kind === 'hex' || batch.kind === 'hexSkirt' || rockRole || batch.role === 'river'
            ? this.textures[rockRole ? 'rock' : batch.role] || null
            : null
        const rough =
          batch.role === 'river'
            ? 0.24
            : batch.role === 'shallow'
              ? 0.3
              : batch.role === 'dome' || batch.role === 'copper' || batch.role === 'metal'
                ? 0.42
                : batch.role === 'snow'
                  ? 0.76
                  : 0.86
        const metal =
          batch.role === 'dome' || batch.role === 'copper' || batch.role === 'metal'
            ? 0.24
            : batch.role === 'river'
              ? 0.1
              : 0
        const stdMat = new THREE.MeshStandardMaterial({
          color: '#ffffff',
          map: tex,
          roughness: rough,
          metalness: metal,
          emissive: '#ffffff',
          emissiveIntensity: batch.glow,
          flatShading:
            batch.kind === 'hexSkirt' ||
            batch.kind === 'peak' ||
            batch.kind === 'crag' ||
            batch.kind === 'ridge' ||
            batch.kind === 'snow',
        })
        stdMat.onBeforeCompile = shader => {
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <emissivemap_fragment>',
            '#include <emissivemap_fragment>\n#if defined(USE_COLOR) || defined(USE_INSTANCING_COLOR)\ntotalEmissiveRadiance *= vColor.rgb;\n#endif',
          )
        }
        if (batch.role === 'smoke') {
          stdMat.transparent = true
          stdMat.opacity = 0.72
          stdMat.depthWrite = false
        }
        material = stdMat
      }
      const m = new THREE.InstancedMesh(this.geos[batch.kind], material, batch.items.length)
      m.castShadow = !['shallow', 'foam', 'road', 'river', 'smoke', 'lane', 'ao'].includes(batch.role)
      m.receiveShadow = batch.role !== 'ao'
      m.userData.batch = batch
      batch.items.forEach((item, i) => {
        item.index = i
        item.mesh = m
        this.applyMatrix(item)
        m.setMatrixAt(i, this.dummy.matrix)
      })
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      this.root.add(m)
      this.instances.push(m)
    }

    this.syncLOD()
    this.createLabels()
    this.applyColors()
    if (this.pinned) {
      this.refreshPinnedSelection()
    }
  }

  private matches = (n: PickOwner | null | undefined): boolean => {
    const lens = this.lens
    if (!lens) return true
    if (!n) return false
    if (lens.type === 'shared') return Boolean(n.shared)
    if (lens.type === 'search') {
      if (n.isTile) return lens.contIds.has(n.continent) || (Boolean(n.id) && lens.areaIds.has(n.id!))
      return lens.cityIds.has(n.id) || lens.areaIds.has(n.area) || lens.contIds.has(n.continent)
    }
    if (n.isTile) return false
    if (lens.type === 'host') return (n.origin || n.host) === lens.value
    return lens.value === 'tapestry' ? Boolean(n.hasTapestry) : n.state === lens.value
  }

  private applyColors(): void {
    if (!this.scene || !this.renderer || !this.postMat || !this.hemi || !this.sun || !this.seaMesh) return
    const mode = this.night ? 'night' : 'day'
    const p = SCHEMES[mode]
    const bp = BIOMES[mode]
    this.tmpShared.set(p.shared)
    this.postMat.uniforms.uNight.value = this.night ? 1.0 : 0.0

    for (const tm of this.terrainMeshes) {
      tm.updateColors(p, bp, this.lens, this.night, this.matches)
    }
    if (this.riverMesh) {
      const mat = this.riverMesh.material as THREE.MeshStandardMaterial
      mat.color.set(this.night ? '#255c78' : '#4696ab')
      mat.emissive.set(this.night ? '#123850' : '#1e5b6e')
      mat.roughness = this.night ? 0.22 : 0.2
      mat.metalness = 0.14
      mat.emissiveIntensity = this.lens ? 0.04 : this.night ? 0.16 : 0.09
    }
    for (const line of this.seaLaneLines) {
      const mat = line.material as THREE.MeshBasicMaterial
      mat.color.set(p.lane)
      mat.opacity = this.lens ? 0.08 : this.night ? 0.5 : 0.48
    }
    for (const bl of this.borderLines) {
      const mat = bl.material as THREE.LineBasicMaterial
      mat.color.set(this.night ? '#9cc2d4' : '#1c3438')
      const baseOp = bl.userData.tier === 'l2_only' ? 0.18 : 0.16
      mat.opacity = this.lens ? 0.04 : baseOp
    }

    const schemeCols: Record<string, THREE.Color> = {}
    for (const [rk, hex] of Object.entries(p)) schemeCols[rk] = new THREE.Color(hex)
    const biomeCols: Record<BiomeId, Record<string, THREE.Color>> = {
      mediterranean: {},
      temperate: {},
      savanna: {},
      nordic: {},
    }
    for (const bk of Object.keys(bp) as BiomeId[]) {
      for (const [rk, hex] of Object.entries(bp[bk])) {
        biomeCols[bk][rk] = new THREE.Color(hex)
      }
    }

    const dimMul = this.night ? 0.18 : 0.26
    const sharedMix = this.lens?.type === 'search' ? 0.22 : 0.13

    for (const m of this.instances) {
      const b = m.userData.batch as BatchGroup
      const fallback = b.custom ? new THREE.Color(b.custom) : schemeCols[b.role] || schemeCols.land
      const useBiome = !b.custom && BIOME_ROLES.has(b.role)
      const items = b.items
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const src = (useBiome && item.biome && biomeCols[item.biome]?.[b.role]) || fallback
        this.tmpCol.copy(src)
        if (this.lens) {
          if (!item.owner || !this.matches(item.owner)) {
            this.tmpGrey.setScalar(this.tmpCol.r * 0.2126 + this.tmpCol.g * 0.7152 + this.tmpCol.b * 0.0722)
            this.tmpCol.lerp(this.tmpGrey, 0.82).multiplyScalar(dimMul)
          } else if (
            (this.lens.type === 'shared' || this.lens.type === 'search') &&
            item.owner.isTile &&
            TERRAIN_ROLES.has(b.role)
          ) {
            this.tmpCol.lerp(this.tmpShared, sharedMix)
          }
        }
        m.setColorAt(i, this.tmpCol)
      }
      if (m.instanceColor) m.instanceColor.needsUpdate = true
      if (b.role === 'ao') {
        ;(m.material as THREE.MeshBasicMaterial).opacity = this.night ? 0.52 : 0.72
      } else {
        ;(m.material as THREE.MeshStandardMaterial).emissiveIntensity = b.glow * (this.night ? 1.65 : 0.48)
      }
    }

    const seaMat = this.seaMesh.material as THREE.MeshStandardMaterial
    seaMat.color.set(p.sea)
    seaMat.roughness = this.night ? 0.42 : 0.36
    this.scene.background = new THREE.Color(p.sea)
    this.hemi.color.set(this.night ? '#b5cae8' : '#fff5dc')
    this.hemi.groundColor.set(this.night ? '#243748' : '#465c5e')
    this.hemi.intensity = this.night ? 1.95 : 1.05
    this.sun.color.set(this.night ? '#a7c2e4' : '#fff0c8')
    this.sun.intensity = this.night ? 1.95 : 3.25
    this.renderer.toneMappingExposure = this.night ? 1.16 : 1.08

    for (const s of this.signals) {
      const hit = !this.lens || this.matches(s.n)
      const dim = hit ? 1 : 0.06
      const liveCity = !['closed', 'settled'].includes(s.n.state)
      const searchDirect = this.lens?.type === 'search' && this.lens.cityIds.has(s.n.id)
      s.m.visible =
        s.type === 'lens-ring'
          ? Boolean(this.lens) &&
            this.matches(s.n) &&
            (this.lens?.type === 'search' ? searchDirect || liveCity : this.lens?.type !== 'shared' || liveCity)
          : dim > 0.1
      if (s.type === 'halo') {
        ;((s.m as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity =
          (this.night ? (s.ask ? 0.88 : 0.86) : s.ask ? 0.24 : 0.16) * dim
      }
      if (s.type === 'forge-glow') {
        ;((s.m as THREE.Sprite).material as THREE.SpriteMaterial).opacity = (this.night ? 0.95 : 0.28) * dim
      }
      if (s.type === 'forge-ring') {
        ;((s.m as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = (this.night ? 0.78 : 0.62) * dim
      }
      if (s.type === 'ask-ring') {
        ;((s.m as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = (this.night ? 0.8 : 0.62) * dim
      }
      if (s.type === 'ring') {
        ;((s.m as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = (this.night ? 0.86 : 0.62) * dim
      }
      if (s.type === 'lantern-glow') {
        ;((s.m as THREE.Sprite).material as THREE.SpriteMaterial).opacity = (this.night ? 0.94 : 0.58) * dim
      }
      if (s.type === 'beam' && s.mesh) {
        const bm = s.mesh.material as THREE.MeshBasicMaterial
        bm.opacity = (this.night ? 0.56 : 0.24) * dim
        bm.blending = this.night ? THREE.AdditiveBlending : THREE.NormalBlending
        bm.needsUpdate = true
      }
    }

    this.el.classList.toggle('night', this.night)
    for (const l of this.labelEls) {
      if (l.continent) {
        if (!this.lens) l.el.style.opacity = '1'
        else if (this.lens.type === 'shared') l.el.style.opacity = l.continent.shared ? '1' : '.32'
        else if (this.lens.type === 'search') {
          const hitCont = this.lens.contIds.has(l.continent.id) || this.lens.activeContIds.has(l.continent.id)
          const hitArea = Boolean(l.area && (this.lens.areaIds.has(l.area.id) || this.lens.contIds.has(l.continent.id)))
          l.el.style.opacity = (l.kind === 'area' ? hitArea : hitCont) ? '1' : '.28'
        } else {
          l.el.style.opacity = '1'
        }
      }
    }
  }

  private setMode(mode: LightingMode): void {
    this.lighting = mode
    this.night = mode === 'night' || (mode === 'auto' && isNightHour(localHour()))
    for (const [m, btn] of this.modeButtons.entries()) {
      btn.classList.toggle('selected', m === mode)
    }
    this.applyColors()
  }

  private computeWorldView(): { x: number; z: number; span: number } {
    if (!this.atlas || this.atlas.tiles.length === 0) {
      return { x: 0, z: 0, span: 160 }
    }
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const t of this.atlas.tiles) {
      if (t.x < minX) minX = t.x
      if (t.x > maxX) maxX = t.x
      if (t.z < minZ) minZ = t.z
      if (t.z > maxZ) maxZ = t.z
    }
    const { width, height } = this.viewportSize()
    const aspect = width / height
    const spanX = Math.max(20, maxX - minX + 16)
    const spanZ = Math.max(20, maxZ - minZ + 16)
    const span = Math.min(240, Math.max(48, Math.max(spanZ * 1.18, (spanX / Math.max(0.6, aspect)) * 1.14)))
    return { x: (minX + maxX) * 0.5, z: (minZ + maxZ) * 0.5, span }
  }

  private jump(name: string): void {
    this.worldBtn.classList.toggle('selected', name === 'World')
    if (name === 'World') {
      const view = this.computeWorldView()
      this.target.set(view.x, 0, view.z)
      this.wantedSpan = view.span
      return
    }
    if (!this.atlas) return
    if (name === 'Street') {
      const n =
        this.atlas.fibers.find(f => f.state === 'working') ||
        this.atlas.fibers.find(f => f.state === 'ask') ||
        this.atlas.fibers[0]
      if (n) {
        this.target.set(n.x - 1.8, 0, n.z + 4.1)
        this.wantedSpan = 16.8
      }
      return
    }
    const q = name.toLowerCase()
    const c = this.atlas.continents.find(item => item.name.toLowerCase() === q || item.id.toLowerCase() === q)
    if (c) {
      this.target.set(c.x, 0, c.z)
      this.wantedSpan = Math.max(38, c.rc * 9.5)
    }
  }

  private jumpArea(a: PlacedArea): void {
    this.target.set(a.x, 0, a.z)
    this.wantedSpan = 18
    this.worldBtn.classList.remove('selected')
  }

  private flyToCity(n: PlacedCity): void {
    this.target.set(n.x, 0, n.z)
    this.wantedSpan = 14
    this.worldBtn.classList.remove('selected')
  }

  private syncRenderTarget(curSpan: number): void {
    if (!this.pixelRT) return
    const { width, height } = this.viewportSize()
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    let nextScale: number
    let nextFilter: THREE.TextureFilter
    if (curSpan > 75) {
      nextScale = 1
      nextFilter = THREE.LinearFilter
    } else if (curSpan > 36) {
      nextScale = 1.5
      nextFilter = THREE.LinearFilter
    } else {
      nextScale = 2
      nextFilter = THREE.NearestFilter
    }
    const rw = Math.max(1, Math.round((width * this.dpr) / nextScale))
    const rh = Math.max(1, Math.round((height * this.dpr) / nextScale))
    if (rw !== this.rtW || rh !== this.rtH) {
      this.rtW = rw
      this.rtH = rh
      this.pixelRT.setSize(rw, rh)
    }
    if (nextFilter !== this.rtFilter) {
      this.rtFilter = nextFilter
      this.pixelRT.texture.minFilter = nextFilter as THREE.MinificationTextureFilter
      this.pixelRT.texture.magFilter = nextFilter as THREE.MagnificationTextureFilter
      this.pixelRT.texture.needsUpdate = true
    }
  }

  private readonly onResize = (): void => {
    if (!this.renderer) return
    const { width, height } = this.viewportSize()
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.renderer.setPixelRatio(this.dpr)
    this.renderer.setSize(width, height)
    this.syncRenderTarget(this.span)
  }

  private createLabels(): void {
    for (const l of this.labelEls) l.el.remove()
    this.labelEls = []
    if (!this.atlas) return

    for (const c of [...this.atlas.continents].sort((a, b) => b.total - a.total)) {
      const isIslet = c.total < 50
      const dispName = c.name
      const el = document.createElement('div')
      el.className = 'continent-label' + (c.shared ? ' shared' : '') + (isIslet ? ' islet' : '')
      const b = document.createElement('button')
      if (c.shared) {
        const mark = document.createElement('span')
        mark.className = 'shared-mark'
        mark.textContent = '◈'
        mark.title = 'Shared territory'
        b.append(mark)
      }
      b.append(dispName)
      const badge = c.active + c.ask
      if (badge > 0) {
        const count = document.createElement('em')
        count.textContent = String(badge)
        b.append(count)
      }
      const statParts = [`${formatCount(c.total)} fibers`]
      if (c.cities) statParts.push(`${c.cities} threads`)
      if (c.active) statParts.push(`${c.active} active`)
      if (c.ask) statParts.push(`${c.ask} ask`)
      if (c.shared) statParts.push('Shared')
      b.title = `${dispName} · ${statParts.join(' · ')} · Click to zoom`
      b.onclick = () => this.jump(c.name)
      el.append(b)
      this.labelsEl.append(el)

      const coreTiles = this.atlas.tiles.filter(t => t.continent === c.id && !t.isthmus)
      const cx = coreTiles.length ? coreTiles.reduce((acc, t) => acc + t.x, 0) / coreTiles.length : c.x
      const cz = coreTiles.length ? coreTiles.reduce((acc, t) => acc + t.z, 0) / coreTiles.length : c.z
      const minZ = coreTiles.length ? Math.min(...coreTiles.map(t => t.z)) : cz - c.rc
      const cy = Math.min(1.2, c.peak * 0.45 + 0.6)
      const worldZ = isIslet ? cz - (cz - minZ) * 0.18 : cz - (cz - minZ) * 0.45
      const northTiles = coreTiles.filter(t => t.z <= minZ + Math.max(2.5, (cz - minZ) * 0.32))
      const northAvgX = northTiles.length ? northTiles.reduce((acc, t) => acc + t.x, 0) / northTiles.length : cx
      const northX = cx * 0.65 + northAvgX * 0.35
      const northZ = minZ + Math.min(0.5, (cz - minZ) * 0.05)

      this.labelEls.push({
        kind: 'continent',
        isIslet,
        textLen: dispName.length + (badge > 0 ? 3 : 0) + (c.shared ? 2 : 0),
        el,
        p: new THREE.Vector3(cx, cy, worldZ),
        northP: new THREE.Vector3(northX, cy, northZ),
        region: c.name,
        continent: c,
      })
    }

    const allAreas = this.atlas.continents
      .flatMap(c => {
        const candidates = [
          ...c.areas
            .filter(a => !a.id.endsWith('#outskirts') && (a.id !== c.id || c.areas.length === 1))
            .map(a => ({ a, c, isSub: false, qualifiesOverview: false })),
          ...(c.subAreas || [])
            .filter(a => a.mass >= 2 || a.citedBy > 0)
            .slice(0, 10)
            .map(a => ({ a, c, isSub: true, qualifiesOverview: false })),
        ]
        let qualCount = 0
        for (const x of candidates) {
          if (x.a.mass >= 18 || (x.a.citedBy || 0) >= 20) {
            x.qualifiesOverview = true
            qualCount++
          }
        }
        if (qualCount < 2 && c.total >= 30) {
          const largest = candidates
            .filter(x => !x.isSub && x.a.mass >= 5)
            .sort((x, y) => y.a.mass - x.a.mass || (y.a.citedBy || 0) - (x.a.citedBy || 0))[0]
          if (largest) largest.qualifiesOverview = true
        }
        return candidates
      })
      .sort((x, y) => Number(x.isSub) - Number(y.isSub) || y.a.mass - x.a.mass || (y.a.citedBy || 0) - (x.a.citedBy || 0))

    for (const { a, c, isSub, qualifiesOverview } of allAreas) {
      const slug = a.slug || a.id.split('/').at(-1) || a.id
      const el = document.createElement('div')
      el.className = 'area-label' + (c.shared || a.shared ? ' shared' : '') + (isSub ? ' outskirts-sub' : '')
      const b = document.createElement('button')
      const nameSpan = document.createElement('span')
      nameSpan.className = 'area-slug'
      nameSpan.textContent = slug
      b.append(nameSpan)
      const countSpan = document.createElement('small')
      countSpan.textContent = `${a.mass}`
      b.append(countSpan)
      b.title = `${c.name} / ${a.name} (${a.mass} fibers${a.citedBy ? `, ${a.citedBy} citations` : ''}) · Click to zoom into district`
      b.onclick = () => this.jumpArea(a)
      el.append(b)
      this.labelsEl.append(el)
      const ay = this.terrainSampler ? Math.max(0.2, this.terrainSampler.sampleHeight(a.x, a.z)) : visH(a.elevation || 0.6)
      this.labelEls.push({
        kind: 'area',
        isSub,
        qualifiesOverview,
        textLen: slug.length + String(a.mass).length + 2,
        el,
        p: new THREE.Vector3(a.x, ay + 0.55, a.z),
        area: a,
        continent: c,
      })
    }

    const nodeRank = (n: PlacedCity): number =>
      n.state === 'ask' ? 4 : n.state === 'working' ? 3 : n.isOrchestrator ? 2 : 1
    const threadNodes = [...this.atlas.fibers]
      .filter(n => !['closed', 'settled'].includes(n.state))
      .sort((a, b) => nodeRank(b) - nodeRank(a) || (b.citedBy || 0) - (a.citedBy || 0))
    for (const n of threadNodes) {
      const el = document.createElement('div')
      const stCls = n.state === 'ask' ? 'ask' : n.state === 'working' ? 'working' : 'resting'
      el.className = 'node-label ' + stCls + (n.isOrchestrator ? ' orchestrator' : '')
      const dot = document.createElement('span')
      dot.className = 'nl-dot'
      const txt = document.createElement('span')
      txt.className = 'nl-text'
      const shortName = smartTruncate(n.name, 30)
      txt.textContent = shortName
      el.append(dot, txt)
      const hostLabel = n.origin || n.host
      el.title = `${n.name} (${n.state}${hostLabel ? ` · ${hostLabel}` : ''})`
      el.onclick = () => this.pinSelection(n, { x: n.x, y: n.elevation, z: n.z })
      this.labelsEl.append(el)
      this.labelEls.push({
        kind: 'node',
        textLen: shortName.length,
        el,
        p: new THREE.Vector3(n.x, n.elevation + (n.state === 'ask' ? 2.5 : n.isOrchestrator ? 2.8 : 2.4), n.z),
        node: n,
        continent: this.contMap.get(n.continent),
      })
    }

    const seenSub = new Set<string>()
    for (const m of this.atlas.level3) {
      if (!m.subLabel || m.cityId || seenSub.has(m.parentTile)) continue
      seenSub.add(m.parentTile)
      const el = document.createElement('div')
      el.className = 'node-label subthread'
      const shortSub = smartTruncate(m.subLabel, 24)
      el.textContent = shortSub
      el.title = m.subLabel
      this.labelsEl.append(el)
      const my = this.terrainSampler ? Math.max(0.15, this.terrainSampler.sampleHeight(m.x, m.z)) : visH(m.height)
      this.labelEls.push({
        kind: 'subthread',
        textLen: shortSub.length,
        el,
        p: new THREE.Vector3(m.x, my + 0.72, m.z),
        sub: m,
        continent: this.contMap.get(m.continent),
      })
    }
  }

  private positionLabels(): void {
    if (!this.camera) return
    const { width, height } = this.viewportSize()
    const wideDrawer = Boolean(this.pinned && width >= 1000)
    const narrowDrawer = Boolean(this.pinned && width < 1000)
    const maxX = wideDrawer ? width * 0.5 - 18 : width - 18
    const occupied = [
      { x: 18, y: 14, w: 240, h: 44 },
      { x: wideDrawer ? width * 0.5 - 205 : width - 205, y: 14, w: 188, h: 48 },
    ]
    if (this.searchOpen) occupied.push({ x: width / 2 - 240, y: 56, w: 480, h: 340 })

    const contOffsets: ReadonlyArray<[number, number]> = [
      [0, 0],
      [0, -16],
      [0, 16],
      [-22, -10],
      [22, -10],
      [-22, 10],
      [22, 10],
    ]
    const areaOffsets: ReadonlyArray<[number, number]> = [
      [0, 0],
      [0, -18],
      [0, 18],
      [-30, -12],
      [30, -12],
      [-30, 12],
      [30, 12],
      [-46, 0],
      [46, 0],
      [0, -34],
      [0, 34],
      [-38, -26],
      [38, -26],
      [-38, 26],
      [38, 26],
    ]
    const nodeOffsets: ReadonlyArray<[number, number]> = [
      [0, -4],
      [0, -22],
      [0, 14],
      [-32, -12],
      [32, -12],
      [-32, 12],
      [32, 12],
      [0, -34],
      [0, 28],
      [-46, -22],
      [46, -22],
    ]
    let areaShown = 0
    let nodeShown = 0
    let subShown = 0
    const maxAreas = this.span <= 38 ? 6 : 5
    const zoomedInCont = this.span <= 78

    for (const l of this.labelEls) {
      let visible = false
      if (!narrowDrawer) {
        if (l.kind === 'continent') visible = this.span > 20
        else if (l.kind === 'area' && l.area) {
          const searchHit = this.lens?.type === 'search' && this.lens.areaIds.has(l.area.id)
          const inSpan = l.isSub ? this.span > 17 && this.span <= 42 : this.span > 17 && this.span <= 72
          visible =
            (inSpan &&
              Boolean(l.qualifiesOverview) &&
              areaShown < maxAreas &&
              (!this.lens || this.lens.type !== 'shared' || Boolean(l.continent?.shared || l.area?.shared))) ||
            searchHit
        } else if (l.kind === 'node' && l.node) {
          visible =
            (this.span <= 20 && nodeShown < 10 && this.matches(l.node)) ||
            (this.lens?.type === 'search' && this.lens.cityIds.has(l.node.id) && this.lens.cityIds.size <= 18)
        } else if (l.kind === 'subthread') {
          visible = this.span <= 11 && subShown < 4 && (!this.lens || this.lens.type !== 'shared' || Boolean(l.continent?.shared))
        }
      }
      if (l.kind === 'continent') l.el.classList.toggle('zoomed-in', zoomedInCont)
      const anchor = l.kind === 'continent' && zoomedInCont && l.northP ? l.northP : l.p
      const v = anchor.clone().project(this.camera)
      const x0 = (v.x * 0.5 + 0.5) * width
      const y0 = (-v.y * 0.5 + 0.5) * height

      let w: number
      let h: number
      let candOffsets: ReadonlyArray<[number, number]>
      let padX = 8
      let padY = 6
      if (l.kind === 'continent') {
        w = l.isIslet ? Math.max(76, l.textLen * 5.6 + 18) : Math.max(96, l.textLen * 6.8 + 26)
        h = l.isIslet ? 20 : 26
        candOffsets = contOffsets
        padX = 10
        padY = 8
      } else if (l.kind === 'area') {
        w = Math.min(148, Math.max(60, l.textLen * 5.8 + 20))
        h = 21
        candOffsets = areaOffsets
        padX = 28
        padY = 18
      } else if (l.kind === 'node') {
        w = Math.min(195, Math.max(54, l.textLen * 5.6 + 28))
        h = 23
        candOffsets = nodeOffsets
        padX = 10
        padY = 6
      } else {
        w = Math.min(165, Math.max(52, l.textLen * 5.2 + 14))
        h = 19
        candOffsets = nodeOffsets
        padX = 14
        padY = 10
      }

      let placed: { x: number; y: number; dx: number; dy: number; rect: { x: number; y: number; w: number; h: number } } | null = null
      if (visible && v.z > -1 && v.z < 1) {
        for (const [dx, dy] of candOffsets) {
          const x = x0 + dx
          const y = y0 + dy
          if (x - w / 2 <= 18 || x + w / 2 >= maxX || y <= 58 || y >= height - 86) continue
          const rect = { x: x - w / 2, y: y - h, w, h }
          if (
            !occupied.some(
              r =>
                rect.x < r.x + r.w + padX &&
                rect.x + rect.w + padX > r.x &&
                rect.y < r.y + r.h + padY &&
                rect.y + rect.h + padY > r.y,
            )
          ) {
            placed = { x, y, dx, dy, rect }
            break
          }
        }
      }

      if (placed) {
        occupied.push(placed.rect)
        if (l.kind === 'area') areaShown++
        else if (l.kind === 'node') nodeShown++
        else if (l.kind === 'subthread') subShown++
        l.el.style.display = l.kind === 'node' ? 'inline-flex' : 'block'
        l.el.style.left = placed.x + 'px'
        l.el.style.top = placed.y + 'px'
        if (l.kind === 'node') {
          const tailPx = Math.max(11, Math.min(w - 11, w / 2 - placed.dx))
          l.el.style.setProperty('--tail-x', Math.round(tailPx) + 'px')
          l.el.classList.toggle('tail-up', placed.dy > 10)
        }
      } else {
        l.el.style.display = 'none'
      }
    }
  }

  private updateSearch(raw: string): void {
    if (!this.atlas) return
    const q = raw.trim().replace(/^\//, '')
    if (!q) {
      this.searchResults = []
      this.searchIndex = 0
      this.searchCount.textContent = `${this.atlas.continents.length} continents · ${this.atlas.fibers.length} threads`
      for (const c of [...this.atlas.continents].sort((a, b) => b.total - a.total).slice(0, 8)) {
        this.searchResults.push({
          kind: 'continent',
          score: 0,
          title: c.name,
          badge: 'CONTINENT',
          badgeClass: 'continent',
          meta: `${formatCount(c.total)}f · ${c.cities} cities`,
          target: c,
        })
      }
      this.setLens(this.locked)
      this.renderSearchResults()
      return
    }

    const matches: SearchResultItem[] = []
    const contIds = new Set<string>()
    const areaIds = new Set<string>()
    const cityIds = new Set<string>()
    const activeContIds = new Set<string>()
    const byKey = new Map<string, SearchResultItem>()
    const normSlug = (s: string | undefined): string =>
      String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const dedupKeysFor = (id: string, continent: string | null, slug: string | null): string[] => {
      const keys: string[] = []
      const nid = normEntityId(id)
      if (nid) keys.push(nid)
      if (continent && slug) keys.push(`${normEntityId(continent)}/${normSlug(slug)}`)
      return keys
    }

    for (const c of this.atlas.continents) {
      const sc = Math.max(scoreQuery(q, c.name), scoreQuery(q, c.id))
      if (sc > 0) {
        contIds.add(c.id)
        activeContIds.add(c.id)
        const entry: SearchResultItem = {
          kind: 'continent',
          score: sc + 25,
          title: c.name,
          badge: 'CONTINENT',
          badgeClass: 'continent',
          meta: `${formatCount(c.total)}f · ${c.cities} cities`,
          target: c,
        }
        matches.push(entry)
        for (const k of dedupKeysFor(c.id, null, null)) byKey.set(k, entry)
      }
    }

    for (const n of this.atlas.fibers) {
      const c = this.contMap.get(n.continent)
      const dispC = c?.name || n.continent
      const hostName = n.origin || n.host
      const nsc = Math.max(
        scoreQuery(q, n.name),
        scoreQuery(q, n.id),
        scoreQuery(q, hostName) * 0.7,
        scoreQuery(q, n.channel) * 0.75,
      )
      if (nsc > 0) {
        cityIds.add(n.id)
        activeContIds.add(n.continent)
        const stateBonus = n.state === 'working' ? 12 : n.state === 'ask' ? 14 : n.state === 'resting' ? 6 : 0
        const badge = n.state === 'closed' ? (n.tempered === false ? 'DISCARDED' : 'TEMPERED') : n.state.toUpperCase()
        const entry: SearchResultItem = {
          kind: 'city',
          score: nsc + stateBonus,
          title: n.name,
          badge,
          badgeClass: n.state,
          meta: `${dispC}${hostName ? ` · ${hostName}` : ''}`,
          target: n,
        }
        const dKeys = dedupKeysFor(n.id, n.continent, n.id.split('/').at(-1) || null)
        const existing = dKeys.map(k => byKey.get(k)).find(Boolean)
        if (!existing) {
          matches.push(entry)
          for (const k of dKeys) byKey.set(k, entry)
        } else if (existing.kind === 'city' && entry.score > existing.score) {
          Object.assign(existing, entry)
        }
      }
    }

    for (const c of this.atlas.continents) {
      const seenAreaId = new Set<string>()
      for (const a of [...c.areas.filter(x => !x.id.endsWith('#outskirts')), ...(c.subAreas || [])]) {
        const naid = normEntityId(a.id)
        if (seenAreaId.has(naid)) continue
        seenAreaId.add(naid)
        const slug = a.slug || a.id.split('/').at(-1) || a.id
        const sampleHit = (a.sampleFibers || []).map(f => scoreQuery(q, f) * 0.85).reduce((m, v) => Math.max(m, v), 0)
        const asc = Math.max(scoreQuery(q, slug), scoreQuery(q, a.name), scoreQuery(q, a.id), sampleHit)
        if (asc > 0) {
          areaIds.add(a.id)
          activeContIds.add(c.id)
          const dKeys = dedupKeysFor(a.id, c.id, slug)
          const existing = dKeys.map(k => byKey.get(k)).find(Boolean)
          if (existing) {
            existing.score = Math.max(existing.score, asc + 12)
            if (!existing.areaMeta) existing.areaMeta = a
            continue
          }
          const entry: SearchResultItem = {
            kind: 'area',
            score: asc + 14 + (a.citedBy ? Math.min(8, Math.log2(1 + a.citedBy)) : 0),
            title: `/${slug}`,
            badge: 'DISTRICT',
            badgeClass: 'area',
            meta: `${c.name} · ${a.mass}f`,
            target: a,
            continent: c,
          }
          matches.push(entry)
          for (const k of dKeys) byKey.set(k, entry)
        }
      }
    }

    matches.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    const totalMatches = matches.length
    this.searchCount.textContent = `${totalMatches} match${totalMatches === 1 ? '' : 'es'}`
    this.searchResults = matches.slice(0, 9)
    this.searchIndex = 0
    this.setLens({ type: 'search', value: q, contIds, areaIds, cityIds, activeContIds })
    this.renderSearchResults()
  }

  private renderSearchResults(): void {
    this.searchList.replaceChildren()
    if (!this.searchResults.length) {
      const li = document.createElement('li')
      li.className = 'res-empty'
      li.textContent = 'No matching continents, /districts, or Shuttle threads'
      this.searchList.append(li)
      return
    }
    this.searchResults.forEach((r, idx) => {
      const li = document.createElement('li')
      li.className = idx === this.searchIndex ? 'active' : ''
      li.setAttribute('role', 'option')
      li.setAttribute('aria-selected', String(idx === this.searchIndex))
      const main = document.createElement('div')
      main.className = 'res-main'
      const badge = document.createElement('span')
      badge.className = `res-badge ${r.badgeClass || ''}`
      badge.textContent = r.badge
      const title = document.createElement('span')
      title.className = 'res-title'
      title.textContent = r.title
      main.append(badge, title)
      const meta = document.createElement('span')
      meta.className = 'res-meta'
      meta.textContent = r.meta
      li.append(main, meta)
      li.onmouseenter = () => {
        this.searchIndex = idx
        this.searchList.querySelectorAll('li').forEach((el, i) => el.classList.toggle('active', i === idx))
      }
      li.onclick = () => this.activateSearchResult(r)
      this.searchList.append(li)
    })
  }

  private activateSearchResult(r: SearchResultItem): void {
    this.closeSearch()
    if (r.kind === 'continent') {
      this.jump(r.target.name)
      const contSel: ContinentSelection = { ...r.target, isContinent: true }
      this.pinSelection(contSel, {
        x: r.target.x,
        y: this.terrainSampler ? this.terrainSampler.sampleHeight(r.target.x, r.target.z) : 0.5,
        z: r.target.z,
      })
    } else if (r.kind === 'area') {
      this.jumpArea(r.target)
      const cont = r.continent || this.contMap.get(r.target.continent)
      const tileSel: TileOwner = {
        isTile: true,
        level: 2,
        id: r.target.id,
        continent: r.target.continent || cont?.id || '',
        continentName: cont?.name || '',
        areaName: r.target.name,
        mass: r.target.mass,
        cities: r.target.cities,
        citedBy: r.target.citedBy || 0,
        shared: Boolean(cont?.shared || r.target.shared),
        sampleFibers: r.target.sampleFibers || [],
      }
      this.pinSelection(tileSel, {
        x: r.target.x,
        y: this.terrainSampler ? this.terrainSampler.sampleHeight(r.target.x, r.target.z) : 0.4,
        z: r.target.z,
      })
    } else {
      this.flyToCity(r.target)
      this.pinSelection(r.target, { x: r.target.x, y: r.target.elevation, z: r.target.z })
    }
  }

  private openSearch(initialQuery = ''): void {
    this.searchOpen = true
    this.searchModal.classList.add('open')
    this.searchModal.setAttribute('aria-hidden', 'false')
    this.searchTrigger.classList.add('selected')
    this.searchInput.value = initialQuery
    this.updateSearch(this.searchInput.value)
    clearTimeout(this.focusTimer)
    this.focusTimer = window.setTimeout(() => this.searchInput.focus(), 10)
  }

  private closeSearch(): void {
    this.searchOpen = false
    this.searchModal.classList.remove('open')
    this.searchModal.setAttribute('aria-hidden', 'true')
    this.searchTrigger.classList.remove('selected')
    this.searchInput.blur()
    this.setLens(this.locked)
  }

  private clearPin(): void {
    this.pinned = null
    this.pinnedPos = null
    this.drawerTab = 'thread'
    if (this.pinGroup) this.pinGroup.visible = false
    this.drawerEl.classList.remove('open')
    this.drawerEl.setAttribute('aria-hidden', 'true')
    this.el.classList.remove('drawer-open')
    this.rdBody.replaceChildren()
  }

  private threadUrl(uid: string, host: string): string {
    const baseHref = this.opts.base
      ? new URL(`${this.opts.base.replace(/\/+$/, '')}/`, window.location.href).href
      : window.location.href
    const url = new URL(threadHref(baseHref, { uid, host }))
    if (this.opts.route.inRex) url.searchParams.set('in', 'rex')
    else url.searchParams.delete('in')
    return url.href
  }

  private renderDrawerBody(item: PinSelectionItem, dispCont: string): void {
    if (!this.atlas) {
      this.rdBody.replaceChildren()
      return
    }

    const isContinent = Boolean(item.isContinent)
    const isTile = Boolean(item.isTile)
    const isCity = !isTile && !isContinent

    if (isCity) {
      const city = item as PlacedCity
      const channelName = city.channel || (city.isOrchestrator ? dispCont : null)
      if (this.drawerTab === 'channel' && channelName) {
        this.rdBody.replaceChildren()
        const pad = document.createElement('div')
        pad.className = 'rd-pad'
        const livePeers = this.atlas.fibers
          .filter(
            f =>
              (city.channel ? f.channel === city.channel : f.continent === city.continent) &&
              !['closed', 'settled'].includes(f.state),
          )
          .sort(
            (a, b) =>
              (a.state === 'ask' ? 0 : a.state === 'working' ? 1 : a.isOrchestrator ? 2 : 3) -
                (b.state === 'ask' ? 0 : b.state === 'working' ? 1 : b.isOrchestrator ? 2 : 3) ||
              a.name.localeCompare(b.name),
          )
        const title = document.createElement('div')
        title.className = 'rd-fibers-title'
        title.textContent = `#${channelName} · ${livePeers.length} live thread${livePeers.length === 1 ? '' : 's'}`
        pad.append(title)
        if (livePeers.length) {
          const ul = document.createElement('ul')
          ul.className = 'rd-fibers'
          for (const pf of livePeers.slice(0, 24)) {
            const li = document.createElement('li')
            li.className = 'clickable'
            const nm = document.createElement('span')
            nm.textContent = pf.name
            const st = document.createElement('small')
            st.style.color = 'var(--map-muted)'
            const peerHost = pf.origin || pf.host
            st.textContent = peerHost ? `${pf.state} · ${peerHost}` : pf.state
            li.append(nm, st)
            li.onclick = () => {
              this.flyToCity(pf)
              this.pinSelection(pf, { x: pf.x, y: pf.elevation, z: pf.z })
            }
            ul.append(li)
          }
          pad.append(ul)
        } else {
          const box = document.createElement('div')
          box.className = 'rd-offline-box'
          box.textContent = `No active or resting threads in #${channelName}.`
          pad.append(box)
        }
        this.rdBody.append(pad)
        return
      }

      const hostId = city.origin || city.host || ''
      if (city.uid && hostId) {
        const nextSrc = this.threadUrl(city.uid, hostId)
        const existing = this.rdBody.firstElementChild
        if (
          existing instanceof HTMLIFrameElement &&
          existing.classList.contains('rd-preview-frame') &&
          existing.dataset.threadSrc === nextSrc
        ) {
          existing.title = `Thread reader: ${city.name}`
          return
        }
        this.rdBody.replaceChildren()
        const iframe = document.createElement('iframe')
        iframe.className = 'rd-preview-frame'
        iframe.title = `Thread reader: ${city.name}`
        iframe.dataset.threadSrc = nextSrc
        iframe.src = nextSrc
        this.rdBody.append(iframe)
      } else {
        this.rdBody.replaceChildren()
        const pad = document.createElement('div')
        pad.className = 'rd-pad'
        const box = document.createElement('div')
        box.className = 'rd-offline-box'
        const lines: string[] = []
        if (city.outcome) lines.push(city.outcome)
        else if (city.summary) lines.push(city.summary)
        else {
          const areaObj = this.areaMap.get(city.area)
          lines.push(
            `${city.isOrchestrator ? 'Orchestrator citadel' : 'Shuttle constitution'} in ${dispCont}${areaObj ? ` / ${areaObj.name}` : ''}.`,
          )
          if (city.channel) lines.push(`Channel: #${city.channel}`)
          if (city.agent) lines.push(`Agent: ${city.agent} · Kind: ${city.kind || 'oneshot'}`)
        }
        for (const l of lines) {
          const p = document.createElement('div')
          p.textContent = l
          box.append(p)
        }
        const note = document.createElement('div')
        note.className = 'rd-offline-note'
        note.textContent = 'No live thread address attached to this fiber.'
        box.append(note)
        pad.append(box)

        const related = this.atlas.fibers
          .filter(f => f.id !== city.id && (f.area === city.area || f.continent === city.continent) && !['closed', 'settled'].includes(f.state))
          .slice(0, 8)
        if (related.length) {
          const t = document.createElement('div')
          t.className = 'rd-fibers-title'
          t.textContent = `Nearby threads in ${dispCont}`
          pad.append(t)
          const ul = document.createElement('ul')
          ul.className = 'rd-fibers'
          for (const rf of related) {
            const li = document.createElement('li')
            li.className = 'clickable'
            const nm = document.createElement('span')
            nm.textContent = rf.name
            const st = document.createElement('small')
            st.style.color = 'var(--map-muted)'
            st.textContent = rf.state
            li.append(nm, st)
            li.onclick = () => {
              this.flyToCity(rf)
              this.pinSelection(rf, { x: rf.x, y: rf.elevation, z: rf.z })
            }
            ul.append(li)
          }
          pad.append(ul)
        }
        this.rdBody.append(pad)
      }
      return
    }

    this.rdBody.replaceChildren()
    const pad = document.createElement('div')
    pad.className = 'rd-pad'
    const sampleFibers = !isContinent ? (item as TileOwner).sampleFibers : undefined
    const fibersList = sampleFibers?.length
      ? sampleFibers
      : this.atlas.fibers
          .filter(f => (isContinent ? f.continent === item.id : f.area === item.id || f.continent === (item as TileOwner).continent))
          .slice(0, 12)
          .map(f => f.name)
    if (fibersList.length) {
      const h = document.createElement('div')
      h.className = 'rd-fibers-title'
      h.textContent = isContinent ? 'Featured threads' : 'Fibers in this district'
      pad.append(h)
      const ul = document.createElement('ul')
      ul.className = 'rd-fibers'
      for (const fn of fibersList.slice(0, 12)) {
        const li = document.createElement('li')
        li.textContent = fn
        ul.append(li)
      }
      const totalF = isContinent ? (item as ContinentSelection).total || 0 : (item as TileOwner).mass || 0
      if (totalF > fibersList.length) {
        const more = document.createElement('li')
        more.className = 'more'
        more.textContent = `+${formatCount(totalF - Math.min(12, fibersList.length))} more fibers`
        ul.append(more)
      }
      pad.append(ul)
    }
    this.rdBody.append(pad)
  }

  private renderDrawerHeader(item: PinSelectionItem): string {
    const isContinent = Boolean(item.isContinent)
    const isTile = Boolean(item.isTile)
    const isCity = !isTile && !isContinent
    const contId = isContinent ? (item as ContinentSelection).id : (item as PlacedCity | TileOwner).continent
    const cont = this.contMap.get(contId)
    const dispCont = cont?.name || (isTile ? (item as TileOwner).continentName : '') || contId

    let badgeText = ''
    let badgeCls = ''
    if (isContinent) {
      badgeText = 'CONTINENT'
      badgeCls = 'continent'
    } else if (isCity) {
      const city = item as PlacedCity
      badgeText = city.state === 'closed' ? (city.tempered === false ? 'DISCARDED' : 'TEMPERED') : (city.state || 'THREAD').toUpperCase()
      badgeCls = city.state || ''
    } else {
      const tile = item as TileOwner
      badgeText = tile.level === 3 && tile.fiberId ? 'FIBER' : 'DISTRICT'
      badgeCls = 'area'
    }

    this.rdBadge.textContent = badgeText
    this.rdBadge.className = `rd-badge ${badgeCls}`
    if (isContinent) {
      this.rdTitle.textContent = dispCont
      this.rdPath.textContent = (item as ContinentSelection).id
    } else if (isCity) {
      const city = item as PlacedCity
      this.rdTitle.textContent = city.name
      this.rdPath.textContent = city.id
    } else {
      const tile = item as TileOwner
      this.rdTitle.textContent = tile.level === 3 && tile.fiberName ? tile.fiberName : tile.areaName || tile.name || ''
      this.rdPath.textContent = tile.fiberId || tile.id || tile.continent || ''
    }

    this.rdMeta.replaceChildren()
    const addChip = (text: string, dotCol: string | null = null): void => {
      const sp = document.createElement('span')
      sp.className = 'rd-chip'
      if (dotCol) {
        const d = document.createElement('span')
        d.className = 'rd-dot'
        d.style.background = dotCol
        sp.append(d)
      }
      sp.append(document.createTextNode(text))
      this.rdMeta.append(sp)
    }

    if (isCity) {
      const city = item as PlacedCity
      const st = city.state === 'closed' ? (city.tempered === false ? 'discarded' : 'tempered') : city.state
      addChip(st)
      const hostName = city.origin || city.host
      if (hostName) addChip(hostName, hostColor(hostName))
      if (city.channel) addChip(`#${city.channel}`)
      if (city.citedBy) addChip(`${city.citedBy} citations`)
      if (city.shared) addChip('◈ Shared')
    } else if (isContinent) {
      const c = item as ContinentSelection
      addChip(`${formatCount(c.total || 0)} fibers`)
      if (c.cities) addChip(`${c.cities} threads`)
      if (c.citedBy) addChip(`${formatCount(c.citedBy)} citations`)
      if (c.shared) addChip('◈ Shared')
    } else {
      const tile = item as TileOwner
      if (dispCont) addChip(dispCont)
      if (tile.mass) addChip(`${formatCount(tile.mass)} fibers`)
      if (tile.citedBy) addChip(`${formatCount(tile.citedBy)} citations`)
      if (tile.shared) addChip('◈ Shared')
    }

    this.rdTabs.replaceChildren()
    const cityItem = isCity ? (item as PlacedCity) : null
    const hasChannelTab = Boolean(cityItem && (cityItem.isOrchestrator || cityItem.channel))
    if (!hasChannelTab) this.drawerTab = 'thread'
    this.rdTabs.classList.toggle('visible', hasChannelTab)
    if (hasChannelTab) {
      for (const [tid, label] of [
        ['thread', 'Thread'],
        ['channel', 'Channel'],
      ] as const) {
        const tb = document.createElement('button')
        tb.className = 'rd-tab' + (this.drawerTab === tid ? ' active' : '')
        tb.setAttribute('role', 'tab')
        tb.setAttribute('aria-selected', String(this.drawerTab === tid))
        tb.textContent = label
        tb.onclick = e => {
          e.stopPropagation()
          this.drawerTab = tid
          this.rdTabs.querySelectorAll('.rd-tab').forEach(b => {
            const on = b === tb
            b.classList.toggle('active', on)
            b.setAttribute('aria-selected', String(on))
          })
          this.renderDrawerBody(item, dispCont)
        }
        this.rdTabs.append(tb)
      }
    }

    this.rdActions.replaceChildren()
    if (cityItem && !['closed', 'settled'].includes(cityItem.state) && (cityItem.uid || cityItem.id)) {
      const hostId = cityItem.origin || cityItem.host || ''
      if (hostId) {
        const openLabel = this.opts.route.inRex ? 'Open in Rex' : 'Open thread'
        const rexBtn = document.createElement('button')
        rexBtn.className = 'rd-btn primary'
        rexBtn.textContent = openLabel
        rexBtn.onclick = async () => {
          const uid = cityItem.uid || cityItem.id
          if (!this.opts.route.inRex) {
            this.opts.navigate(this.threadUrl(uid, hostId))
            return
          }
          rexBtn.disabled = true
          rexBtn.textContent = 'Opening…'
          try {
            await this.focusCity(cityItem, uid, hostId)
          } finally {
            if (!this.disposed) {
              rexBtn.disabled = false
              rexBtn.textContent = openLabel
            }
          }
        }
        this.rdActions.append(rexBtn)
      }
    }

    return dispCont
  }

  private resolvePinnedItem(
    item: PinSelectionItem,
  ): { item: PinSelectionItem; pos: { x: number; y: number; z: number } } | null {
    if (!this.atlas) return null
    if (item.isContinent) {
      const cont = this.atlas.continents.find(c => c.id === item.id)
      if (!cont) return null
      const fresh: ContinentSelection = { ...cont, isContinent: true }
      const y = this.terrainSampler ? this.terrainSampler.sampleHeight(cont.x, cont.z) : 0.5
      return { item: fresh, pos: { x: cont.x, y, z: cont.z } }
    }
    if (item.isTile) {
      const cont = this.contMap.get(item.continent)
      if (item.id) {
        let area: PlacedArea | undefined
        for (const c of this.atlas.continents) {
          area = c.areas.find(a => a.id === item.id) || (c.subAreas || []).find(a => a.id === item.id)
          if (area) break
        }
        if (!area) return null
        const fresh: TileOwner = {
          ...item,
          continentName: cont?.name || item.continentName,
          mass: area.mass,
          cities: area.cities,
          citedBy: area.citedBy || item.citedBy,
          shared: Boolean(cont?.shared || area.shared),
          sampleFibers: area.sampleFibers || item.sampleFibers,
        }
        const px = this.pinnedPos?.x ?? area.x
        const pz = this.pinnedPos?.z ?? area.z
        const py = this.terrainSampler ? this.terrainSampler.sampleHeight(px, pz) : (this.pinnedPos?.y ?? 0.4)
        return { item: fresh, pos: { x: px, y: py, z: pz } }
      }
      if (!cont) return null
      const fresh: TileOwner = {
        ...item,
        continentName: cont.name,
        shared: Boolean(cont.shared),
      }
      const px = this.pinnedPos?.x ?? cont.x
      const pz = this.pinnedPos?.z ?? cont.z
      const py = this.terrainSampler ? this.terrainSampler.sampleHeight(px, pz) : (this.pinnedPos?.y ?? 0.4)
      return { item: fresh, pos: { x: px, y: py, z: pz } }
    }
    const city = item as PlacedCity
    const fresh =
      (city.uid ? this.atlas.fibers.find(f => f.uid === city.uid) : undefined) ??
      this.atlas.fibers.find(f => f.id === city.id)
    if (!fresh) return null
    return { item: fresh, pos: { x: fresh.x, y: fresh.elevation, z: fresh.z } }
  }

  private refreshPinnedSelection(): void {
    if (!this.pinned) return
    const resolved = this.resolvePinnedItem(this.pinned)
    if (!resolved) {
      this.clearPin()
      return
    }
    this.pinned = resolved.item
    this.pinnedPos = resolved.pos
    if (this.pinGroup) {
      this.pinGroup.position.set(resolved.pos.x, Math.max(SEA_Y + 0.08, resolved.pos.y) + 0.085, resolved.pos.z)
      this.pinGroup.visible = true
    }
    const dispCont = this.renderDrawerHeader(resolved.item)
    this.renderDrawerBody(resolved.item, dispCont)
  }

  private pinSelection(item: PinSelectionItem | null, worldPos: { x?: number; y?: number; z?: number } | null = null): void {
    if (!item) {
      this.clearPin()
      return
    }
    this.pinned = item
    this.drawerTab = 'thread'
    const px = worldPos?.x ?? item.x ?? 0
    const pz = worldPos?.z ?? item.z ?? 0
    const py =
      worldPos?.y ??
      ('elevation' in item ? item.elevation : undefined) ??
      (this.terrainSampler ? this.terrainSampler.sampleHeight(px, pz) : 0.18)
    this.pinnedPos = { x: px, y: py, z: pz }
    if (this.pinGroup) {
      this.pinGroup.position.set(px, Math.max(SEA_Y + 0.08, py) + 0.085, pz)
      this.pinGroup.visible = true
    }

    this.target.set(px, 0, pz)

    const dispCont = this.renderDrawerHeader(item)
    this.renderDrawerBody(item, dispCont)
    this.drawerEl.classList.add('open')
    this.drawerEl.setAttribute('aria-hidden', 'false')
    this.el.classList.add('drawer-open')
  }

  private async focusCity(city: PlacedCity, uid: string, host: string): Promise<void> {
    this.showToast(`Opening in Rex · ${city.name}`)
    try {
      const answer = await go(this.opts.base, { uid, host })
      if (answer.went) {
        const label = answer.place === 'view' ? 'Opened thread view in Rex' : 'Opened in Rex'
        this.showToast(`${label} · ${city.name}`)
      } else if (answer.place === 'live' || answer.place === 'view') {
        this.showToast(`Rex could not show ${city.name}`)
      } else {
        this.showToast(`${city.name} is not running`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.showToast(`Rex unavailable · ${msg}`)
    }
  }

  private showToast(msg: string, ms = 4200): void {
    if (this.disposed) return
    this.toastEl.textContent = msg
    this.toastEl.style.opacity = '1'
    clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => {
      if (!this.disposed) this.toastEl.style.opacity = '0'
    }, ms)
  }

  private hit(e: PointerEvent): { owner: PickOwner; point: THREE.Vector3 } | null {
    if (!this.camera || !this.renderer) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, 1 - ((e.clientY - rect.top) / rect.height) * 2)
    this.ray.setFromCamera(this.pointer, this.camera)
    let tileHit: { owner: PickOwner; point: THREE.Vector3 } | null = null
    for (const h of this.ray.intersectObjects(this.pickables, false)) {
      let n: PickOwner | null = null
      if (h.object.userData.isTerrainMesh || h.object.userData.isRiverMesh) {
        const fn = h.object.userData.ownerForHit as ((hit: THREE.Intersection, lod: number) => PickOwner | null) | undefined
        n = fn ? fn(h, this.lodTier) : null
      } else if (h.object.userData.batch && h.instanceId !== undefined) {
        const batch = h.object.userData.batch as BatchGroup
        n = batch.items[h.instanceId]?.owner || null
      }
      if (!n) continue
      if (!n.isTile) return { owner: n, point: h.point }
      if (!tileHit) tileHit = { owner: n, point: h.point }
    }
    return tileHit
  }

  private readonly onDocumentClick = (e: MouseEvent): void => {
    if (!this.hostsWrap.contains(e.target as Node)) {
      this.hostsWrap.classList.remove('open')
      this.hostsTrigger.setAttribute('aria-expanded', 'false')
    }
  }

  private readonly onWindowKeydown = (e: KeyboardEvent): void => {
    const active = document.activeElement
    if (
      e.key === '/' &&
      !this.searchOpen &&
      active !== this.searchInput &&
      !(active && ['INPUT', 'TEXTAREA'].includes(active.tagName))
    ) {
      e.preventDefault()
      this.openSearch('')
    } else if (e.key === 'Escape') {
      if (this.searchOpen) {
        e.preventDefault()
        this.closeSearch()
      } else if (this.pinned) {
        e.preventDefault()
        this.clearPin()
      }
    }
  }

  private readonly onWheel = (e: WheelEvent): void => {
    const targetEl = e.target as Element | null
    if (!this.el.contains(targetEl)) return
    if (targetEl?.closest?.('.map-search-results, .hosts-popover, .map-drawer')) return
    e.preventDefault()
    this.wantedSpan = THREE.MathUtils.clamp(this.wantedSpan * Math.exp(e.deltaY * 0.0011), 7, 250)
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return
    const targetEl = e.target as Element | null
    if (!this.el.contains(targetEl)) return
    if (targetEl?.closest?.('.map-jumps, .map-top-right, .map-footer, .map-search-modal, .map-drawer, .hosts-popover, .map-loading')) {
      return
    }
    this.down = { x: e.clientX, y: e.clientY, onLabel: Boolean(targetEl?.closest?.('.map-labels')) }
    this.dragged = false
  }

  private readonly onWindowClickCapture = (e: MouseEvent): void => {
    if (this.suppressClick) {
      this.suppressClick = false
      e.preventDefault()
      e.stopPropagation()
    }
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.down) {
      const dx = e.clientX - this.down.x
      const dy = e.clientY - this.down.y
      if (Math.abs(dx) + Math.abs(dy) > 3) this.dragged = true
      if (this.dragged) {
        const { height } = this.viewportSize()
        const units = this.span / height
        this.target.addScaledVector(this.right, -dx * units)
        this.target.addScaledVector(this.forward, dy * units)
        this.down.x = e.clientX
        this.down.y = e.clientY
        this.tooltipEl.style.display = 'none'
      }
      return
    }
    if (!this.renderer || e.target !== this.renderer.domElement) {
      this.tooltipEl.style.display = 'none'
      return
    }
    const res = this.hit(e)
    const n = res?.owner || null
    this.renderer.domElement.style.cursor = n ? 'pointer' : 'grab'
    this.tooltipEl.style.display = n ? 'block' : 'none'
    if (n) {
      this.tooltipEl.replaceChildren()
      const row = document.createElement('div')
      row.className = 'tt-row'
      const title = document.createElement('strong')
      const sub = document.createElement('small')
      if (!n.isTile) {
        const st = n.state === 'closed' ? (n.tempered === false ? 'discarded' : 'tempered') : n.state
        const hostName = n.origin || n.host
        title.textContent = n.name
        sub.textContent = hostName ? `${st} · ${hostName}` : st
        row.append(title, sub)
        this.tooltipEl.append(row)
      } else if (n.level === 3 && n.fiberName) {
        title.textContent = n.fiberName
        sub.textContent = `${n.continentName} / ${n.subAreaName || n.areaName}`
        row.append(title, sub)
        this.tooltipEl.append(row)
      } else {
        title.textContent = `${n.continentName} / ${n.areaName}`
        sub.textContent = `${formatCount(n.mass || 0)} fibers`
        row.append(title, sub)
        this.tooltipEl.append(row)
        const contKind = this.contMap.get(n.continent)?.kind
        if (contKind === 'shoals' && n.sampleFibers?.length) {
          const ul = document.createElement('ul')
          ul.className = 'tooltip-fibers'
          for (const f of n.sampleFibers.slice(0, 4)) {
            const li = document.createElement('li')
            li.textContent = f
            ul.append(li)
          }
          this.tooltipEl.append(ul)
        }
      }
      const { width, height } = this.viewportSize()
      const rect = this.el.getBoundingClientRect()
      const localX = e.clientX - rect.left
      const localY = e.clientY - rect.top
      this.tooltipEl.style.left = Math.min(localX + 16, width - 300) + 'px'
      this.tooltipEl.style.top = Math.min(localY + 14, height - 140) + 'px'
    }
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.down) {
      if (this.dragged) {
        this.suppressClick = true
        clearTimeout(this.suppressClickTimer)
        this.suppressClickTimer = window.setTimeout(() => {
          this.suppressClick = false
        }, 50)
      } else if (!this.down.onLabel) {
        const res = this.hit(e)
        if (res?.owner) {
          const n = res.owner
          const pos = !n.isTile ? { x: n.x, y: n.elevation, z: n.z } : { x: res.point.x, y: res.point.y, z: res.point.z }
          this.pinSelection(n, pos)
        } else {
          this.clearPin()
        }
      }
    }
    this.down = null
  }

  private readonly onPointerCancel = (): void => {
    this.down = null
  }

  private readonly onVisibilityChange = (): void => {
    if (this.disposed || !this.bundle) return
    if (document.visibilityState === 'visible') {
      this.startLoop()
      this.scheduleCompositePoll(true)
    } else {
      this.stopLoop()
      clearTimeout(this.pollTimer)
    }
  }

  private scheduleCompositePoll(immediate: boolean): void {
    clearTimeout(this.pollTimer)
    if (this.disposed || !this.bundle || document.visibilityState !== 'visible') return
    if (immediate) {
      void this.pollComposite().finally(() => {
        if (!this.disposed && document.visibilityState === 'visible') {
          clearTimeout(this.pollTimer)
          this.pollTimer = window.setTimeout(() => this.scheduleCompositePoll(true), MAP_POLL_MS)
        }
      })
    } else {
      this.pollTimer = window.setTimeout(() => this.scheduleCompositePoll(true), MAP_POLL_MS)
    }
  }

  private async pollComposite(): Promise<void> {
    if (this.disposed || !this.bundle) return
    const headers: Record<string, string> = {}
    if (this.etag) headers['If-None-Match'] = this.etag
    try {
      const url = `${this.opts.base.replace(/\/+$/, '')}/api/v1/fibers/composite`
      const resp = await daemonFetch(url, { headers })
      if (this.disposed || resp.status === 304) return
      if (!resp.ok) return
      const nextEtag = resp.headers.get('ETag')
      if (nextEtag) this.etag = nextEtag
      const data: unknown = await resp.json()
      if (this.disposed || !this.bundle) return

      const merged = mergeCompositeSnapshot(this.bundle.cities, data)
      const mergedOrigins = merged.origins ? { ...(this.bundle.origins || {}), ...merged.origins } : this.bundle.origins
      this.bundle = {
        ...this.bundle,
        origins: mergedOrigins,
        cities: merged.cities,
      }
      this.rebuildHostLenses(collectHosts(this.bundle))
      if (merged.changed) {
        this.assemble()
      }
    } catch {
      // Transient poll failure leaves current atlas undisturbed until next tick.
    }
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.lastFrameMs = 0
  }

  private startLoop(): void {
    if (this.rafId !== null || this.disposed || !this.renderer || document.visibilityState !== 'visible') return
    this.lastFrameMs = 0
    const tick = (now: number): void => {
      if (this.disposed || document.visibilityState !== 'visible') {
        this.rafId = null
        this.lastFrameMs = 0
        return
      }
      this.frame(now)
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private frame(now: number): void {
    if (!this.renderer || !this.scene || !this.camera || !this.pixelRT || !this.postScene || !this.postCam || !this.sun || !this.textures) {
      return
    }
    const dt = this.lastFrameMs > 0 ? Math.min(Math.max(0, (now - this.lastFrameMs) / 1000), 0.05) || 0.016 : 0.016
    this.lastFrameMs = now
    const smooth = 1 - Math.exp(-dt * 8)

    if (Math.abs(this.wantedSpan - this.span) < 0.0005) this.span = this.wantedSpan
    else this.span += (this.wantedSpan - this.span) * smooth
    if (this.current.distanceToSquared(this.target) < 1e-8) this.current.copy(this.target)
    else this.current.lerp(this.target, smooth)

    const { width, height } = this.viewportSize()
    const wantedShift = this.pinned && width >= 1000 ? 1 : 0
    if (Math.abs(wantedShift - this.drawerShift) < 0.0005) this.drawerShift = wantedShift
    else this.drawerShift += (wantedShift - this.drawerShift) * smooth

    const nextLod = this.span > 115 ? 0 : this.span > 24 ? 1 : 2
    if (nextLod !== this.lodTier) this.syncLOD()
    this.syncRenderTarget(this.span)

    const aspect = width / height
    this.camera.left = (-this.span * aspect) / 2
    this.camera.right = (this.span * aspect) / 2
    this.camera.top = this.span / 2
    this.camera.bottom = -this.span / 2

    this.camCenter.copy(this.current).addScaledVector(this.right, this.drawerShift * 0.25 * this.span * aspect)
    this.renderCenter.copy(this.camCenter)
    if (Math.abs(this.wantedSpan - this.span) < 0.08) {
      const texelX = (this.span * aspect) / this.rtW
      const texelY = this.span / this.rtH
      const u = this.renderCenter.dot(this.right)
      const v = this.renderCenter.dot(this.camUp)
      this.renderCenter.addScaledVector(this.right, Math.round(u / texelX) * texelX - u)
      this.renderCenter.addScaledVector(this.camUp, Math.round(v / texelY) * texelY - v)
    }

    this.camera.position.copy(this.renderCenter).addScaledVector(this.direction, 220)
    this.camera.lookAt(this.renderCenter)
    this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld()

    const shadowExtent = Math.round(Math.min(150, Math.max(18, this.span * 0.85)) * 2) / 2
    const shadowTexel = (2 * shadowExtent) / 4096
    const sunU = Math.round(this.renderCenter.dot(this.sunRight) / shadowTexel) * shadowTexel
    const sunV = Math.round(this.renderCenter.dot(this.sunUp) / shadowTexel) * shadowTexel
    this.shadowCenter.set(0, 0, 0).addScaledVector(this.sunRight, sunU).addScaledVector(this.sunUp, sunV)
    this.sun.position.copy(this.shadowCenter).addScaledVector(this.sunDir, 240)
    this.sun.target.position.copy(this.shadowCenter)
    this.sun.target.updateMatrixWorld()
    if (this.sun.shadow.camera.right !== shadowExtent) {
      Object.assign(this.sun.shadow.camera, {
        left: -shadowExtent,
        right: shadowExtent,
        top: shadowExtent,
        bottom: -shadowExtent,
      })
      this.sun.shadow.camera.updateProjectionMatrix()
    }

    this.simTime += dt
    const t = this.simTime
    this.textures.sea.offset.set((t * 0.014) % 1, Math.sin(t * 0.28) * 0.016)
    this.textures.foam.offset.set(Math.sin(t * 1.15) * 0.022, Math.cos(t * 0.95) * 0.022)
    this.textures.shallow.offset.set(Math.cos(t * 0.75) * 0.016, Math.sin(t * 0.85) * 0.016)
    this.textures.river.offset.y = -((t * 0.38) % 1)

    for (const b of this.boats) {
      const nPts = b.pts.length
      if (nPts < 2) continue
      const u = (((b.phase0 + t * b.speed) % 1) + 1) % 1
      const fIdx = u * (nPts - 1)
      const i0 = Math.min(nPts - 2, Math.floor(fIdx))
      const frac = fIdx - i0
      const pA = b.pts[i0]
      const pB = b.pts[i0 + 1]
      const bx = pA.x + (pB.x - pA.x) * frac
      const bz = pA.z + (pB.z - pA.z) * frac
      const dir = b.speed >= 0 ? 1 : -1
      const yaw = Math.atan2((pB.x - pA.x) * dir, (pB.z - pA.z) * dir)
      const bob = Math.sin(t * 2.4 + b.phase0 * 12) * 0.012
      const ux = Math.sin(yaw)
      const uz = Math.cos(yaw)
      const syncPart = (item: BatchItem, offFwd: number, offY: number, rotOff = 0): void => {
        item.x = bx + ux * offFwd
        item.z = bz + uz * offFwd
        item.y = b.y0 + offY + bob
        item.rotation = yaw + rotOff
        this.applyMatrix(item)
        if (item.mesh && item.index !== undefined) {
          item.mesh.setMatrixAt(item.index, this.dummy.matrix)
          item.mesh.instanceMatrix.needsUpdate = true
        }
      }
      syncPart(b.hull, 0, 0.03)
      syncPart(b.deck, -0.04, 0.065)
      syncPart(b.mast, 0.02, 0.24)
      syncPart(b.mainSail, -0.02, 0.26)
      syncPart(b.jibSail, 0.14, 0.22)
      syncPart(b.wake, -0.28, -0.015)
    }

    for (const s of this.smokes) {
      const phase = (t * 0.4 + s.k * 0.2) % 1
      const rise = s.rise ?? 0.7
      const drift = s.drift ?? 0.06
      const bx = s.baseX ?? s.n.x + 0.34
      s.item.y = s.base + phase * rise
      s.item.x = bx + s.k * drift + Math.sin(t * 0.5 + s.k) * 0.06
      this.applyMatrix(s.item)
      if (s.item.mesh && s.item.index !== undefined) {
        s.item.mesh.setMatrixAt(s.item.index, this.dummy.matrix)
        s.item.mesh.instanceMatrix.needsUpdate = true
      }
    }

    for (const s of this.signals) {
      if (s.type === 'beam') s.m.rotation.y = t * 0.52 + hash(s.n.id) * 6
      if (s.type === 'ring' || s.type === 'ask-ring') {
        const scale = 1 + Math.sin(t * 2.3) * 0.1
        s.m.scale.setScalar(scale)
      }
      if (s.type === 'lantern-glow') {
        const scale = 1.45 * (1 + Math.sin(t * 2.3 + hash(s.n.id) * 6) * 0.07)
        s.m.scale.set(scale, scale, 1)
      }
    }

    if (this.pinGroup && this.pinGroup.visible) {
      const pulse = 1 + Math.sin(t * 3.8) * 0.1
      const inner = this.pinGroup.userData.inner as THREE.Mesh
      const outer = this.pinGroup.userData.outer as THREE.Mesh
      inner.scale.setScalar(pulse)
      outer.scale.setScalar(1 + Math.sin(t * 3.8 - 0.7) * 0.18)
      ;(outer.material as THREE.MeshBasicMaterial).opacity = 0.32 + 0.26 * (0.5 + 0.5 * Math.sin(t * 3.8))
    }

    this.positionLabels()
    this.renderer.setRenderTarget(this.pixelRT)
    this.renderer.render(this.scene, this.camera)
    this.renderer.setRenderTarget(null)
    this.renderer.render(this.postScene, this.postCam)
  }
}
