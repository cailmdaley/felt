/**
 * THE SCRUB BAR — the "you are here" mark that makes a rail navigable.
 *
 * ## Why this is its own module
 *
 * Day draws a lane per fiber across one day; Week draws a rail per day across
 * one week. Different marks, different grain — but a pinned slip is the same
 * gesture on both: you stop the tooltip fleeing, and then you want to MOVE the
 * moment it is reporting without hunting for a two-pixel mark with the pointer.
 * That is a bar, a drag, and two arrow keys, and none of it knows what a fiber
 * or a day is. So it lives here, with the geometry handed in.
 *
 * The split is the same one `placeTip` makes: WHERE the instants are is the
 * view's (it owns the frame, the rails, the grain), how you take hold of one
 * and walk it is not.
 *
 * ## What the bar is
 *
 * A full-height vertical rule in VERDIGRIS, the board's pigment for a thing
 * settled — which a pinned moment is, against a page where everything else is
 * still moving. It is deliberately the strongest mark on the rail: while it is
 * up, it is what the slip is talking about, and a reader must never have to
 * work out which minute a panel belongs to.
 *
 * It is DRAGGABLE and it takes FOCUS, in that order of importance. Dragging is
 * how you scan — the slip follows live, so a day can be read by sweeping. Focus
 * is what makes the arrow keys land somewhere sensible the instant you pin:
 * without it the first ArrowRight would page the whole view to tomorrow, which
 * is the opposite of a small step. Holding an arrow auto-repeats at the
 * browser's own rate; no acceleration, because a step whose size changes while
 * you hold it is a step you cannot aim.
 */

import './railScrub.css'

/** The half-open span a scrub may walk, in the view's own instants. */
export interface ScrubFrame {
  startMs: number
  endMs: number
}

/** Where the bar is: which rail, and when. */
export interface ScrubTarget {
  laneKey: string
  atMs: number
}

/**
 * A rail's geometry, as the scrub needs it.
 *
 * `host` is the element the bar is PARENTED to — it must be positioned and it
 * must be as tall as the mark should be (Day hands over the gridline layer,
 * which spans the whole stack of lanes; Week hands over the one row's rail).
 * `left`/`width` are the client-space box that maps x to time, which may be a
 * different element from the host and usually is.
 */
export interface ScrubRail {
  host: HTMLElement
  left: number
  width: number
}

export interface RailScrubOptions {
  /**
   * The window a lane is drawn in, or null when that lane is no longer on the
   * page.
   *
   * PER LANE, because on Week it genuinely is: every row is its own 6am→6am
   * rail, and a bar walking Tuesday must clamp to Tuesday. Day's lanes all
   * share one frame and it simply ignores the argument, which is the right
   * shape for the one that does not.
   */
  frame: (laneKey: string) => ScrubFrame | null
  /** Where a lane is right now, or null if it is no longer on the page. */
  rail: (laneKey: string) => ScrubRail | null
  /** One arrow-key step. A minute on Day; a slot on Week, which has no finer
   *  grain to offer and would otherwise step four times to move one mark. */
  stepMs: number
  /** Report a new target. The view redraws its slip; the bar has already moved. */
  onMove: (target: ScrubTarget) => void
}

export class RailScrub {
  private readonly options: RailScrubOptions
  private bar: HTMLElement | null = null
  private at: ScrubTarget | null = null
  /** A drag on the bar itself, which is not a drag on the rail underneath it. */
  private dragging = false

  constructor(options: RailScrubOptions) {
    this.options = options
  }

  /**
   * Raise the bar at `target` and take the keyboard.
   *
   * Idempotent per position: pinning the moment already pinned re-focuses the
   * bar and does nothing else, so a second click on the same mark cannot
   * flicker the panel it is holding open.
   */
  pin(target: ScrubTarget): void {
    this.at = target
    this.draw()
    // After the draw, so the element being focused exists. `preventScroll`
    // because the bar is mid-page furniture: taking focus must not jump the
    // sheet under someone who was reading it.
    this.bar?.focus({ preventScroll: true })
  }

  /** Move the bar without re-focusing — a drag, or an arrow key. */
  move(atMs: number): void {
    if (!this.at) return
    const frame = this.options.frame(this.at.laneKey)
    if (!frame) return
    const clamped = Math.min(Math.max(atMs, frame.startMs), frame.endMs - 1)
    if (clamped === this.at.atMs) return
    this.at = { ...this.at, atMs: clamped }
    this.draw()
    this.options.onMove(this.at)
  }

  /** Put the bar away. Safe to call when it is already down. */
  clear(): void {
    this.at = null
    this.dragging = false
    this.bar?.remove()
    this.bar = null
  }

