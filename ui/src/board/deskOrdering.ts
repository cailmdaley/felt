import { ATTENTION_ORDER, attentionOf, lastActive, wantOf, type Attention, type Want, type Waits } from './attention.js'
import type { KanbanCard } from './KanbanTypes.js'
import { slug } from './threadOutline.js'
import { turnOf } from './turn.js'
import type { ThreadIndex } from './threads.js'

/**
 * The Desk's sections, in reading order. The first three are the board's
 * columns: what waits on the human for an answer, what works, and what was
 * closed for their review. The other three are its shelf, where quiet
 * families rest by what their top-level is: a draft, at rest, or a seat or
 * standing schedule.
 */
export const DESK_SECTIONS = ['waiting', 'working', 'review', 'drafts', 'resting', 'roles'] as const
export type DeskSection = typeof DESK_SECTIONS[number]
/** The sections drawn as the board's columns; the rest stand on the shelf below them. */
export const DESK_COLUMNS: readonly DeskSection[] = ['waiting', 'working', 'review']

/** Each Desk section's name. */
export const DESK_SECTION_TITLE: Readonly<Record<DeskSection, string>> = {
  waiting: 'Waiting on you', working: 'Working', review: 'Awaiting review', drafts: 'Drafts', resting: 'Resting', roles: 'Roles & standing',
}

/** A column's name on the phone's folio tab, where three must share a line. */
export const DESK_FOLIO_NAME: Readonly<Partial<Record<DeskSection, string>>> = { waiting: 'Waiting', working: 'Working', review: 'Review' }

/** A member of a family that waits on the human, and what it wants. */
export interface FamilyWait { card: KanbanCard; want: Want }

/**
 * One family as the Desk draws it: a top-level constitution with everything
 * under it, in the section its members put it in, naming every member that
 * moves: those that wait on the human, then those with a live worker.
 */
export interface DeskFamily {
  root: KanbanCard
  /** The most urgent state among its members, for colour. */
  attention: Attention
  section: DeskSection
  /** Every member that waits on the human, at any depth, the newest wait first. */
  waits: FamilyWait[]
  /** Every member below the top-level with a live worker that asks nothing, at any depth: mid-turn first, then the latest active. */
  live: KanbanCard[]
  /** What orders it in its section: its newest wait while it waits, else its latest activity. */
  at: number
}

/** The Desk's visible order. */
export interface DeskOrder {
  sections: Readonly<Record<DeskSection, DeskFamily[]>>
  /** What the reader's j / k walk: each family's top-level, then its members that wait, then its live members, section by section. */
  rows: KanbanCard[]
  placements: ReadonlyMap<string, DeskPlacement>
}

/** The Desk section a row stands in, and its name. */
export interface DeskPlacement {
  section: DeskSection
  group: string
}

/** Identity shared by a Desk row and its Reader projection. */
export function deskCardKey(card: KanbanCard): string {
  return JSON.stringify([card.originId, card.uid ?? card.id])
}

const archived = (card: KanbanCard): boolean => card.column === 'tempered' || card.column === 'composted'

/** Where a quiet family rests, by its top-level: a seat or a standing schedule, a rest, else a draft (a launch held at boot among them). */
function shelf(root: KanbanCard): DeskSection {
  if (root.column === 'roles' || root.shuttleKind === 'standing') return 'roles'
  return root.column === 'resting' ? 'resting' : 'drafts'
}

/** Mid-turn before idle (or starting, or unheard from), then the latest active first. */
const byLiveness = (a: KanbanCard, b: KanbanCard): number =>
  Number(turnOf(b).turn === 'working') - Number(turnOf(a).turn === 'working') || lastActive(b) - lastActive(a)

/**
 * A family's place on the Desk. Waiting on you when a member wants an answer
 * (an ask, a post, a prompt, a turn that could not start); else Awaiting
 * review when a member was closed for review; else Working when a member
 * works; else its top-level's shelf.
 */
export function deskFamily(index: ThreadIndex, root: KanbanCard, waits: Waits): DeskFamily {
  const members = [root, ...index.subtree(root)]
  const states = members.map(card => attentionOf(card, waits))
  const attention = ATTENTION_ORDER.find(state => states.includes(state))!
  const found = members.flatMap(card => { const want = wantOf(card, waits); return want ? [{ card, want }] : [] })
    .sort((a, b) => b.want.at - a.want.at)
  const live = members.filter((_, i) => i > 0 && states[i] === 'working').sort(byLiveness)
  const section: DeskSection = found.some(wait => wait.want.kind !== 'review') ? 'waiting'
    : found.length ? 'review' : attention === 'working' ? 'working' : shelf(root)
  return { root, attention, section, waits: found, live, at: found.length ? found[0].want.at : Math.max(...members.map(lastActive)) }
}

/**
 * The Desk for a thread graph and what waits on the human: every family once,
 * in its section (`deskFamily`). Families that wait are ordered by their
 * newest wait, seats and schedules by name, the rest by latest activity. A
 * family whose top-level has a verdict stays off the Desk unless something in
 * it still waits or works; a cycle marks time and is never a family.
 */
export function deskOrder(index: ThreadIndex, waits: Waits): DeskOrder {
  const sections = Object.fromEntries(DESK_SECTIONS.map(section => [section, [] as DeskFamily[]])) as Record<DeskSection, DeskFamily[]>
  for (const root of index.roots()) {
    if (root.isCycle) continue
    const family = deskFamily(index, root, waits)
    if (archived(root) && family.attention === 'quiet') continue
    sections[family.section].push(family)
  }
  const byName = (a: DeskFamily, b: DeskFamily): number => slug(a.root).localeCompare(slug(b.root))
  for (const section of DESK_SECTIONS) sections[section].sort(section === 'roles' ? byName : (a, b) => b.at - a.at || byName(a, b))
  const rows: KanbanCard[] = []
  const placements = new Map<string, DeskPlacement>()
  for (const section of DESK_SECTIONS) {
    for (const family of sections[section]) {
      for (const card of [family.root, ...family.waits.map(wait => wait.card), ...family.live]) {
        const key = deskCardKey(card)
        if (placements.has(key)) continue
        placements.set(key, { section, group: DESK_SECTION_TITLE[section] })
        rows.push(card)
      }
    }
  }
  return { sections, rows, placements }
}
