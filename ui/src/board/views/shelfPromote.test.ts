import { describe, expect, it } from 'vitest'

import {
  choosePromotion,
  PROMOTE_OFF,
  PROMOTE_ON,
  type PromoteCandidate,
  type PromoteView,
} from './shelfPromote.js'

const VIEW: PromoteView = { zoom: 1, panX: 0, panY: 0, width: 1000, height: 800 }

function card(key: string, over: Partial<PromoteCandidate> = {}): PromoteCandidate {
  return { key, x: 0, y: 0, w: 200, h: 280, reflows: true, ...over }
}

/** The zoom at which the default card covers exactly `cover` of the viewport.
 *  Cards are portrait, so it is the HEIGHT axis that decides — reading the
 *  threshold off the width instead is off by nearly a factor of two. */
function zoomFor(cover: number): number {
  return cover / Math.max(200 / VIEW.width, 280 / VIEW.height)
}

describe('choosePromotion', () => {
  it('leaves a wall of thumbnails alone', () => {
    expect(choosePromotion([card('a'), card('b', { x: 300 })], VIEW, null)).toBeNull()
  })

  it('promotes a card once it covers enough of the viewport', () => {
    // 200px wide at zoom 4 is 800px on a 1000px viewport: 0.8 of the width.
    const view = { ...VIEW, zoom: 4 }
    expect(choosePromotion([card('a')], view, null)).toBe('a')
  })

  it('holds a promoted card through the hysteresis band', () => {
    // Cover lands between the two bars: too small to promote from cold, big
    // enough to keep. Without this the card would flicker under a slow pinch.
    const view = { ...VIEW, zoom: zoomFor((PROMOTE_ON + PROMOTE_OFF) / 2) }
    expect(choosePromotion([card('a')], view, null)).toBeNull()
    expect(choosePromotion([card('a')], view, 'a')).toBe('a')
  })

  it('demotes once the card has shrunk past the lower bar', () => {
    const view = { ...VIEW, zoom: zoomFor(PROMOTE_OFF - 0.05) }
    expect(choosePromotion([card('a')], view, 'a')).toBeNull()
  })

  it('promotes only one card, the largest', () => {
    const view = { ...VIEW, zoom: 4 }
    const chosen = choosePromotion(
      [card('small'), card('big', { x: 50, w: 260, h: 360 })],
      view,
      null,
    )
    expect(chosen).toBe('big')
  })

  // At this zoom a default 200x280 card covers the viewport's height exactly
  // (280 * 2.9 / 800 = 1.015) — the moment promotion is decided, and the moment
  // a neighbour on the same pitch is still a third of the way onto the screen.
  const AT_FIT = 2.9

  it('promotes the card under the pinch, not its identical neighbour', () => {
    // The bug as reported: zoom into a card and the next one over takes the
    // screen. Two same-size cards cover the viewport by exactly the same
    // fraction, so cover alone is a coin flip decided by map order.
    const view = { ...VIEW, zoom: AT_FIT }
    const cards = [card('left'), card('right', { x: 220 })]
    expect(choosePromotion(cards, { ...view, focusX: 300, focusY: 140 }, null)).toBe('right')
    expect(choosePromotion(cards, { ...view, focusX: 100, focusY: 140 }, null)).toBe('left')
  })

  it('promotes nothing when the pinch lands on a card that cannot reflow', () => {
    // A PNG under the finger is an answer — "not a page" — and it must not be
    // read as "no opinion", which would hand the screen to the report beside it.
    const view = { ...VIEW, zoom: AT_FIT, focusX: 100, focusY: 140 }
    const cards = [card('shot', { reflows: false }), card('report', { x: 220 })]
    expect(choosePromotion(cards, view, null)).toBeNull()
  })

  it('falls back to the largest card when the pinch lands on bare surface', () => {
    // (100, 500) is below both cards — the reader pinched the gap, so the board
    // has only the old question to go on.
    const view = { ...VIEW, zoom: AT_FIT, focusX: 100, focusY: 500 }
    const chosen = choosePromotion(
      [card('small'), card('big', { x: 200, w: 260, h: 360 })],
      view,
      null,
    )
    expect(chosen).toBe('big')
  })

  it('ignores a card that is mostly panned off screen', () => {
    const view = { ...VIEW, zoom: 4, panX: -700 }
    expect(choosePromotion([card('a')], view, null)).toBeNull()
  })

  it('promotes a card far LARGER than the viewport', () => {
    // The case the whole feature is for, and the one a card-relative
    // visibility test silently rejects: zoomed in until the page overflows
    // every edge, only a few percent of the card is on screen — but it is all
    // of the screen.
    const view = { ...VIEW, zoom: 20 }
    expect(choosePromotion([card('a')], view, null)).toBe('a')
  })

  it('never promotes a body that has no layout of its own', () => {
    const view = { ...VIEW, zoom: 4 }
    expect(choosePromotion([card('log', { reflows: false })], view, null)).toBeNull()
  })

  it('promotes only once the page FITS the screen, pillarboxed', () => {
    // The bug this pins: promoting at 0.6 left an A4 page filling three fifths
    // of the height and barely two fifths of the width — reading mode with the
    // page adrift in an empty screen. At the bar, the promoted box must be the
    // page fitted to the viewport on its tighter axis.
    const c = card('a')
    const aspect = c.h / c.w
    // The first zoom at which it promotes, found by walking up in fine steps.
    let zoom = 0
    for (let z = 0.1; z < 40; z += 0.0002) {
      if (choosePromotion([c], { ...VIEW, zoom: z }, null) === 'a') { zoom = z; break }
    }
    expect(zoom).toBeGreaterThan(0)
    const fitW = Math.min(VIEW.width, VIEW.height / aspect)
    const fitH = Math.min(VIEW.height, VIEW.width * aspect)
    expect(c.w * zoom).toBeCloseTo(fitW, 0)
    expect(c.h * zoom).toBeCloseTo(fitH, 0)
  })

  it('is a no-op before the viewport has been measured', () => {
    expect(choosePromotion([card('a')], { ...VIEW, width: 0, height: 0 }, null)).toBeNull()
  })
})
