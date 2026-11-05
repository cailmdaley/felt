import { hasLiveWorker, type KanbanCard } from './KanbanTypes.js'
import { instantMs } from './civilDay.js'

/** A cached absence of a worker is insufficient while dispatch remains armed. */
export function canPlanOffline(card: KanbanCard): boolean {
  return card.localPlanning === true && quiescent(card)
}

function quiescent(card: KanbanCard): boolean {
  if (card.status === 'active' || hasLiveWorker(card) || card.held) return false
  if (!card.dispatchedAt) return !card.sessionUuid
  const start = instantMs(card.dispatchedAt), end = card.handedOffAt ? instantMs(card.handedOffAt) : NaN
  return start !== undefined && end !== undefined && Number.isFinite(start) && Number.isFinite(end) && end > start
}

export function executionRefusal(card: KanbanCard): string | undefined {
  if (!card.shuttleHost) return 'No execution host is assigned; assign one before launching a worker.'
  if (card.originStale) return `Execution host ${card.shuttleHost} is unreachable; reconnect it before launching or resuming a worker.`
}

/** A standing Temper is an owner-routed accepted verdict. */
export function temperNeedsOwner(card: KanbanCard): boolean {
  return card.shuttleKind === 'standing'
}

export function offlineExplanation(card: KanbanCard): string {
  if (quiescent(card) && card.localPlanning !== true) {
    return `Execution host ${card.shuttleHost ?? card.originId} is unreachable. No quiescent local planning copy is available; reconnect the host or sync its document before saving changes.`
  }
  return canPlanOffline(card)
    ? `Execution host ${card.shuttleHost ?? card.originId} is unreachable. Planning changes are saved here and reach it through Git sync; launching needs the host.`
    : `Execution host ${card.shuttleHost ?? card.originId} is unreachable. This fiber is armed or may have a live worker. Reconnect the host before changing its lifecycle.`
}
