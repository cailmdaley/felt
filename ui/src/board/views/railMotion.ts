/**
 * The Channels rail's motion: how far it is drawn in, from 0 (put away) to 1
 * (shown), following a finger or a trackpad's sideways travel pixel for
 * pixel, and settling by where it stands and how fast it was going. Nothing
 * here waits for a gesture to end before the next can take hold: a swipe
 * begun while the rail still settles catches it where it is.
 */

/** Velocity is read over the last this many milliseconds of travel. */
const VELOCITY_MS = 100
/** A release settles where the rail would stand this long after, at the speed it was let go. */
const PROJECT_MS = 180
/** Settling never runs longer or shorter than these, whatever the distance. */
const SETTLE_MS = { min: 90, max: 240 } as const
/** Settling covers the distance at least this fast (px/ms), so a slow release still lands briskly. */
const SETTLE_SPEED = 1.1
/** A trackpad's swipe is over once its wheel events have paused this long. */
export const WHEEL_IDLE_MS = 140
/** The wheel events weighed in deciding whether a burst runs sideways or along the stream. */
const AXIS_MS = 60
/** Sideways travel a wheel burst or a finger needs before it is taken as the rail's. */
export const SLOP_PX = 6
/** Sideways travel over the reader that leaves it: a swipe, where the rail's slop would take a scroll's drift. */
export const LEAVE_PX = 48

export interface RailHooks {
  /** The motion starts: the rail is laid out to move, and its width returned. */
  begin(): number
  /** Draws the rail `p` of the way in. */
  render(p: number): void
  /** The rail's shown state becomes `shown`: put away as it starts to leave, shown once it has arrived. */
  commit(shown: boolean): void
  /** The motion is over and the rail rests as committed. */
  end(): void
  /** Whether the viewer asked for less motion: the rail then moves at once. */
  still(): boolean
}

/** Where a release settles: shown when the rail, carried on at its speed, would stand past halfway. */
export const settlesShown = (p: number, velocity: number): boolean => p + velocity * PROJECT_MS > 0.5

/** How long settling from `p` to `to` takes, released at `velocity` (fraction per ms) on a rail `width` wide. */
export function settleMs(p: number, to: number, velocity: number, width: number): number {
  const distance = Math.abs(to - p) * width
  const speed = Math.max(Math.abs(velocity) * width, SETTLE_SPEED)
  return Math.max(SETTLE_MS.min, Math.min(SETTLE_MS.max, distance / speed))
}

/** Schedules a settle's frames: the browser's animation frames, or a test's clock. */
export interface Frames { request(fn: (t: number) => void): number; cancel(id: number): void }

const easeOut = (t: number): number => 1 - (1 - t) ** 3

export class RailMotion {
  /** How far the rail is drawn in. */
  p: number
  private width = 1
  private moving = false
  private frame = 0
  private samples: Array<{ t: number; p: number }> = []

  private readonly hooks: RailHooks
  private readonly now: () => number
  private readonly frames: Frames

  constructor(hooks: RailHooks, shown: boolean, now: () => number = () => performance.now(), frames: Frames = { request: fn => requestAnimationFrame(fn), cancel: id => cancelAnimationFrame(id) }) {
    this.hooks = hooks
    this.now = now
    this.frames = frames
    this.p = shown ? 1 : 0
  }

  get active(): boolean { return this.moving }

  /** Takes hold of the rail where it stands, stopping it if it was settling. */
  grab(): void {
    if (this.frame) { this.frames.cancel(this.frame); this.frame = 0 }
    if (!this.moving) { this.moving = true; this.width = Math.max(1, this.hooks.begin()) }
    this.samples = []
  }

  /** Moves the rail `px` rightward (toward shown), at time `t`. */
  drag(px: number, t: number): void {
    if (!this.moving || this.frame) this.grab()
    this.p = Math.max(0, Math.min(1, this.p + px / this.width))
    this.samples.push({ t, p: this.p })
    while (this.samples.length > 2 && t - this.samples[0].t > VELOCITY_MS) this.samples.shift()
    this.hooks.render(this.p)
  }

  /**
   * The rail's speed as of `at`, as a fraction of its width per ms: over the
   * travel of the last moments, so a rail held still before it is let go has
   * none. A trackpad's release comes once its events pause, so its speed is
   * spent: its inertia tail has already carried the rail.
   */
  velocity(at = this.now()): number {
    const recent = this.samples.filter(sample => at - sample.t <= VELOCITY_MS)
    const first = recent[0], last = recent.at(-1)
    return first && last && last.t > first.t ? (last.p - first.p) / (last.t - first.t) : 0
  }

