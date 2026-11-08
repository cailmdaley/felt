import type { ColumnKind, KanbanCard } from './KanbanTypes.js'

const LIFECYCLE: readonly string[] = ['drafts', 'inFlight', 'awaitingReview', 'tempered', 'composted']
/**
 * The lifecycle column a card holds on its own account, or null when it rests
 * (Resting, the timeline, the Roles). A family's Desk row is the node whose
 * own column this is, so a move, a launch or a verdict from the row starts
 * here.
 */
export function ownColumn(card: KanbanCard): ColumnKind | null {
  return LIFECYCLE.includes(card.column) ? card.column as ColumnKind : null
}
