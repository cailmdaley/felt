import type { KanbanCard } from './KanbanTypes.js'
import type { ThreadIndex } from './threads.js'

/** A fiber's slug: the last step of its id, as Rex's sidebar names it. */
export const slug = (card: Pick<KanbanCard, 'id'>): string => card.id.split('/').pop() ?? card.id

/** A family's label: its top-level's slug, after the path of any ancestor missing from the board. */
export function rowLabel(index: ThreadIndex, card: KanbanCard): string {
  return [...index.ancestry(card).map(step => step.card ? slug(step.card) : step.name), slug(card)].join('/')
}
