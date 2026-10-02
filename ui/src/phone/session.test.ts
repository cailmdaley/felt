import { describe, expect, it } from 'vitest'
import type { MicHandlers } from './mic'
import { clockTime, type AudioHealth, type LinkState } from './phoneState'
import { AudioSession, type LockLike, type MicLike, type RelayEvents, type RelayLike } from './session'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

class FakeMic implements MicLike {
  closed = false
  state: AudioHealth = 'ok'
  revival = deferred<AudioHealth>()
  revives = 0
  handlers: MicHandlers
  constructor(handlers: MicHandlers) { this.handlers = handlers }
  health(): AudioHealth { return this.state }
  revive(): Promise<AudioHealth> { this.revives += 1; return this.revival.promise }
  close(): void { this.closed = true }
}

class FakeRelay implements RelayLike {
  opened = false
  closed = false
  sent = 0
  nudges = 0
  launch: string | null
  events: RelayEvents
  constructor(launch: string | null, events: RelayEvents) { this.launch = launch; this.events = events }
  open(): void { this.opened = true }
  send(): void { this.sent += 1 }
  nudge(): void { this.nudges += 1 }
  close(): void { this.closed = true }
  emit(link: LinkState, reason: string | null = null): void { this.events.onLink(link, reason) }
}

class FakeLock implements LockLike {
  held = 0
  async acquire(): Promise<void> { this.held += 1 }
  async reacquire(): Promise<void> {}
  release(): void { this.held = 0 }
}

