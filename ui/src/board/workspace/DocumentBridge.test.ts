// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectDocumentFrame, documentMessage, envelope } from './DocumentBridge.js'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

describe('bounded document messages', () => {
  it('caps reference candidates and rejects oversized payloads of every bridge type', () => {
    expect(documentMessage(envelope('references', { candidates: Array(500).fill('a'.repeat(256)) }))).toBe(true)
    expect(documentMessage(envelope('references', { candidates: Array(501).fill('a') }))).toBe(false)
    expect(documentMessage(envelope('references', { candidates: ['a'.repeat(257)] }))).toBe(false)
    expect(documentMessage(envelope('references', { candidates: Array(2) }))).toBe(false)
    for (const type of ['ready', 'media', 'key', 'scroll', 'select', 'play', 'pause', 'restore', 'active', 'references:scan', 'references:resolved', 'references:playback']) {
      expect(documentMessage(envelope(type, { excess: 'x'.repeat(4096) })), type).toBe(false)
    }
    expect(documentMessage(envelope('key', { key: 'x'.repeat(65) }))).toBe(false)
    expect(documentMessage(envelope('select', { candidate: 'x'.repeat(257) }))).toBe(false)
    expect(documentMessage(envelope('unknown', {}))).toBe(false)
    expect(documentMessage(envelope('scroll', { x: 0, y: Infinity }))).toBe(false)
    expect(documentMessage(envelope('key', { key: 'ArrowRight', altKey: 'yes' }))).toBe(false)
    expect(documentMessage(envelope('references:resolved', { targets: [{ candidate: 'a', title: 'a'.repeat(257), audio: false }] }))).toBe(false)
  })

  it('accepts no more than four reference batches in any second per frame and disposes its budget', () => {
    const frame = document.createElement('iframe'); document.body.append(frame)
    const receive = vi.fn()
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
    const bridge = connectDocumentFrame(frame, receive)
    const send = () => window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow, data: envelope('references', { candidates: ['report.html'] }),
    }))
    for (let i = 0; i < 20; i++) send()
    expect(receive).toHaveBeenCalledTimes(4)
    now.mockReturnValue(1999); send()
    expect(receive).toHaveBeenCalledTimes(4)
    now.mockReturnValue(2000); send()
    expect(receive).toHaveBeenCalledTimes(5)
    const other = document.createElement('iframe'); document.body.append(other)
    const otherReceive = vi.fn()
    const second = connectDocumentFrame(other, otherReceive)
    window.dispatchEvent(new MessageEvent('message', { source: other.contentWindow, data: envelope('references', { candidates: [] }) }))
    expect(otherReceive).toHaveBeenCalledOnce()
    bridge.dispose(); send()
    expect(receive).toHaveBeenCalledTimes(5)
    second.dispose()
  })

  it('delivers the newest deferred batch when the window reopens and survives a backward clock', () => {
    vi.useFakeTimers()
    try {
      const frame = document.createElement('iframe'); document.body.append(frame)
      const receive = vi.fn()
      const now = vi.spyOn(performance, 'now').mockReturnValue(100_000)
      const bridge = connectDocumentFrame(frame, receive)
      const send = (candidate: string) => window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow, data: envelope('references', { candidates: [candidate] }),
      }))
      for (let i = 0; i < 6; i++) send(`r${i}`)
      expect(receive).toHaveBeenCalledTimes(4)
      now.mockReturnValue(101_000); vi.advanceTimersByTime(1000)
      expect(receive).toHaveBeenCalledTimes(5)
      expect(receive.mock.lastCall![0].payload.candidates).toEqual(['r5'])
      // A clock stepped into the past must not pin the budget's entries in the future.
      for (let i = 0; i < 3; i++) send(`s${i}`)
      now.mockReturnValue(0); send('late')
      expect(receive.mock.lastCall![0].payload.candidates).toEqual(['late'])
      bridge.dispose()
    } finally { vi.useRealTimers() }
  })
})
