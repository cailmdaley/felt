import type { KanbanCard } from '../KanbanTypes.js'
import { hasLiveWorker } from '../KanbanTypes.js'
import { classifyFiber } from '../KanbanRules.js'
import { COLUMN_TITLES } from '../KanbanSurfaces.js'
import { isAgentCard } from '../KanbanModalShared.js'

/** The reader uses the same lifecycle classifier and labels as the Desk. */
export function fiberPageColumn(card: KanbanCard) {
  if (card.effectiveHorizon === 'stashed') return 'resting' as const
  return classifyFiber({ id: card.id, name: card.name, status: card.status, createdAt: card.createdAt, tags: card.tags, tempered: card.tempered, shuttleKind: card.shuttleKind, hasShuttleBlock: isAgentCard(card) }, { liveWorker: hasLiveWorker(card) })
}
export function fiberPageKicker(card: KanbanCard): string {
  const column = fiberPageColumn(card)
  if (column === 'awaitingReview') return 'Awaiting your review'
  if (column === 'resting' || column === 'scheduled') return 'Resting'
  if (column === 'cycles') return 'Cycle'
  return COLUMN_TITLES[column]
}
