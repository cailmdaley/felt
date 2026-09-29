import { afterEach, describe, expect, it, vi } from 'vitest'
import { daemonErrorMessage, daemonFetch, DaemonBootingError } from './daemonApi.js'

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
