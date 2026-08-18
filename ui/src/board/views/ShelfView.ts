/**
 * ShelfView (hotkey 5) — the BOARD: the sent work, as a surface rather than a
 * list. ("Shelf" is the internal name, kept in the id, the storage keys and
 * these module names; the reader sees "board".)
 *
 * Everything a worker pushed with `SendUserFile` in the last month, each file
 * a card: the report renders inside its frame, the plot draws, the page is the
 * thing itself and not a link to it. Which is the whole argument for a canvas.
 * A list of filenames is an index of work; a wall of rendered pages is the
 * work, and you find the one you want by recognising it.
 *
 * A CARD IS TWO LAYERS. The FACE — name, fiber, age, kind — is synchronous,
 * free, and the card's resting state; it is never a skeleton, because a face
 * is not a placeholder for content, it is content. The BODY — the iframe, the
 * image, the page of text — is expensive, finite, and mortal: it mounts when
 * the card comes near the viewport and is taken down again when the board has
 * more live bodies than it can carry (shelfLoad). The old board mounted bodies
 * and never took one down, which is how a skimmable surface became the
 * slowest page in the browser.
 *
 * CARDS ARE HANDLES, NEVER FACTORIES. Everything you can do to a card here
 * rearranges the canvas; nothing on a card makes another card. Drag the header
 * to move it, the corner to resize it, the ✶ to hold it where it is, click its
 * body to make the frame live. The one rule behind all of it is that a CLICK
 * IS NOT A DRAG — see shelfGesture, which exists because conflating the two
 * made a click on a card's name look like the card had spawned a copy.
 *
 * NOTHING OVERLAPS, except a pile of one fiber's work. Cards are bodies with
 * volume: drag one onto its neighbours and they move out of the way, live,
 * every frame (shelfPack). The flow routes around the cards you placed rather
 * than being shoved off its grid by them.
 *
 * READING HAPPENS IN THE READER. The ↗ sends the file to ShelfReader — one
 * overlay window with its own tab strip, where opens accumulate. Shuttle runs
 * as a Safari dock web-app, which has no tab bar: every `window.open`,
 * `_blank` included, becomes a separate WINDOW, and no script may add a tab to
 * an existing one. Owning the tab strip is therefore the only way opens can
 * gather in one place. See ShelfReader's docstring — the constraint is the
 * whole argument.
 *
 * THREE STATES a card can be in, and the view is mostly about the boundaries
 * between them:
 *
 *   flowed    the lens arranged it (see shelfLayout)
 *   placed    you arranged it — dragged, resized, or starred
 *   focused   the frame is live under your pointer. Click away or press
 *             Escape and it goes back to being a tile you can drag.
 *
 * The veil is not decoration. An iframe swallows every pointer event that
 * lands on it, so a canvas of live frames is a canvas you cannot pan or drag
 * — the transparent sheet over each card is what gives the surface its
 * gestures back, and lifting it is exactly what "focus" means here.
 *
 * ZOOM IS A CAMERA UNTIL A CARD FILLS THE SCREEN, THEN IT IS A READER.
 * One transform on the surface scales everything — chrome, text, and the
 * documents inside the frames alike — which is right for a wall of thumbnails
 * and wrong for the moment you have zoomed until one report fills the viewport:
 * a magnified 225px page is 225px of layout drawn enormous, not a page. So past
 * a threshold ONE card is PROMOTED (see syncPromotion): its real DOM box is
 * multiplied by the zoom and its own transform carries the reciprocal scale, so
 * it occupies exactly the same rectangle on screen while its composite scale is
 * 1. Its iframe's viewport is then genuinely large, and the document inside
 * reflows and paints at native pixel size — text you can read, not text made
 * big. No reparenting is involved, deliberately: moving an iframe between
 * parents reloads its document, which would throw away the page mid-read.
 *
 * ONE ORDER, AND IT IS RECENCY. The flow fills top-left to bottom-right, so
 * time has a direction on the surface. There is no lens toggle any more: a
 * fiber's sends are ONE STACK — one tile, newest sheet face up — and the
 * ‹ 2/7 › strip on its edge leafs back through the older ones IN PLACE, with
 * nothing else on the board moving while you do it. That is what the by-fiber
 * lens was reaching for, except a tile per fiber rather than a band per fiber,
 * which is the difference between a board of ten things and a board of a
 * hundred.
 *
 * ONLY THE FACE OF A STACK IS A CARD. The sheets underneath have no DOM and so
 * no body, which is the perf shape of the whole arrangement: a ten-file fiber
 * costs one iframe, not ten. Leafing to another sheet builds that one card and
 * drops the one it replaced, so the live-body budget (shelfLoad) is spent on
 * what is actually face up.
 */

import './ShelfView.css'

import {
  keystrokeIsSpokenFor,
  registerView,
  type TemporalView,
  type ViewContext,
} from './ViewRegistry.js'
import { createViewEmptyState, createViewPage } from './ViewPage.js'
import { isOriginStale, type TemporalOrigins } from './TemporalData.js'
import {
  dedupeByPath,
  fetchShelf,
  fileUrl,
  shelfKind,
  type ShelfFile,
  type ShelfKind,
} from './shelfData.js'
import {
  buildStacks,
  clampZoom,
  emptyPersist,
  FLOW_MIN_W,
  isPlaced,
  layoutShelf,
  loadShelfPersist,
  resetLayout,
  saveShelfPersist,
  SHELF_METRICS,
  type ShelfCardState,
  type ShelfLayout,
  type ShelfPersist,
  type ShelfStack,
} from './shelfLayout.js'
import {
  advanceGesture,
  beginGesture,
  framePointToClient,
  settleGesture,
  wheelZoomFactor,
  type ShelfGesture,
} from './shelfGesture.js'
import { packShelf, type PackCard } from './shelfPack.js'
import { choosePromotion, type PromoteCandidate } from './shelfPromote.js'
import { ShelfReader } from './ShelfReader.js'
import {
  chooseEvictions,
  chooseLoads,
  LOAD_POLICY,
  MAX_CARDS,
  matchesQuery,
  mostRecent,
  TextCache,
  type BodyState,
} from './shelfLoad.js'

/** How far back the board reaches. A month is the span over which "did I send
 *  that already?" is still a live question; beyond it the canvas would be an
 *  archive, which is a different surface. */
const SHELF_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** The seam between the canvas and a docked reader. A divider, not a gutter:
 *  wide enough to read as an edge, narrow enough that no card-sized strip of
 *  canvas is lost to it. The grab zone for dragging it is wider (see the
 *  docked-reader rules in ShelfView.css) and overlaps the reader's edge. */
const DIVIDER = 6

/** How long after a real drag a double-click is ignored. Long enough to cover
 *  the release-and-click-again that a browser will happily report as a
 *  double-click, short enough to be invisible to anyone who meant one. */
const DBLCLICK_AFTER_DRAG_MS = 350

/** A card, as the view holds it: the file, its DOM, and the state of its body. */
interface CardHandle {
  file: ShelfFile
  kind: ShelfKind
  root: HTMLElement
  /** The metadata layer. Always mounted, hidden only under a live body. */
  face: HTMLElement
  /** Where the body mounts. */
  host: HTMLElement
  ageEl: HTMLElement
  dismissEl: HTMLElement
  /** The paging strip along the card's foot, shown only when this card is the
   *  face of a stack with something under it. */
  stackEl: HTMLElement
  stackLabel: HTMLElement
  state: BodyState
  body: HTMLElement | null
  /** Inside the ring right now? */
  visible: boolean
  /** When it was last inside the ring — the eviction key. */
  lastVisible: number
  /** Distance from the viewport centre at the last pump, for load ordering. */
  distance: number
  timer: number | null
  /** The file changed under a live body; the card offers a reload rather than
   *  swapping the document out from under the reader. */
  stale: boolean
  /** Undoes the wheel listener planted inside a same-origin frame's own
   *  document, so the pinch a focused card swallows still zooms the board. */
  unframeWheel: (() => void) | null
}

class ShelfView implements TemporalView {
  readonly id = 'shelf' as const
  // What the reader calls this surface. The internal id stays `shelf` (as do
  // the storage keys and the module names) — renaming those would be churn
  // through half the board for no reader-visible gain.
  readonly title = 'Board'
  readonly hotkey = '5'

  private ctx: ViewContext | null = null
  private viewport: HTMLElement | null = null
  private surface: HTMLElement | null = null
  private emptyEl: HTMLElement | null = null
  private searchEl: HTMLInputElement | null = null

