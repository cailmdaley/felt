import type { KanbanCard } from '../KanbanTypes.js'
import type { ThreadIndex } from '../threads.js'
import { cardIdentity } from './SidebarFlight.js'
import { threadTree, type TreeNode } from './ThreadTree.js'

export type Fold = 'collapsed' | 'more' | 'working'
export type SidebarFolds = Record<string, Partial<Record<Fold, boolean>>>
export const SIDEBAR_STORAGE = 'shuttle.sidebar.tree'
export const rootIdentity = (card: KanbanCard): string => card.uid ?? cardIdentity(card)
export interface SidebarFamily {
  root: KanbanCard
  asks: KanbanCard[]
  working: Array<{ card: KanbanCard; depth: number }>
  rows: KanbanCard[]
  expandable: boolean
  folded: boolean
  more: number
}

/** Optional browser storage; revealing a page never writes a fold preference. */
export class SidebarPreferences {
  readonly folds: SidebarFolds
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null
  constructor(storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
    this.storage = storage
    let folds: SidebarFolds = {}
    try {
      const value: unknown = JSON.parse(storage?.getItem(SIDEBAR_STORAGE) ?? '{}')
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, row] of Object.entries(value)) {
          if (!row || typeof row !== 'object' || Array.isArray(row)) continue
          folds[key] = Object.fromEntries(Object.entries(row).filter(([key, value]) => ['collapsed', 'more', 'working'].includes(key) && typeof value === 'boolean'))
        }
      }
    } catch { /* Storage is optional. */ }
    this.folds = folds
  }
  toggle(root: KanbanCard, fold: Fold): void {
    const key = rootIdentity(root), row = this.folds[key] ??= {}
    row[fold] = !row[fold]
    try { this.storage?.setItem(SIDEBAR_STORAGE, JSON.stringify(this.folds)) } catch { /* Storage is optional. */ }
  }
}

/** Roots retain Desk order; each expanded family exposes asks before its folded work. */
export function sidebarOutline(index: ThreadIndex, desk: KanbanCard[], current: KanbanCard | undefined, folds: SidebarFolds, query = ''): SidebarFamily[] {
  const roots = new Map<string, KanbanCard>()
  for (const card of [...desk, ...(current ? [current] : [])]) {
    const root = index.family(index.card(card)).root
    roots.set(rootIdentity(root), root)
  }
  return [...roots.values()].map(root => {
    const descendants = index.subtree(root)
    const asks = descendants.filter(card => ['waiting', 'to-review'].includes(index.state(card))).sort(index.compare)
    const nodes: TreeNode[] = [], pending = [threadTree(index, root)]
    while (pending.length) {
      const node = pending.pop()!
      nodes.push(node)
      pending.push(...node.children.slice().reverse())
    }
    const containsWork = new Set<TreeNode>()
    for (let n = nodes.length - 1; n >= 0; n--) {
      const node = nodes[n]
      if (index.state(node.card) === 'working' || node.children.some(child => containsWork.has(child))) containsWork.add(node)
    }
    const working = nodes.filter(node => node.card !== root && containsWork.has(node)).map(({ card, depth }) => ({ card, depth }))
    const state = folds[rootIdentity(root)] ?? {}, folded = state.collapsed ?? false
    let rows = [root]
    if (query) rows.push(...descendants.filter(card => index.state(card) !== 'archived'))
    else if (!folded) {
      rows.push(...(state.more ? asks : asks.slice(0, 3)))
      if (state.working) rows.push(...working.map(row => row.card))
    }
    if (current && rootIdentity(index.family(current).root) === rootIdentity(root) && !rows.some(card => cardIdentity(card) === cardIdentity(current))) rows.push(current)
    rows = [...new Map(rows.map(card => [cardIdentity(card), card])).values()]
    return { root, asks, working, rows, folded, expandable: !!(asks.length || working.length), more: Math.max(0, asks.length - 3) }
  })
}
