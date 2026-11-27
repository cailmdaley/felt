import type * as THREE from 'three'

export type CityState = 'working' | 'ask' | 'review' | 'resting' | 'draft' | 'closed'
export type BiomeId = 'mediterranean' | 'temperate' | 'savanna' | 'nordic'
export type HeightMode = 'citations' | 'depth' | 'recency'
export type LightingMode = 'auto' | 'day' | 'night'
export type RenderTier = 'all' | 'l0' | 'l1_only' | 'l12' | 'l2_only'
export type MountainClass = 'foothill' | 'ridge' | 'peak' | 'high_peak'

export interface Axial {
  q: number
  r: number
}

export interface WorldXZ {
  x: number
  z: number
}

export interface SeaAnchorConfig {
  sea?: string
  biome?: string
  x?: number
  z?: number
}

export type MapSeaEntry = string | SeaAnchorConfig

export interface MapConfig {
  seas?: Record<string, MapSeaEntry>
  pins?: Record<string, Axial>
}

export interface FiberItem {
  id: string
  name: string
  status?: string
  citedBy?: number
}

export interface OriginInfo {
  stale?: boolean
  fibers?: number
}

export interface ContinentInput {
  id: string
  name: string
  kind: 'project' | 'guild' | 'shoals' | string
  shared?: boolean
  stores?: string[]
  total: number
  cities: number
  citedBy?: number
  maxDepth?: number
  topLevelBreadth?: number
  decisionCount?: number
  recentRatio?: number
  lastUpdated?: string | null
}

export interface AreaInput {
  id: string
  name: string
  continent: string
  mass: number
  cities: number
  shared?: boolean
  citedBy?: number
  maxDepth?: number
  topLevelBreadth?: number
  decisionCount?: number
  recentRatio?: number
  lastUpdated?: string | null
  sampleFibers?: string[]
  fiberItems?: FiberItem[]
}

export interface CityInput {
  id: string
  uid?: string
  nid?: string
  name: string
  continent: string
  area: string
  parent?: string | null
  depth?: number
  citedBy?: number
  state: CityState | string
  column?: string
  turn?: string
  status?: string
  horizon?: string
  kind?: string
  tempered?: boolean
  host?: string
  origin?: string
  channel?: string
  agent?: string
  outcome?: string
  summary?: string
  createdAt?: string
  isOrchestrator?: boolean
  hasTapestry?: boolean
  rexSession?: string
}

export interface GraphLink {
  a: string
  b: string
  w: number
}

export interface TerrainBundle {
  generatedAt?: string
  origins?: Record<string, OriginInfo>
  continents: ContinentInput[]
  areas: AreaInput[]
  cities: CityInput[]
  areaLinks: GraphLink[]
  domainLinks: GraphLink[]
  mapConfig?: MapConfig
}

export interface PlacedArea extends AreaInput {
  citedBy: number
  maxDepth: number
  topLevelBreadth: number
  decisionCount: number
  recentRatio: number
  anchor: Axial
  anchorAbs?: Axial
  weight: number
  cells: number
  x: number
  z: number
  slug: string
  elevation: number
  folded?: number
  isOutskirtsSub?: boolean
}

export interface PlacedCity extends CityInput {
  isTile?: false
  isContinent?: false
  depth: number
  summitTier: number
  q: number
  r: number
  x: number
  z: number
  local: Axial
  elevation: number
  shared: boolean
  scenery?: string
}

export interface PlacedContinent extends ContinentInput {
  sea: string
  biome: BiomeId
  topLevelBreadth: number
  coarse: number
  rc: number
  q: number
  r: number
  fq: number
  fr: number
  x: number
  z: number
  areas: PlacedArea[]
  subAreas: PlacedArea[]
  highland: number
  citedBy: number
  fibers: PlacedCity[]
  peak: number
  land: number
  active: number
  ask: number
  review: number
}

export interface CoarseCell extends Axial, WorldXZ {
  fq: number
  fr: number
  level: 1
  continent: string
  area: string
  height: number
  coast: boolean
  isthmus: boolean
  valley: boolean
  river: boolean
  citedBy: number
  maxDepth: number
  recentRatio: number
  decisionCount: number
  mass: number
}

export interface FineTile extends Axial, WorldXZ {
  level: 2
  continent: string
  area: string
  subArea: string | null
  subAreaName: string | null
  cell: string
  height: number
  valley: boolean
  river: boolean
  coast: boolean
  isthmus: boolean
  citedBy: number
  depth: number
  recentRatio: number
  decisionCount: number
  splitL3: boolean
}

