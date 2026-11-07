import { hasLiveWorker, type KanbanCard } from '../KanbanTypes.js'
import { deskColumn } from '../deskColumn.js'
import { THREAD_LABEL, shelfOf, threadKey, threadTree, type ThreadIndex, type TreeNode } from '../threads.js'
import { turnOf } from '../turn.js'
import './thread-tree.css'

export interface ThreadTreeOptions {
  /** Which shelves stand open; resting opens and archived folds unless told. */
  open?: ReadonlyMap<string, boolean>
  /** Draws only these threads, each with its ancestors for context, and no shelves. */
  only?: (card: KanbanCard) => boolean
  /** Draws the root's own row at depth 0; without it the root's threads start there. */
  withRoot?: boolean
}

/**
 * The family as drawn: the root, then a tree of the threads in play (a resting
 * or archived thread stays in it only as the context of work beneath it), then
 * the other resting threads, then the other archived ones folded. Both shelves
 * list in tree order.
 */
export function renderThreadTree(index: ThreadIndex, root: KanbanCard, current: KanbanCard, rowFactory: (card: KanbanCard, focus: string) => HTMLElement, { open = new Map(), only, withRoot = true }: ThreadTreeOptions = {}): HTMLElement[] {
  const shelved: Record<'resting' | 'archived', KanbanCard[]> = { resting: [], archived: [] }
  const lift = withRoot ? 0 : 1
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
  // With `only`, a node is drawn when it or a thread beneath it is wanted.
  const wanted = new Set<TreeNode>()
  const want = (node: TreeNode): boolean => {
    let any = !!only?.(node.card)
    for (const child of node.children) any = want(child) || any
    if (any) wanted.add(node)
    return any
  }
  const grow = (node: TreeNode): HTMLElement[] => {
    const rows = node.depth >= lift ? [draw(node.card, node.depth - lift)] : []
    for (const child of node.children) {
      if (only) { if (wanted.has(child)) rows.push(...grow(child)); continue }
      if (shelfOf(index, child.card) === 'tree' || child.hasActiveDescendant) rows.push(...grow(child))
      else shelve(child)
    }
    return rows
  }
  const shelve = (node: TreeNode): void => {
    const shelf = shelfOf(index, node.card)
    shelved[shelf === 'tree' ? 'resting' : shelf].push(node.card)
    for (const child of node.children) shelve(child)
  }
  const tree = threadTree(index, root)
  if (only) want(tree)
  const result = grow(tree)
  if (only) return result
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
