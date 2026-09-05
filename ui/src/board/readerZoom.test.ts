import { describe, expect, it } from 'vitest'

import {
  fitPageZoom,
  fitZoom,
  nextZoom,
  stepZoom,
  zoomAnchorScroll,
  PAGE_ASPECT,
  PAGE_PX_H,
  PAGE_PX_W,
  ZOOM_MAX,
  ZOOM_MIN,
} from './ReaderZoom.js'

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

/**
 * FIT, WHICH IS THE PHONE'S HALF OF THE GESTURE.
 *
 * A mouse never needed a floor: a file too big for its column is fine, you
 * scroll. A finger has no wheel, so a PDF fitted to the width of a phone is a
 * page you can only read a third of, with no way back. `fitZoom` is the way
 * back, and the arithmetic is the same for all three kinds of file because at
 * zoom 1 every one of them is drawn fit to the cell's width.
 */
describe('fitZoom', () => {
  it('lands the whole of a tall page on the cell', () => {
    // A 400px-wide cell 300px tall showing an A4 sheet. At zoom 1 the page is
    // 400 x 1.414 = 566 tall; fit must divide that down to 300.
    const z = fitZoom(300, 400, PAGE_ASPECT)
    expect(400 * PAGE_ASPECT * z).toBeCloseTo(300, 6)
  })

  it('never magnifies — fit is a way back, not a way up', () => {
    // A short report that already fits is left alone rather than blown up to
    // fill the phone, which is not what anyone means by "fit".
    expect(fitZoom(800, 400, 0.5)).toBe(1)
  })

  it('stops at the floor rather than fitting a document into illegibility', () => {
    expect(fitZoom(100, 400, 40)).toBe(ZOOM_MIN)
  })

  it('answers 1 for a cell or a base it cannot measure', () => {
    expect(fitZoom(0, 400, PAGE_ASPECT)).toBe(1)
    expect(fitZoom(300, 0, PAGE_ASPECT)).toBe(1)
    expect(fitZoom(300, 400, 0)).toBe(1)
  })
})

describe('stepZoom — one press of the button pair', () => {
  it('is proportional in both directions and round-trips', () => {
    expect(stepZoom(1, 1)).toBeGreaterThan(1)
    expect(stepZoom(1, -1)).toBeLessThan(1)
    expect(stepZoom(stepZoom(2, 1), -1)).toBeCloseTo(2, 12)
  })

  it('clamps to the same range the wheel does', () => {
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX)
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN)
  })
})

/**
 * A PDF PAGE, WHERE BOTH DIMENSIONS BIND.
 *
 * The frame is enlarged and scaled down, so at zoom z its viewport is
 * `cell / z` in each direction and the page has to fit in both. On a landscape
 * phone it is the height that binds, by a factor of four; on a portrait one it
 * can be either.
 */
describe('fitPageZoom', () => {
  it('takes whichever dimension binds', () => {
    // The measured landscape cell: 750 x 292. Height binds.
    const z = fitPageZoom(750, 292)
    expect(z).toBeCloseTo(292 / PAGE_PX_H, 12)
    expect(750 / z).toBeGreaterThanOrEqual(PAGE_PX_W)
    expect(292 / z).toBeCloseTo(PAGE_PX_H, 6)
  })

  it('binds on width when the cell is tall and narrow — a portrait phone', () => {
    const z = fitPageZoom(390, 3000)
    expect(z).toBeCloseTo(390 / PAGE_PX_W, 12)
  })

  it('never magnifies, and answers 1 for a cell it cannot measure', () => {
    expect(fitPageZoom(4000, 4000)).toBe(1)
    expect(fitPageZoom(0, 292)).toBe(1)
  })

  it('agrees with the page aspect it is derived from', () => {
    expect(PAGE_ASPECT).toBeCloseTo(PAGE_PX_H / PAGE_PX_W, 12)
  })
})
