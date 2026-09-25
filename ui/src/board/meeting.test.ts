import { describe, expect, it } from 'vitest'
import {
  formatMeetingDuration,
  meetingActions,
  meetingDuration,
  meetingPollDelay,
  meetingStateWord,
  MeetingStopGuard,
  parseMeetingStatus,
  type MeetingRecord,
} from './meeting'

const meeting = (overrides: Partial<MeetingRecord> = {}): MeetingRecord => ({
  state: 'live',
  title: 'Shear telecon',
  started_at: '2026-09-25T12:00:00Z',
  last_line: null,
  transcript: null,
  mirror_host: null,
  tmux_session: 'hark-meeting',
  error: null,
  ...overrides,
})

describe('meeting wire status', () => {
  it('accepts the contract row and rejects unknown states', () => {
    expect(parseMeetingStatus({ available: true, meeting: meeting() })).toMatchObject({
      available: true,
      meeting: { state: 'live', mirror_host: null },
    })
    expect(parseMeetingStatus({ available: true, meeting: { state: 'booting' } })).toBeNull()
  })
})

describe('meeting state words and actions', () => {
  it.each([
    ['starting', 'Starting'],
    ['loading', 'Loading'],
    ['live', 'Recording'],
    ['stopping', 'Stopping'],
    ['failed', 'Failed'],
  ] as const)('names %s as %s', (state, word) => {
    expect(meetingStateWord(state)).toBe(word)
  })

  it.each([
    ['starting', true, true, false, false],
    ['loading', true, true, false, false],
    ['live', true, true, false, false],
    ['stopping', true, true, true, false],
    ['failed', true, false, false, true],
  ] as const)('offers the right actions in %s', (state, terminal, stop, stopDisabled, dismiss) => {
    expect(meetingActions(meeting({ state }))).toEqual({ terminal, stop, stopDisabled, dismiss })
  })

  it('disables Stop while this meeting has a request in flight', () => {
    expect(meetingActions(meeting(), true).stopDisabled).toBe(true)
    expect(meetingActions(meeting({ tmux_session: null })).terminal).toBe(false)
  })
})

describe('meeting poll cadence', () => {
  it('uses two seconds for a visible meeting and the board cadence for idle or failed reads', () => {
    expect(meetingPollDelay(true, true, meeting())).toBe(2_000)
    expect(meetingPollDelay(true, true, null)).toBe(15_000)
    expect(meetingPollDelay(true, false, meeting())).toBe(15_000)
  })

  it('pauses while hidden and resumes with the current cadence when visible', () => {
    expect(meetingPollDelay(false, true, meeting())).toBeNull()
    expect(meetingPollDelay(true, true, meeting({ state: 'failed' }))).toBe(2_000)
  })
})

describe('meeting stop guard', () => {
  it('allows one request until polling observes stopping, failure, or absence', () => {
    const guard = new MeetingStopGuard()
    const live = meeting()
    expect(guard.request(live)).toBe(true)
    expect(guard.request(live)).toBe(false)
    expect(guard.isRequested(live)).toBe(true)

    guard.observe(meeting({ state: 'stopping' }))
    expect(guard.isRequested(meeting({ state: 'stopping' }))).toBe(false)
    expect(guard.request(meeting({ state: 'stopping' }))).toBe(false)

    guard.observe(null)
    expect(guard.request(live)).toBe(true)
    guard.observe(meeting({ state: 'failed' }))
    expect(guard.request(meeting({ state: 'failed' }))).toBe(true)
  })

  it('carries a request from a starting row to its timestamped poll row', () => {
    const guard = new MeetingStopGuard()
    const starting = meeting({ state: 'starting', started_at: null })
    const live = meeting({ state: 'live' })
    expect(guard.request(starting)).toBe(true)
    guard.observe(live)
    expect(guard.isRequested(live)).toBe(true)
    expect(guard.request(live)).toBe(false)
  })
})

describe('meeting duration', () => {
  it('formats minutes and hours and omits duration while starting or without a timestamp', () => {
    const now = Date.parse('2026-09-25T14:03:12Z')
    expect(formatMeetingDuration('2026-09-25T14:01:09Z', now)).toBe('2:03')
    expect(formatMeetingDuration('2026-09-25T13:01:09Z', now)).toBe('1:02:03')
    expect(formatMeetingDuration('2026-09-25T14:04:00Z', now)).toBe('0:00')
    expect(meetingDuration(meeting({ state: 'starting', started_at: null }), now)).toBeNull()
    expect(meetingDuration(meeting({ state: 'loading', started_at: null }), now)).toBeNull()
    expect(meetingDuration(meeting(), now)).toBe('2:03:12')
    expect(meetingDuration(meeting({ started_at: 'not a date' }), now)).toBeNull()
  })
})