  /** Everything fetched, newest first, capped at MAX_CARDS. */
  private files: ShelfFile[] = []
  /** What the search leaves — the files the surface is made of. */
  private shown: ShelfFile[] = []
  /** Those files gathered into tiles: one per fiber, plus the loners. */
  private stacks: ShelfStack[] = []
  /** Which sheet of each fiber's stack is face up, for the fibers the reader
   *  has leafed through. In memory only: a reading position is not a fact
   *  about the work, and a board reopened tomorrow should show what is newest,
   *  not where you happened to stop. */
  private readonly leafed: Record<string, string> = {}
  private query = ''
  private origins: TemporalOrigins = {}
  private persist: ShelfPersist = emptyPersist()
  /** Paths the reader has put away, as a set for the filter. */
  private dismissed = new Set<string>()
  /** Are the put-away cards being shown (so they can be taken back)? */
  private showDismissed = false
  private hiddenEl: HTMLElement | null = null
  private readonly handles = new Map<string, CardHandle>()
  private observer: IntersectionObserver | null = null
  private focused: string | null = null
  /** The one card, if any, currently living at its true size instead of at the
   *  camera's. See syncPromotion. */
  private promoted: string | null = null
  /** The point the last pinch was anchored on, in SURFACE coordinates — what
   *  syncPromotion reads to know which card the reader is zooming INTO. Null
   *  until the camera is first zoomed; see PromoteView.focusX. */
  private zoomAnchor: { x: number; y: number } | null = null
  private zTop = 10
  private loading = false

  private readonly textCache = new TextCache()
  private reader: ShelfReader | null = null
  /** Was the reader open when this view was last left? The view object
   *  outlives its DOM (one instance is registered for the app's life), so
   *  leaving the board and coming back can put the reader back as it was
   *  instead of making the reader re-open every tab by hand. */
  private readerWasOpen = false
  /** The fraction of the board the docked reader has taken, or null when it is
   *  closed or floating free. */
  private dockSplit: number | null = null
  /** When the last gesture that actually travelled let go. */
  private lastDragEnd = 0

  /** The card the layout must not move: the one under the pointer, or the one
   *  just dropped. Its neighbours are the ones that yield. */
  private activeCard: string | null = null
  private pushFrame: number | null = null
  private pumpFrame: number | null = null
  private sweepTimer: ReturnType<typeof setTimeout> | null = null
  /** Where every card sat when the current drag began — the arrangement the
   *  collision solve starts from on every frame. */
  private dragBase: Map<string, { x: number; y: number; w: number; h: number }> | null = null
  /** Bodies taken down for the duration of a resize, to be put back after. */
  private demoted: string[] = []

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  mount(host: HTMLElement, ctx: ViewContext): void {
    this.ctx = ctx
    this.persist = loadShelfPersist()
    this.dismissed = new Set(this.persist.dismissed)
    this.reader = new ShelfReader(
      () => this.ctx?.shuttleBase ?? '',
      () => this.boardRect(),
    )
    this.reader.onChange = () => this.syncReading()
    this.reader.onDock = (split) => this.applyDock(split)

    const page = createViewPage(this.title)
    page.titleRow.append(this.buildSearch(), this.buildTools())

    this.viewport = document.createElement('div')
    this.viewport.className = 'kbn-shelf-viewport'
    this.surface = document.createElement('div')
    this.surface.className = 'kbn-shelf-surface'
    this.viewport.append(this.surface)
    page.body.append(this.viewport)
    host.append(page.root)

    // The ring: a card this close to the viewport is worth a body. Wider than
    // the viewport so a scroll lands on something already drawn, narrow enough
    // that a board of a hundred cards is not a hundred documents.
    this.observer = new IntersectionObserver(
      (entries) => {
        const now = Date.now()
        for (const entry of entries) {
          const path = (entry.target as HTMLElement).dataset.path
          const handle = path ? this.handles.get(path) : null
          if (!handle) continue
          handle.visible = entry.isIntersecting
          handle.lastVisible = now
        }
        this.pump()
      },
      { root: this.viewport, rootMargin: LOAD_POLICY.ring },
    )

    this.viewport.addEventListener('pointerdown', this.onSurfacePointerDown)
    this.viewport.addEventListener('wheel', this.onWheel, { passive: false })
    document.addEventListener('keydown', this.onKeyDown, true)
    document.addEventListener('visibilitychange', this.onVisibility)

    window.addEventListener('resize', this.onResize)

    this.applyPan()
    void this.load()
    // The reader outlives the view's DOM, so a board reopened while it was
    // open restores the split too — after the first layout, so it has a board
    // rectangle to dock against.
    if (this.readerWasOpen) requestAnimationFrame(() => this.reader?.reopen())
  }

  /**
   * The canvas's rectangle on screen — what a docked reader splits.
   *
   * Measured from the viewport's PARENT, whose width does not change when the
   * canvas narrows. Deriving the full width from the narrowed viewport instead
   * (`r.width / (1 - split)`) makes the divider's own thickness compound
   * through the division, so the reader creeps a few pixels further left on
   * every re-dock and the seam never settles.
   */
  private boardRect(): { left: number; top: number; width: number; height: number } | null {
    const host = this.viewport?.parentElement
    if (!host) return null
    const r = host.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }

  /**
   * Give the reader its half.
   *
   * The canvas narrows rather than being covered: cards reflow into the space
   * that is left, so nothing ends up underneath the reader. That is the whole
   * point of a split over a floating window here — a board is a spatial
   * memory, and a panel laid over it hides exactly the thing you were trying
   * to remember.
   */
  private applyDock(split: number | null): void {
    if (this.dockSplit === split) return
    this.dockSplit = split
    const vp = this.viewport
    if (!vp) return
    // The canvas takes what the reader does not, less the divider — a seam of
    // a few pixels, not a margin. Everything else on this side must be zero:
    // the flow now flexes its columns to whatever width it is given
    // (shelfLayout.flowMetrics), so any padding left here would be dead canvas
    // that no arrangement can ever use.
    vp.style.width = split === null ? '' : `calc(${(1 - split) * 100}% - ${DIVIDER}px)`
    // The viewport's new width changes how many columns the flow has, so the
    // layout must follow the divider — after the browser has applied it.
    requestAnimationFrame(() => {
      this.reflow()
      this.pump()
    })
  }

  private readonly onResize = (): void => {
    this.reader?.relayout()
    this.reflow()
    this.pump()
  }

  refresh(ctx: ViewContext): void {
    this.ctx = ctx
    void this.load()
  }

  unmount(): void {
    document.removeEventListener('keydown', this.onKeyDown, true)
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('resize', this.onResize)
    this.viewport?.removeEventListener('pointerdown', this.onSurfacePointerDown)
    this.viewport?.removeEventListener('wheel', this.onWheel)
    this.endGesture()
    this.readerWasOpen = this.reader?.isOpen() ?? false
    this.reader?.destroy()
    this.reader = null
    if (this.pumpFrame !== null) cancelAnimationFrame(this.pumpFrame)
    if (this.sweepTimer) clearTimeout(this.sweepTimer)
    if (this.layerTimer) clearTimeout(this.layerTimer)
    this.pumpFrame = null
    this.sweepTimer = null
    this.layerTimer = null
    // Every body dies with the view — an orphaned iframe keeps its whole JS
    // realm alive behind a page the reader has left.
    for (const handle of this.handles.values()) this.evictBody(handle)
    this.observer?.disconnect()
    this.observer = null
    this.handles.clear()
    this.promoted = null
    this.viewport = this.surface = this.emptyEl = null
    this.searchEl = null
    this.ctx = null
    this.signature = ''
    this.firstPaint = true
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    const ctx = this.ctx
    // A hidden tab polls nothing. The refresh on becoming visible catches up.
    if (!ctx || this.loading || document.hidden) return
    this.loading = true
    try {
      const result = await fetchShelf(ctx.shuttleBase, Date.now() - SHELF_WINDOW_MS)
      if (!this.surface) return
      this.files = mostRecent(dedupeByPath(result.files), MAX_CARDS)
      this.origins = result.origins
      this.applyQuery()
    } finally {
      this.loading = false
    }
  }

  private readonly onVisibility = (): void => {
    if (!document.hidden) void this.load()
  }

  /** The signature of the file set last laid out, so a 15s poll that changes
   *  nothing does not touch the canvas under the user's hands. */
  private signature = ''

