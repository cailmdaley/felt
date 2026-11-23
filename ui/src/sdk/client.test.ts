import { describe, expect, it, vi } from 'vitest'
import { DaemonBootingError, DaemonRequestError, ShuttleClient, daemonErrorMessage, isDaemonBooting, responseError } from './client'
import type { ShuttleFiber } from './types'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

/** A client over a fetch that records each request and answers from `reply`. */
function recording(reply: (url: string, init?: RequestInit) => Response = () => json({})) {
  const calls: Array<{ url: string; init?: RequestInit; body?: unknown }> = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    return reply(url, init)
  }) as unknown as typeof globalThis.fetch
  return { client: new ShuttleClient({ base: 'http://daemon:4000/', fetch }), calls }
}

const row: ShuttleFiber = { fiber: { id: 'work/task', uid: 'U1', name: 'Task', status: 'active' }, origin: 'remote', felt_store: '/s', path: 'work/task.md', column: 'in_flight' }

describe('ShuttleClient', () => {
  it('builds every read on the API root, leaving unset parameters out', async () => {
    const { client, calls } = recording(() => json({ files: [{ fullPath: '/a.png', basename: 'a.png', timestamp: 1, sessionId: null }] }))
    await client.version()
    await client.version('remote')
    await client.fleet()
    await client.peers(true)
    await client.contract()
    await client.fiber('work/a b', 'remote')
    expect(await client.sentFiles('U1', 'remote')).toEqual([{ fullPath: '/a.png', basename: 'a.png', timestamp: 1, sessionId: null }])
    expect(calls.map(call => call.url)).toEqual([
      'http://daemon:4000/api/v1/version',
      'http://daemon:4000/api/v1/version?origin=remote',
      'http://daemon:4000/api/v1/fleet',
      'http://daemon:4000/api/v1/peers?local=true',
      'http://daemon:4000/api/v1/contract',
      'http://daemon:4000/api/v1/fibers/work/a%20b?body=true&origin=remote',
      'http://daemon:4000/api/v1/sent-files?uid=U1&origin=remote',
    ])
  })

  it('revalidates the composite feed with its ETag and reports a 304 as unchanged', async () => {
    const feed = { host: 'here', fibers: [row], origins: {} }
    const { client, calls } = recording((_url, init) => (init?.headers as Record<string, string> | undefined)?.['If-None-Match'] === 'W/"1"'
      ? new Response(null, { status: 304 })
      : json(feed, 200, { ETag: 'W/"1"' }))
    expect(await client.fibersComposite()).toEqual({ notModified: false, response: feed, etag: 'W/"1"' })
    expect(await client.fibersComposite({ etag: 'W/"1"' })).toEqual({ notModified: true, etag: 'W/"1"' })
    expect(calls[1].init).toMatchObject({ cache: 'no-store', headers: { 'If-None-Match': 'W/"1"' } })
  })

  it('posts every write as JSON to its route', async () => {
    const { client, calls } = recording()
    await client.createFiber({ id: 'work/new', name: 'New' })
    await client.capture({ prompt: 'p', project_dir: '/d' })
    await client.dispatch({ fiber_id: 'work/task', user_message: 'hi' })
    await client.deliver({ fiber_id: 'work/task', text: 'hi' })
    await client.lifecycle({ action: 'rest', fiber: 'work/task', origin: 'remote' })
    await client.kill('work/task', 'remote')
    await client.inbox({ action: 'list', fiber_id: 'work/task' })
    expect(calls.map(call => [call.url.replace('http://daemon:4000/api/v1', ''), call.init?.method, call.body])).toEqual([
      ['/fiber/create', 'POST', { id: 'work/new', name: 'New' }],
      ['/capture', 'POST', { prompt: 'p', project_dir: '/d' }],
      ['/dispatch', 'POST', { fiber_id: 'work/task', user_message: 'hi' }],
      ['/deliver', 'POST', { fiber_id: 'work/task', text: 'hi' }],
      ['/lifecycle', 'POST', { action: 'rest', fiber: 'work/task', origin: 'remote' }],
      ['/kill', 'POST', { fiber_id: 'work/task', origin: 'remote' }],
      ['/inbox', 'POST', { action: 'list', fiber_id: 'work/task' }],
    ])
  })

  it('takes an offer on its owner: a lifecycle verb, or a kill', async () => {
    const { client, calls } = recording()
    await client.act(row, { verb: 'temper', label: 'Temper', request: { action: 'close', tempered: true } })
    await client.act(row, { verb: 'kill', label: 'Stop worker' })
    expect(calls.map(call => [call.url.split('/api/v1')[1], call.body])).toEqual([
      ['/lifecycle', { action: 'close', tempered: true, fiber: 'work/task', origin: 'remote' }],
      ['/kill', { fiber_id: 'work/task', origin: 'remote' }],
    ])
  })

  it('throws a booting daemon as its own error, and a refusal in the daemon’s words', async () => {
    const booting = recording(() => json({ error: 'booting' }, 503)).client
    const error = await booting.version().catch(e => e)
    expect(error).toBeInstanceOf(DaemonBootingError)
    expect(isDaemonBooting(error)).toBe(true)
    const refused = recording(() => json({ error: 'no such fiber' }, 404)).client
    const refusal = await refused.lifecycle({ action: 'rest', fiber: 'x' }).catch(e => e)
    expect(refusal).toBeInstanceOf(DaemonRequestError)
    expect(refusal).toMatchObject({ message: 'no such fiber', status: 404 })
  })

  it('builds file and thread page addresses', () => {
    const client = new ShuttleClient()
    expect(client.fileUrl('/home/me/~x/a b.html')).toBe('/api/v1/file?path=%2Fhome%2Fme%2F%7Ex%2Fa%20b.html')
    expect(client.fileUrl('rel.png', 'remote')).toBe('/api/v1/file?path=%2Frel.png&origin=remote')
    expect(client.fileUrl('/a.png', 'local')).toBe('/api/v1/file?path=%2Fa.png')
    expect(client.threadPageUrl('U1', 'host-a')).toBe('/thread?f=U1@host-a')
  })
})

describe('errors as sentences', () => {
  it('names an unreachable daemon by type, and passes other messages through', () => {
    expect(daemonErrorMessage(new TypeError('Load failed'))).toBe('Couldn’t reach the Shuttle daemon (:4000).')
    expect(daemonErrorMessage(new Error('refused'))).toBe('refused')
  })

  it('prefers a JSON error field, then the raw text, then the label', async () => {
    expect(await responseError(json({ message: 'why' }, 400), 'X')).toBe('why')
    expect(await responseError(new Response('stderr text', { status: 500 }), 'X')).toBe('stderr text')
    expect(await responseError(new Response('', { status: 502 }), 'Read failed')).toBe('Read failed (HTTP 502)')
  })
})
