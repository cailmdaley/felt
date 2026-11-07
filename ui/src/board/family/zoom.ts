import { select, type Selection } from 'd3-selection'
import 'd3-transition'
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'

/**
 * The field's zoom: a scale and a shift, as shares of the plate. d3-zoom owns
 * the gesture and the flight; every frame of either repaints the drawing at
 * the view it has reached, so marks and text hold their reading size while the
 * geometry scales about the pointer.
 */
export interface View { k: number; x: number; y: number }
export const WHOLE: View = { k: 1, x: 0, y: 0 }

/** Deep enough for three generations, each a room inside its orchestrator's. */
const MOST = 4096
/** A wheel's quiet after which its pan has ended. */
const SETTLE_MS = 140
const SLOP = 6
const WHEEL_RATE = .01
const WHEEL_MOST = 60
const FLY_MS = 620

const within = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value))
/** How far past the plate's edge a field at this scale may go, so a body at its rim can reach the middle. */
const overrun = (k: number): number => Math.min(.5, (k - 1) / 2)
/** Keeps the field over the plate, give or take its overrun: at the base scale, no shift at all. */
export const held = ({ k, x, y }: View): View => {
  const scale = within(k, 1, MOST), past = overrun(scale)
  return { k: scale, x: within(x, 1 - scale - past, past), y: within(y, 1 - scale - past, past) }
}
/** `view` scaled by `factor` with the plate's point at `px`, `py` staying where it is. */
export function zoomAbout(view: View, factor: number, px: number, py: number): View {
  const k = within(view.k * factor, 1, MOST), share = k / view.k
  return held({ k, x: px - (px - view.x) * share, y: py - (py - view.y) * share })
}

interface GestureEvent extends UIEvent { scale: number; clientX: number; clientY: number }

