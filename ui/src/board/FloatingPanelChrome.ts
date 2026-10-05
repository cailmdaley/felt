/**
 * FloatingPanelChrome — geometry, drag, resize, and focus behavior for the
 * Board's floating file-reader window. The caller persists its inline window
 * geometry through `onSettle`.
 */

export interface PanelGeometry {
  left: number
  top: number
  width: number
  height: number
}

/** The smallest size for the floating file-reader window and its resize handles. */
export const PANEL_MIN = { width: 380, height: 320 }

/**
 * The floating file-reader window's z-order. A `pointerdown` raises it above
 * overlapping board surfaces by stamping a value above its base `z-index`.
 */
let panelZ = 10000
function bringPanelToFront(el: HTMLElement): void {
  el.style.zIndex = String(++panelZ)
}

/**
 * Raise `el` when focus moves into one of its iframes.
 *
 * A `pointerdown` inside a PDF or report iframe belongs to that frame's
 * document and never reaches the parent page. The parent can observe the
 * resulting focus change instead: after the window blurs, the iframe becomes
 * `document.activeElement`. One listener serves each registered window; the
 * returned function withdraws its request.
 */
const frameRaised = new Set<HTMLElement>()
let frameFocusWatched = false
export function raiseOnFrameFocus(el: HTMLElement): () => void {
  frameRaised.add(el)
  if (!frameFocusWatched) {
    frameFocusWatched = true
    window.addEventListener('blur', () => {
      window.setTimeout(() => {
        const active = document.activeElement
        if (!(active instanceof HTMLIFrameElement)) return
        for (const panel of frameRaised) {
          if (panel.contains(active)) {
            bringPanelToFront(panel)
            return
          }
        }
      }, 0)
    })
  }
  return () => {
    frameRaised.delete(el)
  }
}

/**
 * Clamp a remembered file-reader geometry to the viewport it is applied in.
 *
 * A fixed reader window taller than the viewport leaves its lower edge and
 * scrollport off screen. Clamp its size to the viewport first, then move it
 * inside the available area.
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

export function readPanelGeometry(overlay: HTMLElement): PanelGeometry {
  return {
    left: overlay.offsetLeft,
    top: overlay.offsetTop,
    width: overlay.offsetWidth,
    height: overlay.offsetHeight,
  }
}

/** Header-strip drag. The dedicated chrome is the drag handle, so pointer
 *  drag needs no modifier. Buttons and form fields opt out. `onMoved` fires
 *  once a gesture travels (>4px); `onSettle` fires on pointer-up, after a
 *  click handler can distinguish a drag from a click. */
/** Is this panel currently framed as a full-screen sheet? A reader can become
 *  one while open, and keeps its drag and resize wiring across the change;
 *  both stand down while it is. */
export function isSheetFrame(overlay: HTMLElement): boolean {
  return overlay.classList.contains('kbn-detail-sheet')
}

export function attachPanelDrag(
  overlay: HTMLElement,
  handle: HTMLElement,
  opts: {
    /** Defaults to `kbn-detail-dragging`, styled by the file-reader frame. */
    draggingClass?: string
    onMoved?: () => void
    onSettle?: () => void
  },
): void {
  const dragClass = opts.draggingClass ?? 'kbn-detail-dragging'
  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('button, input, textarea, select')) return
    // A panel that is a sheet right now has no placement to drag.
    if (isSheetFrame(overlay)) return
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

/** Eight invisible resize zones on the file-reader window's edges and
 *  corners. Pointer-based, same lifecycle as drag; the minimum size keeps its
 *  header usable. Handle elements use `<handleClassPrefix>-<dir>` classes. */
export function attachPanelResize(
  overlay: HTMLElement,
  opts: {
    /** Defaults use the file-reader frame's shared stylesheet and {@link PANEL_MIN}. */
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
      if (isSheetFrame(overlay)) return
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
