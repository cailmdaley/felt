import { afterEach, describe, expect, it, vi } from 'vitest'
import { daemonErrorMessage, daemonFetch, DaemonBootingError } from './daemonApi.js'
import { KanbanModal } from './KanbanModal.js'

afterEach(() => vi.unstubAllGlobals())

describe('daemonFetch boot handling', () => {
  it('classifies the shared booting 503 before callers read its JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'booting', ready: false }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )))

    await expect(daemonFetch('/api/v1/state')).rejects.toBeInstanceOf(DaemonBootingError)
  })

  it('leaves non-booting service errors to the route caller', async () => {
    const response = new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 })
    vi.stubGlobal('fetch', vi.fn(async () => response))

    await expect(daemonFetch('/api/v1/state')).resolves.toBe(response)
  })
})

describe('daemonFetch conditional responses', () => {
  it('lets the Desk poll return on 304 without parsing the feed', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { hostname: 'localhost' }, setTimeout: vi.fn() },
    })
    const board = new KanbanModal({ shuttleBase: '' }) as unknown as {
      fetchAndRender(): Promise<void>
      fetchMeetingStatus(): Promise<void>
      compositeEtag: string | null
      lastFetchFailed: boolean
      daemonBooting: boolean
    }
    board.compositeEtag = 'W/"feed"'
    board.fetchMeetingStatus = async () => {}
    const response = new Response(null, { status: 304, headers: { ETag: 'W/"feed"' } })
    const json = vi.spyOn(response, 'json')
    vi.stubGlobal('fetch', vi.fn(async () => response))

    await board.fetchAndRender()

    expect(json).not.toHaveBeenCalled()
    expect(board.lastFetchFailed).toBe(false)
    expect(board.daemonBooting).toBe(false)
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(expect.stringContaining('/api/v1/fibers/composite'), {
      headers: new Headers({ 'If-None-Match': 'W/"feed"' }),
    })
  })

  it('returns a 304 untouched without reading or parsing a body', async () => {
    const response = new Response(null, { status: 304, headers: { ETag: 'W/"feed"' } })
    const json = vi.spyOn(response, 'json')
    vi.stubGlobal('fetch', vi.fn(async () => response))

    const result = await daemonFetch('/api/v1/fibers/composite', {
      headers: { 'If-None-Match': 'W/"feed"' },
    })

    expect(result.status).toBe(304)
    expect(json).not.toHaveBeenCalled()
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/v1/fibers/composite', {
      headers: { 'If-None-Match': 'W/"feed"' },
    })
  })
})

describe('daemonErrorMessage', () => {
  // Every engine names a transport failure differently; the TypeError is the
  // only thing they agree on.
  it.each([
    ['Chrome', 'Failed to fetch'],
    ['Firefox', 'NetworkError when attempting to fetch resource.'],
    ['WebKit', 'Load failed'],
  ])('names the daemon when the fetch itself never lands (%s)', (_engine, message) => {
    expect(daemonErrorMessage(new TypeError(message))).toBe('Couldn’t reach the Shuttle daemon (:4000).')
  })

  it('passes our own errors through as written', () => {
    expect(daemonErrorMessage(new Error('fetch the parent first'))).toBe('fetch the parent first')
    expect(daemonErrorMessage('plain')).toBe('plain')
  })
})
