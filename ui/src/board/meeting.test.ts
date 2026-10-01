import { describe, expect, it } from 'vitest'
import {
  formatMeetingDuration,
  joinDeliveryPhrase,
  meetingJoinable,
  meetingActions,
  meetingDuration,
  meetingPollDelay,
  meetingStateWord,
  MeetingStopGuard,
  parseMeetingStatus,
  parseTranscriptLine,
  seatMeetingHost,
  type MeetingRecord,
} from './meeting'
import type { KanbanCard } from './KanbanTypes'

const meeting = (overrides: Partial<MeetingRecord> = {}): MeetingRecord => ({
  state: 'live',
  title: 'Shear telecon',
  started_at: '2026-09-25T12:00:00Z',
  tail: [],
  transcript: null,
  mirror_host: null,
  fiber: null,
  joined: false,
  phone: false,
  launch: null,
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

describe('joining a meeting to a constitution', () => {
  it('reads the joined fiber off the wire row', () => {
    expect(parseMeetingStatus({ available: true, meeting: meeting({ fiber: 'loom/shear' }) })?.meeting?.fiber)
      .toBe('loom/shear')
    expect(parseMeetingStatus({ available: true, meeting: { state: 'live' } })?.meeting?.fiber).toBeNull()
  })

  it('offers a start only while hark is here and nothing records', () => {
    expect(meetingJoinable({ available: true, meeting: null })).toBe(true)
    expect(meetingJoinable({ available: true, meeting: meeting({ state: 'failed' }) })).toBe(true)
    expect(meetingJoinable({ available: true, meeting: meeting() })).toBe(false)
    expect(meetingJoinable({ available: true, meeting: meeting({ state: 'starting' }) })).toBe(false)
    expect(meetingJoinable({ available: false, meeting: null })).toBe(false)
  })

  it('says how the worker received the meeting', () => {
    expect(joinDeliveryPhrase('message')).toBe('its worker has the meeting')
    expect(joinDeliveryPhrase('resume')).toBe('resumed with the meeting')
    expect(joinDeliveryPhrase('dispatch')).toBe('started with the meeting')
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

describe('a meeting on its card', () => {
  const card = (id: string, extra: Partial<KanbanCard> = {}): KanbanCard =>
    ({ id, name: id, path: `${id}.md`, originId: 'local', status: 'active', createdAt: '2026-09-25', ...extra }) as KanbanCard
  const desk = () => ({
    drafts: [card('loom/draft')],
    inFlight: [card('loom/running'), card('loom/other')],
    awaitingReview: [card('loom/review'), card('loom/scribe')],
  })

  it('reads the tail and whether the fiber was joined off the wire row', () => {
    const row = parseMeetingStatus({
      available: true,
      meeting: { ...meeting(), tail: ['14:03:12 S2  hello', 7], fiber: 'loom/scribe', joined: false },
    })?.meeting
    expect(row?.tail).toEqual(['14:03:12 S2  hello'])
    expect(row?.joined).toBe(false)
    expect(parseMeetingStatus({ available: true, meeting: { ...meeting(), joined: true } })?.meeting?.joined).toBe(true)
    expect(parseMeetingStatus({ available: true, meeting: { ...meeting(), phone: true } })?.meeting?.phone).toBe(true)
    expect(parseMeetingStatus({ available: true, meeting: { state: 'live' } })?.meeting?.phone).toBe(false)
    expect(parseMeetingStatus({ available: true, meeting: { state: 'live' } })?.meeting?.tail).toEqual([])
  })

  it('seats a joined constitution at the top of In flight, lifted from its column', () => {
    const { now, host } = seatMeetingHost(desk(), meeting({ fiber: 'loom/draft' }))
    expect(host?.id).toBe('loom/draft')
    expect(now.drafts).toEqual([])
    expect(now.inFlight.map((c) => c.id)).toEqual(['loom/draft', 'loom/running', 'loom/other'])
  })

  it('moves a running host to the top rather than duplicating it', () => {
    const { now } = seatMeetingHost(desk(), meeting({ fiber: 'loom/other' }))
    expect(now.inFlight.map((c) => c.id)).toEqual(['loom/other', 'loom/running'])
  })

  it('seats a capture scribe\'s card once the daemon has found its fiber', () => {
    const { now, host } = seatMeetingHost(desk(), meeting({ fiber: 'loom/scribe', joined: false }))
    expect(host?.id).toBe('loom/scribe')
    expect(now.awaitingReview.map((c) => c.id)).toEqual(['loom/review'])
  })

  it('leaves the desk alone when the meeting has no card on it', () => {
    const columns = desk()
    for (const row of [null, meeting(), meeting({ fiber: 'loom/elsewhere' }), meeting({ fiber: 'loom/unseen', joined: false })]) {
      const seated = seatMeetingHost(columns, row)
      expect(seated.host).toBeNull()
      expect(seated.now).toBe(columns)
    }
  })

  it('splits a transcript line into stamp, speaker and words', () => {
    expect(parseTranscriptLine('14:03:12 S2  so the covariance looks fine')).toEqual({
      time: '14:03:12', end: null, speaker: 'S2', text: 'so the covariance looks fine',
    })
    expect(parseTranscriptLine('14:03:12-14:03:20 S2  so the covariance looks fine')).toEqual({
      time: '14:03:12', end: '14:03:20', speaker: 'S2', text: 'so the covariance looks fine',
    })
    expect(parseTranscriptLine('unstamped words')).toEqual({ time: null, end: null, speaker: null, text: 'unstamped words' })
  })
})
