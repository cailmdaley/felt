/**
 * ShelfReader — where reading happens, because the browser cannot.
 *
 * The board's canvas is SPATIAL MEMORY: a wall of live thumbnails you navigate
 * by recognising, where a card is a handle you move, resize and hold. It is
 * deliberately not a place to read — a 240px tile with a report squeezed into
 * it is a picture of a document, not a document.
 *
 * So the ↗ sends the file HERE: one window, over the canvas, in which opened
 * files accumulate as tabs. Open a second file and it joins the strip; open
 * one already open and its tab comes forward. The canvas keeps its arrangement
 * underneath, untouched.
 *
 * WHY AN IN-APP READER AND NOT A BROWSER TAB — the reason is environmental,
 * not aesthetic, and it is worth writing down because the obvious objection
 * ("the browser already has tabs, don't rebuild them") is correct everywhere
 * except here. Shuttle runs as a Safari dock web-app, which has NO TAB BAR:
 * every `window.open` — `_blank` included — is forced into a separate window.
 * A reader who opens four reports gets four windows scattered across the
 * desktop, and no script can gather them, because adding a tab to an existing
 * window is not something the web platform grants. The only way to make opens
 * ACCUMULATE is to own the tab strip. So we own it.
 *
 * WHAT IS REUSED, and it is nearly everything that matters:
 *   ../ReaderTabs           the tab-set arithmetic (open/activate/close, and
 *                           the never-a-second-tab rule), shared verbatim with
 *                           FiberDetailModal's viewer.
 *   ../ReaderChrome         the tab button and the view cell — the element tree
 *                           the shared stylesheet is written against.
 *   ../ReaderZoom           Cmd/Ctrl-wheel magnification, cursor-anchored.
 *   ../FileViewerPanel      `buildFileViewer` — the by-extension render
 *                           dispatch, so a file looks the same wherever the
 *                           board opens it.
 *   ../FloatingPanelChrome  drag + eight-zone resize.
 *   ../FiberDetailModal.css the window's vellum, bar, tabs and view cells —
 *                           the same stylesheet and the same class names, so
 *                           the two readers on the board are visibly one idea.
 * What is written here is the window's own lifecycle and its persistence.
 *
 * PERSISTENCE (`shuttle:shelf:reader`): the open tabs in order, which was
 * active, each tab's scroll offset and zoom, and the window's geometry.
 * Escape or ✕ dismisses the reader; the next ↗ brings it back with the strip
 * intact, because a reader you closed is not a reader you emptied.
 */

import '../FiberDetailModal.css'

import {
  attachPanelDrag,
  attachPanelResize,
  readPanelGeometry,
  type PanelGeometry,
} from '../FloatingPanelChrome.js'
import { buildFileViewer, isScrollableFile } from '../FileViewerPanel.js'
import {
  activateTab,
  closeTab,
  coerceTabRefs,
  emptyTabState,
  openTab,
  type TabRef,
  type TabState,
} from '../ReaderTabs.js'
import { buildTabButton, buildViewCell } from '../ReaderChrome.js'
import { applyZoom, zoomOnWheel, type ZoomableTab } from '../ReaderZoom.js'
import type { ShelfFile } from './shelfData.js'

export const READER_PERSIST_KEY = 'shuttle:shelf:reader'

const MIN_WIDTH = 380
const MIN_HEIGHT = 320

/** What survives a dismissal. */
export interface ReaderPersist {
  open: TabRef[]
  active?: string
  geom?: PanelGeometry
  /**
   * Is the reader DOCKED to the right of the canvas (the default), or has the
   * reader dragged it free to float?
   *
   * Docked is the default because a reader that opens over the canvas hides
   * cards, and hidden cards are the board's one unforgivable failure — the
   * whole surface is a spatial memory, and covering part of it is covering
   * part of what you remember. Docked, the canvas reflows into the half that
   * is left and nothing is lost, only smaller.
   */
  docked?: boolean
  /** The docked width, as a FRACTION of the board's width, so the split
   *  survives a window resize or a different display. */
  split?: number
}

export function emptyReaderPersist(): ReaderPersist {
  return { open: [] }
}

/** How much of the board the reader takes when it docks, and the range the
 *  divider may be dragged through. Below the floor the reader is too narrow to
 *  read in; above the ceiling the canvas stops being a canvas. */
