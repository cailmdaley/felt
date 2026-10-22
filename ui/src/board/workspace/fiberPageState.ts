import type { KanbanCard } from '../KanbanTypes.js'
import { deskColumn } from '../deskColumn.js'
import { COLUMN_TITLES } from '../KanbanSurfaces.js'
import { isAgentCard } from '../KanbanModalShared.js'
import type { KeyIntent } from '../keymap.js'
import type { Verdict } from './Verdicts.js'

/** Only what the Desk admits is on its lifecycle: a Shuttle-managed fiber or a
 *  cycle. Any other fiber (a note opened from a link, a role) has no column,
 *  and its page offers nothing to launch, set or review. */
export function onDesk(card: KanbanCard): boolean {
  return isAgentCard(card) || card.isCycle
}
/** Rest reaches every Shuttle-managed constitution, including one with a verdict. */
export function restReachable(card: KanbanCard): boolean {
  return isAgentCard(card)
}
/** Temper and Discard reach every fiber on the Desk's lifecycle that has no
 *  verdict yet: a draft, work in flight, or work awaiting review. */
export function verdictReachable(card: KanbanCard): boolean {
  if (!onDesk(card)) return false
  const column = deskColumn(card)
  return column === 'drafts' || column === 'roles' || column === 'inFlight' || column === 'awaitingReview'
}
/** Work still on its way, a draft or in flight, can be moved to Awaiting review. */
export function reviewReachable(card: KanbanCard): boolean {
  if (!onDesk(card)) return false
  const column = deskColumn(card)
  return column === 'drafts' || column === 'inFlight'
}
/** The column's name for the page's status line; empty for a fiber with no column. */
export function fiberPageKicker(card: KanbanCard): string {
  if (!onDesk(card)) return ''
  const column = deskColumn(card)
  if (column === 'awaitingReview') return 'Awaiting your review'
  if (column === 'resting' || column === 'scheduled') return 'Resting'
  if (column === 'cycles') return 'Cycle'
  if (column === 'roles') return 'Roles'
  return COLUMN_TITLES[column]
}

/** What a surface does once a constitution key has reached a card. */
export interface ConstitutionActions {
  verdict(card: KanbanCard, verdict: Verdict): void
  compose(card: KanbanCard): void
  conversation(card: KanbanCard): void
  rest(card: KanbanCard): void
}
/** A constitution key, gated by the same reachability on the reader and the
 *  Desk. Answers whether the key reached the card. */
export function constitutionAction(intent: KeyIntent, card: KanbanCard | null | undefined, actions: ConstitutionActions): boolean {
  if (!card) return false
  if (intent === 'temper' || intent === 'discard') {
    if (!verdictReachable(card)) return false
    actions.verdict(card, intent === 'temper' ? 'tempered' : 'composted')
  } else if (intent === 'toReview') {
    if (!reviewReachable(card)) return false
    actions.verdict(card, 'awaitingReview')
  } else if (intent === 'compose') {
    if (!onDesk(card)) return false
    actions.compose(card)
  } else if (intent === 'conversation') actions.conversation(card)
  else if (intent === 'rest') {
    if (!restReachable(card)) return false
    actions.rest(card)
  } else return false
  return true
}
