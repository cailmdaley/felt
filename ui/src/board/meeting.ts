import type { KanbanCard } from './KanbanTypes.js'

export const MEETING_POLL_IDLE_MS = 15_000
export const MEETING_POLL_ACTIVE_MS = 2_000

export type MeetingState = 'starting' | 'loading' | 'live' | 'stopping' | 'failed'

export interface MeetingRecord {
  state: MeetingState
  title: string | null
  started_at: string | null
  /** The transcript's last spoken lines, oldest first. */
  tail: string[]
  transcript: string | null
  mirror_host: string | null
  /** The fiber this meeting rides on: the constitution it joined, or the fiber
   *  its capture scribe claimed, once the daemon has found it. */
  fiber: string | null
  /** Whether `fiber` is a constitution the meeting joined. */
  joined: boolean
  /** The meeting takes its audio from a phone (`/phone`), not this machine. */
  phone: boolean
  /** The recording's launch id: what a phone's audio socket binds to. */
  launch: string | null
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
    tail: Array.isArray(raw.tail) ? raw.tail.filter((line): line is string => typeof line === 'string') : [],
    transcript: nullableString('transcript'),
    mirror_host: nullableString('mirror_host'),
    fiber: nullableString('fiber'),
    joined: raw.joined === true,
    phone: raw.phone === true,
    launch: nullableString('launch'),
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

/** A new meeting can start here: hark is available and nothing is recording
 *  (a failed row is replaced by the next start). */
export function meetingJoinable(status: MeetingStatus): boolean {
  return status.available && (!status.meeting || status.meeting.state === 'failed')
}

/** How a joined constitution's worker received the meeting, for the banner. */
export function joinDeliveryPhrase(delivery: string): string {
  return {
    message: 'its worker has the meeting',
    resume: 'resumed with the meeting',
    dispatch: 'started with the meeting',
  }[delivery] ?? 'joined the meeting'
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

/**
 * The card a meeting lives on: its fiber's, the constitution it joined or the
 * fiber its capture scribe claimed. `null` when the meeting has no fiber yet or
 * its card is not on the desk, and the meeting draws its own card.
 */
export function meetingHostCard(meeting: MeetingRecord | null, cards: Iterable<KanbanCard>): KanbanCard | null {
  if (!meeting?.fiber) return null
  for (const card of cards) if (card.id === meeting.fiber) return card
  return null
}

export interface TranscriptLine {
  /** When the turn began. */
  time: string | null
  /** When it ended, for a line stamped with a range. */
  end: string | null
  speaker: string | null
  text: string
}

/** Split `14:03:12 S2  words`, or `14:03:12-14:03:20 S2  words`, into its
 *  stamp, speaker and words. */
export function parseTranscriptLine(line: string): TranscriptLine {
  const match = /^(\d{1,2}:\d{2}:\d{2})(?:-(\d{1,2}:\d{2}:\d{2}))?\s+(\S+)\s+(.*)$/.exec(line)
  return match
    ? { time: match[1], end: match[2] ?? null, speaker: match[3], text: match[4] }
    : { time: null, end: null, speaker: null, text: line }
}


/** Redraw a transcript list when its lines change, staying pinned to the
 *  newest line unless the reader has scrolled back. */
export function paintTranscript(tail: HTMLOListElement, lines: string[]): void {
  const signature = lines.join('\n')
  if (tail.dataset.signature === signature) return
  const following = !tail.dataset.signature ||
    tail.scrollTop + tail.clientHeight >= tail.scrollHeight - 4
  tail.dataset.signature = signature
  tail.hidden = lines.length === 0
  tail.replaceChildren(...lines.map((raw) => {
    const line = parseTranscriptLine(raw)
    const item = document.createElement('li')
    item.className = 'kbn-meeting-line'
    if (line.time) item.title = line.end ? `${line.time}–${line.end}` : line.time
    if (line.speaker) {
      const speaker = document.createElement('span')
      speaker.className = 'kbn-meeting-speaker'
      speaker.textContent = line.speaker
      item.append(speaker, ' ')
    }
    item.append(line.text)
    return item
  }))
  if (!following) return
  // A freshly built tail has no layout until the desk mounts it.
  tail.scrollTop = tail.scrollHeight
  if (!tail.isConnected) requestAnimationFrame(() => { tail.scrollTop = tail.scrollHeight })
}

export interface DeskColumns {
  drafts: KanbanCard[]
  inFlight: KanbanCard[]
  awaitingReview: KanbanCard[]
}

/**
 * Seat a meeting's host card at the top of In flight, lifted out of whichever
 * desk column holds it: a recording is live work, and only one runs at a time.
 * Without a host on the desk the columns are returned as they are.
 */
export function seatMeetingHost(
  now: DeskColumns,
  meeting: MeetingRecord | null,
): { now: DeskColumns; host: KanbanCard | null } {
  const host = meetingHostCard(meeting, [...now.drafts, ...now.inFlight, ...now.awaitingReview])
  if (!host) return { now, host: null }
  const without = (cards: KanbanCard[]) => cards.filter((card) => card !== host)
  return {
    host,
    now: {
      drafts: without(now.drafts),
      inFlight: [host, ...without(now.inFlight)],
      awaitingReview: without(now.awaitingReview),
    },
  }
}
