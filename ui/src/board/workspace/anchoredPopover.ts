/**
 * One positioning rule for every popover, menu and dropdown the fiber page and
 * its plates open: anchored to the control that opened it, flipped or shifted
 * to stay inside the viewport and above the phone's bottom bar, and never
 * clipped by an ancestor's `overflow` or displaced by an ancestor's transform.
 *
 * Where the Popover API exists the panel is promoted to the top layer, which
 * escapes clipping and transformed containing blocks while leaving it in place
 * in the DOM, so scoped styles, inheritance and event delegation still apply.
 * The panel follows its trigger through scrolling and resizing until released;
 * a panel whose content changes size asks to be placed again with `reposition`.
 */
export type Placement = 'below-start' | 'below-end' | 'above-start' | 'above-end'

export interface AnchorOptions {
  /** Preferred side and edge alignment; the side flips when the other has more room. */
  placement?: Placement
  /** Space between trigger and panel, in px. */
  gap?: number
  /** Minimum distance kept from the viewport's edges, in px. */
  margin?: number
  /** The panel is at least as wide as its trigger. */
  matchWidth?: boolean
}

/**
 * Releases an anchored panel when called: stops following and leaves the top
 * layer. `reposition` places it again against its trigger, for content that
 * has changed size; after release it does nothing.
 */
export type Release = (() => void) & { reposition: () => void }

const STYLE_KEYS = ['position', 'inset', 'margin', 'left', 'top', 'maxHeight', 'minWidth', 'overflowY', 'color', 'zIndex'] as const

/** The lowest y a popover may reach: the viewport's bottom, or the top of a visible phone bottom bar. */
export function popoverFloor(): number {
  let bottom = document.documentElement.clientHeight || window.innerHeight
  for (const bar of document.querySelectorAll<HTMLElement>('[data-part="phone-bottom-bar"]')) {
    const rect = bar.getBoundingClientRect()
    if (rect.height > 0 && rect.width > 0 && rect.top > 0 && rect.top < bottom) bottom = rect.top
  }
  return bottom
}

/** Places `panel` against `trigger` and keeps it there until the returned release is called. */
export function anchorPopover(panel: HTMLElement, trigger: HTMLElement, options: AnchorOptions = {}): Release {
  const { placement = 'below-start', gap = 4, margin = 8, matchWidth = false } = options
  const topLayer = typeof panel.showPopover === 'function'
  if (topLayer) {
    if (!panel.hasAttribute('popover')) panel.setAttribute('popover', 'manual')
    if (!panel.matches(':popover-open')) panel.showPopover()
  }
  Object.assign(panel.style, { position: 'fixed', inset: 'auto', margin: '0', color: 'inherit', zIndex: '10000' })
  panel.dataset.anchored = ''

  let released = false
  const place = (): void => {
    if (released || !panel.isConnected || !trigger.isConnected) return
    const anchor = trigger.getBoundingClientRect()
    panel.style.maxHeight = ''
    panel.style.overflowY = ''
    panel.style.minWidth = matchWidth ? `${anchor.width}px` : ''
    const width = panel.offsetWidth
    const natural = panel.offsetHeight
    const right = document.documentElement.clientWidth || window.innerWidth
    const floor = popoverFloor()
    const below = floor - margin - (anchor.bottom + gap)
    const above = anchor.top - gap - margin
    let side: 'above' | 'below' = placement.startsWith('above') ? 'above' : 'below'
    if (side === 'below' && natural > below && above > below) side = 'above'
    else if (side === 'above' && natural > above && below > above) side = 'below'
    const room = Math.max(0, side === 'below' ? below : above)
    if (natural > room) { panel.style.maxHeight = `${room}px`; panel.style.overflowY = 'auto' }
    const height = Math.min(natural, room)
    const top = side === 'below' ? anchor.bottom + gap : anchor.top - gap - height
    const preferred = placement.endsWith('end') ? anchor.right - width : anchor.left
    const left = Math.max(margin, Math.min(preferred, right - margin - width))
    panel.style.left = `${Math.round(left)}px`
    panel.style.top = `${Math.round(top)}px`
    panel.dataset.side = side
  }

  let frame = 0
  const follow = (): void => {
    if (frame) return
    frame = requestAnimationFrame(() => { frame = 0; place() })
  }
  place()
  window.addEventListener('scroll', follow, true)
  window.addEventListener('resize', follow)
  window.visualViewport?.addEventListener('resize', follow)

  const release = (): void => {
    if (released) return
    released = true
    if (frame) cancelAnimationFrame(frame)
    window.removeEventListener('scroll', follow, true)
    window.removeEventListener('resize', follow)
    window.visualViewport?.removeEventListener('resize', follow)
    if (topLayer && panel.matches(':popover-open')) panel.hidePopover()
    if (topLayer) panel.removeAttribute('popover')
    for (const key of STYLE_KEYS) panel.style[key] = ''
    delete panel.dataset.anchored
    delete panel.dataset.side
  }
  return Object.assign(release, { reposition: place })
}
