import { describe, expect, it } from 'vitest'
import {
  formatMeetingDuration,
  meetingActions,
  meetingPollInterval,
  meetingStateWord,
  parseMeetingStatus,
  type MeetingRecord,
} from './meeting'

const meeting = (overrides: Partial<MeetingRecord> = {}): MeetingRecord => ({
  state: 'live',
  title: 'Shear telecon',
  host: null,
  fiber: 'work/meetings/shear-telecon',
  started_at: '2026-09-25T12:00:00Z',
  last_line: null,
  transcript: null,
  tmux_session: 'hark-meeting',
  error: null,
  ...overrides,
})

describe('meeting wire status', () => {
  it('accepts the local status envelope and rejects unknown states', () => {
    expect(parseMeetingStatus({ available: true, meeting: meeting() })).toMatchObject({
      available: true,
      meeting: { state: 'live', host: null },
    })
    expect(parseMeetingStatus({ available: true, meeting: { state: 'booting' } })).toBeNull()
  })
})

describe('meeting state words and actions', () => {
  it.each([
    ['starting', 'Starting'],
    ['loading', 'Loading'],
    ['live', 'Live'],
    ['local', 'Local capture'],
    ['stopping', 'Stopping'],
    ['failed', 'Failed'],
  ] as const)('names %s as %s', (state, word) => {
    expect(meetingStateWord(state)).toBe(word)
  })

  it.each([
    ['starting', false, true, false, false],
    ['loading', false, true, false, false],
    ['live', true, true, false, false],
    ['local', false, true, false, false],
    ['stopping', true, true, true, false],
    ['failed', false, false, false, true],
  ] as const)('enables the right actions in %s', (state, notes, stop, stopDisabled, dismiss) => {
    expect(meetingActions(meeting({ state }))).toMatchObject({
      notes,
      terminal: true,
      stop,
      stopDisabled,
      dismiss,
    })
  })

  it('hides Notes without a fiber and Terminal without a tmux session', () => {
    expect(meetingActions(meeting({ fiber: null })).notes).toBe(false)
    expect(meetingActions(meeting({ tmux_session: null })).terminal).toBe(false)
  })
})

describe('meeting poll cadence', () => {
  it('polls with the board cadence while idle and every two seconds while a meeting exists', () => {
    expect(meetingPollInterval(null)).toBe(15_000)
    expect(meetingPollInterval(meeting({ state: 'failed' }))).toBe(2_000)
  })
})

describe('meeting duration', () => {
  it('formats minutes and hours, clamps future starts, and rejects missing timestamps', () => {
    const now = Date.parse('2026-09-25T14:03:12Z')
    expect(formatMeetingDuration('2026-09-25T14:01:09Z', now)).toBe('2:03')
    expect(formatMeetingDuration('2026-09-25T13:01:09Z', now)).toBe('1:02:03')
    expect(formatMeetingDuration('2026-09-25T14:04:00Z', now)).toBe('0:00')
    expect(formatMeetingDuration(null, now)).toBe('—')
    expect(formatMeetingDuration('not a date', now)).toBe('—')
  })
})