/** Pinch, wheel and drag over a host's `.fm-sky-plate`. At the base scale everything but a zoom stays the page's. */
export class FieldZoom {
  /** Where the field stands, moved every frame of a gesture or a flight. */
  drawn: View = WHOLE
  /** A flight is under way. */
  flying = false
  private readonly host: HTMLElement
  private readonly canvas: Selection<HTMLElement, unknown, null, undefined>
  private readonly behavior: ZoomBehavior<HTMLElement, unknown>
  private readonly moved: () => void
  private readonly settled: (inward: boolean) => void
  private readonly listening = new AbortController()
  private gesture: View | null = null
  private silent = false
  /** The scale a hand last left the field at. */
  private grasped = 1
  private frame = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  /** `moved` hears each frame of the field moving; `settled` a hand letting go of it, and whether it went in; `stepOut` a double-click or double-tap on the field. */
  constructor(host: HTMLElement, moved: () => void, settled: (inward: boolean) => void, stepOut: () => void) {
    this.host = host; this.moved = moved; this.settled = settled
    this.canvas = select(host)
    this.behavior = zoom<HTMLElement, unknown>()
      .scaleExtent([1, MOST])
      .extent((): [[number, number], [number, number]] => { const { width, height } = this.size(); return [[0, 0], [width, height]] })
      .constrain(transform => this.transform(held(this.view(transform))))
      .wheelDelta(event => -within(event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1), -WHEEL_MOST, WHEEL_MOST) * WHEEL_RATE)
      .clickDistance(SLOP)
      .filter(event => this.takes(event))
      .on('zoom', (event: D3ZoomEvent<HTMLElement, unknown>) => this.reached(event.transform))
      .on('end', (event: D3ZoomEvent<HTMLElement, unknown>) => { if (event.sourceEvent) this.settle() })
    this.canvas.call(this.behavior).on('dblclick.zoom', (event: Event) => { if (this.onField(event.target)) stepOut() })
    const signal = this.listening.signal
    host.addEventListener('wheel', event => this.wheel(event), { passive: false, signal })
    host.addEventListener('gesturestart', event => this.gestureStart(event as GestureEvent), { signal })
    host.addEventListener('gesturechange', event => this.gestureChange(event as GestureEvent), { signal })
    host.addEventListener('gestureend', () => { this.gesture = null; this.settle() }, { signal })
  }

  dispose(): void {
    this.listening.abort()
    this.canvas.interrupt().on('.zoom', null)
    cancelAnimationFrame(this.frame)
    if (this.timer !== null) clearTimeout(this.timer)
  }
  /** Takes up a view without moving: the caller's next paint is at it. */
  jump(view: View): void {
    this.canvas.interrupt()
    this.drawn = held(view)
    this.grasped = this.drawn.k
    this.silent = true
    this.behavior.transform(this.canvas, this.transform(this.drawn))
    this.silent = false
  }
  /** Flies the field to a view, along the path that keeps both ends in sight; at once under reduced motion. */
  fly(view: View): void {
    const end = this.transform(held(view))
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { this.jump(view); return }
    this.flying = true
    this.host.classList.add('family-map-moving')
    this.canvas.interrupt().transition().duration(FLY_MS).call(this.behavior.transform, end)
      .on('end interrupt', () => {
        this.flying = false
        this.grasped = this.drawn.k
        this.moved()
        this.rest()
      })
  }
  /** Forgets the view, for a stage a new drawing is taking. */
  forget(): void {
    this.gesture = null
    this.jump(WHOLE)
    this.host.classList.remove('family-map-moving')
  }
  /** Brings an element the keys have reached back onto the field. */
  reveal(el: Element): void {
    const plate = this.plate()
    if (!plate || this.drawn.k === 1) return
    const box = plate.getBoundingClientRect(), mark = el.getBoundingClientRect()
    const x = (mark.left + mark.right) / 2, y = (mark.top + mark.bottom) / 2
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return
    this.behavior.transform(this.canvas, this.transform({ ...this.drawn, x: this.drawn.x + (box.left + box.width / 2 - x) / box.width, y: this.drawn.y + (box.top + box.height / 2 - y) / box.height }))
    this.settle()
  }

  private plate(): HTMLElement | null { return this.host.querySelector<HTMLElement>('.fm-sky-plate') }
  private size(): { width: number; height: number } {
    const plate = this.plate()
    return { width: plate?.clientWidth || this.host.clientWidth || 1000, height: plate?.clientHeight || this.host.clientHeight || 680 }
  }
  private transform({ k, x, y }: View): ZoomTransform {
    const { width, height } = this.size()
    return zoomIdentity.translate(x * width, y * height).scale(k)
  }
  private view({ k, x, y }: ZoomTransform): View {
    const { width, height } = this.size()
    return { k, x: x / width, y: y / height }
  }
  private inPlate(target: EventTarget | null): boolean { return !!(target as Element | null)?.closest?.('.fm-sky-plate') }
  /** The empty field: the plate, not one of its threads or what a thread holds. */
  private onField(target: EventTarget | null): boolean { return this.inPlate(target) && !(target as Element).closest('[data-thread], [data-held]') }
  /** What d3-zoom may start: a pinch or a modified wheel anywhere on the plate; once zoomed, a drag of the field, or a finger off a draggable body. */
  private takes(event: Event): boolean {
    if (!this.inPlate(event.target)) return false
    if (event.type === 'wheel') return (event as WheelEvent).ctrlKey || (event as WheelEvent).metaKey
    const touches = (event as TouchEvent).touches?.length ?? 0
    if (touches > 1) return true
    if ((event as MouseEvent).button) return false
    if (this.drawn.k === 1) return false
    const body = this.host.classList.contains('family-map-radial') && !!(event.target as Element).closest('.fm-star')
    return !body && (touches === 1 || this.onField(event.target))
  }
  /** The plain wheel pans a zoomed field, and is the page's at the base scale. */
  private wheel(event: WheelEvent): void {
    if (event.ctrlKey || event.metaKey || this.drawn.k === 1 || !this.inPlate(event.target)) return
    event.preventDefault()
    const rows = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1, { width, height } = this.size()
    this.behavior.transform(this.canvas, this.transform({ ...this.drawn, x: this.drawn.x - event.deltaX * rows / width, y: this.drawn.y - event.deltaY * rows / height }))
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.settle(), SETTLE_MS)
  }
  private gestureStart(event: GestureEvent): void {
    if (!this.inPlate(event.target)) return
    event.preventDefault()
    this.gesture = this.drawn
  }
  private gestureChange(event: GestureEvent): void {
    if (!this.gesture) return
    event.preventDefault()
    const box = this.plate()!.getBoundingClientRect()
    this.behavior.transform(this.canvas, this.transform(zoomAbout(this.gesture, event.scale, (event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height)))
  }

  /** The field has reached a transform: at most one repaint a frame. */
  private reached(transform: ZoomTransform): void {
    if (this.silent) return
    this.drawn = this.view(transform)
    this.host.classList.add('family-map-moving')
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.moved()
    })
  }
  /** The hand has let go. */
  private settle(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    cancelAnimationFrame(this.frame)
    this.frame = 0
    const inward = this.drawn.k > this.grasped
    this.grasped = this.drawn.k
    this.settled(inward)
    if (!this.flying) this.rest()
  }
  /** Whatever was painted last stands, and later changes glide again. */
  private rest(): void {
    requestAnimationFrame(() => requestAnimationFrame(() => this.host.classList.remove('family-map-moving')))
  }
}

