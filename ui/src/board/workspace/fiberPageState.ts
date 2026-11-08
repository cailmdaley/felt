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
/** Rest reaches every Shuttle-managed constitution, including one with a verdict. */
export function restReachable(card: KanbanCard): boolean {
  return isAgentCard(card)
}
/** Unreviewed work in flight or awaiting review takes both verdicts, as do
 *  oneshot drafts. Open standing constitutions and idle scheduled standing
 *  cards take Discard alone: Temper accepts a standing run, not a paused or
 *  idle responsibility. A seat at rest takes none. */
export function verdictsFor(card: KanbanCard): Array<'temper' | 'discard'> {
  if (!constitution(card)) return []
  const column = card.column
  if (column === 'roles') return []
  if (card.shuttleKind === 'standing' && card.status === 'open')
    return card.shuttleSeat === true || card.tempered != null ? [] : ['discard']
  if (column === 'drafts' || column === 'inFlight' || column === 'awaitingReview') return ['temper', 'discard']
  if (column !== 'resting' || card.shuttleSeat === true) return []
  return card.shuttleKind === 'standing' ? ['discard'] : ['temper', 'discard']
}
/** Whether a card takes any verdict. */
export function verdictReachable(card: KanbanCard): boolean {
  return verdictsFor(card).length > 0
}
/** Work still on its way, a draft or in flight, can be moved to Awaiting review. */
export function reviewReachable(card: KanbanCard): boolean {
  return constitution(card) && (card.column === 'drafts' || card.column === 'inFlight')
}
/** The column's name for the page's status line; empty for a fiber with no column. */
export function fiberPageKicker(card: KanbanCard): string {
  if (card.isCycle) return 'Cycle'
  if (!isAgentCard(card)) return ''
  return card.column === 'awaitingReview' ? 'Awaiting your review' : DESK_COLUMN_TITLE[card.column]
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
