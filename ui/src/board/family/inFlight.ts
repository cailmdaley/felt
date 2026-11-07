import type { KanbanCard, KanbanResponse } from '../KanbanTypes.js'
import { isAgentCard } from '../KanbanModalShared.js'
import { ThreadIndex, threadKey } from '../threads.js'
import { DAY } from './drawing.js'
import { familyModel, type FamilyModel, type MapFeeds, type MapThread } from './model.js'

/** How long a closed family stays on the just-finished arm. */
export const LATELY_MS = 3 * DAY

const CENTRE: KanbanCard = { id: 'in-flight', name: 'In flight', path: '', originId: '', status: 'open', createdAt: '', effectiveHorizon: 'now', drifted: false, isCycle: false, cycleStart: null }

const within = (model: FamilyModel, thread: MapThread): MapThread[] => [thread, ...thread.children.flatMap(key => within(model, model.threads.get(key)!))]
/** A family seen from outside says what its most urgent thread says, and that it holds a new file. */
function raise(model: FamilyModel, family: MapThread): void {
  const kin = within(model, family), lead = model.attention.find(thread => kin.includes(thread))
  family.fresh = kin.some(thread => thread.fresh)
  if (!lead || lead === family) return
  family.tone = lead.tone
  family.word = lead.word
  family.note = lead.note
}

/**
 * Everything in flight as one family: a centre that stands for the Desk, whose
 * threads are the families the Desk has In flight and, as just finished, those
 * that came to Awaiting review or closed lately. Each family is the same tree
 * it is on its own map, hung from the centre by a copy of its root.
 */
export function inFlightModel(desk: KanbanResponse['now'], cards: readonly KanbanCard[], index: ThreadIndex, feeds: MapFeeds, now: number): FamilyModel {
  const root = (card: KanbanCard): KanbanCard => index.family(index.card(card)).root
  const flying = new Set(desk.inFlight.map(root))
  const closed = cards.filter(card => !index.parentOf(card) && isAgentCard(card) && index.state(card) === 'archived' && now - (Date.parse(card.closedAt ?? '') || 0) < LATELY_MS)
  const finished = new Set([...desk.awaitingReview.map(root), ...closed].filter(card => !flying.has(card)))
  const families = new Set([...flying, ...finished])
  const hung = cards.map(card => families.has(index.card(card)) ? { ...card, orchestrator: CENTRE.id } : card)
  const model = familyModel(new ThreadIndex([CENTRE, ...hung]), CENTRE, CENTRE, feeds, now)
  for (const key of model.root.children) raise(model, model.threads.get(key)!)
  model.root.word = `${desk.inFlight.length} in flight`
  model.root.launches = [...model.threads.values()].flatMap(thread => thread.launches)
  model.root.commits = [...model.threads.values()].flatMap(thread => thread.commits)
  return { ...model, finished: new Set([...finished].map(threadKey)) }
}
