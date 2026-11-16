import { ago, clockTime, dayClock, formatSpanMinutes, instantMs, isoDayLocal } from '../civilDay.js'
import { hasLiveWorker, type KanbanCard } from '../KanbanTypes.js'

/**
 * A constitution's run in a few words: `working since 14:02` while its worker
 * is live; once stopped, how long the last run worked and how long ago it
 * stopped, `worked 2h 14m · stopped 40m ago`; `not run` before any launch.
 * A run with no hand-off stopped at its last activity.
 */
export function runWords(card: Pick<KanbanCard, 'dispatchedAt' | 'handedOffAt' | 'lastActivityAt' | 'closedAt' | 'workerState'>, now = Date.now()): string {
  const start = instantMs(card.dispatchedAt)
  if (start === undefined) return 'not run'
  if (hasLiveWorker(card)) return `working since ${isoDayLocal(start) === isoDayLocal(now) ? clockTime(start) : dayClock(start)}`
  const end = stoppedAt(card, start)
  return `worked ${formatSpanMinutes(Math.round((end - start) / 60_000))} · stopped ${ago(end, now)}`
}

/**
 * The same run in one short word, for a glance: `since 14:02` while its
 * worker is live, else how long ago it stopped, `40m ago`; nothing before
 * any launch. {@link runWords} says it whole, on hover.
 */
export function runGlance(card: Pick<KanbanCard, 'dispatchedAt' | 'handedOffAt' | 'lastActivityAt' | 'closedAt' | 'workerState'>, now = Date.now()): string {
  const start = instantMs(card.dispatchedAt)
  if (start === undefined) return ''
  if (hasLiveWorker(card)) return `since ${isoDayLocal(start) === isoDayLocal(now) ? clockTime(start) : dayClock(start)}`
  return ago(stoppedAt(card, start), now)
}

/** When a stopped run stopped: its hand-off, else its last activity or close. */
function stoppedAt(card: Pick<KanbanCard, 'handedOffAt' | 'lastActivityAt' | 'closedAt'>, start: number): number {
  const handed = instantMs(card.handedOffAt)
  return handed !== undefined && handed >= start ? handed : Math.max(start, card.lastActivityAt ?? start, instantMs(card.closedAt) ?? start)
}
