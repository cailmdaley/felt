/**
 * The field's zoom: a scale and a shift, as shares of the plate. Geometry scales
 * about the pointer; marks and text stay their reading size because a drawing
 * repaints at the settled view. Between paints a gesture moves the plate's
 * layers by transform alone, so it costs no layout; a flight is one repaint at
 * its end, which every element drifts to together.
 */
export interface View { k: number; x: number; y: number }
export const WHOLE: View = { k: 1, x: 0, y: 0 }

const MOST = 64
/** A wheel's quiet after which its gesture has ended. */
const SETTLE_MS = 140
const SLOP = 6
const TAP_MS = 300
const TAP_REACH = 30
const WHEEL_RATE = .01
const WHEEL_MOST = 60
/** A flight's length, which family-map.css gives its drift. */
const FLY_MS = 400

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

interface Finger { x: number; y: number }
interface GestureEvent extends UIEvent { scale: number; clientX: number; clientY: number }

/** Pinch, wheel and drag over a host's `.fm-sky-plate`. At the base scale everything but a zoom stays the page's. */
export class FieldZoom {
  /** Where the gesture has reached. */
  private view: View = WHOLE
  /** The view the plate is painted at. */
  drawn: View = WHOLE
  private readonly host: HTMLElement
  private readonly settled: () => void
  private readonly stepOut: () => void
  private readonly listening = new AbortController()
  private readonly fingers = new Map<number, Finger>()
  private pinch: { view: View; gap: number; middle: Finger } | null = null
  private pan: { view: View; from: Finger; moved: boolean } | null = null
  private gesture: View | null = null
  private tap: Finger & { at: number } | null = null
  private frame = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private flight: ReturnType<typeof setTimeout> | null = null

  /** `settled` hears a gesture end, repainted by it; `stepOut` hears a double-click or double-tap on the field. */
  constructor(host: HTMLElement, settled: () => void, stepOut: () => void) {
    this.host = host; this.settled = settled; this.stepOut = stepOut
    const signal = this.listening.signal
    host.addEventListener('wheel', event => this.wheel(event), { passive: false, signal })
    host.addEventListener('pointerdown', event => this.down(event), { signal })
    host.addEventListener('touchmove', event => this.claim(event), { passive: false, signal })
    host.addEventListener('dblclick', event => { if (this.onField(event.target)) this.stepOut() }, { signal })
    host.addEventListener('gesturestart', event => this.gestureStart(event as GestureEvent), { signal })
    host.addEventListener('gesturechange', event => this.gestureChange(event as GestureEvent), { signal })
    host.addEventListener('gestureend', () => { this.gesture = null; this.settle() }, { signal })
    window.addEventListener('pointermove', event => this.move(event), { signal })
    window.addEventListener('pointerup', event => this.up(event), { signal })
    window.addEventListener('pointercancel', event => this.up(event), { signal })
  }

