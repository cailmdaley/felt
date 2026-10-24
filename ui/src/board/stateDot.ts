import type { KanbanCard } from './KanbanTypes.js'
import { turnOf } from './turn.js'
import './stateDot.css'

/** The same state and chat target on every constitution index. */
export function stateDot(card: KanbanCard, open: (card: KanbanCard) => void): HTMLButtonElement {
  const turn = turnOf(card)
  const dot = document.createElement('button')
  dot.type = 'button'
  dot.className = 'constitution-state-dot'
  dot.dataset.turn = turn.turn
  dot.setAttribute('aria-label', `Open ${card.name} — ${turn.word}`)
  dot.addEventListener('pointerdown', event => event.stopPropagation())
  dot.addEventListener('click', event => { event.stopPropagation(); open(card) })
  return dot
}
