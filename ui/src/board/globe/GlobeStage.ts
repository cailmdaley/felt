import type { KanbanCard } from '../KanbanTypes.js'
import { ATTENTION, ATTENTION_WORD, conversable, type MapFeeds, type MapFile } from '../family/model.js'
import { htmlEl as el, markPath, shortAgo, svgEl } from '../family/drawing.js'
import { flight, frameOf, invert, keeping, lonLat, project, wholeRadius, type Camera, type Flight, type Frame, type Projection, type Viewport } from './camera.js'
import { forestOf, persistentId } from './forest.js'
import { NORTH, cellSpan, centre, child, facePoint, inCell, ipixOf, type FacePoint, type Vec } from './healpix.js'
import { blocks, placeNames, within, type Block, type Candidate, type Point } from './labels.js'
import { BEACON_PX, paint, paintLeaders, type Leader, type Palette, type Pulse } from './paint.js'
import { askKind, sceneOf, traceOf, type Body, type Scene, type Tone } from './scene.js'
import { cardNamed, type ThreadIndex } from '../threads.js'
import { keystrokeIsSpokenFor } from '../views/ViewRegistry.js'
import './globe.css'

/** What the globe reaches through the board. */
export interface GlobeHost {
  feeds: MapFeeds & { refresh(): void; lead(card: KanbanCard): Promise<MapFile | undefined> }
  openDocument(card: KanbanCard, doc: string): void
  /** Moves Rex to the thread; true if it had a conversation to open. */
  converse(card: KanbanCard): boolean
  constitutionKey(card: KanbanCard): string
  /** The thread a surface has come to rest on, which voice follows; null for none. */
  see?(card: KanbanCard | null): void
  /** Heard when a feed lands. */
  onFeeds?: () => void
}

/** Where the globe stands, kept across leaving and coming back. */
export interface GlobePlace {
  camera: Camera | null; projection: Projection; focus: string | null; worker: string | null
  /** The feeds behind sizes have landed, or their wait has run out: placing before that would move every tile when they do. */
  fed: boolean
}
export const freshPlace = (): GlobePlace => ({ camera: null, projection: 'globe', focus: null, worker: null, fed: false })

/** The opening looks straight down on the north, where everything in flight is, with its four base pixels square to the stage. */
const OPENING_LAT = Math.PI / 2 - 1e-6, OPENING_LON = Math.PI / 4
/** The pixels left around a tile flown to, and the least the foot of the stage is kept for the peek. */
const FRAME_MARGIN = 10, MIN_FOOT = 70
const WHEEL_RATE = .01, WHEEL_MOST = 60, KEY_ZOOM = 1.6
const SLOP = 5
/** A callout's distance from the centre of its marker. */
const CALLOUT_GAP = 12
/** The step of the rings a name under the focus searches for room, how many it keeps to before leaving the tile for the open water beside it, and how many in all. */
const NUDGE = 22, NEAR_RINGS = 2, NUDGE_RINGS = 6
/** The peek's distance from the stage's foot. */
const FOOT_GAP = 10
/** A zoom's limit: the thing under it this many stages wide, or over open water this many spheres. */
const FILL_REACH = 1.5, OCEAN_REACH = 6
const FEED_WAIT_MS = 1200
const BLOOM_MS = 700
const PULSE_MS = 1600
/** The feeds' first landing can move every thread's last move: only change after this long is news. */
const SETTLED_MS = 6000
/** The time a let-go drag takes to lose most of its speed, and the speed in pixels per millisecond at which it stops. */
const COAST_MS = 280, COAST_LEAST = .03
/** The window over which a drag's speed is read. */
const TRAIL_MS = 90
/** A tile narrower than this takes no click of its own. */
const TARGET_PX = 14
/** A tile narrower than this has no name to read and no tapestry worth asking for. */
const NAME_PX = 40, LEAD_PX = 70
/** A constitution is named when its thread is in focus, or it is this wide: he seldom wants it. */
const CONSTITUTION_PX = 170
const MOST_NAMES = 90
/** The type roles a name may take and their sizes, as styles/type.css sets them, at --leading-tight. */
const ROLE_SIZE = { display: 34, title: 21, row: 16, note: 14 } as const
type Role = keyof typeof ROLE_SIZE
const LEADING = 1.2
/** Roles for each kind of tile, the largest that fits winning, so a name grows as its tile does. */
const ROLES: Record<Body['kind'], readonly Role[]> = {
  province: ['display', 'title', 'row'], area: ['title', 'row', 'note'], thread: ['display', 'title', 'row', 'note'], lead: ['title', 'row', 'note'], constitution: ['row', 'note'], file: ['title', 'row', 'note'],
}
const TONES: readonly Tone[] = ['question', 'blocked', 'new', 'turn', 'review', 'working', 'still', 'quiet', 'aside', 'land', 'page']
/**
 * The shape a thread's name may fill: as wide as its diamond and half as tall,
 * centred on it. Diamonds of a size tile as bricks at their centres, so names
 * in these shapes clear each other where a name inside the diamond could not fit.
 */
