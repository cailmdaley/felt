import type { KanbanCard } from './KanbanTypes.js'
import { threadTree, type ThreadIndex, type ThreadState, type TreeNode } from './threads.js'

/** A fiber's slug: the last step of its id, as Rex's sidebar names it. */
export const slug = (card: Pick<KanbanCard, 'id'>): string => card.id.split('/').pop() ?? card.id

/** A thread in a section's outline: its depth among the rows shown, and its slug path from the nearest of them. */
export interface OutlineRow { card: KanbanCard; depth: number; path: string; parent: KanbanCard }

/**
 * The threads one Desk row holds in its section: every descendant in the
 * row's own state, each under its nearest ancestor in that state, the
 * threads between them left out and named in its slug path instead.
 * Children come in creation order.
 */
export function sectionOutline(index: ThreadIndex, row: KanbanCard, state: ThreadState = index.state(row)): OutlineRow[] {
  const rows: OutlineRow[] = []
  const walk = (node: TreeNode, shown: KanbanCard, depth: number, via: string[]): void => {
    for (const child of node.children) {
      const path = [...via, slug(child.card)]
      if (index.state(child.card) === state) {
        rows.push({ card: child.card, depth, path: path.join('/'), parent: shown })
        walk(child, child.card, depth + 1, [])
      } else walk(child, shown, depth, path)
    }
  }
  walk(threadTree(index, row), row, 0, [])
  return rows
}

/** A Desk row's own label: its name at a family's root, else its slug path from the root, a missing ancestor named by its path. */
export function rowLabel(index: ThreadIndex, card: KanbanCard): string {
  const ancestry = index.ancestry(card)
  if (!ancestry.length) return card.name
  return [...ancestry.map(step => step.card ? slug(step.card) : step.name), slug(card)].join('/')
}