  /** Lets go: the rail settles by where it stands and how fast it was going. */
  release(): void {
    if (!this.moving || this.frame) return
    const velocity = this.velocity()
    this.go(settlesShown(this.p, velocity), velocity)
  }

  /** Carries the rail to shown or put away, from wherever it stands. */
  go(shown: boolean, velocity = 0): void {
    this.grab()
    const from = this.p, to = shown ? 1 : 0
    if (!shown) this.hooks.commit(false)
    if (this.hooks.still() || from === to) { this.p = to; this.finish(shown); return }
    this.hooks.render(from)
    const start = this.now(), ms = settleMs(from, to, velocity, this.width)
    const step = (): void => {
      const t = Math.min(1, (this.now() - start) / ms)
      this.p = from + (to - from) * easeOut(t)
      this.hooks.render(this.p)
      if (t < 1) { this.frame = this.frames.request(step); return }
      this.frame = 0
      this.finish(shown)
    }
    this.frame = this.frames.request(step)
  }

  /** The rail rests as it is committed elsewhere (a phone that chose a channel, a narrowed window): no motion. */
  rest(shown: boolean): void {
    if (this.frame) { this.frames.cancel(this.frame); this.frame = 0 }
    this.p = shown ? 1 : 0
    if (this.moving) { this.moving = false; this.hooks.end() }
  }

  private finish(shown: boolean): void {
    if (shown) this.hooks.commit(true)
    this.moving = false
    this.hooks.end()
  }
}

/**
 * Decides which wheel events are the rail's. A burst is taken once its
 * recent events run sideways more than along the stream; taken, it stays the
 * rail's (only its sideways travel counts) until it pauses, inertia tail and
 * all, and a strongly vertical stretch hands it back to the stream.
 */
export class WheelAxis {
  private recent: Array<{ t: number; x: number; y: number }> = []
  private taken = false
  private last = -Infinity

  /** The sideways travel this event gives the rail (pending travel included when the burst is first taken), or null when it is the stream's. */
  feed(dx: number, dy: number, t: number): number | null {
    if (t - this.last > WHEEL_IDLE_MS) { this.taken = false; this.recent = [] }
    this.last = t
    this.recent.push({ t, x: dx, y: dy })
    while (this.recent.length && t - this.recent[0].t > AXIS_MS) this.recent.shift()
    const x = this.recent.reduce((sum, each) => sum + each.x, 0), y = this.recent.reduce((sum, each) => sum + each.y, 0)
    if (this.taken) {
      if (Math.abs(y) > 2 * Math.abs(x) + 10) { this.taken = false; return null }
      return dx
    }
    if (Math.abs(x) <= Math.abs(y) || Math.abs(x) < SLOP_PX) return null
    this.taken = true
    return x
  }

  /** Whether a burst is the rail's now. */
  get holding(): boolean { return this.taken }
}

/**
 * A trackpad swipe already spent (it left the reader): the rest of it, its
 * inertia dying away, moves nothing. It ends when its events pause, or when
 * they speed up again well past the slowest sustained pace they have fallen to
 * since they began to slow, which is fingers starting the next swipe. Speeds,
 * not deltas, so frames the browser coalesced read as the travel they carry.
 */
export class SpentSwipe {
  private on = false
  private last = 0
  private peak = 0
  private low = Infinity
  private prev = Infinity

  get active(): boolean { return this.on }

  /** The swipe is spent from time `t`. */
  begin(t: number): void {
    this.on = true; this.last = t; this.peak = 0; this.low = Infinity; this.prev = Infinity
  }

  /** Whether an event of `travel` px at time `t` is the spent swipe's; false once it has ended. */
  feed(travel: number, t: number): boolean {
    if (!this.on) return false
    const dt = t - this.last
    if (dt > WHEEL_IDLE_MS) { this.on = false; return false }
    this.last = t
    const speed = travel / Math.max(dt, 1)
    if (speed > 3 * this.low + 0.3) { this.on = false; return false }
    this.peak = Math.max(this.peak, speed)
    // Two consecutive slow events establish a real slowdown; a single jittered frame does not.
    const sustained = Math.max(this.prev, speed)
    this.prev = speed
    if (sustained < this.peak / 2) this.low = Math.min(this.low, sustained)
    return true
  }
}