function brickOf(polygon: readonly number[], { x, y }: Point): number[] {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity
  for (let n = 0; n < polygon.length; n += 2) {
    left = Math.min(left, polygon[n]); right = Math.max(right, polygon[n])
    top = Math.min(top, polygon[n + 1]); bottom = Math.max(bottom, polygon[n + 1])
  }
  const halfWidth = Math.min(x - left, right - x), halfHeight = Math.min(y - top, bottom - y) / 2
  return [x - halfWidth, y - halfHeight, x + halfWidth, y - halfHeight, x + halfWidth, y + halfHeight, x - halfWidth, y + halfHeight]
}

/** A point and the rings around it, nearest first; flattened, as names are wider than they are tall. */
function ringsAround({ x, y }: Point, step: number, rings: number): Point[] {
  const points = [{ x, y }]
  for (let ring = 1; ring <= rings; ring++) {
    const count = 12 * ring
    for (let n = 0; n < count; n++) {
      const angle = -Math.PI / 2 + 2 * Math.PI * n / count
      points.push({ x: x + 2 * ring * step * Math.cos(angle), y: y + ring * step * Math.sin(angle) })
    }
  }
  return points
}

/** The sphere with nothing placed yet. */
const BARE: Scene = { roots: [], byKey: new Map(), threads: new Map(), asks: [], deepest: 8 }
const firstSentence = (text: string): string => text.replace(/\s+/g, ' ').match(/^.*?[.?!](?=\s|$)/)?.[0] ?? text

/** The stage of the Globe view: its canvas, the names over it, and every way of moving on it. */
export class GlobeStage {
  readonly el = el('section', 'globe')
  private readonly canvas = el('canvas', 'globe-canvas')
  private readonly context: CanvasRenderingContext2D
  private readonly names = el('div', 'globe-names')
  private readonly crumbs = el('nav', 'globe-crumbs')
  private readonly counts = el('div', 'ws-family-counts globe-counts')
  private readonly toggle = el('div', 'globe-toggle')
  private readonly peek = el('section', 'globe-peek')
  private readonly probe = el('span', 'globe-probe')
  /** A hidden name in each type role in turn, which the measurer takes its font from. */
  private readonly ruler = el('span', 'globe-name globe-probe')
  private readonly listening = new AbortController()
  private readonly observer: ResizeObserver
  private readonly measurer = document.createElement('canvas').getContext('2d')!
  private readonly host: GlobeHost
  private readonly reading: () => boolean
  private readonly place: GlobePlace
  private scene: Scene = BARE
  private signature = ''
  private viewport: Viewport = { width: 0, height: 0 }
  private palette: Palette | null = null
  private paper = ''
  private flying: { path: Flight; started: number } | null = null
  private frame = 0
  /** The surface still sliding after a drag let go. */
  private readonly pulses = new Map<string, number>()
  private coast: { grabbed: Vec; x: number; y: number; vx: number; vy: number; last: number } | null = null
  /** The pointer's last moves in a drag, for the speed it let go at. */
  private trail: Array<Point & { at: number }> = []
  /** When the tiles began to appear. */
  private bloom = 0
  private hover: Body | null = null
  private readonly fingers = new Map<number, Point>()
  private drag: { grabbed: Vec | null; from: Point; camera: Camera; moved: boolean; touch: boolean } | null = null
  private pinch: { gap: number; radius: number; grabbed: Vec | null } | null = null
  /** The thread a first tap came to, which a second tap converses with. */
  private tapped: string | null = null
  private readonly leads = new Map<string, MapFile | null>()
  private readonly nameEls = new Map<string, HTMLButtonElement>()
  private readonly blockCache = new Map<string, Block[]>()
  private crumbShape = ''
  /** The strips the head and the peek take from the stage, which names keep clear of. */
  private headHeight = 0
  private footHeight = 0
  private peekShape = ''
  private readonly holding: ReturnType<typeof setTimeout>

  /** `refreshed` draws the board's latest cards again. */
  constructor(host: GlobeHost, reading: () => boolean, refreshed: () => void, place = freshPlace()) {
    this.host = host; this.reading = reading; this.place = place
    const fed = (): void => { place.fed = true; refreshed() }
    host.onFeeds = fed
    this.holding = setTimeout(fed, place.fed ? 0 : FEED_WAIT_MS)
    this.context = this.canvas.getContext('2d')!
    this.canvas.setAttribute('aria-hidden', 'true')
    this.names.setAttribute('role', 'listbox')
    this.names.setAttribute('aria-label', 'What the view holds')
    this.peek.setAttribute('aria-live', 'polite')
    const head = el('div', 'globe-head')
    head.append(this.crumbs, this.counts)
    for (const [projection, label] of [['globe', 'Globe'], ['mollweide', 'Mollweide']] as const) {
      const button = el('button', 'globe-toggle-option', label); button.type = 'button'
      button.dataset.projection = projection
      button.title = 'Change the projection (m)'
      button.addEventListener('click', () => this.project(projection))
      this.toggle.append(button)
    }
    this.toggle.setAttribute('role', 'group')
    this.toggle.setAttribute('aria-label', 'Projection')
    this.el.append(this.canvas, this.names, head, this.toggle, this.peek, this.probe, this.ruler)
    const signal = this.listening.signal
    this.el.addEventListener('wheel', event => this.wheel(event), { passive: false, signal })
    this.canvas.addEventListener('pointerdown', event => this.down(event), { signal })
    this.canvas.addEventListener('pointerleave', () => this.setHover(null), { signal })
    window.addEventListener('pointermove', event => this.move(event), { signal })
    window.addEventListener('pointerup', event => this.up(event), { signal })
    window.addEventListener('pointercancel', event => this.up(event), { signal })
    this.names.addEventListener('click', event => this.named(event), { signal })
    this.observer = new ResizeObserver(() => this.resized())
    this.observer.observe(this.el)
  }

