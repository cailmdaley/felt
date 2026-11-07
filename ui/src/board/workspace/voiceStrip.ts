import type { MeetingRecord } from '../meeting.js'
import type { RexMove, VoiceStatus } from '../voice.js'

/** A fiber's slug from its id or uid on a host, when the board knows the card. */
export type FiberSlug = (fiber: string, origin?: string | null) => string | undefined

/** Where spoken words go right now: following the view, into a meeting, or nowhere. */
export interface VoiceLine {
  mode: 'off' | 'following' | 'meeting'
  /** The destination's slug, or its name when the board does not know the card. */
  name: string
  paused: boolean
}

/**
 * Where words go: a meeting the board observes, named by its fiber, else the
 * daemon's `mode` / `destination` / `paused`, else the live voice target from
 * a daemon that predates them. Each is named by its card's slug.
 */
export function voiceLine(meeting: MeetingRecord | null, voice: VoiceStatus | null, slugOf: FiberSlug): VoiceLine {
  const named = (move: RexMove | null | undefined): string => move ? slugOf(move.fiber_id, move.origin) ?? move.name : 'Rex'
  if (meeting && meeting.state !== 'failed') {
    const name = meeting.fiber ? slugOf(meeting.fiber, meeting.mirror_host ?? meeting.recorder) ?? meeting.fiber.split('/').at(-1) : meeting.title?.trim()
    return { mode: 'meeting', name: name || 'a meeting', paused: !!meeting.paused }
  }
  if (voice?.available && voice.mode && voice.mode !== 'off') {
    return { mode: voice.mode, name: named(voice.destination), paused: !!voice.paused }
  }
  if (voice?.available && voice.enabled && voice.state === 'yielded') return { mode: 'meeting', name: 'a recording', paused: false }
  if (voice?.available && voice.enabled && voice.state !== 'failed') {
    return { mode: 'following', name: named(voice.target), paused: voice.muted }
  }
  return { mode: 'off', name: '', paused: false }
}

/** The band's voice strip: the slug words go to, or nothing when the mic is off. Listen's icon says whether it is muted or a meeting. */
export class VoiceStrip {
  readonly el = document.createElement('span')

  constructor() {
    this.el.className = 'ws-voice-strip'
    this.el.dataset.part = 'voice-strip'
    this.el.hidden = true
  }

  paint(line: VoiceLine): void {
    const words = line.mode === 'off' ? '' : line.name
    this.el.hidden = !words
    this.el.dataset.mode = line.mode
    this.el.toggleAttribute('data-paused', line.paused)
    if (this.el.textContent !== words) this.el.textContent = words
    this.el.title = words ? `${line.mode === 'meeting' ? 'A meeting: every word goes to' : 'Following you: words go to'} ${words}${line.paused ? ' once unmuted' : ''}` : ''
  }
}
