import { describe, expect, it } from 'vitest'
import { RailMotion, SpentSwipe, WHEEL_IDLE_MS, WheelAxis, settleMs, settlesShown } from './railMotion.js'

/** A rail 200px wide on a test clock: frames run when the clock is advanced. */
function rail(shown = false) {
  let now = 0
  let queued: Array<{ id: number; fn: (t: number) => void }> = []
  let id = 0
  const log: string[] = []
  const motion = new RailMotion({
    begin: () => { log.push('begin'); return 200 },
    render: () => {},
    commit: shown => log.push(shown ? 'shown' : 'away'),
    end: () => log.push('end'),
    still: () => false,
  }, shown, () => now, {
    request: fn => { queued.push({ id: ++id, fn }); return id },
    cancel: gone => { queued = queued.filter(frame => frame.id !== gone) },
  })
  const advance = (ms: number) => {
    for (const stop = now + ms; now < stop;) {
      now = Math.min(stop, now + 16)
      const due = queued; queued = []
      for (const frame of due) frame.fn(now)
    }
  }
  /** Draws the rail `px` over `ms`, a frame at a time, ending on the clock's now. */
  const draw = (px: number, ms = 80) => {
    const frames = Math.max(1, Math.round(ms / 16))
    for (let frame = 0; frame < frames; frame++) { now += ms / frames; motion.drag(px / frames, now) }
  }
  return { motion, log, advance, draw, at: () => now, wait: (ms: number) => { now += ms } }
}

describe('where a release settles', () => {
  it('goes by where the rail stands when it is let go still', () => {
    expect(settlesShown(0.6, 0)).toBe(true)
    expect(settlesShown(0.4, 0)).toBe(false)
  })
  it('lets a flick carry it past where it stands', () => {
    expect(settlesShown(0.2, 0.005)).toBe(true)
    expect(settlesShown(0.9, -0.005)).toBe(false)
  })
  it('settles briskly whatever the distance', () => {
    expect(settleMs(0, 1, 0, 200)).toBeLessThanOrEqual(240)
    expect(settleMs(0.98, 1, 0, 200)).toBeGreaterThanOrEqual(90)
    expect(settleMs(0, 1, 0.01, 200)).toBeLessThan(settleMs(0, 1, 0, 200))
  })
})

describe('the rail follows and settles', () => {
  it('moves pixel for pixel and clamps at either end', () => {
    const { motion, draw } = rail()
    draw(50)
    expect(motion.p).toBeCloseTo(0.25)
    draw(500)
    expect(motion.p).toBe(1)
  })

  it('a flicked rail settles shown and commits once it arrives', () => {
    const { motion, log, draw, advance } = rail()
    draw(60, 40)
    motion.release()
    expect(log).toEqual(['begin'])
    advance(300)
    expect(motion.p).toBe(1)
    expect(log).toEqual(['begin', 'shown', 'end'])
    expect(motion.active).toBe(false)
  })

  it('a rail held still before it is let go settles by where it stands', () => {
    const { motion, draw, wait, advance } = rail()
    draw(60, 40)
    wait(150)
    motion.release()
    advance(300)
    expect(motion.p).toBe(0)
  })

  it('putting away commits as it starts to leave', () => {
    const { motion, log, advance } = rail(true)
    motion.go(false)
    expect(log).toEqual(['begin', 'away'])
    advance(300)
    expect(log).toEqual(['begin', 'away', 'end'])
  })

  it('a swipe that catches a settling rail takes it from where it stands, with no wait', () => {
    const { motion, log, draw, advance } = rail()
    draw(150, 40)
    motion.release()
    advance(48)
    const caught = motion.p
    expect(caught).toBeGreaterThan(0.75)
    expect(caught).toBeLessThan(1)
    draw(-150, 40)
    expect(motion.p).toBeCloseTo(caught - 0.75)
    motion.release()
    advance(300)
    expect(motion.p).toBe(0)
    // One motion throughout: begun once, never shown, put away as it left.
    expect(log).toEqual(['begin', 'away', 'end'])
  })
})

