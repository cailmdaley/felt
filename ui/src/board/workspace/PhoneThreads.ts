import type { KanbanCard } from '../KanbanTypes.js'
import { threadRow } from '../ThreadPeek.js'
import type { ThreadIndex } from '../threads.js'
import { THREAD_GROUPS, threadGroup } from './threadGroups.js'

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
  if (identity(root) !== current) {
    const rootRow = row(root)
    rootRow.classList.add('ws-phone-threads-root')
    section.append(rootRow)
  }
  for (const [key, label] of THREAD_GROUPS) {
    const members = family.filter(thread => threadGroup(thread) === key)
    if (!members.length) continue
    const group = document.createElement('section')
    group.dataset.group = key
    const heading = document.createElement('h3'); heading.textContent = `${label} · ${members.length}`
    group.append(heading, ...members.map(row)); section.append(group)
  }
  return section
}
