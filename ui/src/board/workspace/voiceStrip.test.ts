import { describe, expect, it } from 'vitest'
import { voiceLine, voiceWords } from './voiceStrip.js'
import type { MeetingRecord } from '../meeting.js'
import type { VoiceStatus } from '../voice.js'

const voice = (patch: Partial<VoiceStatus> = {}): VoiceStatus => ({ available: true, enabled: true, muted: false, state: 'listening', target: { fiber_id: 'u', origin: 'h', name: 'Career futures' }, last: null, error: null, ...patch })
const meeting = (patch: Partial<MeetingRecord> = {}): MeetingRecord => ({ state: 'live', title: 'Call', started_at: null, tail: [], transcript: null, mirror_host: null, fiber: 'ai-futures/felt/debug', joined: true, phone: false, launch: 'L', tmux_session: null, error: null, ...patch })
const said = (m: MeetingRecord | null, v: VoiceStatus | null): string => voiceWords(voiceLine(m, v, () => undefined))

describe('the voice strip', () => {
  it('names the live voice target while following', () => {
    expect(said(null, voice())).toBe('Following → Career futures')
    expect(said(null, voice({ muted: true }))).toBe('Following → Career futures · paused')
  })
  it('names the meeting\'s fiber while a meeting holds the mic, over the voice target', () => {
    expect(said(meeting(), voice({ state: 'yielded' }))).toBe('Meeting → debug')
    expect(said(meeting({ paused: true }), null)).toBe('Meeting → debug · paused')
    expect(said(null, voice({ state: 'yielded' }))).toBe('Meeting → a recording')
  })
  it('says nothing when the mic is off or the meeting failed, and holds a stopping meeting until it ends', () => {
    expect(said(null, null)).toBe('')
    expect(said(null, voice({ enabled: false }))).toBe('')
    expect(said(meeting({ state: 'failed' }), null)).toBe('')
    expect(said(meeting({ state: 'stopping' }), null)).toBe('Meeting → debug')
  })
  it('reads the daemon\'s mode, destination and paused when it reports them', () => {
    expect(said(null, voice({ mode: 'meeting', destination: { fiber_id: 'x', origin: 'h', name: 'Standup' }, paused: true }))).toBe('Meeting → Standup · paused')
    expect(said(null, voice({ mode: 'following', destination: { fiber_id: 'u', origin: 'h', name: 'Two columns' }, paused: false }))).toBe('Following → Two columns')
    expect(said(null, voice({ mode: 'off', enabled: false }))).toBe('')
  })
})
