import type { DocKey } from './documents.js'
import { parseRoute, type WorkspaceRoute } from './boardRoute.js'
import { DESK_VIEW, getView, viewOrDesk, viewTitle } from '../views/ViewRegistry.js'

export { parseRoute, type WorkspaceRoute }

/** The reader's addresses live under `#/board/`; `#/board` itself is an old address of Channels. */
const BOARD_HASH = '#/board'
const STATE_KEY = 'shuttleWorkspace'
/** A back goes on through at most this many entries of framed pages' own history. */
export const FRAME_STEPS = 8
/** A back whose landing the board has not heard of in this long is taken as landed. */
export const LANDING_MS = 500
/** The view a reader entry was opened from: `desk`, or a registered view's id. */
export type WorkspaceOriginView = string
/** What a reader entry says about itself: whether the view it was opened from is the entry below it, and which view that is. */
interface RouteState { layer: boolean; originView: WorkspaceOriginView }
type StateObject = Record<string, unknown>

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[@!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** The view a deep link to the reader goes back to. */
const CHANNELS_VIEW = 'channels'
/** The id a hash of a view's shape (`#/<id>`) carries. */
const idOfHash = (hash: string): string | undefined => /^#\/([^/?#]+)$/.exec(hash)?.[1]
/** The board view a location hash addresses (`#/<id>` for a registered view), or null for any other hash. */
export function viewOfHash(hash: string): WorkspaceOriginView | null {
  if (hash === '#/desk' || hash === '#/chronicle' || hash === '#/globe') return DESK_VIEW
  const id = hash === BOARD_HASH || hash.startsWith(`${BOARD_HASH}/`) ? CHANNELS_VIEW : idOfHash(hash)
  return id && getView(id) ? id : null
}
/** The address a view is shown at: `#/board` redirects to `#/channels`; retired view hashes redirect to `#/desk`. */
function canonical(hash: string): string {
  if (hash === BOARD_HASH) return '#/channels'
  if (hash === '#/chronicle' || hash === '#/globe') return '#/desk'
  return hash
}
/** The address the board moves to: a view's own, and the Desk's for one no registered view answers to. */
function settled(hash: string): string {
  const address = canonical(hash)
  return idOfHash(address) && !viewOfHash(address) ? `#/${DESK_VIEW}` : address
}

export function formatRoute(route: WorkspaceRoute): string {
  if (route.kind === 'overview') return route.hash ?? '#/channels'
  if (!route.uid || !route.owner) throw new Error('Channel routes require a uid and owner')
  return `${BOARD_HASH}/${encode(route.uid)}@${encode(route.owner)}${route.doc === undefined ? '' : `/${encode(route.doc)}`}`
}

function stateObject(value: unknown): StateObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as StateObject) }
    : {}
}

function readRouteState(value: unknown): RouteState | null {
  const entry = stateObject(value)[STATE_KEY] as Partial<RouteState> | undefined
  return entry && typeof entry.layer === 'boolean' && typeof entry.originView === 'string' && entry.originView ? { layer: entry.layer, originView: entry.originView } : null
}

function withRouteState(value: unknown, routeState: RouteState | null): StateObject {
  const state = stateObject(value)
  if (routeState) state[STATE_KEY] = routeState
  else delete state[STATE_KEY]
  return state
}

/**
 * Where back goes. The reader is one layer over the view it was opened
 * from, and back's destination depends only on where you are, never on how
 * you got there: back from any page the reader shows returns to that view.
 *
 * The layer holds at most one history entry, pushed directly above its
 * view's when the reader opens. Every move inside the reader (another
 * constitution, another page, a link, a scan) replaces that entry, so the
 * address always names what is shown while the history never grows. The
 * reader's back, Escape, the phone's swipe, the origin view's tab and the
 * browser's own back are therefore the same single step. A reader address
 * opened directly (a deep link, a typed URL with nothing of ours below it)
 * has no view entry below: leaving it replaces it with its view.
 *
 * Another view chosen from the reader replaces the reader's entry, so the
 * browser's back from there returns to the view the reader covered; the
 * view under the reader, chosen from it, is back. Dialogs over the reader
 * (the sent files sheet) keep no entry of their own.
 */