export interface MicroHex extends Axial, WorldXZ {
  level: 3
  parentTile: string
  cell: string
  continent: string
  area: string
  subArea: string
  subAreaName: string
  height: number
  valley: boolean
  river: boolean
  coast: boolean
  citedBy: number
  depth: number
  recentRatio: number
  cityId: string | null
  subFiberId: string
  subStatus: string
  subLabel: string
}

export interface LandRoad {
  continent: string
  toContinent?: string
  isthmus?: boolean
  from: string | null
  to: string
  points: Axial[]
}

export interface RiverRoute {
  continent: string
  link: [string, string] | null
  fromArea?: string
  toArea?: string
  weight: number
  points: Axial[]
}

export interface SeaLanePoint extends WorldXZ {
  sea: boolean
}

export interface SeaLane {
  a: string
  b: string
  weight: number
  arcLength: number
  step: number
  points: SeaLanePoint[]
}

export interface Isthmus {
  a: string
  b: string
  sea: string
  weight: number
  cells: Axial[]
  road?: Axial[]
}

export interface AtlasLayout {
  continents: PlacedContinent[]
  fibers: PlacedCity[]
  tiles: FineTile[]
  cells: CoarseCell[]
  level1: CoarseCell[]
  level2: FineTile[]
  level3: MicroHex[]
  roads: LandRoad[]
  rivers: RiverRoute[]
  lanes: SeaLane[]
  isthmuses: Isthmus[]
  heightMode: HeightMode
}

export interface TileOwner {
  isTile: true
  isContinent?: false
  level?: number
  id?: string
  name?: string
  continent: string
  continentName: string
  areaName: string
  subAreaName?: string
  fiberName?: string
  fiberId?: string | null
  fiberStatus?: string
  mass: number
  cities: number
  citedBy: number
  maxDepth?: number
  recentRatio?: number
  shared: boolean
  elevation?: number
  sampleFibers?: string[]
  x?: number
  z?: number
}

export interface ContinentSelection extends PlacedContinent {
  isContinent: true
  isTile?: false
}

export type PickOwner = PlacedCity | TileOwner
export type PinSelectionItem = PlacedCity | TileOwner | ContinentSelection

export type LensState =
  | { type: 'state'; value: string }
  | { type: 'shared'; value: 'shared' }
  | { type: 'host'; value: string }
  | {
      type: 'search'
      value: string
      contIds: Set<string>
      areaIds: Set<string>
      cityIds: Set<string>
      activeContIds: Set<string>
    }

export interface SchemePalette {
  sea: string
  shallow: string
  foam: string
  sand: string
  rock: string
  granite: string
  slate: string
  snow: string
  spruce: string
  land: string
  meadow: string
  valley: string
  highland: string
  alpine: string
  peak: string
  lane: string
  shared: string
  wall: string
  trim: string
  roof: string
  active: string
  dome: string
  copper: string
  leaf: string
  canopyLight: string
  crop: string
  trunk: string
  road: string
  river: string
  metal: string
  window: string
  amber: string
  white: string
  smoke: string
  host: string
  ao: string
}

export interface BiomePalette {
  sand: string
  rock: string
  granite: string
  slate: string
  snow: string
  spruce: string
  valley: string
  meadow: string
  land: string
  highland: string
  alpine: string
  peak: string
  leaf: string
  canopyLight: string
  crop: string
  wall: string
  trim: string
  roof: string
  copper: string
}

export interface RiverSamplePoint {
  x: number
  z: number
  frac: number
  halfW: number
  arc: number
}

export interface SampledRiverPath {
  pts: RiverSamplePoint[]
  owner: TileOwner
  continent: string
  isOutlet: boolean
}

export interface RiverSegment {
  ax: number
  az: number
  bx: number
  bz: number
  halfW: number
  frac: number
  isOutlet: boolean
  owner: TileOwner
  continent: string
}

export interface TerrainParams {
  uplift: number
  erosionK: number
  aCrit: number
  valleySmooth: number
  crestSharpness: number
  talusSlope: number
  lakeLevel: number
  iterations: number
  seed: number
}

export interface NaturalSample {
  h: number
  baseH: number
  ridge: number
  slope: number
  ownTile: FineTile | null
  nearestTile: FineTile | null
  landRatio: number
}

export interface TerrainSample {
  h: number
  baseH: number
  ridge: number
  slope: number
  ownTile: FineTile | null
  nearestTile: FineTile | null
  isRiver: boolean
  riverBank: boolean
  riverOwner: TileOwner | null
  riverDist: number
  isLake: boolean
  lakeY: number | null
  inPad: boolean
}

