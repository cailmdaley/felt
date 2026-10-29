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
  return {
    now,
    roles,
    resting,
    rows: [...now.drafts, ...now.inFlight, ...now.awaitingReview, ...roles, ...resting.flat],
  }
}
