import { describe, expect, it } from 'vitest'
import { BUFFERED_LIMIT, type LinkState } from './phoneState'
import { RelayLink, type SocketLike } from './relay'

class FakeSocket implements SocketLike {
  binaryType: BinaryType = 'blob'
  readyState = 0
  bufferedAmount = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  sent: number[] = []
  closedWith: number | null = null
  /** Handlers as first assigned, to fire stale events after the relay detaches. */
  handlers: { onmessage: ((event: MessageEvent) => void) | null; onclose: ((event: CloseEvent) => void) | null } = {
    onmessage: null,
    onclose: null,
  }

  send(data: ArrayBuffer): void {
    this.sent.push(data.byteLength)
  }

  close(code?: number): void {
    this.closedWith = code ?? 1000
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.handlers = { onmessage: this.onmessage, onclose: this.onclose }
    this.onopen?.(new Event('open'))
  }

  status(body: object): void {
    this.onmessage?.({ data: JSON.stringify(body) } as MessageEvent)
  }

  listening(): void {
    this.open()
    this.status({ state: 'connected' })
  }

  drop(code: number, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason } as CloseEvent)
  }
}

const OPEN_TIMEOUT = 10_000

function harness() {
  const sockets: FakeSocket[] = []
  const timers: { run: () => void; ms: number; cleared: boolean }[] = []
  const links: [LinkState, string | null][] = []
  const losses: [number, number | null][] = []
  let clock = 1_000
  const relay = new RelayLink({
    url: 'wss://example/api/v1/meeting/audio?launch=L1',
    onLink: (link, reason) => links.push([link, reason]),
    onLoss: (since, until) => losses.push([since, until]),
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    setTimer: (run, ms) => {
      timers.push({ run, ms, cleared: false })
      return timers.length - 1
    },
    clearTimer: (handle) => { timers[handle as number].cleared = true },
    now: () => clock,
  })
  const backoffs = () => timers.filter((timer) => timer.ms !== OPEN_TIMEOUT).map((timer) => timer.ms)
  const runBackoff = () => timers.filter((timer) => timer.ms !== OPEN_TIMEOUT && !timer.cleared).at(-1)!.run()
  return { relay, sockets, timers, links, losses, backoffs, runBackoff, tick: (ms: number) => { clock += ms } }
}

