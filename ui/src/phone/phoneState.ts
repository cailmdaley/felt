/**
 * The phone page's decisions, kept apart from the DOM and the audio graph so
 * the suite can hold them to account: what the screen offers for a meeting
 * state, what the relay's status frames mean, when to reconnect, and what to
 * say about audio that never reached hark. Nothing is held for later: hark
 * pads gaps with silence on its own clock, so late audio would count twice.
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

/** An open socket with more than this queued (about 2 s of audio) is not
 *  keeping up; further chunks are dropped and counted as lost. */
export const BUFFERED_LIMIT = 2 * 16_000 * 2

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
export type AudioHealth = 'ok' | 'muted' | 'suspended' | 'ended'

export function audioHealth(
  trackState: MediaStreamTrackState | 'missing',
  muted: boolean,
  contextState: string,
): AudioHealth {
  if (trackState !== 'live') return 'ended'
  if (muted) return 'muted'
  return contextState === 'running' ? 'ok' : 'suspended'
}

/**
 * The relay socket's URL beside the page (or beside an absolute API base),
 * bound to the meeting with launch id `launch`.
 */
export function relayUrl(
  shuttleBase: string,
  location: Pick<Location, 'protocol' | 'host'>,
  launch: string | null,
): string {
  const base = shuttleBase ? new URL(shuttleBase) : null
  const protocol = (base?.protocol ?? location.protocol) === 'https:' ? 'wss:' : 'ws:'
  const host = base?.host ?? location.host
  const prefix = base ? base.pathname.replace(/\/+$/, '') : ''
  const query = launch ? `?launch=${encodeURIComponent(launch)}` : ''
  return `${protocol}//${host}${prefix}/api/v1/meeting/audio${query}`
}

/** A wall-clock time as HH:MM:SS, local. */
export function clockTime(ms: number): string {
  const date = new Date(ms)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}

/**
 * The status line. `lostSince` is when audio stopped reaching hark after it
 * had been listening (a drop, or a socket that could not keep up).
 */
export function linkWords(link: LinkState, reason: string | null, lostSince: number | null = null): string {
  if (lostSince !== null && !TERMINAL_LINKS.has(link) && link !== 'idle') {
    return link === 'connected'
      ? `The connection can’t keep up — audio lost since ${clockTime(lostSince)}`
      : `Reconnecting — audio lost since ${clockTime(lostSince)}`
  }
  switch (link) {
    case 'idle': return 'Mic off'
    case 'opening': return 'Connecting…'
    case 'waiting': return 'Loading models — speech isn’t captured until Listening'
    case 'connected': return 'Listening'
    case 'reconnecting': return 'Reconnecting — speech isn’t captured until Listening'
    case 'refused': return reason ? `Refused: ${reason}` : 'The relay refused the mic'
    case 'ended': return reason ? `Ended: ${reason}` : 'The meeting ended'
    case 'replaced': return reason ?? 'Another device is now the microphone'
  }
}