  dispose(): void {
    this.listening.abort()
    cancelAnimationFrame(this.frame)
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.flight !== null) clearTimeout(this.flight)
  }
  /** Takes up a view without moving: the caller's next paint is at it. */
  jump(view: View): void { this.view = this.drawn = held(view) }
  /** As `jump`, with the caller's next paint drifting there as one flight. */
  fly(view: View): void {
    this.jump(view)
    this.host.classList.add('family-map-flying')
    if (this.flight !== null) clearTimeout(this.flight)
    this.flight = setTimeout(() => { this.flight = null; this.host.classList.remove('family-map-flying') }, FLY_MS)
  }
  /** Forgets the view, for a stage a new drawing is taking. */
  forget(): void {
    this.jump(WHOLE)
    this.pinch = this.pan = this.gesture = null
    this.host.classList.remove('family-map-gesturing', 'family-map-pinching')
  }
  /** Brings an element the keys have reached back onto the field. */
  reveal(el: Element): void {
    const plate = this.plate()
    if (!plate || this.view.k === 1) return
    const box = plate.getBoundingClientRect(), mark = el.getBoundingClientRect()
    const x = (mark.left + mark.right) / 2, y = (mark.top + mark.bottom) / 2
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return
    this.view = held({ ...this.view, x: this.view.x + (box.left + box.width / 2 - x) / box.width, y: this.view.y + (box.top + box.height / 2 - y) / box.height })
    this.settle()
  }

  private plate(): HTMLElement | null { return this.host.querySelector<HTMLElement>('.fm-sky-plate') }
  private inPlate(target: EventTarget | null): boolean { return !!(target as Element | null)?.closest?.('.fm-sky-plate') }
  /** The empty field: the plate, not one of its threads or what a thread holds. */
  private onField(target: EventTarget | null): boolean { return this.inPlate(target) && !(target as Element).closest('[data-thread], [data-held]') }
  /** A point as shares of the plate, from the plate as painted. */
  private share(x: number, y: number): Finger {
    const box = this.plate()!.getBoundingClientRect()
    return { x: (x - box.left) / box.width, y: (y - box.top) / box.height }
  }

  private wheel(event: WheelEvent): void {
    if (!this.inPlate(event.target)) return
    const rows = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      const at = this.share(event.clientX, event.clientY)
      this.view = zoomAbout(this.view, Math.exp(-within(event.deltaY * rows, -WHEEL_MOST, WHEEL_MOST) * WHEEL_RATE), at.x, at.y)
    } else if (this.view.k > 1) {
      event.preventDefault()
      const box = this.plate()!.getBoundingClientRect()
      this.view = held({ ...this.view, x: this.view.x - event.deltaX * rows / box.width, y: this.view.y - event.deltaY * rows / box.height })
    } else return
    this.preview()
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.settle(), SETTLE_MS)
  }

  private down(event: PointerEvent): void {
    if (!this.inPlate(event.target) || event.button !== 0) return
    this.fingers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (this.fingers.size === 2) {
      this.pan = null
      this.startPinch()
      return
    }
    const body = this.host.classList.contains('family-map-radial') && (event.target as Element).closest('.fm-star')
    if (this.view.k > 1 && !body && (event.pointerType === 'touch' || this.onField(event.target))) this.startPan(event.clientX, event.clientY)
  }
  private startPan(x: number, y: number): void { this.pan = { view: this.view, from: { x, y }, moved: false } }
  private startPinch(): void {
    const [a, b] = [...this.fingers.values()]
    this.pinch = { view: this.view, gap: Math.hypot(a.x - b.x, a.y - b.y) || 1, middle: this.share((a.x + b.x) / 2, (a.y + b.y) / 2) }
    this.host.classList.add('family-map-pinching')
  }
  private move(event: PointerEvent): void {
    if (!this.fingers.has(event.pointerId)) return
    this.fingers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (this.pinch) {
      const [a, b] = [...this.fingers.values()], { view, gap, middle } = this.pinch
      const now = this.share((a.x + b.x) / 2, (a.y + b.y) / 2), zoomed = zoomAbout(view, Math.hypot(a.x - b.x, a.y - b.y) / gap, middle.x, middle.y)
      this.view = held({ ...zoomed, x: zoomed.x + now.x - middle.x, y: zoomed.y + now.y - middle.y })
      this.preview()
    } else if (this.pan) {
      const { view, from } = this.pan, dx = event.clientX - from.x, dy = event.clientY - from.y
      if (!this.pan.moved && Math.hypot(dx, dy) < SLOP) return
      this.pan.moved = true
      const box = this.plate()!.getBoundingClientRect()
      this.view = held({ ...view, x: view.x + dx / box.width, y: view.y + dy / box.height })
      this.preview()
    }
  }
  private up(event: PointerEvent): void {
    const finger = this.fingers.get(event.pointerId)
    if (!finger) return
    this.fingers.delete(event.pointerId)
    if (this.pinch) {
      this.pinch = null
      this.host.classList.remove('family-map-pinching')
      const [left] = this.fingers.values()
      if (left && this.view.k > 1) this.startPan(left.x, left.y)
      else this.settle()
      return
    }
    const panned = this.pan?.moved
    this.pan = null
    if (panned) {
      this.settle()
      const swallow = (click: Event): void => { click.stopPropagation() }
      this.host.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => this.host.removeEventListener('click', swallow, { capture: true }))
    } else if (event.pointerType === 'touch' && event.type === 'pointerup') this.tapped(event)
  }
  /** A second tap on the field where the first landed steps out, as a double-click does. */
  private tapped(event: PointerEvent): void {
    const tap = this.tap, at = event.timeStamp
    this.tap = null
    if (!this.onField(event.target)) return
    if (tap && at - tap.at < TAP_MS && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < TAP_REACH) this.stepOut()
    else this.tap = { x: event.clientX, y: event.clientY, at }
  }
  /** A pinch, or any touch on a zoomed plate, is the map's and not the page's. */
  private claim(event: TouchEvent): void {
    if (event.cancelable && (this.fingers.size > 1 || (this.view.k > 1 && this.inPlate(event.target)))) event.preventDefault()
  }
  private gestureStart(event: GestureEvent): void {
    if (this.fingers.size || !this.inPlate(event.target)) return
    event.preventDefault()
    this.gesture = this.view
  }
  private gestureChange(event: GestureEvent): void {
    if (!this.gesture) return
    event.preventDefault()
    const at = this.share(event.clientX, event.clientY)
    this.view = zoomAbout(this.gesture, event.scale, at.x, at.y)
    this.preview()
  }

  /** Moves the painted plate's layers to the view, once a frame. */
  private preview(): void {
    this.host.classList.add('family-map-gesturing')
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      const plate = this.plate()
      if (!plate) return
      const share = this.view.k / this.drawn.k
      const x = (this.view.x - this.drawn.x * share) * plate.clientWidth, y = (this.view.y - this.drawn.y * share) * plate.clientHeight
      for (const layer of plate.children as Iterable<HTMLElement | SVGElement>) layer.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${share.toFixed(4)})`
    })
  }
  /** The gesture is over: the drawing repaints at the view, in one step with the layers' release. */
  private settle(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    cancelAnimationFrame(this.frame)
    this.frame = 0
    this.drawn = this.view
    this.settled()
    for (const layer of (this.plate()?.children ?? []) as Iterable<HTMLElement | SVGElement>) layer.style.transform = ''
    this.host.classList.remove('family-map-gesturing')
  }
}
