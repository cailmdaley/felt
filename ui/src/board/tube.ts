import type { KanbanCard } from './KanbanTypes.js'
import type { Ending, Entry } from './channels.js'

/** One life of a thread, drawn as a line down a lane at the stream's left. */
export interface TubeLine {
  /** `<fiber>:<n>`, as its stations and items name it. */
  id: string
  card: KanbanCard
  /** Its lane, 0 the outermost. */
  lane: number
  /** The row of its start, or -1 when it began before the stream does. */
  from: number
  /** The row of its end, or Infinity while it runs. */
  to: number
  /** How it ended, once it has. */
  end?: Ending
}

/** What a row draws in the gutter: the lines passing it, and its own part of one, if any. */
export interface TubeRow {
  /** The lines running the row's full height. */
  through: TubeLine[]
  /** The line the row is a station of: its start, a tick, its end, or one of its items. */
  own?: { line: TubeLine; what: 'start' | 'tick' | 'end' | 'item' }
}

export interface Tube { lines: TubeLine[]; lanes: number; rows: TubeRow[] }

/**
 * Lays a stream's lives out as a tube map: each line a lane from its start
 * row to its end row, a lane taken again from the row after its line ended,
 * the lines already running at the stream's top in the outer lanes.
 */
export function layTube(entries: readonly Entry[]): Tube {
  const lines = new Map<string, TubeLine>()
  entries.forEach((entry, row) => {
    const id = entry.line
    if (!id) return
    const line = lines.get(id) ?? lines.set(id, { id, card: entry.card, lane: 0, from: -1, to: Infinity }).get(id)!
    if (entry.kind !== 'station') return
    if (entry.what === 'start') line.from = row
    if (entry.what === 'end') { line.to = row; line.end = entry.end }
  })
  // Each lane's last row taken; a line takes the outermost lane free before its start.
  const taken: number[] = []
  for (const line of [...lines.values()].sort((a, b) => a.from - b.from || a.id.localeCompare(b.id))) {
    let lane = taken.findIndex(last => last < line.from)
    if (lane < 0) lane = taken.length
    taken[lane] = line.to
    line.lane = lane
  }
  const sorted = [...lines.values()].sort((a, b) => a.lane - b.lane)
  const rows = entries.map((entry, row): TubeRow => {
    const id = entry.line
    const own = id ? lines.get(id) : undefined
    return {
      through: sorted.filter(line => line.from < row && row < line.to),
      ...own ? { own: { line: own, what: entry.kind === 'station' ? entry.what : 'item' } } : {},
    }
  })
  return { lines: sorted, lanes: taken.length, rows }
}
