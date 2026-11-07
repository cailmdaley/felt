import type { KanbanCard } from './KanbanTypes.js'
import { waitingWords, type ThreadIndex } from './threads.js'
import { stateDot } from './stateDot.js'
import './threads.css'

/** A row of the family page; pinning stays local to the page. */
export function threadRow(card: KanbanCard, index: ThreadIndex, open: (card: KanbanCard) => void): HTMLDivElement {
  const state = index.state(card)
  const row = document.createElement('div')
  row.className = 'kbn-thread-row'; row.dataset.threadState = state
  row.tabIndex = 0; row.setAttribute('role', 'link')
  row.dataset.cardUid = card.uid ?? card.id; row.dataset.cardOrigin = card.originId
  row.title = index.ancestryTitle(card) || card.name
  const name = document.createElement('span'); name.className = 'kbn-thread-name'; name.textContent = card.name
  row.append(stateDot(card, open), name)
  row.classList.toggle('kbn-thread-pinned', isPinned(card))
  row.addEventListener('click', event => { event.stopPropagation(); open(card) })
  row.addEventListener('pointerdown', event => event.stopPropagation())
  row.addEventListener('keydown', event => {
    if (event.target === row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(card) }
  })
  return row
}

/** Messages waiting for the next worker, distinct from a human turn. */
export function waitingNote(card: Pick<KanbanCard, 'pendingResults'>): HTMLElement | null {
  const n = card.pendingResults ?? 0
  if (n <= 0) return null
  const el = document.createElement('span'); el.className = 'kbn-waiting'
  el.textContent = `${n} waiting`; el.title = waitingWords(n)
  return el
}

export const PINNED_TAG = 'pinned'
export const isPinned = (card: Pick<KanbanCard, 'tags'>): boolean => card.tags?.includes(PINNED_TAG) ?? false
export const THREAD_PIN = 'shuttle-thread-pin'
export interface ThreadPinRequest { card: KanbanCard; pinned: boolean }
