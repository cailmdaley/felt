export type MeetingMode = 'call' | 'room'

export const MEETING_MODES: ReadonlyArray<{ value: MeetingMode; label: string }> = [
  { value: 'call', label: 'Call' },
  { value: 'room', label: 'Room' },
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
 * the meeting (`message`, `resume` or `dispatch`); `recording` means hark is
 * recording but the worker did not receive it, and says why.
 */
export type JoinMeetingOutcome =
  | { kind: 'joined'; delivery: string }
  | { kind: 'recording'; error: string }
  | { kind: 'error'; message: string }

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
  if (response.ok && delivery) {
    return { kind: 'joined', delivery: typeof delivery.delivery === 'string' ? delivery.delivery : 'message' }
  }
  if (payload.recording === true) return { kind: 'recording', error: responseError(payload, response.status) }
  if (response.status === 409 && payload.meeting) {
    return { kind: 'error', message: 'A meeting is already starting or running.' }
  }
  if (response.status === 404) {
    return { kind: 'error', message: 'This daemon cannot join meetings yet — deploy the current build.' }
  }
  return { kind: 'error', message: responseError(payload, response.status) }
}
