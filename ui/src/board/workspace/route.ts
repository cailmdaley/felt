import type { DocKey } from './documents.js'
import { parseRoute, type WorkspaceRoute } from './boardRoute.js'
import { DESK_VIEW, getView, viewOrDesk, viewTitle } from '../views/ViewRegistry.js'
import { FRAME_STEPS, LANDING_MS } from './DocumentBridge.js'

export { parseRoute, type WorkspaceRoute }

/** The reader's addresses live under `#/board/`; `#/board` itself is an old address of Channels. */
const BOARD_HASH = '#/board'
const STATE_KEY = 'shuttleWorkspace'
export { FRAME_STEPS, LANDING_MS }
/** The view a reader entry was opened from: `desk`, or a registered view's id. */
export type WorkspaceOriginView = string
/**
 * What a reader entry says about itself: whether the view it was opened from
 * is the entry below it, which view that is, and, for a page shown full
 * screen, the address of the page beneath it, which is the entry below.
 */
interface RouteState { layer: boolean; originView: WorkspaceOriginView; under?: string }
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
  if (!entry || typeof entry.layer !== 'boolean' || typeof entry.originView !== 'string' || !entry.originView) return null
  return { layer: entry.layer, originView: entry.originView, ...typeof entry.under === 'string' ? { under: entry.under } : {} }
}

function withRouteState(value: unknown, routeState: RouteState | null): StateObject {
  const state = stateObject(value)
  if (routeState) state[STATE_KEY] = routeState
  else delete state[STATE_KEY]
  return state
}

