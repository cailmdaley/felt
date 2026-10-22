import { hasLiveWorker, type KanbanCard } from './KanbanTypes.js'
import { classifyFiber } from './KanbanRules.js'
import { isAgentCard } from './KanbanModalShared.js'

/**
 * Where the Desk files a card: `classifyFiber`'s column, with a draft put
 * down (`horizon: stashed`) in Resting, as the read model routes it. Every
 * surface that names a card's place on the lifecycle (the reader, the dock,
 * thread rows, mention chips) reads this.
 */
export function deskColumn(card: KanbanCard) {
  const column = classifyFiber({ id: card.id, name: card.name, status: card.status, createdAt: card.createdAt, tags: card.tags, tempered: card.tempered, shuttleKind: card.shuttleKind, shuttleSeat: card.shuttleSeat, shuttleRole: card.shuttleRole, hasShuttleBlock: isAgentCard(card) }, { liveWorker: hasLiveWorker(card) })
  if (column === 'drafts' && card.effectiveHorizon === 'stashed') return 'resting' as const
  return column
}
