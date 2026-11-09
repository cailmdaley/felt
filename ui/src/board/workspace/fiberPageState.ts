import type { KanbanCard } from '../KanbanTypes.js'
import { DESK_COLUMN_TITLE } from '../KanbanSurfaces.js'
import { isAgentCard } from '../KanbanModalShared.js'
import type { KeyIntent } from '../keymap.js'
import type { Verdict } from './Verdicts.js'

/** Only what the Desk admits is on its lifecycle: a Shuttle-managed fiber or a
 *  cycle. Any other fiber (a note opened from a link, a role) has no column,
 *  and its page offers nothing to launch, set or review. */
export function onDesk(card: KanbanCard): boolean {
  return isAgentCard(card) || card.isCycle
}
/** A constitution its column speaks for: Shuttle-managed, and not a cycle, which marks time. */
function constitution(card: KanbanCard): boolean {
  return isAgentCard(card) && !card.isCycle
}
/** A standing constitution: it runs on its cron, and its lifecycle is its schedule's. */
export function standing(card: KanbanCard): boolean {
  return constitution(card) && card.shuttleKind === 'standing'
}
/** A constitution on a clock that Rest stops: a standing one's cron, or a
 *  seat's pulse. Its Rest pauses that schedule and takes no wake day. */
export function scheduled(card: KanbanCard): boolean {
  return standing(card) || (isAgentCard(card) && !card.isCycle && !!card.shuttlePulse)
}
/** A scheduled constitution whose schedule is paused (`status: open`): it
 *  fires again only once its schedule is resumed. */
export function schedulePaused(card: KanbanCard): boolean {
  return scheduled(card) && card.status === 'open'
}
/** Rest reaches every Shuttle-managed constitution, including one with a
 *  verdict; on a standing one it pauses or resumes the schedule, which a
 *  retired one no longer has. */
export function restReachable(card: KanbanCard): boolean {
  return isAgentCard(card) && !(standing(card) && card.status === 'closed')
}
/** Unreviewed work in flight or awaiting review takes both verdicts, as do
 *  oneshot drafts and work put down. A standing constitution takes Discard
 *  alone, as Retire: a run's exit re-arms it, and its review is the run's own
 *  ask. A seat at rest takes none. */
export function verdictsFor(card: KanbanCard): Array<'temper' | 'discard'> {
  if (!constitution(card)) return []
  const column = card.column
  if (column === 'roles') return []
  if (standing(card)) return card.status === 'closed' ? [] : ['discard']
  if (column === 'drafts' || column === 'inFlight' || column === 'awaitingReview') return ['temper', 'discard']
  if (column !== 'resting' || card.shuttleSeat === true) return []
  return ['temper', 'discard']
}
/** Whether a card takes any verdict. */
export function verdictReachable(card: KanbanCard): boolean {
  return verdictsFor(card).length > 0
}
/** Work still on its way, a draft or in flight, can be moved to Awaiting
 *  review; a standing constitution never waits there. */
export function reviewReachable(card: KanbanCard): boolean {
  return constitution(card) && !standing(card) && (card.column === 'drafts' || card.column === 'inFlight')
}
/** The column's name for the page's status line, or a standing constitution's
 *  schedule state at rest; empty for a fiber with no column. */
export function fiberPageKicker(card: KanbanCard): string {
  if (card.isCycle) return 'Cycle'
  if (!isAgentCard(card)) return ''
  if (card.column === 'awaitingReview') return 'Awaiting your review'
  if (card.column === 'resting' && standing(card)) return schedulePaused(card) ? 'Schedule paused' : 'Scheduled'
  return DESK_COLUMN_TITLE[card.column]
}

/** What a surface does once a constitution key has reached a card. */
export interface ConstitutionActions {
  verdict(card: KanbanCard, verdict: Verdict): void
  conversation(card: KanbanCard): void
  rest(card: KanbanCard): void
}
/** A constitution key, gated by the same reachability on the reader and the
 *  Desk. Answers whether the key reached the card. */
export function constitutionAction(intent: KeyIntent, card: KanbanCard | null | undefined, actions: ConstitutionActions): boolean {
  if (!card) return false
  if (intent === 'temper' || intent === 'discard') {
    if (!verdictsFor(card).includes(intent)) return false
    actions.verdict(card, intent === 'temper' ? 'tempered' : 'composted')
  } else if (intent === 'toReview') {
    if (!reviewReachable(card)) return false
    actions.verdict(card, 'awaitingReview')
  } else if (intent === 'conversation') actions.conversation(card)
  else if (intent === 'rest') {
    if (!restReachable(card)) return false
    actions.rest(card)
  } else return false
  return true
}
