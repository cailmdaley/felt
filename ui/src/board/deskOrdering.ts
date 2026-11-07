import { IN_FLIGHT_BANDS, inFlightBand, restingCards } from './KanbanReadModel.js'
import { restingOrder, type RestingOrder } from './KanbanSurfaces.js'
import { hostZone, type Zone } from './civilDay.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'

/** The Desk's visible order, including the Resting grouping used to draw it. */
export interface DeskOrder {
  now: KanbanResponse['now']
  roles: KanbanCard[]
  resting: RestingOrder
  rows: KanbanCard[]
  placements: ReadonlyMap<string, DeskPlacement>
}

export type DeskColumn = 'drafts' | 'inFlight' | 'awaitingReview' | 'roles' | 'resting'

/** The caption and Desk column a row occupies in the rendered projection. */
export interface DeskPlacement {
  column: DeskColumn
  group: string
}

/** Identity shared by a Desk row and its Reader projection. */
export function deskCardKey(card: KanbanCard): string {
  return JSON.stringify([card.originId, card.uid ?? card.id])
}

/**
 * Put every visible Desk row in its reading order for the given response.
 * The reader's j/k walks `rows`: each constitution once, at its own row; a
 * root heading another section is a view of it, and threads are reached from
 * their constitution's page.
 */
export function deskOrder(
  resp: KanbanResponse | null,
  zone: Zone = hostZone(),
): DeskOrder {
  const source = resp?.now ?? { drafts: [], inFlight: [], awaitingReview: [] }
  const now = {
    ...source,
    inFlight: IN_FLIGHT_BANDS.flatMap(([band]) => source.inFlight.filter(card => inFlightBand(card) === band)),
  }
  const roles = resp?.roles ?? []
  const resting = restingOrder(restingCards(resp), zone)
  const placements = new Map<string, DeskPlacement>()
  const place = (cards: KanbanCard[], column: DeskColumn, group: string): void => {
    for (const card of cards) if (!card.deskSection) placements.set(deskCardKey(card), { column, group })
  }
  place(now.drafts, 'drafts', 'Drafts')
  for (const [band, label] of IN_FLIGHT_BANDS) {
    place(now.inFlight.filter(card => inFlightBand(card) === band), 'inFlight', label)
  }
  place(now.awaitingReview, 'awaitingReview', 'Awaiting review')
  place(resting.flat, 'resting', 'Resting')
  place(roles, 'roles', 'Roles')
  return {
    now,
    roles,
    resting,
    rows: [...now.drafts, ...now.inFlight, ...now.awaitingReview, ...resting.flat, ...roles].filter(card => !card.deskSection),
    placements,
  }
}
