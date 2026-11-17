import type { KanbanCard } from './KanbanTypes.js'
import type { Ending, Entry } from './channels.js'

/**
 * The structure of Channels' margin, apart from its drawing: which life of
 * which thread runs where down the stream, which of them have a fibre of
 * their own at each height and which are gathered into the faint strand, in
 * what order they lie across the margin, and how taut each is where.
 *
 * Every length here is in the stream's *reckoned* pixels: each row stands at
 * the height its parts reckon before anything in it loads ({@link rowHeight}
 * for a station, a post by its previews). The drawing maps them onto the rows
 * as measured, so a preview that loads stretches the margin inside its own
 * row and leaves every line above and below it as it was, and an entry
 * arriving at the foot moves nothing already drawn.
 */

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
  /** The life of its parent thread that runs where it starts, when it is a sub-thread and its parent's line is in the stream. */
  parent?: TubeLine
  /** Its place across the margin, left to right: the row it first appears at. */
  rank: number
}

/** A thing a line does that asks for a fibre around it, and how much: a post 3, a handoff 2, a parent's reach to a sub-thread 1. */
interface Mark { at: number; weight: number }

/** A stretch of the stream over which a line has a fibre of its own. */
export interface Span {
  line: TubeLine
  /** Reckoned pixels from the stream's top. */
  from: number
  to: number
  /** It begins at the line's start, from its cell body, rather than leaving the strand. */
  born: boolean
  /** It ends at the line's end, in its arbor, rather than being gathered into the strand. */
  dies: boolean
}

/** A stretch where running lines with no fibre of their own ride the strand. */
export interface Gathered { from: number; to: number; lines: TubeLine[] }

export interface Tube {
  lines: TubeLine[]
  /** Each row's top, reckoned. */
  tops: number[]
  /** Where each row's mark sits (a post's drop, a station's body), reckoned. */
  anchors: number[]
  /** The stream's reckoned height. */
  height: number
  spans: Span[]
  gathered: Gathered[]
}

const STATION_PX = { start: 22, tick: 16, end: 18 } as const
/** About how tall an entry's row stands before anything in it loads. */
export const rowHeight = (entry: Entry): number =>
  entry.kind === 'station' ? STATION_PX[entry.what] : 64 + (entry.files.length || entry.kind === 'close' ? 330 : 0)
/** Where a row's mark sits below its top: a post's drop beside its head, a station's mark at its middle. */
export const ANCHOR = { item: 20, grouped: 12, start: 11, tick: 8, end: 9 } as const
export const anchorOf = (entry: Entry, grouped = false): number =>
  entry.kind === 'station' ? ANCHOR[entry.what] : grouped ? ANCHOR.grouped : ANCHOR.item

/** A line has a fibre of its own within this many reckoned pixels of anything it does. */
export const REACH_PX = 220
/** At most this many lines have a fibre of their own at any height. */
export const MAX_FIBRES = 4
/** At most this many working lines keep a fibre to the stream's foot. */
export const WORKING_FIBRES = 3
/** A fibre leaves the strand, or is gathered back into it, along this many pixels, its colour and weight coming in or going out over all of them. */
export const FADE_PX = 90

/**
 * Lays a stream's lives out for the margin. A line has a fibre of its own
 * within {@link REACH_PX} of each of its marks (a post, a handoff, a
 * sub-thread's start), from its start and to its end where those are near,
 * and from its last mark to the stream's foot while its thread works (the
 * {@link WORKING_FIBRES} heard from latest);
 * elsewhere, while it runs, it is gathered into the strand. A start or an end
 * with no mark near it is born into the strand or leaves from it. A line's
 * rank across the margin is the row it first appears at, so a line born here
 * lies right of every line drawn before it.
 */
