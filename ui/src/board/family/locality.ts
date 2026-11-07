import type { MapFile, MapThread } from './model.js'
import type { Holds, Point } from './drawing.js'

/** Sent files with a place before the rest become a count. */
const SLOTS = 5
/** The arc of what a thread holds, as a share of the arm's reach, and its row pitch at reading size. */
const ARC = .68
const ARC_TOP = -.9
const ROW = 26
const TITLE_RISE = 56
const NAME_MOST = 300
const MARGIN = 14
/** A file's name per character, and what its sheet and age add. */
const CHAR = 6.6
const MARKS = 54
/** A body's holdings in miniature: how many files show before they have names. */
const MINI_FILES = 5

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
/** A body in view with what it holds at its fixed places, in small and unnamed. */
export interface Mini {
  thread: MapThread
  marks: Array<Point & { file: MapFile; kind: HeldKind }>
}

/** The place `row` rows down the arc at the body's upper right, about the body. */
function place(row: number, reach: number): Point {
  const radius = reach * ARC, y = radius * ARC_TOP + row * ROW
  return { x: Math.sqrt(Math.max(0, radius ** 2 - y ** 2)), y }
}

/** Where a thread's title sits, heading the arc of what it holds. */
export function heldTitle(at: Point, reach: number): Point {
  const { x, y } = place(0, reach)
  return { x: at.x + x, y: at.y + y - TITLE_RISE }
}

/**
 * What a thread holds, in places fixed around its body at every level, so what
 * it lacks leaves its place empty and the rest stay put: the tapestry first on
 * the arc in the upper quarter the arms leave free, sent files down the arc
 * newest first, what does not fit counted in the last place, and the
 * constitution small in the opposite quarter.
 */
export function unfold(thread: MapThread, holds: Holds, frame: { width: number }, at: Point, reach: number): Satellite[] {
  const { lead, constitution } = holds
  const files = thread.files.filter(file => file.key !== lead?.key)
  const shown = files.length > SLOTS ? files.slice(0, SLOTS - 1) : files
  const spot = (row: number): Point => { const { x, y } = place(row, reach); return { x: at.x + x, y: at.y + y } }
  const room = (point: Point): number => Math.min(NAME_MOST, frame.width - point.x - MARGIN)
  const fits = (name: string, point: Point): boolean => name.length * CHAR + MARKS <= room(point)
  const out: Satellite[] = []
  if (lead) out.push({ ...spot(0), file: lead, kind: 'lead', more: 0, side: 'right', room: room(spot(0)) })
  shown.forEach((file, n) => {
    const point = spot(n + 1)
    if (fits(file.name, point)) out.push({ ...point, file, kind: 'file', more: 0, side: 'right', room: room(point) })
  })
  if (files.length > shown.length) out.push({ ...spot(shown.length + 1), kind: 'file', more: files.length - shown.length, side: 'right', room: room(spot(shown.length + 1)) })
  if (constitution) {
    const { x, y } = place(0, reach), point = { x: at.x - x, y: at.y - y }
    out.push({ ...point, file: constitution, kind: 'constitution', more: 0, side: 'left', room: Math.min(NAME_MOST, point.x - MARGIN) })
  }
  return out
}

/** A body's holdings in miniature, at the same places as when it unfolds, drawn to the scale its room has reached. */
export function miniature(thread: MapThread, holds: Holds, at: Point, reach: number): Mini {
  const { x: crownX, y: crownY } = place(0, reach)
  const pitch = ROW * reach / 300
  const files = thread.files.filter(file => file.key !== holds.lead?.key).slice(0, MINI_FILES)
  const down = (n: number): Point => { const y = crownY + (n + 1) * pitch, radius = reach * ARC; return { x: at.x + Math.sqrt(Math.max(0, radius ** 2 - y ** 2)), y: at.y + y } }
  return {
    thread,
    marks: [
      ...(holds.lead ? [{ x: at.x + crownX, y: at.y + crownY, file: holds.lead, kind: 'lead' as const }] : []),
      ...files.map((file, n) => ({ ...down(n), file, kind: 'file' as const })),
      ...(holds.constitution ? [{ x: at.x - crownX, y: at.y - crownY, file: holds.constitution, kind: 'constitution' as const }] : []),
    ],
  }
}
