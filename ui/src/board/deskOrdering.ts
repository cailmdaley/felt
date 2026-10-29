import { IN_FLIGHT_BANDS, inFlightBand, restingCards } from './KanbanReadModel.js'
import { restingOrder, type RestingOrder } from './KanbanSurfaces.js'
import { hostZone, type Zone } from './civilDay.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { seatMeetingHost, type MeetingRecord } from './meeting.js'

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

/** Identity shared by a Desk row and its Reader/sidebar projection. */
export function deskCardKey(card: KanbanCard): string {
  return JSON.stringify([card.originId, card.uid ?? card.id])
}

/** Put every visible Desk row in its reading order for the given response. */
export function deskOrder(
  resp: KanbanResponse | null,
  zone: Zone = hostZone(),
  meeting: MeetingRecord | null = null,
): DeskOrder {
  const source = resp?.now ?? { drafts: [], inFlight: [], awaitingReview: [] }
  const seated = seatMeetingHost(source, meeting).now
  const now = {
    ...seated,
    inFlight: IN_FLIGHT_BANDS.flatMap(([band]) => seated.inFlight.filter(card => inFlightBand(card) === band)),
  }
  const roles = resp?.roles ?? []
  const resting = restingOrder(restingCards(resp), zone)
  const placements = new Map<string, DeskPlacement>()
  const place = (cards: KanbanCard[], column: DeskColumn, group: string): void => {
    for (const card of cards) placements.set(deskCardKey(card), { column, group })
  }
  place(now.drafts, 'drafts', 'Drafts')
  for (const [band, label] of IN_FLIGHT_BANDS) {
    place(now.inFlight.filter(card => inFlightBand(card) === band), 'inFlight', label)
  }
  place(now.awaitingReview, 'awaitingReview', 'Awaiting review')
  place(roles, 'roles', 'Roles')
  place(resting.flat, 'resting', 'Resting')
  return {
    now,
    roles,
    resting,
    rows: [...now.drafts, ...now.inFlight, ...now.awaitingReview, ...roles, ...resting.flat],
    placements,
  }
}
