import { afterEach, expect, it, vi } from 'vitest'
import { BoardFeed, type BoardRecord } from './boardFeed.js'
import { settle } from './testFixtures.js'

afterEach(() => { vi.unstubAllGlobals() })

const human = { label: 'Sam' }
const record = (id: string, kind: string, fiber: string, timestamp: number): BoardRecord => ({ id, kind, fiber, to: human, timestamp, text: id })

/** A daemon that answers each family read with `records` and the board's unhandled lines. */
function serve(records: () => BoardRecord[], lines: () => Record<string, { id: string; at: number }>): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ family: { uid: 'root' }, records: records(), reach_ms: 86_400_000, waiting: lines() }))))
}

it('a read of a family the daemon could not resolve leaves what waits as the last answer said', async () => {
  const now = Date.now()
  serve(() => [], () => ({ chair: { id: 'p', at: now } }))
  const feed = new BoardFeed('')
  feed.read(['root']); await settle()
  vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ family: null, viewer: null, records: [], reach_ms: 86_400_000, waiting: {} })))
  feed.read(['gone']); await settle()
  expect(feed.waiting.has('chair')).toBe(true)
})

it('reads every family at once into the board slot, whose answer says what waits though it names no family', async () => {
  const now = Date.now()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ family: null, viewer: null, records: [record('p', 'post', 'chair', now - 3000)], reach_ms: 86_400_000, waiting: { chair: { id: 'p', at: now - 3000 } } }))))
  const feed = new BoardFeed('')
  feed.readBoard(); await settle()
  expect(String(vi.mocked(fetch).mock.calls[0][0])).toMatch(/\/api\/v1\/board\/family\?all=true&since_ms=\d+$/)
  expect(feed.boardRecords().map(each => each.id)).toEqual(['p'])
  expect(feed.records(['chair'])).toEqual([])
  expect(feed.waiting.get('chair')).toMatchObject({ id: 'p', kind: 'post' })
  feed.readBoard(); await settle()
  const since = Number(new URL(String(vi.mocked(fetch).mock.calls[1][0]), 'http://board').searchParams.get('since_ms'))
  expect(since, 'the next read asks from the newest record held').toBe(now - 3000 - 60_000)
})

it('undoes a clear made here: the line waits again at once, the daemon is told, and a clear after it reaches past the undo', async () => {
  const now = Date.now()
  serve(() => [record('p', 'post', 'chair', now - 3000)], () => ({ chair: { id: 'p', at: now - 3000 } }))
  const feed = new BoardFeed('http://daemon')
  feed.read(['root']); await settle()
  const at = await feed.clear('chair')
  expect(at).toBe(now - 3000)
  const calls = vi.mocked(fetch).mock.calls.length
  await feed.unclear('chair', at!)
  expect(feed.waiting.has('chair')).toBe(true)
  const key = (n: number) => JSON.parse(String(vi.mocked(fetch).mock.calls[n][1]?.body)).key
  expect(key(calls)).toBe(`unclear:chair:${now - 3000}`)
  expect(await feed.clear('chair')).toBe(now - 2999)
  expect(key(calls + 1)).toBe(`clear:chair:${now - 2999}`)
  expect(feed.waiting.has('chair')).toBe(false)
})

it('takes every unhandled line as waiting on the human, a post included, with its kind and words once its family is read', async () => {
  const now = Date.now()
  const records = [record('p', 'post', 'chair', now - 3000), record('a', 'asked', 'mask', now - 2000)]
  serve(() => records, () => ({ chair: { id: 'p', at: now - 3000 }, mask: { id: 'a', at: now - 2000 }, cov: { id: 'c', at: now - 1000 } }))
  const feed = new BoardFeed('')
  feed.read(['root']); await settle()
  expect(Object.fromEntries(feed.waiting)).toStrictEqual({
    chair: { id: 'p', at: now - 3000, kind: 'post', text: 'p', files: undefined },
    mask: { id: 'a', at: now - 2000, kind: 'asked', text: 'a', files: undefined },
    // Its family is not read: it waits, its kind not known yet.
    cov: { id: 'c', at: now - 1000 },
  })
})

it('clears a line by hand at once, writing only the dismissal that handles it, and holds it against a read already under way', async () => {
  const now = Date.now()
  const lines = { chair: { id: 'p', at: now - 3000 } }
  serve(() => [record('p', 'post', 'chair', now - 3000)], () => lines)
  const feed = new BoardFeed('http://daemon'), heard = vi.fn()
  feed.read(['root']); await settle()
  feed.subscribe(heard)
  const calls = vi.mocked(fetch).mock.calls.length
  await feed.clear('chair')
  expect(feed.waiting.has('chair')).toBe(false)
  expect(heard).toHaveBeenCalled()
  const writes = vi.mocked(fetch).mock.calls.slice(calls)
  expect(writes.map(([url, init]) => [String(url), init?.method, JSON.parse(String(init?.body))])).toStrictEqual([
    ['http://daemon/api/v1/channels/dismiss', 'POST', { key: `clear:chair:${now - 3000}`, fiber: 'chair' }],
  ])
  // A read that answered before the daemon took the clear still names the line.
  feed.read(['root']); await settle()
  expect(feed.waiting.has('chair')).toBe(false)
  // A later line waits again.
  lines.chair = { id: 'q', at: now }
  feed.read(['root']); await settle()
  expect(feed.waiting.get('chair')?.id).toBe('q')
})

it('a clear the daemon refuses waits again', async () => {
  const now = Date.now()
  serve(() => [], () => ({ chair: { id: 'p', at: now } }))
  const feed = new BoardFeed('')
  feed.read(['root']); await settle()
  vi.mocked(fetch).mockImplementation(async () => new Response('no', { status: 500 }))
  await expect(feed.clear('chair')).rejects.toThrow()
  expect(feed.waiting.has('chair')).toBe(true)
})

it('hears a read that adds one record as another leaves the reach, though the count holds', async () => {
  const now = Date.now()
  let records = [record('old', 'post', 'chair', now - 1000)]
  serve(() => records, () => ({}))
  const feed = new BoardFeed(''), heard = vi.fn()
  feed.subscribe(heard)
  feed.read(['root']); await settle()
  expect(heard).toHaveBeenCalledTimes(1)
  // The daemon's reach shrinks past the old record as a new one arrives.
  records = [record('new', 'post', 'chair', now)]
  vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ records, reach_ms: 500, waiting: {} })))
  feed.read(['root']); await settle()
  expect(feed.records(['root']).map(each => each.id)).toStrictEqual(['new'])
  expect(heard).toHaveBeenCalledTimes(2)
})
