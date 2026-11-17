import { describe, expect, it } from 'vitest'
import type { Entry } from './channels.js'
import { field } from './ink.js'
import { card } from './testFixtures.js'
import { FADE_PX, MAX_FIBRES, REACH_PX, WORKING_FIBRES, layTube, runsOf, tautness } from './tube.js'

const now = Date.parse('2026-11-16T12:00:00Z')
const cards = new Map<string, ReturnType<typeof card>>()
const of = (slug: string) => cards.get(slug) ?? cards.set(slug, card({ id: `unions/${slug}`, uid: slug, name: slug })).get(slug)!
/** A stream from a script: `+a` starts a's line, `-a` ends it, `^a` ticks it, `a` is an item on it, `.` an item on no line. */
const stream = (script: string): Entry[] => script.trim().split(' ').map((step, row): Entry => {
  const slug = step.replace(/^[+\-^]/, ''), what = ({ '+': 'start', '-': 'end', '^': 'tick' } as const)[step[0] as '+' | '-' | '^']
  const at = now - (100 - row) * 60_000
  if (what) return { kind: 'station', id: `${step}:${row}`, card: of(slug), at, what, line: `${slug}:0`, ...what === 'end' ? { end: 'closed' as const } : {} }
  return { kind: 'post', id: `p:${row}`, card: of(slug === '.' ? 'chair' : slug), at, arrived: at, text: '', files: [], waiting: false, ...slug === '.' ? {} : { line: `${slug}:0` } }
})
const lay = (script: string, height = 64, options: Parameters<typeof layTube>[2] = {}) => { const entries = stream(script); return layTube(entries, entries.map(() => height), options) }
const spansOf = (tube: ReturnType<typeof layTube>, slug: string) => tube.spans.filter(span => span.line.id === `${slug}:0`)

describe('layTube', () => {
  it('gives a line a fibre of its own around what it says, and gathers it into the strand far from that', () => {
    // hub speaks at the top and again far below; between, it rides the strand.
    const tube = lay(`hub ${'. '.repeat(14)}hub`)
    const [first, second] = spansOf(tube, 'hub')
    // Reaching the stream's top, its first stretch runs on past it.
    expect(first).toMatchObject({ from: -Infinity, to: 20 + REACH_PX, born: false, dies: false })
    expect(second.from).toBe(15 * 64 + 20 - REACH_PX)
    expect(tube.gathered).toStrictEqual([{ from: first.to, to: second.from, lines: [first.line] }])
  })

  it('draws a fibre from its cell body where a line starts with something to say soon, and into its arbor where it ends just after', () => {
    const tube = lay('+a a -a', 30)
    expect(spansOf(tube, 'a')).toMatchObject([{ from: tube.anchors[0], to: tube.anchors[2], born: true, dies: true }])
  })

  it('bears a line that starts or ends with nothing near it straight into the strand, with no fibre of its own', () => {
    const tube = lay(`+a ${'. '.repeat(10)}-a`)
    expect(spansOf(tube, 'a')).toStrictEqual([])
    expect(tube.gathered[0].lines.map(line => line.id)).toStrictEqual(['a:0'])
  })

  it('reaches a parent down to touch the start of each sub-thread, and links the two', () => {
    const tube = lay(`hub ${'. '.repeat(10)}+child child`, 64, { parentOf: c => c === of('child') ? of('hub') : undefined })
    const child = tube.lines.find(line => line.id === 'child:0')!
    expect(child.parent?.id).toBe('hub:0')
    expect(spansOf(tube, 'hub').at(-1)!.to).toBeGreaterThan(tube.anchors[11])
  })

  it('keeps a working line drawn from its last word to the foot, for the latest few that work', () => {
    const tube = lay(`a b c d e ${'. '.repeat(12)}`, 64, { active: () => true })
    expect(tube.spans.filter(span => span.to === Infinity).map(span => span.line.id)).toStrictEqual(['c:0', 'd:0', 'e:0'])
    expect(WORKING_FIBRES).toBe(3)
  })

  it('ranks lines by the row each first appears at, so one born later lies to the right', () => {
    const tube = lay('a +b b a')
    expect(tube.lines.map(line => [line.id, line.rank])).toStrictEqual([['a:0', 0], ['b:0', 1]])
  })
})

