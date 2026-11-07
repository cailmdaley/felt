import { hasLiveWorker, type KanbanCard } from '../KanbanTypes.js'
import { THREAD_LABEL, threadKey, threadTree, type ThreadIndex, type TreeNode } from '../threads.js'
import { turnOf } from '../turn.js'

/** How far back a family's map reaches. */
export const MAP_WINDOW_MS = 14 * 86_400_000

/** What a thread asks of the human, most urgent first. */
export const ATTENTION = ['question', 'blocked', 'new', 'turn', 'review', 'working'] as const
export type Attention = typeof ATTENTION[number]
/** A thread's place on the map: asking, in flight with no worker running, quiet history on it, or set aside as a count. */
export type Standing = Attention | 'still' | 'quiet' | 'aside'
export const ATTENTION_WORD: Readonly<Record<Attention, string>> = {
  question: 'Questions', blocked: 'Blocked', new: 'New', turn: 'Your turn', review: 'To review', working: 'Working',
}

export interface ThreadMarks { launches: number[]; commits: number[] }
export interface MapFile { key: string; name: string; at: number; unread: boolean }
/** The facts about a thread that do not live on its card. */
export interface MapFeeds {
  marks(card: KanbanCard): ThreadMarks | undefined
  /** The thread's sent files, newest first. */
  files(card: KanbanCard): MapFile[]
}

export interface MapThread {
  key: string
  card: KanbanCard
  name: string
  depth: number
  parent: string | null
  children: string[]
  standing: Standing
  /** The state its colour says: its standing, with a new file left to the mark on top. */
  tone: Exclude<Standing, 'new'>
  /** The standing in a word or two, for a label. */
  word: string
  /** What it asks, else what it came to. */
  note: string
  /** Its place in `FamilyModel.order`; -1 when the map does not draw it. */
  rank: number
  lastMove: number
  born: number
  ended: number | null
  launches: number[]
  commits: number[]
  files: MapFile[]
  /** A sent file the human has not opened yet. */
  fresh: boolean
  /** Its work is finished and came back up to its orchestrator. */
  merged: boolean
  /** Its own mass of work and that of every thread merged into it. */
  weight: number
}

export interface FamilyModel {
  now: number
  root: MapThread
  /** Every thread of the family, in tree order. */
  threads: ReadonlyMap<string, MapThread>
  /** Every drawn thread: what asks, by urgency then newest; then what is in flight with no worker; then quiet history; then the ancestry they need. */
  order: MapThread[]
  /** The part of `order` that asks something of the human or is at work. */
  attention: MapThread[]
  /** What the map leaves out, as counts. */
  aside: { drafts: number; resting: number; archived: number }
  /** The family seen whole, as one body among others: its summed work, its newest move, its asks by kind. */
  mass: number
  lastMove: number
  counts: Record<Attention, number>
  /** The open thread, when the map holds it. */
  current: string | null
}

/** A thread's time open, to its close or to now. */
export const timeOpen = (thread: MapThread, now: number): number => Math.max(0, (thread.ended ?? now) - thread.born)
/** The card has a conversation to open: a live worker, or a past session. */
export const conversable = (card: KanbanCard): boolean => hasLiveWorker(card) || !!card.sessionUuid
export const needsHuman = (thread: MapThread): boolean => (ATTENTION as readonly string[]).includes(thread.standing) && thread.standing !== 'working'
export const isDrawn = (thread: MapThread): boolean => thread.rank >= 0
/** A thread's mass of work: its launches, commits and files. */
export const mass = (thread: MapThread): number => thread.launches.length + thread.commits.length + thread.files.length

function standingOf(card: KanbanCard, index: ThreadIndex, fresh: boolean, lastMove: number, now: number): Standing {
  const state = index.state(card), { turn, yours } = turnOf(card, now)
  if (state === 'archived') return now - lastMove < MAP_WINDOW_MS ? 'quiet' : 'aside'
  if (turn === 'question') return turn
  if (state === 'drafts' || state === 'roles' || state === 'resting') return 'aside'
  if (turn === 'blocked') return turn
  if (fresh) return 'new'
  if (state === 'to-review') return 'review'
  if (yours) return 'turn'
  return hasLiveWorker(card) ? 'working' : 'still'
}

