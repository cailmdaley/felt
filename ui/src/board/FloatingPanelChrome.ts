/**
 * FloatingPanelChrome — the drag / resize machinery shared by Portolan's
 * floating non-modal panels (the kanban's fiber-detail panel, the sent-file
 * viewer). A panel is a `position: fixed` overlay whose geometry is always
 * set inline (left/top/width/height); these helpers own the pointer
 * lifecycle and hand geometry persistence back to the caller via
 * `onSettle`.
 *
 * Extracted from FiberDetailModal so a second panel didn't mean a second
 * copy of the eight-zone resize handles.
 */

export interface PanelGeometry {
  left: number
  top: number
  width: number
  height: number
}

/** The smallest a floating panel may be: below this the header stops being
 *  usable. Shared, because every window in the set is the same frame. */
export const PANEL_MIN = { width: 380, height: 320 }

export function applyPanelGeometry(el: HTMLElement, g: PanelGeometry): void {
  el.style.left = `${Math.max(0, g.left)}px`
  el.style.top = `${Math.max(0, g.top)}px`
  el.style.width = `${g.width}px`
  el.style.height = `${g.height}px`
}

/** A geometry refitted to the window it is about to be applied in. */
export function fittedGeometry(g: PanelGeometry): PanelGeometry {
  return fitPanelGeometry(g, { width: window.innerWidth, height: window.innerHeight }, PANEL_MIN)
}

/**
 * The half-and-half arrangement: the card takes the left half of the viewport,
 * the panel beside it the right half, with a shared gutter. Used when a second
 * window opens — the file viewer, and the panel that holds followed wikilinks.
 */
export function halfAndHalf(): { card: PanelGeometry; other: PanelGeometry } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const gutter = 12
  const half = Math.floor((vw - 3 * gutter) / 2)
  const top = gutter
  const height = vh - 2 * gutter
  return {
    card: { left: gutter, top, width: half, height },
    other: { left: 2 * gutter + half, top, width: half, height },
  }
}

/**
 * The shared z-order stack for every floating window on the board — the card
 * panel, the file viewer, the wikilink panel. Clicking one raises it above the
 * others: a `pointerdown` bumps the counter and stamps the window's `z-index`,
 * so the last-touched window wins. Seeded above the vellum scrim (9999), which
 * is where the panel's base CSS `z-index` sits.
 */
let panelZ = 10000
export function bringPanelToFront(el: HTMLElement): void {
  el.style.zIndex = String(++panelZ)
}

/**
 * Every floating window currently on screen, in open order.
 *
 * Two behaviours need the whole set rather than one window's own element.
 * Click-away close: a click on the panel next door is not a click "outside the
 * card", or following a wikilink would close the card you followed it from.
 * Escape: it acts on the LAST-OPENED window, so a reading unwinds in the order
 * it was built up rather than vanishing at once.
 */
const openPanels: HTMLElement[] = []

export function registerPanel(el: HTMLElement): void {
  openPanels.push(el)
}
export function unregisterPanel(el: HTMLElement): void {
  const i = openPanels.indexOf(el)
  if (i >= 0) openPanels.splice(i, 1)
}
export function inSomeOpenPanel(node: Node | null): boolean {
  return node !== null && openPanels.some((p) => p.contains(node))
}
/** Is this the newest window on screen — the one Escape should act on? */
export function isTopPanel(el: HTMLElement): boolean {
  return openPanels[openPanels.length - 1] === el
}

/**
 * Clamp a remembered geometry to the viewport it is about to be applied in.
 *
 * A `position: fixed` panel taller than the window has its lower edge below
 * the screen, and the page pane's scroll container goes with it: the reader
 * can scroll the body to its end and still never SEE the end, because the
 * bottom of the scrollport is off-screen. (That was the bug — a card whose
 * geometry was saved on a taller window could only ever be read down to
 * `viewportHeight` worth of it.) So no restored geometry is ever trusted
 * unclamped: size fits the window first, then position slides back inside it.
 *
 * Pure, and takes its viewport rather than reading `window`, so the rule is
 * testable headless.
 */
export function fitPanelGeometry(
  g: PanelGeometry,
  viewport: { width: number; height: number },
  min: { width: number; height: number },
): PanelGeometry {
  const width = Math.min(g.width, Math.max(min.width, viewport.width))
  const height = Math.min(g.height, Math.max(min.height, viewport.height))
  return {
    left: Math.min(Math.max(0, g.left), Math.max(0, viewport.width - width)),
    top: Math.min(Math.max(0, g.top), Math.max(0, viewport.height - height)),
    width,
    height,
  }
}

/** Class carrying the geometry transition — applied only for the duration
 *  of a programmatic move so pointer-driven drag/resize stays 1:1. */
