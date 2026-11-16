import { attentionOf, wantOf, type Waits } from './attention.js'
import type { KanbanCard } from './KanbanTypes.js'
import { TURN_WORD, turnOf } from './turn.js'
import './stateDot.css'

const WORD = { waiting: 'waiting on you', working: 'working', quiet: 'quiet' } as const

/**
 * A constitution's state as one dot, the same on every index: gold while it
 * waits on the human, the agent's blue while it works (breathing while its
 * worker is mid-turn, still while idle), hollow when quiet. Its tooltip says
 * what it wants, else its worker's turn. A click opens it.
 */
export function stateDot(card: KanbanCard, waits: Waits, open: (card: KanbanCard) => void): HTMLButtonElement {
  const attention = attentionOf(card, waits), want = wantOf(card, waits), turn = turnOf(card)
  const detail = want ? want.text : attention === 'working' ? `${TURN_WORD[turn.turn]}: ${turn.detail}` : WORD.quiet
  const dot = document.createElement('button')
  dot.type = 'button'
  dot.className = 'constitution-state-dot'
  dot.dataset.attention = attention
  dot.toggleAttribute('data-busy', attention === 'working' && turn.turn === 'working')
  dot.title = detail
  dot.setAttribute('aria-label', `Open ${card.name} — ${WORD[attention]}`)
  dot.setAttribute('aria-description', detail)
  dot.addEventListener('pointerdown', event => event.stopPropagation())
  dot.addEventListener('click', event => { event.stopPropagation(); open(card) })
  return dot
}
