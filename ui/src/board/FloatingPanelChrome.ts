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

/** Class carrying the geometry transition — applied only for the duration
 *  of a programmatic move so pointer-driven drag/resize stays 1:1. */
const GEOM_ANIM_CLASS = 'panel-geom-anim'
const GEOM_ANIM_MS = 320

/** Glide the panel to a new geometry (split-view enter/exit). The
 *  transition class is shed after the animation so subsequent drags
 *  aren't smoothed-and-laggy. */
export function animatePanelGeometry(overlay: HTMLElement, g: PanelGeometry): void {
  overlay.classList.add(GEOM_ANIM_CLASS)
  overlay.style.left = `${Math.max(0, g.left)}px`
  overlay.style.top = `${Math.max(0, g.top)}px`
  overlay.style.width = `${g.width}px`
  overlay.style.height = `${g.height}px`
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
    draggingClass: string
    onMoved?: () => void
    onSettle?: () => void
  },
): void {
  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('button, input, textarea, select')) return
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const startLeft = overlay.offsetLeft
    const startTop = overlay.offsetTop
    overlay.classList.add(opts.draggingClass)
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
      overlay.classList.remove(opts.draggingClass)
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
    handleClassPrefix: string
    resizingClass: string
    minWidth: number
    minHeight: number
    onSettle?: () => void
  },
): void {
  const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const
  for (const dir of dirs) {
    const h = document.createElement('div')
    h.className = `${opts.handleClassPrefix} ${opts.handleClassPrefix}-${dir}`
    h.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const startY = e.clientY
      const startLeft = overlay.offsetLeft
      const startTop = overlay.offsetTop
      const startW = overlay.offsetWidth
      const startH = overlay.offsetHeight
      overlay.classList.add(opts.resizingClass)
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
        if (w < opts.minWidth) {
          if (dir.includes('w')) left -= opts.minWidth - w
          w = opts.minWidth
        }
        if (ht < opts.minHeight) {
          if (dir.includes('n')) top -= opts.minHeight - ht
          ht = opts.minHeight
        }
        overlay.style.left = `${left}px`
        overlay.style.top = `${Math.max(0, top)}px`
        overlay.style.width = `${w}px`
        overlay.style.height = `${ht}px`
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        overlay.classList.remove(opts.resizingClass)
        opts.onSettle?.()
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    })
    overlay.append(h)
  }
}
