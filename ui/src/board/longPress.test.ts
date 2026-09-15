import { describe, expect, it } from 'vitest'
import { LongPressTracker } from './longPress'

/** A hand-turned clock: timers only run when the test says so, so every
 *  assertion is about the rule and not about wall time. */
function fakeClock() {
  const pending = new Map<number, () => void>()
  let next = 1
  return {
    setTimer: (fn: () => void) => {
      const id = next++
      pending.set(id, fn)
      return id
    },
    clearTimer: (id: number) => { pending.delete(id) },
    /** Fire everything still armed. */
    elapse: () => {
      for (const fn of [...pending.values()]) fn()
      pending.clear()
    },
    get armed() { return pending.size },
  }
}

function tracker(onFire: () => void, clock = fakeClock()) {
  return {
    clock,
    t: new LongPressTracker({ onFire, setTimer: clock.setTimer, clearTimer: clock.clearTimer }),
  }
}

describe('LongPressTracker', () => {
  it('fires once the press has been held still', () => {
    let fired = 0
    const { t, clock } = tracker(() => { fired += 1 })
    t.down(1, { x: 10, y: 10 })
    expect(t.pressing).toBe(true)
    clock.elapse()
    expect(fired).toBe(1)
    expect(t.pressing).toBe(false)
  })

  it('tolerates a wobble inside the slop radius', () => {
    let fired = 0
    const { t, clock } = tracker(() => { fired += 1 })
    t.down(1, { x: 10, y: 10 })
    t.move(1, { x: 14, y: 13 })
    clock.elapse()
    expect(fired).toBe(1)
  })

  it('abandons the press once the finger travels', () => {
    let fired = 0
    const { t, clock } = tracker(() => { fired += 1 })
    t.down(1, { x: 10, y: 10 })
    t.move(1, { x: 30, y: 10 })
    expect(t.pressing).toBe(false)
    clock.elapse()
    expect(fired).toBe(0)
  })

  it('ignores movement from a different pointer', () => {
    let fired = 0
    const { t, clock } = tracker(() => { fired += 1 })
    t.down(1, { x: 10, y: 10 })
    t.move(2, { x: 200, y: 200 })
    clock.elapse()
    expect(fired).toBe(1)
  })

  it('a lift before the hold elapses fires nothing', () => {
    let fired = 0
    const { t, clock } = tracker(() => { fired += 1 })
    t.down(1, { x: 10, y: 10 })
    t.cancel()
    expect(clock.armed).toBe(0)
    clock.elapse()
    expect(fired).toBe(0)
  })

  it('a second finger takes the gesture down rather than extending it', () => {
    let fired = 0
    const { t, clock } = tracker(() => { fired += 1 })
    t.down(1, { x: 10, y: 10 })
    t.down(2, { x: 60, y: 60 })
    clock.elapse()
    expect(fired).toBe(0)
  })

  it('swallows exactly one click after firing', () => {
    const { t, clock } = tracker(() => {})
    expect(t.consumeClick()).toBe(false)
    t.down(1, { x: 0, y: 0 })
    clock.elapse()
    expect(t.consumeClick()).toBe(true)
    expect(t.consumeClick()).toBe(false)
  })

  it('leaves an ordinary tap’s click alone', () => {
    const { t } = tracker(() => {})
    t.down(1, { x: 0, y: 0 })
    t.cancel()
    expect(t.consumeClick()).toBe(false)
  })

  it('reports press state to the caller', () => {
    const states: boolean[] = []
    const clock = fakeClock()
    const t = new LongPressTracker({
      onFire: () => {},
      onPressChange: (p) => states.push(p),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    t.down(1, { x: 0, y: 0 })
    clock.elapse()
    t.down(1, { x: 0, y: 0 })
    t.cancel()
    expect(states).toEqual([true, false, true, false])
  })
})
