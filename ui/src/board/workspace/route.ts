import type { DocKey } from './documents.js'

export type WorkspaceRoute =
  /** `hash` names the view the entry addresses, known before an asynchronous pop lands. */
  | { kind: 'overview'; hash?: string }
  | { kind: 'channel'; uid: string; owner: string; doc?: DocKey }

const OVERVIEW_HASH = '#/board'
const STATE_KEY = 'shuttleWorkspace'
export type WorkspaceOriginView = 'desk' | 'chronicle' | 'board' | 'tree' | 'globe' | 'map'
interface HistoryPage { hash: string; label?: string; pageLabel?: string }
interface RouteState {
  depth: number
  base: boolean
  baseHash: string
  originView?: WorkspaceOriginView
  label?: string
  pageLabel?: string
  back?: HistoryPage
}
type StateObject = Record<string, unknown>

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[@!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function isOriginView(value: unknown): value is WorkspaceOriginView {
  return value === 'desk' || value === 'chronicle' || value === 'board' || value === 'tree' || value === 'globe' || value === 'map'
}
function originFromHash(hash: string): WorkspaceOriginView | null {
  if (hash === '#/desk') return 'desk'
  if (hash === '#/chronicle') return 'chronicle'
  if (hash === '#/tree') return 'tree'
  if (hash === '#/globe') return 'globe'
  if (hash === '#/map') return 'map'
  if (hash === OVERVIEW_HASH || hash.startsWith(`${OVERVIEW_HASH}/`)) return 'board'
  return null
}
function hashFromOrigin(view: WorkspaceOriginView): string {
  return view === 'board' ? OVERVIEW_HASH : `#/${view}`
}

export function parseRoute(hash: string): WorkspaceRoute | null {
  const OVERVIEW_HASH = '#/board'
  const decode = (value: string): string | null => { try { return decodeURIComponent(value) } catch { return null } }
  if (hash === OVERVIEW_HASH) return { kind: 'overview' }
  const prefix = `${OVERVIEW_HASH}/`
  if (!hash.startsWith(prefix)) return null
  const addressAndDoc = hash.slice(prefix.length)
  const slash = addressAndDoc.indexOf('/')
  const address = slash < 0 ? addressAndDoc : addressAndDoc.slice(0, slash)
  const encodedDoc = slash < 0 ? undefined : addressAndDoc.slice(slash + 1)
  if (slash >= 0 && (!encodedDoc || encodedDoc.includes('/'))) return null
  const at = address.indexOf('@')
  if (at <= 0 || at === address.length - 1) return null
  const uid = decode(address.slice(0, at))
  const owner = decode(address.slice(at + 1))
  if (!uid || !owner) return null
  if (encodedDoc === undefined) return { kind: 'channel', uid, owner }
  const doc = decode(encodedDoc)
  if (!doc) return null
  return { kind: 'channel', uid, owner, doc }
}

export function formatRoute(route: WorkspaceRoute): string {
  if (route.kind === 'overview') return OVERVIEW_HASH
  if (!route.uid || !route.owner) throw new Error('Channel routes require a uid and owner')
  return `${OVERVIEW_HASH}/${encode(route.uid)}@${encode(route.owner)}${route.doc === undefined ? '' : `/${encode(route.doc)}`}`
}

function stateObject(value: unknown): StateObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as StateObject) }
    : {}
}

function readRouteState(value: unknown): RouteState | null {
  const entry = stateObject(value)[STATE_KEY]
  if (!entry || typeof entry !== 'object') return null
  const { depth, base, baseHash, originView, label, pageLabel, back } = entry as Partial<RouteState>
  return Number.isInteger(depth) && depth! >= 0 && typeof base === 'boolean' && typeof baseHash === 'string'
    ? {
      depth: depth!, base, baseHash, ...(isOriginView(originView) ? { originView } : {}),
      label: typeof label === 'string' ? label : undefined,
      pageLabel: typeof pageLabel === 'string' ? pageLabel : undefined,
      back: back && typeof back.hash === 'string' ? back : undefined,
    } : null
}

function withRouteState(value: unknown, routeState: RouteState): StateObject {
  return { ...stateObject(value), [STATE_KEY]: routeState }
}

/** URL-backed channel navigation and return to the originating view. */
export class WorkspaceHistory {
  private readonly onRoute: (route: WorkspaceRoute) => void
  private started = false
  private current: WorkspaceRoute | null = null
  private currentHash = ''
  private depth = 0
  private base = false
  private baseHash = ''
  private routeOrigin: WorkspaceOriginView = 'board'
  private pendingOwnPop: string | null = null
  private backInFlight = false
  private queuedEnter: (Extract<WorkspaceRoute, { kind: 'channel' }> & { originView?: WorkspaceOriginView; replace: boolean }) | null = null
  private queuedLeave = false

