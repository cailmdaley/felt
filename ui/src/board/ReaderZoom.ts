/**
 * ReaderZoom — Cmd/Ctrl + wheel over an open file, anchored on the cursor.
 *
 * The two tabbed readers on the board (the fiber detail panel's file viewer and
 * the Shelf's Reader) zoom identically, because there is only one right answer
 * to "magnify this file": the point under the pointer must not move, and the
 * magnified box must be a real layout box so the cell's `overflow:auto` gives
 * you scrollbars to pan it with. Both had their own copy of that answer, down
 * to the same clamp constants and the same deferral frame.
 *
 * The arithmetic is separated from the DOM deliberately. `nextZoom` and
 * `zoomAnchorScroll` are the whole gesture as numbers, and are what the tests
 * cover; `applyZoom` and `zoomOnWheel` are the element writes, which this repo
 * keeps headless and therefore untested. The split is not ceremony — the anchor
 * arithmetic is the part that is easy to get subtly wrong, and it is now pinned.
 *
 * ZOOMING OUT is the other half, and it arrived late because a mouse never
 * needed it: on a desktop a file that overflows its column is fine, you
 * scroll. On a phone a PDF fit to the column's width is a page you can only
 * ever read a third of at a time, with no wheel to pull back with. So the
 * reader carries an explicit FIT — the magnification at which the whole page
 * is on screen — and on a coarse pointer it gets buttons and a double-tap,
 * because a gesture nobody can perform is not an affordance.
 *
 * KNOWN GAP, deliberately left alone here: the wheel reads `deltaY` as pixels
 * and ignores `WheelEvent.deltaMode`, so a line-mode wheel (Firefox, some mice)
 * zooms roughly forty times too fast. `views/shelfGesture.ts` already solved
 * exactly this — `wheelZoomFactor(deltaY, deltaMode, viewportH)`, with tests
 * that say "the units are the bug" — and adopting it here is one line. It is
 * not taken now because it changes the zoom feel of BOTH readers at once, which
 * is a decision about how the thing should feel, not a cleanup.
 */

/** What zoom needs of a tab: the pan surface, what is being scaled, where the
 *  zoom currently stands, and an image's fit-width at zoom 1. Both readers'
 *  tab records extend this, which is what lets one gesture drive either. */
export interface ZoomableTab {
  /** The `overflow:auto` cell the file is drawn in — the pan surface. */
  cell: HTMLElement
  /** The element zoom is applied to: an `<img>` (sized in px, base × zoom) or
   *  the viewer wrap (CSS `zoom`). Null until the viewer is built. */
  zoomTarget: HTMLElement | null
  zoom: number
  /** True when the target is a fixed SHEET rather than reflowing content — a
   *  PDF. It gets its own treatment, and the treatment was arrived at on a
   *  real phone rather than reasoned out: see `applyZoom`. */
  fixedPage?: boolean
  /** Fit-width (px) of an image at zoom 1 — recaptured at zoom 1 so a resized
   *  column re-fits. Base for the explicit `width = baseW × zoom` that lets an
   *  image magnify PAST the column (a `width:100%`/`max-width` image cannot). */
  baseW: number
}

/** One page of a PDF, in CSS pixels: A4 at 96dpi.
 *
 * A PDF renders inside an iframe, and an iframe showing a PDF tells us
 * nothing — there is no document to measure, same-origin or not. But a PDF is
 * a PAGE: a fixed sheet, not reflowing text, and almost every one that reaches
 * this reader is A4 or US Letter (794x1123 and 816x1056 at 96dpi). A4 is the
 * taller and narrower, so assuming it makes "fit" err towards showing slightly
 * more than the page rather than clipping its foot, which is the right
 * direction to be wrong in. */
export const PAGE_PX_W = 794
export const PAGE_PX_H = 1123
export const PAGE_ASPECT = PAGE_PX_H / PAGE_PX_W

/** Below this the file is a thumbnail; above it, a texture. */
export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 6

/** Wheel pixels to zoom, exponentially — so a notch is the same proportional
 *  step at any magnification, which is what makes zooming feel linear. */
const ZOOM_PER_PIXEL = 0.0015

/** Where one wheel notch lands, clamped. Returns `zOld` unchanged when the step
 *  would leave the range, which is the caller's signal to do nothing at all. */
