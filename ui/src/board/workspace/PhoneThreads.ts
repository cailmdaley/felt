import type { KanbanCard } from '../KanbanTypes.js'
import { threadRow } from '../ThreadPeek.js'
import { threadKey, type ThreadIndex } from '../threads.js'
import { renderThreadTree } from './ThreadTree.js'

/** The phone's family tree, retaining disclosures across sheet openings and repaints. */
export class PhoneThreads {
  private section: HTMLElement | null = null
  private readonly openFolds = new Map<string, boolean>()
  private revealed = ''
  private signature = ''

  render(card: KanbanCard, index: ThreadIndex, open: (card: KanbanCard) => void): HTMLElement | null {
    for (const fold of this.section?.querySelectorAll<HTMLDetailsElement>('details[data-thread-details]') ?? []) {
      this.openFolds.set(fold.dataset.threadDetails!, fold.open)
    }
    card = index.card(card)
    let root = card
    for (let parent = index.parentOf(root); parent; parent = index.parentOf(parent)) root = parent
    if (!index.children(root).length) { this.section = null; this.signature = ''; return null }
    const visit = JSON.stringify([threadKey(root), threadKey(card)])
    const signature = JSON.stringify([visit, root, ...index.subtree(root)])
    if (signature === this.signature && this.section) return this.section
    this.signature = signature
    const arriving = visit !== this.revealed
    this.revealed = visit
    const section = document.createElement('section')
    section.className = 'ws-phone-threads'
    section.setAttribute('aria-label', 'Threads')
    section.append(...renderThreadTree(index, root, card, (thread, focus) => {
      const row = threadRow(thread, index, open)
      row.querySelector<HTMLElement>('.constitution-state-dot')!.dataset.threadFocus = JSON.stringify([focus, 'dot'])
      return row
    }, this.openFolds))
    this.section = section
    if (arriving && threadKey(card) !== threadKey(root)) requestAnimationFrame(() => {
      if (section.isConnected) section.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest' })
    })
    return section
  }
}
