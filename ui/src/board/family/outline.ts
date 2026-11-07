import { needsHuman, type FamilyModel, type MapThread } from './model.js'
import { threadState } from '../threads.js'

/** The kinds of attention a thread can ask for, most urgent first: the order of the rows and the words of the counts. */
export const SECTIONS = ['question', 'blocked', 'turn', 'review', 'working', 'still'] as const
export type Section = typeof SECTIONS[number]
const ASIDE_SECTIONS = ['resting', 'drafts', 'roles', 'archived'] as const
type AsideSection = typeof ASIDE_SECTIONS[number]
export const SECTION_WORD: Readonly<Record<Section | AsideSection, string>> = {
  question: 'Questions', blocked: 'Blocked', turn: 'Your turn', review: 'To review', working: 'Working', still: 'No worker',
  resting: 'Resting', drafts: 'Drafts', roles: 'Seats', archived: 'Archived',
}

/** One line of the page under its head: the family's section of a kind of attention, a thread's row, or the fold that holds a level's threads set aside. */
export type Line =
  | { kind: 'section'; key: string; section: Section | AsideSection; level: number }
  | { kind: 'thread'; key: string; thread: MapThread; level: number; section: Section | undefined; open: boolean; divided: boolean }
  | { kind: 'aside'; key: string; owner: string; level: number; threads: MapThread[]; open: boolean }

/** What a row says of the threads under it. */
export interface Under { section: Section | undefined; from: MapThread | undefined; threads: number; asks: number; lastMove: number }

const rankOf = (section: Section | undefined): number => section === undefined ? SECTIONS.length : SECTIONS.indexOf(section)
const own = (thread: MapThread): Section | undefined => (SECTIONS as readonly string[]).includes(thread.tone) ? thread.tone as Section : undefined

/**
 * Each thread's standing with everything under it: the most urgent section at
 * or below it and the thread that puts it there, how many threads it holds and
 * how many of those ask something of the human, and its newest move. A thread
 * whose whole subtree is set aside has no section.
 */
export function underAll(model: FamilyModel): ReadonlyMap<string, Under> {
  const all = new Map<string, Under>()
  const walk = (thread: MapThread): Under => {
    let section = own(thread), from = section ? thread : undefined, threads = 0, asks = 0, lastMove = thread.lastMove
    for (const key of thread.children) {
      const kid = model.threads.get(key)!, below = walk(kid)
      threads += 1 + below.threads
      asks += (needsHuman(kid) ? 1 : 0) + below.asks
      lastMove = Math.max(lastMove, below.lastMove)
      if (rankOf(below.section) < rankOf(section)) { section = below.section; from = below.from }
    }
    const under = { section, from, threads, asks, lastMove }
    all.set(thread.key, under)
    return under
  }
  walk(model.root)
  return all
}

/**
 * The page under its head, which is the family's root: the tree whole, every
 * thread under its orchestrator. Siblings run by the most urgent thing each
 * holds, then newest first, and the family's own threads sit under one
 * divider per kind of attention, each once; the threads set aside (archived,
 * resting, drafts) wait behind one fold at the end of their level. An open
 * row lists its own threads beneath it the same way, without dividers.
 */
export function outline(model: FamilyModel, open: ReadonlySet<string>, under: ReadonlyMap<string, Under> = underAll(model)): Line[] {
  const lines: Line[] = []
  const byUrgency = (a: MapThread, b: MapThread): number => {
    const x = under.get(a.key)!, y = under.get(b.key)!
    return rankOf(x.section) - rankOf(y.section) || y.lastMove - x.lastMove || a.name.localeCompare(b.name)
  }
  const level = (owner: MapThread, depth: number): void => {
    const kids = owner.children.map(key => model.threads.get(key)!).sort(byUrgency)
    const live = kids.filter(kid => under.get(kid.key)!.section), aside = kids.filter(kid => !under.get(kid.key)!.section)
    let last: Section | undefined
    for (const kid of live) {
      const section = under.get(kid.key)!.section!
      if (depth === 0 && section !== last) lines.push({ kind: 'section', key: `section:${section}`, section, level: depth })
      last = section
      row(kid, depth, section, depth === 0)
    }
    if (!aside.length) return
    const key = `aside:${owner.key}`, unfolded = open.has(key)
    lines.push({ kind: 'aside', key, owner: owner.key, level: depth, threads: aside, open: unfolded })
    if (unfolded) for (const section of ASIDE_SECTIONS) {
      const group = aside.filter(kid => threadState(kid.card) === section)
      if (!group.length) continue
      lines.push({ kind: 'section', key: `aside-section:${owner.key}:${section}`, section, level: depth })
      for (const kid of group) row(kid, depth, undefined, true)
    }
  }
  /** `divided`: the row sits directly under a divider that already names its kind. */
  const row = (thread: MapThread, depth: number, section: Section | undefined, divided: boolean): void => {
    const unfolded = open.has(thread.key)
    lines.push({ kind: 'thread', key: thread.key, thread, level: depth, section, open: unfolded, divided })
    if (unfolded) level(thread, depth + 1)
  }
  level(model.root, 0)
  return lines
}

/** The keys to open so that a thread shows, unfolded: every orchestrator above it, any fold that hides it, and itself. */
export function opening(model: FamilyModel, key: string, under: ReadonlyMap<string, Under> = underAll(model)): string[] {
  const keys: string[] = []
  for (let at = model.threads.get(key); at && at !== model.root; at = at.parent ? model.threads.get(at.parent) : undefined) {
    keys.push(at.key)
    if (!under.get(at.key)!.section && at.parent) keys.push(`aside:${at.parent}`)
  }
  return keys
}