  /**
   * Step the bar with an arrow key, if one is what arrived.
   *
   * Returns whether the key was consumed, so a view can offer its own arrows
   * (paging to the next day, the next week) to every keystroke this one
   * declines. WHILE THE BAR IS UP THE ARROWS BELONG TO IT: a pinned reader
   * pressing right means "the next minute", never "the next day", and the two
   * meanings cannot both be bound at once.
   */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.at) return false
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false
    if (e.metaKey || e.ctrlKey || e.altKey) return false
    e.preventDefault()
    // Shift takes a longer stride — the same key, ten steps at a time, for
    // crossing a quiet afternoon without holding it down.
    const stride = this.options.stepMs * (e.shiftKey ? 10 : 1)
    this.move(this.at.atMs + (e.key === 'ArrowLeft' ? -stride : stride))
    return true
  }

  private draw(): void {
    const at = this.at
    const frame = at ? this.options.frame(at.laneKey) : null
    if (!at || !frame) return this.clear()
    const rail = this.options.rail(at.laneKey)
    const span = frame.endMs - frame.startMs
    if (!rail || rail.width <= 0 || span <= 0) return this.clear()

    if (!this.bar || this.bar.parentElement !== rail.host) {
      this.bar?.remove()
      this.bar = this.build()
      rail.host.append(this.bar)
    }
    this.bar.style.left = `${(((at.atMs - frame.startMs) / span) * 100).toFixed(4)}%`
    this.bar.setAttribute('aria-valuenow', String(at.atMs))
  }

  private build(): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'kbn-scrub'
    // A slider is what this is: one value, on a range, moved with the arrows.
    // Naming it so is what makes the keyboard behaviour discoverable rather
    // than a secret, and costs one attribute.
    bar.setAttribute('role', 'slider')
    bar.setAttribute('aria-label', 'pinned moment — drag or use arrow keys')
    bar.tabIndex = 0

    const line = document.createElement('i')
    line.className = 'kbn-scrub-line'
    bar.append(line)

    // THE PRESS IS SWALLOWED. Underneath this bar is a rail that reads a press
    // as the start of a drag-to-zoom; taking hold of the bar is not that
    // gesture and must not begin it.
    bar.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      this.dragging = true
      bar.classList.add('kbn-scrub-held')
      bar.focus({ preventScroll: true })
    })
    // The click the browser fires at the end of a drag on this bar would
    // otherwise reach the document listener that puts pinned slips away.
    bar.addEventListener('click', (e) => e.stopPropagation())
    bar.addEventListener('keydown', (e) => {
      // Handled here as well as at the document, so the bar works even in a
      // view that has not wired the global key path.
      if (this.handleKey(e)) e.stopPropagation()
    })
    document.addEventListener('mousemove', this.onDragMove)
    document.addEventListener('mouseup', this.onDragUp)
    return bar
  }

  private readonly onDragMove = (e: MouseEvent): void => {
    if (!this.dragging || !this.at) return
    const frame = this.options.frame(this.at.laneKey)
    const rail = this.options.rail(this.at.laneKey)
    if (!frame || !rail || rail.width <= 0) return
    e.preventDefault()
    const fraction = Math.min(1, Math.max(0, (e.clientX - rail.left) / rail.width))
    this.move(frame.startMs + fraction * (frame.endMs - frame.startMs))
  }

  private readonly onDragUp = (): void => {
    if (!this.dragging) return
    this.dragging = false
    this.bar?.classList.remove('kbn-scrub-held')
  }

  /** Drop the document listeners the bar's drag needs. Called when the view
   *  unmounts — the bar itself may be long gone with its rail. */
  dispose(): void {
    this.clear()
    document.removeEventListener('mousemove', this.onDragMove)
    document.removeEventListener('mouseup', this.onDragUp)
  }
}

/**
 * Which side of the now-line an instant falls on.
 *
 * THE DIVIDER SPLITS THE GESTURE, and this is the whole rule stated once. Left
 * of now is the day that HAPPENED: it is covered in marks, every pixel of it
 * answers a question about the past, and a click there means "hold still, I am
 * reading this". Right of now is blank paper — nothing happened there, there is
 * nothing to pin, and the only thing a click can sensibly mean on a lane's
 * empty future is "take me to this work", which is the terminal.
 *
 * A frame with no `now` in it at all (a past day, a week already over) is ALL
 * past: everything pins, and the lane's label keeps its own door open.
 */
export function isPast(atMs: number, nowMs: number): boolean {
  return atMs <= nowMs
}
