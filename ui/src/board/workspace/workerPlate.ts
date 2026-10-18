import type { KanbanCard } from '../KanbanTypes.js'
import { humanizeIdleAge } from '../utils.js'
import { turnOf, type Turn } from '../turn.js'

/**
 * What the worker pill says, on every surface: the card's turn (`turnOf`),
 * its word, and how long it has held. The age is the time since the turn
 * began: since the question was asked, since the worker stopped, or, for a
 * working worker, since its last hook event once that silence passes ten
 * minutes. `busy` breathes the dot whatever the turn.
 */
export function workerPlateFacts(card: KanbanCard, now = Date.now()): { turn: Turn; word: string; elapsed?: string; busy: boolean } {
  const { turn, word, since, busy } = turnOf(card, now)
  const elapsed = since !== undefined && Number.isFinite(since) ? humanizeIdleAge(now - since) : undefined
  return { turn, word, elapsed, busy }
}

/**
 * Decorate the real conversation target, never a second opening mechanism:
 * a dot in the turn's pigment, the turn's word, and the age. A fallback route
 * the builder named after a middot ("· browser") stays as a quiet suffix.
 */
export function workerPlate(card: KanbanCard, target: HTMLElement | null): HTMLElement {
  const facts = workerPlateFacts(card, Date.now())
  const plate = target ?? document.createElement('span')
  const via = plate.querySelector('.ws-worker-via')?.textContent ?? plate.textContent?.match(/ · (.+)$/)?.[1]
  plate.classList.add('ws-worker-control')
  plate.classList.toggle('ws-turn-active', facts.busy)
  plate.dataset.turn = facts.turn
  const part = (cls: string, text = ''): HTMLElement => {
    const span = document.createElement('span')
    span.className = cls
    span.textContent = text
    return span
  }
  // The dot is the plate's first item, so it centres on the capitals beside it and stands alone where the words are hidden.
  const dot = part('ws-worker-dot')
  dot.setAttribute('aria-hidden', 'true')
  plate.replaceChildren(dot, part('ws-worker-state', facts.word), part('ws-worker-elapsed', facts.elapsed ?? ''), ...(via ? [part('ws-worker-via', via)] : []))
  return plate
}