  dispose(): void {
    clearTimeout(this.holding)
    this.host.onFeeds = undefined
    this.listening.abort()
    this.observer.disconnect()
    cancelAnimationFrame(this.frame)
    this.place.camera = this.camera
  }

  update(index: ThreadIndex, cards: readonly KanbanCard[], now = Date.now()): void {
    this.host.feeds.refresh()
    if (!this.place.fed) return
    const forest = forestOf(index, cards, this.host.feeds, now)
    const signature = JSON.stringify([forest.projects, [...forest.threads.values()].map(thread => [thread.standing, thread.tone, thread.word, Math.floor(thread.lastMove / 60_000)])])
    if (signature === this.signature) return
    this.signature = signature
    const before = this.scene
    this.scene = sceneOf(forest, now)
    if (this.bloom && performance.now() - this.bloom > SETTLED_MS) this.notice(before)
    for (const [key, lead] of this.leads) if (lead) this.withLead(key, lead)
    if (this.hover) this.hover = this.scene.byKey.get(this.hover.key) ?? null
    this.paintCounts()
    this.request()
  }

  /** A thread whose state or last move changed since the last placing rings once. */
  private notice(before: Scene): void {
    const at = performance.now()
    for (const [key, body] of this.scene.threads) {
      const was = before.threads.get(key)?.thread, thread = body.thread!
      if (was && (was.standing !== thread.standing || was.lastMove < thread.lastMove)) this.pulses.set(key, at)
    }
  }
  /** Comes to a fiber Rex moved to on a host, leaving Rex be; false for one the globe does not hold. */
  follow(id: string, origin: string): boolean {
    const { threads } = this.scene
    const card = cardNamed([...threads.values()].map(body => body.thread!.card), id, origin), body = card && threads.get(persistentId(card))
    if (!body) return false
    this.place.worker = body.key
    if (body.key !== this.place.focus) this.come(body)
    this.request()
    return true
  }

  private get camera(): Camera { return this.place.camera ?? this.opening() }
  private set camera(camera: Camera) { this.place.camera = camera }
  private get whole(): number { return wholeRadius(this.place.projection, this.viewport) }
  /** The radius at which the smallest tile fills the stage. */
  private get closest(): number {
    return Math.max(this.whole * 4, Math.min(this.viewport.width, this.viewport.height) * 1.2 / cellSpan(this.scene.deepest + 1))
  }
  /** The whole sphere from over the north, or the whole sky on the map. */
  private opening(): Camera { return { lon: OPENING_LON, lat: this.place.projection === 'globe' ? OPENING_LAT : 0, radius: this.whole } }
  private frameNow(): Frame { return frameOf(this.camera, this.place.projection, this.viewport) }
  private held(camera: Camera): Camera { return { ...camera, radius: Math.max(this.whole, Math.min(this.closest, camera.radius)) } }
  private request(): void { if (!this.frame) this.frame = requestAnimationFrame(now => this.draw(now)) }
  private stopFlight(): void { this.flying = null; this.coast = null }

