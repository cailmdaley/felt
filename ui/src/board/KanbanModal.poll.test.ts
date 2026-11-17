// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import { parseCompositeFeed, type CompositeFeed } from './KanbanComposite.js'
import { buildKanbanResponseFromComposite } from './KanbanReadModel.js'
import type { KanbanResponse } from './KanbanTypes.js'

interface Poll {
  fetchAndRender(): Promise<void>
  presentFeed(feed: CompositeFeed): void
  refreshUnchanged(data: KanbanResponse): void
  readBoard(): void
  render(): void
  syncWorkspaceRuntime(): void
  mountOrRefreshActiveView(): void
  compositeEtag: string | null
  lastFeed: CompositeFeed | null
  lastResponse: KanbanResponse | null
  lastResponseSig: string | null
  lastFetchFailed: boolean
  daemonBooting: boolean
}

const NOW = Date.parse('2026-11-17T15:00:00Z')
const feed = parseCompositeFeed({ host: 'here', fibers: [], origins: { here: { kind: 'local', stale: false, fiber_count: 0 } } })

/** A board that last drew `feed`, built at `builtAt`, polling a daemon that answers 304. */
function polled(builtAt: number): Poll {
  const board = new KanbanModal({ shuttleBase: '' }) as unknown as Poll
  for (const name of ['readBoard', 'render', 'syncWorkspaceRuntime', 'mountOrRefreshActiveView'] as const) board[name] = vi.fn()
  board.compositeEtag = 'W/"feed"'
  board.lastFeed = feed
  board.lastResponse = buildKanbanResponseFromComposite(feed, { nowMs: builtAt })
  board.lastResponseSig = 'drawn'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 304, headers: { ETag: 'W/"feed"' } })))
  return board
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('a poll the daemon answers 304', () => {
  it('keeps the classified board and still reads what waits, the workspace and the view', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const board = polled(NOW - 60_000), drawn = board.lastResponse
    const present = vi.spyOn(board, 'presentFeed')

    await board.fetchAndRender()

    expect(present).not.toHaveBeenCalled()
    expect(board.lastResponse).toBe(drawn)
    expect(board.readBoard).toHaveBeenCalledWith(drawn)
    expect(board.syncWorkspaceRuntime).toHaveBeenCalled()
    expect(board.mountOrRefreshActiveView).toHaveBeenCalled()
    expect(board.render).not.toHaveBeenCalled()
  })

  it('redraws a page that showed a failure from the feed it holds', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const board = polled(NOW - 60_000)
    board.lastFetchFailed = true
    board.lastResponseSig = null

    await board.fetchAndRender()

    expect(board.lastFetchFailed).toBe(false)
    expect(board.lastResponseSig).not.toBeNull()
    expect(board.render).toHaveBeenCalled()
  })

  it('reclassifies once the local civil day has turned, for due-day promotion', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const board = polled(NOW - 36 * 3_600_000), before = board.lastResponse
    const present = vi.spyOn(board, 'presentFeed')

    await board.fetchAndRender()

    expect(present).toHaveBeenCalledWith(feed)
    expect(board.lastResponse).not.toBe(before)
    expect(board.lastResponse?.generatedAt).toBe(NOW)
  })
})
