import { meetingJoinable, parseMeetingRecord, parseMeetingStatus, type MeetingRecord, type MeetingMode } from '../board/meeting'
export type { MeetingMode } from '../board/meeting'

/**
 * What hark records: `call` this machine's mic and system audio, `room` its mic
 * alone, `phone` a browser's mic streamed from the board.
 */
export const MEETING_MODES: ReadonlyArray<{ value: MeetingMode; label: string }> = [
  { value: 'call', label: 'Live' },
  { value: 'room', label: 'Mic only' },
  { value: 'phone', label: 'Phone' },
]

export interface CaptureMeetingCapabilities {
  available: boolean
  modes: MeetingMode[]
  recorder: string | null
}

/** Parse the serving daemon's meeting modes and fail closed while it records. */
export function parseCaptureMeetingCapabilities(value: unknown): CaptureMeetingCapabilities {
  const status = parseMeetingStatus(value)
  return {
    available: status !== null && meetingJoinable(status),
    modes: status?.modes ?? [],
    recorder: status?.recorder ?? null,
  }
}

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
  meeting?: MeetingRecord,
): Promise<void> {
  if (meeting && !meeting.launch) throw new Error('The meeting has no launch id. Refresh before stopping it.')
  const response = await fetcher(`${shuttleBase}/api/v1/meeting/stop`, {
    method: 'POST',
    ...(meeting ? {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(meeting.recorder ? { recorder: meeting.recorder } : {}), launch: meeting.launch }),
    } : {}),
  })
  if (response.status === 404) return
  const payload: unknown = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(responseError(payload, response.status))
}

export interface JoinMeetingInput {
  fiberId: string
  origin?: string
  recorder?: string | null
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
  | { kind: 'error'; message: string; uncertain?: boolean; recorder?: string | null }

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
    ...(input.recorder && input.mode !== 'phone' ? { recorder: input.recorder } : {}),
    meeting: { mode: input.mode },
    ...(note ? { note } : {}),
  }
}

/** Record on the selected recorder and deliver to the constitution's owner. */
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
    return { kind: 'error', uncertain: true, recorder: input.recorder,
      message: `Recording start couldn't be confirmed: ${(error as Error)?.message ?? String(error)}. Inspect the recorder before starting another meeting.` }
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (payload.recording_unknown === true) return {
    kind: 'error', uncertain: true,
    recorder: typeof payload.recorder === 'string' ? payload.recorder : input.recorder,
    message: responseError(payload, response.status),
  }
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
