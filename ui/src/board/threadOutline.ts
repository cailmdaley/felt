import { hasLiveWorker, type KanbanCard } from './KanbanTypes.js'
import { THREAD_LABEL, shelfOf, threadKey, threadTree, type ThreadIndex, type TreeNode } from './threads.js'
import { turnOf } from './turn.js'

/** What a hand last did to one node: shut it, or asked for all its threads rather than those that need you. */
export interface Fold { collapsed?: boolean; all?: boolean }

export interface Outline {
  index: ThreadIndex
  root: KanbanCard
  /** The row the outline hangs from, marked where it appears inside. */
  current: KanbanCard
  /** Threads the outline opens on by default. */
  needs(card: KanbanCard): boolean
  fold(card: KanbanCard): Fold
  setFold(card: KanbanCard, fold: Fold): void
  /** A thread's row, without its caret. */
  row(card: KanbanCard): HTMLElement
}

/**
 * A family's threads as an outline, every node that has threads of its own
 * folding on its own caret. A node stands open, unless a hand shut it, when a
 * thread beneath it needs you; its own need shows on its own row. Open, it
 * shows the children on the way to what needs you and a quiet "n more" for
 * the rest, or every child when none needs you or the hand asked for them all.
 * Resting children follow those in play. Archived threads are drawn only as
 * the way to live work beneath them. Shutting a node forgets its "all", so it
 * reopens on what needs you.
 */
export function renderOutline(o: Outline, redraw: () => void): HTMLElement[] {
  const needy = new Map<TreeNode, boolean>()
  const mark = (node: TreeNode): boolean => {
    let any = o.needs(node.card)
    for (const child of node.children) any = mark(child) || any
    needy.set(node, any)
    return any
  }
  const tree = threadTree(o.index, o.root)
  mark(tree)
  const live = (node: TreeNode): TreeNode[] => {
    const kids = node.children.filter(child => shelfOf(o.index, child.card) !== 'archived' || child.hasActiveDescendant)
    const inPlay = (child: TreeNode) => shelfOf(o.index, child.card) === 'tree' || child.hasActiveDescendant
    return [...kids.filter(inPlay), ...kids.filter(child => !inPlay(child))]
  }
  const below = (node: TreeNode): boolean => node.children.some(child => needy.get(child))
  const rows: HTMLElement[] = []
  const grow = (node: TreeNode, depth: number): void => {
    const kids = live(node), fold = o.fold(node.card)
    const shown = fold.all || !below(node) ? kids : kids.filter(child => needy.get(child))
    for (const child of shown) {
      const grandkids = live(child).length
      const item = draw(child.card, depth, grandkids ? expanded(child) : null)
      rows.push(item)
      if (grandkids && expanded(child)) grow(child, depth + 1)
    }
    if (shown.length < kids.length) {
      const more = document.createElement('button'); more.type = 'button'; more.className = 'kbn-thread-more'
      more.style.setProperty('--ws-thread-depth', String(depth)); more.dataset.depth = String(depth)
      more.dataset.threadFocus = JSON.stringify(['more', threadKey(node.card)])
      more.textContent = `${kids.length - shown.length} more`
      more.addEventListener('click', event => { event.stopPropagation(); o.setFold(node.card, { ...fold, all: true }); redraw() })
      rows.push(more)
    }
  }
  const expanded = (node: TreeNode): boolean => {
    const { collapsed } = o.fold(node.card)
    return collapsed === undefined ? below(node) : !collapsed
  }
  const draw = (card: KanbanCard, depth: number, open: boolean | null): HTMLElement => {
    const key = threadKey(card), row = o.row(card)
    row.style.setProperty('--ws-thread-depth', String(depth)); row.dataset.depth = String(depth)
    row.dataset.threadFocus = JSON.stringify(['row', key])
    row.setAttribute('aria-level', String(depth + 1))
    const state = o.index.state(card), kind = state === 'roles' ? 'resting' : state === 'working' && !hasLiveWorker(card) ? 'armed' : state
    const turn = turnOf(card).turn
    const substate = state === 'waiting' && turn === 'question' ? ', Your question' : state === 'waiting' && turn === 'blocked' ? ', Blocked' : ''
    row.setAttribute('aria-label', `${card.name}, ${kind === 'armed' ? 'Armed' : THREAD_LABEL[kind]}${substate}`)
    if (key === threadKey(o.current)) { row.classList.add('ws-thread-current'); row.setAttribute('aria-current', 'true') }
    const caret = document.createElement(open === null ? 'span' : 'button'); caret.className = 'kbn-thread-fold'
    if (open !== null) {
      const button = caret as HTMLButtonElement
      button.type = 'button'
      button.dataset.threadFocus = JSON.stringify(['fold', key])
      button.setAttribute('aria-expanded', String(open))
      button.setAttribute('aria-label', `${open ? 'Fold' : 'Unfold'} the threads of ${card.name}`)
      button.addEventListener('click', event => { event.stopPropagation(); o.setFold(card, open ? { collapsed: true } : { collapsed: false }); redraw() })
      button.addEventListener('pointerdown', event => event.stopPropagation())
    }
    row.prepend(caret)
    return row
  }
  grow(tree, 0)
  return rows
}

/** Whether the outline stands open at its root. */
export function outlineOpen(o: Pick<Outline, 'index' | 'root' | 'needs' | 'fold'>): boolean {
  const { collapsed } = o.fold(o.root)
  return collapsed === undefined ? o.index.subtree(o.root).some(card => o.needs(card)) : !collapsed
}