export function nextZoom(zOld: number, deltaY: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zOld * Math.exp(-deltaY * ZOOM_PER_PIXEL)))
}

/** Where the cell must scroll to so the content point under the cursor stays
 *  under the cursor. That fixed point is the whole gesture: zoom that ignores
 *  it walks the reader away from what they were pointing at. */
export function zoomAnchorScroll(at: {
  scrollLeft: number
  scrollTop: number
  cursorX: number
  cursorY: number
  zOld: number
  zNew: number
}): { scrollLeft: number; scrollTop: number } {
  // The content-space point under the cursor before the zoom.
  const px = (at.scrollLeft + at.cursorX) / at.zOld
  const py = (at.scrollTop + at.cursorY) / at.zOld
  return {
    scrollLeft: px * at.zNew - at.cursorX,
    scrollTop: py * at.zNew - at.cursorY,
  }
}

/**
 * Handle one wheel event over `entry`. Returns whether it zoomed — the caller's
 * cue to persist, and nothing else. A plain wheel (no modifier) is left alone
 * so ordinary scrolling still works, and so is a step that changes nothing.
 */
export function zoomOnWheel(e: WheelEvent, entry: ZoomableTab | null | undefined): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false
  if (!entry?.zoomTarget) return false
  e.preventDefault()
  const cell = entry.cell
  const rect = cell.getBoundingClientRect()
  const zOld = entry.zoom
  const zNew = nextZoom(zOld, e.deltaY)
  if (zNew === zOld) return false
  const at = zoomAnchorScroll({
    scrollLeft: cell.scrollLeft,
    scrollTop: cell.scrollTop,
    cursorX: e.clientX - rect.left,
    cursorY: e.clientY - rect.top,
    zOld,
    zNew,
  })
  entry.zoom = zNew
  applyZoom(entry)
  cell.scrollLeft = at.scrollLeft
  cell.scrollTop = at.scrollTop
  return true
}

/**
 * Mirror an entry's zoom into its viewer element.
 *
 * Three kinds of content, three mechanisms, and they are not interchangeable:
 *
 *   a PDF   the frame is enlarged and scaled down — the only thing mobile
 *           Safari's PDF viewer responds to. See the comment in the branch.
 *   an IMAGE is sized in px, `width = baseW × zoom`, because a `width:100%`
 *           image cannot grow past its column no matter what you multiply it
 *           by. The fit base is captured lazily the first time we are past
 *           zoom 1 (it needs layout) and forgotten at zoom 1, so a resized
 *           column re-fits.
 *   ANYTHING ELSE is the wrap under the CSS `zoom` property rather than
 *           `transform: scale`: `zoom` grows the element's layout box, so the
 *           cell's `overflow:auto` gives real scrollbars to pan with.
 *
 * If the cell is not laid out yet — a rehydrated zoom applied on open — there
 * is nothing to measure, so defer a frame rather than capture a zero.
 */
