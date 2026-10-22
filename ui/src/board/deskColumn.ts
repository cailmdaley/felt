import { hasLiveWorker, type ColumnKind, type KanbanCard } from './KanbanTypes.js'
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

const LIFECYCLE: readonly string[] = ['drafts', 'inFlight', 'awaitingReview', 'tempered', 'composted']
/**
 * The lifecycle column a card holds on its own account, or null when it rests
 * (Resting, the timeline, the Roles). A root promoted onto the Desk for its
 * threads is drawn in the column they ask for; this is where a move, a launch
 * or a verdict on the root itself starts from.
 */
export function ownColumn(card: KanbanCard): ColumnKind | null {
  const column = deskColumn(card)
  return LIFECYCLE.includes(column) ? column as ColumnKind : null
}
