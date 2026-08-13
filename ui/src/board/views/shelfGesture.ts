/**
 * shelfGesture — one pointer gesture on the shelf, as a state machine.
 *
 * The Shelf's cards are HANDLES: you grab a header to move a card, a corner to
 * resize it, the surface to pan. Every one of those gestures starts life
 * indistinguishable from a CLICK, and the whole reason this module exists is
 * that the difference matters enormously:
 *
 *   a click on a header  →  focus the card. Nothing is remembered.
 *   a drag on a header   →  the card is PLACED: it leaves the flow and keeps
 *                           the exact position you gave it, forever.
 *
 * Treating the two the same was the shelf's worst bug. A bare click on a
 * card's name committed the card's *current* flow position to storage, which
 * took it out of the flow — and the flow, closing over the gap it left, slid
 * the next card up into the slot the clicked card was still sitting in. Two
 * cards, one place, one of them a card the user had just been looking at: it
 * read as the card having spawned a copy of itself. Nothing was created; a
 * click was mistaken for a placement.
 *
 * So the machine has three phases and a threshold:
 *
 *   idle    → nothing in progress
 *   maybe   → the pointer is down, but has not travelled. Nothing has moved,
 *             nothing will be written; releasing here is a CLICK.
 *   active  → the pointer has travelled past DRAG_THRESHOLD. Now it is a
 *             gesture: geometry follows the pointer, and releasing commits.
 *
 * Pure — coordinates in, geometry out. The view does the DOM; this decides.
 */

/** How far a pointer must travel before a press becomes a drag. Four pixels
 *  is about the tremor of a deliberate click on a trackpad — under it, the
 *  user meant to click. */
export const DRAG_THRESHOLD = 4

/** A line of scroll, in pixels. Browsers that report scroll in LINES leave the
 *  conversion to the page; sixteen is the conventional figure and matches the
 *  board's own body text. */
const PIXELS_PER_LINE = 16

/** No single wheel event may zoom by more than this, whatever it claims to
 *  have scrolled. Some browsers send 120 per notch and some send 3; without a
 *  ceiling the same gesture is a nudge on one machine and a jump to the far
 *  end of the range on another. */
const MAX_STEP_PX = 40

/** How much zoom one pixel of wheel travel is worth. */
const ZOOM_PER_PIXEL = 0.0125

/**
 * A wheel event's zoom factor — the ratio to multiply the current scale by.
 *
 * THE UNITS ARE THE WHOLE BUG THIS FUNCTION EXISTS FOR. `WheelEvent.deltaY` is
 * meaningless without `deltaMode`, and the two gestures that both zoom report
 * in DIFFERENT modes:
 *
 *   a trackpad PINCH   arrives as pixels (deltaMode 0), tens of them per
 *                      event, so reading deltaY as pixels happens to work.
 *   ctrl + SCROLL      arrives as LINES (deltaMode 1) on macOS — deltaY of
 *                      about 1 to 3 per notch.
 *
 * Reading a line-mode "1" as one pixel yields a factor of exp(-0.0125): a 1.2%
 * change, which is invisible. The board zoomed under a pinch and appeared
 * completely dead under ctrl+scroll, and the difference was never the event
 * type or the modifier — it was that nobody converted the units.
 */
export function wheelZoomFactor(
  deltaY: number,
  deltaMode: number,
  pageHeight = 800,
): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1
  const perUnit = deltaMode === 1 ? PIXELS_PER_LINE : deltaMode === 2 ? pageHeight : 1
  const px = deltaY * perUnit
  const clamped = Math.max(-MAX_STEP_PX, Math.min(MAX_STEP_PX, px))
  return Math.exp(-clamped * ZOOM_PER_PIXEL)
}

/** Floors for a hand-resized card: below these the header is unreadable and
 *  the body shows nothing worth showing. */
export const MIN_CARD_W = 160
export const MIN_CARD_H = 120

export type GesturePhase = 'maybe' | 'active'
export type GestureMode = 'move' | 'resize' | 'pan'

