import { renderMarkdown, renderEmbeds } from './utils.js'
import type { ColumnKind, KanbanCard } from './KanbanTypes.js'
import { dispatchIneligibleReason, errorMessageFromResponse, isAgentCard } from './KanbanModalShared.js'
import { fetchFiberIndex, filterParentCandidates, type FiberSearchResult } from './fiberSearch.js'
import {
  attachPanelDrag,
  attachPanelResize,
  readPanelGeometry,
  animatePanelGeometry,
  type PanelGeometry,
} from './FloatingPanelChrome.js'
import { buildFileViewer, basenameOf, isScrollableFile } from './FileViewerPanel.js'
import { fileBytesUrl, showToast } from './utils.js'
import './FiberDetailModal.css'

/**
 * Panel geometry remembered across opens within a session — the reader who
 * dragged the page to the right edge to watch a fiber while working the
 * board gets the same placement on the next card. Cleared on reload.
 */
let lastGeometry: { left: number; top: number; width: number; height: number } | null = null

const MIN_WIDTH = 380
const MIN_HEIGHT = 320

/** Single-column reading width. The card panel opens here and keeps it — the
 *  file viewer is now its own floating window, so the card never grows.
 *  Mirrors the old default (≤950 / 92vw). */
const SINGLE_COL_WIDTH = 950

/**
 * Shared z-order stack for the two coexisting floating windows (the card panel
 * and the file viewer). Clicking either raises it above the other: a
 * `pointerdown` on a window bumps the counter and stamps the window's
 * `z-index`, so the last-touched window wins. Seeded above the vellum scrim
 * (9999) the way the panel's base CSS `z-index` was.
 */
let panelZ = 10000
function bringToFront(el: HTMLElement): void {
  el.style.zIndex = String(++panelZ)
}

function applyGeometryTo(el: HTMLElement, g: PanelGeometry): void {
  el.style.left = `${Math.max(0, g.left)}px`
  el.style.top = `${Math.max(0, g.top)}px`
  el.style.width = `${g.width}px`
  el.style.height = `${g.height}px`
}

/** A remembered geometry is usable only if it still lands on-screen (the
 *  viewport may have shrunk, or moved to a smaller display, since it was
 *  saved). Falls back to the default placement otherwise. */
function onScreen(g: PanelGeometry): boolean {
  return (
    g.left < window.innerWidth - 80 &&
    g.top < window.innerHeight - 80 &&
    g.left > 80 - g.width &&
    g.top > -20
  )
}

/** The half-and-half default arrangement: the card fills the left half of the
 *  viewport, the file viewer the right half, with a shared gutter. */
function halfAndHalf(): { card: PanelGeometry; viewer: PanelGeometry } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const gutter = 12
  const half = Math.floor((vw - 3 * gutter) / 2)
  const top = gutter
  const height = vh - 2 * gutter
  return {
    card: { left: gutter, top, width: half, height },
    viewer: { left: 2 * gutter + half, top, width: half, height },
  }
}

/**
 * One sent deliverable on a card's trail. `fullPath` is the absolute path the
 * `/api/v1/file` route reads; `sessionId` is the worker session that pushed it
 * (display-only).
 */
interface SentFile {
  fullPath: string
  basename: string
  timestamp: number
  sessionId?: string
}

/**
 * Per-card file-viewer UI state, persisted to localStorage under
 * `shuttle:detail:<uid>`. The `open` array is the stable tab order. Each entry
 * carries its per-file scroll offset + zoom to restore on rehydrate.
 */
interface DetailPersist {
  /** Full path of the active (front-most) tab — restored on reopen. */
  active?: string
  /** Remembered geometry of the two windows, so reopening a card restores the
   *  exact arrangement the reader left (not the half-and-half default). */
  cardGeom?: PanelGeometry
  viewerGeom?: PanelGeometry
  /**
   * `basename` is the file's display label as the trail provided it — which can
   * differ from the path tail in the disambiguation case (two distinct files
   * both literally named `report.html`, distinguished as
   * `standalone-kanban-report.html` vs `morning-post-report.html`). Persisting
   * it keeps the tab label stable across reload; legacy records without it fall
   * back to `basenameOf(path)`. `zoom` is the per-file Cmd-scroll magnification
   * (1 = native), `scroll` the last reading offset — both restored per tab.
   */
  open: Array<{ path: string; basename?: string; scroll: number; zoom?: number }>
}

/**
 * One open file in the right-column TABBED viewer. Owns its DOM: the `tab`
 * button in the tab strip and the full-bleed `cell` that renders the file
 * (only the active tab's cell is shown — the others stay built-but-hidden so
 * switching tabs preserves scroll, zoom, and iframe load state, browser-tab
 * style). Live state the persistence writer reads: `scroll` (last iframe/cell
 * reading offset) and `zoom` (Cmd-scroll magnification, 1 = native). The viewer
 * is built once, on first activation (`viewerBuilt`).
 */
interface OpenFileEntry {
  file: SentFile
  tab: HTMLElement
  cell: HTMLElement
  scroll: number
  zoom: number
  viewerBuilt: boolean
  /** The same-origin iframe, once built — the scroll-restore target. */
  iframe: HTMLIFrameElement | null
  /** The element zoom is applied to: an `<img>` (sized in px, base × zoom) or
   *  an iframe wrap (CSS `zoom`). */
  zoomTarget: HTMLElement | null
  /** Fit-width (px) of an image at zoom 1 — recaptured at zoom 1 so a resized
   *  column re-fits. Base for the explicit `width = baseW × zoom` that lets an
   *  image magnify PAST the column (a `width:100%`/`max-width` image can't). */
  baseW: number
}

const PERSIST_PREFIX = 'shuttle:detail:'

function loadPersist(uid: string): DetailPersist {
  if (!uid) return { open: [] }
  try {
    const raw = window.localStorage.getItem(PERSIST_PREFIX + uid)
    if (!raw) return { open: [] }
    const parsed = JSON.parse(raw) as DetailPersist
    return {
      active: parsed.active,
      cardGeom: parsed.cardGeom,
      viewerGeom: parsed.viewerGeom,
      open: Array.isArray(parsed.open) ? parsed.open : [],
    }
  } catch {
    return { open: [] }
  }
}

function savePersist(uid: string, state: DetailPersist): void {
  if (!uid) return
  try {
    // Keep the record while there are open tabs OR remembered window geometry
    // (so a card with no files still reopens its windows where the user left
    // them); drop it only when there's nothing to remember.
    if (state.open.length === 0 && !state.cardGeom && !state.viewerGeom) {
      window.localStorage.removeItem(PERSIST_PREFIX + uid)
    } else {
      window.localStorage.setItem(PERSIST_PREFIX + uid, JSON.stringify(state))
    }
  } catch {
    /* storage full / disabled — persistence is best-effort */
  }
}

/**
 * One entry of the daemon's `GET /api/v1/agents` registry. The axis metadata
 * (`effort_levels`, `default_effort`, `chrome_capable`) populates the agent
 * picker's effort options and chrome toggle without any hardcoded option list
 * in the frontend — the registry is the single source of truth. `alias_of` is
 * set on convenience records (e.g. `claude-opus-chrome`) that the base-agent
 * select filters out.
 */
interface AgentRecord {
  id: string
  model?: string
  default?: boolean
  effort_levels?: string[]
  default_effort?: string | null
  chrome_capable?: boolean
  cost_class?: string | null
  alias_of?: string | null
}

/**
 * FiberDetailModal — one click on a kanban card opens the fiber itself.
 *
 * A floating, draggable, edge-and-corner-resizable panel whose body is a
 * single-column page: outcome lede, then the markdown body. The standalone
 * UI emulates the vellum look in CSS rather than importing vellum's
 * `NarrativeView`/PretextProse stack — the body is rendered by the lean
 * `marked` renderer (`utils.renderMarkdown`) and styled to read like a
 * vellum page (`.kbn-detail-prose` in FiberDetailModal.css). The markdown
 * comes from the daemon's `GET /api/v1/fibers/<id>?body=true`, which reads the
 * daemon's stores including the git-synced `~/loom` mirror — so remote-host
 * fibers normally render here too; a fiber the local daemon can't read (not
 * synced to its mirror, or bodyless) degrades to its outcome, which the
 * composite feed always carries. `:::{embed}` artifacts and relative images render through the
 * daemon's owner-routed `/file` route, anchored on the fiber's own dir.
 *
 * Every card action lives in one dropdown directly under the title,
 * collapsed by default: directive box + "wait for me", New session /
 * Resume, Temper / Compost, agent / kind / schedule, tags, parent fiber,
 * and the drill-out to the full workspace.
 *
 * Deliberately NOT a Radix AppDialog and NOT background-locked: the panel
 * is non-modal by design — "drag it aside to keep an eye on one fiber
 * while working the board" requires the kanban behind it to stay
 * interactive, so there is no scrim, no focus trap, no body-inert. This is
 * the documented exception to the new-modal invariant. Escape still
 * closes; only one instance is open at a time. The root keeps the
 * `.kbn-detail-overlay` class so Camera's wheel-exemption `closest()`
 * list keeps routing wheel events to the panel instead of zooming the map.
 *
 * Lifecycle: `open(card)` mounts the panel; `close()` tears it down
 * (including the React root inside the page pane).
 */
export class FiberDetailModal {
  private overlay: HTMLElement | null = null
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null
  private outsideHandler: ((e: PointerEvent) => void) | null = null
  private searchDebounce: number | null = null
  /** ResizeObservers watching full-length HTML embeds so they re-fit their
   *  height when the panel reflows their content (see autosizeEmbeds).
   *  Disconnected on close so a re-opened panel never leaks observers. */
  private embedObservers: ResizeObserver[] = []
  /** Shuttle daemon base (`:4000`). Every verb routes here — transition,
   *  dispatch (carrying user_message + resume_mode inline), felt-edit,
   *  lifecycle, felt-nest — owner-routed by the card's `originId` carried as
   *  `origin` in the body. Reads (agent registry, parent-picker fiber index)
   *  hit the daemon's GET routes. Portolan's `:4004` no longer serves the
   *  kanban at all. */
  private readonly shuttleBase: string
  /** Map a card's `cityId` to the city's project directory — the
   *  `project_dir` a shuttle install needs (worker cwd). Wired from the
   *  parent kanban's pinned-city roots; absent in tests/embeds, where
   *  promotion installs without a project dir (valid for paused drafts). */
  private readonly resolveCityProjectPath?: (cityId: string) => string | undefined
  /** Parent-picker index: one `GET /api/v1/fibers` per panel-open, filtered
   *  client-side per keystroke. Cleared on close. */
  private fiberIndex: Promise<Array<{ id: string; name: string }>> | null = null
  /** Monotonic guard so only the latest searchParents call renders the
   *  dropdown — see the comment inside searchParents. */
  private searchRenderToken = 0
  private readonly onSaved: () => void
  private readonly onAttachFreshTmux?: (tmuxSessionName: string) => void
  /** Focus an already-running worker's kitty tab. Wired from the parent
   *  kanban's onOpenWorker; drives the status pill's double-click. */
  private readonly onOpenWorker?: (tmuxSessionName: string, shuttleHost?: string) => void
  /**
   * Terminal-move delegate. When wired, Temper / Compost close the panel
   * immediately and hand the move to the parent kanban's optimistic
   * transition path (instant card relocation + background commit + banner
   * on failure) instead of blocking on an in-panel fetch. Absent → the
   * legacy in-panel `runTransition` fetch runs.
   */
  private readonly onTransition?: (card: KanbanCard, target: ColumnKind) => void
  // ── Two-column file viewer state (the right column) ─────────────────────
  /** The card the panel is currently showing — every accordion action
   *  (open/close/expand/scroll) keys its persistence off `card.uid`. */
  private card: KanbanCard | null = null
  /** The full sent-files trail (newest-first), fetched once per panel-open.
   *  The left-column launcher renders from this. */
  private sentFiles: SentFile[] = []
  /** Open files in stable open-order (the tab order — tabs don't reorder on
   *  click, browser-style). Each entry owns its tab + view cell + live
   *  scroll/zoom state; this is the authority the persistence writer
   *  serializes. The active tab is tracked separately by `activePath`. */
  private openFiles: OpenFileEntry[] = []
  /** Full path of the active (shown) file, or null. The active tab's cell is
   *  visible; every other open cell stays built-but-hidden. */
  private activePath: string | null = null
  /** The viewer window's views host (holds every open file's cell; only the
   *  active one is shown). Null while no file is open. */
  private rightCol: HTMLElement | null = null
  /** The viewer window's tab strip (one tab per open file). Null while closed. */
  private tabStrip: HTMLElement | null = null
  /** The separate floating file-viewer window (its own document.body overlay,
   *  draggable + resizable independently of the card). Null until the first
   *  file opens; nulled when the last tab closes or its ✕ is clicked. */
  private viewerWindow: HTMLElement | null = null
  /** Remembered viewer-window geometry for THIS card: loaded from persistence
   *  on open, updated on the window's drag/resize settle, captured before the
   *  window closes. Drives "reopen where you left it" vs the half-and-half
   *  default. Null = no remembered placement yet (use the default). */
  private viewerGeom: PanelGeometry | null = null
  /** Remembered CARD-window geometry for this card (mirror of viewerGeom):
   *  the INTENDED geometry (default / restored / half-and-half / dragged), never
   *  a mid-animation read, so the persisted arrangement is exact. */
  private cardGeom: PanelGeometry | null = null
  /** Debounce handle for scroll-position persistence writes. */
  private scrollWriteTimer: number | null = null