/**
 * Where back goes. The reader is one layer over the view it was opened
 * from, and back from any page the reader shows returns to that view, save
 * a page sent full screen, whose back returns to the page it was sent from.
 *
 * The layer holds one history entry, pushed directly above its view's when
 * the reader opens. Every move inside the reader (another constitution,
 * another page, a link, a scan) replaces that entry, so the address always
 * names what is shown while the history never grows. The reader's back,
 * Escape, the phone's swipe, the origin view's tab and the browser's own
 * back are therefore the same single step, save from full screen. A reader
 * address opened directly (a deep link, a typed URL with nothing of ours
 * below it) has no view entry below: leaving it replaces it with its view.
 *
 * Full screen (a file a page shows in place, sent to fill the reader) is
 * one entry more, above the page it was sent from: moves inside it replace
 * it, and back from it (the reader's, Escape, the phone's swipe, the
 * browser's) returns to that page; that page chosen from it is back too.
 * Leaving the reader from full screen (the view's tab, Channels' swipe,
 * another view) passes full screen's entry first, then leaves as from the
 * page beneath.
 *
 * Another view chosen from the reader replaces the reader's entry, so the
 * browser's back from there returns to the view the reader covered; the
 * view under the reader, chosen from it, is leaving. Dialogs over the reader
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
  /** The address of the page beneath the page shown full screen, the entry below; null when nothing is full screen. */
  private under: string | null = null
  /** A back this history asked for has not landed: anything asked meanwhile waits for it. */
  private leaving = false
  /** Leaving the reader from full screen: what is left to do once full screen's entry is passed. */
  private passing: (() => void) | null = null
  /** The address of full screen's page beneath, once a leave has passed it; the browser's second report of that landing (a hashchange after its popstate) is not where the leave lands. */
  private passed: string | null = null
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
  /** The page beneath the page shown full screen, where the reader's back goes; null when nothing is full screen. */
  get beneath(): Extract<WorkspaceRoute, { kind: 'channel' }> | null {
    const route = this.under ? parseRoute(this.under) : null
    return route?.kind === 'channel' ? route : null
  }

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
    this.under = saved?.under ?? null
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
    // The page beneath full screen, chosen from it, is back.
    if (hash === this.under) { this.back(); return }
    if (this.current?.kind === 'channel') {
      window.history.replaceState(withRouteState(window.history.state, this.routeState()), '', hash)
    } else {
      this.origin = viewOfHash(this.currentHash) ?? originView ?? this.origin
      this.layered = true
      this.under = null
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

  /**
   * A page of the constitution shown full screen, one entry above the page
   * on show, which back returns to. Asked from full screen, it takes full
   * screen's place.
   */
  full(doc: DocKey): void {
    if (this.leaving) { this.queued = () => this.full(doc); return }
    if (this.current?.kind !== 'channel') return
    if (this.under) { this.show(doc); return }
    const route: WorkspaceRoute = { kind: 'channel', uid: this.current.uid, owner: this.current.owner, doc }
    const hash = formatRoute(route)
    if (hash === this.currentHash) return
    // The page beneath says what it is (a deep link's says nothing yet), so a back that lands on it knows.
    window.history.replaceState(withRouteState(window.history.state, this.routeState()), '')
    this.under = this.currentHash
    window.history.pushState(withRouteState(null, this.routeState()), '', hash)
    this.current = route
    this.currentHash = hash
    this.onRoute(route, false)
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
    if (this.current?.kind === 'channel') { this.close(hash, false); return }
    window.history.pushState(null, '', hash)
    this.showView(hash)
  }

  /** A back that landed in a framed page's own history (a deck's slides): the back this history asked for goes on to the view. */
  framePopped(): void {
    if (this.leaving && ++this.steps <= FRAME_STEPS) this.pop()
  }

  /** The reader's back: from full screen, the page beneath it; from any other page, the view. */
  back(): void {
    const beneath = this.beneath
    if (this.current?.kind !== 'channel') return
    if (!beneath) { this.leave(); return }
    this.leaving = true
    this.steps = 0
    this.pop()
    this.current = beneath
    this.currentHash = this.under!
    this.under = null
    this.onRoute(beneath, false)
  }

  /** Leave the reader, from anywhere in it: its view, a step back; with no view below, its entry becomes the view. */
  leave(): void {
    if (this.leaving) { this.queued = () => this.leave(); return }
    if (this.current?.kind !== 'channel') return
    this.close(`#/${this.originView}`, this.layered)
  }

  /**
   * The reader gives way to the view at `hash`: its entry is popped onto the
   * view's below it (`pop`), or given the view's address. From full screen,
   * full screen's entry is passed first.
   */
  private close(hash: string, pop: boolean): void {
    const out = (): void => {
      if (pop) { this.pop(); return }
      window.history.replaceState(withRouteState(window.history.state, null), '', hash)
      if (this.leaving) this.handleLocation(window.history.state)
    }
    this.steps = 0
    if (this.under) {
      this.leaving = true
      this.passing = out
      this.pop()
    } else {
      this.leaving = pop
      out()
    }
    this.showView(hash)
  }

  private showView(hash: string): void {
    this.origin = viewOfHash(hash) ?? DESK_VIEW
    this.layered = false
    this.under = null
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
   * made, which reports nothing) goes on back while it still stands on full
   * screen's entry; past that, or past the steps, it is taken as landed: the
   * entry it stopped on names what the board shows (the view, or the page
   * beneath full screen), and what was asked meanwhile goes ahead.
   */
  private pop(): void {
    window.history.back()
    clearTimeout(this.landing)
    this.landing = window.setTimeout(() => {
      if (!this.leaving) return
      if (readRouteState(window.history.state)?.under && ++this.steps <= FRAME_STEPS) { this.pop(); return }
      this.passing = null
      window.history.replaceState(withRouteState(window.history.state, this.current?.kind === 'channel' ? this.routeState() : null), '', this.currentHash)
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
    this.passing = null
    this.passed = null
    this.queued = null
  }

  private ensureStarted(): void {
    if (!this.started) this.start()
  }

  private routeState(): RouteState {
    return { layer: this.layered, originView: this.origin, ...this.under ? { under: this.under } : {} }
  }

  /** An address that stands for another is replaced by it where it stands. */
  private redirect(address: (hash: string) => string): void {
    const hash = address(window.location.hash)
    if (hash !== window.location.hash) window.history.replaceState(window.history.state, '', hash)
  }

  /** The browser moved: through its own back or forward, a typed address, or a back this history asked for. */
  private handleLocation(state: unknown): void {
    this.redirect(settled)
    if (this.leaving && window.location.hash === this.passed) return
    clearTimeout(this.landing)
    // Leaving from full screen, the back landed on the page beneath it: on to the view.
    if (this.passing && this.leaving) {
      const pass = this.passing
      this.passing = null
      this.passed = window.location.hash
      pass()
      return
    }
    const hash = window.location.hash
    const queued = this.leaving ? this.queued : null
    this.leaving = false
    this.passed = null
    this.queued = null
    if (hash !== this.currentHash) this.land(hash, state)
    else this.know(state)
    queued?.()
  }

  /** Landed on an entry at the address already shown (a page and full screen over it can share one): what the entry says of itself holds. */
  private know(state: unknown): void {
    const saved = readRouteState(state)
    if (!saved || this.current?.kind !== 'channel') return
    this.layered = saved.layer
    this.origin = saved.originView
    this.under = saved.under ?? null
  }

  private land(hash: string, state: unknown): void {
    const route = parseRoute(hash)
    const saved = readRouteState(state)
    if (route?.kind === 'channel') {
      this.under = saved?.under ?? null
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
      this.under = null
      this.origin = viewOfHash(hash) ?? this.origin
      this.current = { kind: 'overview', hash }
    }
    this.currentHash = hash
    this.onRoute(this.current, false)
  }

  private readonly onPopState = (event: PopStateEvent): void => this.handleLocation(event.state)
  private readonly onHashChange = (): void => this.handleLocation(window.history.state)
}
