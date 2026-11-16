import { describe, expect, it } from 'vitest'
import type { Entry } from './channels.js'
import { card } from './testFixtures.js'
import { LANES, layTube } from './tube.js'

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
const short = (script: string) => { const entries = stream(script); return layTube(entries, entries.map(() => 20)) }

describe('layTube', () => {
  it('takes a line out of the bundle into a lane where its events fall close together, and back after', () => {
    const tube = short('hub +a a -a . hub')
    // The hub, running in from the top, leaves the bundle for its first item and rejoins it after its second.
    expect(tube.rows[0].own).toMatchObject({ what: 'item', excursion: { lane: 0, from: 0, to: 5 }, leaves: true, rejoins: false })
    expect(tube.rows[5].own).toMatchObject({ excursion: { lane: 0 }, leaves: false, rejoins: true })
    // a: start, item, end close together, one lane from its start to its end.
    expect(tube.rows[1].own).toMatchObject({ what: 'start', excursion: { lane: 1, from: 1, to: 3 }, leaves: false, rejoins: false })
    expect(tube.rows[2].own).toMatchObject({ what: 'item', excursion: { lane: 1 } })
    expect(tube.rows[2].through.map(each => each.line.id)).toStrictEqual(['hub:0', 'a:0'])
    // Out of the bundle, neither line is carried by it.
    expect(tube.rows[2].bundled).toStrictEqual([])
  })

  it('wires a lone event to the bundle, the bundle carrying the running line between', () => {
    const entries = stream('hub . . . hub')
    const tube = layTube(entries, [20, 700, 20, 20, 20])
    expect([tube.rows[0].own?.excursion, tube.rows[4].own?.excursion]).toStrictEqual([undefined, undefined])
    expect(tube.rows[2].bundled.map(line => line.id)).toStrictEqual(['hub:0'])
    expect(tube.rows[2].bundle).toStrictEqual({ top: true, bottom: true })
  })

  it('opens at most three lanes at once; a fourth stretch rides the bundle, its events wired to it', () => {
    const tube = short('+a +b +c +d a b c d')
    expect(tube.rows.slice(0, 4).map(row => row.own?.excursion?.lane)).toStrictEqual([0, 1, 2, undefined])
    expect(LANES).toBe(3)
    // d's start wires to the bundle, which carries it on below.
    expect(tube.rows[3].bundle).toStrictEqual({ top: false, bottom: true })
    // a, its stretch over at its item, rides the bundle again beside d.
    expect(tube.rows[5].bundled.map(line => line.id)).toStrictEqual(['a:0', 'd:0'])
  })

  it('takes a lane again once its stretch is over', () => {
    const tube = short('+a -a +b -b +c -c +d -d')
    expect(tube.rows.filter(row => row.own?.what === 'start').map(row => row.own?.excursion?.lane)).toStrictEqual([0, 0, 0, 0])
  })
})
