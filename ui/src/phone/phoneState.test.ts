import { describe, expect, it } from 'vitest'
import {
  audioHealth,
  clockTime,
  closeMeaning,
  linkWords,
  parseRelayStatus,
  reconnectDelay,
  relayUrl,
} from './phoneState'

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