  /**
   * Reconcile the cards on the surface with the files that should be there.
   *
   * INCREMENTAL, and that is the point: a poll that returns the same files
   * must not tear down the cards, because rebuilding an iframe every fifteen
   * seconds loses its scroll position and rebuilding one mid-drag loses the
   * drag. New files get new cards, departed files lose theirs, and a file
   * whose bytes changed under a LIVE body is marked stale rather than
   * hot-swapped — the reader decides when the page they are reading reloads.
   *
   * THE CARDS ARE THE STACK FACES, not the files. Everything below a face is
   * data on the tile above it and has no DOM at all, so a fiber that sent forty
   * files costs one card and one body. The signature therefore covers the faces
   * AND the depths — a new send that lands under an unchanged face still has to
   * repaint the strip that counts it.
   */
  private syncCards(): void {
    const surface = this.surface
    if (!surface) return

    this.stacks = buildStacks(this.shown, this.persist.cards, this.leafed)
    const faces = this.stacks.map((s) => s.face)

    const sig = this.stacks
      .map((s) => `${s.face.fullPath}@${s.face.timestamp}/${s.files.length}`)
      .join('')
    if (sig === this.signature) return
    this.signature = sig

    this.emptyEl?.remove()
    this.emptyEl = null
    if (faces.length === 0) {
      for (const path of [...this.handles.keys()]) this.dropCard(path)
      this.emptyEl = createViewEmptyState(
        this.query ? '— nothing matches —' : '— nothing sent yet —',
      )
      surface.append(this.emptyEl)
      this.reflow()
      return
    }

    const wanted = new Set(faces.map((f) => f.fullPath))
    for (const path of [...this.handles.keys()]) {
      if (!wanted.has(path)) this.dropCard(path)
    }

    for (const file of faces) {
      const handle = this.handles.get(file.fullPath)
      if (!handle) {
        const built = this.buildCard(file)
        this.handles.set(file.fullPath, built)
        surface.append(built.root)
        this.observer?.observe(built.root)
        continue
      }
      if (handle.file.timestamp === file.timestamp) continue
      // The file was sent again. A card showing nothing yet can simply take
      // the new bytes; a card the reader may be reading says so and waits.
      handle.file = file
      handle.ageEl.textContent = relativeAge(file.timestamp, Date.now())
      if (handle.state === 'live') this.markStale(handle)
      else if (handle.state !== 'idle') this.evictBody(handle)
    }

    this.syncDismissMarks()
    this.syncReading()
    // The first paint lands without a transition: cards sliding in from the
    // origin would read as an animation the data did not ask for.
    this.reflow(this.firstPaint)
    this.firstPaint = false
    this.pump()
  }

  private firstPaint = true

  /** A card on the surface only because the reader asked to see what they had
   *  put away wears its dismissal plainly, and its glyph offers the way back. */
  private syncDismissMarks(): void {
    for (const [path, handle] of this.handles) {
      const away = this.dismissed.has(path)
      handle.root.classList.toggle('kbn-shelf-card-dismissed', away)
      handle.dismissEl.textContent = away ? '↺' : '×'
      handle.dismissEl.title = away ? 'Put this card back' : 'Hide this card'
      handle.dismissEl.setAttribute('aria-label', away ? 'Restore' : 'Hide')
    }
  }

  private dropCard(path: string): void {
    const handle = this.handles.get(path)
    if (!handle) return
    this.evictBody(handle)
    this.observer?.unobserve(handle.root)
    handle.root.remove()
    this.handles.delete(path)
    if (this.focused === path) this.focused = null
    if (this.promoted === path) this.promoted = null
  }

  // ── Chrome ─────────────────────────────────────────────────────────────────

