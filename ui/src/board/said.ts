import type { BoardRecord } from './boardFeed.js'
import type { KanbanCard } from './KanbanTypes.js'
import type { ThreadIndex } from './threads.js'

/**
 * What a constitution last said: its newest post, question or close note among
 * `records` (its family's board records), its open question, or its review
 * note; never its outcome.
 */
export function lastSaid(card: KanbanCard, index: ThreadIndex, records: readonly BoardRecord[]): { text: string; at: number } | undefined {
  const uid = card.uid ?? card.id, outcome = card.outcome?.trim()
  // A closing post's line carries the outcome as its text.
  const posts = records
    .filter(record => record.fiber === uid && ['post', 'asked', 'closed'].includes(record.kind) && record.text?.trim() && !(record.kind === 'closed' && record.text.trim() === outcome))
    .map(record => ({ text: record.text!.trim(), at: record.timestamp }))
  if (card.ask && card.status === 'active') posts.push({ text: card.ask.text, at: Date.parse(card.ask.at) || 0 })
  if (index.state(card) === 'to-review' && card.reviewMark?.note) posts.push({ text: card.reviewMark.note, at: Date.parse(card.reviewMark.at) || 0 })
  return posts.sort((a, b) => a.at - b.at).at(-1)
}
