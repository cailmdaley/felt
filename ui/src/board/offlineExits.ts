import type { KanbanCard } from './KanbanTypes.js'

/** Only the daemon decides whether a synchronized copy is safe for an exit. */
export function canExitOffline(card: KanbanCard): boolean {
  return card.localExit === true && !card.documentStale
}

export function exitRefusal(card: KanbanCard): string | undefined {
  if (card.documentStale) return offlineExplanation(card)
  if (card.originStale && !canExitOffline(card)) return offlineExplanation(card)
}

export function executionRefusal(card: KanbanCard): string | undefined {
  if (card.documentStale) return 'The document is unreadable; resolve it before launching or resuming a worker.'
  if (!card.shuttleHost) return 'No execution host is assigned; assign one before launching a worker.'
  if (card.originStale) return `Execution host ${card.shuttleHost} is unreachable; reconnect it before launching or resuming a worker.`
}

export function offlineExplanation(card: KanbanCard): string {
  if (card.documentStale) return 'This document is unreadable; its last-known row is stale. Its worker can still be stopped through the owner. Resolve the file before lifecycle changes.'
  if (card.exitCopyPending) return 'The local exit copy is waiting for Git sync. The healthy owner remains authoritative.'
  return canExitOffline(card)
    ? 'An exit can be saved on the local copy after a definite pre-send failure to a known, already stale owner. It travels by Git; configuration and execution still need the owner.'
    : 'The owner decides: no safe local exit is available. Reconnect it before changing this lifecycle.'
}