  /** The search field: one quiet line of the board's own hand. It filters what
   *  is already here and never fetches — the board holds a bounded window, and
   *  searching it is a matter of hiding cards, not asking the daemon again. */
  private buildSearch(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'kbn-shelf-search'
    const input = document.createElement('input')
    input.type = 'search'
    input.className = 'kbn-shelf-search-input'
    input.placeholder = 'find'
    input.setAttribute('aria-label', 'Filter cards by name or fiber')
    input.value = this.query
    input.addEventListener('input', () => {
      this.query = input.value
      this.applyQuery()
    })
    // Escape inside the field clears it rather than closing the board.
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (!input.value) {
        input.blur()
        return
      }
      input.value = ''
      this.query = ''
      this.applyQuery()
    })
    wrap.append(input)
    this.searchEl = input
    return wrap
  }

  private applyQuery(): void {
    this.shown = this.files.filter(
      (f) =>
        matchesQuery(f, this.query) &&
        (this.showDismissed || !this.dismissed.has(f.fullPath)),
    )
    this.searchEl?.classList.toggle('kbn-shelf-search-on', this.query.trim() !== '')
    this.syncCards()
  }

  /**
   * Put a card away, or take it back.
   *
   * Dismissal is by PATH and it persists, so a file sent again does not return
   * from the dead — which is the whole point: the cards you dismiss are the
   * ones a busy fiber keeps re-sending. Its placement goes with it, so taking
   * it back gives you a card in the flow rather than one in a spot you chose
   * for it a week ago.
   */
  private toggleDismissed(path: string): void {
    if (this.dismissed.has(path)) {
      this.dismissed.delete(path)
    } else {
      this.dismissed.add(path)
      delete this.persist.cards[path]
      if (this.focused === path) this.focus(null)
    }
    this.persist.dismissed = [...this.dismissed]
    this.save()
    this.syncTools()
    this.applyQuery()
  }

  /**
   * The two housekeeping controls, in the board's quiet chrome hand: put the
   * furniture back, and a count of what has been put away.
   *
   * The hidden count is not decoration — a dismissal that cannot be seen is a
   * black hole, and a reader who puts away the wrong card would have no way to
   * learn that it is still there. It appears only when there is something to
   * report, and clicking it brings the put-away cards back onto the surface
   * (faded, each wearing a restore glyph) so they can be taken back one by one.
   */
  private buildTools(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'kbn-shelf-tools'

    const reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'kbn-shelf-tool'
    reset.textContent = 'reset'
    reset.title = 'Put every card back in the flow (stars are kept)'
    reset.addEventListener('click', () => this.resetLayout())

    const hidden = document.createElement('button')
    hidden.type = 'button'
    hidden.className = 'kbn-shelf-tool kbn-shelf-hidden'
    hidden.addEventListener('click', () => {
      this.showDismissed = !this.showDismissed
      this.syncTools()
      this.applyQuery()
    })
    this.hiddenEl = hidden

    wrap.append(reset, hidden)
    this.syncTools()
    return wrap
  }

  private syncTools(): void {
    const el = this.hiddenEl
    if (!el) return
    const n = this.dismissed.size
    el.hidden = n === 0
    el.textContent = this.showDismissed ? `${n} hidden · done` : `${n} hidden · show`
    el.title = this.showDismissed
      ? 'Stop showing the put-away cards'
      : 'Show the put-away cards so they can be taken back'
    el.classList.toggle('kbn-shelf-tool-on', this.showDismissed)
  }

  /** Hand the whole surface back to the flow. Cheap to redo, so no
   *  confirmation — the cards are all still here, only their arrangement goes. */
  private resetLayout(): void {
    this.persist = resetLayout(this.persist)
    this.save()
    this.applyZoom()
    // Every hand placement is gone, so every card it had pulled out of a stack
    // rejoins one: the tiles are rebuilt before they are placed.
    this.syncCards()
    this.reflow()
    this.pump()
  }

  /**
   * Leaf a fiber's stack to another sheet.
   *
   * The tile does not move: a stack's place in the flow is its NEWEST member's
   * age (shelfLayout), so paging back through a fiber's history leaves the
   * board's arrangement exactly as it was and only changes what is face up.
   *
   * It wraps at both ends. Seven sheets in a footprint is a thing you flick
   * through, and a strip that dead-ends at 7/7 makes you travel all the way
   * back to see the newest again.
   */
  private leaf(uid: string, delta: number): void {
    const stack = this.stacks.find((s) => s.uid === uid)
    if (!stack || stack.files.length < 2) return
    const at = stack.files.indexOf(stack.face)
    const next = stack.files[(at + delta + stack.files.length) % stack.files.length]
    this.leafed[uid] = next.fullPath
    this.syncCards()
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  /**
   * Position every card, and tell each stack how deep it is.
   *
   * `immediate` suppresses the reflow transition for the first paint — cards
   * sliding in from the origin on mount would read as an animation the data
   * did not ask for.
   */
  private reflow(immediate = false): ShelfLayout | null {
    const surface = this.surface
    if (!surface) return null
    // The flow's width is the UNSCALED viewport, deliberately. Zoom is a
    // camera, not a layout parameter: letting the column count follow the
    // scale would re-lay the whole board on every zoom step, and the thing you
    // zoomed out to look at would be somewhere else by the time you got there.
    // `clientWidth` already excludes any scrollbar, and the flow flexes to
    // fill exactly what it is handed, so nothing is shaved off here — a
    // "safety" margin would be permanent dead canvas.
    const width = Math.max(this.viewport?.clientWidth ?? 0, FLOW_MIN_W)
    const layout = layoutShelf(
      this.stacks,
      this.persist.cards,
      { ...SHELF_METRICS, width },
      this.activeCard,
    )

    if (immediate) surface.classList.add('kbn-shelf-still')

    for (const card of layout.cards) {
      const handle = this.handles.get(card.file.fullPath)
      if (!handle) continue
      this.placeCard(handle, card.x, card.y)
      this.sizeCard(handle, card.w, card.h)
      handle.root.classList.toggle('kbn-shelf-card-pinned', card.pinned)
      handle.root.classList.toggle('kbn-shelf-card-starred', card.starred)
      this.syncStack(handle, card.stack)
    }

    surface.style.width = `${layout.width}px`
    surface.style.height = `${layout.height + 40}px`
    this.clampPan()
    this.syncPromotion()

    if (immediate) {
      // Two frames: one for the browser to commit the positions, one for the
      // class removal to land after they are already where they belong.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => surface.classList.remove('kbn-shelf-still')),
      )
    }
    return layout
  }

  /**
   * Dress a card as the face of its stack — or undress it when the stack has
   * fallen to one.
   *
   * A stack of one is a plain card, with no strip and no sheet edges. That is
   * the honest rendering and it also keeps the affordance meaningful: a strip
   * on every card would be furniture, whereas a strip that appears exactly when
   * there is something underneath is a fact about the work.
   */
  private syncStack(handle: CardHandle, stack: ShelfStack): void {
    const depth = stack.files.length
    handle.root.classList.toggle('kbn-shelf-card-stacked', depth > 1)
    handle.stackEl.hidden = depth < 2
    if (depth < 2) return
    // The face comes from the STACK, not from the handle. Every poll rebuilds
    // the file records (dedupeByPath returns fresh objects) while an unchanged
    // card keeps the handle — and the record — it was built from, so looking
    // the handle's own file up in the freshly built stack found nothing and the
    // strip counted `0/11` on every tile the reader had not just touched.
    const at = stack.files.indexOf(stack.face)
    handle.stackLabel.textContent = `${at + 1}/${depth}`
    handle.stackEl.title = `${depth} files from ${stack.uid} — ‹ › to leaf through them`
  }

  // ── Promotion: the card that is a page rather than a tile ──────────────────

  /**
   * How much bigger a card's real DOM box is than its surface geometry.
   *
   * 1 for every card but the promoted one, and the zoom for that one — which is
   * exactly what cancels the surface's scale. Kept on the element as well as in
   * this field so `readGeom` can undo it without needing the view: every other
   * piece of the board (the layout, the collision solve, the drag maths, the
   * persisted store) speaks SURFACE coordinates, and promotion must be
   * invisible to all of them.
   */
  private inflation(path: string): number {
    return this.promoted === path ? this.persist.zoom : 1
  }

  /** Position a card, carrying the reciprocal scale if it is promoted. The
   *  translate is applied in the parent's (unscaled) space before the scale, so
   *  the card's surface coordinates mean the same thing either way. */
  private placeCard(handle: CardHandle, x: number, y: number): void {
    const k = this.inflation(handle.file.fullPath)
    handle.root.style.transform =
      k === 1
        ? `translate(${x}px, ${y}px)`
        : `translate(${x}px, ${y}px) scale(${1 / k})`
  }

  /** Size a card in surface units; the DOM box is inflated if it is promoted,
   *  which is the whole trick — a bigger box under a smaller scale is the same
   *  rectangle on screen with more room inside it. */
  private sizeCard(handle: CardHandle, w: number, h: number): void {
    const k = this.inflation(handle.file.fullPath)
    handle.root.dataset.inflate = String(k)
    handle.root.style.width = `${w * k}px`
    handle.root.style.height = `${h * k}px`
  }

  /**
   * Decide which card, if any, is currently being READ rather than looked at,
   * and keep its box in step with the zoom.
   *
   * Called after anything that moves the camera or the furniture. Cheap: a pass
   * over the handle table doing arithmetic on styles already in hand. The
   * decision itself is pure and lives in shelfPromote; this is only its
   * consequences on the DOM.
   */
  private syncPromotion(): void {
    const viewport = this.viewport
    if (!viewport) return

    const candidates: PromoteCandidate[] = []
    for (const [path, handle] of this.handles) {
      candidates.push({
        key: path,
        ...readGeom(handle.root),
        reflows: handle.kind === 'page' || handle.kind === 'pdf',
      })
    }
    const winner = choosePromotion(
      candidates,
      {
        zoom: this.persist.zoom,
        panX: this.persist.pan.x,
        panY: this.persist.pan.y,
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        focusX: this.zoomAnchor?.x,
        focusY: this.zoomAnchor?.y,
      },
      this.promoted,
    )

    const previous = this.promoted
    if (previous === winner) {
      // Still the same card — but the zoom may have moved under it, so its box
      // has to be re-inflated to the new scale or it would drift out of the
      // rectangle the camera says it occupies.
      if (winner) this.reapply(winner)
      return
    }
    this.promoted = winner
    if (previous) {
      const handle = this.handles.get(previous)
      if (handle) {
        handle.root.classList.remove('kbn-shelf-card-promoted')
        this.reapply(previous)
      }
    }
    if (winner) {
      const handle = this.handles.get(winner)
      if (handle) {
        handle.root.classList.add('kbn-shelf-card-promoted')
        handle.root.style.zIndex = String(++this.zTop)
        this.reapply(winner)
        // A card this big is the thing on screen; it must have its document.
        this.ensureBody(handle)
      }
    }
  }

  /** Re-write a card's box and transform from the geometry it already has,
   *  under whatever inflation now applies to it. */
  private reapply(path: string): void {
    const handle = this.handles.get(path)
    if (!handle) return
    const geom = readGeom(handle.root)
    this.sizeCard(handle, geom.w, geom.h)
    this.placeCard(handle, geom.x, geom.y)
  }

  /**
   * While a card is being dragged, keep the surface legal AROUND it.
   *
   * Everything is re-solved from the LIVE rectangles every frame — the dragged
   * card hard-pinned under the pointer, its neighbours yielding — so what the
   * reader sees is bodies making room, not a layout recomputed on release.
   */
  private pushNeighbours(draggedPath: string): void {
    const base = this.dragBase
    if (!base) return
    const cards: PackCard[] = []
    for (const [path, handle] of this.handles) {
      // Everyone else is solved from where they were when the drag STARTED,
      // not from where the last frame left them. That is what lets a card the
      // drag passed over come back: the displacement is a function of where
      // the dragged card is now, so it undoes itself as the card moves on.
      // Solving from the previous frame instead would leave a wake of shoved
      // cards behind every gesture.
      const geom = path === draggedPath ? readGeom(handle.root) : base.get(path)
      if (!geom) continue
      cards.push({
        key: path,
        group: handle.file.uid ?? '',
        ...geom,
        rank:
          path === draggedPath || this.persist.cards[path]?.starred === true ? 'hard' : 'soft',
      })
    }
    for (const [key, rect] of packShelf(cards)) {
      if (key === draggedPath) continue
      const handle = this.handles.get(key)
      if (!handle) continue
      this.placeCard(handle, rect.x, rect.y)
    }
  }

  /** Coalesce the collision solve to one per frame: a pointermove can fire
   *  several times between paints, and solving three times for one frame is
   *  three times the work for the same picture. */
  private queuePush(path: string): void {
    if (this.pushFrame !== null) return
    this.pushFrame = requestAnimationFrame(() => {
      this.pushFrame = null
      if (this.drag?.gesture.phase === 'active') this.pushNeighbours(path)
    })
  }

  // ── Cards ──────────────────────────────────────────────────────────────────

  private buildCard(file: ShelfFile): CardHandle {
    const root = document.createElement('article')
    root.className = 'kbn-shelf-card'
    root.dataset.path = file.fullPath
    // The worker's own words first when it left any, then the path — a caption
    // says what the file IS, which is what you want on hover; the path says
    // where it is, which is what you want when the caption isn't enough.
    root.title = file.caption ? `${file.caption}\n${file.fullPath}` : file.fullPath
    if (isOriginStale(this.origins, file.host ?? null)) {
      root.classList.add('kbn-shelf-card-stale')
    }

    const kind = shelfKind(file.fullPath)
    const head = document.createElement('header')
    head.className = 'kbn-shelf-head'

    const star = document.createElement('button')
    star.type = 'button'
    star.className = 'kbn-shelf-star'
    star.textContent = '✶'
    star.title = 'Hold this card where it is'
    star.setAttribute('aria-label', 'Star')
    star.addEventListener('pointerdown', (e) => e.stopPropagation())
    star.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleStar(file.fullPath)
    })

    const name = document.createElement('span')
    name.className = 'kbn-shelf-name'
    name.textContent = file.basename

    const fiber = document.createElement('span')
    fiber.className = 'kbn-shelf-fiber'
    fiber.textContent = file.uid ?? ''

    const age = document.createElement('span')
    age.className = 'kbn-shelf-age'
    age.textContent = relativeAge(file.timestamp, Date.now())

    // The ↗ sends the file to the reader. It stays an <a> carrying the real
    // URL so the address is inspectable and right-click → copy link works, but
    // the plain click is ours: in this environment a browser-opened file is a
    // stray window, not a tab (see the class docstring). Only for the kinds a
    // browser actually renders — a tarball behind this glyph is a download
    // prompt wearing an "open" affordance.
    const open = document.createElement('a')
    open.className = 'kbn-shelf-open'
    open.textContent = '↗'
    open.title = 'Read this'
    open.href = this.ctx ? fileUrl(this.ctx.shuttleBase, file) : '#'
    open.hidden = !isRenderable(kind)
    open.addEventListener('pointerdown', (e) => e.stopPropagation())
    open.addEventListener('click', (e) => {
      e.stopPropagation()
      e.preventDefault()
      this.read(file)
    })

    // Put this one away. Sits at the far end of the header, quiet until the
    // card is hovered — a destructive-looking glyph on every card at rest
    // would make the board feel like a list of things to delete.
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.className = 'kbn-shelf-dismiss'
    dismiss.addEventListener('pointerdown', (e) => e.stopPropagation())
    dismiss.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleDismissed(file.fullPath)
    })

    head.append(star, name, fiber, age, open, dismiss)
    head.addEventListener('pointerdown', (e) => this.startGesture(e, file.fullPath, 'move'))

    const host = document.createElement('div')
    host.className = 'kbn-shelf-body'

    const face = buildFace(file, kind)
    host.append(face)

    // The sheet that gives the surface its gestures back. Clicking it focuses
    // the card, which lifts it — see the class docstring.
    const veil = document.createElement('div')
    veil.className = 'kbn-shelf-veil'
    veil.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      this.focus(file.fullPath)
    })
    host.append(veil)

    // The accordion. A stack's other sheets are reachable without the tile
    // growing, opening, or displacing anything — the strip swaps which file
    // this card IS, so the name, the age and the document all follow it. That
    // is why paging is cheap: one card is torn down and one is built, rather
    // than a fiber's worth of frames being kept warm for a glance.
    const stackEl = document.createElement('div')
    stackEl.className = 'kbn-shelf-stack'
    stackEl.hidden = true
    stackEl.addEventListener('pointerdown', (e) => e.stopPropagation())
    stackEl.addEventListener('dblclick', (e) => e.stopPropagation())
    const stackLabel = document.createElement('span')
    stackLabel.className = 'kbn-shelf-stack-count'
    // The stack is ordered newest-first, so ‹ walks BACK into the fiber's
    // history and › returns towards what just landed — the direction the
    // numbers on the strip already run.
    const step = (glyph: string, delta: number, label: string): HTMLElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'kbn-shelf-stack-step'
      btn.textContent = glyph
      btn.title = `${label} file from this fiber`
      btn.setAttribute('aria-label', `${label} file from ${file.uid ?? 'this fiber'}`)
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.leaf(file.uid ?? '', delta)
      })
      return btn
    }
    stackEl.append(step('‹', 1, 'Older'), stackLabel, step('›', -1, 'Newer'))

    const grip = document.createElement('div')
    grip.className = 'kbn-shelf-grip'
    grip.title = 'Resize'
    grip.addEventListener('pointerdown', (e) => this.startGesture(e, file.fullPath, 'resize'))

    // Double-click anywhere on the card opens it — the same intent as ↗ at a
    // coarser aim, and the gesture most people try first on a thumbnail. Bound
    // on the whole card rather than the header so the face and the body answer
    // to it too; the buttons in the header opt out below, since double-tapping
    // a star should star once and open nothing.
    root.addEventListener('dblclick', (e) => {
      e.preventDefault()
      if (!isRenderable(kind)) return
      // A drag's release can be followed closely enough by another click to
      // synthesise a double-click. Opening the reader because someone put a
      // card down and picked it up again would be a surprise, so a gesture
      // that actually travelled suppresses the next one.
      if (Date.now() - this.lastDragEnd < DBLCLICK_AFTER_DRAG_MS) return
      this.read(file)
    })
    for (const control of [star, open, dismiss]) {
      control.addEventListener('dblclick', (e) => e.stopPropagation())
    }

    root.append(head, host, stackEl, grip)
    return {
      file,
      kind,
      root,
      face,
      host,
      ageEl: age,
      dismissEl: dismiss,
      stackEl,
      stackLabel,
      state: 'idle',
      body: null,
      visible: false,
      lastVisible: 0,
      distance: Number.POSITIVE_INFINITY,
      timer: null,
      stale: false,
      unframeWheel: null,
    }
  }

  // ── The body lifecycle ─────────────────────────────────────────────────────

  /**
   * Decide what loads and what dies, once per frame.
   *
   * Called on every intersection change, reflow, lens switch and load
   * completion. Cheap by construction: the two decisions are pure functions
   * over the handle table (shelfLoad), and the DOM work is only what those
   * decisions name.
   */
  private pump(): void {
    if (this.pumpFrame !== null) return
    this.pumpFrame = requestAnimationFrame(() => {
      this.pumpFrame = null
      this.fill()
      this.scheduleSweep()
    })
  }

  private fill(): void {
    const viewport = this.viewport
    if (!viewport) return
    // The centre of what the reader is looking at, converted into SURFACE
    // coordinates — the same space the card rects are in, so the ordering
    // stays meaningful at every zoom. (Zoomed out, many more cards fall inside
    // the ring; center-distance is then the only thing deciding which of them
    // get the four loader slots, and the live-body cap is what keeps the rest
    // from ever mounting.)
    const zoom = this.persist.zoom
    const cx = (-this.persist.pan.x + viewport.clientWidth / 2) / zoom
    const cy = (-this.persist.pan.y + viewport.clientHeight / 2) / zoom

    let inFlight = 0
    const candidates: Array<{ key: string; distance: number }> = []
    for (const [path, handle] of this.handles) {
      if (handle.state === 'loading') inFlight++
      if (handle.state !== 'idle' || !handle.visible) continue
      if (handle.kind === 'opaque') continue // a face is all it will ever have
      const geom = readGeom(handle.root)
      handle.distance = Math.hypot(geom.x + geom.w / 2 - cx, geom.y + geom.h / 2 - cy)
      candidates.push({ key: path, distance: handle.distance })
    }
    for (const key of chooseLoads(candidates, LOAD_POLICY.maxConcurrent - inFlight)) {
      const handle = this.handles.get(key)
      if (handle) this.mountBody(handle)
    }
  }

  private scheduleSweep(): void {
    if (this.sweepTimer) clearTimeout(this.sweepTimer)
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null
      this.sweep()
    }, LOAD_POLICY.sweepMs)
  }

  /** Take down the bodies the board can no longer carry. */
  private sweep(): void {
    const live: Array<{ key: string; lastVisible: number; exempt: boolean }> = []
    for (const [path, handle] of this.handles) {
      if (handle.state !== 'live') continue
      live.push({
        key: path,
        lastVisible: handle.lastVisible,
        // On screen, being read, held down, or in the middle of a gesture:
        // never take these down. See shelfLoad.chooseEvictions.
        exempt:
          handle.visible ||
          this.focused === path ||
          this.activeCard === path ||
          this.persist.cards[path]?.starred === true,
      })
    }
    for (const key of chooseEvictions(live)) {
      const handle = this.handles.get(key)
      if (handle) this.evictBody(handle)
    }
  }

  /** Give a card its content. The face stays mounted underneath until the body
   *  has actually loaded, so a slow file shows its name rather than a hole. */
  private mountBody(handle: CardHandle): void {
    if (!this.ctx || handle.state !== 'idle') return
    const src = fileUrl(this.ctx.shuttleBase, handle.file)
    handle.state = 'loading'
    handle.root.classList.add('kbn-shelf-card-loading')
    handle.stale = false
    handle.root.classList.remove('kbn-shelf-card-updated')

    const settle = (): void => {
      if (handle.timer !== null) clearTimeout(handle.timer)
      handle.timer = null
      handle.state = 'live'
      handle.root.classList.remove('kbn-shelf-card-loading', 'kbn-shelf-card-stalled')
      handle.root.classList.add('kbn-shelf-card-live')
      // One frame of face still showing, then the crossfade — swapping in the
      // same tick shows an unpainted body.
      requestAnimationFrame(() => handle.body?.classList.add('kbn-shelf-body-in'))
      this.pump()
    }

    const fail = (): void => {
      if (handle.timer !== null) clearTimeout(handle.timer)
      handle.timer = null
      this.evictBody(handle)
      handle.root.classList.add('kbn-shelf-card-stalled')
    }

    if (handle.kind === 'image') {
      const img = document.createElement('img')
      img.className = 'kbn-shelf-img kbn-shelf-bodyel'
      img.alt = handle.file.basename
      img.decoding = 'async'
      img.addEventListener('load', settle)
      img.addEventListener('error', fail)
      img.src = src
      handle.body = img
      handle.host.insertBefore(img, handle.host.firstChild)
    } else if (handle.kind === 'text') {
      void this.mountText(handle, src, settle, fail)
    } else {
      const frame = document.createElement('iframe')
      frame.className = 'kbn-shelf-frame kbn-shelf-bodyel'
      frame.title = handle.file.basename
      frame.loading = 'lazy'
      // A sent file is our own daemon's bytes, but it is also arbitrary HTML a
      // worker wrote: sandboxed to scripts-and-same-origin-reads so a report's
      // own interactivity works while nothing it contains can navigate the
      // board.
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups')
      frame.addEventListener('load', () => {
        this.hearFrameWheel(handle, frame)
        settle()
      })
      frame.addEventListener('error', fail)
      frame.src = src
      handle.body = frame
      handle.host.insertBefore(frame, handle.host.firstChild)
    }

    // A load that has taken this long is not going to feel like loading any
    // more. Say so, and offer the retry — a blank rectangle explains nothing.
    const budget = handle.file.host
      ? LOAD_POLICY.softTimeoutRemoteMs
      : LOAD_POLICY.softTimeoutLocalMs
    handle.timer = window.setTimeout(() => {
      handle.timer = null
      if (handle.state !== 'loading') return
      handle.state = 'stalled'
      handle.root.classList.remove('kbn-shelf-card-loading')
      handle.root.classList.add('kbn-shelf-card-stalled')
    }, budget)
  }

  /**
   * Hear the pinch a framed document would otherwise swallow.
   *
   * A wheel event inside an iframe is dispatched into THAT document and never
   * bubbles out, so once a focused card's veil is lifted the board stops
   * hearing the zoom gesture entirely. The frames are our own daemon's bytes
   * on our own origin (`/api/v1/file`, sandboxed `allow-same-origin`), so the
   * fix is to listen inside them and hand the ctrl/⌘ case back to the same
   * `zoomAt` the outer handler uses. Everything else is left alone: a plain
   * scroll must keep scrolling the document being read.
   *
   * A remote board (`shuttleBase` pointing at another host) serves frames
   * cross-origin, and reaching for `contentWindow` there throws. Those cards
   * keep the old limit rather than the whole card failing to mount.
   */
  private hearFrameWheel(handle: CardHandle, frame: HTMLIFrameElement): void {
    handle.unframeWheel?.()
    handle.unframeWheel = null
    if (handle.body !== frame) return
    let win: Window | null = null
    try {
      win = frame.contentWindow
      // Touching a property is what actually trips the cross-origin check.
      void win?.document
    } catch {
      return
    }
    if (!win) return
    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const rect = frame.getBoundingClientRect()
      const point = framePointToClient(
        { x: e.clientX, y: e.clientY },
        rect,
        { width: frame.clientWidth, height: frame.clientHeight },
      )
      this.zoomAt(
        point.x,
        point.y,
        wheelZoomFactor(e.deltaY, e.deltaMode, this.viewport?.clientHeight ?? 800),
      )
    }
    win.addEventListener('wheel', onWheel, { passive: false })
    handle.unframeWheel = () => {
      try {
        win.removeEventListener('wheel', onWheel)
      } catch {
        /* the realm is already gone */
      }
    }
  }

  /** Text bodies are fetched as strings, not framed: a log in an iframe is a
   *  whole document for a page of plain characters. Cached, because the string
   *  is small and the round trip is not. */
  private async mountText(
    handle: CardHandle,
    src: string,
    settle: () => void,
    fail: () => void,
  ): Promise<void> {
    const pre = document.createElement('pre')
    pre.className = 'kbn-shelf-text kbn-shelf-bodyel'
    handle.body = pre
    handle.host.insertBefore(pre, handle.host.firstChild)

    const cached = this.textCache.get(handle.file.fullPath)
    if (cached !== undefined) {
      pre.textContent = cached
      settle()
      return
    }
    try {
      const res = await fetch(src)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      // The card may have been evicted or dropped while the bytes were in
      // flight; writing into a detached node would be harmless but pointless.
      if (handle.body !== pre) return
      this.textCache.set(handle.file.fullPath, text)
      pre.textContent = text
      settle()
    } catch {
      if (handle.body === pre) fail()
    }
  }

  /**
   * Take a body down.
   *
   * `src = 'about:blank'` BEFORE removal, and that order matters: removing an
   * iframe from the document does not reliably release the JS realm it hosts,
   * so a board that only removed nodes would keep every report it had ever
   * shown alive in memory. Navigating it to blank first is what actually lets
   * it go. The face is already underneath, so the card never blinks.
   */
  private evictBody(handle: CardHandle): void {
    if (handle.timer !== null) clearTimeout(handle.timer)
    handle.timer = null
    const body = handle.body
    handle.body = null
    handle.state = 'idle'
    handle.unframeWheel?.()
    handle.unframeWheel = null
    handle.root.classList.remove(
      'kbn-shelf-card-live',
      'kbn-shelf-card-loading',
      'kbn-shelf-card-stalled',
    )
    if (!body) return
    if (body instanceof HTMLIFrameElement) body.src = 'about:blank'
    if (body instanceof HTMLImageElement) body.removeAttribute('src')
    body.remove()
  }

  /** The file changed under a body someone may be reading. Say so; do not
   *  swap the document out from under them. */
  private markStale(handle: CardHandle): void {
    if (handle.stale) return
    handle.stale = true
    handle.root.classList.add('kbn-shelf-card-updated')
  }

  /** Put a stale card's new bytes on screen, on the reader's word. */
  private reload(handle: CardHandle): void {
    this.evictBody(handle)
    handle.root.classList.remove('kbn-shelf-card-updated')
    handle.stale = false
    this.mountBody(handle)
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  // ── Reading ────────────────────────────────────────────────────────────────

  /** Send a file to the reader. The card is left exactly as it was: opening a
   *  file is not a rearrangement of the canvas. */
  private read(file: ShelfFile): void {
    this.reader?.open(file)
    this.syncReading()
  }

  /** Mark the cards whose files are open in the reader, so the canvas shows
   *  what the reader is holding without the reader having to be in front. */
  private syncReading(): void {
    const open = new Set(this.reader?.openPaths() ?? [])
    for (const [path, handle] of this.handles) {
      handle.root.classList.toggle('kbn-shelf-card-reading', open.has(path))
    }
  }

  // ── Focus ──────────────────────────────────────────────────────────────────

  /** Lift a card's veil and raise it. One card is live at a time — two live
   *  frames means two places a stray click can land. */
  private focus(path: string | null): void {
    if (this.focused === path) return
    if (this.focused) {
      this.handles.get(this.focused)?.root.classList.remove('kbn-shelf-card-focus')
    }
    this.focused = path
    if (!path) return
    const handle = this.handles.get(path)
    if (!handle) return
    handle.root.classList.add('kbn-shelf-card-focus')
    handle.root.style.zIndex = String(++this.zTop)
    this.ensureBody(handle)
  }

  /**
   * Reaching for a card is the one signal that outranks every policy: bring
   * its body back if it was swept out, take the new bytes if it went stale,
   * and try again if it stalled. This is the retry — a stalled card is retried
   * by asking for it, not by a button that only says "retry".
   */
  private ensureBody(handle: CardHandle): void {
    if (handle.stale || handle.state === 'stalled') {
      this.reload(handle)
      return
    }
    if (handle.state === 'idle') this.mountBody(handle)
  }

  private toggleStar(path: string): void {
    const state = this.persist.cards[path] ?? {}
    if (state.starred) {
      // Unstarring a card that was never moved by hand hands it back to the
      // flow; one that WAS dragged keeps the position its owner chose.
      delete state.starred
      if (!state.w && !state.h) { delete state.x; delete state.y }
      if (Object.keys(state).length === 0) delete this.persist.cards[path]
      else this.persist.cards[path] = state
    } else {
      state.starred = true
      if (!isPlaced(state)) {
        // Capture where the flow had just put it — a star means "hold this
        // HERE", so it must know where here is.
        const handle = this.handles.get(path)
        const rect = handle ? readGeom(handle.root) : null
        if (rect) Object.assign(state, rect)
      }
      this.persist.cards[path] = state
    }
    this.save()
    // A star takes a file OUT of its fiber's stack (and unstarring puts it
    // back), so the tiles have to be rebuilt, not merely repositioned.
    this.syncCards()
    this.reflow()
  }

  // ── Drag, resize, pan ──────────────────────────────────────────────────────

  /**
   * The one gesture in flight, and the element it is being tracked on.
   *
   * `gesture` is the pure state machine (shelfGesture); everything here is the
   * DOM half — which element has pointer capture, which element to paint. A
   * press starts as a MAYBE and paints nothing: it becomes a drag only once
   * the pointer has travelled, and only a drag is ever written down.
   */
  private drag: { gesture: ShelfGesture; target: HTMLElement } | null = null

  private startGesture(e: PointerEvent, path: string, mode: 'move' | 'resize'): void {
    if (e.button !== 0) return
    const handle = this.handles.get(path)
    if (!handle) return
    e.preventDefault()
    e.stopPropagation()
    this.drag = {
      gesture: beginGesture(mode, path, e, readGeom(handle.root), this.persist.zoom),
      target: handle.root,
    }
    handle.root.setPointerCapture(e.pointerId)
    handle.root.addEventListener('pointermove', this.onDragMove)
    handle.root.addEventListener('pointerup', this.onDragEnd)
    handle.root.addEventListener('pointercancel', this.onDragEnd)
  }

  /** Drag on empty canvas pans the surface — and unfocuses whatever was live,
   *  because reaching past a card to grab the surface is a way of putting it
   *  down. */
  private readonly onSurfacePointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('.kbn-shelf-card')) return
    this.focus(null)
    const viewport = this.viewport
    if (!viewport) return
    e.preventDefault()
    this.drag = {
      gesture: beginGesture('pan', null, e, {
        x: this.persist.pan.x,
        y: this.persist.pan.y,
        w: 0,
        h: 0,
      }),
      target: viewport,
    }
    viewport.classList.add('kbn-shelf-panning')
    viewport.setPointerCapture(e.pointerId)
    viewport.addEventListener('pointermove', this.onDragMove)
    viewport.addEventListener('pointerup', this.onDragEnd)
    viewport.addEventListener('pointercancel', this.onDragEnd)
  }

  private readonly onDragMove = (e: PointerEvent): void => {
    const drag = this.drag
    if (!drag || e.pointerId !== drag.gesture.pointerId) return
    const before = drag.gesture.phase
    const { gesture, geometry } = advanceGesture(drag.gesture, e.clientX, e.clientY)
    drag.gesture = gesture
    if (geometry === null) return // still a maybe — nothing has moved yet
    if (before === 'maybe') this.beginMotion(drag.target, gesture)
    if (gesture.mode === 'pan') {
      this.persist.pan = { x: geometry.x, y: geometry.y }
      this.applyPan()
      return
    }
    // The gesture speaks surface units throughout, so a promoted card's
    // inflated box is applied here rather than being written raw.
    const handle = gesture.path ? this.handles.get(gesture.path) : null
    if (handle && gesture.mode === 'move') {
      this.placeCard(handle, geometry.x, geometry.y)
    } else if (handle) {
      this.sizeCard(handle, geometry.w, geometry.h)
    }
    // A card that has moved or grown is a card that may now be standing on
    // someone. Re-solve the surface around it, this frame.
    if (gesture.path) this.queuePush(gesture.path)
  }

  /**
   * A press has become a gesture. Everything expensive starts here, not on
   * pointerdown — lifting a card the reader only clicked would flag every
   * click as a drag.
   *
   * `will-change: transform` goes on the ONE element being moved and comes off
   * on release: it promotes its subject to its own compositor layer, which is
   * what keeps a drag smooth and what would blow out memory if the surface
   * wore it permanently.
   */
  private beginMotion(target: HTMLElement, gesture: ShelfGesture): void {
    if (gesture.mode === 'pan') return
    target.style.zIndex = String(++this.zTop)
    target.style.willChange = 'transform'
    target.classList.add('kbn-shelf-card-dragging')
    this.activeCard = gesture.path
    // Live iframes stop taking pointer events for the whole gesture: a frame
    // under the pointer would otherwise swallow the drag the moment it crossed
    // one, and hit-testing dozens of documents is not free either.
    this.surface?.classList.add('kbn-shelf-gesturing')
    this.dragBase = new Map(
      [...this.handles].map(([path, handle]) => [path, readGeom(handle.root)]),
    )
    // A resize reflows whatever is inside the card on EVERY frame. For a
    // ten-megabyte report that is the single most expensive thing the board
    // can do, so the body steps out for the duration and comes back after.
    if (gesture.mode === 'resize' && gesture.path) {
      const handle = this.handles.get(gesture.path)
      if (handle && handle.state === 'live') {
        this.evictBody(handle)
        this.demoted = [gesture.path]
      }
    }
  }

  private readonly onDragEnd = (e: PointerEvent): void => {
    const drag = this.drag
    if (!drag || e.pointerId !== drag.gesture.pointerId) return
    const gesture = drag.gesture
    const target = drag.target
    this.endGesture()
    const { placed, click } = settleGesture(gesture)

    if (click) {
      // The pointer never travelled: this was a click, and a click on a card
      // means "let me at it" — focus, not placement. Writing geometry here is
      // what made a click look like it duplicated the card (see shelfGesture).
      // A click on the resize corner is a miss, not a request — only the
      // header (and the body's veil) means "let me at this card".
      this.activeCard = null
      if (gesture.mode === 'move' && gesture.path) this.focus(gesture.path)
      return
    }
    if (!placed) {
      this.save() // a pan: only the offset is new
      this.pump()
      return
    }
    this.lastDragEnd = Date.now()
    if (!gesture.path) return
    // A card that has been moved or resized is PLACED: it keeps this exact
    // geometry through every reflow and reload from here on.
    const state = this.persist.cards[gesture.path] ?? {}
    Object.assign(state, readGeom(target))
    this.persist.cards[gesture.path] = state
    // Dragging a sheet off a stack is how you take one out of it: the card is
    // placed now, so it stands alone and the fiber it came from closes up
    // behind it with a new face.
    this.syncCards()
    // The drop still counts as active for this one layout, so it keeps the
    // ground it landed on and its neighbours are the ones that give way.
    const layout = this.reflow()
    if (layout) this.commitDisplaced(layout)
    this.activeCard = null
    this.save()
    this.pump()
  }

  /**
   * Write back where the settle actually put the placed cards.
   *
   * The layout enforces the no-overlap law on every pass, so a card displaced
   * by a drop would be re-displaced identically on the next load — but only
   * while the same card counts as active, which it will not after a reload.
   * Persisting the SETTLED arrangement means the store holds a legal board:
   * what reopens is exactly what the reader last saw, with nothing left to
   * re-solve. Flowed cards are untouched — committing one would silently place
   * a card the reader never placed.
   */
  private commitDisplaced(layout: ShelfLayout): void {
    for (const card of layout.cards) {
      if (!card.pinned) continue
      const state = this.persist.cards[card.file.fullPath]
      if (!state || !isPlaced(state)) continue
      if (state.x === card.x && state.y === card.y) continue
      state.x = card.x
      state.y = card.y
    }
  }

  private endGesture(): void {
    if (this.pushFrame !== null) cancelAnimationFrame(this.pushFrame)
    this.pushFrame = null
    this.dragBase = null
    this.surface?.classList.remove('kbn-shelf-gesturing')
    // Whatever stepped out for a resize comes back now the size has settled.
    for (const path of this.demoted) {
      const handle = this.handles.get(path)
      if (handle && handle.visible) this.mountBody(handle)
    }
    this.demoted = []
    const drag = this.drag
    this.drag = null
    if (!drag) return
    drag.target.classList.remove('kbn-shelf-card-dragging')
    drag.target.style.willChange = ''
    this.viewport?.classList.remove('kbn-shelf-panning')
    try {
      drag.target.releasePointerCapture(drag.gesture.pointerId)
    } catch {
      /* already gone */
    }
    drag.target.removeEventListener('pointermove', this.onDragMove)
    drag.target.removeEventListener('pointerup', this.onDragEnd)
    drag.target.removeEventListener('pointercancel', this.onDragEnd)
  }

  /**
   * The trackpad, both ways.
   *
   * A plain two-finger scroll pans, in both axes. A PINCH arrives — on macOS
   * and on Windows precision trackpads alike — as a wheel event with `ctrlKey`
   * set, which is also what the browser reads as "zoom the page". So the
   * gesture is claimed here with `preventDefault`: without it the whole
   * application would zoom, chrome and all, which is never what a pinch on a
   * canvas means. `metaKey` zooms too: on a Mac the zoom chord in the hand is
   * ⌘-scroll, and a canvas that answers ctrl but not ⌘ reads as broken.
   */
  private readonly onWheel = (e: WheelEvent): void => {
    // Ctrl first, before every other bail: ctrl+scroll is THE zoom gesture, so
    // nothing else in this handler may claim the event ahead of it. (A
    // trackpad pinch arrives as this same event and so zooms too, which is
    // fine — but the two report their deltas in different UNITS, see below.)
    //
    // A FOCUSED card's veil is lifted, so its live iframe owns the pointer and
    // the wheel event inside it never reaches this document. That case is not
    // handled here and cannot be: see hearFrameWheel, which listens inside the
    // frame and calls the same zoomAt with translated coordinates.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      // Units, not magnitude: a pinch reports pixels and ctrl+scroll reports
      // LINES, so the delta is converted before it means anything. See
      // wheelZoomFactor — reading a line-mode delta as pixels is what made
      // ctrl+scroll look like it did nothing at all.
      this.zoomAt(
        e.clientX,
        e.clientY,
        wheelZoomFactor(e.deltaY, e.deltaMode, this.viewport?.clientHeight ?? 800),
      )
      return
    }
    if ((e.target as HTMLElement).closest('.kbn-shelf-card-focus')) return
    e.preventDefault()
    // The pan reads the same delta, and needs the same conversion.
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (this.viewport?.clientHeight ?? 800) : 1
    this.persist.pan = {
      x: this.persist.pan.x - e.deltaX * lines,
      y: this.persist.pan.y - e.deltaY * lines,
    }
    this.applyPan()
    this.holdLayer()
    this.saveSoon()
    this.pump()
  }

  /**
   * Scale the canvas about a point on the screen, keeping whatever is under
   * the cursor exactly where it is.
   *
   * The arithmetic is the whole feature. A point at screen position `c` sits
   * at surface position `s = (c - pan) / zoom`; holding `s` fixed across a
   * change of zoom means the new pan must be `c - s · zoom'`. Zoom about the
   * viewport's origin instead and the board slides out from under the pointer,
   * which is the difference between a canvas that feels like a map and one
   * that feels like a scrollbar.
   */
  private zoomAt(clientX: number, clientY: number, factor: number): void {
    const viewport = this.viewport
    if (!viewport) return
    const zoom = this.persist.zoom
    const next = clampZoom(zoom * factor)
    if (next === zoom) return
    const rect = viewport.getBoundingClientRect()
    const cx = clientX - rect.left
    const cy = clientY - rect.top
    const sx = (cx - this.persist.pan.x) / zoom
    const sy = (cy - this.persist.pan.y) / zoom
    this.persist.zoom = next
    this.persist.pan = { x: cx - sx * next, y: cy - sy * next }
    // The still point of the gesture, kept in surface units so a later pan
    // carries it with the content rather than leaving it on a screen position.
    this.zoomAnchor = { x: sx, y: sy }
    this.applyZoom()
    this.holdLayer()
    this.saveSoon()
    this.pump()
  }

  /**
   * Promote the surface to its own compositor layer for the duration of a
   * gesture, and — importantly — LET IT GO afterwards.
   *
   * `will-change: transform` is what keeps a pan or zoom smooth, but it also
   * pins the layer's raster at whatever resolution it had when it was
   * promoted. Held permanently, that is precisely what makes a zoomed-in card
   * blurry: the browser scales the bitmap it already had instead of drawing
   * the content again at the new scale. Dropping the hint once the gesture
   * settles is the re-rasterisation — the text and the framed documents come
   * back sharp at whatever scale you left them.
   */
  private holdLayer(): void {
    this.surface?.classList.add('kbn-shelf-moving')
    if (this.layerTimer) clearTimeout(this.layerTimer)
    this.layerTimer = setTimeout(() => {
      this.layerTimer = null
      this.surface?.classList.remove('kbn-shelf-moving')
    }, 220)
  }

  private layerTimer: ReturnType<typeof setTimeout> | null = null

  private applyPan(): void {
    this.applyZoom()
  }

  /** One transform carries both: pan OUTSIDE the scale (so pan stays in screen
   *  pixels and the drag maths does not have to unpick it) and the scale about
   *  the surface's own origin. */
  private applyZoom(): void {
    if (!this.surface) return
    this.clampPan()
    const { pan, zoom } = this.persist
    this.surface.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
    // The camera moved, so which card (if any) is large enough to be read at
    // its true size may have changed — and a card already promoted has to be
    // re-inflated to the new scale in the same frame, or it would lag a pinch
    // by a rectangle.
    this.syncPromotion()
  }

  /**
   * Keep the board on screen.
   *
   * An unclamped pan can put every card outside the viewport, and a canvas
   * showing nothing is indistinguishable from a canvas that failed to load —
   * you cannot tell "I have scrolled into empty space" from "the newest work
   * never arrived". Worse, the offset is persisted, so the board reopens where
   * you left it: on nothing. A margin of surface must always remain in view.
   */
  private clampPan(): void {
    const viewport = this.viewport
    const surface = this.surface
    if (!viewport || !surface) return
    const keep = 140
    // The surface's size ON SCREEN, which is what "still in view" is about —
    // at 0.4 zoom a 3000px board occupies 1200 screen pixels, and clamping
    // against the unscaled extent would let it be panned entirely away.
    const zoom = this.persist.zoom
    const surfaceW = (parseFloat(surface.style.width) || viewport.clientWidth) * zoom
    const surfaceH = (parseFloat(surface.style.height) || viewport.clientHeight) * zoom
    const minX = Math.min(0, viewport.clientWidth - surfaceW - keep)
    const minY = Math.min(0, viewport.clientHeight - surfaceH - keep)
    const maxX = Math.max(0, viewport.clientWidth - keep)
    const maxY = Math.max(0, viewport.clientHeight - keep)
    this.persist.pan = {
      x: Math.min(maxX, Math.max(minX, this.persist.pan.x)),
      y: Math.min(maxY, Math.max(minY, this.persist.pan.y)),
    }
  }

  /**
   * Escape peels one layer at a time, outermost first: the reader if it is
   * open, then the focused card. Only ever consumed when there IS something to
   * put down — otherwise it falls through and closes the board, which is what
   * Escape means everywhere else.
   */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    if (keystrokeIsSpokenFor()) return
    if (this.reader?.isOpen()) {
      e.preventDefault()
      e.stopPropagation()
      this.reader.close()
      return
    }
    if (!this.focused) return
    e.preventDefault()
    e.stopPropagation()
    this.focus(null)
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private saveTimer: ReturnType<typeof setTimeout> | null = null

  private save(): void {
    saveShelfPersist(this.persist)
  }

  /** Coalesce a wheel's worth of pan updates into one write. */
  private saveSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save()
    }, 400)
  }
}

