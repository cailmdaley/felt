import { hasLiveWorker, type KanbanCard } from '../KanbanTypes.js'
import { ascByKey, instantMs } from '../civilDay.js'
import { deskColumn } from '../deskColumn.js'
import { THREAD_LABEL, threadKey, type ThreadIndex } from '../threads.js'
import { turnOf } from '../turn.js'
import './thread-tree.css'

export interface TreeNode { card: KanbanCard; depth: number; hasLiveDescendant: boolean; children: TreeNode[] }
/** Family shape in creation order, independent of the presentation surface. */
export function threadTree(index: ThreadIndex, root: KanbanCard): TreeNode {
  const build = (card: KanbanCard, depth: number): TreeNode => {
    const sorted = [...index.children(card)].sort((a, b) => ascByKey(instantMs(a.createdAt), instantMs(b.createdAt)) || a.name.localeCompare(b.name) || threadKey(a).localeCompare(threadKey(b)))
    const children = sorted.map(child => build(child, depth + 1))
    return { card, depth, children, hasLiveDescendant: children.some(n => index.state(n.card) !== 'archived' || n.hasLiveDescendant) }
  }
  return build(root, 0)
}

export function renderThreadTree(index: ThreadIndex, root: KanbanCard, current: KanbanCard, rowFactory: (card: KanbanCard, focus: string) => HTMLElement, open: ReadonlyMap<string, boolean> = new Map()): HTMLElement[] {
  const lineage = new Set<string>()
  for (let p: KanbanCard | undefined = current; p; p = index.parentOf(p)) lineage.add(threadKey(p))
  const render = (node: TreeNode): HTMLElement[] => {
    const { card, depth } = node
    // An archived ancestor of live work remains visible as its context.
    const folded = node.children.filter(n => index.state(n.card) === 'archived' && !n.hasLiveDescendant)
    const visible = node.children.filter(n => index.state(n.card) !== 'archived' || n.hasLiveDescendant)
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
    const result = [item, ...visible.flatMap(render)]
    if (folded.length) {
      const details = document.createElement('details'); details.className = 'ws-tree-archived'; details.dataset.threadDetails = key
      details.open = folded.some(n => lineage.has(threadKey(n.card))) || (open.get(key) ?? false)
      const summary = document.createElement('summary'); summary.dataset.threadFocus = JSON.stringify(['archive', key]); summary.style.setProperty('--ws-thread-depth', String(depth + 1))
      summary.append(`${folded.length} archived`)
      details.append(summary, ...folded.flatMap(render)); result.push(details)
    }
    return result
  }
  return render(threadTree(index, root))
}