export function applyZoom(entry: ZoomableTab): void {
  const t = entry.zoomTarget
  if (!t) return

  // ── A PDF ────────────────────────────────────────────────────────────────
  // The frame is made BIGGER and then painted smaller. That is backwards
  // until you watch what mobile Safari does with an iframe full of PDF: it
  // renders the page at the size the frame's own viewport implies and gives
  // you no way to scroll it, so shrinking the frame's box only crops harder —
  // which is exactly the complaint that started this ("no way of zooming out
  // so everything fits"). Handing the frame a viewport big enough to contain
  // the page and scaling the whole thing down is the one move that works, and
  // it was verified on an iPhone before it was written down.
  //
  // The painted box stays exactly the cell, at every zoom: `cell / z` scaled
  // by `z` is `cell`. What changes is how much page is inside it.
  if (entry.fixedPage) {
    if (entry.zoom === 1) {
      t.style.removeProperty('width')
      t.style.removeProperty('height')
      t.style.removeProperty('transform')
      t.style.removeProperty('transform-origin')
      t.style.removeProperty('margin-left')
      return
    }
    const w = entry.cell.clientWidth
    const h = entry.cell.clientHeight
    if (!w || !h) {
      requestAnimationFrame(() => applyZoom(entry))
      return
    }
    // Height is inflated freely — it is the dimension a page runs out of. Width
    // is capped at one page: a landscape cell asks for a 3300px viewport, and
    // the viewer answers by drawing the page against the left edge of it with
    // two thirds of the frame left white. One page wide is all a page needs.
    const frameW = Math.round(Math.min(w / entry.zoom, PAGE_PX_W))
    t.style.width = `${frameW}px`
    t.style.height = `${Math.round(h / entry.zoom)}px`
    t.style.transform = `scale(${entry.zoom})`
    t.style.transformOrigin = '0 0'
    // `transform` does not move the layout box, so centring is arithmetic
    // rather than `margin: auto` — the painted width is `frameW × zoom`.
    t.style.marginLeft = `${Math.max(0, Math.round((w - frameW * entry.zoom) / 2))}px`
    return
  }

  // ── An image ─────────────────────────────────────────────────────────────
  if (t instanceof HTMLImageElement) {
    if (entry.zoom === 1) {
      t.style.removeProperty('width')
      t.style.removeProperty('max-width')
      t.style.removeProperty('height')
      t.style.removeProperty('margin')
      entry.baseW = 0
      return
    }
    if (!entry.baseW) {
      const fit = t.parentElement?.clientWidth ?? 0
      if (!fit) {
        requestAnimationFrame(() => applyZoom(entry))
        return
      }
      entry.baseW = fit
    }
    t.style.maxWidth = 'none'
    t.style.height = 'auto'
    t.style.width = `${Math.round(entry.baseW * entry.zoom)}px`
    // Shrunk below the cell, a plate clinging to the left edge reads as a
    // rendering fault. Centred, it reads as a plate on a mat.
    t.style.margin = '0 auto'
    return
  }

  // ── Anything else: the reflowing document ────────────────────────────────
  if (entry.zoom === 1) t.style.removeProperty('zoom')
  else t.style.setProperty('zoom', String(entry.zoom))
}

/** The magnification at which a whole PDF page is on screen.
 *
 * Both dimensions bind, unlike everything else in this module: the frame's
 * viewport is `cell / z` in each direction, and the page needs to fit in both.
 * Capped at 1 — "fit" never magnifies — and floored at ZOOM_MIN. */
export function fitPageZoom(cellW: number, cellH: number): number {
  if (!(cellW > 0) || !(cellH > 0)) return 1
  return Math.min(1, Math.max(ZOOM_MIN, Math.min(cellW / PAGE_PX_W, cellH / PAGE_PX_H)))
}

/** The magnification at which the whole of the content is on screen.
 *
 * One formula for all three kinds, because at zoom 1 every one of them is
 * drawn fit to the cell's width: the rendered height is `baseW × aspect × z`,
 * so the z that lands it on `cellH` is `cellH / (baseW × aspect)`.
 *
 * Capped at 1: "fit" is a way to pull BACK from a file that overflows, never a
 * reason to blow a three-line report up to fill a phone. Floored at ZOOM_MIN
 * so a very long document does not fit itself into illegibility.
 */
export function fitZoom(cellH: number, baseW: number, aspect: number): number {
  if (!(cellH > 0) || !(baseW > 0) || !(aspect > 0)) return 1
  return Math.min(1, Math.max(ZOOM_MIN, cellH / (baseW * aspect)))
}

/** One press of the − / + pair. Proportional, like the wheel, and clamped. */
export function stepZoom(z: number, dir: -1 | 1): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * Math.pow(1.3, dir)))
}

/** Point the entry's zoom at the right element for the file it just built, and
 *  apply whatever magnification it is carrying.
 *
 *  Both readers had this line twice and it is not a one-liner any more: an
 *  image is scaled by its own px width, a PDF is a sheet scaled the same way,
 *  and everything else is the wrap under CSS `zoom`. */
export function setZoomTarget(entry: ZoomableTab, viewer: HTMLElement, path: string): void {
  entry.fixedPage = /\.pdf$/i.test(path)
  entry.zoomTarget = viewer.querySelector<HTMLElement>('img.kbn-fileview-image') ?? viewer
  applyZoom(entry)
}

/** What `fitZoom` needs, measured off whatever this tab is actually showing.
 *  Returns null when there is nothing laid out yet to measure. */