const GEOM_ANIM_CLASS = 'panel-geom-anim'
const GEOM_ANIM_MS = 320

/** Glide the panel to a new geometry (split-view enter/exit). The
 *  transition class is shed after the animation so subsequent drags
 *  aren't smoothed-and-laggy. */
export function animatePanelGeometry(overlay: HTMLElement, g: PanelGeometry): void {
  overlay.classList.add(GEOM_ANIM_CLASS)
  applyPanelGeometry(overlay, g)
  window.setTimeout(() => overlay.classList.remove(GEOM_ANIM_CLASS), GEOM_ANIM_MS)
}

export function readPanelGeometry(overlay: HTMLElement): PanelGeometry {
  return {
    left: overlay.offsetLeft,
    top: overlay.offsetTop,
    width: overlay.offsetWidth,
    height: overlay.offsetHeight,
  }
}

/** Header-strip drag. Plain pointer drag — the header is dedicated chrome,
 *  so no modifier gate is needed (the Cmd-gate lesson from the pin-card
 *  prototype applies to chrome-less surfaces where drag fights text
 *  selection; a title bar doesn't). Buttons and form fields opt out.
 *  `onMoved` fires once a gesture actually travels (>4px) — callers whose
 *  drag handle doubles as a click target consult it so drag-release ≠
 *  click. `onSettle` fires on pointer-up, after the click event has had a
 *  chance to consult the moved state. */
export function attachPanelDrag(
  overlay: HTMLElement,
  handle: HTMLElement,
  opts: {
    /** Defaults to `kbn-detail-dragging` — every window in the set is the
     *  same frame, styled by the one stylesheet. */
    draggingClass?: string
    onMoved?: () => void
    onSettle?: () => void
  },
): void {
  const dragClass = opts.draggingClass ?? 'kbn-detail-dragging'
  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('button, input, textarea, select')) return
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const startLeft = overlay.offsetLeft
    const startTop = overlay.offsetTop
    overlay.classList.add(dragClass)
    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 4) {
        opts.onMoved?.()
      }
      overlay.style.left = `${startLeft + ev.clientX - startX}px`
      overlay.style.top = `${Math.max(0, startTop + ev.clientY - startY)}px`
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      overlay.classList.remove(dragClass)
      opts.onSettle?.()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  })
}

/** Eight invisible resize zones on the edges and corners. Pointer-based,
 *  same lifecycle as drag; min size keeps the header usable. Handle
 *  elements are classed `<handleClassPrefix>` + `<handleClassPrefix>-<dir>`
 *  so each panel's CSS positions its own zones. */
export function attachPanelResize(
  overlay: HTMLElement,
  opts: {
    /** All four default to the shared frame's values — the same stylesheet
     *  styles every window in the set, and {@link PANEL_MIN} is its floor. */
    handleClassPrefix?: string
    resizingClass?: string
    minWidth?: number
    minHeight?: number
    /** Fires on every frame of the resize. A panel that DIVIDES a layout (the
     *  board's docked reader) has to reflow what is beside it as the edge
     *  moves; settling only at the end would make the divider feel detached
     *  from the thing it divides. */
    onMove?: () => void
    onSettle?: () => void
  },
): void {
  const prefix = opts.handleClassPrefix ?? 'kbn-detail-rh'
  const resizingClass = opts.resizingClass ?? 'kbn-detail-resizing'
  const minWidth = opts.minWidth ?? PANEL_MIN.width
  const minHeight = opts.minHeight ?? PANEL_MIN.height
  const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const
  for (const dir of dirs) {
    const h = document.createElement('div')
    h.className = `${prefix} ${prefix}-${dir}`
    h.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const startY = e.clientY
      const startLeft = overlay.offsetLeft
      const startTop = overlay.offsetTop
      const startW = overlay.offsetWidth
      const startH = overlay.offsetHeight
      overlay.classList.add(resizingClass)
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        let left = startLeft
        let top = startTop
        let w = startW
        let ht = startH
        if (dir.includes('e')) w = startW + dx
        if (dir.includes('s')) ht = startH + dy
        if (dir.includes('w')) {
          w = startW - dx
          left = startLeft + dx
        }
        if (dir.includes('n')) {
          ht = startH - dy
          top = startTop + dy
        }
        if (w < minWidth) {
          if (dir.includes('w')) left -= minWidth - w
          w = minWidth
        }
        if (ht < minHeight) {
          if (dir.includes('n')) top -= minHeight - ht
          ht = minHeight
        }
        overlay.style.left = `${left}px`
        overlay.style.top = `${Math.max(0, top)}px`
        overlay.style.width = `${w}px`
        overlay.style.height = `${ht}px`
        opts.onMove?.()
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        overlay.classList.remove(resizingClass)
        opts.onSettle?.()
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    })
    overlay.append(h)
  }
}
