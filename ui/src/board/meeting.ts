export const MEETING_POLL_IDLE_MS = 15_000
export const MEETING_POLL_ACTIVE_MS = 2_000

export type MeetingState = 'starting' | 'loading' | 'live' | 'local' | 'stopping' | 'failed'

export interface MeetingRecord {
  state: MeetingState
  title: string | null
  host: string | null
  fiber: string | null
  started_at: string | null
  last_line: string | null
  transcript: string | null
  tmux_session: string | null
  error: string | null
}

export interface MeetingStatus {
  available: boolean
  meeting: MeetingRecord | null
}

const MEETING_STATES = new Set<MeetingState>([
  'starting', 'loading', 'live', 'local', 'stopping', 'failed',
])

export function parseMeetingRecord(value: unknown): MeetingRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.state !== 'string' || !MEETING_STATES.has(raw.state as MeetingState)) return null
  const nullableString = (key: string): string | null =>
    typeof raw[key] === 'string' ? raw[key] as string : null
  return {
    state: raw.state as MeetingState,
    title: nullableString('title'),
    host: nullableString('host'),
    fiber: nullableString('fiber'),
    started_at: nullableString('started_at'),
    last_line: nullableString('last_line'),
    transcript: nullableString('transcript'),
    tmux_session: nullableString('tmux_session'),
    error: nullableString('error'),
  }
}

export function parseMeetingStatus(value: unknown): MeetingStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.available !== 'boolean') return null
  if (raw.meeting === null || raw.meeting === undefined) return { available: raw.available, meeting: null }
  const meeting = parseMeetingRecord(raw.meeting)
  return meeting ? { available: raw.available, meeting } : null
}

export function meetingStateWord(state: MeetingState): string {
  return {
    starting: 'Starting',
    loading: 'Loading',
    live: 'Live',
    local: 'Local capture',
    stopping: 'Stopping',
    failed: 'Failed',
  }[state]
}

export interface MeetingActions {
  notes: boolean
  terminal: boolean
  stop: boolean
  stopDisabled: boolean
  dismiss: boolean
}

export function meetingActions(meeting: MeetingRecord): MeetingActions {
  return {
    notes: !!meeting.fiber && (meeting.state === 'live' || meeting.state === 'stopping'),
    terminal: !!meeting.tmux_session,
    stop: meeting.state !== 'failed',
    stopDisabled: meeting.state === 'stopping',
    dismiss: meeting.state === 'failed',
  }
}

export function meetingPollInterval(meeting: MeetingRecord | null): number {
  return meeting ? MEETING_POLL_ACTIVE_MS : MEETING_POLL_IDLE_MS
}

export function formatMeetingDuration(startedAt: string | null, nowMs = Date.now()): string {
  if (!startedAt) return '—'
  const startMs = Date.parse(startedAt)
  if (!Number.isFinite(startMs)) return '—'
  const totalSeconds = Math.max(0, Math.floor((nowMs - startMs) / 1000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}:${String(seconds).padStart(2, '0')}`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
