export const MEETING_POLL_IDLE_MS = 15_000
export const MEETING_POLL_ACTIVE_MS = 2_000

export type MeetingState = 'starting' | 'loading' | 'live' | 'stopping' | 'failed'

export interface MeetingRecord {
  state: MeetingState
  title: string | null
  started_at: string | null
  last_line: string | null
  transcript: string | null
  mirror_host: string | null
  tmux_session: string | null
  error: string | null
}

export interface MeetingStatus {
  available: boolean
  meeting: MeetingRecord | null
}

const MEETING_STATES = new Set<MeetingState>(['starting', 'loading', 'live', 'stopping', 'failed'])

export function parseMeetingRecord(value: unknown): MeetingRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.state !== 'string' || !MEETING_STATES.has(raw.state as MeetingState)) return null
  const nullableString = (key: string): string | null =>
    typeof raw[key] === 'string' ? raw[key] as string : null
  return {
    state: raw.state as MeetingState,
    title: nullableString('title'),
    started_at: nullableString('started_at'),
    last_line: nullableString('last_line'),
    transcript: nullableString('transcript'),
    mirror_host: nullableString('mirror_host'),
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
    live: 'Recording',
    stopping: 'Stopping',
    failed: 'Failed',
  }[state]
}

export interface MeetingActions {
  terminal: boolean
  stop: boolean
  stopDisabled: boolean
  dismiss: boolean
}

export function meetingActions(meeting: MeetingRecord, stopRequested = false): MeetingActions {
  const dismiss = meeting.state === 'failed'
  return {
    terminal: !!meeting.tmux_session,
    stop: !dismiss,
    stopDisabled: stopRequested || (!dismiss && meeting.state === 'stopping'),
    dismiss,
  }
}

/** A failed or absent read backs off to the board's regular polling cadence. */
export function meetingPollDelay(
  visible: boolean,
  succeeded: boolean,
  meeting: MeetingRecord | null,
): number | null {
  if (!visible) return null
  if (!succeeded || !meeting) return MEETING_POLL_IDLE_MS
  return MEETING_POLL_ACTIVE_MS
}

export class MeetingStopGuard {
  private requested: { key: string; title: string | null; startedAt: string | null } | null = null

  request(meeting: MeetingRecord): boolean {
    if (meeting.state === 'stopping' || this.isRequested(meeting)) return false
    this.requested = {
      key: this.key(meeting),
      title: meeting.title,
      startedAt: meeting.started_at,
    }
    return true
  }

  isRequested(meeting: MeetingRecord): boolean {
    if (!this.requested) return false
    return this.requested.key === this.key(meeting) || (
      this.requested.startedAt === null && this.requested.title === meeting.title
    )
  }

  /** Clear only after an authoritative read observes a terminal row or absence. */
  observe(meeting: MeetingRecord | null): void {
    if (!meeting || meeting.state === 'stopping' || meeting.state === 'failed') {
      this.requested = null
      return
    }
    if (
      this.requested?.startedAt === null &&
      this.requested.title === meeting.title &&
      meeting.started_at !== null
    ) {
      this.requested = {
        key: this.key(meeting),
        title: meeting.title,
        startedAt: meeting.started_at,
      }
    }
  }

  private key(meeting: MeetingRecord): string {
    return `${meeting.started_at ?? ''}\u0000${meeting.title ?? ''}`
  }
}

export function meetingDuration(meeting: MeetingRecord, nowMs = Date.now()): string | null {
  if (meeting.state === 'starting' || !meeting.started_at) return null
  const duration = formatMeetingDuration(meeting.started_at, nowMs)
  return duration === '—' ? null : duration
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
