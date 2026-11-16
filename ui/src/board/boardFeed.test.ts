import { afterEach, expect, it, vi } from 'vitest'
import { BoardFeed, type BoardRecord } from './boardFeed.js'
import { settle } from './testFixtures.js'

afterEach(() => { vi.unstubAllGlobals() })

const human = { label: 'Sam' }
const record = (id: string, kind: string, fiber: string, timestamp: number): BoardRecord => ({ id, kind, fiber, to: human, timestamp, text: id })

/** A daemon that answers each family read with `records` and the board's unhandled lines. */
function serve(records: () => BoardRecord[], lines: () => Record<string, { id: string; at: number }>): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ records: records(), reach_ms: 86_400_000, waiting: lines() }))))
}

it('takes a question or a close as waiting on the human, never a post, once its family is read', async () => {
  const now = Date.now()
  const records = [record('p', 'post', 'chair', now - 3000), record('a', 'asked', 'mask', now - 2000), record('c', 'closed', 'cov', now - 1000)]
  serve(() => records, () => ({ chair: { id: 'p', at: now - 3000 }, mask: { id: 'a', at: now - 2000 }, cov: { id: 'c', at: now - 1000 } }))
  const feed = new BoardFeed('')
  feed.read(['root']); await settle()
  expect([...feed.waiting.keys()]).toStrictEqual(['mask', 'cov'])
  expect([...feed.unhandled.keys()]).toStrictEqual(['chair', 'mask', 'cov'])
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
