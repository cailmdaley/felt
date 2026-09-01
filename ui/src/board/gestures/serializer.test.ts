import { describe, expect, it } from 'vitest'
import { serializeGestures, type GestureRecord } from './serializer.js'

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
        id: 'n', kind: 'note', location: slide, point: { x: 200, y: 300 },
        noteText: 'put the menu here',
      },
    ]
    expect(serializeGestures('/tmp/talk/index.html', records)).toBe(
      '[gestures on index.html]\n' +
      'slide 14 "Results"\n' +
      '  img.money-plot (Fig 4)  box 80,120 1120x560 -> 400,120 800x560\n' +
      '  note @ (200,300): "put the menu here"',
    )
  })

  it('truncates and quotes edited text', () => {
    const long = 'a'.repeat(100)
    expect(serializeGestures('report.html', [{
      id: 't', kind: 'text', location: { kind: 'page', heading: '', title: 'Report' },
      fingerprint: 'p.lede', beforeText: 'old', afterText: long,
    }])).toContain('page "Report"\n  text p.lede: "old" -> "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa…"')
  })
})