export function layTube(
  entries: readonly Entry[],
  heights: readonly number[] = entries.map(entry => rowHeight(entry)),
  { parentOf = () => undefined, grouped = [], active = () => false }: {
    parentOf?: (card: KanbanCard) => KanbanCard | undefined
    grouped?: readonly boolean[]
    /** Whether a line's thread works now: a working line keeps its fibre from its last mark to the stream's foot. */
    active?: (line: TubeLine) => boolean
  } = {},
): Tube {
  const tops: number[] = [], anchors: number[] = []
  let height = 0
  entries.forEach((entry, row) => { tops.push(height); anchors.push(height + anchorOf(entry, grouped[row])); height += heights[row] })
  const lines = new Map<string, TubeLine>(), marks = new Map<TubeLine, Mark[]>()
  entries.forEach((entry, row) => {
    const id = entry.line
    if (!id) return
    const line = lines.get(id) ?? lines.set(id, { id, card: entry.card, from: -1, to: Infinity, rank: row }).get(id)!
    // A start or an end is no mark of its own: a line born or ending far from anything else it does is born into the strand or leaves from it.
    const own = marks.get(line) ?? marks.set(line, []).get(line)!
    if (entry.kind !== 'station') own.push({ at: anchors[row], weight: 3 })
    else if (entry.what === 'tick') own.push({ at: anchors[row], weight: 2 })
    if (entry.kind !== 'station') return
    if (entry.what === 'start') line.from = row
    if (entry.what === 'end') { line.to = row; line.end = entry.end }
  })
  const lifeOf = (line: TubeLine): [number, number] => [line.from < 0 ? -Infinity : anchors[line.from], line.to === Infinity ? Infinity : anchors[line.to]]
  // A sub-thread's start is a mark on its parent's line too: the parent reaches down to touch it.
  for (const line of lines.values()) {
    if (line.from < 0) continue
    const parent = parentOf(line.card)
    if (!parent) continue
    const at = anchors[line.from]
    const life = [...lines.values()].find(each => each.card === parent && lifeOf(each)[0] < at && at <= lifeOf(each)[1])
    if (!life) continue
    line.parent = life
    marks.get(life)!.push({ at, weight: 1 })
  }
  // The working lines heard from most recently keep their fibres to the foot; the rest of a busy fleet stays gathered.
  const lastOf = (line: TubeLine): number => Math.max(0, lifeOf(line)[0], ...marks.get(line)!.map(mark => mark.at))
  const working = new Set([...lines.values()].filter(line => line.to === Infinity && active(line)).sort((a, b) => lastOf(b) - lastOf(a)).slice(0, WORKING_FIBRES))
  // Each mark asks for a fibre around it, the weightiest first (a post, then a handoff or a working line's way to the foot, then a
  // parent's reach to a sub-thread), each from the top down. A window that would make more than MAX_FIBRES at some height shrinks
  // to a short fibre about its mark, and failing that is not drawn: its post hangs from the strand.
  const RES = 8, last = Math.ceil(height / RES), count = new Uint8Array(last + 1), mine = new Map<TubeLine, Uint8Array>()
  const bins = (a: number, b: number): [number, number] => [Math.max(0, Math.floor(a / RES)), Math.min(last, Math.ceil(b / RES))]
  const take = (line: TubeLine, a: number, b: number): boolean => {
    const [born, dies] = lifeOf(line), [k0, k1] = bins(Math.max(born, a), Math.min(dies, b)), own = mine.get(line) ?? mine.set(line, new Uint8Array(last + 1)).get(line)!
    if (k1 < k0) return true
    for (let k = k0; k <= k1; k++) if (!own[k] && count[k] >= MAX_FIBRES) return false
    for (let k = k0; k <= k1; k++) if (!own[k]) { own[k] = 1; count[k]++ }
    return true
  }
  const asks = [...marks].flatMap(([line, at]) => [
    ...at.map(mark => ({ line, ...mark, a: mark.at - REACH_PX, b: mark.at + REACH_PX })),
    ...working.has(line) ? [{ line, at: lastOf(line), weight: 2, a: lastOf(line), b: Infinity }] : [],
  ]).sort((p, q) => q.weight - p.weight || p.at - q.at || p.line.rank - q.line.rank)
  for (const ask of asks) if (!take(ask.line, ask.a, ask.b)) take(ask.line, ask.at - FADE_PX, ask.at + FADE_PX)
  // A line's own stretches closer than two fades join, where there is room; each run of them is a span.
  const spans: Span[] = []
  for (const [line, own] of mine) {
    const [born, dies] = lifeOf(line)
    for (let k = 1, gap = -1; k <= last; k++) {
      if (!own[k]) { if (own[k - 1]) gap = k; continue }
      if (gap >= 0 && k - gap <= (2 * FADE_PX) / RES) take(line, gap * RES, k * RES)
      gap = -1
    }
    for (let k = 0; k <= last; k++) {
      if (!own[k] || own[k - 1]) continue
      let end = k
      while (end < last && own[end + 1]) end++
      // A stretch that reaches the stream's top or foot runs on past it.
      const from = k === 0 ? born : Math.max(born, k * RES), to = end === last ? dies : Math.min(dies, end * RES)
      spans.push({ line, from: from <= born + RES ? born : from, to: to >= dies - RES ? dies : to, born: from <= born + RES && born > -Infinity, dies: to >= dies - RES && dies < Infinity })
      k = end
    }
  }
  // The strand: between every pair of boundaries, the running lines with no fibre there.
  const edges = [...new Set([0, height, ...spans.flatMap(span => [span.from, span.to]), ...[...lines.values()].flatMap(lifeOf)])]
    .filter(edge => edge >= 0 && edge <= height).sort((a, b) => a - b)
  const gathered: Gathered[] = []
  for (let k = 0; k + 1 < edges.length; k++) {
    const from = edges[k], to = edges[k + 1], mid = (from + to) / 2
    const riding = [...lines.values()].filter(line => {
      const [born, dies] = lifeOf(line)
      return born < mid && mid < dies && !spans.some(span => span.line === line && span.from < mid && mid < span.to)
    })
    if (!riding.length) continue
    const last = gathered.at(-1)
    if (last && last.to === from && last.lines.length === riding.length && last.lines.every((line, n) => line === riding[n])) last.to = to
    else gathered.push({ from, to, lines: riding })
  }
  return { lines: [...lines.values()], tops, anchors, height, spans, gathered }
}

/** How much of the time from `a` to `b` the runs cover, 0 to 1; at an instant, whether one covers it. */
export function tautness(runs: ReadonlyArray<readonly [number, number]>, a: number, b: number): number {
  if (b <= a) return runs.some(([from, to]) => from <= a && a <= to) ? 1 : 0
  let covered = 0
  for (const [from, to] of runs) covered += Math.max(0, Math.min(b, to) - Math.max(a, from))
  return Math.min(1, covered / (b - a))
}

/**
 * A thread's runs, each from a launch to the first thing after it that stops
 * a worker: a handoff, a close, a rest, a question to the human, or the next
 * launch. A run with none of those after it lasts until now while the thread
 * works, else until the last thing it did.
 */
export function runsOf(launches: readonly number[], stops: readonly number[], { now, working, last }: { now: number; working: boolean; last: number }): Array<[number, number]> {
  const sorted = [...launches].sort((a, b) => a - b), halts = [...stops].sort((a, b) => a - b)
  return sorted.map((from, n) => {
    const next = Math.min(sorted[n + 1] ?? Infinity, halts.find(at => at > from) ?? Infinity)
    return [from, next < Infinity ? next : working ? now : Math.max(from, last)]
  })
}
