import type { KanbanCard } from '../KanbanTypes.js'
import { threadRow } from '../ThreadPeek.js'
import type { ThreadIndex } from '../threads.js'

const identity = (card: KanbanCard): string => JSON.stringify([card.originId, card.uid ?? card.id])

/**
 * The phone's thread list for the open constitution: its family from the
 * root down, the threads waiting on an answer first, the open one marked.
 * Empty (null) when the constitution has no family.
 */
export function phoneThreads(card: KanbanCard, index: ThreadIndex, open: (card: KanbanCard) => void): HTMLElement | null {
  let root = index.card(card)
  for (let parent = index.parentOf(root); parent; parent = index.parentOf(parent)) root = parent
  const family = index.subtree(root)
  if (!family.length) return null
  const current = identity(index.card(card))
  const section = document.createElement('section')
  section.className = 'ws-phone-threads'
  section.setAttribute('aria-label', 'Threads')
  const row = (thread: KanbanCard): HTMLElement => {
    const button = threadRow(thread, index, open)
    if (identity(thread) === current) button.setAttribute('aria-current', 'page')
    return button
  }
  const waiting = family.filter(thread => index.state(thread) === 'waiting')
  if (waiting.length) {
    const strip = document.createElement('div')
    strip.className = 'ws-phone-threads-waiting'
    const heading = document.createElement('h3')
    heading.textContent = `Waiting · ${waiting.length}`
    strip.append(heading, ...waiting.map(row))
    section.append(strip)
  }
  const tree = (parent: KanbanCard): HTMLUListElement => {
    const list = document.createElement('ul')
    for (const child of index.children(parent)) {
      const item = document.createElement('li')
      item.append(row(child))
      if (index.size(child) > 0) item.append(tree(child))
      list.append(item)
    }
    return list
  }
  const heading = document.createElement('h3')
  heading.textContent = 'Threads'
  const rootRow = row(root)
  rootRow.classList.add('ws-phone-threads-root')
  section.append(heading, rootRow, tree(root))
  return section
}
