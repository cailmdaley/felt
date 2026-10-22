import type { KanbanCard } from '../KanbanTypes.js'
import { isAgentCard } from '../KanbanModalShared.js'
import { onDesk } from './fiberPageState.js'
import { deskColumn } from '../deskColumn.js'
import { workerPlateFacts } from './workerPlate.js'
import { claudeOpening } from '../conversationOpening.js'
import { coarsePointer } from '../mobile.js'

/** Only the paper, worker target and turn contribute to a row's face. */
export function sidebarRevision(card: KanbanCard): string {
  return JSON.stringify([
    card.id, card.uid, card.originId, card.name, card.outcome, isAgentCard(card), onDesk(card),
    card.status === 'active' && card.runtimePhase !== 'attention' ? card.ask?.text : undefined,
    deskColumn(card), card.workerState, card.runtimePhase, card.launchError,
    card.tmuxSession, card.sessionLink, card.sessionUuid, card.desktopLink, card.shuttleHost,
    card.shuttleProjectDir, card.workerSurface, card.shuttleSurface, card.workerAgent, card.shuttleAgent,
    card.lastActivityAt, card.ask?.at, card.originStale?.since, workerPlateFacts(card), claudeOpening(), coarsePointer(),
  ])
}
