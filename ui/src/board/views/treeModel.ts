import type { KanbanCard } from '../KanbanTypes.js'
import { familyModel, type MapFeeds, type MapFile, type MapThread } from '../family/model.js'
import type { ThreadIndex } from '../threads.js'
import { fiberKey } from '../workspace/documents.js'

/** What sits under a row and is told on it while it is folded, most urgent first. */
export const ROLLUP_KINDS = ['question', 'fresh', 'turn', 'review', 'working'] as const
export type RollupKind = typeof ROLLUP_KINDS[number]
export type Rollup = Record<RollupKind, number>
export type TreeShelf = 'drafts' | 'resting' | 'archived' | 'files'
export type TreeFileRole = 'tapestry' | 'sent' | 'constitution'

/**
 * One row's worth of the tree. A group is a stretch of fiber path no card
 * stands on; a thread is a card; a fold gathers a parent's drafts, resting or
 * archived threads, or the files of a thread with threads of its own; a file
 * opens on the stage.
 */
export interface TreeItem {
  key: string
  kind: 'group' | 'thread' | 'fold' | 'file'
  name: string
  parent: TreeItem | null
  children: TreeItem[]
  /** Its newest move, its subtree's included. */
  at: number
  /** In play at it or under it. */
  live: boolean
  /** What is under it, itself not counted. */
  rollup: Rollup
  threads: number
  files: number
  thread?: MapThread
  /** The thread a file belongs to. */
  card?: KanbanCard
  file?: MapFile
  role?: TreeFileRole
  shelf?: TreeShelf
}

export interface TreeFeeds {
  /** A thread's sent files, newest first. */
  files(card: KanbanCard): MapFile[]
  /** Its tapestry or report, once read. */
  lead(card: KanbanCard): MapFile | undefined
}

const SHELF_NAME: Readonly<Record<TreeShelf, string>> = { drafts: 'Drafts', resting: 'Resting', archived: 'Archived', files: 'Files' }
const SHELVES = ['drafts', 'resting', 'archived'] as const

const blank = (key: string, kind: TreeItem['kind'], name: string, at = 0): TreeItem => ({
  key, kind, name, parent: null, children: [], at, live: false, threads: 0, files: 0,
  rollup: { question: 0, fresh: 0, turn: 0, review: 0, working: 0 },
})

/** The kind a thread adds to the rollups above it, if it asks or works. */
function rollupKind(thread: MapThread): RollupKind | null {
  if (thread.tone === 'question' || thread.tone === 'blocked') return 'question'
  return thread.tone === 'turn' || thread.tone === 'review' || thread.tone === 'working' ? thread.tone : null
}
/** Asking, under review, at work, or in flight with its worker gone. */
const inPlay = (thread: MapThread): boolean => rollupKind(thread) !== null || thread.tone === 'still'

function shelfOf(index: ThreadIndex, thread: MapThread): Exclude<TreeShelf, 'files'> {
  const state = index.state(thread.card)
  return state === 'archived' ? 'archived' : state === 'drafts' ? 'drafts' : 'resting'
}

function fileRow(thread: MapThread, file: MapFile, role: TreeFileRole): TreeItem {
  return { ...blank(`file\u0000${thread.key}\u0000${file.key}`, 'file', file.name, file.at), file, role, card: thread.card }
}

function fold(parent: TreeItem, shelf: TreeShelf, children: TreeItem[]): TreeItem {
  return { ...blank(`fold\u0000${parent.key}\u0000${shelf}`, 'fold', SHELF_NAME[shelf]), shelf, children, parent }
}

/** A thread's files and threads as it shows them: tapestry, sent files, then threads and folds, the constitution last. */
function arrange(node: TreeItem, subs: TreeItem[], index: ThreadIndex, lead: MapFile | undefined): TreeItem[] {
  const thread = node.thread
  const main = subs.filter(sub => sub.kind === 'group' || sub.live)
    .sort((a, b) => Number(b.kind === 'group') - Number(a.kind === 'group') || (a.kind === 'group' ? a.name.localeCompare(b.name) : b.thread!.born - a.thread!.born || a.name.localeCompare(b.name)))
  const shelves = SHELVES.flatMap(shelf => {
    const children = subs.filter(sub => sub.thread && !sub.live && shelfOf(index, sub.thread) === shelf).sort((a, b) => b.at - a.at)
    return children.length ? [fold(node, shelf, children)] : []
  })
  const threads = main.length > 0 || shelves.length > 0
  const leading = thread && lead ? [fileRow(thread, lead, 'tapestry')] : []
  const sent = thread ? thread.files.filter(file => file.key !== lead?.key).map(file => fileRow(thread, file, 'sent')) : []
  const constitution = thread ? [fileRow(thread, { key: fiberKey(thread.card.originId, thread.card.uid ?? thread.card.id), name: 'Constitution', at: 0, unread: false }, 'constitution')] : []
  const folded = threads && sent.length > 0
  const body = !main.length && shelves.length === 1 && !leading.length && !sent.length ? shelves[0].children : [...main, ...shelves]
  return [...leading, ...(folded ? [fold(node, 'files', [...sent, ...constitution])] : sent), ...body, ...(folded ? [] : constitution)]
}

