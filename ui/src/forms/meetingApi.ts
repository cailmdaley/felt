import { parseMeetingRecord, type MeetingRecord } from '../board/meeting'

export type MeetingMode = 'call' | 'room'
export type MeetingField = 'title' | 'host' | 'projectDir' | 'under' | 'mode'
export type MeetingInputErrors = Partial<Record<MeetingField, string>>

export interface MeetingFormInput {
  title: string
  host: string
  projectDir: string
  under: string
  mode: MeetingMode
}

export interface MeetingRequest {
  title: string
  host: string
  project_dir: string
  under: string
  mode: MeetingMode
}

export function validateMeetingInput(input: MeetingFormInput): MeetingInputErrors {
  const errors: MeetingInputErrors = {}
  if (!input.title.trim()) errors.title = 'Enter a meeting title.'
  if (!input.host.trim()) errors.host = 'Choose a host.'
  if (!input.projectDir.trim()) errors.projectDir = 'Choose a project.'
  if (!input.under.trim()) {
    errors.under = 'Choose a parent fiber.'
  } else if (!/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(input.under.trim())) {
    errors.under = 'Use a loom-relative fiber id with lowercase words and `/` separators.'
  }
  if (input.mode !== 'call' && input.mode !== 'room') errors.mode = 'Choose Call or Room.'
  return errors
}

export function meetingRequestBody(input: MeetingFormInput): MeetingRequest {
  const errors = validateMeetingInput(input)
  if (Object.keys(errors).length) throw new MeetingValidationError(errors)
  return {
    title: input.title.trim(),
    host: input.host,
    project_dir: input.projectDir.trim(),
    under: input.under.trim(),
    mode: input.mode,
  }
}

export class MeetingValidationError extends Error {
  readonly fields: MeetingInputErrors

  constructor(fields: MeetingInputErrors) {
    super(Object.values(fields)[0] ?? 'Check the meeting details.')
    this.fields = fields
    this.name = 'MeetingValidationError'
  }
}

function responseError(body: unknown, status: number): string {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const raw = body as Record<string, unknown>
    for (const key of ['detail', 'error', 'message', 'reason']) {
      if (typeof raw[key] === 'string' && raw[key]) return raw[key] as string
    }
  }
  if (status === 409) return 'A meeting is already starting or running.'
  if (status === 422) return 'Check the meeting details and try again.'
  if (status === 503) return 'Hark is unavailable on this daemon.'
  return `Meeting request failed (${status}).`
}

export async function startMeeting(
  shuttleBase: string,
  input: MeetingFormInput,
  fetcher: typeof fetch = fetch,
): Promise<MeetingRecord> {
  const body = meetingRequestBody(input)
  const response = await fetcher(`${shuttleBase}/api/v1/meeting`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload: unknown = await response.json().catch(() => ({}))
  const meeting = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? parseMeetingRecord((payload as Record<string, unknown>).meeting)
    : null
  if (!response.ok || !meeting) throw new Error(responseError(payload, response.status))
  return meeting
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
