import { parseMeetingRecord, type MeetingRecord } from '../board/meeting'

/**
 * What hark records: `call` this machine's mic and system audio, `room` its mic
 * alone, `phone` a browser's mic streamed from the board.
 */
export type MeetingMode = 'call' | 'room' | 'phone'

export const MEETING_MODES: ReadonlyArray<{ value: MeetingMode; label: string }> = [
  { value: 'call', label: 'Call' },
  { value: 'room', label: 'Room' },
  { value: 'phone', label: 'Phone' },
]

function responseError(body: unknown, status: number): string {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const raw = body as Record<string, unknown>
    for (const key of ['detail', 'error', 'message', 'reason']) {
      if (typeof raw[key] === 'string' && raw[key]) return raw[key] as string
    }
  }
  return `Meeting request failed (${status}).`
}

export async function stopMeeting(
  shuttleBase: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`${shuttleBase}/api/v1/meeting/stop`, { method: 'POST' })
  if (response.status === 404) return
  const payload: unknown = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(responseError(payload, response.status))
}

export interface JoinMeetingInput {
  fiberId: string
  origin?: string
  mode: MeetingMode
  note?: string
}

/**
 * What a join came to. `joined` names how the constitution's worker received
 * the meeting (`message`, `resume` or `dispatch`); `unconfirmed` means the
 * meeting was sent but the worker has not been seen taking it up yet, and says
 * what is known; `recording` means hark is recording but the worker did not
 * receive it, and says why.
 */
export type JoinMeetingOutcome =
  | { kind: 'joined'; delivery: string; meeting: MeetingRecord | null }
  | { kind: 'unconfirmed'; detail: string; meeting: MeetingRecord | null }
  | { kind: 'recording'; error: string; meeting: MeetingRecord | null }
  | { kind: 'error'; message: string }

/**
 * An unconfirmed delivery: `delivered: null`, or a message receipt of status
 * `unknown` (sent, arrival unconfirmed) whatever HTTP status carried it.
 */
function unconfirmedDetail(delivery: Record<string, unknown>): string | null {
  const receipt = delivery.receipt && typeof delivery.receipt === 'object'
    ? delivery.receipt as Record<string, unknown>
    : null
  if (delivery.delivered !== null && receipt?.status !== 'unknown') return null
  for (const detail of [delivery.detail, receipt?.detail]) {
    if (typeof detail === 'string' && detail) return detail
  }
  return 'the message was sent; its arrival is unconfirmed'
}

export function joinMeetingBody(input: JoinMeetingInput): Record<string, unknown> {
  const note = input.note?.trim() ?? ''
  return {
    fiber_id: input.fiberId,
    ...(input.origin ? { origin: input.origin } : {}),
    meeting: { mode: input.mode },
    ...(note ? { note } : {}),
  }
}

/** Record a meeting on this daemon and join it to an existing constitution. */
export async function joinMeeting(
  shuttleBase: string,
  input: JoinMeetingInput,
  fetcher: typeof fetch = fetch,
): Promise<JoinMeetingOutcome> {
  let response: Response
  try {
    response = await fetcher(`${shuttleBase}/api/v1/meeting/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(joinMeetingBody(input)),
    })
  } catch (error: unknown) {
    return { kind: 'error', message: `Couldn't reach Shuttle: ${(error as Error)?.message ?? String(error)}` }
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
  const delivery = payload.delivery && typeof payload.delivery === 'object'
    ? payload.delivery as Record<string, unknown>
    : null
  const meeting = parseMeetingRecord(payload.meeting)
  const unconfirmed = delivery && unconfirmedDetail(delivery)
  if (unconfirmed) return { kind: 'unconfirmed', detail: unconfirmed, meeting }
  if (response.ok && delivery) {
    return { kind: 'joined', delivery: typeof delivery.delivery === 'string' ? delivery.delivery : 'message', meeting }
  }
  if (payload.recording === true) return { kind: 'recording', error: responseError(payload, response.status), meeting }
  if (response.status === 409 && payload.meeting) {
    return { kind: 'error', message: 'A meeting is already starting or running.' }
  }
  return { kind: 'error', message: responseError(payload, response.status) }
}
