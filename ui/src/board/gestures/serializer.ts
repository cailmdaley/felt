import type { GestureBox } from './coordinates.js'

export type GestureKind = 'move' | 'resize' | 'text' | 'note' | 'new-text'

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
  noteText?: string
  point?: { x: number; y: number }
}

const TEXT_LIMIT = 72

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
    case 'note':
      return `note @ (${number(record.point?.x)},${number(record.point?.y)}): "${quote(truncate(record.noteText ?? ''))}"`
    case 'new-text':
      return `new text box  box ${box(record.afterBox)}: "${quote(truncate(record.afterText ?? ''))}"`
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

function truncate(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > TEXT_LIMIT ? `${clean.slice(0, TEXT_LIMIT - 1)}…` : clean
}

function quote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
