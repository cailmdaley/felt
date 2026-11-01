import { hasLiveWorker, type KanbanCard } from '../KanbanTypes.js'
import { deskColumn } from '../deskColumn.js'
import { threadKey, type ThreadIndex } from '../threads.js'
import { turnOf } from '../turn.js'
import './thread-tree.css'

export type Attention = 'waiting' | 'to-review' | null
export interface TreeNode { card: KanbanCard; depth: number; attention: Attention; children: TreeNode[] }
const urgent = (a: Attention, b: Attention): Attention => a === 'waiting' || b === 'waiting' ? 'waiting' : a || b
const attentionOf = (index: ThreadIndex, card: KanbanCard): Attention => {
  const state = index.state(card)
  return state === 'waiting' || state === 'to-review' ? state : null
}
/** Family shape and subtree attention, independent of the presentation surface. */
export function threadTree(index: ThreadIndex, root: KanbanCard): TreeNode {
  const build = (card: KanbanCard, depth: number): TreeNode => {
    const sorted = [...index.children(card)].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name) || threadKey(a).localeCompare(threadKey(b)))
    const children = sorted.map(child => build(child, depth + 1))
    const attention = children.reduce<Attention>((a, n) => urgent(a, urgent(attentionOf(index, n.card), n.attention)), null)
    return { card, depth, attention, children }
  }
  return build(root, 0)
}
const labels: Record<string, string> = { waiting: 'Waiting', 'to-review': 'To review', working: 'Working', armed: 'Armed', drafts: 'Drafts', resting: 'Resting', archived: 'Archived' }
const mark = (kind: string, text: string, bubbled = false): HTMLElement => {
  const el = document.createElement('span'); el.className = bubbled ? 'ws-tree-attention' : 'ws-tree-state'; el.dataset.state = kind; el.textContent = text
  return el
}
export function renderThreadTree(index: ThreadIndex, root: KanbanCard, current: KanbanCard, rowFactory: (card: KanbanCard, focus: string) => HTMLElement, open: ReadonlyMap<string, boolean> = new Map(), arriving = true): HTMLElement[] {
  const lineage = new Set<string>()
  for (let p: KanbanCard | undefined = current; p; p = index.parentOf(p)) lineage.add(threadKey(p))
  const render = (node: TreeNode): HTMLElement[] => {
    const { card, depth, attention } = node
    const children = node.children.filter(n => index.state(n.card) !== 'archived')
    const archived = node.children.filter(n => index.state(n.card) === 'archived')
    const key = threadKey(card), focus = JSON.stringify(['row', key])
    const item = rowFactory(card, focus), row = item.matches('.kbn-thread-row') ? item : item.querySelector<HTMLElement>('.kbn-thread-row')!
    item.style.setProperty('--ws-thread-depth', String(depth)); item.dataset.depth = String(depth)
    row.dataset.threadFocus = focus
    const state = index.state(card), kind = state === 'roles' ? 'resting' : state === 'working' && !hasLiveWorker(card) ? 'armed' : state
    const turn = turnOf(card).turn
    const suffix = state === 'waiting' && turn === 'question' ? ' ?' : state === 'waiting' && turn === 'blocked' ? ' !' : state === 'archived' && deskColumn(card) === 'composted' ? ' ×' : ''
    if (attention && urgent(attentionOf(index, card), attention) !== attentionOf(index, card)) {
      const bubble = mark(attention, '•', true); bubble.title = `Descendant: ${labels[attention]}`; bubble.setAttribute('aria-label', bubble.title); row.append(bubble)
    }
    row.append(mark(kind, labels[kind] + suffix))
    if (key === threadKey(current)) { row.classList.add('ws-thread-current'); row.setAttribute('aria-current', 'page') }
    const result = [item, ...children.flatMap(render)]
    if (archived.length) {
      const details = document.createElement('details'); details.className = 'ws-tree-archived'; details.dataset.threadDetails = key
      details.open = (arriving && archived.some(n => lineage.has(threadKey(n.card)))) || (open.get(key) ?? false)
      const summary = document.createElement('summary'); summary.dataset.threadFocus = JSON.stringify(['archive', key]); summary.style.setProperty('--ws-thread-depth', String(depth + 1))
      summary.append(`${archived.length} archived`)
      const folded = archived.reduce<Attention>((a, n) => urgent(a, urgent(attentionOf(index, n.card), n.attention)), null)
      if (folded) summary.append(mark(folded, labels[folded], true))
      details.append(summary, ...archived.flatMap(render)); result.push(details)
    }
    return result
  }
  return render(threadTree(index, root))
}
