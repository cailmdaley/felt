const ANGLE = Math.tan(Math.PI / 6)

/** Horizontal intent is latched only beyond 12 px and within 30° of the bar. */
export function barSwipeIntent(dx: number, dy: number): -1 | 0 | 1 {
  return Math.abs(dx) > 12 && Math.abs(dy) < Math.abs(dx) * ANGLE ? (dx < 0 ? 1 : -1) : 0
}

/** A cancellable page gesture confined to chrome, leaving browser edges and vertical pans alone. */
export function installBarSwipe(bar: HTMLElement, enabled: () => boolean, step: (delta: number) => void): () => void {
  let drag: { id: number; x: number; y: number; dx: number; dy: number; latched: boolean } | null = null
  let suppressClick = false
  const cancel = (): void => {
    const current = drag
    drag = null
    if (current?.latched && bar.hasPointerCapture(current.id)) bar.releasePointerCapture(current.id)
  }
  const down = (event: PointerEvent): void => {
    suppressClick = false
    if (!enabled() || !event.isPrimary || event.button !== 0 || event.clientX < 24 || event.clientX > window.innerWidth - 24) return
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0, latched: false }
  }
  const move = (event: PointerEvent): void => {
    if (!drag || drag.id !== event.pointerId) return
    drag.dx = event.clientX - drag.x; drag.dy = event.clientY - drag.y
    if (!drag.latched) {
      if (Math.max(Math.abs(drag.dx), Math.abs(drag.dy)) <= 12) return
      if (!barSwipeIntent(drag.dx, drag.dy)) { cancel(); return }
      drag.latched = true
      suppressClick = true
      bar.setPointerCapture(event.pointerId)
    }
    event.preventDefault()
  }
  const up = (event: PointerEvent): void => {
    if (!drag || drag.id !== event.pointerId) return
    const delta = drag.latched ? barSwipeIntent(event.clientX - drag.x, event.clientY - drag.y) : 0
    cancel()
    if (delta && enabled()) step(delta)
  }
  const click = (event: MouseEvent): void => {
    if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation() }
  }
  const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape' && drag) { cancel(); event.preventDefault(); event.stopImmediatePropagation() } }
  bar.addEventListener('pointerdown', down)
  bar.addEventListener('pointermove', move)
  bar.addEventListener('pointerup', up)
  bar.addEventListener('pointercancel', cancel)
  bar.addEventListener('lostpointercapture', cancel)
  bar.addEventListener('click', click, true)
  window.addEventListener('keydown', escape, true)
  return () => {
    cancel()
    bar.removeEventListener('pointerdown', down); bar.removeEventListener('pointermove', move)
    bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', cancel)
    bar.removeEventListener('lostpointercapture', cancel); bar.removeEventListener('click', click, true)
    window.removeEventListener('keydown', escape, true)
  }
}

/** Small scroll reversals accumulate; document tops always reveal the return control. */
export class PhoneTopbar {
  private key = ''
  private anchor = 0
  private previous = 0
  private direction = 0
  private readonly show: (hidden: boolean) => void
  constructor(show: (hidden: boolean) => void) { this.show = show }
  select(key: string, y = 0): void {
    if (key === this.key) return
    this.key = key; this.anchor = this.previous = y; this.direction = 0
    this.show(false)
  }
  scroll(key: string, y: number): void {
    if (key !== this.key || !Number.isFinite(y)) return
    y = Math.max(0, y)
    const direction = Math.sign(y - this.previous)
    if (direction && direction !== this.direction) { this.anchor = this.previous; this.direction = direction }
    this.previous = y
    if (y <= 2) { this.show(false); this.anchor = y }
    else if (Math.abs(y - this.anchor) >= 8) { this.show(direction > 0); this.anchor = y }
  }
}
