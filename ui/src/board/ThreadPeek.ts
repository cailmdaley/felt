import type { KanbanCard } from './KanbanTypes.js'
import { THREAD_LABEL, waitingWords, type ThreadIndex } from './threads.js'
import './threads.css'

/** A constitution-view rail row; pinning stays local to the rail. */
export function threadRow(card: KanbanCard, index: ThreadIndex, open: (card: KanbanCard) => void): HTMLButtonElement {
  const state = index.state(card)
  const row = document.createElement('button')
  row.type = 'button'; row.className = 'kbn-thread-row'; row.dataset.threadState = state
  row.dataset.cardUid = card.uid ?? card.id; row.dataset.cardOrigin = card.originId
  row.title = card.ask?.text ?? card.outcome ?? card.id
  const name = document.createElement('span'); name.className = 'kbn-thread-name'; name.textContent = card.name
  const label = document.createElement('small'); label.textContent = THREAD_LABEL[state]
  const outcome = document.createElement('span'); outcome.className = 'kbn-thread-outcome'
  outcome.textContent = card.ask?.text ?? card.outcome ?? ''
  row.append(name, label, outcome)
  const waiting = waitingNote(card); if (waiting) name.after(waiting)
  row.classList.toggle('kbn-thread-pinned', isPinned(card))
  row.addEventListener('click', event => { event.stopPropagation(); open(card) })
  row.addEventListener('pointerdown', event => event.stopPropagation())
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
export function requestThreadPin(from: EventTarget, card: KanbanCard): void {
  from.dispatchEvent(new CustomEvent<ThreadPinRequest>(THREAD_PIN, { bubbles: true, composed: true, detail: { card, pinned: !isPinned(card) } }))
}

const PIN_PATH = 'M9.5 1.5 14.5 6.5 12.6 7.1 10.4 9.3 10.6 12.6 9.4 13.8 6.6 11 3.2 14.4 1.6 14.4 1.6 12.8 5 9.4 2.2 6.6 3.4 5.4 6.7 5.6 8.9 3.4Z'
export function threadItem(card: KanbanCard, index: ThreadIndex, open: (card: KanbanCard) => void, focus: string): HTMLElement {
  const item = document.createElement('div'); item.className = 'kbn-thread-item'
  const row = threadRow(card, index, open); row.dataset.threadFocus = focus
  const pinned = isPinned(card)
  const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'kbn-thread-pin'
  pin.dataset.threadFocus = JSON.stringify([focus, 'pin'])
  pin.setAttribute('aria-pressed', String(pinned))
  pin.title = pinned ? `Unpin ${card.name}` : `Pin ${card.name}`
  pin.setAttribute('aria-label', pin.title); pin.tabIndex = -1
  pin.innerHTML = `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="${PIN_PATH}"/></svg>`
  pin.addEventListener('click', event => { event.stopPropagation(); requestThreadPin(pin, card) })
  pin.addEventListener('pointerdown', event => event.stopPropagation())
  item.append(row, pin)
  return item
}
