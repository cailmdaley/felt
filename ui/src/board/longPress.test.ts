// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { attachLongPress, LongPressTracker } from './longPress'

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

describe('attachLongPress', () => {
  it('ignores mouse holds and cancels a nested row drag that stops bubbling', () => {
    const card = document.createElement('div')
    const row = document.createElement('div')
    card.append(row)
    document.body.append(card)
    row.addEventListener('dragstart', (event: Event) => event.stopPropagation())
    const clock = fakeClock()
    const onFire = vi.fn()
    const detach = attachLongPress(card as unknown as HTMLElement, {
      onFire,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })

    const mouseDown = Object.assign(new Event('pointerdown', { bubbles: true }), {
      button: 0, pointerId: 1, pointerType: 'mouse', clientX: 10, clientY: 10,
    })
    card.dispatchEvent(mouseDown)
    expect(clock.armed).toBe(0)

    // Pen uses the same press path as touch, so the drag-start guard still
    // matters for a draggable descendant that stops event bubbling.
    const penDown = Object.assign(new Event('pointerdown', { bubbles: true }), {
      button: 0, pointerId: 2, pointerType: 'pen', clientX: 10, clientY: 10,
    })
    card.dispatchEvent(penDown)
    expect(clock.armed).toBe(1)
    // A real bubbling event reaches window capture before the row stops it.
    row.dispatchEvent(new Event('dragstart', { bubbles: true }))
    clock.elapse()

    expect(onFire).not.toHaveBeenCalled()
    expect(clock.armed).toBe(0)
    detach()
    card.remove()
  })
})
