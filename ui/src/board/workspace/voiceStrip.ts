import type { MeetingRecord } from '../meeting.js'
import type { VoiceStatus } from '../voice.js'

/** Where spoken words go right now: following the view, into a meeting, or nowhere. */
export interface VoiceLine {
  mode: 'off' | 'following' | 'meeting'
  name: string
  paused: boolean
}

/**
 * Where words go: a meeting the board observes, named by its fiber, else the
 * daemon's `mode` / `destination` / `paused`, else the live voice target from
 * a daemon that predates them. `meetingName` names a meeting's fiber.
 */
export function voiceLine(meeting: MeetingRecord | null, voice: VoiceStatus | null, meetingName: (meeting: MeetingRecord) => string | undefined): VoiceLine {
  if (meeting && meeting.state !== 'failed') {
    return { mode: 'meeting', name: meetingName(meeting) ?? meeting.fiber?.split('/').at(-1) ?? meeting.title?.trim() ?? 'a meeting', paused: !!meeting.paused }
  }
  if (voice?.available && voice.mode && voice.mode !== 'off') {
    return { mode: voice.mode, name: voice.destination?.name ?? 'Rex', paused: !!voice.paused }
  }
  if (voice?.available && voice.enabled && voice.state === 'yielded') return { mode: 'meeting', name: 'a recording', paused: false }
  if (voice?.available && voice.enabled && voice.state !== 'failed') {
    return { mode: 'following', name: voice.target?.name ?? 'Rex', paused: voice.muted }
  }
  return { mode: 'off', name: '', paused: false }
}

/** The strip's one line, or nothing when the mic is off. */
export function voiceWords(line: VoiceLine): string {
  if (line.mode === 'off') return ''
  // The state leads, so a long name's ellipsis never hides it; Listen's icon tells a meeting from following.
  return `${line.paused ? 'Paused' : line.mode === 'meeting' ? 'Meeting' : 'Following'} → ${line.name}`
}

/** The band's voice strip: one line saying where the words go. */
export class VoiceStrip {
  readonly el = document.createElement('span')

  constructor() {
    this.el.className = 'ws-voice-strip'
    this.el.dataset.part = 'voice-strip'
    this.el.hidden = true
  }

  paint(line: VoiceLine): void {
    const words = voiceWords(line)
    this.el.hidden = !words
    this.el.dataset.mode = line.mode
    this.el.toggleAttribute('data-paused', line.paused)
    if (this.el.textContent !== words) this.el.textContent = words
    this.el.title = words ? `Your words go to ${line.name}${line.paused ? ', once the mic resumes' : ''}` : ''
  }
}