  constructor(
    shuttleBase: string,
    // Accepted for positional signature compatibility with KanbanModal's call
    // (and Portolan's panel), but unused in the standalone UI: there's no full
    // workspace to "open elsewhere" — the panel itself is the fiber view.
    _onOpenFiber: (card: KanbanCard, options?: { openInNewWindow?: boolean }) => void,
    onSaved: () => void,
    onAttachFreshTmux?: (tmuxSessionName: string) => void,
    onTransition?: (card: KanbanCard, target: ColumnKind) => void,
    onOpenWorker?: (tmuxSessionName: string, shuttleHost?: string) => void,
    resolveCityProjectPath?: (cityId: string) => string | undefined,
    // `portolanBase` is still accepted in the options bag for call-site
    // signature compatibility, but the standalone UI no longer talks to
    // Portolan's retired `:4004` — sent files and bytes both route through the
    // shuttle daemon (`shuttleBase`).
    opts?: { onOpenFile?: (fullPath: string, originId: string) => void; portolanBase?: string },
  ) {
    this.shuttleBase = shuttleBase
    this.resolveCityProjectPath = resolveCityProjectPath
    this.onSaved = onSaved
    this.onAttachFreshTmux = onAttachFreshTmux
    this.onTransition = onTransition
    this.onOpenWorker = onOpenWorker
    // `opts.onOpenFile` / `opts.portolanBase` are accepted for call-site
    // signature compatibility (Portolan's full file workspace, the retired
    // :4004 base) but unused — the standalone UI opens files in its own
    // right-column accordion, all bytes via the shuttle daemon.
    void opts
  }