// ── Card faces ───────────────────────────────────────────────────────────────

/** Kinds a browser will draw in a tab of its own. Everything else — a
 *  tarball, a notebook, a binary — would arrive as a download prompt, so the
 *  board does not offer to open it. */
function isRenderable(kind: ShelfKind): boolean {
  return kind === 'page' || kind === 'image' || kind === 'pdf'
}

/**
 * The face: what a card is when it has no body yet, and what it falls back to
 * when its body is swept out.
 *
 * Everything on it comes from the feed, so it costs no network and no wait.
 * That is why it is the resting state rather than a shimmer — a card that says
 * `deck.html · lands17 · html` is already useful, and a grey pulsing rectangle
 * never is.
 */
function buildFace(file: ShelfFile, kind: ShelfKind): HTMLElement {
  const face = document.createElement('div')
  face.className = 'kbn-shelf-face'

  const glyph = document.createElement('div')
  glyph.className = 'kbn-shelf-face-ext'
  const base = file.basename.split('/').pop() ?? file.basename
  const dot = base.lastIndexOf('.')
  glyph.textContent = dot > 0 ? base.slice(dot + 1).toLowerCase() : 'file'

  const note = document.createElement('div')
  note.className = 'kbn-shelf-face-note'
  note.textContent = kind === 'opaque' ? '— not drawn here —' : (file.caption ?? '')

  face.append(glyph, note)
  if (file.host) {
    const origin = document.createElement('div')
    origin.className = 'kbn-shelf-face-origin'
    origin.textContent = file.host
    face.append(origin)
  }
  return face
}

