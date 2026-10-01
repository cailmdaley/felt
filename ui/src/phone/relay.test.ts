import { describe, expect, it } from 'vitest'
import { ChunkQueue, type LinkState } from './phoneState'
import { RelayLink, type SocketLike } from './relay'

class FakeSocket implements SocketLike {
  binaryType: BinaryType = 'blob'
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  sent: number[] = []
  closedWith: number | null = null

  send(data: ArrayBuffer): void {
    this.sent.push(data.byteLength)
  }

  close(code?: number): void {
    this.closedWith = code ?? 1000
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  status(body: object): void {
    this.onmessage?.({ data: JSON.stringify(body) } as MessageEvent)
  }

  drop(code: number, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason } as CloseEvent)
  }
}

/** The reconnect delays scheduled, leaving out each socket's open timeout. */
const backoffs = (timers: { ms: number }[]): number[] =>
  timers.map((timer) => timer.ms).filter((ms) => ms !== 10_000)

function harness() {
  const sockets: FakeSocket[] = []
  const timers: { run: () => void; ms: number }[] = []
  const links: [LinkState, string | null][] = []
  const relay = new RelayLink({
    url: 'wss://example/api/v1/meeting/audio',
    onLink: (link, reason) => links.push([link, reason]),
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    setTimer: (run, ms) => {
      timers.push({ run, ms })
      return timers.length
    },
    clearTimer: () => {},
    queue: new ChunkQueue(1_000),
  })
  return { relay, sockets, timers, links }
}

describe('relay link', () => {
  it('holds audio until the socket opens, then sends it in order, then streams', () => {
    const { relay, sockets, links } = harness()
    relay.send(new ArrayBuffer(10))
    relay.open()
    relay.send(new ArrayBuffer(20))
    expect(sockets).toHaveLength(1)
    expect(sockets[0].binaryType).toBe('arraybuffer')
    sockets[0].open()
    expect(sockets[0].sent).toEqual([10, 20])
    relay.send(new ArrayBuffer(30))
    expect(sockets[0].sent).toEqual([10, 20, 30])
    sockets[0].status({ state: 'waiting', reason: 'hark is loading' })
    sockets[0].status({ state: 'connected' })
    expect(links.map(([link]) => link)).toEqual(['opening', 'waiting', 'connected'])
  })

  it('reconnects with backoff after a drop, holding audio meanwhile', () => {
    const { relay, sockets, timers, links } = harness()
    relay.open()
    sockets[0].open()
    sockets[0].drop(1006)
    expect(relay.link).toBe('reconnecting')
    expect(backoffs(timers)).toEqual([500])
    relay.send(new ArrayBuffer(40))

    timers.find((timer) => timer.ms === 500)!.run()
    expect(sockets).toHaveLength(2)
    sockets[1].drop(1006)
    expect(backoffs(timers)).toEqual([500, 1000])
    timers.find((timer) => timer.ms === 1000)!.run()
    sockets[2].open()
    expect(sockets[2].sent).toEqual([40])
    // A successful open resets the backoff.
    sockets[2].drop(1006)
    expect(backoffs(timers).at(-1)).toBe(500)
    expect(links.some(([link]) => link === 'reconnecting')).toBe(true)
  })

  it('stops for good on a terminal close and keeps saying why', () => {
    const { relay, sockets, timers, links } = harness()
    relay.open()
    sockets[0].open()
    sockets[0].status({ state: 'ended', reason: 'the meeting has ended' })
    sockets[0].drop(4410, 'the meeting has ended')
    expect(relay.link).toBe('ended')
    expect(links.at(-1)).toEqual(['ended', 'the meeting has ended'])
    expect(backoffs(timers)).toHaveLength(0)
    relay.send(new ArrayBuffer(8))
    relay.close()
    expect(relay.link).toBe('ended')
  })

  it('reads another sender taking over from the close code alone', () => {
    const { relay, sockets, timers } = harness()
    relay.open()
    sockets[0].open()
    sockets[0].drop(4409, 'another device is now the meeting’s microphone')
    expect(relay.link).toBe('replaced')
    expect(backoffs(timers)).toHaveLength(0)
  })

  it('closing turns the mic link off without a reconnect', () => {
    const { relay, sockets, timers } = harness()
    relay.open()
    sockets[0].open()
    relay.close()
    expect(sockets[0].closedWith).toBe(1000)
    expect(relay.link).toBe('idle')
    expect(backoffs(timers)).toHaveLength(0)
  })

  it('a socket that never opens is given up on and retried', () => {
    const { relay, sockets, timers } = harness()
    relay.open()
    timers.find((timer) => timer.ms === 10_000)!.run()
    expect(sockets[0].closedWith).toBe(1000)
    expect(relay.link).toBe('reconnecting')
    expect(backoffs(timers)).toEqual([500])
    // An open timeout firing after the socket opened changes nothing.
    timers.find((timer) => timer.ms === 500)!.run()
    sockets[1].open()
    timers.filter((timer) => timer.ms === 10_000)[1].run()
    expect(relay.link).toBe('reconnecting')
    expect(sockets).toHaveLength(2)
  })

  it('a nudge reconnects at once instead of waiting out the backoff', () => {
    const { relay, sockets } = harness()
    relay.open()
    sockets[0].drop(1006)
    relay.nudge()
    expect(sockets).toHaveLength(2)
  })
})