describe('relay link', () => {
  it('sends nothing until hark listens, then streams; nothing is held for later', () => {
    const { relay, sockets, links, losses } = harness()
    relay.send(new ArrayBuffer(10))
    relay.open()
    relay.send(new ArrayBuffer(20))
    sockets[0].open()
    relay.send(new ArrayBuffer(30))
    sockets[0].status({ state: 'waiting', reason: 'hark is loading its models' })
    relay.send(new ArrayBuffer(40))
    expect(sockets[0].sent).toEqual([])
    sockets[0].status({ state: 'connected' })
    relay.send(new ArrayBuffer(50))
    expect(sockets[0].sent).toEqual([50])
    expect(links.map(([link]) => link)).toEqual(['opening', 'waiting', 'connected'])
    // Audio before hark first listened is not a loss: the page says it is loading.
    expect(losses).toEqual([])
  })

  it('a drop after listening is a loss from the drop until audio flows again', () => {
    const { relay, sockets, losses, backoffs, runBackoff, tick } = harness()
    relay.open()
    sockets[0].listening()
    tick(500)
    sockets[0].drop(1006)
    expect(relay.link).toBe('reconnecting')
    expect(relay.lostSince).toBe(1_500)
    expect(losses).toEqual([[1_500, null]])
    expect(backoffs()).toEqual([500])
    relay.send(new ArrayBuffer(8))

    runBackoff()
    expect(sockets).toHaveLength(2)
    sockets[1].drop(1006)
    expect(backoffs()).toEqual([500, 1000])
    runBackoff()
    sockets[2].listening()
    tick(2_000)
    relay.send(new ArrayBuffer(8))
    expect(sockets[2].sent).toEqual([8])
    expect(losses).toEqual([[1_500, null], [1_500, 3_500]])
    expect(relay.lostSince).toBeNull()
    // A successful open resets the backoff.
    sockets[2].drop(1006)
    expect(backoffs().at(-1)).toBe(500)
  })

  it('drops chunks while the socket cannot keep up, and counts them as lost', () => {
    const { relay, sockets, losses } = harness()
    relay.open()
    sockets[0].listening()
    sockets[0].bufferedAmount = BUFFERED_LIMIT
    relay.send(new ArrayBuffer(3_200))
    expect(sockets[0].sent).toEqual([])
    expect(losses).toEqual([[1_000, null]])
    sockets[0].bufferedAmount = 0
    relay.send(new ArrayBuffer(3_200))
    expect(sockets[0].sent).toEqual([3_200])
    expect(losses.at(-1)).toEqual([1_000, 1_000])
  })

  it('a nudge while a socket is connecting opens no second one', () => {
    const { relay, sockets, runBackoff } = harness()
    relay.open()
    sockets[0].drop(1006)
    runBackoff()
    expect(sockets).toHaveLength(2)
    relay.nudge()
    relay.nudge()
    expect(sockets).toHaveLength(2)
  })

  it('a nudge during the backoff reconnects at once, once', () => {
    const { relay, sockets } = harness()
    relay.open()
    sockets[0].drop(1006)
    relay.nudge()
    relay.nudge()
    expect(sockets).toHaveLength(2)
  })

  it('events from a superseded socket change nothing', () => {
    const { relay, sockets, timers, runBackoff } = harness()
    relay.open()
    sockets[0].listening()
    const stale = sockets[0].handlers
    sockets[0].drop(1006)
    runBackoff()
    sockets[1].listening()
    stale.onmessage?.({ data: JSON.stringify({ state: 'ended', reason: 'old' }) } as MessageEvent)
    stale.onclose?.({ code: 4410, reason: 'old' } as CloseEvent)
    expect(relay.link).toBe('connected')
    expect(sockets).toHaveLength(2)
    // The first socket's open timeout firing late does nothing either.
    timers.filter((timer) => timer.ms === OPEN_TIMEOUT)[0].run()
    expect(sockets).toHaveLength(2)
    expect(relay.link).toBe('connected')
  })

  it('stops for good on a terminal close and keeps saying why', () => {
    const { relay, sockets, links, backoffs } = harness()
    relay.open()
    sockets[0].listening()
    sockets[0].status({ state: 'ended', reason: 'the meeting has ended' })
    sockets[0].drop(4410, 'the meeting has ended')
    expect(relay.link).toBe('ended')
    expect(links.at(-1)).toEqual(['ended', 'the meeting has ended'])
    expect(backoffs()).toHaveLength(0)
    relay.close()
    expect(relay.link).toBe('ended')
  })

  it('reads another sender taking over from the close code alone', () => {
    const { relay, sockets, backoffs } = harness()
    relay.open()
    sockets[0].open()
    sockets[0].drop(4409, 'another device is now the meeting’s microphone')
    expect(relay.link).toBe('replaced')
    expect(backoffs()).toHaveLength(0)
  })

  it('closing turns the link off without a reconnect', () => {
    const { relay, sockets, backoffs } = harness()
    relay.open()
    sockets[0].open()
    relay.close()
    expect(sockets[0].closedWith).toBe(1000)
    expect(relay.link).toBe('idle')
    expect(backoffs()).toHaveLength(0)
  })

  it('a socket that never opens is given up on and retried', () => {
    const { relay, sockets, timers, backoffs } = harness()
    relay.open()
    timers.find((timer) => timer.ms === OPEN_TIMEOUT)!.run()
    expect(sockets[0].closedWith).toBe(1000)
    expect(relay.link).toBe('reconnecting')
    expect(backoffs()).toEqual([500])
  })
})