export const SPLIT_DEFAULT = 0.5
export const SPLIT_MIN = 0.2
export const SPLIT_MAX = 0.8

export function clampSplit(split: number): number {
  if (!Number.isFinite(split)) return SPLIT_DEFAULT
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, split))
}

/**
 * Where a docked reader sits: the right `split` of the board's own rectangle,
 * full height. Measured from the BOARD, not the window — the board lives
 * inside a modal that need not span the screen, and a reader docked to the
 * window's edge would float away from the canvas it is supposed to be beside.
 */
export function dockedGeometry(board: PanelGeometry, split: number): PanelGeometry {
  const width = Math.max(MIN_WIDTH, Math.round(board.width * clampSplit(split)))
  return {
    left: Math.round(board.left + board.width - width),
    top: board.top,
    width,
    height: Math.max(MIN_HEIGHT, board.height),
  }
}

/** Coerce a parsed record into a reader state. Anything unreadable is a reader
 *  with nothing open — the window must be able to open either way. */
export function coerceReaderPersist(parsed: unknown): ReaderPersist {
  const out = emptyReaderPersist()
  if (!parsed || typeof parsed !== 'object') return out
  const rec = parsed as Record<string, unknown>
  out.open = coerceTabRefs(rec.open)
  const paths = new Set(out.open.map((r) => r.path))
  // An active tab that isn't in the strip is not an active tab. (A store
  // hand-edited, or written by a version that closed a tab without clearing
  // the pointer, would otherwise rehydrate showing nothing.)
  if (typeof rec.active === 'string' && paths.has(rec.active)) out.active = rec.active
  else if (out.open.length > 0) out.active = out.open[out.open.length - 1].path
  const geom = coerceGeometry(rec.geom)
  if (geom) out.geom = geom
  // Docked unless the store says otherwise: a record written before the dock
  // existed should open in the arrangement that hides nothing.
  out.docked = rec.docked !== false
  out.split = clampSplit(typeof rec.split === 'number' ? rec.split : SPLIT_DEFAULT)
  return out
}

function coerceGeometry(raw: unknown): PanelGeometry | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const n = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  const left = n(rec.left), top = n(rec.top), width = n(rec.width), height = n(rec.height)
  if (left === null || top === null || width === null || height === null) return null
  if (width < MIN_WIDTH || height < MIN_HEIGHT) return null
  return { left, top, width, height }
}

export function loadReaderPersist(storage?: Storage): ReaderPersist {
  const store = storage ?? safeStorage()
  if (!store) return emptyReaderPersist()
  try {
    const raw = store.getItem(READER_PERSIST_KEY)
    return raw ? coerceReaderPersist(JSON.parse(raw)) : emptyReaderPersist()
  } catch {
    return emptyReaderPersist()
  }
}