const WORD: Partial<Record<Standing, string>> = { question: 'question', blocked: 'blocked', new: 'new file', review: 'to review', turn: 'your turn' }
/** What an in-flight thread with no worker is: held by the daemon, stopped after a run, or armed and yet to start. */
const stillWord = (card: KanbanCard): string => card.held ? 'held' : card.dispatchedAt || card.sessionUuid ? 'stopped' : 'armed'

/** The family under `root`, ready to draw: one model every drawing reads. */
export function familyModel(index: ThreadIndex, root: KanbanCard, current: KanbanCard, feeds: MapFeeds, now: number): FamilyModel {
  const threads = new Map<string, MapThread>()
  const walk = (node: TreeNode, parent: string | null): MapThread => {
    const { card, depth } = node
    const marks = feeds.marks(card), files = feeds.files(card)
    const launches = marks?.launches ?? [], commits = marks?.commits ?? []
    const ended = Date.parse(card.closedAt ?? '') || null, born = Date.parse(card.createdAt) || ended || now
    const ask = turnOf(card, now).turn === 'question' ? card.ask : undefined
    const lastMove = Math.min(now, Math.max(card.lastActivityAt ?? 0, ...launches, ...commits, ...files.map(file => file.at), ended ?? 0, born, Date.parse(ask?.at ?? '') || 0))
    const fresh = files.some(file => file.unread)
    const standing = standingOf(card, index, fresh, lastMove, now), tone = standingOf(card, index, false, lastMove, now) as MapThread['tone']
    const thread: MapThread = {
      key: threadKey(card), card, name: card.name, depth, parent, children: [], standing, tone,
      word: WORD[standing] ?? (standing === 'working' ? turnOf(card, now).word : standing === 'still' ? stillWord(card) : THREAD_LABEL[index.state(card)].toLowerCase()),
      note: ask?.text ?? card.outcome ?? '', rank: -1, lastMove, born, ended, launches, commits, files, fresh,
      merged: index.state(card) === 'archived', weight: launches.length + commits.length + files.length,
    }
    threads.set(thread.key, thread)
    for (const child of node.children) {
      const kid = walk(child, thread.key)
      thread.children.push(kid.key)
      if (kid.merged) thread.weight += kid.weight
    }
    return thread
  }
  const top = walk(threadTree(index, root), null)
  const all = [...threads.values()]
  const urgency = (thread: MapThread): number => (ATTENTION as readonly string[]).indexOf(thread.standing)
  const newest = (a: MapThread, b: MapThread): number => b.lastMove - a.lastMove || a.name.localeCompare(b.name) || a.key.localeCompare(b.key)
  const attention = all.filter(thread => urgency(thread) >= 0).sort((a, b) => urgency(a) - urgency(b) || newest(a, b))
  const still = all.filter(thread => thread.standing === 'still').sort(newest)
  const quiet = all.filter(thread => thread.standing === 'quiet').sort(newest)
  const known = new Set([...attention, ...still, ...quiet])
  const context: MapThread[] = []
  for (const thread of known) {
    for (let up = thread.parent; up !== null; up = threads.get(up)!.parent) {
      const ancestor = threads.get(up)!
      if (known.has(ancestor) || context.includes(ancestor)) break
      context.push(ancestor)
    }
  }
  if (!known.has(top) && !context.includes(top)) context.push(top)
  const order = [...attention, ...still, ...quiet, ...context]
  order.forEach((thread, rank) => { thread.rank = rank })
  const aside = { drafts: 0, resting: 0, archived: 0 }
  for (const thread of all) {
    if (thread.standing !== 'aside' || isDrawn(thread)) continue
    const state = index.state(thread.card)
    aside[state === 'drafts' ? 'drafts' : state === 'archived' ? 'archived' : 'resting']++
  }
  const own = current.uid ?? current.id
  const counts = Object.fromEntries(ATTENTION.map(kind => [kind, attention.filter(thread => thread.standing === kind).length])) as Record<Attention, number>
  return {
    now, root: top, threads, order, attention, aside, counts,
    mass: all.reduce((sum, thread) => sum + mass(thread), 0), lastMove: Math.max(...all.map(thread => thread.lastMove)),
    current: all.find(thread => (thread.card.uid ?? thread.card.id) === own)?.key ?? null,
  }
}
