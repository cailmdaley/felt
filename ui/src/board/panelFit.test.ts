// A restored file-reader window must fit the viewport it is restored into.
// The reader persists its geometry, so a window saved on a taller display can
// exceed the current viewport. Its document must remain scrollable all the way
// to the bottom while the window itself stays on screen.

import { describe, expect, it } from 'vitest'
import { fitPanelGeometry } from './FloatingPanelChrome.js'

const MIN = { width: 380, height: 320 }

describe('fitPanelGeometry', () => {
  it('shrinks a panel taller than the window so its bottom edge stays visible', () => {
    // The exact shape of the bug: geometry saved on a tall display, reopened
    // in a short window.
    const g = fitPanelGeometry(
      { left: 165, top: 12, width: 952, height: 1400 },
      { width: 1280, height: 577 },
      MIN,
    )
    expect(g.top + g.height).toBeLessThanOrEqual(577)
    expect(g.left + g.width).toBeLessThanOrEqual(1280)
  })

  it('leaves a geometry that already fits exactly alone', () => {
    const g = { left: 165, top: 12, width: 952, height: 553 }
    expect(fitPanelGeometry(g, { width: 1280, height: 577 }, MIN)).toEqual(g)
  })

  it('slides a panel that fits but hangs off the edge back inside', () => {
    // Size is fine; only the position is stale.
    expect(fitPanelGeometry(
      { left: 1100, top: 500, width: 600, height: 400 },
      { width: 1280, height: 800 },
      MIN,
    )).toEqual({ left: 680, top: 400, width: 600, height: 400 })
  })

  it('never shrinks below the minimum, even in a window smaller than it', () => {
    // A window narrower/shorter than the panel minimum: the minimum wins and
    // the panel is pinned to the origin rather than pushed negative.
    const g = fitPanelGeometry(
      { left: 40, top: 40, width: 900, height: 900 },
      { width: 300, height: 200 },
      MIN,
    )
    expect(g).toEqual({ left: 0, top: 0, width: 380, height: 320 })
  })

  it('pulls a panel dragged off the top-left back to the origin', () => {
    const g = fitPanelGeometry(
      { left: -200, top: -80, width: 600, height: 400 },
      { width: 1280, height: 800 },
      MIN,
    )
    expect(g).toEqual({ left: 0, top: 0, width: 600, height: 400 })
  })
})