export function saveReaderPersist(state: ReaderPersist, storage?: Storage): void {
  const store = storage ?? safeStorage()
  if (!store) return
  try {
    if (state.open.length === 0 && !state.geom) store.removeItem(READER_PERSIST_KEY)
    else store.setItem(READER_PERSIST_KEY, JSON.stringify(state))
  } catch {
    /* storage full / disabled — persistence is best-effort */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

/**
 * A remembered geometry is usable only if it still lands on-screen — the
 * viewport may have shrunk, or moved to a smaller display, since it was saved.
 * (The same test the detail panel applies to its own windows.)
 */
export function onScreen(g: PanelGeometry, vw: number, vh: number): boolean {
  return g.left < vw - 80 && g.top < vh - 80 && g.left > 80 - g.width && g.top > -20
}

/** Where the reader opens when it has no memory: a broad column inset from the
 *  viewport, so the canvas stays visible around its edges — the reader is over
 *  the board, not instead of it. */
export function defaultReaderGeom(vw: number, vh: number): PanelGeometry {
  const width = Math.max(MIN_WIDTH, Math.min(1100, Math.round(vw * 0.62)))
  const height = Math.max(MIN_HEIGHT, Math.round(vh * 0.84))
  return {
    left: Math.max(12, Math.round(vw - width - Math.max(24, vw * 0.05))),
    top: Math.max(12, Math.round((vh - height) / 2)),
    width,
    height,
  }
}

// ── The live tab ─────────────────────────────────────────────────────────────

/**
 * One open file. Owns its tab button and its view cell; only the active cell
 * is shown, the rest stay built-but-hidden so switching tabs preserves scroll,
 * zoom and iframe load state — browser-tab style. The viewer is built lazily
 * on first view, so a rehydrated strip of eight tabs costs one iframe, not
 * eight.
 */
interface ReaderTab extends ZoomableTab {
  path: string
  file: ShelfFile
  tab: HTMLElement
  scroll: number
  built: boolean
  iframe: HTMLIFrameElement | null
}

export class ShelfReader {
  private readonly shuttleBase: () => string
  private persist: ReaderPersist
  private state: TabState<ReaderTab> = emptyTabState()
  private win: HTMLElement | null = null
  private strip: HTMLElement | null = null
  private views: HTMLElement | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  /** The board's own rectangle on screen, so a docked reader can sit beside
   *  the canvas rather than at the window's edge. */
  private readonly boardRect: () => PanelGeometry | null

  constructor(shuttleBase: () => string, boardRect: () => PanelGeometry | null = () => null) {
    this.shuttleBase = shuttleBase
    this.boardRect = boardRect
    this.persist = loadReaderPersist()
  }

  /**
   * Fires whenever the space the reader occupies changes: the fraction of the
   * board it has taken, or null when it is closed or floating free. The board
   * narrows its viewport to match, which is what makes this a SPLIT rather
   * than a window sitting on top of the work.
   */
  onDock: ((split: number | null) => void) | null = null

  isOpen(): boolean {
    return this.win !== null
  }

  /** The paths currently open — the board marks their cards. */
  openPaths(): string[] {
    return this.state.tabs.map((t) => t.path)
  }

  /** Called whenever the open set changes, so the board can re-mark cards. */
  onChange: (() => void) | null = null

  /**
   * Send a file to the reader: open the window if it is closed (restoring the
   * tabs it was closed with), then open or activate this file's tab.
   */
  open(file: ShelfFile): void {
    this.ensureWindow()
    this.activate(file)
    this.write()
  }

  /** Reopen the reader on whatever it held, with no new file. A no-op when it
   *  is already open or has never held anything. */
  reopen(): void {
    if (this.win || this.persist.open.length === 0) return
    this.ensureWindow()
  }

  /** Dismiss the reader. The tab strip is remembered, not emptied. */
  close(): void {
    if (!this.win) return
    // Only a floating window's rectangle is worth remembering; a docked one is
    // recomputed from the board every time it opens.
    if (!this.persist.docked) this.persist.geom = readPanelGeometry(this.win)
    this.onDock?.(null)
    this.harvest()
    this.win.remove()
    this.win = null
    this.strip = null
    this.views = null
    // The tabs and cells lived inside the window; the live set dies with it.
    // What they knew is already in `persist`.
    this.state = emptyTabState()
    this.write()
    this.onChange?.()
  }

  destroy(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (this.win) {
      if (!this.persist.docked) this.persist.geom = readPanelGeometry(this.win)
      this.onDock?.(null)
      this.harvest()
      this.win.remove()
    }
    this.win = null
    this.strip = null
    this.views = null
    this.state = emptyTabState()
    this.write()
  }

  // ── The window ─────────────────────────────────────────────────────────────

  private ensureWindow(): void {
    if (this.win) return

    const win = document.createElement('div')
    // The detail panel's frame and the file-viewer modifier, verbatim: this is
    // the same kind of window, so it is the same stylesheet.
    win.className = 'kbn-detail-overlay kbn-fileview-window'
    win.setAttribute('role', 'dialog')
    win.setAttribute('aria-label', 'Reader')

    const bar = document.createElement('div')
    bar.className = 'kbn-fileview-bar'

    const strip = document.createElement('div')
    strip.className = 'kbn-detail-tabstrip'
    strip.setAttribute('role', 'tablist')
    this.strip = strip

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'kbn-fileview-win-close'
    close.setAttribute('aria-label', 'Close the reader')
    close.title = 'Close the reader'
    close.textContent = '×'
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      this.close()
    })

    bar.append(strip, close)

    const views = document.createElement('div')
    views.className = 'kbn-detail-views'
    views.addEventListener('wheel', (e) => this.onZoomWheel(e), { passive: false })
    this.views = views

    win.append(bar, views)

    this.win = win
    win.classList.toggle('kbn-shelf-reader-docked', this.persist.docked === true)
    this.placeWindow()

    const remember = (): void => {
      if (this.win && !this.persist.docked) this.persist.geom = readPanelGeometry(this.win)
      this.write()
    }
    attachPanelDrag(win, bar, {
      draggingClass: 'kbn-detail-dragging',
      // Dragging the window by its bar is how you take it OFF the dock. The
      // gesture says "I want this somewhere else", and a docked window that
      // refused to move would be a window with a dead title bar.
      onMoved: () => this.undock(),
      onSettle: remember,
    })
    attachPanelResize(win, {
      handleClassPrefix: 'kbn-detail-rh',
      resizingClass: 'kbn-detail-resizing',
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      // While docked, the west edge IS the divider: every frame of the resize
      // re-reports the split so the canvas reflows under the reader's hand.
      onMove: () => this.reportSplit(),
      onSettle: () => {
        this.reportSplit()
        remember()
      },
    })

    document.body.append(win)
    this.reportSplit()
    this.rehydrate()
  }

  /**
   * Put the window where it belongs: the right of the board when docked, its
   * remembered (or default) rectangle when floating.
   *
   * Docked geometry is recomputed rather than remembered — the board's size is
   * the authority, so a window resize or a move to another display re-splits
   * correctly instead of restoring a rectangle that no longer fits anything.
   */
  private placeWindow(): void {
    const win = this.win
    if (!win) return
    const board = this.boardRect()
    let geom: PanelGeometry
    if (this.persist.docked && board) {
      geom = dockedGeometry(board, this.persist.split ?? SPLIT_DEFAULT)
    } else {
      const vw = window.innerWidth
      const vh = window.innerHeight
      geom =
        this.persist.geom && onScreen(this.persist.geom, vw, vh)
          ? this.persist.geom
          : defaultReaderGeom(vw, vh)
      this.persist.geom = geom
    }
    win.style.left = `${Math.max(0, geom.left)}px`
    win.style.top = `${Math.max(0, geom.top)}px`
    win.style.width = `${geom.width}px`
    win.style.height = `${geom.height}px`
  }

  /** Re-dock after the board's own rectangle changed (a window resize). */
  relayout(): void {
    if (!this.win || !this.persist.docked) return
    this.placeWindow()
  }

  /** Tell the board how much room the reader is taking, so it can narrow the
   *  canvas to match. */
  private reportSplit(): void {
    if (!this.win || !this.persist.docked) {
      this.onDock?.(null)
      return
    }
    const board = this.boardRect()
    if (!board || board.width <= 0) return
    const width = this.win.offsetWidth
    this.persist.split = clampSplit(width / board.width)
    this.onDock?.(this.persist.split)
  }

  /** Take the reader off the dock — it floats from here, and the canvas gets
   *  its full width back. */
  private undock(): void {
    if (!this.persist.docked) return
    this.persist.docked = false
    this.win?.classList.remove('kbn-shelf-reader-docked')
    this.onDock?.(null)
    this.write()
  }

  /** Rebuild the strip the reader was closed with. Tabs only — the active
   *  one's viewer is built by `setActive`, the rest stay cheap. */
  private rehydrate(): void {
    const refs = this.persist.open
    if (refs.length === 0) return
    for (const ref of refs) {
      this.activate(refToFile(ref), { scroll: ref.scroll ?? 0, zoom: ref.zoom ?? 1, show: false })
    }
    const active = this.persist.active ?? refs[refs.length - 1].path
    const entry = this.state.tabs.find((t) => t.path === active) ?? this.state.tabs[0]
    if (entry) this.setActive(entry)
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────

  /**
   * Open `file`, or bring its tab forward if it is already open. The single
   * door — the ↗ and rehydration both come through it, so the never-duplicate
   * rule holds for both.
   */
  private activate(
    file: ShelfFile,
    opts?: { scroll?: number; zoom?: number; show?: boolean },
  ): void {
    const result = openTab(this.state, file.fullPath, () =>
      this.buildTab(file, opts?.scroll ?? 0, opts?.zoom ?? 1),
    )
    this.state = result.state
    // Rehydration builds the whole strip before showing anything: `setActive`
    // runs once, at the end, so eight restored tabs cost one viewer.
    if (opts?.show === false) return
    this.setActive(result.entry)
    this.onChange?.()
  }

  private buildTab(file: ShelfFile, scroll: number, zoom: number): ReaderTab {
    const { tab: tabEl, closeBtn } = buildTabButton(file.basename, file.fullPath)
    const cell = buildViewCell()

    const entry: ReaderTab = {
      path: file.fullPath,
      file,
      tab: tabEl,
      cell,
      scroll,
      zoom,
      built: false,
      iframe: null,
      zoomTarget: null,
      baseW: 0,
    }

    tabEl.addEventListener('click', () => {
      this.state = activateTab(this.state, entry.path)
      this.setActive(entry)
      this.write()
    })
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.closeOne(entry.path)
    })

    this.strip?.append(tabEl)
    this.views?.append(cell)
    return entry
  }

  private setActive(entry: ReaderTab): void {
    this.state = { tabs: this.state.tabs, active: entry.path }
    for (const t of this.state.tabs) {
      const on = t === entry
      t.cell.hidden = !on
      t.tab.classList.toggle('kbn-detail-tab-active', on)
      t.tab.setAttribute('aria-selected', String(on))
    }
    // Show first, build second: a freshly-built image measures the now-visible
    // cell for its fit-to-width base.
    if (!entry.built) this.buildViewer(entry)
  }

  private closeOne(path: string): void {
    const { state, closed } = closeTab(this.state, path)
    if (!closed) return
    this.state = state
    closed.tab.remove()
    closed.cell.remove()
    const next = state.active ? state.tabs.find((t) => t.path === state.active) : null
    if (next) this.setActive(next)
    if (state.tabs.length === 0) {
      // The last tab closing closes the reader — an empty window is furniture.
      this.close()
      return
    }
    this.write()
    this.onChange?.()
  }

  private buildViewer(entry: ReaderTab): void {
    if (entry.built) return
    entry.built = true
    const origin = entry.file.host ?? 'local'
    const viewer = buildFileViewer(
      this.shuttleBase(),
      entry.path,
      origin,
      isScrollableFile(entry.path)
        ? (iframe) => {
            entry.iframe = iframe
            try {
              iframe.contentWindow?.scrollTo(0, entry.scroll)
              const win = iframe.contentWindow
              win?.addEventListener(
                'scroll',
                () => {
                  entry.scroll = win.scrollY
                  this.writeSoon()
                },
                { passive: true },
              )
            } catch {
              /* cross-origin / unreadable — no scroll restore */
            }
          }
        : undefined,
      { fiberId: entry.file.uid },
    )
    entry.cell.append(viewer)
    entry.zoomTarget = viewer.querySelector<HTMLElement>('img.kbn-fileview-image') ?? viewer
    applyZoom(entry)
  }

  // ── Zoom ───────────────────────────────────────────────────────────────────

  /** Cmd/Ctrl + wheel magnifies the file under the cursor, anchored on it. The
   *  gesture is `ReaderZoom`'s, shared with the detail panel's viewer; this side
   *  only says which tab is under the pointer, and saves if it moved. */
  private onZoomWheel(e: WheelEvent): void {
    const entry = this.state.tabs.find((t) => t.path === this.state.active)
    if (zoomOnWheel(e, entry)) this.writeSoon()
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  /** Read the live tabs back into the persist record — done before the window
   *  (and with it every tab's scroll and zoom) is torn down. Unconditional: an
   *  emptied strip must EMPTY the record, or the next open resurrects tabs the
   *  reader closed. */
  private harvest(): void {
    this.persist.open = this.state.tabs.map((t) => tabToRef(t))
    this.persist.active = this.state.active ?? undefined
  }

  private write(): void {
    if (this.win) this.harvest()
    saveReaderPersist(this.persist)
  }

  /** Coalesce a scroll's or a zoom's worth of updates into one write. */
  private writeSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.write()
    }, 400)
  }
}

function tabToRef(t: ReaderTab): TabRef {
  const ref: TabRef = { path: t.path, basename: t.file.basename }
  if (t.file.host) ref.host = t.file.host
  if (t.scroll) ref.scroll = t.scroll
  if (t.zoom !== 1) ref.zoom = t.zoom
  return ref
}

/** The least a rehydrated tab needs to be a file: the path it names, the label
 *  it was shown under, and the host that holds it. A file that has since aged
 *  off the board still reads here — the reader holds what you opened, not what
 *  the canvas currently shows. */
function refToFile(ref: TabRef): ShelfFile {
  return {
    fullPath: ref.path,
    basename: ref.basename ?? (ref.path.split('/').pop() || ref.path),
    timestamp: 0,
    ...(ref.host ? { host: ref.host } : {}),
  }
}
