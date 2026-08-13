/**
 * ShelfView (hotkey 5) — the sent work, as a surface rather than a list.
 *
 * Everything a worker pushed with `SendUserFile` in the last month, each file
 * a LIVE card: the report renders inside its frame, the plot draws, the page
 * is the thing itself and not a link to it. Which is the whole argument for a
 * canvas. A list of filenames is an index of work; a wall of rendered pages is
 * the work, and you find the one you want by recognising it.
 *
 * THREE STATES a card can be in, and the view is mostly about the boundaries
 * between them:
 *
 *   flowed    the lens arranged it (see shelfLayout)
 *   placed    you arranged it — dragged, resized, or starred
 *   focused   you are reading it. The overlay comes off and the iframe is
 *             live; click away or press Escape and it goes back to being a
 *             tile you can drag.
 *
 * The overlay is not decoration. An iframe swallows every pointer event that
 * lands on it, so a canvas of live frames is a canvas you cannot pan or drag
 * — the transparent sheet over each card is what gives the surface its
 * gestures back, and lifting it is exactly what "focus" means here.
 *
 * ORDER IS A LENS, NOT A SCROLL. The recency lens fills top-left to
 * bottom-right, so time has a direction on the surface; the fiber lens breaks
 * the same cards into captioned bands. Switching between them moves the
 * furniture and keeps the pinned things nailed down.
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
  isPlaced,
  layoutShelf,
  loadShelfPersist,
  saveShelfPersist,
  SHELF_METRICS,
  type ShelfCardState,
  type ShelfLens,
  type ShelfPersist,
} from './shelfLayout.js'

/** How far back the shelf reaches. A month is the span over which "did I send
 *  that already?" is still a live question; beyond it the canvas would be an
 *  archive, which is a different surface. */
const SHELF_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** The reading size a card grows to when you open it in place. */
const EXPANDED = { w: 760, h: 560 }

/** Margin around the viewport inside which an iframe is allowed to mount.
 *  Dozens of live frames would wreck the tab, so a card off-screen is a card
 *  with no `src`. */
const LAZY_MARGIN = '400px'

interface CardHandle {
  file: ShelfFile
  root: HTMLElement
  frameHost: HTMLElement
  mounted: boolean
}

class ShelfView implements TemporalView {
  readonly id = 'shelf' as const
  readonly title = 'Shelf'
  readonly hotkey = '5'

  private ctx: ViewContext | null = null
  private viewport: HTMLElement | null = null
  private surface: HTMLElement | null = null
  private emptyEl: HTMLElement | null = null
  private lensEl: HTMLElement | null = null

