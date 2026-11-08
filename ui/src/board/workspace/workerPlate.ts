import type { KanbanCard } from '../KanbanTypes.js'
import { age } from '../civilDay.js'
import { turnOf, type Turn } from '../turn.js'

/**
 * A worker's turn as the board reads it: the card's turn (`turnOf`),
 * its word, and how long it has held. The age is the time since the turn
 * began: since the question was asked, since the worker stopped, or, for a
 * working worker, since its last hook event once that silence passes ten
 * minutes. `busy` breathes the dot whatever the turn.
 */
export function workerPlateFacts(card: KanbanCard, now = Date.now()): { turn: Turn; word: string; elapsed?: string; busy: boolean } {
  const { turn, word, since, busy } = turnOf(card, now)
  const elapsed = since !== undefined && Number.isFinite(since) ? age(now - since) : undefined
  return { turn, word, elapsed, busy }
}