  constructor(onRoute: (route: WorkspaceRoute) => void) {
    this.onRoute = onRoute
  }

  get originView(): WorkspaceOriginView { return this.routeOrigin }
  get backLabel(): string {
    const back = readRouteState(window.history.state)?.back
    const route = back && parseRoute(back.hash)
    if (route?.kind !== 'channel') return this.originLabel
    const sameChannel = this.current?.kind === 'channel' && route.uid === this.current.uid && route.owner === this.current.owner
    return (sameChannel ? back?.pageLabel : back?.label) ?? route.uid
  }
  private get originLabel(): string { return { desk: 'Desk', chronicle: 'Chronicle', board: 'Board', tree: 'Tree', globe: 'Globe', map: 'Map' }[this.routeOrigin] }

  /** Resolve this entry's page address and names without adding a visit. */
  name(label: string, pageLabel = label, doc = this.current?.kind === 'channel' ? this.current.doc : undefined): void {
    if (this.current?.kind !== 'channel') return
    const saved = readRouteState(window.history.state)
    const route: WorkspaceRoute = { ...this.current, doc }
    const hash = formatRoute(route)
    if (hash === saved?.back?.hash) { this.back(); return }
    if (hash === this.currentHash && saved?.label === label && saved?.pageLabel === pageLabel) return
    window.history.replaceState(withRouteState(window.history.state, { ...this.routeState(), label, pageLabel }), '', hash)
    this.current = route
    this.currentHash = hash
  }

  /** Follow the visited path, or return a direct address to its origin view. */
  back(): void {
    if (this.current?.kind !== 'channel' || this.pendingOwnPop !== null || this.backInFlight) return
    if (this.depth > 0) { this.backInFlight = true; window.history.back() }
    else this.leave()
  }

  /** Explicit page opens add a visit, including links to a page just visited. */
  openDocument(doc: DocKey, pageLabel?: string): void {
    if (this.pendingOwnPop !== null) {
      if (this.queuedEnter) this.queuedEnter.doc = doc
      return
    }
    if (this.current?.kind !== 'channel' || this.current.doc === doc) return
    this.enter(this.current.uid, this.current.owner, doc, undefined, false, pageLabel)
  }

  /** Returning to controls reuses their preceding visit; otherwise it adds one. */
  revisitDocument(doc: DocKey, pageLabel?: string): void {
    if (this.current?.kind === 'channel' && formatRoute({ ...this.current, doc }) === readRouteState(window.history.state)?.back?.hash) this.back()
    else this.openDocument(doc, pageLabel)
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.currentHash = window.location.hash
    window.addEventListener('popstate', this.onPopState)
    window.addEventListener('hashchange', this.onHashChange)
    const route = parseRoute(this.currentHash)
    if (!route) {
      this.depth = 0
      this.base = true
      this.baseHash = this.currentHash
      this.routeOrigin = readRouteState(window.history.state)?.originView ?? originFromHash(this.currentHash) ?? this.routeOrigin
      return
    }
    this.current = route
    this.adoptDepth(window.history.state, route, this.currentHash)
    this.onRoute(route)
  }

  /** Constitution steps replace the current visit; other channel and page moves push. */
  enter(uid: string, owner: string, doc?: DocKey, originView?: WorkspaceOriginView, replace = false, pageLabel?: string): void {
    this.ensureStarted()
    const route: Extract<WorkspaceRoute, { kind: 'channel' }> = { kind: 'channel', uid, owner, ...(doc === undefined ? {} : { doc }) }
    if (this.pendingOwnPop !== null) {
      this.queuedEnter = { ...route, originView: originView ?? this.routeOrigin, replace }
      return
    }
    const hash = formatRoute(route)
    if (hash === this.currentHash) return
    const saved = readRouteState(window.history.state)
    if (replace && hash === saved?.back?.hash) { this.back(); return }
    if (originView) this.routeOrigin = originView
    // Back adopts the entry's origin along with its address.
    if (saved?.originView !== this.routeOrigin) window.history.replaceState(withRouteState(window.history.state, this.routeState()), '')
    const sameChannel = this.current?.kind === 'channel' && this.current.uid === uid && this.current.owner === owner
    const back = replace ? saved?.back : { hash: this.currentHash, label: saved?.label, pageLabel: saved?.pageLabel }
    const depth = this.depth + (replace ? 0 : 1)
    const state = withRouteState(window.history.state, {
      ...this.routeState(depth), label: sameChannel ? saved?.label : undefined, pageLabel, back,
    })
    if (replace) window.history.replaceState(state, '', hash)
    else window.history.pushState(state, '', hash)
    this.current = route
    this.currentHash = hash
    this.depth = depth
    this.onRoute(route)
  }