export function measureFit(entry: ZoomableTab): number | null {
  const t = entry.zoomTarget
  if (!t) return null
  const cellH = entry.cell.clientHeight
  const baseW = entry.baseW || t.parentElement?.clientWidth || entry.cell.clientWidth
  if (!cellH || !baseW) return null
  if (t instanceof HTMLImageElement) {
    if (!t.naturalWidth || !t.naturalHeight) return null
    return fitZoom(cellH, baseW, t.naturalHeight / t.naturalWidth)
  }
  if (entry.fixedPage) return fitPageZoom(entry.cell.clientWidth, cellH)
  // A same-origin HTML report can be measured for real; a frame that refuses
  // to be read falls back to "already fits", which is the honest answer when
  // we cannot see inside it.
  const frame = t.querySelector<HTMLIFrameElement>('iframe.kbn-fileview-frame')
  try {
    const h = frame?.contentDocument?.documentElement?.scrollHeight ?? 0
    return h > 0 ? fitZoom(cellH, baseW, h / baseW) : 1
  } catch {
    return 1
  }
}

/** Set an entry's zoom and mirror it into the DOM. Returns whether it moved. */
export function setZoom(entry: ZoomableTab, z: number): boolean {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
  if (next === entry.zoom) return false
  // The fit base is captured at the first magnification away from 1 and
  // dropped at 1; going straight from 1 to a fit smaller than 1 needs it now.
  if (!entry.baseW) entry.baseW = entry.zoomTarget?.parentElement?.clientWidth ?? 0
  entry.zoom = next
  applyZoom(entry)
  return true
}

/**
 * Mount the zoom cluster on a reader's chrome bar and wire the touch gestures.
 *
 * A no-op on a fine pointer: Cmd-wheel is already the better gesture there,
 * and a toolbar duplicating it is clutter. Under a finger there is no wheel at
 * all, so this is the ONLY way out of a page magnified past the screen — which
 * is why it is chrome and not a hidden gesture.
 *
 * DOUBLE-TAP is the second half, and the one people will actually use: two
 * taps anywhere on the file toggle between fit and native size, the same
 * bargain every photo viewer on a phone has made. It is implemented from
 * `pointerdown` timing rather than `dblclick` because a double-tap on a
 * scrolling surface does not reliably reach `dblclick` on iOS.
 *
 * `onChange` is the caller's persist hook — the same one the wheel calls.
 */
export function installTouchZoom(opts: {
  bar: HTMLElement
  views: HTMLElement
  before?: Element | null
  active: () => ZoomableTab | null | undefined
  buildBar: () => {
    bar: HTMLElement
    out: HTMLElement
    fit: HTMLElement
    plus: HTMLElement
    minus: HTMLElement
  }
  coarse: boolean
  onChange: () => void
}): void {
  if (!opts.coarse) return
  const ui = opts.buildBar()
  opts.bar.insertBefore(ui.bar, opts.before ?? null)

  const show = (): void => {
    const e = opts.active()
    ui.out.textContent = `${Math.round((e?.zoom ?? 1) * 100)}%`
  }
  const commit = (z: number): void => {
    const e = opts.active()
    if (!e || !setZoom(e, z)) return
    show()
    opts.onChange()
  }
  // FIT is a TOGGLE, not a one-way trip: pressed at fit it returns you to
  // native size, so the same control is both "show me the whole thing" and
  // "put it back", which is the pair a reader actually alternates between.
  const toggleFit = (): void => {
    const e = opts.active()
    if (!e) return
    const fit = measureFit(e)
    if (fit == null) return
    commit(Math.abs(e.zoom - fit) < 0.01 ? 1 : fit)
  }

  ui.minus.addEventListener('click', () => {
    const e = opts.active()
    if (e) commit(stepZoom(e.zoom, -1))
  })
  ui.plus.addEventListener('click', () => {
    const e = opts.active()
    if (e) commit(stepZoom(e.zoom, 1))
  })
  ui.fit.addEventListener('click', toggleFit)

  let lastTap = 0
  opts.views.addEventListener(
    'pointerdown',
    (ev) => {
      if ((ev as PointerEvent).pointerType === 'mouse') return
      const now = Date.now()
      const isDouble = now - lastTap < 320
      lastTap = isDouble ? 0 : now
      if (isDouble) toggleFit()
    },
    { passive: true },
  )

  // The readout goes stale the moment a tab switch or a wheel moves the zoom
  // under it, and neither of those comes through this module. A frame loop is
  // the wrong answer; the bar's own pointer traffic is the right one — you
  // only read a number you are about to act on.
  opts.bar.addEventListener('pointerenter', show)
  opts.views.addEventListener('pointerup', show, { passive: true })
  show()
}
