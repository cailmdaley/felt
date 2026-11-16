import type { KanbanCard } from './KanbanTypes.js'
import type { Ending, Entry } from './channels.js'

/** One life of a thread: from its start row to its end row. */
export interface TubeLine {
  /** `<fiber>:<n>`, as its stations and items name it. */
  id: string
  card: KanbanCard
  /** The row of its start, or -1 when it began before the stream does. */
  from: number
  /** The row of its end, or Infinity while it runs. */
  to: number
  /** How it ended, once it has. */
  end?: Ending
}

/** A stretch of a line out of the bundle in a lane of its own: from one of its events to another close below it. */
export interface Excursion { line: TubeLine; lane: number; from: number; to: number }

/** What a row draws in the gutter. */
export interface TubeRow {
  /** Whether the bundle runs into the row from above, and on out of it below. */
  bundle: { top: boolean; bottom: boolean }
  /** The running lines the bundle carries past this row. */
  bundled: TubeLine[]
  /** The excursions passing the row in their lanes. */
  through: Excursion[]
  /**
   * The row's own event, if any: on its excursion's lane, leaving the bundle
   * just above it or rejoining it just below; else wired to the bundle.
   */
  own?: { line: TubeLine; what: 'start' | 'tick' | 'end' | 'item'; excursion?: Excursion; leaves: boolean; rejoins: boolean }
}

export interface Tube { lines: TubeLine[]; rows: TubeRow[] }

/** At most this many lines run in lanes of their own at once; the rest ride the bundle. */
export const LANES = 3
/** Events of one line closer than this (in estimated pixels of stream between them) share one excursion. */
export const GAP_PX = 600

/** About how tall an entry's row stands: what decides whether a line's events are near enough to share a lane. */
export const rowHeight = (entry: Entry): number =>
  entry.kind === 'station' ? { start: 22, tick: 16, end: 18 }[entry.what] : 64 + (entry.files.length || entry.kind === 'close' ? 330 : 0)

/**
 * Lays a stream's lives out as a bundle with a few lanes beside it. Every
 * running line rides one bundle; a line leaves it into a lane of its own for
 * a stretch where its events fall close together (a start, the items it said,
 * a handoff, its end), and rejoins it after. At most {@link LANES} lanes run at
 * once, the earliest stretches first; an event with no lane is wired straight
 * to the bundle.
 */
export function layTube(entries: readonly Entry[], heights: readonly number[] = entries.map(rowHeight)): Tube {
  const lines = new Map<string, TubeLine>(), events = new Map<string, number[]>()
  entries.forEach((entry, row) => {
    const id = entry.line
    if (!id) return
    const line = lines.get(id) ?? lines.set(id, { id, card: entry.card, from: -1, to: Infinity }).get(id)!
    ;(events.get(id) ?? events.set(id, []).get(id)!).push(row)
    if (entry.kind !== 'station') return
    if (entry.what === 'start') line.from = row
    if (entry.what === 'end') { line.to = row; line.end = entry.end }
  })
  const between = (a: number, b: number): number => heights.slice(a + 1, b).reduce((sum, height) => sum + height, 0)
  // Each line's events, grouped where they fall close together; a group of two or more asks for a lane.
  const asked: Array<Omit<Excursion, 'lane'>> = []
  for (const [id, rows] of events) {
    let first = rows[0]
    rows.forEach((row, index) => {
      const next = rows[index + 1]
      if (next !== undefined && between(row, next) <= GAP_PX) return
      if (row > first) asked.push({ line: lines.get(id)!, from: first, to: row })
      first = next
    })
  }
  const taken: number[] = Array(LANES).fill(-Infinity), excursions: Excursion[] = []
  for (const stretch of asked.sort((a, b) => a.from - b.from || a.line.id.localeCompare(b.line.id))) {
    const lane = taken.findIndex(last => last < stretch.from)
    if (lane < 0) continue
    taken[lane] = stretch.to
    excursions.push({ ...stretch, lane })
  }
  const rows = entries.map((entry, row): TubeRow => {
    const out = (line: TubeLine): Excursion | undefined => excursions.find(each => each.line === line && each.from <= row && row <= each.to)
    const bundled = [...lines.values()].filter(line => line.from < row && row < line.to && !out(line))
    const through = excursions.filter(each => each.from < row && row < each.to)
    const line = entry.line ? lines.get(entry.line) : undefined
    let own: TubeRow['own']
    if (line) {
      const what = entry.kind === 'station' ? entry.what : 'item', excursion = out(line)
      own = { line, what, excursion, leaves: !!excursion && row === excursion.from && what !== 'start', rejoins: !!excursion && row === excursion.to && what !== 'end' }
    }
    const wired = own && !own.excursion
    return {
      bundle: {
        top: bundled.length > 0 || !!own?.leaves || (!!wired && own!.what !== 'start'),
        bottom: bundled.length > 0 || !!own?.rejoins || (!!wired && own!.what !== 'end'),
      },
      bundled, through, ...own ? { own } : {},
    }
  })
  return { lines: [...lines.values()], rows }
}