/** Sums what is under a row into it. */
function total(node: TreeItem): void {
  for (const child of node.children) {
    node.at = Math.max(node.at, child.at)
    if (child.kind === 'file') { if (child.role !== 'constitution') node.files++; continue }
    node.threads += child.threads + (child.thread ? 1 : 0)
    node.files += child.files
    for (const kind of Object.keys(node.rollup) as RollupKind[]) node.rollup[kind] += child.rollup[kind]
    const kind = child.thread && rollupKind(child.thread)
    if (kind) node.rollup[kind]++
    if (child.thread?.fresh) node.rollup.fresh++
  }
}

/**
 * Every card on the board as one tree. A thread hangs from its orchestrator.
 * A family's root hangs from the nearest card along its fiber path, else from
 * groups named by the path; a group holding one thing gives way to it.
 * In-play threads stand in their parent, the others go to its folds, and a
 * parent with nothing else to show has no need of a fold. Places are stable:
 * groups by name, then threads newest-born first, and folds by newest move.
 */
export function buildTree(index: ThreadIndex, cards: readonly KanbanCard[], feeds: TreeFeeds, now: number): TreeItem {
  const top = blank('top', 'group', '')
  const onPath = new Map<string, TreeItem>()
  const families = new Map<KanbanCard, TreeItem>()
  const familyOf = new Map<TreeItem, TreeItem>()
  const mapFeeds: MapFeeds = { marks: () => undefined, files: feeds.files }
  for (const card of cards) {
    const root = index.family(index.card(card)).root
    if (families.has(root)) continue
    const model = familyModel(index, root, root, mapFeeds, now)
    const grow = (thread: MapThread): TreeItem => {
      const node: TreeItem = { ...blank(thread.key, 'thread', thread.name, thread.lastMove), thread, live: inPlay(thread) }
      if (!onPath.has(thread.card.id)) onPath.set(thread.card.id, node)
      node.children = thread.children.map(key => grow(model.threads.get(key)!))
      return node
    }
    const family = grow(model.root)
    families.set(root, family)
    const claim = (node: TreeItem): void => { familyOf.set(node, family); node.children.forEach(claim) }
    claim(family)
  }
  const groups = new Map<string, TreeItem>()
  const group = (segments: readonly string[]): TreeItem => {
    if (!segments.length) return top
    const path = segments.join('/')
    let node = groups.get(path)
    if (!node) {
      node = blank(`group\u0000${path}`, 'group', segments.at(-1)!)
      groups.set(path, node)
      group(segments.slice(0, -1)).children.push(node)
    }
    return node
  }
  const hangs = new Map<TreeItem, TreeItem>()
  const reaches = (from: TreeItem, sought: TreeItem): boolean => {
    for (let up: TreeItem | undefined = from; up; up = hangs.get(up)) if (up === sought) return true
    return false
  }
  for (const family of families.values()) {
    const segments = family.thread!.card.id.split('/')
    let parent: TreeItem | undefined
    for (let n = segments.length - 1; n > 0 && !parent; n--) {
      const near = onPath.get(segments.slice(0, n).join('/'))
      // A root may sit on the path of its own thread, or of a family already hanging from it.
      if (near && !reaches(familyOf.get(near)!, family)) { parent = near; hangs.set(family, familyOf.get(near)!) }
    }
    ;(parent ?? group(segments.slice(0, -1))).children.push(family)
  }
  const finish = (node: TreeItem): TreeItem => {
    const subs = node.children.map(finish)
    node.live ||= subs.some(sub => sub.live)
    if (node.kind === 'group' && node !== top && subs.length === 1) {
      const [only] = subs
      if (only.kind === 'group') only.name = `${node.name}/${only.name}`
      return only
    }
    node.children = arrange(node, subs, index, node.thread && feeds.lead(node.thread.card))
    for (const child of node.children) {
      child.parent = node
      if (child.kind === 'fold') { for (const held of child.children) held.parent = child; total(child) }
    }
    total(node)
    return node
  }
  return finish(top)
}

export interface TreeRow {
  item: TreeItem
  level: number
  pos: number
  size: number
  /** Null for a row with nothing under it. */
  open: boolean | null
}

/** Open while it holds something live, until a hand says otherwise. */
export const openByDefault = (node: TreeItem): boolean => node.children.some(child => child.live)

const haystack = (node: TreeItem): string => (node.thread ? `${node.name} ${node.thread.card.id}` : node.name).toLowerCase()

/** The rows on the page: what is open, or, under a query, what matches and the way to it. */
export function visibleRows(top: TreeItem, isOpen: (node: TreeItem) => boolean, query = ''): TreeRow[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = new Set<TreeItem>()
  const search = (node: TreeItem): boolean => {
    const below = node.children.map(search).some(Boolean)
    const hit = below || (node !== top && terms.every(term => haystack(node).includes(term)))
    if (hit) shown.add(node)
    return hit
  }
  if (terms.length) search(top)
  const rows: TreeRow[] = []
  const walk = (node: TreeItem, level: number): void => {
    const children = terms.length ? node.children.filter(child => shown.has(child)) : node.children
    children.forEach((child, n) => {
      const open = terms.length
        ? child.children.some(grand => shown.has(grand)) || null
        : child.children.length ? isOpen(child) : null
      rows.push({ item: child, level, pos: n + 1, size: children.length, open })
      if (open) walk(child, level + 1)
    })
  }
  walk(top, 1)
  return rows
}

/** From the top down to the row, the folds it passes through left out. */
export function pathTo(node: TreeItem): TreeItem[] {
  const path: TreeItem[] = []
  for (let up: TreeItem | null = node; up?.parent; up = up.parent) if (up === node || up.kind !== 'fold') path.unshift(up)
  return path
}
