// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShuttleClient, type CompositeRead } from './client'
import { ShuttleFeed, type ShuttleFeedState } from './feed'
import type { ShuttleFiber } from './types'

const row = (id: string): ShuttleFiber => ({ fiber: { id, name: id }, origin: 'here', felt_store: '/s', path: `${id}.md` })
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve() }

/** A client whose feed reads answer from a queue. */
function client(answers: Array<CompositeRead | Error>) {
  const c = new ShuttleClient()
  const read = vi.spyOn(c, 'fibersComposite').mockImplementation(async () => {
    const next = answers.shift() ?? { notModified: true, etag: 'e1' }
    if (next instanceof Error) throw next
    return next
  })
  return { client: c, read }
}

let visibility: DocumentVisibilityState = 'visible'
beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ShuttleFeed', () => {
  it('reads on start, tells subscribers, and revalidates with the ETag it was given', async () => {
    const { client: c, read } = client([{ notModified: false, response: { host: 'here', fibers: [row('a')], origins: {} }, etag: 'e1' }])
    const feed = new ShuttleFeed(c, { intervalMs: 1000, now: () => 42 })
    const seen: ShuttleFeedState['status'][] = []
    feed.subscribe(state => seen.push(state.status))
    expect(feed.getState().status).toBe('idle')
    feed.start()
    await flush()
    expect(feed.getState()).toMatchObject({ status: 'ready', fibers: [row('a')], updatedAt: 42, error: null })
    expect(seen).toEqual(['loading', 'ready'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ etag: 'e1' }))
    expect(feed.getState().fibers).toEqual([row('a')])
    feed.stop()
  })

  it('keeps its rows through a failure, and names a booting daemon', async () => {
    const { DaemonBootingError } = await import('./client')
    const { client: c } = client([
      { notModified: false, response: { host: 'here', fibers: [row('a')], origins: {} }, etag: null },
      new TypeError('Failed to fetch'),
      new DaemonBootingError(),
    ])
    const feed = new ShuttleFeed(c)
    await feed.refresh()
    expect(await feed.refresh()).toMatchObject({ status: 'error', error: 'Couldn’t reach the Shuttle daemon (:4000).', fibers: [row('a')] })
    expect(await feed.refresh()).toMatchObject({ status: 'booting', fibers: [row('a')] })
  })

  it('pauses while the page is hidden and reads as soon as it is shown', async () => {
    const { client: c, read } = client([])
    const feed = new ShuttleFeed(c, { intervalMs: 1000 })
    feed.start()
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(read).toHaveBeenCalledTimes(1)
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(read).toHaveBeenCalledTimes(2)
    feed.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('reads a listener that throws as the page’s error: the feed stays ready and the next listener hears it', async () => {
    const surfaced = vi.fn()
    vi.stubGlobal('reportError', surfaced)
    const { client: c } = client([{ notModified: false, response: { host: 'here', fibers: [row('a')], origins: {} }, etag: null }])
    const feed = new ShuttleFeed(c)
    const seen: ShuttleFeedState['status'][] = []
    feed.subscribe(() => { throw new TypeError('page bug') })
    feed.subscribe(state => seen.push(state.status))
    expect(await feed.refresh()).toMatchObject({ status: 'ready', error: null, fibers: [row('a')] })
    expect(seen).toEqual(['loading', 'ready'])
    expect(surfaced).toHaveBeenCalledTimes(2)
    expect(surfaced).toHaveBeenCalledWith(expect.objectContaining({ message: 'page bug' }))
  })

  it('aborts the read in flight when stopped, ignores how it ends, and starts again on a read of its own', async () => {
    const reads: Array<{ signal: AbortSignal; land(read: CompositeRead): void; fail(error: Error): void }> = []
    const c = new ShuttleClient()
    vi.spyOn(c, 'fibersComposite').mockImplementation(({ signal } = {}) => new Promise((land, fail) => { reads.push({ signal: signal!, land, fail }) }))
    const answer = (id: string): CompositeRead => ({ notModified: false, response: { host: 'here', fibers: [row(id)], origins: {} }, etag: id })
    const feed = new ShuttleFeed(c, { intervalMs: 1000 })
    feed.start()
    feed.stop()
    expect(reads[0].signal.aborted).toBe(true)
    expect(feed.getState().status).toBe('idle')
    feed.start()
    expect(reads).toHaveLength(2)
    reads[0].land(answer('stale'))
    await flush()
    expect(feed.getState()).toMatchObject({ status: 'loading', fibers: [] })
    reads[1].land(answer('fresh'))
    await flush()
    expect(feed.getState()).toMatchObject({ status: 'ready', fibers: [row('fresh')] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(reads).toHaveLength(3)
    feed.stop()
    reads[2].fail(new DOMException('aborted', 'AbortError'))
    await flush()
    expect(feed.getState()).toMatchObject({ status: 'ready', error: null, fibers: [row('fresh')] })
    await vi.advanceTimersByTimeAsync(5000)
    expect(reads).toHaveLength(3)
  })

  it('joins a read already in flight, and unsubscribes', async () => {
    const { client: c, read } = client([])
    const feed = new ShuttleFeed(c)
    const listener = vi.fn()
    const off = feed.subscribe(listener)
    await Promise.all([feed.refresh(), feed.refresh()])
    expect(read).toHaveBeenCalledTimes(1)
    off()
    await feed.refresh()
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
