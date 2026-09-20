// A dismissing tap must not reach what it dismissed over.
//
// No jsdom in this repo, so the scope is a hand-made event target — which is
// the point: these rules are about listener registration, phase and ordering,
// none of which needs a layout engine to check.

import { describe, expect, it } from 'vitest'
import { dismissOnScrim, onPressRelease, suppressNextClick, type GestureEvent } from './dismissGesture'

interface FakeEvent {
  defaultPrevented: boolean
  propagationStopped: boolean
  preventDefault(): void
  stopPropagation(): void
  stopImmediatePropagation(): void
}

function event(): FakeEvent {
  return {
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
    stopImmediatePropagation() { this.propagationStopped = true },
  }
}

/** An event target that records the capture flag, so "before the card's own
 *  handler" is an assertion and not a hope. */
function scope() {
  const listeners = new Map<string, Set<{ fn: (e: GestureEvent) => void; capture: boolean }>>()
  return {
    addEventListener(type: string, fn: (e: GestureEvent) => void, opts?: unknown): void {
      const set = listeners.get(type) ?? new Set()
      set.add({ fn, capture: opts === true })
      listeners.set(type, set)
    },
    removeEventListener(type: string, fn: (e: GestureEvent) => void): void {
      const set = listeners.get(type)
      if (!set) return
      for (const l of [...set]) if (l.fn === fn) set.delete(l)
    },
    /** Dispatch, returning the event so the caller can read what was eaten. */
    fire(type: string, e: FakeEvent = event()): FakeEvent {
      for (const l of [...(listeners.get(type) ?? [])]) l.fn(e)
      return e
    },
    count(type: string): number {
      return listeners.get(type)?.size ?? 0
    },
    capturing(type: string): boolean {
      return [...(listeners.get(type) ?? [])].every((l) => l.capture)
    },
  }
}

function fakeClock() {
  const pending = new Map<number, () => void>()
  let next = 1
  return {
    setTimer: (fn: () => void) => { const id = next++; pending.set(id, fn); return id },
    clearTimer: (id: number) => { pending.delete(id) },
    elapse: () => { for (const fn of [...pending.values()]) fn(); pending.clear() },
    get armed() { return pending.size },
  }
}

describe('suppressNextClick', () => {
  it('eats the next click and then gets out of the way', () => {
    const win = scope()
    const clock = fakeClock()
    suppressNextClick(win, clock)
    expect(win.capturing('click')).toBe(true)

    const first = win.fire('click')
    expect(first.defaultPrevented).toBe(true)
    expect(first.propagationStopped).toBe(true)

    // The SECOND tap is a real tap: the overlay is gone and the reader means it.
    expect(win.count('click')).toBe(0)
    const second = win.fire('click')
    expect(second.defaultPrevented).toBe(false)
    expect(clock.armed).toBe(0)
  })

  it('disarms itself when no click follows', () => {
    const win = scope()
    const clock = fakeClock()
    suppressNextClick(win, clock)
    clock.elapse()
    expect(win.count('click')).toBe(0)
    expect(win.fire('click').defaultPrevented).toBe(false)
  })

  it('can be disarmed by its caller', () => {
    const win = scope()
    const clock = fakeClock()
    const stop = suppressNextClick(win, clock)
    stop()
    expect(win.count('click')).toBe(0)
    expect(clock.armed).toBe(0)
  })
})

describe('dismissOnScrim', () => {
  it('dismisses on pointerdown and lets nothing through the gesture', () => {
    const scrim = scope()
    const win = scope()
    const clock = fakeClock()
    let dismissed = 0
    dismissOnScrim(scrim, () => { dismissed += 1 }, win, clock)

    const down = scrim.fire('pointerdown')
    expect(dismissed).toBe(1)
    expect(down.defaultPrevented).toBe(true)
    expect(down.propagationStopped).toBe(true)

    // The scrim is removed by `dismiss`, so the click lands on the window with
    // the card beneath as its target — that is the one this must swallow.
    expect(win.fire('click').defaultPrevented).toBe(true)
  })

  it('swallows pointerup and click that land on the scrim itself', () => {
    const scrim = scope()
    const win = scope()
    dismissOnScrim(scrim, () => {}, win, fakeClock())
    expect(scrim.fire('pointerup').propagationStopped).toBe(true)
    expect(scrim.fire('click').propagationStopped).toBe(true)
  })

  it('opens nothing on the tap after the dismissing one', () => {
    const scrim = scope()
    const win = scope()
    const clock = fakeClock()
    dismissOnScrim(scrim, () => {}, win, clock)
    scrim.fire('pointerdown')
    win.fire('click') // the dismissing gesture's own click, swallowed
    expect(win.fire('click').defaultPrevented).toBe(false)
  })
})

describe('onPressRelease', () => {
  it('waits for the finger that opened the menu to lift', () => {
    const win = scope()
    const clock = fakeClock()
    let released = 0
    onPressRelease(win, () => { released += 1 }, clock)
    expect(released).toBe(0)
    win.fire('pointerup')
    expect(released).toBe(1)
    // Once only: later lifts belong to choices made IN the menu.
    win.fire('pointerup')
    expect(released).toBe(1)
    expect(clock.armed).toBe(0)
  })

  it('counts a cancelled press as a release', () => {
    const win = scope()
    let released = 0
    onPressRelease(win, () => { released += 1 }, fakeClock())
    win.fire('pointercancel')
    expect(released).toBe(1)
  })

  it('releases on its own when there was no press to wait for', () => {
    const win = scope()
    const clock = fakeClock()
    let released = 0
    onPressRelease(win, () => { released += 1 }, clock)
    clock.elapse()
    expect(released).toBe(1)
  })

  it('does not fire for a menu closed before the finger lifts', () => {
    const win = scope()
    const clock = fakeClock()
    let released = 0
    const stop = onPressRelease(win, () => { released += 1 }, clock)
    stop()
    win.fire('pointerup')
    clock.elapse()
    expect(released).toBe(0)
    expect(win.count('pointerup')).toBe(0)
  })
})
