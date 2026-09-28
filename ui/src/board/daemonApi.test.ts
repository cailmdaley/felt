import { afterEach, describe, expect, it, vi } from 'vitest'
import { daemonFetch, DaemonBootingError } from './daemonApi.js'

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
