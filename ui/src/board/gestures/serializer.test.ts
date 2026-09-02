import { describe, expect, it } from 'vitest'
import { coalesceGestures, serializeGestures, type GestureRecord } from './serializer.js'

const slide = { kind: 'slide' as const, slideIndex: '14', heading: 'Results', title: 'deck' }

 describe('gesture serializer', () => {
  it('groups records by slide and uses the plain-text protocol', () => {
    const records: GestureRecord[] = [
      {
        id: 'm', kind: 'move', location: slide, fingerprint: 'img.money-plot (Fig 4)',
        beforeBox: { x: 80, y: 120, width: 1120, height: 560 },
        afterBox: { x: 400, y: 120, width: 800, height: 560 },
      },
      {
        id: 'n', kind: 'comment', location: slide, point: { x: 200, y: 300 },
        commentText: 'this plot is doing too much work',
      },
    ]
    expect(serializeGestures('/tmp/talk/index.html', records)).toBe(
      '[gestures on index.html]\n' +
      'slide 14 "Results"\n' +
      '  img.money-plot (Fig 4)  box 80,120 1120x560 -> 400,120 800x560\n' +
      '  comment @ (200,300): "this plot is doing too much work"',
    )
  })

  it('coalesces repeated geometry against its original box', () => {
    const first = {
      id: 'm1', kind: 'move' as const, location: slide, fingerprint: 'img.plot', coalesceKey: 'plot',
      beforeBox: { x: 100, y: 200, width: 400, height: 300 },
      afterBox: { x: 140, y: 220, width: 400, height: 300 },
    }
    const second = {
      ...first, id: 'm2', beforeBox: first.afterBox,
      afterBox: { x: 160, y: 230, width: 400, height: 300 },
    }
    expect(coalesceGestures([first, second])).toEqual([{
      ...first, afterBox: second.afterBox,
    }])
  })

  it('drops geometry and text that return to their original values', () => {
    const move: GestureRecord = {
      id: 'm', kind: 'move', location: slide, fingerprint: 'img.plot', coalesceKey: 'plot',
      beforeBox: { x: 100, y: 200, width: 400, height: 300 },
      afterBox: { x: 102, y: 202, width: 400, height: 300 },
    }
    const text: GestureRecord = {
      id: 't', kind: 'text', location: slide, fingerprint: 'p.caption', coalesceKey: 'caption',
      beforeText: 'old', afterText: 'new',
    }
    expect(coalesceGestures([move])).toEqual([])
    expect(coalesceGestures([text, { ...text, id: 't2', beforeText: 'new', afterText: 'old' }])).toEqual([])
  })

  it('serializes a group move with member fingerprints and a signed delta', () => {
    expect(serializeGestures('deck.html', [{
      id: 'g', kind: 'group', location: slide,
      members: ['img.money-plot', 'p.caption'], delta: { x: 320, y: -40 },
    }])).toContain('move group [img.money-plot, p.caption] by +320,-40')
  })

  it('serializes a group resize as one box change', () => {
    expect(serializeGestures('deck.html', [{
      id: 'g', kind: 'group', location: slide,
      members: ['img.money-plot', 'p.caption'],
      beforeBox: { x: 80, y: 120, width: 1120, height: 560 },
      afterBox: { x: 80, y: 120, width: 560, height: 280 },
    }])).toContain('resize group [img.money-plot, p.caption]  box 80,120 1120x560 -> 80,120 560x280')
  })

  it('keeps separate comments separate and follows one that is dragged', () => {
    const first: GestureRecord = {
      id: 'c1', kind: 'comment', location: slide, coalesceKey: 'c1',
      point: { x: 10, y: 10 }, commentText: 'here',
    }
    const second: GestureRecord = { ...first, id: 'c2', coalesceKey: 'c2', commentText: 'and here' }
    const moved: GestureRecord = { ...first, point: { x: 90, y: 40 } }
    expect(coalesceGestures([first, second])).toHaveLength(2)
    expect(coalesceGestures([first, second, moved])).toEqual([
      { ...first, point: { x: 90, y: 40 } }, second,
    ])
  })

  it('truncates and quotes edited text', () => {
    const long = 'a'.repeat(100)
    expect(serializeGestures('report.html', [{
      id: 't', kind: 'text', location: { kind: 'page', heading: '', title: 'Report' },
      fingerprint: 'p.lede', beforeText: 'old', afterText: long,
    }])).toContain('page "Report"\n  text p.lede: "old" -> "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa…"')
  })
})
