/**
 * Relay status, audio health, reconnect timing and words for lost audio.
 * Nothing is held for later: hark pads gaps with silence on its own clock,
 * so late audio would count twice.
 */

/** The relay socket's state. */
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
