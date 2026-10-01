/**
 * The phone page's decisions, kept apart from the DOM and the audio graph so
 * the suite can hold them to account: what the screen offers for a meeting
 * state, what the relay's status frames mean, when to reconnect, and how much
 * audio to hold while the socket is down.
 */

import type { MeetingRecord, MeetingStatus } from '../board/meeting.js'

/** The relay socket as the page shows it. */
export type LinkState =
  | 'idle'
  | 'opening'
  | 'waiting'
  | 'connected'
  | 'reconnecting'
  | 'refused'
  | 'ended'
  | 'replaced'

/** A terminal link state: the relay closed for a reason a retry won't change. */
export const TERMINAL_LINKS: ReadonlySet<LinkState> = new Set(['refused', 'ended', 'replaced'])

/** The relay's close codes (`ShuttleWeb.MeetingAudioSocket.close_code/1`). */
export const RELAY_CLOSE_CODES: Readonly<Record<number, LinkState>> = {
  4404: 'refused',
  4409: 'replaced',
  4410: 'ended',
  4500: 'ended',
}

export interface RelayStatus {
  state: 'waiting' | 'connected' | 'refused' | 'ended' | 'replaced'
  reason: string | null
  droppedBytes: number
}

const RELAY_STATES = new Set<RelayStatus['state']>(['waiting', 'connected', 'refused', 'ended', 'replaced'])

/** One of the relay's JSON status frames, or null for anything else. */
export function parseRelayStatus(text: string): RelayStatus | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (typeof record.state !== 'string' || !RELAY_STATES.has(record.state as RelayStatus['state'])) return null
  return {
    state: record.state as RelayStatus['state'],
    reason: typeof record.reason === 'string' ? record.reason : null,
    droppedBytes: typeof record.dropped_bytes === 'number' ? record.dropped_bytes : 0,
  }
}

/**
 * What a closed socket means. The last status frame names a terminal close;
 * failing that, the close code does; anything else (a network drop, a
 * suspended tab, a daemon restart) is worth reconnecting.
 */
export function closeMeaning(code: number, lastStatus: RelayStatus | null): LinkState {
  if (lastStatus && TERMINAL_LINKS.has(lastStatus.state)) return lastStatus.state
  return RELAY_CLOSE_CODES[code] ?? 'reconnecting'
}

/** Reconnect backoff: 0.5 s doubling to a 8 s ceiling. */
export function reconnectDelay(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt), 8_000)
}

/** Audio held while the socket is down, newest kept: about 30 s of 16 kHz s16. */
export const HOLD_BYTES = 30 * 16_000 * 2

export class ChunkQueue {
  private chunks: ArrayBuffer[] = []
  private held = 0
  /** Bytes dropped since the last drain, oldest first. */
  dropped = 0

  private readonly maxBytes: number

  constructor(maxBytes = HOLD_BYTES) {
    this.maxBytes = maxBytes
  }

  get bytes(): number {
    return this.held
  }

  push(chunk: ArrayBuffer): void {
    this.chunks.push(chunk)
    this.held += chunk.byteLength
    while (this.held > this.maxBytes && this.chunks.length > 0) {
      const oldest = this.chunks.shift()!
      this.held -= oldest.byteLength
      this.dropped += oldest.byteLength
    }
  }

  drain(): ArrayBuffer[] {
    const out = this.chunks
    this.chunks = []
    this.held = 0
    this.dropped = 0
    return out
  }
}

/** What the screen offers. */
export interface PhoneView {
  headline: string
  detail: string | null
  /** The one big action: start a phone meeting, or feed the live one. */
  primary: 'start' | 'connect' | null
  /** Stop the meeting (and the mic). */
  canStop: boolean
  /** The note field belongs to starting a meeting. */
  showNote: boolean
}

export interface PhoneViewInput {
  /** The last `GET /api/v1/meeting`, or null before the first answer. */
  status: MeetingStatus | null
  /** Whether the last poll reached the daemon. */
  reachable: boolean
  /** This page holds the mic and a relay socket. */
  streaming: boolean
  /** A start request from this page is in flight. */
  starting: boolean
}

function modeWords(meeting: MeetingRecord): string {
  return meeting.state === 'starting' ? 'A meeting is starting on the Mac' : 'A meeting is recording the Mac’s own mic'
}

export function phoneView({ status, reachable, streaming, starting }: PhoneViewInput): PhoneView {
  const none = { detail: null, primary: null, canStop: false, showNote: false } as const
  if (starting) return { ...none, headline: 'Starting the meeting…' }
  if (!reachable) {
    return { ...none, headline: 'Can’t reach Shuttle', detail: 'Retrying every few seconds.', canStop: streaming }
  }
  if (!status) return { ...none, headline: 'Looking for a meeting…' }

  const meeting = status.meeting
  if (!meeting || meeting.state === 'failed') {
    if (!status.available) {
      return { ...none, headline: 'hark isn’t available on this machine', canStop: streaming }
    }
    return {
      headline: 'No meeting yet',
      detail: meeting?.state === 'failed' ? `The last meeting failed: ${meeting.error || 'no reason given'}` : null,
      primary: 'start',
      canStop: false,
      showNote: true,
    }
  }
  const title = meeting.title?.trim() || 'Untitled meeting'
  if (meeting.state === 'stopping') return { ...none, headline: 'Stopping…', detail: title }
  if (streaming) return { ...none, headline: title, canStop: true }
  if (meeting.phone) {
    return {
      headline: title,
      detail: 'This meeting takes its audio from a phone. Connect this one.',
      primary: 'connect',
      canStop: true,
      showNote: false,
    }
  }
  return { ...none, headline: modeWords(meeting), detail: title, canStop: true }
}

/** Whether captured audio is still flowing, judged from the track and context. */
export type AudioHealth = 'ok' | 'suspended' | 'ended'

export function audioHealth(trackState: MediaStreamTrackState | 'missing', contextState: string): AudioHealth {
  if (trackState !== 'live') return 'ended'
  return contextState === 'running' ? 'ok' : 'suspended'
}

/** The relay socket's URL beside the page (or beside an absolute API base). */
export function relayUrl(shuttleBase: string, location: Pick<Location, 'protocol' | 'host'>): string {
  const base = shuttleBase ? new URL(shuttleBase) : null
  const protocol = (base?.protocol ?? location.protocol) === 'https:' ? 'wss:' : 'ws:'
  const host = base?.host ?? location.host
  const prefix = base ? base.pathname.replace(/\/+$/, '') : ''
  return `${protocol}//${host}${prefix}/api/v1/meeting/audio`
}

/** The link state as words for the status line. */
export function linkWords(link: LinkState, reason: string | null): string {
  switch (link) {
    case 'idle': return 'Mic off'
    case 'opening': return 'Connecting…'
    case 'waiting': return reason ? `Holding audio: ${reason}` : 'Holding audio until hark listens'
    case 'connected': return 'Streaming to hark'
    case 'reconnecting': return 'Connection lost; reconnecting (audio held)'
    case 'refused': return reason ? `Refused: ${reason}` : 'The relay refused the mic'
    case 'ended': return reason ? `Ended: ${reason}` : 'The meeting ended'
    case 'replaced': return reason ?? 'Another device is now the microphone'
  }
}