function harness() {
  const opens: { handlers: MicHandlers; result: ReturnType<typeof deferred<MicLike>> }[] = []
  const mics: FakeMic[] = []
  const relays: FakeRelay[] = []
  const lock = new FakeLock()
  let clock = 0
  const session = new AudioSession({
    openMic: (handlers) => {
      const result = deferred<MicLike>()
      opens.push({ handlers, result })
      return result.promise
    },
    createRelay: (launch, events) => {
      const relay = new FakeRelay(launch, events)
      relays.push(relay)
      return relay
    },
    lock,
    onChange: () => {},
    onLevel: () => {},
    now: () => clock,
  })
  /** Let the n-th open resolve with a fresh mic. */
  const grant = (n = opens.length - 1): FakeMic => {
    const mic = new FakeMic(opens[n].handlers)
    mics.push(mic)
    opens[n].result.resolve(mic)
    return mic
  }
  return { session, opens, mics, relays, lock, grant, tick: (ms: number) => { clock += ms } }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('audio session ownership', () => {
  it('a double tap opens one mic', async () => {
    const { session, opens, grant } = harness()
    const first = session.begin()
    const second = session.begin()
    expect(opens).toHaveLength(1)
    expect(await second).toBeNull()
    grant()
    expect(await first).not.toBeNull()
    expect(await session.begin()).toBeNull()
    expect(opens).toHaveLength(1)
  })

  it('Stop while the mic is still being granted disposes of it when it lands', async () => {
    const { session, relays, lock, grant } = harness()
    const pending = session.begin()
    session.stop()
    const mic = grant()
    expect(await pending).toBeNull()
    expect(mic.closed).toBe(true)
    expect(session.mic).toBeNull()
    expect(relays).toHaveLength(0)
    expect(lock.held).toBe(0)
  })

  it('a start whose request returns after Stop streams nothing', async () => {
    const { session, relays, grant } = harness()
    const pending = session.begin()
    const mic = grant()
    const generation = (await pending)!
    session.stop()
    session.stream(generation, 'L1')
    expect(relays).toHaveLength(0)
    expect(mic.closed).toBe(true)
  })

  it('a superseded relay’s terminal state does not end the current audio', async () => {
    const { session, relays, grant } = harness()
    const a = session.begin()
    grant()
    session.stream((await a)!, 'L1')
    session.stop()
    const b = session.begin()
    const current = grant()
    session.stream((await b)!, 'L1')
    relays[0].emit('replaced', 'another device')
    expect(current.closed).toBe(false)
    expect(session.mic).toBe(current)
    expect(session.relay).toBe(relays[1])
    expect(session.link).toBe('idle')
  })

  it('a superseded mic’s chunks and interruptions go nowhere', async () => {
    const { session, relays, mics, grant } = harness()
    const a = session.begin()
    grant()
    session.stream((await a)!, 'L1')
    const old = mics[0]
    session.stop()
    const b = session.begin()
    grant()
    session.stream((await b)!, 'L1')
    old.handlers.onChunk(new ArrayBuffer(4))
    old.handlers.onInterrupted('the mic stopped')
    expect(relays[1].sent).toBe(0)
    expect(session.needsRestore).toBe(false)
    mics[1].handlers.onChunk(new ArrayBuffer(4))
    expect(relays[1].sent).toBe(1)
  })

  it('binds the relay to the meeting’s launch', async () => {
    const { session, relays, grant } = harness()
    const pending = session.begin()
    grant()
    session.stream((await pending)!, 'launch-7')
    expect(relays[0].launch).toBe('launch-7')
    expect(relays[0].opened).toBe(true)
  })

  it('a terminal relay state releases the mic and the screen lock', async () => {
    const { session, relays, lock, grant } = harness()
    const pending = session.begin()
    const mic = grant()
    session.stream((await pending)!, 'L1')
    await settle()
    expect(lock.held).toBe(1)
    relays[0].emit('ended', 'the meeting has ended')
    expect(mic.closed).toBe(true)
    expect(relays[0].closed).toBe(true)
    expect(lock.held).toBe(0)
    expect(session.link).toBe('ended')
  })
})

describe('audio session recovery', () => {
  it('keeps the full wall-clock background gap through frozen timers and delayed hidden chunks', async () => {
    const { session, tick, grant, relays } = harness()
    const start = new Date(2026, 9, 2, 13, 8, 53).getTime()
    tick(start)
    const pending = session.begin()
    const mic = grant()
    session.stream((await pending)!, 'L1')
    mic.handlers.onChunk(new ArrayBuffer(4))
    session.backgrounded()
    tick(170_000) // No check or timer callback during suspension.
    relays[0].emit('reconnecting')
    mic.handlers.onChunk(new ArrayBuffer(4)) // A delayed worklet callback, still hidden.
    expect(session.warning).toBeNull()
    tick(10_000)
    session.returned()
    const fullGap = `Audio may be missing from ${clockTime(start)} to ${clockTime(start + 180_000)} (the screen locked or the browser went to the background).`
    expect(session.warning).toBe(fullGap) // Visible before any fresh worklet callback.
    relays[0].emit('connected')
    mic.handlers.onChunk(new ArrayBuffer(4))
    expect(session.warning).toBe(fullGap)
    session.warning = null
    mic.handlers.onChunk(new ArrayBuffer(4))
    expect(session.warning).toBeNull()
    session.backgrounded()
    tick(180_000)
    mic.state = 'suspended'
    session.returned()
    expect(session.needsRestore).toBe(true)
    expect(session.warning).toContain(`interrupted at ${clockTime(start + 180_000)}`)

    // Permission/open can also finish after the tab was hidden.
    const acquiring = harness()
    acquiring.tick(start)
    const acquisition = acquiring.session.begin()
    acquiring.session.backgrounded()
    acquiring.tick(180_000)
    acquiring.grant()
    await acquisition
    acquiring.session.returned()
    expect(acquiring.session.warning).toBe(fullGap)
  })

  it('a muted or ended track shows Restore at once, without a visibility change', async () => {
    for (const state of ['muted', 'ended', 'suspended'] as const) {
      const { session, grant } = harness()
      const pending = session.begin()
      const mic = grant()
      await pending
      session.check()
      expect(session.needsRestore).toBe(false)
      mic.state = state
      session.check()
      expect(session.needsRestore).toBe(true)
      expect(session.warning).toMatch(/interrupted/)
    }
  })

  it('an interruption from the mic shows Restore at once', async () => {
    const { session, grant } = harness()
    const pending = session.begin()
    const mic = grant()
    await pending
    mic.handlers.onInterrupted('the system muted the mic')
    expect(session.needsRestore).toBe(true)
  })

  it('a restore that finishes after Stop adopts nothing', async () => {
    const { session, grant } = harness()
    const pending = session.begin()
    const mic = grant()
    await pending
    mic.state = 'ended'
    session.check()
    const restoring = session.restore()
    session.stop()
    mic.revival.resolve('ok')
    await restoring
    expect(session.mic).toBeNull()
    expect(session.needsRestore).toBe(false)
  })

  it('a successful restore clears Restore', async () => {
    const { session, grant } = harness()
    const pending = session.begin()
    const mic = grant()
    await pending
    mic.state = 'muted'
    session.check()
    const restoring = session.restore()
    mic.state = 'ok'
    mic.revival.resolve('ok')
    await restoring
    expect(session.needsRestore).toBe(false)
    expect(session.warning).toMatch(/The mic is back/)
  })

  it('returning to the tab nudges the relay and tries to restore', async () => {
    const { session, relays, grant } = harness()
    const pending = session.begin()
    const mic = grant()
    session.stream((await pending)!, 'L1')
    mic.state = 'suspended'
    session.returned()
    expect(relays[0].nudges).toBe(1)
    expect(mic.revives).toBe(1)
  })

  it('a silent stretch from the worklet is reported when audio resumes', async () => {
    const { session, tick, grant } = harness()
    const pending = session.begin()
    const mic = grant()
    await pending
    tick(5_000)
    session.check()
    mic.handlers.onChunk(new ArrayBuffer(4))
    expect(session.warning).toMatch(/Audio may be missing/)
  })
})
