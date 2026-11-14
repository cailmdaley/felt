import type { VoiceStatus } from '../voice.js'

export type FiberSlug = (fiber: string, origin?: string | null) => string | undefined
export type ListenMode = 'off' | 'following' | 'pinned' | 'meeting'
export interface VoiceLine {
  mode: ListenMode
  name: string
  paused: boolean
  /** The card has no live session, so words are held in the transcript, not sent. */
  held: boolean
}

/** What reaches a card with no live session. */
export const heldWords = (name: string): string =>
  `${name} has no live session: words stay in the transcript. End with “send” to start one.`

/** A meeting is Listen pinned to a card with the computer's audio transcribed too. */
export const listenMode = (voice: VoiceStatus | null): ListenMode =>
  !voice?.enabled ? 'off' : voice.system_audio ? 'meeting' : voice.follow ? 'following' : 'pinned'

const PREFIX: Record<ListenMode, string> = { off: '', following: '', pinned: '📌 ', meeting: '⏺ ' }
const SAYS: Record<ListenMode, string> = { off: '', following: 'Following you: words go to', pinned: 'Pinned: words go to', meeting: 'Meeting: the mic and the computer’s audio go to' }

/** The slug spoken words reach, independent of the card showing the console. */
export function voiceLine(voice: VoiceStatus | null, slugOf: FiberSlug): VoiceLine {
  if (!voice?.enabled) return { mode: 'off', name: '', paused: false, held: false }
  const target = voice.destination ?? voice.target
  const name = target ? slugOf(target.fiber_id, target.origin) ?? target.fiber_id.split('/').at(-1) ?? target.name : ''
  return { mode: listenMode(voice), name, paused: voice.muted, held: !!voice.cold }
}

export class VoiceStrip {
  readonly el = document.createElement('span')
  constructor() {
    this.el.className = 'ws-voice-strip'
    this.el.dataset.part = 'voice-strip'
    this.el.hidden = true
  }
  paint(line: VoiceLine): void {
    const words = line.mode === 'off' || !line.name ? '' : `${PREFIX[line.mode]}${line.name}`
    this.el.hidden = !words
    this.el.dataset.mode = line.mode
    this.el.toggleAttribute('data-paused', line.paused)
    this.el.toggleAttribute('data-held', line.held)
    if (this.el.textContent !== words) this.el.textContent = words
    this.el.title = !words ? '' : line.held ? heldWords(line.name)
      : `${SAYS[line.mode]} ${line.name}${line.paused ? ' once unmuted' : ''}`
  }
}
