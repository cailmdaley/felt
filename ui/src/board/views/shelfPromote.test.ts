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

  it('is a no-op before the viewport has been measured', () => {
    expect(choosePromotion([card('a')], { ...VIEW, width: 0, height: 0 }, null)).toBeNull()
  })
})
