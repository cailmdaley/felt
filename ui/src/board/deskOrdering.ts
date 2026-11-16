import { ATTENTION_ORDER, attentionOf, lastActive, wantOf, type Attention, type Want, type Waits } from './attention.js'
import type { KanbanCard } from './KanbanTypes.js'
import type { ThreadIndex } from './threads.js'

/** Each Desk column's name. */
export const DESK_COLUMN_TITLE: Readonly<Record<Attention, string>> = { waiting: 'Waiting on you', working: 'Working', quiet: 'Quiet' }

/** A member of a family that waits on the human, and what it wants. */
export interface FamilyWait { card: KanbanCard; want: Want }

/**
 * One family as the Desk draws it: a top-level constitution with everything
 * under it, in the column of its most urgent member.
 */
export interface DeskFamily {
  root: KanbanCard
  attention: Attention
  /** Every member that waits on the human, at any depth, the newest wait first. */
  waits: FamilyWait[]
  /** How many members are working. */
  working: number
  /** What orders it in its column: its newest wait while it waits, else its latest activity. */
  at: number
}

/** The Desk's visible order. */
export interface DeskOrder {
  columns: Readonly<Record<Attention, DeskFamily[]>>
  /** What the reader's j / k walk: each family's top-level, then its members that wait, column by column. */
  rows: KanbanCard[]
  placements: ReadonlyMap<string, DeskPlacement>
}

/** The Desk column a row stands in, and its name. */
export interface DeskPlacement {
  column: Attention
  group: string
}

/** Identity shared by a Desk row and its Reader projection. */
export function deskCardKey(card: KanbanCard): string {
  return JSON.stringify([card.originId, card.uid ?? card.id])
}

const archived = (card: KanbanCard): boolean => card.column === 'tempered' || card.column === 'composted'

/** A family's place on the Desk: its members' states, what waits in it, and how it sorts. */
export function deskFamily(index: ThreadIndex, root: KanbanCard, waits: Waits): DeskFamily {
  const members = [root, ...index.subtree(root)]
  const states = members.map(card => attentionOf(card, waits))
  const attention = ATTENTION_ORDER.find(state => states.includes(state))!
  const found = members.flatMap(card => { const want = wantOf(card, waits); return want ? [{ card, want }] : [] })
    .sort((a, b) => b.want.at - a.want.at)
  return {
    root, attention, waits: found,
    working: states.filter(state => state === 'working').length,
    at: attention === 'waiting' ? found[0].want.at : Math.max(...members.map(lastActive)),
  }
}

/**
 * The Desk for a thread graph and what waits on the human: every family once,
 * in the column of its most urgent member (Waiting on you, then Working, then
 * Quiet), the newest wait first in Waiting on you and the latest activity
 * first in the others. A family whose top-level has a verdict stays off the
 * Desk unless something in it still waits or works; a cycle marks time and
 * is never a family.
 */
export function deskOrder(index: ThreadIndex, waits: Waits): DeskOrder {
  const columns: Record<Attention, DeskFamily[]> = { waiting: [], working: [], quiet: [] }
  for (const root of index.roots()) {
    if (root.isCycle) continue
    const family = deskFamily(index, root, waits)
    if (archived(root) && family.attention === 'quiet') continue
    columns[family.attention].push(family)
  }
  for (const column of ATTENTION_ORDER) columns[column].sort((a, b) => b.at - a.at || a.root.name.localeCompare(b.root.name))
  const rows: KanbanCard[] = []
  const placements = new Map<string, DeskPlacement>()
  for (const column of ATTENTION_ORDER) {
    for (const family of columns[column]) {
      for (const card of [family.root, ...family.waits.map(wait => wait.card)]) {
        const key = deskCardKey(card)
        if (placements.has(key)) continue
        placements.set(key, { column, group: DESK_COLUMN_TITLE[column] })
        rows.push(card)
      }
    }
  }
  return { columns, rows, placements }
}
