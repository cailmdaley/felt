import type { VoiceStatus } from '../voice.js'

export type FiberSlug = (fiber: string, origin?: string | null) => string | undefined
export interface VoiceLine {
  mode: 'off' | 'following' | 'pinned'
  name: string
  paused: boolean
}

/** The slug spoken words reach, independent of the card showing the console. */
export function voiceLine(voice: VoiceStatus | null, slugOf: FiberSlug): VoiceLine {
  if (!voice?.enabled) return { mode: 'off', name: '', paused: false }
  const target = voice.destination ?? voice.target
  const name = target ? slugOf(target.fiber_id, target.origin) ?? target.fiber_id.split('/').at(-1) ?? target.name : ''
  return { mode: voice.follow ? 'following' : 'pinned', name, paused: voice.muted }
}

export class VoiceStrip {
  readonly el = document.createElement('span')
  constructor() {
    this.el.className = 'ws-voice-strip'
    this.el.dataset.part = 'voice-strip'
    this.el.hidden = true
  }
  paint(line: VoiceLine): void {
    const words = line.mode === 'off' || !line.name ? '' : `${line.mode === 'pinned' ? '📌 ' : ''}${line.name}`
    this.el.hidden = !words
    this.el.dataset.mode = line.mode
    this.el.toggleAttribute('data-paused', line.paused)
    if (this.el.textContent !== words) this.el.textContent = words
    this.el.title = words ? `${line.mode === 'pinned' ? 'Pinned: words go to' : 'Following you: words go to'} ${line.name}${line.paused ? ' once unmuted' : ''}` : ''
  }
}
