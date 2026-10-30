/**
 * The rail's shared region parts: a fold heading every region opens with, the
 * draggable boundaries between regions, and the pointer drag both the rail's
 * width handle and those boundaries use.
 */

/** Arrow-key step for a handle, in pixels; Shift multiplies it by four. */
export const HANDLE_STEP = 16

/**
 * One pointer drag on a resize handle: past a 4px latch, `apply` receives the
 * pointer's travel along `axis`; release commits, and cancel or Escape restores.
 * While it runs the rail carries the axis's cursor and the artifact's page ignores the pointer.
 */
export function dragHandle(handle: HTMLElement, e: PointerEvent, axis: 'x' | 'y', rail: HTMLElement, apply: (delta: number) => void, finish: (commit: boolean) => void): void {
  if (e.button !== 0) return
  e.preventDefault()
  const start = axis === 'x' ? e.clientX : e.clientY
  try { handle.setPointerCapture(e.pointerId) } catch { /* Capture is an enhancement. */ }
  const marker = axis === 'x' ? 'ws-thread-resizing' : 'ws-thread-splitting'
  rail.classList.add(marker)
  let latched = false
  const move = (ev: PointerEvent): void => {
    const delta = (axis === 'x' ? ev.clientX : ev.clientY) - start
    if (!latched && Math.abs(delta) < 4) return
    latched = true
    apply(delta)
  }
  const end = (commit: boolean): void => {
    handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up)
    handle.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', key, true)
    rail.classList.remove(marker)
    try { if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId) } catch { /* Already released. */ }
    if (latched) finish(commit)
  }
  const up = (): void => end(true), cancel = (): void => end(false)
  const key = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); end(false) } }
  handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up)
  handle.addEventListener('pointercancel', cancel); window.addEventListener('keydown', key, true)
}

function stored(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* Storage is optional. */ }
}

/**
 * A region's heading: its name as a button that folds the region, open by
 * default, remembered per viewer.
 */
export class RailFold {
  readonly heading = document.createElement('h2')
  readonly button = document.createElement('button')
  private expanded: boolean
  private readonly storage: string
  private readonly changed: () => void
  constructor(label: string, storage: string, changed: () => void) {
    this.storage = storage; this.changed = changed
    this.heading.className = 'ws-thread-heading'
    this.button.type = 'button'; this.button.className = 'ws-rail-fold'; this.button.textContent = label
    this.button.addEventListener('click', () => this.set(!this.expanded, true))
    this.heading.append(this.button)
    this.expanded = stored(storage) !== 'false'
    this.paint()
  }
  get open(): boolean { return this.expanded }
  focus(): void { this.button.focus({ preventScroll: true }) }
  private set(open: boolean, persist: boolean): void {
    this.expanded = open; this.paint()
    if (persist) store(this.storage, String(open))
    this.changed()
  }
  private paint(): void { this.button.setAttribute('aria-expanded', String(this.expanded)) }
}

export interface RailSplitOptions {
  label: string
  storage: string
  /** The region whose height the boundary sets. */
  region: HTMLElement
  /** Whether dragging the boundary down grows the region (it sits above) or shrinks it (below). */
  below: boolean
  bounds: () => { min: number; max: number }
  changed: () => void
}

/**
 * A boundary between two regions that sets one region's height by drag or
 * arrow keys, persists it per viewer, and resets to the stylesheet's own
 * height on double-click. It stands only where the rail asks for it.
 */
export class RailSplit {
  readonly el = document.createElement('div')
  private height: number | null
  private active = false
  private readonly rail: HTMLElement
  private readonly o: RailSplitOptions
  constructor(rail: HTMLElement, o: RailSplitOptions) {
    this.rail = rail; this.o = o
    const el = this.el
    el.className = 'ws-rail-split'; el.hidden = true
    el.setAttribute('role', 'separator'); el.setAttribute('aria-orientation', 'horizontal'); el.setAttribute('aria-label', o.label)
    el.title = 'Drag to resize · double-click to reset'; el.tabIndex = 0
    el.addEventListener('pointerdown', e => this.start(e))
    el.addEventListener('keydown', e => this.key(e))
    el.addEventListener('dblclick', () => this.set(null, true))
    const value = Number(stored(o.storage))
    this.height = Number.isFinite(value) && value > 0 ? value : null
  }
  /** Stand the boundary or stand it down; standing, the reader's height, clamped, holds the region. */
  apply(active: boolean): void {
    this.active = active
    this.el.hidden = !active
    const region = this.o.region
    if (!active || this.height === null) {
      region.removeAttribute('data-sized'); region.style.removeProperty('--ws-rail-region-height'); this.el.removeAttribute('aria-valuenow')
      return
    }
    const { min, max } = this.o.bounds(), height = Math.min(max, Math.max(min, Math.round(this.height)))
    region.setAttribute('data-sized', ''); region.style.setProperty('--ws-rail-region-height', `${height}px`)
    this.el.setAttribute('aria-valuemin', String(min)); this.el.setAttribute('aria-valuemax', String(max)); this.el.setAttribute('aria-valuenow', String(height))
  }
  private set(height: number | null, persist: boolean): void {
    this.height = height
    if (persist) store(this.o.storage, height === null ? null : String(Math.round(height)))
    this.apply(this.active); this.o.changed()
  }
  private clamp(height: number): number {
    const { min, max } = this.o.bounds()
    return Math.min(max, Math.max(min, height))
  }
  private start(e: PointerEvent): void {
    const from = this.o.region.getBoundingClientRect().height, before = this.height, sign = this.o.below ? -1 : 1
    dragHandle(this.el, e, 'y', this.rail, delta => this.set(this.clamp(from + sign * delta), false),
      commit => this.set(commit ? this.height : before, commit))
  }
  private key(e: KeyboardEvent): void {
    const { min, max } = this.o.bounds(), now = this.o.region.getBoundingClientRect().height
    const step = HANDLE_STEP * (e.shiftKey ? 4 : 1) * (this.o.below ? -1 : 1)
    // Down moves the boundary down; Home and End take it to the region's smallest and largest heights.
    const next = e.key === 'ArrowDown' ? now + step : e.key === 'ArrowUp' ? now - step
      : e.key === 'Home' ? min : e.key === 'End' ? max : e.key === 'Enter' ? null : undefined
    if (next === undefined) return
    e.preventDefault(); e.stopPropagation()
    this.set(next === null ? null : this.clamp(next), true)
  }
}
