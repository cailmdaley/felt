import { describe, expect, it } from 'vitest'
import { barSwipeIntent, PhoneTopbar } from '../src/board/workspace/PhoneGestures.js'

describe('bottom bar horizontal intent', () => {
  it('latches strictly beyond 12 px and below 30 degrees', () => {
    expect(barSwipeIntent(12, 0)).toBe(0)
    expect(barSwipeIntent(13, 0)).toBe(-1)
    expect(barSwipeIntent(-30, 12)).toBe(1)
    expect(barSwipeIntent(30, 18)).toBe(0)
    expect(barSwipeIntent(0, 100)).toBe(0)
    expect(barSwipeIntent(5, 30)).toBe(0)
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
