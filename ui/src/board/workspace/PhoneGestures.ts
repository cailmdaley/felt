/** A latched page swipe as it travels: the follow offset, then its release or abandonment. */
export type SwipeSignal = { phase: 'move'; dx: number } | { phase: 'end'; dx: number; velocity: number } | { phase: 'cancel' }

/** Recognition measures, in CSS pixels and milliseconds. */
export const SWIPE = { edge: 24, slop: 10, ratio: 1.75, hold: 500, window: 100 } as const

/**
 * A one-finger horizontal page swipe over `root`, written as touch events so
 * vertical scrolling stays native until the gesture is decisively sideways.
 * Starts within `edge` px of either side belong to Safari's edge-back; content
 * that pans sideways itself (scrollable regions, sliders, media, editing, a
 * live selection, pinch zoom) keeps the touch. It closes over nothing, because
 * documents receive it serialized; `screen` measures travel in screen space,
 * which a frame needs because it moves under the finger while following.
 */
export function installPageSwipe(root: Document | HTMLElement, signal: (signal: SwipeSignal) => void,
  enabled: () => boolean, limits: { edge: number; slop: number; ratio: number; hold: number; window: number }, screen = false): () => void {
  const doc = (root as Node).ownerDocument ?? (root as Document)
  const win = doc.defaultView as Window
  const boundary = root === doc ? null : root as HTMLElement
  let drag: { id: number; x: number; y: number; at: number; dx: number; latched: boolean; samples: Array<[number, number]> } | null = null
  const along = (touch: Touch): number => screen && Number.isFinite(touch.screenX) ? touch.screenX : touch.clientX
  const claimed = (target: EventTarget | null): boolean => {
    const selection = win.getSelection()
    if (selection && !selection.isCollapsed) return true
    if ((win.visualViewport?.scale ?? 1) > 1.01) return true
    let el = (target as Node | null)?.nodeType === 1 ? target as Element : (target as Node | null)?.parentElement ?? null
    for (; el && el !== boundary; el = el.parentElement) {
      if (el.matches('input,textarea,select,audio,video,iframe,embed,object,[role="slider"],[contenteditable]:not([contenteditable="false"]),[data-ws-swipe="off"]')) return true
      const style = win.getComputedStyle(el)
      if (style.touchAction === 'none' || (/pan-(x|left|right)/.test(style.touchAction) && !/pan-y/.test(style.touchAction))) return true
      if (el.scrollWidth > el.clientWidth + 1 && (/auto|scroll/.test(style.overflowX) || el === doc.scrollingElement)) return true
    }
    return false
  }
  const touchOf = (event: TouchEvent): Touch | null => {
    for (const touch of Array.from(event.changedTouches)) if (touch.identifier === drag?.id) return touch
    return null
  }
  const abandon = (): void => {
    const latched = drag?.latched
    drag = null
    if (latched) signal({ phase: 'cancel' })
  }
  const start = (event: TouchEvent): void => {
    if (drag) { abandon(); return }
    const touch = event.touches.length === 1 ? event.touches[0] : null
    if (!touch || !event.isTrusted || !enabled()) return
    if (touch.clientX < limits.edge || touch.clientX > win.innerWidth - limits.edge || claimed(event.target)) return
    drag = { id: touch.identifier, x: along(touch), y: touch.clientY, at: event.timeStamp, dx: 0, latched: false, samples: [] }
  }
  const move = (event: TouchEvent): void => {
    const touch = drag && touchOf(event)
    if (!drag || !touch) return
    if (event.touches.length > 1 || !event.isTrusted) { abandon(); return }
    const dx = along(touch) - drag.x, dy = touch.clientY - drag.y
    if (!drag.latched) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < limits.slop) return
      if (event.timeStamp - drag.at > limits.hold || Math.abs(dx) < Math.abs(dy) * limits.ratio || !enabled()) { drag = null; return }
      drag.latched = true
    }
    if (event.cancelable) event.preventDefault()
    drag.dx = dx
    drag.samples.push([event.timeStamp, dx])
    while (drag.samples.length > 2 && event.timeStamp - drag.samples[0][0] > limits.window) drag.samples.shift()
    signal({ phase: 'move', dx })
  }
  const end = (event: TouchEvent): void => {
    const touch = drag && touchOf(event)
    if (!drag || !touch) return
    const current = drag
    drag = null
    if (!current.latched) return
    if (event.type === 'touchcancel' || !event.isTrusted) { signal({ phase: 'cancel' }); return }
    const dx = along(touch) - current.x
    const [first] = current.samples
    const elapsed = first ? event.timeStamp - first[0] : 0
    const velocity = first && elapsed > 0 ? (dx - first[1]) / elapsed : 0
    signal({ phase: 'end', dx, velocity: Number.isFinite(velocity) ? Math.max(-20, Math.min(20, velocity)) : 0 })
  }
  const escape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !drag?.latched) return
    event.preventDefault(); event.stopImmediatePropagation()
    abandon()
  }
  const passive = { capture: true, passive: true }
  const active = { capture: true, passive: false }
  root.addEventListener('touchstart', start as EventListener, passive)
  root.addEventListener('touchmove', move as EventListener, active)
  root.addEventListener('touchend', end as EventListener, passive)
  root.addEventListener('touchcancel', end as EventListener, passive)
  win.addEventListener('keydown', escape, true)
  return () => {
    abandon()
    root.removeEventListener('touchstart', start as EventListener, passive)
    root.removeEventListener('touchmove', move as EventListener, active)
    root.removeEventListener('touchend', end as EventListener, passive)
    root.removeEventListener('touchcancel', end as EventListener, passive)
    win.removeEventListener('keydown', escape, true)
  }
}

/** The page a released swipe settles on: past ~28% of the width, or flicked, toward an existing neighbour. */
export function swipeOutcome(dx: number, velocity: number, width: number, hasPrevious: boolean, hasNext: boolean): -1 | 0 | 1 {
  const direction = dx < 0 ? 1 : dx > 0 ? -1 : 0
  if (!direction || (direction < 0 && !hasPrevious) || (direction > 0 && !hasNext)) return 0
  const far = Math.abs(dx) > width * 0.28
  const flick = Math.abs(dx) > 24 && Math.abs(velocity) > 0.3 && Math.sign(velocity) === Math.sign(dx)
  const reversed = Math.abs(velocity) > 0.3 && Math.sign(velocity) === -Math.sign(dx)
  return (far && !reversed) || flick ? direction : 0
}

/** Travel past the first or last page resists, as a native pager's edge does. */
export function swipeFollow(dx: number, width: number, hasPrevious: boolean, hasNext: boolean): number {
  const open = dx > 0 ? hasPrevious : hasNext
  if (open) return Math.max(-width, Math.min(width, dx))
  const limit = width * 0.18
  return Math.sign(dx) * limit * (1 - 1 / (Math.abs(dx) / limit + 1))
}

/** A settle that carries the finger's speed: faster flicks finish sooner, never slower than a crossing. */
export function swipeSettleTime(remaining: number, velocity: number, crossing: number): number {
  const speed = Math.max(Math.abs(velocity), 0.6)
  return Math.round(Math.max(160, Math.min(crossing, remaining / speed * 1.6)))
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