describe('the fibres', () => {
  /** A random scene: a stream of 20 to 60 rows over a dozen threads, starting, speaking, handing off and ending, at a station's, a post's and a figure's heights. */
  const scene = (seed: number) => {
    let state = seed
    const next = (): number => { state = (state * 1103515245 + 12345) % 2 ** 31; return state / 2 ** 31 }
    const live = new Set<string>(), steps: string[] = []
    for (let row = 0, rows = 20 + Math.floor(next() * 40); row < rows; row++) {
      const slug = `t${Math.floor(next() * 12)}`, roll = next()
      if (!live.has(slug) && roll < 0.4) { live.add(slug); steps.push(`+${slug}`) } else if (live.has(slug) && roll < 0.1) { live.delete(slug); steps.push(`-${slug}`) } else steps.push(roll < 0.2 ? `^${slug}` : roll < 0.3 ? '.' : slug)
    }
    const entries = stream(steps.join(' '))
    return { entries, heights: entries.map(() => [22, 64, 394][Math.floor(next() * 3)]) }
  }

  it('never cross and are never more than a few: across random scenes, at every height, each drawn line lies right of the strand and of every line ranked before it, inside the margin', () => {
    const faults: string[] = []
    for (let seed = 1; seed <= 60; seed++) {
      const { entries, heights } = scene(seed)
      const tube = layTube(entries, heights, { active: line => line.rank % 2 === 0 })
      const place = field(tube, { left: 5, right: 40, chaos: 1.6, taut: (line, s) => (Math.sin(s / 40 + line.rank) + 1) / 2 })
      for (let s = 0; s <= tube.height; s += 3) {
        const slice = place(s)
        const xs = [...slice.lines].sort(([a], [b]) => a.rank - b.rank || a.id.localeCompare(b.id)).map(([, here]) => here.x)
        const across = slice.strand ? [slice.strand.x, ...xs] : xs
        if (across.some((x, k) => x < 5 || x > 40 || (k > 0 && x <= across[k - 1]))) faults.push(`seed ${seed} at ${s}: ${across.map(x => x.toFixed(2))}`)
        if (tube.spans.filter(span => span.from < s && s < span.to).length > MAX_FIBRES) faults.push(`seed ${seed} at ${s}: more than ${MAX_FIBRES} fibres`)
      }
    }
    expect(faults).toStrictEqual([])
  })

  it('keep their shape above an entry that arrives at the foot', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { entries, heights } = scene(seed)
      const arriving: Entry = { kind: 'post', id: 'late', card: entries[0].card, at: now, arrived: now, text: '', files: [], waiting: false, line: entries[0].line }
      const before = layTube(entries, heights), after = layTube([...entries, arriving], [...heights, 64])
      const was = field(before, { left: 5, right: 40, chaos: 1.6 }), is = field(after, { left: 5, right: 40, chaos: 1.6 })
      for (let s = 0; s < before.height - REACH_PX - 2 * FADE_PX; s += 7) {
        expect([...is(s).lines.values()].map(here => here.x), `seed ${seed} at ${s}`).toStrictEqual([...was(s).lines.values()].map(here => here.x))
      }
    }
  })
})

describe('tension', () => {
  it('is the share of the time between two rows that a run covers', () => {
    const runs = [[10, 20], [30, 40]] as const
    expect(tautness(runs, 0, 10)).toBe(0)
    expect(tautness(runs, 10, 20)).toBe(1)
    expect(tautness(runs, 15, 35)).toBe(0.5)
    expect(tautness(runs, 0, 40)).toBe(0.5)
    // Two rows at one instant: taut if a run covers it.
    expect([tautness(runs, 12, 12), tautness(runs, 25, 25)]).toStrictEqual([1, 0])
  })

  it('runs from each launch to the next handoff, close, rest, question or launch; the last until now while it works, else until its last word', () => {
    expect(runsOf([0, 50], [20, 30, 70], { now: 100, working: true, last: 90 })).toStrictEqual([[0, 20], [50, 70]])
    expect(runsOf([0, 50], [20], { now: 100, working: true, last: 90 })).toStrictEqual([[0, 20], [50, 100]])
    expect(runsOf([0, 50], [20], { now: 100, working: false, last: 90 })).toStrictEqual([[0, 20], [50, 90]])
    expect(runsOf([0, 10], [], { now: 100, working: false, last: 5 })).toStrictEqual([[0, 10], [10, 10]])
  })
})
