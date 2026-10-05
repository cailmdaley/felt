import { describe, expect, it } from 'vitest'
import { PhoneTopbar, swipeFollow, swipeOutcome, swipeSettleTime } from '../src/board/workspace/PhoneGestures.js'

describe('page swipe release', () => {
  it('commits past 28% of the width or on a flick, toward an existing neighbour', () => {
    expect(swipeOutcome(-120, 0, 390, true, true)).toBe(1)
    expect(swipeOutcome(120, 0, 390, true, true)).toBe(-1)
    expect(swipeOutcome(-100, 0, 390, true, true)).toBe(0)
    expect(swipeOutcome(-40, -0.5, 390, true, true)).toBe(1)
    expect(swipeOutcome(-20, -2, 390, true, true)).toBe(0)
    expect(swipeOutcome(-200, 0.5, 390, true, true)).toBe(0)
    expect(swipeOutcome(200, 0, 390, false, true)).toBe(0)
    expect(swipeOutcome(-200, 0, 390, true, false)).toBe(0)
  })
  it('follows the finger toward a neighbour and resists past the ends', () => {
    expect(swipeFollow(-80, 390, true, true)).toBe(-80)
    expect(swipeFollow(-900, 390, true, true)).toBe(-390)
    const resisted = swipeFollow(200, 390, false, true)
    expect(resisted).toBeGreaterThan(0)
    expect(resisted).toBeLessThan(390 * 0.18)
  })
  it('settles faster for faster releases within the crossing', () => {
    expect(swipeSettleTime(300, 0, 280)).toBe(280)
    expect(swipeSettleTime(300, 3, 280)).toBe(160)
    expect(swipeSettleTime(200, 1.5, 280)).toBeLessThan(280)
  })
})

describe('phone top bar', () => {
  it('hides down, reveals up and at the top, ignoring other pages', () => {
    const states: boolean[] = []
    const bar = new PhoneTopbar(hidden => states.push(hidden))
    bar.select('a')
    bar.scroll('a', 4)
    expect(states).toEqual([false])
    bar.scroll('a', 12)
    expect(states.at(-1)).toBe(true)
    bar.scroll('a', 6)
    expect(states.at(-1)).toBe(true)
    bar.scroll('a', 3)
    expect(states.at(-1)).toBe(false)
    bar.scroll('a', 40)
    bar.scroll('a', 0)
    expect(states.at(-1)).toBe(false)
    bar.scroll('b', 300)
    expect(states.at(-1)).toBe(false)
    bar.select('b')
    expect(states.at(-1)).toBe(false)
  })
})
