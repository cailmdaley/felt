import type { GestureBox } from './coordinates.js'

export type GestureKind = 'move' | 'resize' | 'text' | 'comment' | 'group'

export interface GestureLocation {
  kind: 'slide' | 'page'
  slideIndex?: string
  heading: string
  title: string
}

export interface GestureRecord {
  id: string
  kind: GestureKind
  location: GestureLocation
  fingerprint?: string
  beforeBox?: GestureBox
  afterBox?: GestureBox
  beforeText?: string
  afterText?: string
  commentText?: string
  point?: { x: number; y: number }
  /** Stable DOM identity used to coalesce repeated touches in one session. */
  coalesceKey?: string
  members?: string[]
  /** Group move: how far the whole selection travelled. */
  delta?: { x: number; y: number }
}

const TEXT_LIMIT = 72
const GEOMETRY_DEAD_ZONE = 2

/** Coalesce repeated edits to one element while preserving the first baseline.
 * Comments stay separate from one another; a comment only merges with itself,
 * when it is dragged to a new spot. */
export function coalesceGestures(records: readonly GestureRecord[]): GestureRecord[] {
  const output: Array<GestureRecord | null> = []
  const positions = new Map<string, number>()

  for (const record of records) {
    const category = coalescingCategory(record)
    const identity = record.coalesceKey ?? record.fingerprint
    const key = category && identity
      ? `${category}|${locationKey(record.location)}|${identity}`
      : record.kind === 'comment' && record.coalesceKey
        ? `comment|${record.coalesceKey}`
        : null
    if (!key) {
      output.push(record)
      continue
    }

    const position = positions.get(key)
    if (position === undefined) {
      if (!isGestureNoop(record)) {
        positions.set(key, output.length)
        output.push(record)
      }
      continue
    }

    const previous = output[position]
    if (!previous) continue
    const merged = mergeRecord(previous, record)
    if (isGestureNoop(merged)) {
      output[position] = null
      positions.delete(key)
    } else {
      output[position] = merged
    }
  }

  return output.filter((record): record is GestureRecord => record !== null)
}

/** A move/resize is noise when every box coordinate changed by at most 2px. */
export function isGestureNoop(record: GestureRecord): boolean {
  if (record.kind === 'text') return record.beforeText === record.afterText
  if (record.kind === 'move' || record.kind === 'resize') {
    return boxWithinDeadZone(record.beforeBox, record.afterBox)
  }
  return false
}

function coalescingCategory(record: GestureRecord): 'geometry' | 'text' | null {
  if (record.kind === 'move' || record.kind === 'resize') return 'geometry'
  if (record.kind === 'text') return 'text'
  return null
}

function locationKey(location: GestureLocation): string {
  return [location.kind, location.slideIndex ?? '', location.heading, location.title].join('|')
}

function mergeRecord(previous: GestureRecord, next: GestureRecord): GestureRecord {
  return {
    ...previous,
    afterBox: next.afterBox ?? previous.afterBox,
    afterText: next.afterText ?? previous.afterText,
    point: next.point ?? previous.point,
  }
}

function boxWithinDeadZone(a: GestureBox | undefined, b: GestureBox | undefined): boolean {
  if (!a || !b) return false
  return (
    Math.abs(a.x - b.x) <= GEOMETRY_DEAD_ZONE &&
    Math.abs(a.y - b.y) <= GEOMETRY_DEAD_ZONE &&
    Math.abs(a.width - b.width) <= GEOMETRY_DEAD_ZONE &&
    Math.abs(a.height - b.height) <= GEOMETRY_DEAD_ZONE
  )
}

/** Turn the unsent gesture batch into the deliberately plain language a worker
 * can apply to the source rather than treating the rendered HTML as source. */
export function serializeGestures(filePath: string, records: readonly GestureRecord[]): string {
  const basename = filePath.split('/').filter(Boolean).pop() ?? filePath
  const lines = [`[gestures on ${basename}]`]
  const groups: Array<{ location: GestureLocation; records: GestureRecord[] }> = []

  for (const record of records) {
    const group = groups.find((candidate) => sameLocation(candidate.location, record.location))
    if (group) group.records.push(record)
    else groups.push({ location: record.location, records: [record] })
  }

  for (const group of groups) {
    lines.push(locationLine(group.location))
    for (const record of group.records) lines.push(`  ${recordLine(record)}`)
  }
  return lines.join('\n')
}

function sameLocation(a: GestureLocation, b: GestureLocation): boolean {
  return a.kind === b.kind && a.slideIndex === b.slideIndex && a.heading === b.heading && a.title === b.title
}

function locationLine(location: GestureLocation): string {
  if (location.kind === 'slide') {
    return `slide ${location.slideIndex ?? '?'} "${quote(location.heading || 'untitled')}"`
  }
  return `page "${quote(location.title || 'untitled')}"`
}

function recordLine(record: GestureRecord): string {
  const name = record.fingerprint ?? 'element'
  switch (record.kind) {
    case 'move':
      return `${name}  box ${box(record.beforeBox)} -> ${box(record.afterBox)}`
    case 'resize':
      return `resize ${name}  box ${box(record.beforeBox)} -> ${box(record.afterBox)}`
    case 'text':
      return `text ${name}: "${quote(truncate(record.beforeText ?? ''))}" -> "${quote(truncate(record.afterText ?? ''))}"`
    case 'comment':
      return `comment @ (${number(record.point?.x)},${number(record.point?.y)}): "${quote(truncate(record.commentText ?? ''))}"`
    case 'group':
      return record.delta
        ? `move group [${(record.members ?? []).join(', ')}] by ${signed(record.delta.x)},${signed(record.delta.y)}`
        : `resize group [${(record.members ?? []).join(', ')}]  box ${box(record.beforeBox)} -> ${box(record.afterBox)}`
  }
}

function box(value: GestureBox | undefined): string {
  if (!value) return '?,? ?x?'
  return `${number(value.x)},${number(value.y)} ${number(value.width)}x${number(value.height)}`
}

function number(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '?'
  return String(Math.round(value * 10) / 10)
}

function signed(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '?'
  const rounded = number(value)
  return value >= 0 ? `+${rounded}` : rounded
}

function truncate(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > TEXT_LIMIT ? `${clean.slice(0, TEXT_LIMIT - 1)}…` : clean
}

function quote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
