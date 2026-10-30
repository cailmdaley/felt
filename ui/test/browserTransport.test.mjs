import { describe, expect, it, vi } from 'vitest'
import { chromium } from 'playwright-core'
import { sharedCDPTransport } from '../e2e/browser.mjs'

class Socket {
  static instance
  readyState = 0
  sent = []
  listeners = new Map()
  constructor() { Socket.instance = this }
  addEventListener(name, listener) { this.listeners.set(name, listener) }
  emit(name, event = {}) { this.listeners.get(name)?.(event) }
  open() { this.readyState = 1; this.emit('open') }
  send(text) { this.sent.push(JSON.parse(text)); this.respond?.(JSON.parse(text)) }
  receive(message) { this.emit('message', { data: JSON.stringify(message) }) }
  close() { this.readyState = 3; this.emit('close', { reason: 'closed' }) }
}

const orphan = {
  method: 'Target.attachedToTarget',
  params: { sessionId: 'this-client-worker', waitingForDebugger: false,
    targetInfo: { targetId: 'foreign-worker', type: 'service_worker', title: 'extension worker',
      url: 'chrome-extension://nkeimhogjdpnpccoofpliimaahmaaome/thunk.js', attached: true, canAccessOpener: false } },
}

describe('shared CDP transport', () => {
  it('detaches only its contextless root attachment and preserves other protocol traffic', () => {
    const transport = sharedCDPTransport('ws://isolated.test', Socket), socket = Socket.instance
    const receive = transport.onmessage = vi.fn()
    transport.send({ id: 1, method: 'Browser.getVersion' })
    expect(socket.sent).toEqual([])
    socket.open()
    socket.receive(orphan)
    expect(socket.sent).toEqual([{ id: 1, method: 'Browser.getVersion' },
      { id: -1, method: 'Target.detachFromTarget', params: { sessionId: 'this-client-worker' } }])
    socket.receive({ id: -1, result: {} })
    expect(receive).not.toHaveBeenCalled()
    const forwarded = [
      { id: 1, result: { product: 'Chrome/151' } },
      { ...orphan, sessionId: 'parent-page' },
      { ...orphan, params: { ...orphan.params, targetInfo: { ...orphan.params.targetInfo, browserContextId: 'owned-context' } } },
      { ...orphan, params: { ...orphan.params, targetInfo: { type: 'browser' } } },
      { ...orphan, params: { ...orphan.params, sessionId: undefined } },
    ]
    for (const message of forwarded) socket.receive(message)
    expect(receive.mock.calls.map(([message]) => message)).toEqual(forwarded.map(message => JSON.parse(JSON.stringify(message))))
    expect(socket.sent).toHaveLength(2)
    const close = transport.onclose = vi.fn()
    transport.close()
    expect(close).toHaveBeenCalledWith('closed')
  })

  it('reports a failed socket through the transport close callback', () => {
    const transport = sharedCDPTransport('ws://isolated.test', Socket), socket = Socket.instance
    const close = transport.onclose = vi.fn()
    socket.emit('error', { message: 'connection refused' })
    socket.close()
    expect(close).toHaveBeenCalledWith('connection refused')
  })

  it('rejects a Playwright connection when the socket fails before opening', async () => {
    const transport = sharedCDPTransport('ws://isolated.test', Socket), socket = Socket.instance
    const connecting = chromium.connectOverCDP(transport, { noDefaults: true })
    queueMicrotask(() => {
      socket.emit('error', { message: 'connection refused' })
      socket.close()
    })
    await expect(connecting).rejects.toThrow('connection refused')
  })

  it('connects Playwright when Chrome reports the upstream contextless service worker event', async () => {
    const transport = sharedCDPTransport('ws://isolated.test', Socket), socket = Socket.instance
    socket.respond = message => queueMicrotask(() => {
      if (message.method === 'Target.setAutoAttach') socket.receive(orphan)
      const result = message.method === 'Browser.getVersion'
        ? { product: 'Chrome/151.0.0', userAgent: 'HeadlessChrome/151.0.0', revision: '123' }
        : message.method === 'Target.getTargetInfo'
          ? { targetInfo: { type: 'browser', targetId: 'browser' } } : {}
      socket.receive({ id: message.id, result })
    })
    socket.open()
    const browser = await chromium.connectOverCDP(transport, { noDefaults: true })
    try {
      expect(browser.isConnected()).toBe(true)
      expect(socket.sent.filter(message => message.method === 'Target.detachFromTarget'))
        .toEqual([{ id: expect.any(Number), method: 'Target.detachFromTarget', params: { sessionId: 'this-client-worker' } }])
    } finally { await browser.close() }
    expect(socket.readyState).toBe(3)
  })
})
