import { describe, expect, it } from 'vitest'
import { ScreenLock, type WakeLockLike } from './mic'

class FakeSentinel implements WakeLockLike {
  released = false
  async release(): Promise<void> { this.released = true }
  addEventListener(): void {}
}

describe('screen lock', () => {
  it('a grant that lands after release is released at once', async () => {
    let grant!: (sentinel: WakeLockLike) => void
    const lock = new ScreenLock(() => new Promise((resolve) => { grant = resolve }), () => true)
    const acquiring = lock.acquire()
    lock.release()
    const sentinel = new FakeSentinel()
    grant(sentinel)
    await acquiring
    expect(sentinel.released).toBe(true)
    expect(lock.held).toBe(false)
  })

  it('holds a grant while wanted and lets it go on release', async () => {
    const sentinel = new FakeSentinel()
    const lock = new ScreenLock(async () => sentinel, () => true)
    await lock.acquire()
    expect(lock.held).toBe(true)
    lock.release()
    expect(sentinel.released).toBe(true)
    expect(lock.held).toBe(false)
  })
})
