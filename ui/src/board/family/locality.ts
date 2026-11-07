import type { FamilyModel, MapFile, MapThread } from './model.js'
import type { Focus, Point } from './drawing.js'

/** The scale from which a focused thread unfolds what it holds. */
export const REVEAL = 2.4
const REACH_LEAST = 120
const REACH_MOST = 168
const NAME_MOST = 300
const MARGIN = 14
/** A focused body's least radius. */
export const FOCUS_BODY = 17
const KID_MOST = 12
/** The tapestry and the constitution sit this high on the orbit, as a share of its radius, either side of the body. */
const CROWN = -.87
/** Sent files and threads each have these places down their side of the orbit, the first this high, the same share apart. */
const SLOTS = 7
const SLOT_TOP = -.5
const SLOT_STEP = .225
/** A side's heading sits between the crown and the first place. */
const KICKER = -.68
/** A phone stacks every place in a column below the thread's name: one row each for the tapestry and the constitution, then these for files. */
const ROW = 27
const NARROW_DROP = 62
const NARROW_INSET = 30
const NARROW_FILES = 4

export type HeldKind = 'lead' | 'constitution' | 'file'
/** One thing a thread holds, at its place, with its name running outward. */
export interface Satellite extends Point {
  /** Absent on the row that counts what did not fit. */
  file?: MapFile
  kind: HeldKind
  more: number
  side: 'left' | 'right'
  room: number
}
export interface Slot extends Point { thread: MapThread; r: number; room: number; side: 'left' | 'right' }
/** A side's heading, over its first place. */
export interface Kicker extends Point { label: string; side: 'left' | 'right' }
/** A focused thread unfolded around its body. */
export interface Locality {
  thread: MapThread
  at: Point
  r: number
  reach: number
  held: Satellite[]
  /** The thread's own threads, gathered to their places. */
  kids: Slot[]
  kickers: Kicker[]
}

/** A thread's own threads the plate draws, most urgent first. */
const kidsOf = (model: FamilyModel, thread: MapThread, drawn: ReadonlySet<string>): MapThread[] =>
  thread.children.flatMap(key => drawn.has(key) ? [model.threads.get(key)!] : []).sort((a, b) => (a.rank < 0 ? Infinity : a.rank) - (b.rank < 0 ? Infinity : b.rank))

/**
 * Lays a thread out the same way at every level. The places are fixed, so what
 * a thread lacks leaves its place empty and the rest stay put: the tapestry at
 * the orbit's upper right and the largest, the constitution small at its upper
 * left, sent files down the right newest first, the thread's threads down the
 * left, what does not fit counted in a side's last place. On a phone the same
 * places run down one column, below the thread's name.
 */
export function unfold(model: FamilyModel, thread: MapThread, focus: Focus, frame: { width: number; height: number; narrow: boolean }, at: Point, body: number, drawn: ReadonlySet<string>): Locality {
  const { width, height, narrow } = frame, { lead, constitution } = focus
  const files = thread.files.filter(file => file.key !== lead?.key)
  const r = Math.max(body, FOCUS_BODY), kids = kidsOf(model, thread, drawn)
  const reach = narrow ? 0 : Math.round(Math.min(REACH_MOST, Math.max(REACH_LEAST, Math.min(width, height) * .24)))
  const satellite = (place: Point, side: 'left' | 'right', kind: HeldKind, room: number, file?: MapFile, more = 0): Satellite => ({ ...place, file, kind, more, side, room })
  if (narrow) {
    const room = width - NARROW_INSET - MARGIN
    const row = (n: number): Point => ({ x: NARROW_INSET, y: at.y + r + NARROW_DROP + n * ROW })
    const shown = files.length > NARROW_FILES ? files.slice(0, NARROW_FILES - 1) : files
    const held = [
      ...(lead ? [satellite(row(0), 'right', 'lead', room, lead)] : []),
      ...(constitution ? [satellite(row(1), 'right', 'constitution', room, constitution)] : []),
      ...shown.map((file, n) => satellite(row(2 + n), 'right', 'file', room, file)),
      ...(files.length > shown.length ? [satellite(row(2 + shown.length), 'right', 'file', room, undefined, files.length - shown.length)] : []),
    ]
    const places = Math.max(0, Math.floor((height - row(2 + NARROW_FILES).y) / ROW))
    return { thread, at, r, reach, held, kickers: [], kids: kids.slice(0, places).map((kid, n) => ({ ...row(2 + NARROW_FILES + n), thread: kid, r: 7, room, side: 'right' })) }
  }
  const place = (share: number, side: 'left' | 'right'): Point => ({ x: at.x + (side === 'right' ? 1 : -1) * reach * Math.sqrt(1 - share ** 2), y: at.y + reach * share })
  const slot = (n: number, side: 'left' | 'right'): Point => place(SLOT_TOP + n * SLOT_STEP, side)
  const room = (spot: Point, side: 'left' | 'right'): number => Math.min(NAME_MOST, side === 'right' ? width - spot.x - MARGIN : spot.x - MARGIN)
  const shown = files.length > SLOTS ? files.slice(0, SLOTS - 1) : files
  const crownRight = place(CROWN, 'right'), crownLeft = place(CROWN, 'left')
  const held = [
    ...(lead ? [satellite(crownRight, 'right', 'lead', room(crownRight, 'right'), lead)] : []),
    ...(constitution ? [satellite(crownLeft, 'left', 'constitution', room(crownLeft, 'left'), constitution)] : []),
    ...shown.map((file, n) => satellite(slot(n, 'right'), 'right', 'file', room(slot(n, 'right'), 'right'), file)),
    ...(files.length > shown.length ? [satellite(slot(shown.length, 'right'), 'right', 'file', room(slot(shown.length, 'right'), 'right'), undefined, files.length - shown.length)] : []),
  ]
  const gathered = kids.slice(0, SLOTS)
  const kickers: Kicker[] = [
    ...(files.length ? [{ label: 'Sent', side: 'right' as const, ...place(KICKER, 'right') }] : []),
    ...(kids.length ? [{ label: `Threads · ${kids.length}`, side: 'left' as const, ...place(KICKER, 'left') }] : []),
  ]
  return {
    thread, at, r, reach, held, kickers,
    kids: gathered.map((kid, n) => ({ ...slot(n, 'left'), thread: kid, r: KID_MOST, room: room(slot(n, 'left'), 'left'), side: 'left' })),
  }
}