export interface TerrainSampler {
  sample(x: number, z: number): TerrainSample
  sampleNatural(x: number, z: number): NaturalSample
  sampleHeight(x: number, z: number): number
  sampleSlope(x: number, z: number): number
  isInRiver(x: number, z: number): boolean
  isInLake(x: number, z: number): boolean
  isInWater(x: number, z: number): boolean
  nearestRiver(x: number, z: number): { dist: number; seg: RiverSegment } | null
  riverSurfaceY(x: number, z: number): number
  lakeSurfaceY(x: number, z: number): number | null
  cityElevations: Map<string, number>
  riverPaths: SampledRiverPath[]
}

export interface RidgeNeighborL2 {
  dir: number
  key: string
  tile: FineTile
  strength: number
  mClass: MountainClass
}

export interface MountainL2Cell {
  tile: FineTile
  key: string
  continent: string
  orogeny: number
  mStrength: number
  mClass: MountainClass
  ridgeNeighbors: RidgeNeighborL2[]
  foothillDirs: number[]
  mountainDirs: number[]
  ridgeAxis: number
}

export interface RidgeNeighborL1 {
  dir: number
  key: string
  cell: CoarseCell
  strength: number
  mClass: MountainClass
  cx: number
  cz: number
}

export interface MountainL1Entry {
  cell: CoarseCell
  key: string
  continent: string
  orogeny: number
  mStrength: number
  mClass: MountainClass
  mCount: number
  cx: number
  cz: number
  ridgeNeighbors: RidgeNeighborL1[]
  mountainDirs: number[]
  ridgeAxis: number
}

export interface MountainStats {
  continent: string
  orogeny: number
  totalL2: number
  ridge: number
  peak: number
  high_peak: number
  foothill: number
  mountains: number
  chains: number
  largestChain: number
  chainSizes: number[]
  l1Mountains?: number
}

export interface MountainField {
  l2: Map<string, MountainL2Cell>
  l1: Map<string, MountainL1Entry>
  stats: MountainStats[]
}

export type GeometryKind =
  | 'box'
  | 'hex'
  | 'cyl'
  | 'taperCyl'
  | 'dome'
  | 'ao'
  | 'canopy'
  | 'conifer'
  | 'gable'
  | 'hipCap'
  | 'hull'
  | 'sail'

export interface BatchItem {
  x: number
  y: number
  z: number
  sx: number
  sy: number
  sz: number
  owner: PickOwner | null
  biome: BiomeId | null
  rotation: number
  slope?: number
  index?: number
  mesh?: THREE.InstancedMesh
}

export interface BatchGroup {
  kind: GeometryKind
  role: string
  glow: number
  custom: string | null
  tier: RenderTier
  pickable?: boolean
  items: BatchItem[]
}

export interface SmokeEntry {
  item: BatchItem
  n: PlacedCity
  base: number
  baseX: number
  k: number
  drift: number
  rise: number
}

export interface BoatEntry {
  pts: SeaLanePoint[]
  phase0: number
  speed: number
  hull: BatchItem
  deck: BatchItem
  mast: BatchItem
  mainSail: BatchItem
  jibSail: BatchItem
  wake: BatchItem
  y0: number
}

export interface SignalEntry {
  type: 'halo' | 'forge-ring' | 'forge-glow' | 'lens-ring' | 'ring' | 'lantern-glow' | 'beam' | 'ask-ring' | 'review-glow'
  m: THREE.Object3D
  mesh?: THREE.Mesh
  n: PlacedCity
  ask?: boolean
}

export interface MapTextures {
  [key: string]: THREE.CanvasTexture
}

export interface AssetContext {
  box(
    role: string,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    owner?: PickOwner | null,
    glow?: number,
    rot?: number,
    tier?: RenderTier,
  ): BatchItem
  cyl(
    role: string,
    x: number,
    y: number,
    z: number,
    r: number,
    h: number,
    owner?: PickOwner | null,
    glow?: number,
    tier?: RenderTier,
  ): BatchItem
  put(
    kind: GeometryKind,
    role: string,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    owner?: PickOwner | null,
    rotation?: number,
    glow?: number,
    custom?: string | null,
    tier?: RenderTier,
  ): BatchItem
  ao(x: number, y: number, z: number, r?: number, tier?: RenderTier): BatchItem
  root: THREE.Group
  textures: MapTextures
  hostColor(host: string | undefined): string | null
  biomeOf(continentId: string | undefined): BiomeId
  smokes: SmokeEntry[]
  boats: BoatEntry[]
  signals: SignalEntry[]
  halo(n: PlacedCity, x: number, y: number, z: number, ask?: boolean): void
  sampleHeight(x: number, z: number): number
  sampleSlope(x: number, z: number): number
  isInRiver(x: number, z: number): boolean
  isInWater(x: number, z: number): boolean
  isNearMountain(t: FineTile): boolean
}
