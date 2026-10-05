import type { DocKey } from './documents.js'

export type WorkspaceRoute =
  /** `hash` names the view the entry addresses, known before an asynchronous pop lands. */
  | { kind: 'overview'; hash?: string }
  | { kind: 'channel'; uid: string; owner: string; doc?: DocKey }

const OVERVIEW_HASH = '#/board'
const STATE_KEY = 'shuttleWorkspace'
interface RouteState { depth: number; base: boolean; baseHash: string }
type StateObject = Record<string, unknown>

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[@!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}
function decode(value: string): string | null {
  try { return decodeURIComponent(value) } catch { return null }
}

export function parseRoute(hash: string): WorkspaceRoute | null {
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
  const { depth, base, baseHash } = entry as Partial<RouteState>
  return Number.isInteger(depth) && depth! >= 0 && typeof base === 'boolean' && typeof baseHash === 'string'
    ? { depth: depth!, base, baseHash }
    : null
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
  private pendingOwnPop: string | null = null
  private queuedEnter: Extract<WorkspaceRoute, { kind: 'channel' }> | null = null
  private queuedLeave = false

  constructor(onRoute: (route: WorkspaceRoute) => void) {
    this.onRoute = onRoute
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
      return
    }
    this.current = route
    this.adoptDepth(window.history.state, route, this.currentHash)
    this.onRoute(route)
  }

  enter(uid: string, owner: string, doc?: DocKey): void {
    this.ensureStarted()
    const route: Extract<WorkspaceRoute, { kind: 'channel' }> = { kind: 'channel', uid, owner, ...(doc === undefined ? {} : { doc }) }
    if (this.pendingOwnPop !== null) {
      this.queuedEnter = route
      return
    }
    const nextDepth = this.depth + 1
    const hash = formatRoute(route)
    window.history.pushState(withRouteState(window.history.state, { depth: nextDepth, base: this.base, baseHash: this.baseHash }), '', hash)
    this.current = route
    this.currentHash = hash
    this.depth = nextDepth
    this.onRoute(route)
  }

  /** Establish an addressable view as the next channel stack's return point. */
  view(hash = OVERVIEW_HASH): void {
    this.ensureStarted()
    this.pendingOwnPop = null
    this.queuedEnter = null
    this.depth = 0
    this.base = true
    this.baseHash = hash
    this.currentHash = hash
    this.current = { kind: 'overview', hash }
    window.history.pushState(withRouteState(window.history.state, { depth: 0, base: true, baseHash: hash }), '', hash)
    this.onRoute(this.current)
  }

  select(doc: DocKey): void {
    if (this.pendingOwnPop !== null) {
      if (this.queuedEnter) this.queuedEnter = { ...this.queuedEnter, doc }
      return
    }
    if (this.current?.kind !== 'channel') return
    const route: WorkspaceRoute = { ...this.current, doc }
    const hash = formatRoute(route)
    window.history.replaceState(withRouteState(window.history.state, { depth: this.depth, base: this.base, baseHash: this.baseHash }), '', hash)
    this.current = route
    this.currentHash = hash
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
    window.history.replaceState(withRouteState(window.history.state, { depth: 0, base: true, baseHash: OVERVIEW_HASH }), '', OVERVIEW_HASH)
    const overview: WorkspaceRoute = { kind: 'overview', hash: OVERVIEW_HASH }
    this.current = overview
    this.currentHash = OVERVIEW_HASH
    this.depth = 0
    this.base = true
    this.baseHash = OVERVIEW_HASH
    this.onRoute(overview)
  }

  dispose(): void {
    if (!this.started) return
    window.removeEventListener('popstate', this.onPopState)
    window.removeEventListener('hashchange', this.onHashChange)
    this.started = false
    this.pendingOwnPop = null
    this.queuedEnter = null
  }

  private ensureStarted(): void {
    if (!this.started) this.start()
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
  }

  private handleLocation(state: unknown): void {
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
      if (queued) this.enter(queued.uid, queued.owner, queued.doc)
      return
    }

    if (hash === this.currentHash) {
      if (route) {
        this.current = route
        this.adoptDepth(state, route, hash)
      }
      return
    }

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