export interface Geometry {
  x: number
  y: number
  w: number
  h: number
}

export interface ShelfGesture {
  mode: GestureMode
  /** The card being handled, or null for a surface pan. */
  path: string | null
  phase: GesturePhase
  startX: number
  startY: number
  /** Geometry (or pan offset, in x/y) at the moment the pointer went down. */
  origin: Geometry
  pointerId: number
  /**
   * The canvas scale this gesture began at.
   *
   * TWO COORDINATE SYSTEMS meet in a drag, and this is the conversion between
   * them. The pointer moves in SCREEN pixels; a card's geometry is in SURFACE
   * pixels, which the canvas transform scales. Zoomed to 0.5, a pointer that
   * travelled 100 screen pixels has dragged the card 200 surface pixels —
   * forget the division and every drag under a zoom lands short, by exactly
   * the factor you zoomed by.
   *
   * The THRESHOLD stays in screen pixels, deliberately: a hand's tremor on a
   * trackpad is four pixels of screen whatever the canvas is scaled to.
   */
  scale: number
}

export function beginGesture(
  mode: GestureMode,
  path: string | null,
  point: { clientX: number; clientY: number; pointerId: number },
  origin: Geometry,
  scale = 1,
): ShelfGesture {
  return {
    mode,
    path,
    phase: 'maybe',
    startX: point.clientX,
    startY: point.clientY,
    origin,
    pointerId: point.pointerId,
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
  }
}

/** Has the pointer travelled far enough to mean a drag? */
export function travelled(gesture: ShelfGesture, clientX: number, clientY: number): boolean {
  return (
    Math.abs(clientX - gesture.startX) + Math.abs(clientY - gesture.startY) > DRAG_THRESHOLD
  )
}

/**
 * Advance a gesture to a new pointer position.
 *
 * Returns the gesture (promoted to `active` once it has travelled) and the
 * geometry the view should paint — `null` while the gesture is still a maybe,
 * because a card that shifts under a click that was never a drag is exactly
 * the jump the old code had.
 */
export function advanceGesture(
  gesture: ShelfGesture,
  clientX: number,
  clientY: number,
): { gesture: ShelfGesture; geometry: Geometry | null } {
  const phase: GesturePhase =
    gesture.phase === 'active' || travelled(gesture, clientX, clientY) ? 'active' : 'maybe'
  const next = phase === gesture.phase ? gesture : { ...gesture, phase }
  if (phase !== 'active') return { gesture: next, geometry: null }
  // Screen travel into surface travel — see `scale` on ShelfGesture. A pan is
  // the exception: the pan offset is applied OUTSIDE the scale, so it is
  // already in screen pixels and must not be divided.
  const divisor = gesture.mode === 'pan' ? 1 : gesture.scale
  const dx = (clientX - gesture.startX) / divisor
  const dy = (clientY - gesture.startY) / divisor
  return { gesture: next, geometry: geometryFor(gesture, dx, dy) }
}

/** Where a gesture puts its subject, given how far the pointer has come. */
export function geometryFor(gesture: ShelfGesture, dx: number, dy: number): Geometry {
  const { origin } = gesture
  if (gesture.mode === 'resize') {
    return {
      x: origin.x,
      y: origin.y,
      w: Math.max(MIN_CARD_W, origin.w + dx),
      h: Math.max(MIN_CARD_H, origin.h + dy),
    }
  }
  // move and pan are the same arithmetic on different subjects.
  return { x: origin.x + dx, y: origin.y + dy, w: origin.w, h: origin.h }
}

/**
 * What a release means.
 *
 * `placed` is the whole point: only a gesture that actually travelled writes
 * anything down. A release from `maybe` is a click, and the view's click
 * handling (focus a card, put one down) is free to run.
 */
export function settleGesture(gesture: ShelfGesture): { placed: boolean; click: boolean } {
  const active = gesture.phase === 'active'
  return { placed: active && gesture.mode !== 'pan', click: !active }
}