// ── Small helpers ────────────────────────────────────────────────────────────

/** A card's geometry as the surface holds it — read from the inline style
 *  rather than `getBoundingClientRect`, which would be in viewport pixels and
 *  would fold in the pan. A PROMOTED card's box is inflated by its own
 *  reciprocal scale (see ShelfView.syncPromotion); dividing it out here is what
 *  keeps promotion invisible to the layout, the pack and the drag maths, all of
 *  which speak surface units and must go on doing so. */
function readGeom(el: HTMLElement): { x: number; y: number; w: number; h: number } {
  const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform)
  const inflate = Number(el.dataset.inflate) || 1
  return {
    x: match ? Number(match[1]) : 0,
    y: match ? Number(match[2]) : 0,
    w: (parseFloat(el.style.width) || el.offsetWidth) / inflate,
    h: (parseFloat(el.style.height) || el.offsetHeight) / inflate,
  }
}

/**
 * How long ago, in the fewest characters that stay true: minutes for the last
 * hour, then hours, then days. A card's age is a glance, not a timestamp — the
 * exact instant is in the header's tooltip.
 */
export function relativeAge(timestamp: number, now: number): string {
  const ms = Math.max(0, now - timestamp)
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

registerView(new ShelfView())

export { ShelfView }
export type { ShelfCardState }
