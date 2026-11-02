import { hasLiveWorker, type KanbanCard } from '../KanbanTypes.js'
import { ascByKey, instantMs } from '../civilDay.js'
import { deskColumn } from '../deskColumn.js'
import { THREAD_LABEL, threadKey, type ThreadIndex } from '../threads.js'
import { turnOf } from '../turn.js'
import './thread-tree.css'

export interface TreeNode { card: KanbanCard; depth: number; hasActiveDescendant: boolean; children: TreeNode[] }
/** Where a thread is drawn: in the tree while it is in play, else below it with the resting or the archived. */
export type Shelf = 'tree' | 'resting' | 'archived'
export function shelfOf(index: ThreadIndex, card: KanbanCard): Shelf {
  const state = index.state(card)
  return state === 'archived' ? 'archived' : state === 'resting' || state === 'roles' ? 'resting' : 'tree'
}
/** Family shape in creation order, independent of the presentation surface. */
export function threadTree(index: ThreadIndex, root: KanbanCard): TreeNode {
  const build = (card: KanbanCard, depth: number): TreeNode => {
    const sorted = [...index.children(card)].sort((a, b) => ascByKey(instantMs(a.createdAt), instantMs(b.createdAt)) || a.name.localeCompare(b.name) || threadKey(a).localeCompare(threadKey(b)))
    const children = sorted.map(child => build(child, depth + 1))
    return { card, depth, children, hasActiveDescendant: children.some(n => shelfOf(index, n.card) === 'tree' || n.hasActiveDescendant) }
  }
  return build(root, 0)
}

/**
 * The family as drawn: the root, then a tree of the threads in play (a resting
 * or archived thread stays in it only as the context of work beneath it), then
 * the other resting threads, then the other archived ones folded. Both shelves
 * list in tree order.
 */
export function renderThreadTree(index: ThreadIndex, root: KanbanCard, current: KanbanCard, rowFactory: (card: KanbanCard, focus: string) => HTMLElement, open: ReadonlyMap<string, boolean> = new Map()): HTMLElement[] {
  const shelved: Record<'resting' | 'archived', KanbanCard[]> = { resting: [], archived: [] }
  const draw = (card: KanbanCard, depth: number): HTMLElement => {
    const key = threadKey(card), focus = JSON.stringify(['row', key])
    const item = rowFactory(card, focus), row = item.matches('.kbn-thread-row') ? item : item.querySelector<HTMLElement>('.kbn-thread-row')!
    item.style.setProperty('--ws-thread-depth', String(depth)); item.dataset.depth = String(depth)
    row.dataset.threadFocus = focus
    row.setAttribute('aria-level', String(depth + 1))
    const state = index.state(card), kind = state === 'roles' ? 'resting' : state === 'working' && !hasLiveWorker(card) ? 'armed' : state
    const label = kind === 'armed' ? 'Armed' : THREAD_LABEL[kind]
    const turn = turnOf(card).turn
    const substate = state === 'waiting' && turn === 'question' ? ['?', 'Your question'] : state === 'waiting' && turn === 'blocked' ? ['!', 'Blocked'] : state === 'archived' && deskColumn(card) === 'composted' ? ['×', 'Discarded'] : null
    row.setAttribute('aria-label', `${card.name}, ${label}${substate ? `, ${substate[1]}` : ''}`)
    const mark = document.createElement('span'); mark.className = 'ws-tree-state'; mark.dataset.state = kind; mark.textContent = label
    if (substate) { const suffix = document.createElement('span'); suffix.textContent = ` ${substate[0]}`; suffix.title = substate[1]; mark.append(suffix) }
    row.append(mark)
    if (key === threadKey(current)) { row.classList.add('ws-thread-current'); row.setAttribute('aria-current', 'page') }
    return item
  }
  const grow = (node: TreeNode): HTMLElement[] => {
    const rows = [draw(node.card, node.depth)]
    for (const child of node.children) {
      const shelf = shelfOf(index, child.card)
      if (shelf === 'tree' || child.hasActiveDescendant) rows.push(...grow(child))
      else shelve(child)
    }
    return rows
  }
  const shelve = (node: TreeNode): void => {
    const shelf = shelfOf(index, node.card)
    shelved[shelf === 'tree' ? 'resting' : shelf].push(node.card)
    for (const child of node.children) shelve(child)
  }
  const result = grow(threadTree(index, root))
  for (const [shelf, cards] of [['resting', shelved.resting], ['archived', shelved.archived]] as const) {
    if (!cards.length) continue
    const details = document.createElement('details'); details.className = `ws-tree-shelf ws-tree-${shelf}`; details.dataset.threadDetails = shelf
    details.open = cards.some(c => threadKey(c) === threadKey(current)) || (open.get(shelf) ?? shelf === 'resting')
    const summary = document.createElement('summary'); summary.dataset.threadFocus = JSON.stringify(['shelf', shelf])
    summary.append(shelf === 'resting' ? `${cards.length} resting` : `${cards.length} archived`)
    details.append(summary, ...cards.map(card => draw(card, 0))); result.push(details)
  }
  return result
}