  /**
   * @param card the card the user clicked
   * @param scopeCityId  the cityId the parent kanban view is scoped to
   *   (`undefined` for the global kanban). Drives the vellum content fetch
   *   only — card ids are loom-relative everywhere (the composite feed),
   *   and every write is owner-routed by `card.originId`, so no endpoint
   *   needs city-scoped URL routing anymore.
   */
  open(card: KanbanCard, scopeCityId?: string | null, _columnKind?: ColumnKind): void {
    // Tear down any existing open panel first (rapid re-click).
    this.close()

    // ── Panel root ──────────────────────────────────────────────────────────
    // Non-modal floating panel (see class docstring). role="dialog" without
    // aria-modal: the board behind stays in the a11y tree on purpose.
    const overlay = document.createElement('div')
    overlay.className = 'kbn-detail-overlay'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-label', `Fiber: ${card.name}`)
    this.applyGeometry(overlay)

    // ── Header (drag handle) ────────────────────────────────────────────────
    const header = document.createElement('div')
    header.className = 'kbn-detail-header'

    // The title is plain identification text + the drag handle. In the
    // standalone UI the panel *is* the fiber view, so there is no "drill out
    // to the full workspace" target — the click-to-open-elsewhere affordance
    // Portolan's title carried is dropped.
    const title = document.createElement('div')
    title.className = 'kbn-detail-title'
    title.textContent = card.name

    // Bind the card + load its persisted viewer state. The launcher and tabbed
    // viewer read these; the persistence writer keys off `card.uid`.
    this.card = card
    this.openFiles = []
    this.activePath = null
    this.sentFiles = []
    const persist = loadPersist(typeof card.uid === 'string' ? card.uid : '')
    // Restore this card's remembered window arrangement: the card to its saved
    // spot (overriding the session default applyGeometry just set), and stash
    // the viewer geometry for openViewerWindow to restore instead of the
    // half-and-half default.
    this.viewerGeom = persist.viewerGeom ?? null
    if (persist.cardGeom && onScreen(persist.cardGeom)) {
      applyGeometryTo(overlay, persist.cardGeom)
      this.cardGeom = persist.cardGeom
    }

    const pill = document.createElement('span')
    pill.className = `kbn-pill kbn-pill-${card.status === 'closed' ? 'closed' : card.status === 'active' ? 'active' : 'open'}`
    pill.textContent = card.status || 'open'

    // Worker aloft → the same teal ▸ aloft pill the grid card wears, same
    // class, same gesture: click opens the worker's tmux session in kitty.
    let aloftPill: HTMLButtonElement | null = null
    if (card.runningWorker && this.onOpenWorker) {
      const tmuxName = card.runningWorker
      aloftPill = document.createElement('button')
      aloftPill.type = 'button'
      aloftPill.className = 'kbn-card-worker kbn-detail-aloft'
      aloftPill.setAttribute('aria-label', `Open worker terminal: ${tmuxName}`)
      aloftPill.title = `Worker aloft — click to open ${tmuxName} in kitty`
      aloftPill.textContent = '▸ aloft'
      aloftPill.addEventListener('click', (e) => {
        e.stopPropagation()
        this.onOpenWorker?.(tmuxName, card.shuttleHost)
      })
    }

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'kbn-detail-close'
    closeBtn.setAttribute('aria-label', 'Close fiber detail')
    closeBtn.textContent = '×'
    closeBtn.addEventListener('click', () => this.close())

    // ID breadcrumb under the title — plain identification text; the title
    // above carries the click-to-vellum affordance.
    const idEl = document.createElement('div')
    idEl.className = 'kbn-detail-id'
    idEl.textContent = card.id

    const titleStack = document.createElement('div')
    titleStack.className = 'kbn-detail-title-stack'
    titleStack.append(title, idEl)
    if (aloftPill) header.append(titleStack, aloftPill, pill, closeBtn)
    else header.append(titleStack, pill, closeBtn)
    this.attachDrag(overlay, header)

    // ── Controls dropdown ───────────────────────────────────────────────────
    // One cluster, directly under the title, collapsed by default. Expanded
    // it holds the directive entry and every action the card supports.
    const scope = scopeCityId ?? undefined
    const shuttleManaged = isAgentCard(card)
    const controls = this.buildControls(card, scope, shuttleManaged)

    // ── Fiber body pane ─────────────────────────────────────────────────────
    // The fiber itself: outcome lede, then the markdown body, rendered by the
    // lean `marked` renderer and styled to read like a vellum page (see the
    // class docstring). Fetched async so the grid path pays nothing until a
    // card is opened; a remote fiber (whose body the local daemon can't read)
    // degrades to its outcome.
    const page = document.createElement('div')
    page.className = 'kbn-detail-page kbn-detail-page-headerless'
    const prose = document.createElement('article')
    prose.className = 'kbn-detail-prose'
    prose.innerHTML = '<p class="kbn-detail-prose-loading">Loading…</p>'
    page.append(prose)
    void this.renderFiberBody(prose, card, overlay)

    // ── Sent-files launcher ──────────────────────────────────────────────────
    // The deliverable trail: files the card's worker sessions pushed via
    // SendUserFile, newest first. Mounts empty and self-populates from the
    // daemon's /sent-files (events.jsonl fallback for older daemons). Clicking
    // an entry opens it in the separate file-viewer window (creating that
    // window on first open). Empty trail → the launcher never reveals itself.
    const launcher = this.buildSentFilesLauncher(card)

    // ── Assemble: a single reading column ────────────────────────────────────
    // The card panel is one flex column again — header, controls, launcher,
    // body. The file viewer is a SEPARATE floating window (openViewerWindow),
    // so the card keeps its own size and never grows.
    overlay.append(header, controls, launcher, page)
    this.attachResizeHandles(overlay)
    // Clicking anywhere on the card raises it above the viewer window. Capture
    // phase so a click on an inner control still bumps z-order first.
    overlay.addEventListener('pointerdown', () => bringToFront(overlay), true)
    bringToFront(overlay)
    document.body.append(overlay)
    this.overlay = overlay

    // Rehydrate the viewer window from persisted state, once the launcher's
    // trail is known. The launcher fetch resolves it async; rehydration that
    // needs a basename falls back to deriving it from the path.
    this.rehydrateOpenFiles(card, persist)

    // Escape to close the panel. When the parent-fiber dropdown is open and
    // focus is inside it, yield to the dropdown's own keydown listener so it
    // can close just the dropdown (not the whole panel).
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.activeElement?.closest('.kbn-detail-parent-dropdown')) return
      this.close()
    }
    document.addEventListener('keydown', this.escapeHandler, true)

    // Click-away closes the panel. pointerdown (not click) so the gesture
    // that opened the panel — whose pointerdown happened before this
    // listener existed — can never self-close it. The event is left to
    // propagate, so the outside click still does its own work (open a
    // different card, drag on the board, …).
    this.outsideHandler = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (target && overlay.contains(target)) return
      // The file-viewer window is a sibling floating window, not "outside" the
      // card in the user's mental model — clicking it focuses it (raises it),
      // it must NOT close the card. Both windows coexist; only a click truly
      // away from both closes the card (which then closes its viewer too).
      if (target instanceof Element && target.closest('.kbn-fileview-window')) return
      this.close()
    }
    document.addEventListener('pointerdown', this.outsideHandler, true)
  }

  close(): void {
    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler, true)
      this.escapeHandler = null
    }
    if (this.outsideHandler) {
      document.removeEventListener('pointerdown', this.outsideHandler, true)
      this.outsideHandler = null
    }
    if (this.searchDebounce !== null) {
      window.clearTimeout(this.searchDebounce)
      this.searchDebounce = null
    }
    // Flush any pending debounced scroll write before tearing down — the
    // user's last reading position must persist even on a quick close.
    if (this.scrollWriteTimer !== null) {
      window.clearTimeout(this.scrollWriteTimer)
      this.scrollWriteTimer = null
      this.writePersist()
    }
    this.fiberIndex = null
    for (const ro of this.embedObservers) ro.disconnect()
    this.embedObservers = []
    // Closing the card closes its file-viewer window too — the two windows are
    // a pair bound to one card. (closeViewerWindow nulls the viewer refs.)
    this.viewerWindow?.remove()
    this.viewerWindow = null
    this.overlay?.remove()
    this.overlay = null
    // Viewer state is durable (localStorage) — clear only the live DOM refs so
    // a re-open rebuilds cleanly.
    this.card = null
    this.sentFiles = []
    this.openFiles = []
    this.activePath = null
    this.rightCol = null
    this.tabStrip = null
  }

  /**
   * Fetch the fiber's markdown body from the daemon and render it into the
   * page pane, styled to read like a vellum page. The body endpoint
   * (`GET /api/v1/fibers/<id>?body=true`) reads from THIS daemon's configured
   * felt stores — which include the git-synced `~/loom` mirror, so a remote
   * host's fibers normally resolve here too (the mirror carries every synced
   * project's body). It degrades to the outcome only when the fiber isn't in
   * this daemon's mirror (e.g. not synced yet) or genuinely has no body.
   * `:::{embed}` artifacts and relative images resolve through the daemon's
   * `/file` route, anchored on the fiber's dir (`card.fiberDir`); an
   * unresolvable path falls back to a placeholder.
   */
  private async renderFiberBody(
    prose: HTMLElement,
    card: KanbanCard,
    overlay: HTMLElement,
  ): Promise<void> {
    // Render the outcome (the card already carries it) IMMEDIATELY, so the
    // panel is never blank: the daemon's body read (`?body=true`) can take
    // several seconds under poll-load, and a bare "Loading…" reads as broken.
    // The body then fills in below the lede, or degrades to a clear note.
    const outcome = (card.outcome ?? '').trim()
    const lede = outcome
      ? `<div class="kbn-detail-lede">${renderMarkdown(outcome)}</div>`
      : ''
    prose.innerHTML = lede + '<p class="kbn-detail-body-status">loading body…</p>'

    let body = ''
    let found = false
    let reached = false
    try {
      const idPath = card.id.split('/').map(encodeURIComponent).join('/')
      // Carry the owning origin so the daemon owner-routes the read to the host
      // that can actually read the fiber (over the SSH tunnel), exactly like
      // every write and the /file bytes route. A remote fiber's body is fetched
      // FROM the remote, never from a git mirror — git sync is never relied on.
      const origin = encodeURIComponent(card.originId ?? '')
      const ctrl = new AbortController()
      const timer = window.setTimeout(() => ctrl.abort(), 25000)
      const res = await fetch(
        `${this.shuttleBase}/api/v1/fibers/${idPath}?body=true&origin=${origin}`,
        { signal: ctrl.signal },
      )
      window.clearTimeout(timer)
      if (res.ok) {
        const data = (await res.json()) as {
          fibers?: Array<{ fiber?: { body?: string } }>
        }
        // An empty `fibers` array means the daemon answered but the id isn't in
        // its mirror (vs. found-but-bodyless); the note below distinguishes them.
        found = (data.fibers?.length ?? 0) > 0
        body = (data.fibers?.[0]?.fiber?.body ?? '').trim()
        reached = true
      }
    } catch {
      // abort / timeout / network — `reached` stays false.
    }
    // The panel may have closed (or been replaced) while we awaited.
    if (this.overlay !== overlay) return

    if (body) {
      // Resolve a relative `:::{embed}` / image against the fiber's own dir
      // (carried on the card from the composite feed) and route the bytes
      // through `/file`. A fiber whose dir didn't resolve degrades to embed
      // placeholders + un-rewritten images, but the prose still reads.
      const bodyOpts = { basePath: card.fiberDir, originId: card.originId }
      prose.innerHTML = lede + renderMarkdown(renderEmbeds(body, bodyOpts), bodyOpts)
      this.autosizeEmbeds(prose)
      return
    }
    if (!outcome && reached && found) {
      prose.classList.add('kbn-detail-prose-empty')
      prose.textContent = 'No body or outcome yet.'
      return
    }
    // No body. Three honest cases — remote bodies normally resolve here via the
    // synced loom mirror, so this is "nothing to show" or "not synced", never a
    // cross-host rendering gap:
    //   reached + found      → the fiber simply has no markdown body.
    //   reached + not found  → not in this daemon's mirror (e.g. not synced yet).
    //   not reached          → the read failed/timed out; offer a retry.
    const note = !reached
      ? 'Couldn’t load the body — the daemon was slow to respond. <button type="button" class="kbn-detail-body-retry">retry</button>'
      : found
        ? 'No body yet — the outcome above is the headline.'
        : 'This fiber isn’t in the local mirror yet (not synced here) — the outcome above is the headline. <button type="button" class="kbn-detail-body-retry">retry</button>'
    prose.innerHTML = lede + `<p class="kbn-detail-prose-note">${note}</p>`
    if (note.includes('kbn-detail-body-retry')) {
      prose.querySelector('.kbn-detail-body-retry')?.addEventListener('click', () => {
        void this.renderFiberBody(prose, card, overlay)
      })
    }
  }

  /**
   * Size full-length HTML embeds (`iframe[data-autosize]`, emitted by
   * utils.embedHtml for an HTML `:::{embed}` with no pinned `:height:`) so they
   * read as part of the page — one scroll column, no nested scrollbar. The
   * iframe is same-origin (the daemon's `/file` route), so its document is
   * readable. Two regimes:
   *
   *   - **reveal.js deck** (a `slides.html` from the slides skill) — a deck has
   *     fixed NATIVE slide dimensions and scales to fill whatever box it's given,
   *     so content-height measurement collapses it to a stub. Instead size by the
   *     deck's own aspect ratio (`Reveal.getConfig()` width/height): height =
   *     container-width × (slideH / slideW). The deck then shows at native
   *     proportions and grows taller as the panel widens.
   *   - **ordinary HTML** (report.html and friends) — grow to the content's
   *     scrollHeight so the whole document reads inline.
   *
   * A ResizeObserver on both the container (width-driven, for the deck) and the
   * body (content-driven, for ordinary HTML) re-fits on any panel resize. A
   * cross-origin or unreadable doc silently keeps the CSS min-height.
   */
  private autosizeEmbeds(prose: HTMLElement): void {
    const frames = prose.querySelectorAll<HTMLIFrameElement>('iframe[data-autosize]')
    frames.forEach((iframe) => {
      // reveal.js deck → size by native slide aspect ratio. Returns false when
      // the frame isn't a (ready) reveal deck, so `fit` falls back to content
      // height. `getConfig` may not exist until the deck's async init runs —
      // hence the retries scheduled on load.
      const fitReveal = (): boolean => {
        const win = iframe.contentWindow as unknown as {
          Reveal?: { getConfig?: () => { width?: number; height?: number } }
        } | null
        const cfg = win?.Reveal?.getConfig?.()
        const sw = Number(cfg?.width)
        const sh = Number(cfg?.height)
        if (!(sw > 0) || !(sh > 0)) return false
        const w = (iframe.parentElement ?? iframe).clientWidth
        if (!(w > 0)) return false
        iframe.style.height = `${Math.round((w * sh) / sw)}px`
        return true
      }
      const fitContent = () => {
        const doc = iframe.contentDocument
        if (!doc) return
        const h = Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0)
        if (h > 0) iframe.style.height = `${h}px`
      }
      const fit = () => {
        try {
          if (!fitReveal()) fitContent()
        } catch {
          /* cross-origin / unreadable — leave the CSS min-height in place */
        }
      }
      iframe.addEventListener('load', () => {
        fit()
        // Late reveal init: getConfig can lag the load event; re-fit a few times.
        ;[120, 400, 1200].forEach((ms) => window.setTimeout(fit, ms))
        try {
          if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => fit())
            // Container width drives the deck; body size drives ordinary HTML.
            if (iframe.parentElement) ro.observe(iframe.parentElement)
            const body = iframe.contentDocument?.body
            if (body) ro.observe(body)
            this.embedObservers.push(ro)
          }
        } catch {
          /* ignore — observation is best-effort */
        }
      })
      // A cached doc may have finished loading before the listener attached.
      try {
        if (iframe.contentDocument?.readyState === 'complete') fit()
      } catch {
        /* ignore */
      }
    })
  }

  // ── Panel geometry: default + remembered, drag, resize ────────────────────

  /** Default size: a reading column at nearly full viewport height — the
   *  page wants vertical room; width stays a comfortable measure. The card
   *  panel opens at this width and keeps it (the file viewer is its own
   *  window); remembered geometry wins when it still fits the viewport. */
  private applyGeometry(overlay: HTMLElement): void {
    const vw = window.innerWidth
    const vh = window.innerHeight
    let g = lastGeometry
    if (g && (g.left > vw - 80 || g.top > vh - 80)) g = null
    const width = g?.width ?? Math.min(SINGLE_COL_WIDTH, Math.round(vw * 0.92))
    const height = g?.height ?? vh - 24
    const left = g?.left ?? Math.round((vw - width) / 2)
    const top = g?.top ?? Math.round((vh - height) / 2)
    const geom = { left: Math.max(0, left), top: Math.max(0, top), width, height }
    applyGeometryTo(overlay, geom)
    // Track the intended geometry (not a mid-animation offset read) so the
    // persisted card placement is exact.
    this.cardGeom = geom
  }

  private rememberGeometry(overlay: HTMLElement): void {
    lastGeometry = readPanelGeometry(overlay)
    this.cardGeom = lastGeometry
    // Persist the card window's placement for this card so reopening restores
    // it (alongside the viewer geometry written on the viewer's settle).
    this.writePersist()
  }

  // ── The file-viewer window: open / close ─────────────────────────────────

  /**
   * Create the separate floating file-viewer window the first time a file is
   * opened. Idempotent — a second file opening into the already-open window
   * just adds a tab. The window is a sibling to the card (its own document.body
   * overlay), independently draggable + resizable, and can overlap the card.
   * It reuses the card's vellum frame (`.kbn-detail-overlay`) with a modifier
   * (`.kbn-fileview-window`) that lays it out as a flex column: a slim
   * manuscript drag bar, the tab strip, then the full-bleed views.
   */
  private openViewerWindow(): void {
    if (this.viewerWindow || !this.overlay) return
    const card = this.overlay

    const win = document.createElement('div')
    win.className = 'kbn-detail-overlay kbn-fileview-window'
    win.setAttribute('role', 'dialog')
    win.setAttribute('aria-label', 'Sent files')

    // ── Chrome bar: the tab strip IS the window chrome ──
    // No separate title bar — the tabs are the titles, and the bar itself is
    // the drag handle (empty areas drag; the tab/✕ buttons opt out of drag).
    // A trailing ✕, pinned right of the horizontally-scrolling tabs, closes the
    // whole viewer (every file) at once; the card stays.
    const bar = document.createElement('div')
    bar.className = 'kbn-fileview-bar'

    const tabs = document.createElement('div')
    tabs.className = 'kbn-detail-tabstrip'
    tabs.setAttribute('role', 'tablist')
    this.tabStrip = tabs

    // Download the active file to ~/Downloads — restores the save affordance the
    // retired Portolan `:4004` route carried (⤓). Pinned right of the tabs, left
    // of the close-all ✕; acts on whichever tab is active.
    const winDownload = document.createElement('button')
    winDownload.type = 'button'
    winDownload.className = 'kbn-fileview-win-download'
    winDownload.setAttribute('aria-label', 'Download file')
    winDownload.title = 'Download to ~/Downloads'
    winDownload.textContent = '⤓'
    winDownload.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.downloadActiveFile()
    })

    const winClose = document.createElement('button')
    winClose.type = 'button'
    winClose.className = 'kbn-fileview-win-close'
    winClose.setAttribute('aria-label', 'Close file viewer')
    winClose.title = 'Close all files'
    winClose.textContent = '×'
    winClose.addEventListener('click', (e) => {
      e.stopPropagation()
      this.closeViewerWindow()
      this.writePersist()
    })

    bar.append(tabs, winDownload, winClose)

    const views = document.createElement('div')
    views.className = 'kbn-detail-views'
    this.rightCol = views

    // Cmd/Ctrl + wheel zooms the active file (images, HTML, PDF — everything).
    views.addEventListener('wheel', (e) => this.handleZoomWheel(e), { passive: false })

    win.append(bar, views)

    // ── Geometry ──
    // Remembered placement for this card wins; otherwise the default is
    // half-and-half — the card glides to the left half, the viewer takes the
    // right half. Once placed, the viewer geometry is remembered (settle +
    // close) so the next open restores it instead of re-splitting.
    if (this.viewerGeom && onScreen(this.viewerGeom)) {
      applyGeometryTo(win, this.viewerGeom)
    } else {
      const { card: cardG, viewer: viewerG } = halfAndHalf()
      animatePanelGeometry(card, cardG)
      lastGeometry = cardG
      this.cardGeom = cardG
      applyGeometryTo(win, viewerG)
      this.viewerGeom = viewerG
    }
    // Persist the new arrangement (half-and-half or restored) immediately.
    this.writePersist()

    const rememberViewer = () => {
      this.viewerGeom = readPanelGeometry(win)
      this.writePersist()
    }
    // Drag (header bar) + resize (eight edge/corner zones) — independent of
    // the card, reusing the same chrome helpers + handle CSS. Both remember the
    // window's new geometry for this card.
    attachPanelDrag(win, bar, { draggingClass: 'kbn-detail-dragging', onSettle: rememberViewer })
    attachPanelResize(win, {
      handleClassPrefix: 'kbn-detail-rh',
      resizingClass: 'kbn-detail-resizing',
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      onSettle: rememberViewer,
    })
    // Clicking anywhere on the viewer raises it above the card.
    win.addEventListener('pointerdown', () => bringToFront(win), true)

    this.viewerWindow = win
    document.body.append(win)
    bringToFront(win)
  }

  /** Tear down the file-viewer window: all tabs/cells die with it, the card
   *  stays open. Fires when the last tab closes OR the window's ✕ is clicked
   *  (the ✕ closes every open file at once). */
  private closeViewerWindow(): void {
    // Remember where the window sat so reopening this card restores it (not the
    // half-and-half default).
    if (this.viewerWindow) this.viewerGeom = readPanelGeometry(this.viewerWindow)
    this.viewerWindow?.remove()
    this.viewerWindow = null
    this.rightCol = null
    this.tabStrip = null
    // The tabs + cells lived inside the window; the live open-file set dies
    // with it. (Persisted state is durable — written by callers.)
    this.openFiles = []
    this.activePath = null
    this.syncLauncherActiveState()
  }

  /** Download the active tab's file to the browser's download folder
   *  (`~/Downloads` by default). The daemon's `/api/v1/file` route serves bytes
   *  inline (no `Content-Disposition`), so we fetch them as a blob and trigger a
   *  same-origin object-URL download — that way the chosen filename is always
   *  honoured whether the bundle is daemon-served (same-origin) or dev-served
   *  (cross-origin against `:4000`). Owner-routed by the card's `originId`, so a
   *  remote-owned deliverable downloads through the same proxy the viewer uses. */
  private async downloadActiveFile(): Promise<void> {
    const entry = this.openFiles.find((e) => e.file.fullPath === this.activePath)
    if (!entry || !this.card) return
    const fullPath = entry.file.fullPath
    const filename = basenameOf(fullPath)
    const url = fileBytesUrl(this.shuttleBase, fullPath, this.card.originId)
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const objUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objUrl
      a.download = filename
      document.body.append(a)
      a.click()
      a.remove()
      // Defer the revoke past this tick: `a.click()` only *initiates* the
      // download — the browser reads the blob from the object URL after the
      // handler returns, so revoking synchronously races (and can zero-byte) a
      // large download. Same "let the browser finish first" setTimeout(0)
      // deferral used elsewhere on the board.
      window.setTimeout(() => URL.revokeObjectURL(objUrl), 0)
    } catch {
      showToast(`Couldn't download ${filename}`, 'error')
    }
  }

  /** Header-strip drag. Plain pointer drag — the header is dedicated chrome,
   *  so no modifier gate is needed (the Cmd-gate lesson from the pin-card
   *  prototype applies to chrome-less surfaces where drag fights text
   *  selection; a title bar doesn't). Buttons and form fields opt out. */
  private attachDrag(overlay: HTMLElement, handle: HTMLElement): void {
    attachPanelDrag(overlay, handle, {
      draggingClass: 'kbn-detail-dragging',
      onSettle: () => this.rememberGeometry(overlay),
    })
  }

  /** Eight invisible resize zones on the edges and corners. Pointer-based,
   *  same lifecycle as drag; min size keeps the header + dropdown usable. */
  private attachResizeHandles(overlay: HTMLElement): void {
    attachPanelResize(overlay, {
      handleClassPrefix: 'kbn-detail-rh',
      resizingClass: 'kbn-detail-resizing',
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      onSettle: () => this.rememberGeometry(overlay),
    })
  }

  // ── Controls dropdown ───────────────────────────────────────────────────

  /**
   * The one cluster holding every card action. Collapsed: a slim toggle row
   * with at-a-glance worker chips. Expanded: directive + dispatch actions,
   * review moves, worker config (agent / kind / schedule), tags, parent,
   * and the drill-out to the full workspace.
   */
  private buildControls(
    card: KanbanCard,
    scope: string | undefined,
    shuttleManaged: boolean,
  ): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'kbn-detail-controls'

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'kbn-detail-controls-toggle'
    toggle.setAttribute('aria-expanded', 'false')

    const chevron = document.createElement('span')
    chevron.className = 'kbn-detail-controls-chevron'
    chevron.setAttribute('aria-hidden', 'true')
    chevron.textContent = '▸'

    const toggleLabel = document.createElement('span')
    toggleLabel.className = 'kbn-detail-controls-label'
    toggleLabel.textContent = 'Actions'

    const summary = document.createElement('span')
    summary.className = 'kbn-detail-controls-summary'
    const chips: string[] = []
    if (card.shuttleAgent) chips.push(card.shuttleAgent)
    if (card.shuttleKind === 'standing' && card.shuttleSchedule) chips.push(card.shuttleSchedule)
    else if (card.shuttleKind) chips.push(card.shuttleKind)
    if (card.shuttleHost) chips.push(card.shuttleHost)
    const projectDir = this.projectDirFor(card)
    if (projectDir) {
      // Home-relativize for the chip (~/dev/shuttle); full path on hover.
      chips.push(projectDir.replace(/^\/(?:Users|home)\/[^/]+\//, '~/'))
      summary.title = projectDir
    }
    summary.textContent = chips.join(' · ')

    toggle.append(chevron, toggleLabel, summary)

    const body = document.createElement('div')
    body.className = 'kbn-detail-controls-body'
    body.hidden = true

    toggle.addEventListener('click', (e) => {
      e.stopPropagation()
      const expanded = body.hidden
      body.hidden = !expanded
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false')
      chevron.textContent = expanded ? '▾' : '▸'
      wrap.classList.toggle('kbn-detail-controls-open', expanded)
    })

    wrap.append(toggle, body)
    this.buildControlsBody(body, card, scope, shuttleManaged)
    return wrap
  }

  private buildControlsBody(
    body: HTMLElement,
    card: KanbanCard,
    scope: string | undefined,
    shuttleManaged: boolean,
  ): void {
    // ── Next dispatch (message + action buttons) ──────────────────────────
    // One canonical surface for "what happens when this fiber dispatches
    // next." The message textarea is the optional payload, carried inline on
    // the dispatch call (`user_message`); "talk to me first" intent rides the
    // directive text, prepended via the one-click "Wait for me" affordance.
    const actionsSec = this.buildSection(shuttleManaged ? 'Next dispatch' : 'Actions')
    const actionsErr = document.createElement('div')
    actionsErr.className = 'kbn-detail-error'
    actionsErr.style.display = 'none'

    const messageTa = document.createElement('textarea')
    messageTa.className = 'kbn-detail-directive'
    messageTa.placeholder = 'Message for the next worker (optional)…'
    messageTa.rows = 3
    messageTa.setAttribute('aria-label', 'Message for next worker')
    messageTa.addEventListener('mousedown', (e) => e.stopPropagation())
    messageTa.addEventListener('click', (e) => e.stopPropagation())

    const WAIT_FOR_ME_LINE = "Wait for me before doing anything heavy — let's talk first.\n\n"
    const waitBtn = document.createElement('button')
    waitBtn.type = 'button'
    waitBtn.className = 'kbn-detail-wait-btn'
    waitBtn.textContent = '⏸ Wait for me'
    waitBtn.title = 'Prepend a "talk first" line to the message so the worker checks in before doing heavy work.'
    waitBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (!messageTa.value.startsWith(WAIT_FOR_ME_LINE)) {
        messageTa.value = WAIT_FOR_ME_LINE + messageTa.value
      }
      messageTa.focus()
    })

    const actionsRow = document.createElement('div')
    actionsRow.className = 'kbn-detail-actions-row'

    const temperBtn = this.buildActionBtn('Temper', 'tempered')
    temperBtn.title = 'Close as tempered (human-accepted)'

    const compostBtn = this.buildActionBtn('Compost', 'composted')
    compostBtn.title = 'Close as composted (human-rejected)'

    if (shuttleManaged) {
      const requeueBtn = this.buildActionBtn('New session ▸', 'primary')
      requeueBtn.title =
        'Cut any open session and dispatch a fresh worker reading ## Status; outcome preserved'

      const resumeBtn = this.buildActionBtn('Resume ▸', 'primary')
      resumeBtn.title = 'Resume the previous worker session (claude --resume); outcome preserved'
      // Resume is always offered for a shuttle-managed card — never gated on a
      // card-visible session id. The Claude session id lives in the fiber's
      // `shuttle.session_uuid` frontmatter field, stamped by the daemon at
      // dispatch; `card.sessionId` is always absent and the frontend cannot
      // see what to resume. The daemon resolves continuation from the
      // `shuttle:` block at dispatch time (resume_mode='previous' reads
      // `shuttle.session_uuid`) and surfaces a precise error if there is
      // genuinely nothing to resume. Gating on `card.sessionId` is exactly what grayed
      // Resume out for EVERY card — it had already grayed standing roles, which
      // never persisted one. See gotcha-standing-role-resume-button-grayed.

      actionsRow.append(requeueBtn, resumeBtn, temperBtn, compostBtn)

      requeueBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.runRequeue(card, messageTa.value.trim(), 'fresh', scope, requeueBtn, actionsErr)
      })
      resumeBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.runRequeue(card, messageTa.value.trim(), 'previous', scope, resumeBtn, actionsErr)
      })
    } else {
      actionsRow.append(temperBtn, compostBtn)
    }

    temperBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.onTransition) { this.close(); this.onTransition(card, 'tempered'); return }
      void this.runTransition(card, 'tempered', scope, temperBtn, actionsErr)
    })
    compostBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.onTransition) { this.close(); this.onTransition(card, 'composted'); return }
      void this.runTransition(card, 'composted', scope, compostBtn, actionsErr)
    })

    // One storyline row under the directive: set intent (⏸), dispatch
    // (New session / Resume), then the review verdicts pushed to the right
    // edge (Temper carries margin-left:auto in CSS) so the two families
    // read as distinct clusters without a second row.
    if (shuttleManaged) {
      actionsRow.prepend(waitBtn)
      actionsSec.append(messageTa, actionsRow, actionsErr)
    } else {
      actionsSec.append(actionsRow, actionsErr)
    }

    // Tags editor removed (Cail) — not needed in the detail panel.

    // ── Worker (shuttle options) ──────────────────────────────────────────
    // Console-style editor for the fiber's shuttle frontmatter block: agent,
    // kind, schedule cadence. Server-side, agent-only changes route through
    // `shuttle-ctl set-model` (preserves session.id + review history);
    // kind/schedule/tz changes trigger a full uninstall + install/repeat.
    let agentSelect: HTMLSelectElement | null = null
    const originalAgent = card.shuttleAgent ?? ''
    // The kind editor toggles oneshot↔standing only; `pinned` is a CLI-managed
    // kind (`shuttle pin <fiber>`), surfaced read-only via the kind chip above.
    // Coerce it to oneshot for the editor's baseline so the toggle stays sound;
    // an agent-only edit on a pinned card never triggers a reshape, so the
    // baseline is never written back unless the human deliberately toggles kind.
    const originalKind: 'oneshot' | 'standing' = card.shuttleKind === 'standing' ? 'standing' : 'oneshot'
    const originalSchedule = card.shuttleSchedule ?? ''
    const originalTz = card.shuttleTz ?? 'Europe/Paris'

    let selectedKind: 'oneshot' | 'standing' = originalKind
    let selectedSchedule = originalSchedule
    let selectedTz = originalTz

    const dispatchSec = this.buildSection(shuttleManaged ? 'Worker' : 'Promote to shuttle')
    const promoteBtn = shuttleManaged ? null : this.buildActionBtn('Promote to shuttle', 'primary')
    const promoteErr = document.createElement('div')
    promoteErr.className = 'kbn-detail-error'
    promoteErr.style.display = 'none'

    // Row 1: agent — base agent select × effort select × chrome toggle. The
    // three orthogonal axes compose into one validated `set-agent` write; the
    // effort options and chrome availability are populated from the selected
    // agent's registry constraint metadata (no hardcoded lists here).
    const agentRow = document.createElement('div')
    agentRow.className = 'kbn-detail-field-row'

    const agentLabel = document.createElement('label')
    agentLabel.className = 'kbn-detail-label'
    agentLabel.textContent = 'Agent'

    agentSelect = document.createElement('select')
    agentSelect.className = 'kbn-detail-select'

    const loadingOpt = document.createElement('option')
    loadingOpt.value = ''
    loadingOpt.textContent = 'Loading agents…'
    agentSelect.append(loadingOpt)

    agentLabel.setAttribute('for', 'kbn-detail-agent')
    agentSelect.id = 'kbn-detail-agent'

    // Effort select — its <option>s are the selected agent's concrete
    // `effort_levels`. There is deliberately no synthetic "default" option:
    // an omitted fiber value resolves to the registry's `default_effort`, so
    // the control always names the level dispatch will actually use.
    const effortSelect = document.createElement('select')
    effortSelect.className = 'kbn-detail-select kbn-detail-select-effort'
    effortSelect.id = 'kbn-detail-effort'
    effortSelect.setAttribute('aria-label', 'Reasoning effort')
    effortSelect.title = 'Reasoning effort used for this fiber'

    // Chrome toggle — enabled only for chrome-capable (claude) agents.
    const chromeWrap = document.createElement('label')
    chromeWrap.className = 'kbn-detail-chrome-toggle'
    chromeWrap.title = 'Run the worker with Claude --chrome (claude harness only)'
    const chromeToggle = document.createElement('input')
    chromeToggle.type = 'checkbox'
    chromeToggle.id = 'kbn-detail-chrome'
    const chromeText = document.createElement('span')
    chromeText.textContent = 'chrome'
    chromeWrap.append(chromeToggle, chromeText)

    // Effort + chrome compose onto an existing shuttle block via set-agent;
    // a not-yet-promoted human card has no block to mutate, so the axes only
    // appear once the card is shuttle-managed. (Promotion's install path takes
    // base model only; the axes are then editable on the installed block.)
    effortSelect.style.display = shuttleManaged ? '' : 'none'
    chromeWrap.style.display = shuttleManaged ? '' : 'none'

    agentRow.append(agentLabel, agentSelect, effortSelect, chromeWrap)
    dispatchSec.append(agentRow)
    // Data-load + listener wiring is deferred until livePatch/statusEl exist
    // (below), since the axis commit posts through them.

    // Row 2: kind segmented control
    const kindRow = document.createElement('div')
    kindRow.className = 'kbn-detail-field-row'

    const kindLabel = document.createElement('span')
    kindLabel.className = 'kbn-detail-label'
    kindLabel.textContent = 'Kind'

    const kindSegmented = document.createElement('div')
    kindSegmented.className = 'kbn-detail-segmented'
    kindSegmented.setAttribute('role', 'radiogroup')
    kindSegmented.setAttribute('aria-label', 'Dispatch kind')

    // Schedule row declared up here so the kind buttons can toggle its
    // visibility; populated below.
    const scheduleRow = document.createElement('div')
    scheduleRow.className = 'kbn-detail-field-row kbn-detail-field-row-schedule'

    const buildKindBtn = (
      value: 'oneshot' | 'standing',
      label: string,
      hint: string,
    ): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'kbn-detail-segment'
      btn.setAttribute('role', 'radio')
      btn.setAttribute('aria-checked', value === selectedKind ? 'true' : 'false')
      btn.dataset.kind = value
      if (value === selectedKind) btn.classList.add('kbn-detail-segment-active')
      btn.title = hint

      const name = document.createElement('span')
      name.className = 'kbn-detail-segment-name'
      name.textContent = label
      btn.append(name)

      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        if (selectedKind === value) return
        selectedKind = value
        for (const sibling of kindSegmented.querySelectorAll<HTMLButtonElement>('button')) {
          const isActive = sibling.dataset.kind === value
          sibling.classList.toggle('kbn-detail-segment-active', isActive)
          sibling.setAttribute('aria-checked', isActive ? 'true' : 'false')
        }
        scheduleRow.style.display = shuttleManaged && value === 'standing' ? '' : 'none'
        // Surface a sensible cron + tz default when promoting to standing
        // for the first time so the user edits rather than fighting an
        // empty input that fails validation on save.
        if (value === 'standing') {
          if (!selectedSchedule) {
            selectedSchedule = '0 9 * * 1-5'
            scheduleInput.value = selectedSchedule
          }
          if (!selectedTz) {
            selectedTz = 'Europe/Paris'
            tzInput.value = selectedTz
          }
        }
      })
      return btn
    }

    const oneshotBtn = buildKindBtn('oneshot', 'One-shot', 'Single dispatch on enable')
    const standingBtn = buildKindBtn('standing', 'Standing', 'Recurring cron-scheduled role')
    kindSegmented.append(oneshotBtn, standingBtn)
    kindRow.append(kindLabel, kindSegmented)
    kindRow.style.display = shuttleManaged ? '' : 'none'
    dispatchSec.append(kindRow)

    // Row 3: schedule + tz (visible only when kind=standing)
    const scheduleLabel = document.createElement('label')
    scheduleLabel.className = 'kbn-detail-label'
    scheduleLabel.textContent = 'Cron'
    scheduleLabel.setAttribute('for', 'kbn-detail-schedule')

    const scheduleInput = document.createElement('input')
    scheduleInput.type = 'text'
    scheduleInput.id = 'kbn-detail-schedule'
    scheduleInput.className = 'kbn-detail-input kbn-detail-input-mono'
    scheduleInput.placeholder = '0 9 * * 1-5'
    scheduleInput.value = selectedSchedule
    scheduleInput.title = '5-field cron · e.g. 0 9 * * 1-5 (weekdays 09:00)'
    scheduleInput.addEventListener('input', () => {
      selectedSchedule = scheduleInput.value
    })
    scheduleInput.addEventListener('mousedown', (e) => e.stopPropagation())
    scheduleInput.addEventListener('click', (e) => e.stopPropagation())

    const tzInput = document.createElement('input')
    tzInput.type = 'text'
    tzInput.className = 'kbn-detail-input kbn-detail-input-tz'
    tzInput.placeholder = 'Europe/Paris'
    tzInput.value = selectedTz
    tzInput.title = 'IANA timezone name'
    tzInput.setAttribute('aria-label', 'Timezone (IANA name)')
    tzInput.addEventListener('input', () => {
      selectedTz = tzInput.value
    })
    tzInput.addEventListener('mousedown', (e) => e.stopPropagation())
    tzInput.addEventListener('click', (e) => e.stopPropagation())

    scheduleRow.append(scheduleLabel, scheduleInput, tzInput)
    scheduleRow.style.display = shuttleManaged && selectedKind === 'standing' ? '' : 'none'
    dispatchSec.append(scheduleRow)
    if (promoteBtn) dispatchSec.append(promoteBtn, promoteErr)

    // ── Live-apply status pill ────────────────────────────────────────────
    // No Save button. Every field commits on its own event: agent on
    // `change`, kind on click, schedule/tz on `blur`/Enter, parent on
    // autocomplete pick. statusEl shows "Saving…" / "Saved"; errors surface
    // in errorEl. Originals advance after each successful PATCH.
    const statusEl = document.createElement('span')
    statusEl.className = 'kbn-detail-save-status'
    statusEl.setAttribute('aria-live', 'polite')

    const errorEl = document.createElement('div')
    errorEl.className = 'kbn-detail-error'
    errorEl.style.display = 'none'

    // ── Parent fiber ──────────────────────────────────────────────────────
    const parentSec = this.buildSection('Parent fiber')

    const idSegments = card.id.split('/')
    const currentParentId = idSegments.length > 1
      ? idSegments.slice(0, -1).join('/')
      : null

    let selectedParentId: string | null = currentParentId

    const currentParentEl = document.createElement('div')
    currentParentEl.className = 'kbn-detail-current-parent'
    currentParentEl.textContent = currentParentId
      ? `↳ ${currentParentId}`
      : '↳ top-level (no parent)'

    const parentSearchWrap = document.createElement('div')
    parentSearchWrap.className = 'kbn-detail-parent-wrap'

    const parentInput = document.createElement('input')
    parentInput.type = 'text'
    parentInput.className = 'kbn-detail-parent-input'
    parentInput.placeholder = 'Search for a new parent…'
    parentInput.setAttribute('aria-label', 'Search parent fiber')
    parentInput.setAttribute('autocomplete', 'off')
    parentInput.setAttribute('role', 'combobox')
    parentInput.setAttribute('aria-expanded', 'false')
    parentInput.setAttribute('aria-haspopup', 'listbox')
    parentInput.addEventListener('mousedown', (e) => e.stopPropagation())
    parentInput.addEventListener('click', (e) => e.stopPropagation())

    const parentDropdown = document.createElement('div')
    parentDropdown.className = 'kbn-detail-parent-dropdown'
    parentDropdown.style.display = 'none'
    parentDropdown.setAttribute('role', 'listbox')

    // Shared pick-handler in a closure-captured ref so the live-commit
    // wrapper below can replace it once `livePatch` is defined — every
    // caller (search debounce, keyboard Enter) goes through the same
    // indirection and picks up the live-apply behavior.
    const parentPickRef: { current: (result: FiberSearchResult) => void } = {
      current: (result) => {
        selectedParentId = result.id
        parentInput.value = result.name
        parentInput.setAttribute('aria-expanded', 'false')
        parentDropdown.style.display = 'none'
      },
    }
    const onPickParent = (result: FiberSearchResult) => parentPickRef.current(result)

    const openDropdown = () => {
      void this.searchParents(
        parentInput.value.trim(),
        card.id,
        parentDropdown,
        onPickParent,
      ).then(() => {
        if (parentDropdown.style.display !== 'none') {
          parentInput.setAttribute('aria-expanded', 'true')
        }
      })
    }

    parentInput.addEventListener('input', () => {
      if (this.searchDebounce !== null) window.clearTimeout(this.searchDebounce)
      this.searchDebounce = window.setTimeout(() => openDropdown(), 200)
    })
    parentInput.addEventListener('focus', () => openDropdown())
    parentInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        const first = parentDropdown.querySelector<HTMLElement>('button')
        if (first) { e.preventDefault(); first.focus() }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        parentDropdown.style.display = 'none'
        parentInput.setAttribute('aria-expanded', 'false')
      }
    })

    parentDropdown.addEventListener('keydown', (e) => {
      const opts = Array.from(
        parentDropdown.querySelectorAll<HTMLElement>('button:not(:disabled)'),
      )
      const idx = opts.indexOf(document.activeElement as HTMLElement)
      if (e.key === 'ArrowDown' && idx < opts.length - 1) {
        e.preventDefault()
        opts[idx + 1].focus()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (idx > 0) opts[idx - 1].focus()
        else parentInput.focus()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        // Focus the input first — hiding a container that holds the focused
        // element drops focus to <body> before we can redirect it.
        parentInput.focus()
        parentDropdown.style.display = 'none'
        parentInput.setAttribute('aria-expanded', 'false')
      }
    })

    parentSearchWrap.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (!parentSearchWrap.contains(document.activeElement)) {
          parentDropdown.style.display = 'none'
          parentInput.setAttribute('aria-expanded', 'false')
        }
      }, 150)
    })

    parentSearchWrap.append(parentInput, parentDropdown)
    parentSec.append(currentParentEl, parentSearchWrap)

    // Track originals as a mutable closure so each successful PATCH can
    // advance the baseline.
    const baseline = {
      agent: originalAgent,
      kind: originalKind,
      schedule: originalSchedule,
      tz: originalTz,
      parentId: currentParentId,
    }

    const livePatch = (
      changes: {
        shuttleAgent?: string
        shuttleKind?: 'oneshot' | 'standing'
        shuttleSchedule?: string
        shuttleTz?: string
        parentId?: string | null
      },
      onCommitted?: () => void,
    ): void => {
      if (Object.keys(changes).length === 0) return
      void this.livePatch(card, changes, statusEl, errorEl).then((ok: boolean) => {
        if (ok && onCommitted) onCommitted()
      })
    }

    // Agent axes: base agent × effort × chrome compose into one validated
    // `set-agent` write (preserves session history, like the old set-model).
    // The picker repopulates effort options + chrome availability from the
    // selected agent's registry metadata and commits on any axis change.
    if (agentSelect) {
      // For a shuttle-managed card every axis change commits via set-agent;
      // for a human card the picker only populates the base-agent select the
      // promote button reads (no block to mutate yet → no-op commit).
      void this.loadAgentPicker(
        { agentSelect, effortSelect, chromeToggle },
        {
          agent: originalAgent,
          effort: card.shuttleEffort ?? '',
          chrome: card.shuttleChrome ?? false,
        },
        shuttleManaged
          ? (axes) => {
              this.commitAxes(card, axes, statusEl, errorEl, () => {
                baseline.agent = axes.agent
              })
            }
          : () => {},
      )
    }

    // Kind: fire on click. When promoting oneshot → standing, batch
    // schedule + tz alongside so the server's reshape path has the full
    // block. A bare standing → oneshot collapse just sends shuttleKind.
    const commitKind = (value: 'oneshot' | 'standing'): void => {
      if (value === baseline.kind) return
      const newSchedule = scheduleInput.value.trim()
      const newTz = tzInput.value.trim()
      if (value === 'standing') {
        if (!newSchedule) {
          errorEl.textContent = 'A cron expression is required for standing roles.'
          errorEl.style.display = ''
          for (const sibling of kindSegmented.querySelectorAll<HTMLButtonElement>('button')) {
            const isActive = sibling.dataset.kind === baseline.kind
            sibling.classList.toggle('kbn-detail-segment-active', isActive)
            sibling.setAttribute('aria-checked', isActive ? 'true' : 'false')
          }
          selectedKind = baseline.kind
          return
        }
        livePatch(
          {
            shuttleKind: 'standing',
            shuttleSchedule: newSchedule,
            shuttleTz: newTz || 'UTC',
          },
          () => {
            baseline.kind = 'standing'
            baseline.schedule = newSchedule
            baseline.tz = newTz || 'UTC'
          },
        )
      } else {
        livePatch({ shuttleKind: 'oneshot' }, () => {
          baseline.kind = 'oneshot'
        })
      }
    }
    for (const btn of kindSegmented.querySelectorAll<HTMLButtonElement>('button')) {
      btn.addEventListener('click', () => {
        const value = btn.dataset.kind as 'oneshot' | 'standing' | undefined
        if (value) commitKind(value)
      })
    }

    // Schedule + tz: fire on `blur` and Enter — `input` would generate
    // noisy patches from mid-typing cron fragments. The reshape path
    // requires kind=standing alongside, so always send all three.
    const commitScheduleTz = (): void => {
      if (baseline.kind !== 'standing') return
      const newSchedule = scheduleInput.value.trim()
      const newTz = tzInput.value.trim() || 'UTC'
      if (newSchedule === baseline.schedule && newTz === baseline.tz) return
      if (!newSchedule) {
        errorEl.textContent = 'A cron expression is required for standing roles.'
        errorEl.style.display = ''
        return
      }
      livePatch(
        {
          shuttleKind: 'standing',
          shuttleSchedule: newSchedule,
          shuttleTz: newTz,
        },
        () => {
          baseline.schedule = newSchedule
          baseline.tz = newTz
        },
      )
    }
    scheduleInput.addEventListener('blur', commitScheduleTz)
    scheduleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        scheduleInput.blur()
      }
    })
    tzInput.addEventListener('blur', commitScheduleTz)
    tzInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        tzInput.blur()
      }
    })

    // Parent: redirect the autocomplete's pick callback into a live patch.
    const basePickParent = parentPickRef.current
    parentPickRef.current = (result) => {
      basePickParent(result)
      const targetParentId = selectedParentId
      if (targetParentId === baseline.parentId) return
      livePatch({ parentId: targetParentId }, () => {
        baseline.parentId = targetParentId
        currentParentEl.textContent = targetParentId
          ? `↳ ${targetParentId}`
          : '↳ top-level (no parent)'
      })
    }

    if (promoteBtn) {
      promoteBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const agent = agentSelect?.value.trim() ?? ''
        if (!agent) {
          promoteErr.textContent = 'Choose an agent to promote this card.'
          promoteErr.style.display = ''
          return
        }
        promoteBtn.disabled = true
        promoteBtn.textContent = 'Promoting…'
        promoteErr.style.display = 'none'
        void this.promoteToShuttle(card, agent, promoteBtn, promoteErr)
      })
    }

    // ── Footer: drill-out + live-save status ──────────────────────────────
    const footer = document.createElement('div')
    footer.className = 'kbn-detail-footer'

    footer.append(errorEl, statusEl)

    // Worker config on the left, card metadata (tags + parent) on the
    // right — a shallow two-column cluster at comfortable widths, one
    // column on narrow panels (container query in FiberDetailModal.css).
    const grid = document.createElement('div')
    grid.className = 'kbn-detail-controls-grid'
    const metaCol = document.createElement('div')
    metaCol.className = 'kbn-detail-controls-grid-col'
    metaCol.append(parentSec)
    grid.append(dispatchSec, metaCol)

    body.append(actionsSec, this.buildRule(), grid, footer)
  }

  // ── Sent files: launcher + two-column accordion ─────────────────────────

  /**
   * The left-column sent-files launcher. Mounts empty (hidden) and self-
   * populates from {@link fetchSentFiles}: the daemon's `/api/v1/sent-files`
   * endpoint first, falling back to parsing `events.jsonl` over `/api/v1/file`
   * for older local daemons. Only reveals itself when the trail has entries,
   * so cards without deliverables pay zero visual cost. Each entry is a button
   * that opens (or re-activates) the file in the right-column accordion.
   */
  private buildSentFilesLauncher(card: KanbanCard): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'kbn-detail-sent kbn-detail-sent-empty'

    const heading = document.createElement('div')
    heading.className = 'kbn-detail-sent-heading'
    heading.textContent = 'Sent files'

    const list = document.createElement('div')
    list.className = 'kbn-detail-sent-list'
    list.setAttribute('role', 'list')
    wrap.append(heading, list)

    const overlayAtBuild = () => this.overlay
    void this.fetchSentFiles(card).then((files) => {
      // Panel may have closed/reopened while the fetch was in flight.
      if (!overlayAtBuild()?.contains(wrap)) return
      // Disambiguate same-named files BEFORE anything reads the trail. Neither
      // real data source distinguishes two files both literally named
      // `report.html` (the endpoint and the events.jsonl parser each emit a bare
      // path tail), so without this the launcher and accordion would show two
      // identical `report.html` rows — defeating the whole "tell them apart"
      // ask. The disambiguated label flows into the launcher, the accordion
      // header, and persistence uniformly.
      this.sentFiles = disambiguateBasenames(files)
      // Reconcile any already-rehydrated accordion entries against the trail's
      // (now disambiguated) basename. Rehydration fires off persisted records
      // before the trail resolves; a legacy record (no persisted basename) or
      // one whose disambiguated label has since changed gets corrected here so
      // the accordion header matches the launcher rather than collapsing to the
      // bare path tail.
      this.reconcileOpenBasenames(this.sentFiles)
      if (files.length === 0) return
      this.renderLauncher(list, card)
      wrap.classList.remove('kbn-detail-sent-empty')
      // A rehydration that arrived before the trail did can now mark which
      // launcher entries are open.
      this.syncLauncherActiveState()
    })

    return wrap
  }

  /** (Re)render the launcher rows from `this.sentFiles`, newest-first. */
  private renderLauncher(list: HTMLElement, card: KanbanCard): void {
    list.replaceChildren()
    for (const file of this.sentFiles) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'kbn-detail-sent-file'
      row.setAttribute('role', 'listitem')
      row.title = file.fullPath
      row.dataset.fullPath = file.fullPath

      const name = document.createElement('span')
      name.className = 'kbn-detail-sent-name'
      name.textContent = file.basename

      const when = document.createElement('span')
      when.className = 'kbn-detail-sent-when'
      when.textContent = relativeTime(file.timestamp)

      row.append(name, when)
      row.addEventListener('click', (e) => {
        e.stopPropagation()
        this.activateFile(file, card)
      })
      list.append(row)
    }
  }

  /** Mark launcher entries whose file is currently open in the accordion. */
  private syncLauncherActiveState(): void {
    const openPaths = new Set(this.openFiles.map((e) => e.file.fullPath))
    this.overlay
      ?.querySelectorAll<HTMLElement>('.kbn-detail-sent-file')
      .forEach((row) => {
        const open = !!row.dataset.fullPath && openPaths.has(row.dataset.fullPath)
        row.classList.toggle('kbn-detail-sent-file-open', open)
      })
  }

  /**
   * Once the trail resolves, align each open accordion entry's display label
   * with the trail's authoritative basename (matched by full path). Without
   * this, an entry rehydrated from a legacy persist record — or before the
   * trail's disambiguation ran — would keep the bare path tail, producing two
   * visually identical `report.html` headers for two genuinely distinct files.
   */
  private reconcileOpenBasenames(files: SentFile[]): void {
    if (this.openFiles.length === 0) return
    const labelByPath = new Map(files.map((f) => [f.fullPath, f.basename]))
    for (const entry of this.openFiles) {
      const label = labelByPath.get(entry.file.fullPath)
      if (label && label !== entry.file.basename) {
        entry.file.basename = label
        const name = entry.tab.querySelector('.kbn-detail-tab-name')
        if (name) name.textContent = label
      }
    }
    // Persist the corrected labels so the next reload starts from truth.
    this.writePersist()
  }

  // ── The tabbed full-view ────────────────────────────────────────────────

  /**
   * Open `file` in the right column and make it the active (shown) tab. If it's
   * already open, just switch to its tab — tabs keep a stable open-order
   * (browser-style; they don't reorder on click). This is the single entry the
   * launcher and rehydration both funnel through, so the tab set + persistence
   * stay consistent.
   */
  private activateFile(file: SentFile, card: KanbanCard, opts?: { scroll?: number; zoom?: number; persist?: boolean }): void {
    const entry =
      this.openFiles.find((e) => e.file.fullPath === file.fullPath) ??
      this.addOpenFile(file, card, opts?.scroll ?? 0, opts?.zoom ?? 1)
    this.setActive(entry, card)
    this.syncLauncherActiveState()
    if (opts?.persist !== false) this.writePersist()
  }

  /**
   * Build a new tab + its (empty) view cell and append both in stable
   * open-order. Reveals the right column on the first open. Does NOT activate
   * or build the viewer — `setActive` does that lazily on first view, so
   * background tabs cost nothing until clicked.
   */
  private addOpenFile(file: SentFile, card: KanbanCard, scroll: number, zoom: number): OpenFileEntry {
    this.openViewerWindow()

    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = 'kbn-detail-tab'
    tab.setAttribute('role', 'tab')
    tab.title = file.fullPath

    const name = document.createElement('span')
    name.className = 'kbn-detail-tab-name'
    name.textContent = file.basename

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'kbn-detail-tab-close'
    closeBtn.setAttribute('aria-label', `Close ${file.basename}`)
    closeBtn.textContent = '✕'

    tab.append(name, closeBtn)

    const cell = document.createElement('div')
    cell.className = 'kbn-detail-view-cell'
    cell.hidden = true

    const entry: OpenFileEntry = {
      file,
      tab,
      cell,
      scroll,
      zoom,
      viewerBuilt: false,
      iframe: null,
      zoomTarget: null,
      baseW: 0,
    }

    tab.addEventListener('click', () => {
      this.setActive(entry, card)
      this.syncLauncherActiveState()
      this.writePersist()
    })
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.closeFile(entry)
    })

    this.openFiles = [...this.openFiles, entry]
    this.tabStrip?.append(tab)
    this.rightCol?.append(cell)
    return entry
  }

  /** Make `entry` the active tab: show its cell (build its viewer on first
   *  view), hide the rest, highlight its tab. Preserves every other open
   *  cell's DOM (scroll + zoom survive the switch). */
  private setActive(entry: OpenFileEntry, card: KanbanCard): void {
    this.activePath = entry.file.fullPath
    // Show the active cell BEFORE building its viewer so a freshly-built image
    // can measure the (now visible) cell width for its fit-to-width base.
    for (const e of this.openFiles) {
      const on = e === entry
      e.cell.hidden = !on
      e.tab.classList.toggle('kbn-detail-tab-active', on)
      e.tab.setAttribute('aria-selected', String(on))
    }
    if (!entry.viewerBuilt) this.buildEntryViewer(entry, card)
  }

  /** Build the viewer for an entry (idempotent — once per entry). Wires
   *  scroll-restore + a debounced scroll-position writer for iframe files, and
   *  records the element Cmd-scroll zoom scales. */
  private buildEntryViewer(entry: OpenFileEntry, card: KanbanCard): void {
    if (entry.viewerBuilt) return
    entry.viewerBuilt = true
    const scrollable = isScrollableFile(entry.file.fullPath)
    const viewer = buildFileViewer(
      this.shuttleBase,
      entry.file.fullPath,
      card.originId,
      scrollable
        ? (iframe) => {
            entry.iframe = iframe
            // Restore the persisted reading position once the doc has loaded
            // (same-origin: served from the app's own daemon).
            try {
              iframe.contentWindow?.scrollTo(0, entry.scroll)
              const win = iframe.contentWindow
              if (win) {
                win.addEventListener('scroll', () => {
                  entry.scroll = win.scrollY
                  this.queueScrollWrite()
                }, { passive: true })
              }
            } catch {
              /* cross-origin / unreadable — no scroll restore */
            }
          }
        : undefined,
    )
    entry.cell.append(viewer)
    // Zoom target: the <img> for images (sized in px so it magnifies PAST the
    // column width), else the viewer wrap (CSS `zoom` for iframes). The cell
    // (overflow:auto) is the pan surface. Apply persisted zoom now that the
    // cell is visible — its width is the image's fit base.
    entry.zoomTarget = viewer.querySelector<HTMLElement>('img.kbn-fileview-image') ?? viewer
    this.applyZoom(entry)
  }

  /** Cmd/Ctrl + wheel over the active file zooms it, anchored on the cursor
   *  (the point under the pointer stays put). Works for images, HTML, and PDF —
   *  it scales the rendered viewer box and pans via the cell's scroll. A plain
   *  wheel (no modifier) is left alone, so normal scrolling still works. */
  private handleZoomWheel(e: WheelEvent): void {
    if (!(e.metaKey || e.ctrlKey)) return
    const entry = this.openFiles.find((x) => x.file.fullPath === this.activePath)
    if (!entry || !entry.zoomTarget) return
    e.preventDefault()
    const cell = entry.cell
    const rect = cell.getBoundingClientRect()
    const cursorX = e.clientX - rect.left
    const cursorY = e.clientY - rect.top
    const zOld = entry.zoom
    const zNew = Math.min(6, Math.max(0.25, zOld * Math.exp(-e.deltaY * 0.0015)))
    if (zNew === zOld) return
    // Content-space point under the cursor (pre-zoom) — keep it fixed.
    const px = (cell.scrollLeft + cursorX) / zOld
    const py = (cell.scrollTop + cursorY) / zOld
    entry.zoom = zNew
    this.applyZoom(entry)
    cell.scrollLeft = px * zNew - cursorX
    cell.scrollTop = py * zNew - cursorY
    this.queueScrollWrite()
  }

  /** Mirror an entry's zoom into its viewer element via the CSS `zoom`
   *  property (Chromium): unlike `transform: scale`, `zoom` grows the element's
   *  layout box, so the cell's `overflow:auto` gives real scrollbars to pan the
   *  magnified file. */
  private applyZoom(entry: OpenFileEntry): void {
    const t = entry.zoomTarget
    if (!t) return
    if (t instanceof HTMLImageElement) {
      // Image. At zoom 1: clear the inline width so CSS `width:100%` fits it to
      // the column (and forget the base so a resize re-fits). At zoom > 1: width
      // = fit-width × zoom in px, so it grows PAST the column and the cell pans.
      // The fit base is the wrap's content width, captured lazily once we're
      // past 1 (post-layout); if the cell isn't laid out yet (rehydrated zoom on
      // open), defer a frame.
      if (entry.zoom === 1) {
        t.style.removeProperty('width')
        t.style.removeProperty('max-width')
        t.style.removeProperty('height')
        entry.baseW = 0
        return
      }
      if (!entry.baseW) {
        const fit = t.parentElement?.clientWidth ?? 0
        if (!fit) { requestAnimationFrame(() => this.applyZoom(entry)); return }
        entry.baseW = fit
      }
      t.style.maxWidth = 'none'
      t.style.height = 'auto'
      t.style.width = `${Math.round(entry.baseW * entry.zoom)}px`
    } else {
      // Iframe wrap: CSS `zoom` magnifies the rendered content.
      if (entry.zoom === 1) t.style.removeProperty('zoom')
      else t.style.setProperty('zoom', String(entry.zoom))
    }
  }

  /** Close one open file. Switches to the nearest remaining tab if it was
   *  active; dissolves the right column if it was the last. */
  private closeFile(entry: OpenFileEntry): void {
    const wasActive = this.activePath === entry.file.fullPath
    const idx = this.openFiles.indexOf(entry)
    entry.tab.remove()
    entry.cell.remove()
    this.openFiles = this.openFiles.filter((e) => e !== entry)
    if (wasActive) {
      this.activePath = null
      const next = this.openFiles[idx] ?? this.openFiles[idx - 1]
      if (next && this.card) this.setActive(next, this.card)
    }
    this.syncLauncherActiveState()
    if (this.openFiles.length === 0) this.closeViewerWindow()
    this.writePersist()
  }

  /** Debounced scroll-position persistence. Open/close/expand write
   *  immediately; scroll is debounced so a flick of the wheel doesn't hammer
   *  localStorage. */
  private queueScrollWrite(): void {
    if (this.scrollWriteTimer !== null) window.clearTimeout(this.scrollWriteTimer)
    this.scrollWriteTimer = window.setTimeout(() => {
      this.scrollWriteTimer = null
      this.writePersist()
    }, 400)
  }

  /** Serialize the current right-column state to localStorage. */
  private writePersist(): void {
    const uid = typeof this.card?.uid === 'string' ? this.card.uid : ''
    if (!uid) return
    savePersist(uid, {
      active: this.activePath ?? undefined,
      cardGeom: this.cardGeom ?? undefined,
      viewerGeom: this.viewerGeom ?? undefined,
      open: this.openFiles.map((e) => ({
        path: e.file.fullPath,
        basename: e.file.basename,
        scroll: e.scroll,
        zoom: e.zoom,
      })),
    })
  }

  /**
   * Rebuild the right column from persisted state on panel-open. Files are
   * activated oldest-first so the saved recency order (index 0 = top) is
   * reproduced, with scroll/expanded carried through. Entries whose path is no
   * longer on the (eventually-loaded) trail are pruned silently — but the
   * rehydrate fires immediately off the persisted paths so the column is there
   * before the trail fetch resolves. A path the trail later disowns is dropped
   * on the next write.
   */
  private rehydrateOpenFiles(card: KanbanCard, persist: DetailPersist): void {
    if (persist.open.length === 0) return
    // Add every tab in the saved (stable) order without activating — building
    // each viewer lazily would load every iframe up front.
    for (const saved of persist.open) {
      const file: SentFile = {
        fullPath: saved.path,
        // Prefer the persisted display label (preserves the disambiguated
        // basename); fall back to the path tail for legacy records.
        basename: saved.basename ?? basenameOf(saved.path),
        timestamp: 0,
      }
      this.addOpenFile(file, card, saved.scroll, saved.zoom ?? 1)
    }
    // Restore the active tab (persisted, else the last opened) — this builds
    // only that one viewer; the others build on first click.
    const active =
      this.openFiles.find((e) => e.file.fullPath === persist.active) ??
      this.openFiles[this.openFiles.length - 1]
    if (active) this.setActive(active, card)
    this.syncLauncherActiveState()
  }

  /**
   * The card's sent-files trail. Tries the daemon's `GET /api/v1/sent-files`
   * first (committed; deploys on the next daemon restart). If that 404s/fails
   * AND the origin is local, falls back to fetching `events.jsonl` via
   * `/api/v1/file` and parsing it client-side — local-only, because the file
   * is ~10 MB and must never be pulled over a slow remote tunnel. The parse is
   * one-shot per panel-open (this method runs once from the launcher build).
   */
  private async fetchSentFiles(card: KanbanCard): Promise<SentFile[]> {
    const uid = typeof card.uid === 'string' ? card.uid.trim() : ''
    const sessionId = typeof card.sessionId === 'string' ? card.sessionId.trim() : ''
    if (!uid && !sessionId) return []

    // ── Primary: the daemon endpoint ──
    const params = new URLSearchParams()
    if (uid) params.set('uid', uid)
    if (card.originId) params.set('origin', card.originId)
    if (sessionId) params.set('sessionId', sessionId)
    try {
      const res = await fetch(`${this.shuttleBase}/api/v1/sent-files?${params.toString()}`)
      if (res.ok) {
        const data = (await res.json()) as { files?: SentFile[] }
        if (Array.isArray(data.files)) return data.files
      }
      // A non-ok (404 on an older daemon) falls through to the fallback.
    } catch {
      // Network error — fall through to the local events.jsonl fallback.
    }

    // ── Fallback: parse the LOCAL events.jsonl over /file ──
    // The old gate was `card.originId === 'local'`, which is NEVER true for a
    // real local card: the composite feed stamps local rows with the daemon's
    // own host id (`own_host_id()`, e.g. `dapmcw68`) and sets the feed's top-
    // level `host` to that same id — so a local card has `originId === feed.host`
    // (a hostname), not the literal `'local'`. That false gate short-circuited
    // the fallback for every real local card, so until `/api/v1/sent-files`
    // deploys, cards showed no sent files — the exact bug this path exists to
    // fix.
    //
    // `FiberDetailModal` isn't handed `feed.host`, so we can't name the local
    // host from the card alone. We don't need to: the read below is pinned to
    // the LOCAL daemon (`fileBytesUrl(..., 'local')` emits no `&origin=`, so the
    // route reads this machine's file — never a remote tunnel). A remote card's
    // sends live in the *remote* host's events.jsonl, so parsing the local log
    // for a remote uid simply yields `[]`. Thus the only real gate is "can we
    // derive a home to point at" — and the cost is bounded (one local read,
    // once per panel-open, primary endpoint already tried).
    const home = homeFromDir(card.fiberDir)
    if (!home) return []
    const eventsPath = `${home}/.portolan/data/events.jsonl`
    try {
      const res = await fetch(fileBytesUrl(this.shuttleBase, eventsPath, 'local'))
      if (!res.ok) return []
      const text = await res.text()
      return parseSentFilesFromEvents(text, uid, sessionId)
    } catch {
      return []
    }
  }

  private buildSection(label: string): HTMLElement {
    const sec = document.createElement('div')
    sec.className = 'kbn-detail-section'
    sec.dataset.section = label.toLowerCase()
    const heading = document.createElement('div')
    heading.className = 'kbn-detail-section-heading'
    heading.textContent = label
    sec.append(heading)
    return sec
  }

  /**
   * Hairline printer's rule used to separate clusters in the dropdown.
   * Pure presentational element — no semantic role.
   */
  private buildRule(): HTMLElement {
    const rule = document.createElement('div')
    rule.className = 'kbn-detail-rule'
    rule.setAttribute('aria-hidden', 'true')
    return rule
  }

  /**
   * Build a button for the action cluster. Variants tint the button to
   * match the kanban grid's `kbn-action-*` palette (gold for primary
   * requeue/resume, teal for tempered, muted gray for composted).
   */
  private buildActionBtn(
    label: string,
    variant: 'primary' | 'tempered' | 'composted' | 'dispatch',
  ): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `kbn-detail-action-btn kbn-detail-action-${variant}`
    btn.textContent = label
    return btn
  }

  /** Shuttle daemon transition endpoint. Owner-routed by `origin` in the
   *  body, so no `?cityId=` scoping — the daemon maps the column `target`
   *  to a lifecycle action itself. */
  private transitionUrl(): string {
    return `${this.shuttleBase}/api/v1/transition`
  }

  /** Shuttle daemon dispatch endpoint (force/ad-hoc launches), owner-routed
   *  by `origin`. */
  private dispatchUrl(): string {
    return `${this.shuttleBase}/api/v1/dispatch`
  }

  /** POST one `/api/v1/lifecycle` action; the daemon answers plain text, so
   *  a !ok body is the error message verbatim. */
  private async postLifecycle(body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.shuttleBase}/api/v1/lifecycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => `${res.status}`)
      throw new Error(errText || `Save failed: ${res.status}`)
    }
  }

  /** The `project_dir` for a card's shuttle install: the block's own
   *  `project_dir` when present (reshape echo), else the owning city's
   *  project path. Undefined when neither resolves — valid for paused
   *  installs; an arming install without one fails loudly in shuttle-ctl. */
  private projectDirFor(card: KanbanCard): string | undefined {
    return (
      card.shuttleProjectDir ??
      (card.cityId ? this.resolveCityProjectPath?.(card.cityId) : undefined)
    )
  }

  /**
   * Unified manual requeue: a single owner-routed `/api/v1/dispatch` carrying
   * the user's message and resume intent inline. `user_message` is the
   * directive text (the daemon inlines it into the prompt at launch);
   * `resume_mode` is `'fresh'` → start a new session, `'previous'` → resume the
   * prior session. The daemon resolves the session to resume from the fiber's
   * `shuttle.session_uuid` frontmatter field, falling back to fresh
   * when there's nothing to resume. `force`/`ad_hoc` launch the worker on the
   * owning host regardless of poll eligibility.
   *
   * Owner-routed by `card.originId` (`origin`), which carries the message and
   * resume_mode to the owning daemon intact cross-host.
   */
  private async runRequeue(
    card: KanbanCard,
    directive: string,
    mode: 'fresh' | 'previous',
    _cityId: string | undefined,
    btn: HTMLButtonElement,
    errorEl: HTMLElement,
  ): Promise<void> {
    // A "New session" over a LIVE worker is a CUT: the daemon stamps the
    // clean-exit marker, kills the running session, and starts fresh — which
    // discards whatever in-flight context that worker was holding. Confirm
    // before doing that. A dormant card (no live worker) cuts nothing, so it's
    // silent; Resume never cuts, so it never confirms.
    if (mode === 'fresh' && card.runningWorker) {
      const working = card.runtimePhase === 'working' ? ' (actively working)' : ''
      const ok = window.confirm(
        `A worker is still running for “${card.name}”${working}.\n\n` +
          `Start a new session? This cuts the open session and discards its ` +
          `in-flight context. Use Resume instead to continue that worker.`,
      )
      if (!ok) return
    }

    const original = btn.textContent ?? ''
    btn.disabled = true
    btn.textContent = mode === 'fresh' ? 'Starting…' : 'Resuming…'
    errorEl.style.display = 'none'

    // Single force/ad-hoc dispatch carrying the message + resume_mode inline.
    let res: Response
    try {
      res = await fetch(this.dispatchUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fiber_id: card.id,
          origin: card.originId,
          force: true,
          ad_hoc: true,
          user_message: directive,
          resume_mode: mode,
        }),
      })
    } catch (err: unknown) {
      const detail = (err as { message?: string })?.message ?? String(err)
      this.showDispatchError(errorEl, btn, original, `Couldn't reach Shuttle: ${detail}`)
      return
    }

    const body = (await res.json().catch(() => ({}))) as {
      dispatched?: boolean
      reason?: string
      detail?: string
      message?: string
      error?: string
      tmux_session?: string
    }

    if (res.status === 409) {
      btn.textContent = 'Already running'
      btn.disabled = true
      errorEl.textContent = 'A worker is already running for this fiber.'
      errorEl.style.display = ''
      return
    }

    if (!res.ok) {
      // Prefer the daemon's structured ineligibility copy (detail/message name
      // the actual host / project_dir); fall back to the generic error / status.
      const msg = (body.reason || body.detail || body.message)
        ? dispatchIneligibleReason(body)
        : (body.error ?? `Requeue failed (${res.status})`)
      this.showDispatchError(errorEl, btn, original, msg)
      return
    }

    this.close()
    this.onSaved()
    if (body.tmux_session) {
      this.onAttachFreshTmux?.(body.tmux_session)
    }
  }

  /**
   * Single-step transition (no directive). Used for Temper / Compost
   * buttons — those are terminal moves where a directive is moot.
   */
  private async runTransition(
    card: KanbanCard,
    target: string,
    _cityId: string | undefined,
    btn: HTMLButtonElement,
    errorEl: HTMLElement,
  ): Promise<void> {
    const original = btn.textContent ?? ''
    btn.disabled = true
    btn.textContent = '…'
    errorEl.style.display = 'none'
    try {
      const res = await fetch(this.transitionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiber_id: card.id, target, origin: card.originId }),
      })
      if (!res.ok) {
        throw new Error(await errorMessageFromResponse(res, 'Transition failed'))
      }
      this.close()
      this.onSaved()
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      errorEl.textContent = msg
      errorEl.style.display = ''
      btn.disabled = false
      btn.textContent = original
    }
  }

  private showDispatchError(
    errorEl: HTMLElement,
    btn: HTMLButtonElement,
    originalBtnText: string,
    message: string,
  ): void {
    errorEl.textContent = message
    errorEl.style.display = ''
    btn.disabled = false
    btn.textContent = originalBtnText
  }

  /**
   * Load the agent registry and wire the composing picker: base agent select
   * (aliases filtered out), an effort select whose options come from the
   * selected agent's `effort_levels`, and a chrome toggle gated on
   * `chrome_capable`. Any axis change repopulates the dependent controls (a
   * new agent resets effort to its default and may disable chrome) and fires
   * `onCommit` with the current composition — which `commitAxes` writes
   * through the daemon's `set-agent` lifecycle action.
   */
  private async loadAgentPicker(
    controls: {
      agentSelect: HTMLSelectElement
      effortSelect: HTMLSelectElement
      chromeToggle: HTMLInputElement
    },
    current: { agent: string; effort: string; chrome: boolean },
    onCommit: (axes: { agent: string; effort: string; chrome: boolean }) => void,
  ): Promise<void> {
    const { agentSelect, effortSelect, chromeToggle } = controls
    let records: AgentRecord[]
    try {
      // The daemon's registry is a bare array; Portolan's retired proxy used
      // to wrap it as `{agents: [...]}`. Accept both for embed compatibility.
      const res = await fetch(`${this.shuttleBase}/api/v1/agents`)
      if (!res.ok) throw new Error(`${res.status}`)
      const raw = (await res.json()) as AgentRecord[] | { agents: AgentRecord[] }
      records = Array.isArray(raw) ? raw : raw.agents ?? []
    } catch {
      agentSelect.innerHTML = '<option value="">Failed to load agents</option>'
      effortSelect.innerHTML = ''
      effortSelect.disabled = true
      chromeToggle.disabled = true
      return
    }

    // Base agents only — alias records (e.g. claude-opus-chrome) are a
    // convenience that the composing picker supersedes; resolving one to its
    // base + axes belongs to the registry, not this list.
    const base = records.filter((a) => !a.alias_of)
    agentSelect.innerHTML = ''
    if (base.length === 0) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = 'No agents available'
      agentSelect.append(opt)
      effortSelect.disabled = true
      chromeToggle.disabled = true
      return
    }

    const defaultAgent = current.agent
      ? undefined
      : base.find((a) => a.default)?.id
    for (const agent of base) {
      const opt = document.createElement('option')
      opt.value = agent.id
      opt.textContent = agent.model ? `${agent.id} (${agent.model})` : agent.id
      if (agent.id === current.agent || (!current.agent && agent.id === defaultAgent)) {
        opt.selected = true
      }
      agentSelect.append(opt)
    }
    // A current agent absent from the registry stays selectable as a custom
    // entry so an unknown id isn't silently rewritten on the next edit.
    if (current.agent && !base.some((a) => a.id === current.agent)) {
      const opt = document.createElement('option')
      opt.value = current.agent
      opt.textContent = `${current.agent} (custom)`
      opt.selected = true
      agentSelect.prepend(opt)
    }

    // Repopulate effort options + chrome availability from a given agent's
    // metadata. The selected value is always concrete: an omitted/invalid
    // fiber value resolves to the agent's registry default. An agent change
    // therefore writes that new agent's explicit effective effort.
    const syncDependents = (agentId: string, effort: string): void => {
      const rec = records.find((a) => a.id === agentId)
      const levels = rec?.effort_levels ?? []
      effortSelect.innerHTML = ''
      for (const lvl of levels) {
        const opt = document.createElement('option')
        opt.value = lvl
        opt.textContent = lvl
        effortSelect.append(opt)
      }
      effortSelect.disabled = levels.length === 0
      const effectiveEffort = levels.includes(effort)
        ? effort
        : rec?.default_effort && levels.includes(rec.default_effort)
          ? rec.default_effort
          : ''
      effortSelect.value = effectiveEffort

      const chromeOk = rec?.chrome_capable ?? false
      chromeToggle.disabled = !chromeOk
      if (!chromeOk) chromeToggle.checked = false
    }

    const selectedAgent = (): string => agentSelect.value
    syncDependents(selectedAgent() || current.agent, current.effort)
    chromeToggle.checked = current.chrome && !chromeToggle.disabled

    const commit = (): void =>
      onCommit({
        agent: selectedAgent(),
        effort: effortSelect.value,
        chrome: chromeToggle.checked,
      })

    agentSelect.addEventListener('change', () => {
      // New agent: select and persist its concrete default effort, then
      // re-gate chrome and write the fresh composition.
      syncDependents(selectedAgent(), '')
      chromeToggle.checked = chromeToggle.checked && !chromeToggle.disabled
      commit()
    })
    effortSelect.addEventListener('change', commit)
    chromeToggle.addEventListener('change', commit)
  }

  /**
   * Write the composed agent axes through the daemon's `set-agent` lifecycle
   * action — one validated write that sees base agent × effort × chrome
   * together. Effort is always a concrete registry token when the agent
   * supports that axis; chrome is always sent explicitly so a toggle-off is
   * unambiguous.
   */
  private async commitAxes(
    card: KanbanCard,
    axes: { agent: string; effort: string; chrome: boolean },
    statusEl: HTMLElement,
    errorEl: HTMLElement,
    onCommitted?: () => void,
  ): Promise<void> {
    if (!axes.agent) return
    errorEl.style.display = 'none'
    statusEl.textContent = 'Saving…'
    statusEl.classList.remove('kbn-detail-save-status-saved')
    statusEl.classList.add('kbn-detail-save-status-saving')
    try {
      await this.postLifecycle({
        action: 'set-agent',
        origin: card.originId,
        fiber: card.id,
        agent: axes.agent,
        effort: axes.effort,
        chrome: axes.chrome,
      })
      this.onSaved()
      statusEl.textContent = 'Saved'
      statusEl.classList.remove('kbn-detail-save-status-saving')
      statusEl.classList.add('kbn-detail-save-status-saved')
      window.setTimeout(() => {
        if (statusEl.textContent === 'Saved') {
          statusEl.textContent = ''
          statusEl.classList.remove('kbn-detail-save-status-saved')
        }
      }, 1500)
      onCommitted?.()
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      errorEl.textContent = msg
      errorEl.style.display = ''
      statusEl.textContent = ''
      statusEl.classList.remove('kbn-detail-save-status-saving')
    }
  }

  /**
   * Fetch the daemon's full fiber index once per panel-open (`GET
   * /api/v1/fibers`, ids + names only). The parent picker filters it
   * client-side per keystroke — the index is a few hundred rows, so this
   * replaces the retired Portolan `/kanban/fiber-search` round trip per
   * keystroke with one fetch and pure filtering.
   */
  private loadFiberIndex(): Promise<Array<{ id: string; name: string }>> {
    this.fiberIndex ??= fetchFiberIndex(this.shuttleBase).catch((err: unknown) => {
      // Don't cache a failure — the next keystroke retries.
      this.fiberIndex = null
      throw err
    })
    return this.fiberIndex
  }

  /**
   * Parent-picker search: one daemon index fetch per panel-open, then the
   * shared `filterParentCandidates` rule (the retired backend
   * `/kanban/fiber-search` semantics) per keystroke.
   */
  private async searchParents(
    q: string,
    excludeId: string,
    dropdown: HTMLElement,
    onSelect: (result: FiberSearchResult) => void,
  ): Promise<void> {
    // Concurrent triggers (focus + debounced input) can resolve the shared
    // index promise in the same microtask batch — without a token the two
    // renders interleave (clear, clear, append, append) and every option
    // doubles. Only the latest call may render.
    const token = ++this.searchRenderToken
    try {
      const allFibers = await this.loadFiberIndex()
      if (token !== this.searchRenderToken) return
      const data = { fibers: filterParentCandidates(allFibers, q, excludeId) }

      dropdown.innerHTML = ''
      if (data.fibers.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'kbn-detail-parent-option kbn-detail-parent-empty'
        empty.textContent = q ? 'No matches' : 'No fibers available'
        dropdown.append(empty)
        dropdown.style.display = ''
        return
      }

      for (const fiber of data.fibers) {
        const opt = document.createElement('button')
        opt.type = 'button'
        opt.className = 'kbn-detail-parent-option'
        opt.dataset.depth = String(fiber.depth)

        const nameSpan = document.createElement('span')
        nameSpan.className = 'kbn-detail-parent-option-name'
        nameSpan.textContent = fiber.name

        const idSpan = document.createElement('span')
        idSpan.className = 'kbn-detail-parent-option-id'
        idSpan.textContent = fiber.id

        opt.append(nameSpan, idSpan)
        opt.addEventListener('click', (e) => {
          e.stopPropagation()
          onSelect(fiber)
        })
        dropdown.append(opt)
      }
      dropdown.style.display = ''
    } catch {
      dropdown.innerHTML = '<div class="kbn-detail-parent-option kbn-detail-parent-empty">Search failed</div>'
      dropdown.style.display = ''
    }
  }

  /**
   * Promote a human card to a paused shuttle draft: `:4000/api/v1/lifecycle`
   * `install --disabled`, owner-routed by `origin`. `project_dir` (the
   * worker's cwd) comes from the card's owning city via
   * `resolveCityProjectPath`; a card with no resolvable city installs
   * without one, which a paused draft permits — arming it later supplies
   * the dir or fails loudly in shuttle-ctl.
   */
  private async promoteToShuttle(
    card: KanbanCard,
    agent: string,
    saveBtn: HTMLButtonElement,
    errorEl: HTMLElement,
  ): Promise<void> {
    try {
      const res = await fetch(`${this.shuttleBase}/api/v1/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'install',
          origin: card.originId,
          fiber: card.id,
          model: agent,
          project_dir: this.projectDirFor(card),
          disabled: true,
        }),
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => `${res.status}`)
        throw new Error(errText || `Promote failed: ${res.status}`)
      }
      this.close()
      this.onSaved()
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      errorEl.textContent = msg
      errorEl.style.display = ''
      saveBtn.disabled = false
      saveBtn.textContent = 'Promote to shuttle'
    }
  }

  /**
   * Apply a single-field (or coupled-field) change to the fiber's shuttle
   * block / parent immediately on event. Updates the status pill in place:
   * "Saving…" while the PATCH is in flight, "Saved" briefly on success,
   * error text in `errorEl` on failure. The panel stays open through all
   * outcomes — live edits don't close the inspector.
   *
   * Returns true on success so the caller can advance its local baseline.
   */
  private async livePatch(
    card: KanbanCard,
    changes: {
      shuttleAgent?: string
      shuttleKind?: 'oneshot' | 'standing'
      shuttleSchedule?: string
      shuttleTz?: string
      parentId?: string | null
    },
    statusEl: HTMLElement,
    errorEl: HTMLElement,
  ): Promise<boolean> {
    errorEl.style.display = 'none'
    statusEl.textContent = 'Saving…'
    statusEl.classList.remove('kbn-detail-save-status-saved')
    statusEl.classList.add('kbn-detail-save-status-saving')
    try {
      const origin = card.originId
      const fiberId = card.id

      const wantsReshape =
        changes.shuttleKind !== undefined ||
        typeof changes.shuttleSchedule === 'string' ||
        typeof changes.shuttleTz === 'string'

      if (wantsReshape) {
        // Kind/schedule/tz is a full uninstall + install/repeat reshape —
        // the shuttle-ctl writers refuse to clobber an existing block, so
        // the daemon's `/lifecycle` verbs are composed client-side, exactly
        // as Portolan's retired `/kanban/fiber-patch` composed shuttle-ctl
        // server-side. Current block state comes from the card.
        const targetKind: 'oneshot' | 'standing' =
          changes.shuttleKind ?? (card.shuttleKind === 'standing' ? 'standing' : 'oneshot')
        const targetAgent = changes.shuttleAgent || card.shuttleAgent
        const projectDir = this.projectDirFor(card)
        // A paused draft must stay paused across the reshape (install
        // defaults to armed; status `open` means draft).
        const wasDisabled = card.status === 'open'

        let reinstall: Record<string, unknown>
        if (targetKind === 'standing') {
          const schedule =
            (typeof changes.shuttleSchedule === 'string' && changes.shuttleSchedule.trim()) ||
            card.shuttleSchedule
          const tz =
            (typeof changes.shuttleTz === 'string' && changes.shuttleTz.trim()) ||
            card.shuttleTz || 'UTC'
          if (!schedule) {
            throw new Error('standing-kind shuttle blocks require a schedule (cron expression)')
          }
          reinstall = {
            action: 'repeat', origin, fiber: fiberId,
            schedule, tz, model: targetAgent, project_dir: projectDir,
          }
        } else {
          reinstall = {
            action: 'install', origin, fiber: fiberId,
            model: targetAgent, project_dir: projectDir, disabled: wasDisabled,
          }
        }

        // Uninstall first — install/repeat refuse to clobber. Skip when no
        // block exists yet (the patch installs fresh).
        if (card.shuttleKind !== undefined) {
          await this.postLifecycle({ action: 'uninstall', origin, fiber: fiberId })
        }
        await this.postLifecycle(reinstall)
      } else if (typeof changes.shuttleAgent === 'string' && changes.shuttleAgent) {
        // Agent-only change is the daemon's `set-model` lifecycle action —
        // preserves session.id + review history and the rest of the block.
        await this.postLifecycle({
          action: 'set-model', origin, fiber: fiberId, agent: changes.shuttleAgent,
        })
      }

      // Reparent: the daemon's `/felt-nest` shells `felt nest`/`felt unnest`
      // on the owning host. The grid refetch reconciles the changed id.
      if ('parentId' in changes) {
        const res = await fetch(`${this.shuttleBase}/api/v1/felt-nest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fiber_id: fiberId, origin, parent: changes.parentId ?? null }),
        })
        if (!res.ok) {
          const errText = await res.text().catch(() => `${res.status}`)
          throw new Error(errText || `Save failed: ${res.status}`)
        }
      }

      // Refresh the kanban so the change shows up in the grid (and in any
      // other modal that's reading the same card). The detail modal stays
      // open — the user may want to keep editing.
      this.onSaved()
      statusEl.textContent = 'Saved'
      statusEl.classList.remove('kbn-detail-save-status-saving')
      statusEl.classList.add('kbn-detail-save-status-saved')
      window.setTimeout(() => {
        // Fade the "Saved" indicator after a beat if nothing else has
        // overwritten it in the meantime.
        if (statusEl.textContent === 'Saved') {
          statusEl.textContent = ''
          statusEl.classList.remove('kbn-detail-save-status-saved')
        }
      }, 1500)
      return true
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      errorEl.textContent = msg
      errorEl.style.display = ''
      statusEl.textContent = ''
      statusEl.classList.remove('kbn-detail-save-status-saving')
      return false
    }
  }
}

