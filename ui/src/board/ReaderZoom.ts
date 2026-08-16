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
  /** Fit-width (px) of an image at zoom 1 — recaptured at zoom 1 so a resized
   *  column re-fits. Base for the explicit `width = baseW × zoom` that lets an
   *  image magnify PAST the column (a `width:100%`/`max-width` image cannot). */
  baseW: number
}

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
 * An IMAGE is sized in px — `width = baseW × zoom` — because a `width:100%`
 * image cannot grow past its column no matter what you multiply it by. The fit
 * base is captured lazily the first time we are past zoom 1 (it needs layout),
 * and forgotten at zoom 1 so a resized column re-fits. If the cell is not laid
 * out yet — a rehydrated zoom applied on open — there is nothing to measure, so
 * defer a frame rather than capture a zero.
 *
 * ANYTHING ELSE is the viewer wrap, magnified with the CSS `zoom` property
 * rather than `transform: scale`: `zoom` grows the element's layout box, so the
 * cell's `overflow:auto` gives real scrollbars to pan the magnified file with.
 */
export function applyZoom(entry: ZoomableTab): void {
  const t = entry.zoomTarget
  if (!t) return
  if (t instanceof HTMLImageElement) {
    if (entry.zoom === 1) {
      t.style.removeProperty('width')
      t.style.removeProperty('max-width')
      t.style.removeProperty('height')
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
  } else if (entry.zoom === 1) {
    t.style.removeProperty('zoom')
  } else {
    t.style.setProperty('zoom', String(entry.zoom))
  }
}
