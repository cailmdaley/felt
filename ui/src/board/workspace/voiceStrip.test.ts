import { describe, expect, it } from 'vitest'
import { voiceLine } from './voiceStrip.js'
import type { MeetingRecord } from '../meeting.js'
import type { VoiceStatus } from '../voice.js'

const voice = (patch: Partial<VoiceStatus> = {}): VoiceStatus => ({ available: true, enabled: true, muted: false, state: 'listening', target: { fiber_id: 'U1', origin: 'h', name: 'Career futures' }, last: null, error: null, ...patch })
const meeting = (patch: Partial<MeetingRecord> = {}): MeetingRecord => ({ state: 'live', title: 'Call', started_at: null, tail: [], transcript: null, mirror_host: null, fiber: 'ai-futures/felt/debug', joined: true, phone: false, launch: 'L', tmux_session: null, error: null, ...patch })
const slugs: Record<string, string> = { U1: 'career', U2: 'two-columns' }
const line = (m: MeetingRecord | null, v: VoiceStatus | null) => voiceLine(m, v, fiber => slugs[fiber])

describe('the voice strip', () => {
  it('names the live voice target by its slug while following, and its name when the board does not know it', () => {
    expect(line(null, voice())).toEqual({ mode: 'following', name: 'career', paused: false })
    expect(line(null, voice({ muted: true }))).toEqual({ mode: 'following', name: 'career', paused: true })
    expect(line(null, voice({ target: { fiber_id: 'U9', origin: 'h', name: 'Unknown card' } })).name).toBe('Unknown card')
  })
  it('names the meeting\'s fiber while a meeting holds the mic, over the voice target', () => {
    expect(line(meeting(), voice({ state: 'yielded' }))).toEqual({ mode: 'meeting', name: 'debug', paused: false })
    expect(line(meeting({ paused: true }), null)).toEqual({ mode: 'meeting', name: 'debug', paused: true })
    expect(line(null, voice({ state: 'yielded' }))).toEqual({ mode: 'meeting', name: 'a recording', paused: false })
  })
  it('says nothing when the mic is off or the meeting failed, and holds a stopping meeting until it ends', () => {
    expect(line(null, null).mode).toBe('off')
    expect(line(null, voice({ enabled: false })).mode).toBe('off')
    expect(line(meeting({ state: 'failed' }), null).mode).toBe('off')
    expect(line(meeting({ state: 'stopping' }), null).name).toBe('debug')
  })
  it('reads the daemon\'s mode, destination and paused when it reports them', () => {
    expect(line(null, voice({ mode: 'meeting', destination: { fiber_id: 'x', origin: 'h', name: 'Standup' }, paused: true }))).toEqual({ mode: 'meeting', name: 'Standup', paused: true })
    expect(line(null, voice({ mode: 'following', destination: { fiber_id: 'U2', origin: 'h', name: 'Two columns' }, paused: false }))).toEqual({ mode: 'following', name: 'two-columns', paused: false })
    expect(line(null, voice({ mode: 'off', enabled: false })).mode).toBe('off')
  })
})
