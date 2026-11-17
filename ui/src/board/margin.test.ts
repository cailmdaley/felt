// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { Entry } from './channels.js'
import { drawMargin, measure, type MarginRow } from './margin.js'
import { card } from './testFixtures.js'
import { layTube, rowHeight } from './tube.js'

const now = Date.parse('2026-11-16T12:00:00Z')
const threads = Array.from({ length: 12 }, (_, n) => card({ id: `unions/t${n}`, uid: `t${n}`, name: `t${n}` }))
/** Fifty rows over a dozen threads: each starts, speaks a few times (some with a figure), and some end. */
const entries: Entry[] = Array.from({ length: 50 }, (_, row): Entry => {
  const thread = threads[row % 12], at = now - (50 - row) * 300_000, line = `${thread.uid}:0`
  if (row < 12) return { kind: 'station', id: `start:${row}`, card: thread, at, what: 'start', line }
  if (row > 44) return { kind: 'station', id: `end:${row}`, card: thread, at, what: 'end', end: 'tempered', line }
  return { kind: 'post', id: `post:${row}`, card: thread, at, arrived: at, text: 'Said.', files: row % 5 ? [] : [{ fullPath: `/x/${row}.svg`, basename: `${row}.svg`, uid: thread.uid, timestamp: at }], waiting: row % 7 === 0, line }
})
const heights = entries.map(entry => rowHeight(entry))
const laid = (rows: number[]): MarginRow[] => { let top = 12; return entries.map((entry, n) => { const row = { entry, grouped: false, top, height: rows[n] }; top += rows[n]; return row }) }

describe('the margin', () => {
  it('stretches only a row that loads taller: every height above it stands where it stood, every one below moves down by the difference', () => {
    const tube = layTube(entries, heights), grown = [...heights]
    grown[20] += 140
    const was = measure(tube, laid(heights)), is = measure(tube, laid(grown))
    for (let s = 0; s < tube.height; s += 5) {
      if (s <= tube.tops[20]) expect(is.y(s)).toBeCloseTo(was.y(s), 6)
      if (s >= tube.tops[21]) expect(is.y(s)).toBeCloseTo(was.y(s) + 140, 6)
    }
    // A row's mark keeps its place in the row, however tall the row stands.
    expect(is.y(tube.anchors[20]) - is.y(tube.tops[20])).toBeCloseTo(20, 6)
  })


  it('joins a life too short for a fibre of its own from its cell body to its end', () => {
    const thread = threads[0], line = 't0:0'
    const short: Entry[] = [
      { kind: 'station', id: 'start', card: thread, at: now, what: 'start', line },
      { kind: 'station', id: 'tick', card: thread, at: now + 1, what: 'tick', line },
      { kind: 'station', id: 'end', card: thread, at: now + 2, what: 'end', end: 'tempered', line },
    ]
    const tube = layTube(short), rows = short.map((entry, n) => ({ entry, grouped: false, top: tube.tops[n], height: rowHeight(entry) }))
    const { svg } = drawMargin(tube, rows, tube.height, { width: 56, chaos: 1.6, weight: 1, hue: () => '0', taut: () => 1, title: () => '', gatheredTitle: () => '', markTitle: () => '' })
    const fibre = svg.querySelector(`.kbn-ch-fibre[data-line="${line}"]`)!
    // Its cell's three wisps, its arbor's three twigs, and the one curve between its start and its end.
    expect(fibre.querySelectorAll('.kbn-ch-twig').length).toBe(7)
    expect(svg.innerHTML).not.toMatch(/NaN|Infinity/)
  })
})