export class WorkspaceHistory {
  /** Hears each route to apply; `quiet` when a scan led to it, which moves neither voice nor Rex. */
  private readonly onRoute: (route: WorkspaceRoute, quiet: boolean) => void
  private started = false
  private current: WorkspaceRoute | null = null
  private currentHash = ''
  /** The view opened from, as it was then: read through `originView`, since it may have been unregistered. */
  private origin: WorkspaceOriginView = CHANNELS_VIEW
  /** The reader's entry sits directly above its view's. */
  private layered = false
  /** A back this history asked for has not landed: anything asked meanwhile waits for it. */
  private leaving = false
  private queued: (() => void) | null = null
  /** How many entries of framed pages' history the back in flight has gone on through. */
  private steps = 0
  private landing = 0

  constructor(onRoute: (route: WorkspaceRoute, quiet: boolean) => void) {
    this.onRoute = onRoute
  }

  /** The one place back goes: the view the reader was opened from, or the Desk once that view is unregistered. */
  get originView(): WorkspaceOriginView { return viewOrDesk(this.origin) }
  /** Its name. */
  get backLabel(): string { return viewTitle(this.originView) }

  start(): void {
    if (this.started) return
    this.started = true
    // An address no view answers to yet is left for a view that registers later.
    this.redirect(canonical)
    this.currentHash = window.location.hash
    window.addEventListener('popstate', this.onPopState)
    window.addEventListener('hashchange', this.onHashChange)
    const route = parseRoute(this.currentHash)
    const saved = readRouteState(window.history.state)
    if (route?.kind !== 'channel') {
      const view = viewOfHash(this.currentHash)
      if (view) { this.origin = view; this.current = { kind: 'overview', hash: this.currentHash } }
      return
    }
    this.current = route
    this.layered = saved?.layer ?? false
    this.origin = saved?.originView ?? CHANNELS_VIEW
    this.onRoute(route, false)
  }

  /**
   * Show a constitution, at one of its pages. From a view this opens the
   * reader's layer above it; inside the reader it takes the layer's place.
   */
  enter(uid: string, owner: string, doc?: DocKey, originView?: WorkspaceOriginView, quiet = false): void {
    this.ensureStarted()
    if (this.leaving) { this.queued = () => this.enter(uid, owner, doc, originView, quiet); return }
    const route: Extract<WorkspaceRoute, { kind: 'channel' }> = { kind: 'channel', uid, owner, ...(doc === undefined ? {} : { doc }) }
    const hash = formatRoute(route)
    if (hash === this.currentHash) return
    if (this.current?.kind === 'channel') {
      window.history.replaceState(withRouteState(window.history.state, this.routeState()), '', hash)
    } else {
      this.origin = viewOfHash(this.currentHash) ?? originView ?? this.origin
      this.layered = true
      window.history.pushState(withRouteState(null, this.routeState()), '', hash)
    }
    this.current = route
    this.currentHash = hash
    this.onRoute(route, quiet)
  }

  /** Another page of the constitution shown, in the layer's place. */
  show(doc: DocKey): void {
    if (this.current?.kind !== 'channel' || this.current.doc === doc) return
    this.enter(this.current.uid, this.current.owner, doc)
  }

  /** The address follows a page the reader settled on by itself, applying nothing. */
  name(doc: DocKey | undefined): void {
    if (this.current?.kind !== 'channel' || this.leaving || this.current.doc === doc) return
    const { uid, owner } = this.current
    const route: WorkspaceRoute = { kind: 'channel', uid, owner, ...(doc === undefined ? {} : { doc }) }
    const hash = formatRoute(route)
    window.history.replaceState(withRouteState(window.history.state, this.routeState()), '', hash)
    this.current = route
    this.currentHash = hash
  }

  /** Show a view. From the reader it takes the reader's entry; otherwise it is a new entry. */
  view(address: string): void {
    this.ensureStarted()
    if (this.leaving) { this.queued = () => this.view(address); return }
    const hash = settled(address)
    if (hash === this.currentHash) return
    // The view under the reader, chosen from it, is back.
    if (this.current?.kind === 'channel' && viewOfHash(hash) === this.originView) { this.leave(); return }
    if (this.current?.kind === 'channel') window.history.replaceState(withRouteState(window.history.state, null), '', hash)
    else window.history.pushState(null, '', hash)
    this.origin = viewOfHash(hash) ?? DESK_VIEW
    this.layered = false
    this.current = { kind: 'overview', hash }
    this.currentHash = hash
    this.onRoute(this.current, false)
  }

