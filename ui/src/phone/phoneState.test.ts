import { describe, expect, it } from 'vitest'
import type { MeetingRecord, MeetingStatus } from '../board/meeting'
import {
  audioHealth,
  clockTime,
  closeMeaning,
  linkWords,
  parseRelayStatus,
  phoneView,
  reconnectDelay,
  relayUrl,
} from './phoneState'

const meeting = (overrides: Partial<MeetingRecord> = {}): MeetingRecord => ({
  state: 'live',
  title: 'Lunch with Martin',
  started_at: '2026-10-01T12:00:00Z',
  tail: [],
  transcript: null,
  mirror_host: null,
  fiber: null,
  joined: false,
  phone: true,
  launch: 'L1',
  tmux_session: 'hark-meeting',
  error: null,
  ...overrides,
})

const status = (row: MeetingRecord | null, available = true): MeetingStatus => ({ available, meeting: row })
const view = (s: MeetingStatus | null, more: Partial<Parameters<typeof phoneView>[0]> = {}) =>
  phoneView({ status: s, reachable: true, streaming: false, starting: false, ...more })

describe('relay status frames', () => {
  it('reads the relay’s states and ignores anything else', () => {
    expect(parseRelayStatus('{"state":"waiting","reason":"hark is loading"}')).toEqual({
      state: 'waiting', reason: 'hark is loading',
    })
    expect(parseRelayStatus('{"state":"dancing"}')).toBeNull()
    expect(parseRelayStatus('not json')).toBeNull()
    expect(parseRelayStatus('[1]')).toBeNull()
  })

  it('a close is terminal when the last frame or the code says so, else worth a reconnect', () => {
    const ended = parseRelayStatus('{"state":"ended","reason":"the meeting has ended"}')
    expect(closeMeaning(1006, ended)).toBe('ended')
    expect(closeMeaning(4409, null)).toBe('replaced')
    expect(closeMeaning(4404, null)).toBe('refused')
    expect(closeMeaning(4410, null)).toBe('ended')
    expect(closeMeaning(1006, null)).toBe('reconnecting')
    expect(closeMeaning(1001, parseRelayStatus('{"state":"connected"}'))).toBe('reconnecting')
  })

  it('backs off from half a second to eight', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelay)).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000])
  })
})

describe('the status line', () => {
  it('says plainly when speech is not being captured', () => {
    expect(linkWords('waiting', 'hark is loading its models')).toBe('Loading models — speech isn’t captured until Listening')
    expect(linkWords('connected', null)).toBe('Listening')
    const since = new Date(2026, 9, 1, 14, 3, 7).getTime()
    expect(clockTime(since)).toBe('14:03:07')
    expect(linkWords('reconnecting', null, since)).toBe('Reconnecting — audio lost since 14:03:07')
    expect(linkWords('waiting', null, since)).toBe('Reconnecting — audio lost since 14:03:07')
    expect(linkWords('connected', null, since)).toMatch(/audio lost since 14:03:07/)
    expect(linkWords('ended', 'the meeting has ended', since)).toBe('Ended: the meeting has ended')
  })
})

describe('what the screen offers', () => {
  it('offers Start, with the note, when nothing records', () => {
    expect(view(status(null))).toMatchObject({ primary: 'start', showNote: true, canStop: false })
  })

  it('offers Start again after a failure and says what failed', () => {
    const v = view(status(meeting({ state: 'failed', error: 'no models' })))
    expect(v.primary).toBe('start')
    expect(v.detail).toContain('no models')
  })

  it('offers Connect mic for a live phone meeting this page is not feeding', () => {
    for (const state of ['loading', 'live'] as const) {
      expect(view(status(meeting({ state })))).toMatchObject({ primary: 'connect', canStop: true, headline: 'Lunch with Martin' })
    }
  })

  it('offers only Stop while streaming', () => {
    expect(view(status(meeting()), { streaming: true })).toMatchObject({ primary: null, canStop: true })
  })

  it('names a meeting on the Mac’s own mic and offers no mic of its own', () => {
    const v = view(status(meeting({ phone: false })))
    expect(v.primary).toBeNull()
    expect(v.canStop).toBe(true)
    expect(v.headline).toMatch(/Mac’s own mic/)
  })

  it('says when hark is missing, the daemon is out of reach, or a stop is underway', () => {
    expect(view(status(null, false))).toMatchObject({ primary: null, headline: expect.stringMatching(/hark/) })
    expect(view(status(null), { reachable: false })).toMatchObject({ primary: null, headline: 'Can’t reach Shuttle' })
    expect(view(status(null), { reachable: false, streaming: true }).canStop).toBe(true)
    expect(view(status(meeting({ state: 'stopping' })))).toMatchObject({ primary: null, canStop: false })
    expect(view(status(null), { starting: true })).toMatchObject({ primary: null, headline: 'Starting the meeting…' })
    expect(view(null).primary).toBeNull()
  })
})

describe('audio health and the relay URL', () => {
  it('reads a live track in a running context as healthy', () => {
    expect(audioHealth('live', false, 'running')).toBe('ok')
    expect(audioHealth('live', true, 'running')).toBe('muted')
    expect(audioHealth('live', false, 'suspended')).toBe('suspended')
    expect(audioHealth('live', false, 'interrupted')).toBe('suspended')
    expect(audioHealth('ended', false, 'running')).toBe('ended')
    expect(audioHealth('missing', false, 'running')).toBe('ended')
  })

  it('puts the relay beside the page, secure when the page is, bound to the meeting', () => {
    expect(relayUrl('', { protocol: 'https:', host: 'mac.tailnet.example' }, 'a+b/c')).toBe('wss://mac.tailnet.example/api/v1/meeting/audio?launch=a%2Bb%2Fc')
    expect(relayUrl('', { protocol: 'http:', host: '127.0.0.1:4000' }, null)).toBe('ws://127.0.0.1:4000/api/v1/meeting/audio')
    expect(relayUrl('http://127.0.0.1:4000/', { protocol: 'https:', host: 'x' }, 'L1')).toBe('ws://127.0.0.1:4000/api/v1/meeting/audio?launch=L1')
  })
})