/** Compact "2m / 3h / 5d ago" stamp for the sent-files launcher. A zero/absent
 *  timestamp (a rehydrated entry whose trail hasn't loaded) renders blank. */
function relativeTime(timestamp: number): string {
  if (!timestamp) return ''
  const deltaMs = Date.now() - timestamp
  if (deltaMs < 60_000) return 'just now'
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * Derive the user's home dir from a fiber's directory — the first two path
 * segments on macOS/Linux (`/Users/<name>` or `/home/<name>`). The
 * events.jsonl fallback reads `<home>/.portolan/data/events.jsonl`. Returns
 * null for a path too shallow to carry a home (or absent).
 */
/**
 * Give each sent file a display label that's unique within the trail. The data
 * sources (the `/api/v1/sent-files` endpoint and the events.jsonl parser) each
 * emit a bare path tail, so two distinct files both named `report.html` would be
 * indistinguishable in the launcher and the accordion. Where a basename
 * collides, walk up the path one parent segment at a time, prefixing
 * `parent-…/basename` (joined by `/`) until every colliding file's label is
 * distinct (e.g. `morning-post/report.html` vs `standalone-kanban/report.html`).
 * Files whose basename is already unique keep the bare name. The full path stays
 * available as the row/header `title` tooltip. Returns a new array; inputs are
 * not mutated (recency order is preserved).
 */
function disambiguateBasenames(files: SentFile[]): SentFile[] {
  const tail = (p: string) => p.split('/').filter(Boolean)
  const byBase = new Map<string, SentFile[]>()
  for (const f of files) {
    const base = tail(f.fullPath).pop() ?? f.fullPath
    ;(byBase.get(base) ?? byBase.set(base, []).get(base)!).push(f)
  }
  const labelFor = new Map<string, string>()
  for (const [base, group] of byBase) {
    if (group.length === 1) {
      labelFor.set(group[0].fullPath, base)
      continue
    }
    // Collision: extend each label leftward until all are distinct (or we run
    // out of parent segments — then the fullest path stands in).
    const segs = group.map((f) => tail(f.fullPath))
    let depth = 1
    const maxDepth = Math.max(...segs.map((s) => s.length))
    while (depth < maxDepth) {
      depth += 1
      const labels = segs.map((s) => s.slice(-depth).join('/'))
      if (new Set(labels).size === group.length) break
    }
    group.forEach((f, i) => labelFor.set(f.fullPath, segs[i].slice(-depth).join('/')))
  }
  return files.map((f) => ({ ...f, basename: labelFor.get(f.fullPath) ?? f.basename }))
}

function homeFromDir(dir: string | undefined): string | null {
  if (!dir || !dir.startsWith('/')) return null
  const segs = dir.split('/').filter(Boolean)
  if (segs.length < 2) return null
  return `/${segs[0]}/${segs[1]}`
}

/** The ULID embedded in a tmux session name (`<slug>-<ULID>-shuttle`). */
const TMUX_ULID_RE = /-([0-9A-HJKMNP-TV-Z]{26})-shuttle$/

/**
 * Parse a card's sent-files trail from a raw `events.jsonl` blob (the local
 * fallback for daemons that predate `/api/v1/sent-files`). Keeps `SendUserFile`
 * pre_tool_use events whose embedded fiber ULID (from `tmuxSession`) — or
 * `sessionId` — matches the card's uid, flattens `toolInput.files`, dedupes by
 * path keeping the newest, and sorts newest-first.
 */
function parseSentFilesFromEvents(text: string, uid: string, sessionId: string): SentFile[] {
  const byPath = new Map<string, SentFile>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let ev: {
      tool?: string
      tmuxSession?: string
      sessionId?: string
      timestamp?: number | string
      toolInput?: { files?: unknown }
    }
    try {
      ev = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (ev.tool !== 'SendUserFile') continue

    const tmuxUlid = typeof ev.tmuxSession === 'string'
      ? ev.tmuxSession.match(TMUX_ULID_RE)?.[1]
      : undefined
    const matches =
      (uid && (tmuxUlid === uid || ev.sessionId === uid)) ||
      (sessionId && ev.sessionId === sessionId)
    if (!matches) continue

    const files = Array.isArray(ev.toolInput?.files) ? ev.toolInput.files : []
    const ts = typeof ev.timestamp === 'number'
      ? ev.timestamp
      : typeof ev.timestamp === 'string'
        ? Date.parse(ev.timestamp) || 0
        : 0
    for (const f of files) {
      if (typeof f !== 'string' || !f) continue
      const prev = byPath.get(f)
      if (!prev || ts > prev.timestamp) {
        byPath.set(f, {
          fullPath: f,
          basename: f.split('/').filter(Boolean).pop() ?? f,
          timestamp: ts,
          sessionId: typeof ev.sessionId === 'string' ? ev.sessionId : undefined,
        })
      }
    }
  }
  return [...byPath.values()].sort((a, b) => b.timestamp - a.timestamp)
}