  private fly(to: Camera): void {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      this.camera = this.held(to); this.request(); return
    }
    this.flying = { path: flight(this.camera, this.held(to), this.viewport, this.whole), started: performance.now() }
    this.request()
  }
  /** The camera that holds a tile's whole outline in the stage clear of the head and foot, as large as that allows. */
  private framing(body: Body): Camera {
    const { width, height } = this.viewport, top = this.headHeight, bottom = height - Math.max(this.footHeight, MIN_FOOT)
    const centred: Camera = { ...lonLat(body.centre), radius: 1 }
    const unit = frameOf(centred, this.place.projection, this.viewport), points = traceOf(body, 8).points
    let left = Infinity, right = -Infinity, up = Infinity, down = -Infinity
    for (let n = 0; n < points.length; n += 3) {
      const at = project(unit, [points[n], points[n + 1], points[n + 2]])
      left = Math.min(left, at.x); right = Math.max(right, at.x); up = Math.min(up, at.y); down = Math.max(down, at.y)
    }
    const radius = Math.min((width - 2 * FRAME_MARGIN) / (right - left), (bottom - top - 2 * FRAME_MARGIN) / (down - up))
    const sized: Camera = { ...centred, radius }
    const shiftX = width / 2 - radius * ((left + right) / 2 - unit.cx), shiftY = (top + bottom) / 2 - radius * ((up + down) / 2 - unit.cy)
    return keeping(sized, this.place.projection, this.viewport, body.centre, shiftX, shiftY)
  }
  private come(body: Body): void {
    this.place.focus = body.key
    this.fly(this.framing(body))
  }
  /** One level out along the hierarchy, to the opening view past the top; false once there. */
  private stepOut(): boolean {
    const at = (this.place.focus ? this.scene.byKey.get(this.place.focus) : undefined) ?? this.atCentre()
    let up = at?.parent
    while (up?.parent && up.cell.order === at?.cell.order) up = up.parent
    if (up && up.cell.order !== at?.cell.order) { this.come(up); return true }
    if (this.camera.radius <= this.whole * 1.01 && !this.place.focus) return false
    this.place.focus = null
    this.fly({ ...this.camera, radius: this.whole })
    return true
  }
  private atCentre(): Body | null { return this.pick(this.viewport.width / 2, this.viewport.height / 2) }

  private project(projection: Projection): void {
    if (projection === this.place.projection) return
    const camera = this.camera, wasWhole = camera.radius <= this.whole * 1.01
    this.stopFlight()
    this.place.projection = projection
    this.camera = wasWhole ? { ...camera, radius: this.whole, lat: projection === 'globe' ? OPENING_LAT : 0 } : this.held(camera)
    this.request()
  }
  /** The deepest tile at a screen point that is wide enough to aim at. */
  private pick(sx: number, sy: number): Body | null {
    const vector = invert(this.frameNow(), sx, sy)
    return vector && this.pickAt(vector, this.camera.radius)
  }
  private pointOf(vector: Vec): FacePoint { return facePoint(vector[2], Math.atan2(vector[1], vector[0])) }
  /** The deepest tile at a direction of those wide enough at this radius; at radius zero, of all of them. */
  private pickAt(vector: Vec, radius: number): Body | null {
    const point = this.pointOf(vector)
    let body = this.scene.roots.find(root => inCell(point, root.cell)) ?? null
    while (body) {
      const next: Body | undefined = body.kids.find(kid => (!radius || kid.span * radius >= TARGET_PX) && (kid.kind !== 'lead' || kid.file) && inCell(point, kid.cell))
      if (!next) break
      body = next
    }
    return body
  }

  private coasting(now: number): void {
    const coast = this.coast!, dt = Math.min(40, now - coast.last), decay = Math.exp(-dt / COAST_MS)
    coast.last = now
    coast.x += coast.vx * dt; coast.y += coast.vy * dt
    coast.vx *= decay; coast.vy *= decay
    this.camera = keeping(this.camera, this.place.projection, this.viewport, coast.grabbed, coast.x, coast.y)
    if (Math.hypot(coast.vx, coast.vy) < COAST_LEAST) this.coast = null
    else this.request()
  }
  private draw(now: number): void {
    this.frame = 0
    const scene = this.scene
    if (!this.viewport.width) return
    if (this.coast) this.coasting(now)
    if (this.flying) {
      const t = Math.min(1, (now - this.flying.started) / this.flying.path.ms)
      this.camera = this.flying.path.at(Math.max(0, t))
      if (t >= 1) this.flying = null
      else this.request()
    }
    this.readPalette()
    if (scene !== BARE) this.bloom ||= now
    const frame = this.frameNow(), c = this.context, ratio = window.devicePixelRatio || 1
    c.setTransform(ratio, 0, 0, ratio, 0, 0)
    const by = scene.byKey
    const pulses: Pulse[] = []
    for (const [key, started] of this.pulses) {
      const body = by.get(key), age = (now - started) / PULSE_MS
      if (!body || age >= 1) this.pulses.delete(key)
      else pulses.push({ body, age: Math.max(0, age) })
    }
    if (pulses.length) this.request()
    paint(c, frame, this.viewport, scene, this.palette!, {
      hover: this.hover, focus: this.place.focus ? by.get(this.place.focus) ?? null : null, worker: this.place.worker ? by.get(this.place.worker) ?? null : null, pulses,
    }, this.bloom ? Math.min(1, (now - this.bloom) / BLOOM_MS) : 0, body => !!body.file)
    if (this.bloom && now - this.bloom < BLOOM_MS) this.request()
    this.paintCrumbs()
    this.paintPeek()
    paintLeaders(c, this.placeNames(frame, scene), this.palette!)
    for (const button of this.toggle.children) button.setAttribute('aria-pressed', String((button as HTMLElement).dataset.projection === this.place.projection))
    this.el.dataset.projection = this.place.projection
  }

  private readPalette(): void {
    const paper = getComputedStyle(this.el).backgroundColor
    if (this.palette && paper === this.paper) return
    this.paper = paper
    const colour = (name: string): string => { this.probe.style.color = `var(--globe-${name})`; return getComputedStyle(this.probe).color }
    this.palette = {
      ocean: colour('ocean'), deep: colour('deep'), glow: colour('glow'), grid: colour('grid'), ink: colour('ink'), paper: colour('paper'), land: colour('land'), shade: colour('shade'),
      tones: Object.fromEntries(TONES.map(tone => [tone, colour(`tone-${tone}`)])) as Record<Tone, string>,
    }
  }

  /** Lays the names that fit over the frame, reusing their elements, and gives back the lines from those standing off their tiles. */
  private placeNames(frame: Frame, scene: Scene): Leader[] {
    const { width, height } = this.viewport, r = frame.r, candidates: Body[] = []
    const visit = (body: Body): void => {
      const px = body.span * r
      if (px < NAME_PX) return
      const at = project(frame, body.centre)
      const reach = body.radius * r
      if (at.depth < 0 || at.x < -reach || at.x > width + reach || at.y < -reach || at.y > height + reach) return
      if (body.kind === 'thread' && px >= LEAD_PX) this.readLead(body)
      const page = body.kind === 'constitution' && body.parent!.key !== this.place.focus && px < CONSTITUTION_PX
      if ((body.kind !== 'lead' || body.file) && !page) candidates.push(body)
      body.kids.forEach(visit)
    }
    scene.roots.forEach(visit)
    const opens = (body: Body): number => this.underFocus(body) ? (body.urgency > ATTENTION.length ? .5 : 0) : body.kind === 'province' || body.kind === 'area' || body.kids.some(kid => kid.kind === 'thread') ? 2 : 1
    // Under the focus the smallest tiles go first: they have the fewest places a name can go.
    candidates.sort((a, b) => opens(a) - opens(b) || (this.underFocus(a) ? b.cell.order - a.cell.order : 0) || a.urgency - b.urgency || b.cell.order - a.cell.order)
    const box = { left: 8, top: this.headHeight + 4, right: width - 8, bottom: height - this.footHeight - 4 }
    const owed = candidates.filter(body => this.underFocus(body))
    // Thread names in the largest type their tiles allow may crowd out their neighbours; then all of them take the smallest.
    let placed = placeNames(this.candidates(candidates, frame, scene, false), box, MOST_NAMES)
    if (owed.some(body => !placed.some(name => name.owner === body))) placed = placeNames(this.candidates(candidates, frame, scene, true), box, MOST_NAMES)
    const live = new Set<string>(), leaders: Leader[] = []
    for (const { owner, block, at, box } of placed) {
      live.add(owner.key)
      let name = this.nameEls.get(owner.key)
      // A flight passes more names than anyone can read: new ones wait for it to land.
      if (!name && this.flying) { live.delete(owner.key); continue }
      if (!name) {
        name = el('button', 'globe-name'); name.type = 'button'
        name.setAttribute('role', 'option')
        name.dataset.key = owner.key
        this.names.append(name)
        this.nameEls.set(owner.key, name)
      }
      const shape = block.lines.join('\n')
      if (name.dataset.shape !== shape) {
        name.dataset.shape = shape
        name.replaceChildren(...block.lines.map(line => el('span', '', line)))
      }
      name.dataset.kind = owner.kind
      name.dataset.standing = owner.tone
      if (owner.thread) name.dataset.thread = owner.key
      name.setAttribute('aria-label', owner.thread ? `${owner.name}, ${owner.thread.word}` : owner.name)
      name.setAttribute('aria-selected', String(owner.key === this.place.focus))
      name.style.transform = `translate(${(at.x - block.width / 2).toFixed(1)}px, ${(at.y - block.height / 2).toFixed(1)}px)`
      name.style.width = `${block.width + 1}px`
      name.dataset.size = block.role
      const outline = this.underFocus(owner) && !this.flying ? this.outlineOn(frame, owner) : null
      if (outline && !within(outline, at.x, at.y)) leaders.push({ box, to: project(frame, owner.centre) })
    }
    for (const [key, name] of this.nameEls) if (!live.has(key)) { name.remove(); this.nameEls.delete(key) }
    return leaders
  }
  /** What asks in earnest is named beside its marker while its tile is too small to hold the name. */
  private *callouts(frame: Frame, scene: Scene): Generator<Candidate<Body>> {
    for (const body of scene.asks) {
      const kind = askKind(body)
      if ((kind !== 'question' && kind !== 'blocked') || body.span * frame.r >= BEACON_PX) continue
      const { x, y, depth } = project(frame, body.centre)
      if (depth < 0) continue
      const options = this.blocksOf(body).filter(block => block.role === 'note').reverse()
      yield { owner: body, polygon: null, blocks: options, anchors: options.flatMap(block => [{ x: x + CALLOUT_GAP + block.width / 2, y }, { x: x - CALLOUT_GAP - block.width / 2, y }]) }
    }
  }
  /** The thread is one of those the view has come to: its name is to be read, whatever the size of its tile. */
  private underFocus(body: Body): boolean { return body.kind === 'thread' && body.parent?.key === this.place.focus }
  /** A tile's outline on the screen; null while any of it is over the horizon. */
  private outlineOn(frame: Frame, body: Body): number[] | null {
    const trace = traceOf(body, 4).points, polygon: number[] = []
    for (let n = 0; n < trace.length; n += 3) {
      const point = project(frame, [trace[n], trace[n + 1], trace[n + 2]])
      if (point.depth < 0) return null
      polygon.push(point.x, point.y)
    }
    return polygon
  }
  private *candidates(bodies: readonly Body[], frame: Frame, scene: Scene, small: boolean): Generator<Candidate<Body>> {
    yield* this.callouts(frame, scene)
    const focus = this.place.focus ? scene.byKey.get(this.place.focus) : undefined, room = focus ? this.outlineOn(frame, focus) : null
    for (const body of bodies) {
      const polygon = this.outlineOn(frame, body)
      if (!polygon) continue
      const middle = project(frame, body.centre)
      if (this.underFocus(body)) {
        const notes = this.blocksOf(body).filter(block => block.role === 'note').reverse()
        yield { owner: body, polygon: brickOf(polygon, middle), anchors: [middle], blocks: small ? notes : this.blocksOf(body) }
        const reach = ringsAround(middle, NUDGE, NUDGE_RINGS)
        yield { owner: body, polygon: room, anchors: ringsAround(middle, NUDGE, NEAR_RINGS), blocks: notes }
        if (room) yield { owner: body, polygon: null, clear: room, anchors: reach, blocks: notes }
        yield { owner: body, polygon: room, anchors: reach, blocks: notes }
        continue
      }
      const childless = body.kind === 'thread' && !body.kids.some(kid => kid.kind === 'thread')
      const anchors = childless ? [project(frame, centre(child(body.cell, NORTH))), middle] : [middle]
      yield { owner: body, polygon: body.kind === 'province' || body.kind === 'area' ? polygon : brickOf(polygon, middle), anchors, blocks: this.blocksOf(body) }
    }
  }
  private blocksOf(body: Body): Block[] {
    const key = `${body.kind}\u0000${body.name}`
    let found = this.blockCache.get(key)
    if (!found) {
      found = ROLES[body.kind].flatMap(role => {
        this.ruler.dataset.size = role
        this.measurer.font = getComputedStyle(this.ruler).font
        return blocks(body.name, text => this.measurer.measureText(text).width, Math.ceil(ROLE_SIZE[role] * LEADING), role)
      })
      this.blockCache.set(key, found)
    }
    return found
  }
  /** Asks for a thread's tapestry the first time its cell is big enough to show it; its place was always kept. */
  private readLead(body: Body): void {
    const thread = body.thread!
    if (this.leads.has(body.key)) return
    this.leads.set(body.key, null)
    void this.host.feeds.lead(thread.card).then(lead => {
      if (!lead) return
      this.leads.set(body.key, lead)
      this.withLead(body.key, lead)
      this.request()
    })
  }
  private withLead(key: string, lead: MapFile): void {
    const slot = this.scene.byKey.get(`lead\u0000${key}`)
    if (slot) { slot.file = lead; slot.name = lead.name }
  }

  private paintCounts(): void {
    const scene = this.scene
    this.counts.replaceChildren(...ATTENTION.flatMap(kind => {
      if (kind === 'working') return []
      const asking = scene.asks.filter(body => askKind(body) === kind)
      if (!asking.length) return []
      const count = el('button', 'ws-family-count globe-count'); count.type = 'button'
      count.dataset.standing = kind
      const mark = svgEl('svg'); mark.setAttribute('viewBox', '-7 -7 14 14'); mark.setAttribute('aria-hidden', 'true')
      const path = svgEl('path'); path.setAttribute('d', markPath(kind, 4.5)); mark.append(path)
      count.append(mark, `${asking.length} ${ATTENTION_WORD[kind].toLowerCase().replace(/s$/, asking.length === 1 ? '' : 's')}`)
      count.addEventListener('click', () => this.nextAsk(kind))
      return [count]
    }))
  }
  /** Walks to the next tile asking, of one kind or any, without touching Rex. */
  private nextAsk(kind?: string, step = 1): void {
    const asks = this.scene.asks.filter(body => !kind || askKind(body) === kind)
    if (!asks.length) return
    const at = asks.findIndex(body => body.key === this.place.focus)
    this.come(asks[(at + step + asks.length) % asks.length])
  }

  private paintCrumbs(): void {
    const focused = this.place.focus ? this.scene.byKey.get(this.place.focus) : undefined
    const at = focused ?? (this.camera.radius > this.whole * 1.5 ? this.atCentre() : null)
    const trail: Body[] = []
    for (let body = at; body; body = body.parent) trail.unshift(body)
    const shape = trail.map(body => body.key).join('\u0001')
    if (shape === this.crumbShape && this.crumbs.childElementCount) return
    this.crumbShape = shape
    const home = el('button', 'globe-crumb', 'Everything'); home.type = 'button'
    home.addEventListener('click', () => { this.place.focus = null; this.fly({ ...this.camera, radius: this.whole }) })
    this.crumbs.replaceChildren(home, ...trail.map(body => {
      const crumb = el('button', 'globe-crumb', body.name); crumb.type = 'button'
      crumb.addEventListener('click', () => this.come(body))
      return crumb
    }))
    this.headHeight = this.crumbs.parentElement!.getBoundingClientRect().height
  }
  private paintPeek(): void {
    const body = this.hover ?? (this.place.focus ? this.scene.byKey.get(this.place.focus) ?? null : null)
    const thread = body?.thread
    const shape = JSON.stringify([body?.key, thread?.word, thread?.note, body?.file?.name])
    if (shape === this.peekShape) return
    this.peekShape = shape
    this.peek.replaceChildren()
    this.peek.classList.toggle('globe-peek-idle', !body)
    if (!body) this.peek.append(el('p', 'globe-reading', 'North in flight · equator at rest · south finished'))
    else this.fillPeek(body)
    this.footHeight = this.peek.getBoundingClientRect().height + FOOT_GAP
  }
  private fillPeek(body: Body): void {
    const thread = body.thread, now = Date.now()
    const title = el('div', 'globe-peek-title')
    title.dataset.standing = body.tone
    title.append(el('span', 'globe-peek-name', body.name))
    if (thread) title.append(el('span', 'globe-peek-meta', [thread.word, shortAgo(thread.lastMove, now)].join(' · ')))
    else if (body.kind === 'province' || body.kind === 'area') {
      const families = this.familyCount(body)
      title.append(el('span', 'globe-peek-meta', `${families} ${families === 1 ? 'family' : 'families'}`))
    }
    else if (body.file?.at) title.append(el('span', 'globe-peek-meta', shortAgo(body.file.at, now)))
    title.append(el('span', 'globe-peek-cell', `order ${body.cell.order} · nest ${ipixOf(body.cell)}`))
    this.peek.append(title)
    if (thread?.note) this.peek.append(el('p', 'globe-peek-note', firstSentence(thread.note)))
  }

  private familyCount(body: Body): number { return body.kids.reduce((sum, kid) => sum + (kid.kind === 'area' ? this.familyCount(kid) : 1), 0) }

  private setHover(body: Body | null): void {
    if (body === this.hover) return
    this.hover = body
    this.canvas.style.cursor = body ? 'pointer' : ''
    this.request()
  }
  private local(event: { clientX: number; clientY: number }): Point {
    const box = this.canvas.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }
  private resized(): void {
    const box = this.canvas.getBoundingClientRect(), width = Math.round(box.width), height = Math.round(box.height)
    if (width === this.viewport.width && height === this.viewport.height) return
    const wasWhole = this.place.camera && this.viewport.width && this.place.camera.radius <= this.whole * 1.01
    this.viewport = { width, height }
    if (!width) return
    const ratio = window.devicePixelRatio || 1
    this.canvas.width = width * ratio; this.canvas.height = height * ratio
    if (wasWhole) this.camera = { ...this.camera, radius: this.whole }
    this.request()
  }

  private wheel(event: WheelEvent): void {
    if ((event.target as Element).closest('.globe-head, .globe-toggle')) return
    event.preventDefault()
    this.stopFlight()
    const rows = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1, at = this.local(event)
    if (event.ctrlKey || event.metaKey) {
      const change = Math.exp(-Math.max(-WHEEL_MOST, Math.min(WHEEL_MOST, event.deltaY * rows)) * WHEEL_RATE)
      this.zoomAbout(this.camera.radius * change, at)
    } else {
      const { width, height } = this.viewport, middle = invert(this.frameNow(), width / 2, height / 2)
      if (middle) this.camera = keeping(this.camera, this.place.projection, this.viewport, middle, width / 2 - event.deltaX * rows, height / 2 - event.deltaY * rows)
    }
    this.request()
  }
  /** The closest a zoom may come here: until the smallest thing under it fills the stage, so it never ends in featureless ground. */
  private reach(under: Vec | null): number {
    const wide = Math.min(this.viewport.width, this.viewport.height)
    const body = under && this.pickAt(under, 0)
    return body ? wide * FILL_REACH / body.span : this.whole * OCEAN_REACH
  }
  private zoomAbout(radius: number, at: Point): void {
    const under = invert(this.frameNow(), at.x, at.y)
    const next = this.held({ ...this.camera, radius: radius > this.camera.radius ? Math.min(radius, Math.max(this.camera.radius, this.reach(under))) : radius })
    this.camera = under ? keeping(next, this.place.projection, this.viewport, under, at.x, at.y) : next
  }
  private down(event: PointerEvent): void {
    if (event.button) return
    this.stopFlight()
    const at = this.local(event)
    this.fingers.set(event.pointerId, at)
    this.canvas.setPointerCapture?.(event.pointerId)
    if (this.fingers.size === 2) {
      const [a, b] = [...this.fingers.values()]
      this.pinch = { gap: Math.hypot(a.x - b.x, a.y - b.y), radius: this.camera.radius, grabbed: invert(this.frameNow(), (a.x + b.x) / 2, (a.y + b.y) / 2) }
      this.drag = null
      return
    }
    this.drag = { grabbed: invert(this.frameNow(), at.x, at.y), from: at, camera: this.camera, moved: false, touch: event.pointerType === 'touch' }
  }
  private move(event: PointerEvent): void {
    const at = this.local(event)
    if (this.fingers.has(event.pointerId)) this.fingers.set(event.pointerId, at)
    if (this.pinch && this.fingers.size === 2) {
      const [a, b] = [...this.fingers.values()], middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const radius = this.pinch.radius * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, this.pinch.gap)
      this.camera = this.held({ ...this.camera, radius: radius > this.camera.radius ? Math.min(radius, Math.max(this.camera.radius, this.reach(this.pinch.grabbed))) : radius })
      if (this.pinch.grabbed) this.camera = keeping(this.camera, this.place.projection, this.viewport, this.pinch.grabbed, middle.x, middle.y)
      this.request()
      return
    }
    if (!this.drag) {
      if (event.pointerType !== 'touch' && event.target === this.canvas) this.setHover(this.pick(at.x, at.y))
      return
    }
    if (!this.drag.moved && Math.hypot(at.x - this.drag.from.x, at.y - this.drag.from.y) < SLOP) return
    this.drag.moved = true
    const time = performance.now()
    this.trail = [...this.trail.filter(point => time - point.at < TRAIL_MS), { ...at, at: time }]
    this.setHover(null)
    this.el.classList.add('globe-dragging')
    const { grabbed, from, camera } = this.drag
    if (grabbed) this.camera = keeping(this.camera, this.place.projection, this.viewport, grabbed, at.x, at.y)
    else this.camera = { ...camera, lon: camera.lon - (at.x - from.x) / camera.radius, lat: Math.max(-1.55, Math.min(1.55, camera.lat + (at.y - from.y) / camera.radius)) }
    this.request()
  }
  private up(event: PointerEvent): void {
    if (!this.fingers.delete(event.pointerId)) return
    if (this.fingers.size < 2) this.pinch = null
    const drag = this.drag
    this.drag = null
    this.el.classList.remove('globe-dragging')
    const at = this.local(event)
    if (drag?.moved && drag.grabbed && this.trail.length > 1 && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      const first = this.trail[0], last = this.trail.at(-1)!, span = Math.max(1, last.at - first.at), time = performance.now()
      if (time - last.at < TRAIL_MS) {
        this.coast = { grabbed: drag.grabbed, x: at.x, y: at.y, vx: (last.x - first.x) / span, vy: (last.y - first.y) / span, last: time }
        this.request()
      }
    }
    this.trail = []
    if (!drag || drag.moved || event.type === 'pointercancel') return
    const body = this.pick(at.x, at.y)
    if (body) this.activate(body, drag.touch)
  }
  /** A name's own click, from a hand or a screen reader, does what a click on its tile does. */
  private named(event: Event): void {
    const name = (event.target as Element).closest<HTMLElement>('.globe-name')
    const body = name?.dataset.key ? this.scene.byKey.get(name.dataset.key) : undefined
    if (body) this.activate(body, false)
  }
  /** A thread flies and opens its conversation at once, a finger's on its second tap; a page opens on the stage; a province is flown to. */
  private activate(body: Body, touch: boolean): void {
    const thread = body.thread, owner = body.parent?.thread
    if (thread) {
      if (touch && this.tapped !== body.key) { this.tapped = body.key; this.come(body); return }
      this.tapped = null
      this.come(body)
      if (conversable(thread.card) && this.host.converse(thread.card)) { this.place.worker = body.key; this.request() }
      return
    }
    if (owner && body.file) this.host.openDocument(owner.card, body.file.key)
    else if (owner && body.kind === 'constitution') this.host.openDocument(owner.card, this.host.constitutionKey(owner.card))
    else this.come(body)
  }
  /** The keys the chassis leaves to a view; true when one was taken. */
  keydown(event: KeyboardEvent): boolean {
    if (this.reading() || event.metaKey || event.ctrlKey || event.altKey || keystrokeIsSpokenFor()) return false
    const { width, height } = this.viewport, middle = { x: width / 2, y: height / 2 }
    switch (event.key) {
      case 'Escape': case 'h': return this.stepOut()
      case 'm': this.project(this.place.projection === 'globe' ? 'mollweide' : 'globe'); return true
      case '+': case '=': this.stopFlight(); this.zoomAbout(this.camera.radius * KEY_ZOOM, middle); this.request(); return true
      case '-': case '_': this.stopFlight(); this.zoomAbout(this.camera.radius / KEY_ZOOM, middle); this.request(); return true
      case 'ArrowRight': case 'ArrowDown': this.nextAsk(); return true
      case 'ArrowLeft': case 'ArrowUp': this.nextAsk(undefined, -1); return true
      case 'Enter': {
        if ((event.target as Element).closest?.('button')) return false
        const body = this.place.focus ? this.scene.byKey.get(this.place.focus) : undefined
        if (body) this.activate(body, false)
        return !!body
      }
      default: return false
    }
  }
}
