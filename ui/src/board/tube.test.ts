import { describe, expect, it } from 'vitest'
import type { Entry } from './channels.js'
import { card } from './testFixtures.js'
import { layTube } from './tube.js'

const now = Date.parse('2026-11-16T12:00:00Z')
const cards = new Map<string, ReturnType<typeof card>>()
const of = (slug: string) => cards.get(slug) ?? cards.set(slug, card({ id: `unions/${slug}`, uid: slug, name: slug })).get(slug)!
/** A stream from a script: `+a` starts a's line, `-a` ends it, `^a` ticks it, `a` is an item on it, `.` an item on no line. */
const stream = (script: string): Entry[] => script.split(' ').map((step, row): Entry => {
  const slug = step.replace(/^[+\-^]/, ''), what = ({ '+': 'start', '-': 'end', '^': 'tick' } as const)[step[0] as '+' | '-' | '^']
  const at = now - (100 - row) * 60_000
  if (what) return { kind: 'station', id: `${step}:${row}`, card: of(slug), at, what, line: `${slug}:0`, ...what === 'end' ? { end: 'closed' as const } : {} }
  return { kind: 'post', id: `p:${row}`, card: of(slug === '.' ? 'chair' : slug), at, arrived: at, text: '', files: [], waiting: false, ...slug === '.' ? {} : { line: `${slug}:0` } }
})

describe('layTube', () => {
  it('gives a line already running at the top the outer lane, and takes a lane again from the row after its line ended', () => {
    const tube = layTube(stream('hub +a a -a +b ^hub b . -hub'))
    expect(tube.lines.map(line => [line.id, line.lane, line.from, line.to])).toStrictEqual([
      ['hub:0', 0, -1, 8], ['a:0', 1, 1, 3], ['b:0', 1, 4, Infinity],
    ])
    expect(tube.lanes).toBe(2)
    // Row 2, a's item: the hub and a pass it, and it is a station of a.
    expect([tube.rows[2].through.map(line => line.id), tube.rows[2].own?.what]).toStrictEqual([['hub:0', 'a:0'], 'item'])
    // Row 4, b's start: b is not yet through, and a has gone.
    expect([tube.rows[4].through.map(line => line.id), tube.rows[4].own?.what]).toStrictEqual([['hub:0'], 'start'])
    expect(tube.rows[7].own).toBeUndefined()
  })

  it('holds a dense hour in a few lanes: four starts and their ends, reused as they close', () => {
    const tube = layTube(stream('+a +b -a +c -b +d -c -d +e'))
    expect(tube.lines.map(line => [line.id, line.lane])).toStrictEqual([['a:0', 0], ['c:0', 0], ['e:0', 0], ['b:0', 1], ['d:0', 1]])
    expect(tube.lanes).toBe(2)
  })
})