describe('which wheel events are the rail\'s', () => {
  /** Feeds a burst of `n` events every 16ms from `t`, each moving (dx, dy); returns the travel taken, or null where none was. */
  const burst = (axis: WheelAxis, t: number, n: number, dx: number, dy: number) =>
    Array.from({ length: n }, (_, i) => axis.feed(dx, dy, t + i * 16))

  it('takes a sideways swipe and all of its inertia', () => {
    const axis = new WheelAxis()
    const taken = burst(axis, 0, 10, -20, 1)
    expect(taken.every(px => px !== null)).toBe(true)
    // The inertia tail, decaying, stays the rail's.
    expect(burst(axis, 160, 20, -2, 0).every(px => px !== null)).toBe(true)
  })

  it('takes a reversed swipe begun inside the last one\'s inertia', () => {
    const axis = new WheelAxis()
    burst(axis, 0, 10, 20, 0)
    burst(axis, 160, 5, 6, 0)
    expect(burst(axis, 240, 10, -20, 0).every(px => px !== null && px < 0)).toBe(true)
  })

  it('leaves a vertical scroll that drifts sideways to the stream', () => {
    const axis = new WheelAxis()
    expect(burst(axis, 0, 30, 3, -30).every(px => px === null)).toBe(true)
    expect(burst(axis, 500, 12, (Math.random() - 0.5) * 4, -12).every(px => px === null)).toBe(true)
  })

  it('takes a swipe begun straight after a vertical scroll\'s inertia', () => {
    const axis = new WheelAxis()
    burst(axis, 0, 20, 0, -8)
    const taken = burst(axis, 320, 8, -25, 0)
    expect(taken.slice(1).every(px => px !== null)).toBe(true)
  })

  it('hands a burst back to the stream once it turns along it, and starts afresh after a pause', () => {
    const axis = new WheelAxis()
    burst(axis, 0, 6, -20, 0)
    expect(burst(axis, 96, 8, 0, -40).at(-1)).toBeNull()
    expect(burst(axis, 96 + 8 * 16 + WHEEL_IDLE_MS + 1, 4, -20, 0).at(-1)).not.toBeNull()
  })
})

describe('a spent swipe', () => {
  /** A swipe that left the reader at t = 0, then its events: each [px, ms since the last]; how many of them it kept. */
  const kept = (events: Array<[number, number]>): number => {
    const spent = new SpentSwipe()
    spent.begin(0)
    let t = 0, n = 0
    for (const [px, dt] of events) { t += dt; if (!spent.feed(px, t)) break; n++ }
    return n
  }
  const frames = (deltas: number[], dt = 16): Array<[number, number]> => deltas.map(px => [px, dt])
  // The rest of a swipe at 30 px a frame, then its inertia decaying by a tenth a frame down to a pixel.
  const swipe = frames([30, 30, 30, 30])
  const inertia = frames(Array.from({ length: 30 }, (_, i) => Math.max(1, Math.round(30 * 0.9 ** (i + 1)))))

  it('keeps the whole of the swipe and its inertia, a frame the browser coalesced and a dip mid-swipe included', () => {
    expect(kept([...swipe, ...inertia])).toBe(swipe.length + inertia.length)
    // Two inertia frames coalesced into one event: twice the travel over twice the time.
    const tail = inertia.slice(0, 15), coalesced: [number, number] = [tail[14][0] * 2, 32]
    expect(kept([...swipe, ...tail, coalesced, ...inertia.slice(16)])).toBe(swipe.length + 15 + 1 + 14)
    // A human swipe that slows and speeds up again before it lets go.
    expect(kept([...frames([30, 12, 26, 30]), ...inertia])).toBe(4 + inertia.length)
    // A single delayed frame under load does not end the spent swipe early.
    expect(kept([[30, 16], [30, 80], [27, 16], ...inertia])).toBe(3 + inertia.length)
  })

  it('ends at the next swipe, however gently it ramps up, or once its events pause', () => {
    const ramp = frames([1, 2, 4, 7, 11, 16, 22, 30, 30])
    const spentFor = swipe.length + 12
    // Begun during the inertia: kept until the fingers are clearly moving again, a few frames in.
    const n = kept([...swipe, ...inertia.slice(0, 12), ...ramp])
    expect(n).toBeGreaterThanOrEqual(spentFor)
    expect(n).toBeLessThan(spentFor + 6)
    // Begun after the inertia died away.
    expect(kept([...swipe, ...inertia, ...ramp])).toBeLessThan(swipe.length + inertia.length + 6)
    expect(kept([...swipe, [30, WHEEL_IDLE_MS + 1]])).toBe(swipe.length)
  })

  it('survives a long reader teardown when rearmed on return, yet still expires if the user pauses after', () => {
    const spent = new SpentSwipe()
    spent.begin(1000, true)
    // Even if an event arrives > WHEEL_IDLE_MS later while teardown is still in flight, it is absorbed.
    expect(spent.feed(30, 1200, 450)).toBe(true)
    // Channels appears and rearms the idle clock; the next swipe frame 16ms later is absorbed.
    spent.rearm(500)
    expect(spent.feed(30, 1266, 516)).toBe(true)
    expect(spent.feed(27, 1282, 532)).toBe(true)
    // If the user actually paused > WHEEL_IDLE_MS after return, the next swipe is free.
    spent.rearm(600)
    expect(spent.feed(30, 1500, 600 + WHEEL_IDLE_MS + 10)).toBe(false)
  })
})
