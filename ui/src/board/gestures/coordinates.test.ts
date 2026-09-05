import { describe, expect, it } from 'vitest'
import { boxInSpace, pointInRect, pointInSpace, roundBox, scaleFromTransform, type CoordinateSpace } from './coordinates.js'

const slide: CoordinateSpace = {
  kind: 'slide', originX: 100, originY: 40, scale: 0.5,
  slideIndex: '3', heading: 'Covariances', title: 'deck',
}

 describe('gesture coordinate math', () => {
  it('divides reveal coordinates by the rendered scale', () => {
    expect(pointInSpace(140, 100, slide)).toEqual({ x: 80, y: 120 })
    expect(roundBox(boxInSpace({ left: 140, top: 100, width: 560, height: 280 }, slide))).toEqual({
      x: 80, y: 120, width: 1120, height: 560,
    })
  })

  it('adds document scroll for ordinary HTML pages', () => {
    const page: CoordinateSpace = { kind: 'page', originX: 0, originY: 0, scale: 1, heading: '', title: 'report' }
    expect(pointInSpace(30, 40, page, 10, 20)).toEqual({ x: 40, y: 60 })
    expect(boxInSpace({ left: 30, top: 40, width: 100, height: 50 }, page, 10, 20)).toEqual({
      x: 40, y: 60, width: 100, height: 50,
    })
  })

  it('treats a group outline as solid, gaps between members included', () => {
    const outline = { left: 100, top: 80, width: 400, height: 200 }
    // The empty middle of the box belongs to the group, not to a new marquee.
    expect(pointInRect(300, 180, outline)).toBe(true)
    expect(pointInRect(100, 80, outline)).toBe(true)
    expect(pointInRect(500, 280, outline)).toBe(true)
    expect(pointInRect(99, 180, outline)).toBe(false)
    expect(pointInRect(300, 281, outline)).toBe(false)
  })

  it('reads both 2d and 3d CSS matrix scales', () => {
    expect(scaleFromTransform('matrix(0.75, 0, 0, 0.75, 0, 0)')).toBe(0.75)
    expect(scaleFromTransform('matrix3d(0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1)')).toBe(0.5)
    expect(scaleFromTransform('none')).toBeNull()
  })
})