  /** A back that landed in a framed page's own history (a deck's slides): the back this history asked for goes on to the view. */
  framePopped(): void {
    if (this.leaving && ++this.steps <= FRAME_STEPS) this.back()
  }

  /** Back, from anywhere in the reader: its view, in one step. */
  leave(): void {
    if (this.current?.kind !== 'channel' || this.leaving) return
    const hash = `#/${this.originView}`
    if (this.layered) {
      this.leaving = true
      this.steps = 0
      this.back()
    } else {
      window.history.replaceState(withRouteState(window.history.state, null), '', hash)
    }
    this.layered = false
    this.current = { kind: 'overview', hash }
    this.currentHash = hash
    this.onRoute(this.current, false)
  }

  /** The view on show was unregistered and the board went home: the address it left names the Desk in its place. */
  viewGone(): void {
    if (this.leaving || this.current?.kind !== 'overview') return
    const hash = settled(this.currentHash)
    if (hash === this.currentHash) return
    window.history.replaceState(withRouteState(window.history.state, null), '', hash)
    this.origin = DESK_VIEW
    this.current = { kind: 'overview', hash }
    this.currentHash = hash
  }

  /**
   * One step back. A back the board never hears land (it stopped in a frame's
   * history past the steps it goes on through, or on an entry a nested frame
   * made, which reports nothing) is taken as landed: the entry it stopped on
   * names the view, and what was asked meanwhile goes ahead.
   */
  private back(): void {
    window.history.back()
    clearTimeout(this.landing)
    this.landing = window.setTimeout(() => {
      if (!this.leaving) return
      window.history.replaceState(withRouteState(window.history.state, null), '', this.currentHash)
      this.handleLocation(window.history.state)
    }, LANDING_MS)
  }

  dispose(): void {
    clearTimeout(this.landing)
    if (!this.started) return
    window.removeEventListener('popstate', this.onPopState)
    window.removeEventListener('hashchange', this.onHashChange)
    this.started = false
    this.leaving = false
    this.queued = null
  }

  private ensureStarted(): void {
    if (!this.started) this.start()
  }

  private routeState(): RouteState {
    return { layer: this.layered, originView: this.origin }
  }

  /** An address that stands for another is replaced by it where it stands. */
  private redirect(address: (hash: string) => string): void {
    const hash = address(window.location.hash)
    if (hash !== window.location.hash) window.history.replaceState(window.history.state, '', hash)
  }

  /** The browser moved: through its own back or forward, a typed address, or a back this history asked for. */
  private handleLocation(state: unknown): void {
    this.redirect(settled)
    const hash = window.location.hash
    clearTimeout(this.landing)
    const queued = this.leaving ? this.queued : null
    this.leaving = false
    this.queued = null
    if (hash !== this.currentHash) this.land(hash, state)
    queued?.()
  }

  private land(hash: string, state: unknown): void {
    const route = parseRoute(hash)
    const saved = readRouteState(state)
    if (route?.kind === 'channel') {
      if (!saved) {
        // An address typed or followed outside the board, above whatever was shown.
        this.layered = this.current?.kind === 'overview'
        if (this.current?.kind === 'overview') this.origin = viewOfHash(this.currentHash) ?? this.origin
        window.history.replaceState(withRouteState(state, this.routeState()), '')
      } else {
        this.layered = saved.layer
        this.origin = saved.originView
      }
      this.current = route
    } else {
      this.currentHash = hash
      if (!this.current && !viewOfHash(hash)) return
      this.layered = false
      this.origin = viewOfHash(hash) ?? this.origin
      this.current = { kind: 'overview', hash }
    }
    this.currentHash = hash
    this.onRoute(this.current, false)
  }

  private readonly onPopState = (event: PopStateEvent): void => this.handleLocation(event.state)
  private readonly onHashChange = (): void => this.handleLocation(window.history.state)
}
