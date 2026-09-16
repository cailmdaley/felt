/**
 * Long press — the touch gesture that stands in for a right-click.
 *
 * Touch has no drag-and-drop backend and no context menu worth having, so a
 * card's "what can I do with this" has to come from somewhere. It comes from
 * holding the card still. The rules are the platform's own, written out because
 * the browser will not do it for us: a press fires once it has been held for
 * `holdMs` WITHOUT travelling more than `slopPx`, and any movement past that
 * radius, any lift, any cancel (a scroll taking over, a drag starting) takes it
 * back down. A finger that is on its way somewhere else is not a long press.
 *
 * The timing lives in a plain object with injectable timers so it can be tested
 * without a DOM — `attachLongPress` below is the thin binding that turns real
 * pointer events into calls on it.
 */

import { suppressNextClick } from './dismissGesture.js'

export const LONG_PRESS_HOLD_MS = 450
export const LONG_PRESS_SLOP_PX = 8

export interface LongPressPoint {
  x: number
  y: number
}

export interface LongPressOptions {
  /** Held this long without travelling, the press fires. */
  holdMs?: number
  /** Travel past this radius (in CSS px) and the press is abandoned. */
  slopPx?: number
  onFire: () => void
  /** Called when a press begins and when it ends, fired or not — the hook the
   *  DOM binding uses to tint the card under the thumb. */
  onPressChange?: (pressing: boolean) => void
  setTimer?: (fn: () => void, ms: number) => number
  clearTimer?: (id: number) => void
}

export class LongPressTracker {
  private readonly holdMs: number
  private readonly slopPx: number
  private readonly onFire: () => void
  private readonly onPressChange: (pressing: boolean) => void
  private readonly setTimer: (fn: () => void, ms: number) => number
  private readonly clearTimer: (id: number) => void

  private timer: number | null = null
  private origin: LongPressPoint | null = null
  private pointerId: number | null = null

  constructor(opts: LongPressOptions) {
    this.holdMs = opts.holdMs ?? LONG_PRESS_HOLD_MS
    this.slopPx = opts.slopPx ?? LONG_PRESS_SLOP_PX
    this.onFire = opts.onFire
    this.onPressChange = opts.onPressChange ?? (() => {})
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number)
    this.clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id))
  }

  get pressing(): boolean {
    return this.timer !== null
  }

  down(pointerId: number, at: LongPressPoint): void {
    // A SECOND finger is not a longer press. Arm the first one only; the
    // pinch-or-two-thumbs case should do nothing rather than fire on whichever
    // finger happened to stay still.
    if (this.pointerId !== null) {
      this.cancel()
      return
    }
    this.pointerId = pointerId
    this.origin = at
    this.timer = this.setTimer(() => {
      this.timer = null
      this.origin = null
      this.pointerId = null
      this.onPressChange(false)
      // Any selection iOS started under the held finger goes before the menu
      // rises, or its Copy/Look Up callout follows the menu up.
      globalThis.getSelection?.()?.removeAllRanges()
      this.onFire()
    }, this.holdMs)
    this.onPressChange(true)
  }

  move(pointerId: number, at: LongPressPoint): void {
    if (this.pointerId !== pointerId || !this.origin) return
    const dx = at.x - this.origin.x
    const dy = at.y - this.origin.y
    if (Math.hypot(dx, dy) > this.slopPx) this.cancel()
  }

  /** Lift, cancel, drag start, scroll — every way a press stops being one. */
  cancel(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
      this.onPressChange(false)
    }
    this.origin = null
    this.pointerId = null
  }

}

/**
 * Bind a tracker to one element.
 *
 * `pointerdown` is listened for on the element and the rest on the element too
 * — a pointer capture would fight the native drag, so instead the window's
 * `pointerup`/`pointercancel` close the gesture wherever the finger ends up.
 * `contextmenu` is refused while pressed so iOS does not raise its selection
 * callout over the menu we are about to open.
 *
 * THE CLICK THAT FOLLOWS A FIRED PRESS is swallowed AT THE WINDOW, not at the
 * card. The gesture and the click are one pointer sequence, so the browser
 * sends a click as soon as the finger lifts — but by then the menu's scrim is
 * covering the card, and the click's target is the SCRIM. A suppression that
 * waited on the card would never see that click, would stay armed, and would
 * eat the reader's next real tap instead (a card that refuses to open once,
 * for no visible reason). One-shot and self-expiring at the window catches the
 * click wherever it lands and forgets about it if none comes.
 */
export function attachLongPress(el: HTMLElement, opts: LongPressOptions): () => void {
  const tracker = new LongPressTracker({
    ...opts,
    onPressChange: (pressing) => {
      el.classList.toggle('kbn-longpress-held', pressing)
      opts.onPressChange?.(pressing)
    },
    onFire: () => {
      suppressNextClick(window)
      opts.onFire()
    },
  })

  const onDown = (e: PointerEvent): void => {
    // Only the primary button: a right-click already has a context menu, and a
    // middle-click drag is not a press.
    if (e.button !== 0) return
    tracker.down(e.pointerId, { x: e.clientX, y: e.clientY })
  }
  const onMove = (e: PointerEvent): void => tracker.move(e.pointerId, { x: e.clientX, y: e.clientY })
  const onEnd = (): void => tracker.cancel()
  const onContextMenu = (e: Event): void => {
    if (tracker.pressing) e.preventDefault()
  }

  el.addEventListener('pointerdown', onDown)
  el.addEventListener('pointermove', onMove)
  el.addEventListener('contextmenu', onContextMenu)
  // A drag that gets going is the other reading of the same press — desktop
  // keeps its drag, and the timer must not fire mid-flight.
  el.addEventListener('dragstart', onEnd)
  window.addEventListener('pointerup', onEnd)
  window.addEventListener('pointercancel', onEnd)
  window.addEventListener('scroll', onEnd, true)

  return () => {
    tracker.cancel()
    el.removeEventListener('pointerdown', onDown)
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('contextmenu', onContextMenu)
    el.removeEventListener('dragstart', onEnd)
    window.removeEventListener('pointerup', onEnd)
    window.removeEventListener('pointercancel', onEnd)
    window.removeEventListener('scroll', onEnd, true)
  }
}
