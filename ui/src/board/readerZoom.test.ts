import { describe, expect, it } from 'vitest'

import { nextZoom, zoomAnchorScroll, ZOOM_MAX, ZOOM_MIN } from './ReaderZoom.js'

/**
 * THE ZOOM GESTURE, AS NUMBERS.
 *
 * Both readers on the board magnify a file the same way, and the part that is
 * easy to get subtly wrong is not the DOM write — it is the anchor. A zoom that
 * does not hold the point under the cursor walks the reader away from the thing
 * they were pointing at, one notch at a time, and it does it plausibly enough
 * that nobody files it as a bug. So that arithmetic is pinned here.
 */

describe('nextZoom', () => {
  it('magnifies on a wheel up and shrinks on a wheel down', () => {
    expect(nextZoom(1, -100)).toBeGreaterThan(1)
    expect(nextZoom(1, 100)).toBeLessThan(1)
  })

  it('is proportional, not additive — one notch is the same step at any zoom', () => {
    const a = nextZoom(1, -100) / 1
    const b = nextZoom(2, -100) / 2
    expect(b).toBeCloseTo(a, 12)
  })

  it('clamps at both ends and stops dead there', () => {
    expect(nextZoom(ZOOM_MAX, -10_000)).toBe(ZOOM_MAX)
    expect(nextZoom(ZOOM_MIN, 10_000)).toBe(ZOOM_MIN)
    // At the ceiling, magnifying further returns the old value UNCHANGED, and
    // that identity is the caller's signal to do nothing: no re-layout, no
    // persist, no scroll write for a notch that moved nothing.
    expect(nextZoom(ZOOM_MAX, -1)).toBe(ZOOM_MAX)
    // The way back is still open — a ceiling is not a trap.
    expect(nextZoom(ZOOM_MAX, 1)).toBeLessThan(ZOOM_MAX)
  })
})

describe('zoomAnchorScroll — the point under the cursor does not move', () => {
  const at = (over: Partial<Parameters<typeof zoomAnchorScroll>[0]> = {}) =>
    zoomAnchorScroll({
      scrollLeft: 200,
      scrollTop: 100,
      cursorX: 50,
      cursorY: 30,
      zOld: 1,
      zNew: 2,
      ...over,
    })

  it('keeps the content point under the cursor exactly where it was', () => {
    const { scrollLeft, scrollTop } = at()
    // Content-space point at zoom 1: (200 + 50) and (100 + 30). At zoom 2 it
    // sits at twice that, and the scroll must absorb the difference so the
    // cursor still lands on it.
    expect((scrollLeft + 50) / 2).toBeCloseTo(250, 12)
    expect((scrollTop + 30) / 2).toBeCloseTo(130, 12)
  })

  it('is a no-op when the zoom did not change', () => {
    expect(at({ zNew: 1 })).toEqual({ scrollLeft: 200, scrollTop: 100 })
  })

  it('holds the anchor on the way back down too', () => {
    const { scrollLeft, scrollTop } = at({ zOld: 4, zNew: 1 })
    expect((scrollLeft + 50) / 1).toBeCloseTo((200 + 50) / 4, 12)
    expect((scrollTop + 30) / 1).toBeCloseTo((100 + 30) / 4, 12)
  })

  it('lets the scroll go negative rather than lying about the anchor', () => {
    // Zooming out near the top-left wants a scroll the cell cannot give. The
    // arithmetic says so plainly; clamping to 0 is the browser's job, and
    // pretending here would put the anchor somewhere it is not.
    expect(at({ scrollLeft: 0, scrollTop: 0, zOld: 4, zNew: 1 }).scrollLeft).toBeLessThan(0)
  })
})