  /** Establish an addressable view as the next channel stack's return point. */
  view(hash = OVERVIEW_HASH): void {
    this.ensureStarted()
    if (hash === this.currentHash) return
    this.pendingOwnPop = null
    this.queuedEnter = null
    this.depth = 0
    this.base = true
    this.baseHash = hash
    this.routeOrigin = originFromHash(hash) ?? 'board'
    this.currentHash = hash
    this.current = { kind: 'overview', hash }
    window.history.pushState(withRouteState(window.history.state, { ...this.routeState(), label: undefined, pageLabel: undefined, back: undefined }), '', hash)
    this.onRoute(this.current)
  }

  leave(): void {
    if (this.current?.kind !== 'channel') return
    if (this.pendingOwnPop !== null) { this.queuedLeave = true; return }
    if (this.base && this.depth > 0) {
      const depth = this.depth
      const destination = this.baseHash
      const overview: WorkspaceRoute = { kind: 'overview', hash: destination }
      this.pendingOwnPop = destination
      window.history.go(-depth)
      this.current = overview
      this.currentHash = destination
      this.depth = 0
      this.onRoute(overview)
      return
    }
    const hash = hashFromOrigin(this.routeOrigin)
    const overview: WorkspaceRoute = { kind: 'overview', hash }
    this.current = overview
    this.currentHash = hash
    this.depth = 0
    this.base = true
    this.baseHash = hash
    window.history.replaceState(withRouteState(window.history.state, { ...this.routeState(), label: undefined, pageLabel: undefined, back: undefined }), '', hash)
    this.onRoute(overview)
  }

  dispose(): void {
    if (!this.started) return
    window.removeEventListener('popstate', this.onPopState)
    window.removeEventListener('hashchange', this.onHashChange)
    this.started = false
    this.backInFlight = false
    this.pendingOwnPop = null
    this.queuedEnter = null
  }

  private ensureStarted(): void {
    if (!this.started) this.start()
  }

  private routeState(depth = this.depth): RouteState {
    const saved = readRouteState(window.history.state)
    return { depth, base: this.base, baseHash: this.baseHash, originView: this.routeOrigin, label: saved?.label, pageLabel: saved?.pageLabel, back: saved?.back }
  }

  private adoptDepth(state: unknown, route: WorkspaceRoute, hash: string): void {
    const saved = readRouteState(state)
    if (saved) {
      this.depth = saved.depth
      this.base = saved.base
      this.baseHash = saved.baseHash
    } else {
      this.depth = 0
      this.base = route.kind === 'overview'
      this.baseHash = route.kind === 'overview' ? hash : ''
    }
    this.routeOrigin = saved?.originView
      ?? originFromHash(saved?.baseHash ?? '')
      ?? originFromHash(hash)
      ?? (route.kind === 'channel' ? 'board' : this.routeOrigin)
  }

  private handleLocation(state: unknown): void {
    this.backInFlight = false
    const hash = window.location.hash
    const route = parseRoute(hash)
    if (this.pendingOwnPop === hash) {
      this.pendingOwnPop = null
      this.currentHash = hash
      this.current = route ?? { kind: 'overview' }
      this.adoptDepth(state, this.current, hash)
      if (this.queuedLeave) {
        this.queuedLeave = false
        this.queuedEnter = null
        this.leave()
        return
      }
      const queued = this.queuedEnter
      this.queuedEnter = null
      if (queued) this.enter(queued.uid, queued.owner, queued.doc, queued.originView, queued.replace)
      return
    }

    if (hash === this.currentHash) return

    this.currentHash = hash
    const next: WorkspaceRoute | null = route ? (route.kind === 'overview' ? { ...route, hash } : route) : (this.current ? { kind: 'overview', hash } : null)
    if (!next) { this.current = null; this.depth = 0; this.base = true; this.baseHash = hash; return }
    this.current = next
    this.adoptDepth(state, next, hash)
    if (!route && next.kind === 'overview' && !readRouteState(state)) {
      this.base = true
      this.baseHash = hash
    }
    this.onRoute(next)
  }

  private readonly onPopState = (event: PopStateEvent): void => this.handleLocation(event.state)
  private readonly onHashChange = (): void => this.handleLocation(window.history.state)
}
