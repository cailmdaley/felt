import type { FamilyModel, MapFile, MapThread } from './model.js'
import type { Point } from './drawing.js'

/** The scale from which a focused thread unfolds what it holds. */
export const REVEAL = 2.4
/** The least height of a satellite's row. */
const ROW = 27
const ROW_MOST = 42
const REACH_LEAST = 104
const REACH_MOST = 168
const NAME_MOST = 300
const MARGIN = 14
/** A focused body's least radius. */
export const FOCUS_BODY = 17
const KID_MOST = 12
/** A phone stacks what a thread holds below it, this far down and this far in. */
const NARROW_DROP = 62
const NARROW_INSET = 30
/** A side's heading sits this far above its first row, this far around the orbit. */
const KICKER_RISE = 26
const KICKER_X = .86

/** One thing a thread holds, on its orbit, with its name running outward. */
export interface Satellite extends Point {
  /** Absent on the row that counts what did not fit. */
  file?: MapFile
  lead: boolean
  more: number
  side: 'left' | 'right'
  room: number
}
export interface Slot extends Point { thread: MapThread; r: number; room: number; side: 'left' | 'right' }
/** A side's heading, over its first row. */
export interface Kicker extends Point { label: string; side: 'left' | 'right' }
/** A focused thread unfolded around its body. */
export interface Locality {
  thread: MapThread
  at: Point
  r: number
  reach: number
  held: Satellite[]
  /** The thread's own threads, gathered onto its orbit. */
  kids: Slot[]
  kickers: Kicker[]
}

/** A thread's own threads the plate draws, most urgent first. */
const kidsOf = (model: FamilyModel, thread: MapThread, drawn: ReadonlySet<string>): MapThread[] =>
  thread.children.flatMap(key => drawn.has(key) ? [model.threads.get(key)!] : []).sort((a, b) => (a.rank < 0 ? Infinity : a.rank) - (b.rank < 0 ? Infinity : b.rank))

/** `count` places down one side of an orbit, nearest the equator kept evenly apart. */
function arc(count: number, reach: number, at: Point, side: 'left' | 'right'): Point[] {
  const gap = Math.min(ROW_MOST, (2 * reach - ROW) / Math.max(1, count - 1))
  return Array.from({ length: count }, (_, n) => {
    const dy = (n - (count - 1) / 2) * gap
    return { x: at.x + (side === 'right' ? 1 : -1) * Math.sqrt(Math.max(0, reach ** 2 - dy ** 2)), y: at.y + dy }
  })
}

/**
 * Lays a thread's holdings around its body: on a wide plate its tapestry and
 * files down the right of one orbit and its threads down the left, each name
 * running outward, what does not fit counted in a last row; on a phone, a
 * column below it.
 */
export function unfold(model: FamilyModel, thread: MapThread, lead: MapFile | undefined, frame: { width: number; height: number; narrow: boolean }, at: Point, body: number, drawn: ReadonlySet<string>): Locality {
  const { width, height, narrow } = frame
  const files = thread.files.filter(file => file.key !== lead?.key)
  const holdings: Array<{ file: MapFile; lead: boolean }> = [...(lead ? [{ file: lead, lead: true }] : []), ...files.map(file => ({ file, lead: false }))]
  const r = Math.max(body, FOCUS_BODY), kids = kidsOf(model, thread, drawn)
  const reach = narrow ? 0 : Math.round(Math.min(REACH_MOST, Math.max(REACH_LEAST, Math.min(width, height) * .24)))
  const rows = narrow ? Math.floor((height - at.y - NARROW_DROP) / ROW) : Math.floor((2 * reach - ROW) / ROW) + 1
  const satellite = (place: Point, side: 'left' | 'right', room: number, item?: typeof holdings[number], more = 0): Satellite => ({ ...place, file: item?.file, lead: item?.lead ?? false, more, side, room })
  const clip = (items: typeof holdings, count: number): { shown: typeof holdings; more: number } => items.length <= count ? { shown: items, more: 0 } : { shown: items.slice(0, count - 1), more: items.length - count + 1 }
  if (narrow) {
    const room = width - NARROW_INSET - MARGIN
    const down = (n: number): Point => ({ x: NARROW_INSET, y: at.y + NARROW_DROP + n * ROW })
    const { shown, more } = clip(holdings, Math.max(1, rows - Math.min(kids.length, Math.floor(rows / 2))))
    const held = shown.map((item, n) => satellite(down(n), 'right', room, item))
    if (more) held.push(satellite(down(shown.length), 'right', room, undefined, more))
    return { thread, at, r, reach, held, kids: kids.slice(0, Math.max(0, rows - held.length)).map((kid, n) => ({ ...down(held.length + n), thread: kid, r: 7, room, side: 'right' })), kickers: [{ label: held.length ? 'Holds' : 'Nothing sent yet', side: 'right', x: NARROW_INSET - 8, y: at.y + NARROW_DROP - ROW }] }
  }
  /** Without threads of its own, a long list takes both sides of the orbit. */
  const spill = kids.length === 0 && holdings.length > rows
  const right = spill ? holdings.slice(0, Math.ceil(holdings.length / 2)) : holdings
  const left = spill ? holdings.slice(right.length) : []
  const side = (items: typeof holdings, name: 'left' | 'right'): Satellite[] => {
    const { shown, more } = clip(items, rows), count = shown.length + (more ? 1 : 0), places = arc(count, reach, at, name)
    const room = (place: Point): number => Math.min(NAME_MOST, name === 'right' ? width - place.x - MARGIN : place.x - MARGIN)
    return [...shown.map((item, n) => satellite(places[n], name, room(places[n]), item)), ...(more ? [satellite(places[shown.length], name, room(places[shown.length]), undefined, more)] : [])]
  }
  const shownKids = kids.slice(0, rows), places = arc(shownKids.length, reach, at, 'left')
  const held = [...side(right, 'right'), ...side(left, 'left')]
  const topOf = (places_: readonly Point[]): number => Math.min(...places_.map(place => place.y), at.y)
  const kickers: Kicker[] = [{ label: held.length ? 'Holds' : 'Nothing sent yet', side: 'right', x: at.x + reach * KICKER_X, y: topOf(held.filter(item => item.side === 'right').length ? held.filter(item => item.side === 'right') : [{ x: 0, y: at.y }]) - KICKER_RISE }]
  if (shownKids.length) kickers.push({ label: `Threads · ${kids.length}`, side: 'left', x: at.x - reach * KICKER_X, y: topOf(places) - KICKER_RISE })
  return {
    thread, at, r, reach, held, kickers,
    kids: shownKids.map((kid, n) => ({ ...places[n], thread: kid, r: KID_MOST, room: Math.min(NAME_MOST, places[n].x - MARGIN), side: 'left' })),
  }
}