  private files: ShelfFile[] = []
  private origins: TemporalOrigins = {}
  private persist: ShelfPersist = { lens: 'recency', pan: { x: 0, y: 0 }, cards: {} }
  private readonly handles = new Map<string, CardHandle>()
  private observer: IntersectionObserver | null = null
  private focused: string | null = null
  private expanded: string | null = null
  private zTop = 10
  private loading = false
  /** The signature of the file set last laid out, so a 15s poll that changes
   *  nothing does not rebuild the canvas under the user's hands. */
  private signature = ''

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  mount(host: HTMLElement, ctx: ViewContext): void {
    this.ctx = ctx
    this.persist = loadShelfPersist()

    const page = createViewPage(this.title)
    page.titleRow.append(this.buildLens())

    this.viewport = document.createElement('div')
    this.viewport.className = 'kbn-shelf-viewport'
    this.surface = document.createElement('div')
    this.surface.className = 'kbn-shelf-surface'
    this.viewport.append(this.surface)
    page.body.append(this.viewport)
    host.append(page.root)

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const path = (entry.target as HTMLElement).dataset.path
          if (path) this.mountFrame(path)
        }
      },
      { root: this.viewport, rootMargin: LAZY_MARGIN },
    )

    this.viewport.addEventListener('pointerdown', this.onSurfacePointerDown)
    this.viewport.addEventListener('wheel', this.onWheel, { passive: false })
    document.addEventListener('keydown', this.onKeyDown, true)

    this.applyPan()
    void this.load()
  }

  refresh(ctx: ViewContext): void {
    this.ctx = ctx
    void this.load()
  }

  unmount(): void {
    document.removeEventListener('keydown', this.onKeyDown, true)
    this.viewport?.removeEventListener('pointerdown', this.onSurfacePointerDown)
    this.viewport?.removeEventListener('wheel', this.onWheel)
    this.endDrag()
    this.observer?.disconnect()
    this.observer = null
    this.handles.clear()
    this.viewport = this.surface = this.emptyEl = this.lensEl = null
    this.ctx = null
    this.signature = ''
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    const ctx = this.ctx
    if (!ctx || this.loading) return
    this.loading = true
    try {
      const result = await fetchShelf(ctx.shuttleBase, Date.now() - SHELF_WINDOW_MS)
      if (!this.surface) return
      this.files = dedupeByPath(result.files)
      this.origins = result.origins
      this.renderIfChanged()
    } finally {
      this.loading = false
    }
  }

  /** Rebuild only when the SET changed. A poll that returns the same files
   *  must not tear down the cards — an iframe rebuilt every fifteen seconds
   *  loses its scroll position, and a card rebuilt mid-drag loses the drag. */
  private renderIfChanged(): void {
    const sig = this.files.map((f) => `${f.fullPath}@${f.timestamp}`).join('')
    if (sig === this.signature) return
    this.signature = sig
    this.render()
  }

  // ── Chrome ─────────────────────────────────────────────────────────────────

  /** The lens control: two words, the active one inked. Quiet on purpose —
   *  it changes how the surface reads, not what is on it. */
  private buildLens(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'kbn-shelf-lens'
    const label = document.createElement('span')
    label.className = 'kbn-shelf-lens-label'
    label.textContent = 'by'
    wrap.append(label)
    for (const lens of ['recency', 'fiber'] as ShelfLens[]) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'kbn-shelf-lens-opt'
      btn.dataset.lens = lens
      btn.textContent = lens
      btn.addEventListener('click', () => this.setLens(lens))
      wrap.append(btn)
    }
    this.lensEl = wrap
    this.syncLens()
    return wrap
  }

  private syncLens(): void {
    for (const btn of this.lensEl?.querySelectorAll<HTMLElement>('.kbn-shelf-lens-opt') ?? []) {
      btn.classList.toggle('kbn-shelf-lens-on', btn.dataset.lens === this.persist.lens)
    }
  }

  private setLens(lens: ShelfLens): void {
    if (this.persist.lens === lens) return
    this.persist.lens = lens
    this.save()
    this.syncLens()
    this.reflow()
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  private render(): void {
    const surface = this.surface
    if (!surface) return
    this.observer?.disconnect()
    surface.innerHTML = ''
    this.handles.clear()
    this.emptyEl = null

    if (this.files.length === 0) {
      this.emptyEl = createViewEmptyState('— nothing sent yet —')
      surface.append(this.emptyEl)
      return
    }

    for (const file of this.files) {
      const handle = this.buildCard(file)
      this.handles.set(file.fullPath, handle)
      surface.append(handle.root)
      this.observer?.observe(handle.root)
    }
    this.reflow(true)
  }

  /**
   * Position every card from the current lens.
   *
   * `immediate` suppresses the reflow transition for the first paint — cards
   * sliding in from the origin on mount would read as an animation the data
   * did not ask for.
   */
  private reflow(immediate = false): void {
    const surface = this.surface
    if (!surface) return
    const width = Math.max(this.viewport?.clientWidth ?? 0, SHELF_METRICS.cardW) - 4
    const layout = layoutShelf(this.files, this.persist.lens, this.persist.cards, {
      ...SHELF_METRICS,
      width,
    })

    if (immediate) surface.classList.add('kbn-shelf-still')

    for (const caption of surface.querySelectorAll('.kbn-shelf-caption')) caption.remove()
    for (const caption of layout.captions) {
      const el = document.createElement('div')
      el.className = 'kbn-shelf-caption'
      el.textContent = caption.label
      el.style.transform = `translate(${caption.x}px, ${caption.y}px)`
      el.style.width = `${caption.width}px`
      surface.append(el)
    }

    for (const card of layout.cards) {
      const handle = this.handles.get(card.file.fullPath)
      if (!handle) continue
      const expanded = this.expanded === card.file.fullPath
      const w = expanded ? EXPANDED.w : card.w
      const h = expanded ? EXPANDED.h : card.h
      handle.root.style.transform = `translate(${card.x}px, ${card.y}px)`
      handle.root.style.width = `${w}px`
      handle.root.style.height = `${h}px`
      handle.root.classList.toggle('kbn-shelf-card-pinned', card.pinned)
      handle.root.classList.toggle('kbn-shelf-card-starred', card.starred)
    }

    surface.style.width = `${layout.width}px`
    surface.style.height = `${layout.height + 40}px`

    if (immediate) {
      // Two frames: one for the browser to commit the positions, one for the
      // class removal to land after they are already where they belong.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => surface.classList.remove('kbn-shelf-still')),
      )
    }
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

    const open = document.createElement('a')
    open.className = 'kbn-shelf-open'
    open.textContent = '↗'
    open.title = 'Open in a new tab'
    open.target = '_blank'
    open.rel = 'noopener'
    open.href = this.ctx ? fileUrl(this.ctx.shuttleBase, file) : '#'
    open.addEventListener('pointerdown', (e) => e.stopPropagation())
    open.addEventListener('click', (e) => e.stopPropagation())

    head.append(star, name, fiber, age, open)
    head.addEventListener('pointerdown', (e) => this.startDrag(e, file.fullPath, 'move'))
    head.addEventListener('dblclick', (e) => {
      e.preventDefault()
      this.toggleExpand(file.fullPath)
    })

    const frameHost = document.createElement('div')
    frameHost.className = 'kbn-shelf-body'

    // The sheet that gives the surface its gestures back. Clicking it focuses
    // the card, which lifts it — see the class docstring.
    const veil = document.createElement('div')
    veil.className = 'kbn-shelf-veil'
    veil.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      this.focus(file.fullPath)
    })

    const grip = document.createElement('div')
    grip.className = 'kbn-shelf-grip'
    grip.title = 'Resize'
    grip.addEventListener('pointerdown', (e) => this.startDrag(e, file.fullPath, 'resize'))

    frameHost.append(veil)
    root.append(head, frameHost, grip)
    return { file, root, frameHost, mounted: false }
  }

  /** Give a card its content, once, when it first comes near the viewport. */
  private mountFrame(path: string): void {
    const handle = this.handles.get(path)
    if (!handle || handle.mounted || !this.ctx) return
    handle.mounted = true
    const kind = shelfKind(path)
    handle.frameHost.append(
      kind === 'opaque'
        ? opaqueFace(handle.file)
        : buildFrame(fileUrl(this.ctx.shuttleBase, handle.file), kind, handle.file.basename),
    )
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
    this.mountFrame(path)
  }

  private toggleExpand(path: string): void {
    this.expanded = this.expanded === path ? null : path
    if (this.expanded) {
      this.focus(path)
      // An expanded card is a card you are reading, and reading it where the
      // flow happened to put it is fine — but its size is now the user's, so
      // a placed card keeps the new one.
      const state = this.persist.cards[path]
      if (isPlaced(state)) {
        state!.w = EXPANDED.w
        state!.h = EXPANDED.h
        this.save()
      }
    }
    this.reflow()
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
    this.reflow()
  }

  // ── Drag, resize, pan ──────────────────────────────────────────────────────

  private drag: {
    path: string | null
    mode: 'move' | 'resize' | 'pan'
    startX: number
    startY: number
    origin: { x: number; y: number; w: number; h: number }
    pointerId: number
    target: HTMLElement
  } | null = null

  private startDrag(e: PointerEvent, path: string, mode: 'move' | 'resize'): void {
    if (e.button !== 0) return
    const handle = this.handles.get(path)
    if (!handle) return
    e.preventDefault()
    e.stopPropagation()
    const geom = readGeom(handle.root)
    handle.root.style.zIndex = String(++this.zTop)
    handle.root.classList.add('kbn-shelf-card-dragging')
    this.drag = {
      path, mode,
      startX: e.clientX, startY: e.clientY,
      origin: geom, pointerId: e.pointerId,
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
      path: null, mode: 'pan',
      startX: e.clientX, startY: e.clientY,
      origin: { x: this.persist.pan.x, y: this.persist.pan.y, w: 0, h: 0 },
      pointerId: e.pointerId,
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
    if (!drag || e.pointerId !== drag.pointerId) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (drag.mode === 'pan') {
      this.persist.pan = { x: drag.origin.x + dx, y: drag.origin.y + dy }
      this.applyPan()
      return
    }
    const el = drag.target
    if (drag.mode === 'move') {
      el.style.transform = `translate(${drag.origin.x + dx}px, ${drag.origin.y + dy}px)`
    } else {
      el.style.width = `${Math.max(160, drag.origin.w + dx)}px`
      el.style.height = `${Math.max(120, drag.origin.h + dy)}px`
    }
  }

  private readonly onDragEnd = (e: PointerEvent): void => {
    const drag = this.drag
    if (!drag || e.pointerId !== drag.pointerId) return
    this.endDrag()
    if (drag.mode === 'pan') {
      this.save()
      return
    }
    if (!drag.path) return
    // A card that has been moved or resized is PLACED: it keeps this exact
    // geometry through every reflow and reload from here on.
    const state = this.persist.cards[drag.path] ?? {}
    Object.assign(state, readGeom(drag.target))
    this.persist.cards[drag.path] = state
    // A hand-sized card is no longer "expanded" — the size is its own now.
    if (this.expanded === drag.path && drag.mode === 'resize') this.expanded = null
    this.save()
    this.reflow()
  }

  private endDrag(): void {
    const drag = this.drag
    this.drag = null
    if (!drag) return
    drag.target.classList.remove('kbn-shelf-card-dragging')
    this.viewport?.classList.remove('kbn-shelf-panning')
    try { drag.target.releasePointerCapture(drag.pointerId) } catch { /* already gone */ }
    drag.target.removeEventListener('pointermove', this.onDragMove)
    drag.target.removeEventListener('pointerup', this.onDragEnd)
    drag.target.removeEventListener('pointercancel', this.onDragEnd)
  }

  /** Trackpad scroll pans, in both axes. No zoom in this version: a zoomed
   *  iframe is a mess of rescaled text, and the card sizes are the scale. */
  private readonly onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey || e.metaKey) return
    if ((e.target as HTMLElement).closest('.kbn-shelf-card-focus')) return
    e.preventDefault()
    this.persist.pan = {
      x: this.persist.pan.x - e.deltaX,
      y: this.persist.pan.y - e.deltaY,
    }
    this.applyPan()
    this.saveSoon()
  }

  private applyPan(): void {
    if (!this.surface) return
    this.surface.style.transform = `translate(${this.persist.pan.x}px, ${this.persist.pan.y}px)`
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    if (!this.focused && !this.expanded) return
    if (keystrokeIsSpokenFor()) return
    // Consume it: Escape here means "put this card down", and letting it
    // through would close the whole board instead.
    e.preventDefault()
    e.stopPropagation()
    this.focus(null)
    if (this.expanded) {
      this.expanded = null
      this.reflow()
    }
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

function buildFrame(src: string, kind: ShelfKind, label: string): HTMLElement {
  if (kind === 'image') {
    const img = document.createElement('img')
    img.className = 'kbn-shelf-img'
    img.src = src
    img.alt = label
    img.loading = 'lazy'
    return img
  }
  const frame = document.createElement('iframe')
  frame.className = 'kbn-shelf-frame'
  frame.src = src
  frame.title = label
  frame.loading = 'lazy'
  // A sent file is our own daemon's bytes, but it is also arbitrary HTML a
  // worker wrote: sandboxed to scripts-and-same-origin-reads so a report's own
  // interactivity works while nothing it contains can navigate the board.
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups')
  return frame
}

/** The face for a file the browser would offer to download rather than draw.
 *  Quiet, and honest about what it is: a name, its kind, and a way out. */
function opaqueFace(file: ShelfFile): HTMLElement {
  const face = document.createElement('div')
  face.className = 'kbn-shelf-face'
  const ext = document.createElement('div')
  ext.className = 'kbn-shelf-face-ext'
  const base = file.basename.split('/').pop() ?? file.basename
  const dot = base.lastIndexOf('.')
  ext.textContent = dot > 0 ? base.slice(dot + 1).toLowerCase() : 'file'
  const note = document.createElement('div')
  note.className = 'kbn-shelf-face-note'
  note.textContent = '— not drawn here —'
  face.append(ext, note)
  return face
}

// ── Small helpers ────────────────────────────────────────────────────────────

/** A card's geometry as the surface holds it — read from the inline style
 *  rather than `getBoundingClientRect`, which would be in viewport pixels and
 *  would fold in the pan. */
function readGeom(el: HTMLElement): { x: number; y: number; w: number; h: number } {
  const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform)
  return {
    x: match ? Number(match[1]) : 0,
    y: match ? Number(match[2]) : 0,
    w: parseFloat(el.style.width) || el.offsetWidth,
    h: parseFloat(el.style.height) || el.offsetHeight,
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
