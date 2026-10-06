import { describe, expect, it } from 'vitest'

import { railCivilDay, shiftCivilDay } from '../civilDay.js'
import { ChronicleFeeds, TEMPORAL_REFRESH_MS } from './chronicleFeeds.js'
import { activityChunks, windowOf, type DayRange } from './chronicleWindow.js'
import type { TemporalFetchers, TemporalOrigins } from './TemporalData.js'

/**
 * THE CADENCE, pinned: a board poll inside the refresh interval costs no
 * temporal request; the interval elapsing, or a forced sync, re-reads the live
 * activity chunk, the session ledger and the window's commits; a window that
 * grows fetches only what it newly covers.
 */

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0)

function windowAround(nowMs: number, past: number, future: number): DayRange {
  const today = railCivilDay(nowMs)
  return windowOf(shiftCivilDay(today, -past), shiftCivilDay(today, future))
}

/** Fetchers that count what they were asked for, and answer one bucket per
 *  activity window so a held chunk is visible in `buckets()`. */
function countingFetchers() {
  const asked = { activity: [] as Array<[number, number]>, sessions: 0, commits: 0 }
  const fetchers: TemporalFetchers = {
    activity: (fromMs, toMs) => {
      asked.activity.push([fromMs, toMs])
      return Promise.resolve({
        host: 'ada',
        from_ms: fromMs,
        to_ms: toMs,
        buckets: [{ m: fromMs, s: null, cwd: null, k: 'agent', n: 1 }],
      })
    },
    sessions: () => {
      asked.sessions += 1
      return Promise.resolve({ host: 'ada', records: [] })
    },
    commits: () => {
      asked.commits += 1
      return Promise.resolve({ host: 'ada', records: [] })
    },
  }
  const reset = (): void => {
    asked.activity = []
    asked.sessions = 0
    asked.commits = 0
  }
  return { fetchers, asked, reset }
}

describe('ChronicleFeeds cadence', () => {
  const window = windowAround(NOW, 28, 14)
  const chunks = activityChunks(window, NOW)
  const live = chunks.filter((c) => c.live)

  it('reads every feed on the first sync', async () => {
    const { fetchers, asked } = countingFetchers()
    const feeds = new ChronicleFeeds()
    await feeds.sync(fetchers, window, { nowMs: NOW })
    expect(asked.activity).toHaveLength(chunks.length)
    expect(asked.sessions).toBe(1)
    expect(asked.commits).toBe(1)
    expect(feeds.buckets(window)).toHaveLength(chunks.length)
  })

  it('answers a poll inside the interval from what it holds', async () => {
    const { fetchers, asked, reset } = countingFetchers()
    const feeds = new ChronicleFeeds()
    await feeds.sync(fetchers, window, { nowMs: NOW })
    reset()
    for (const later of [15_000, 60_000, TEMPORAL_REFRESH_MS - 1]) {
      await feeds.sync(fetchers, window, { nowMs: NOW + later })
    }
    expect(asked).toEqual({ activity: [], sessions: 0, commits: 0 })
    expect(feeds.buckets(window)).toHaveLength(chunks.length)
  })

  it('re-reads the live chunk and both ledgers once the interval elapses', async () => {
    const { fetchers, asked, reset } = countingFetchers()
    const feeds = new ChronicleFeeds()
    await feeds.sync(fetchers, window, { nowMs: NOW })
    reset()
    await feeds.sync(fetchers, window, { nowMs: NOW + TEMPORAL_REFRESH_MS })
    // Settled chunks are kept; only the chunk containing now is asked again.
    expect(asked.activity).toHaveLength(live.length)
    expect(asked.sessions).toBe(1)
    expect(asked.commits).toBe(1)
    expect(feeds.sweptAt).toBe(NOW + TEMPORAL_REFRESH_MS)
  })

  it('re-reads on a forced sync however recent the last sweep', async () => {
    const { fetchers, asked, reset } = countingFetchers()
    const feeds = new ChronicleFeeds()
    await feeds.sync(fetchers, window, { nowMs: NOW })
    reset()
    await feeds.sync(fetchers, window, { nowMs: NOW + 15_000, force: true })
    expect(asked.activity).toHaveLength(live.length)
    expect(asked.sessions).toBe(1)
    expect(asked.commits).toBe(1)
  })

  it('fetches only what a grown window newly covers', async () => {
    const { fetchers, asked, reset } = countingFetchers()
    const feeds = new ChronicleFeeds()
    await feeds.sync(fetchers, window, { nowMs: NOW })
    reset()
    const grown = windowAround(NOW, 28 + 56, 14)
    const added = activityChunks(grown, NOW).length - chunks.length
    expect(added).toBeGreaterThan(0)
    await feeds.sync(fetchers, grown, { nowMs: NOW + 15_000 })
    expect(asked.activity).toHaveLength(added)
    expect(asked.sessions).toBe(0)
    expect(asked.commits).toBe(1)
    expect(feeds.commits?.key).toBe(`${grown.first}:${grown.last}`)
  })

  it('lets a poll landing mid-sweep wait on it rather than start another', async () => {
    const { fetchers, asked } = countingFetchers()
    const feeds = new ChronicleFeeds()
    await Promise.all([
      feeds.sync(fetchers, window, { nowMs: NOW }),
      feeds.sync(fetchers, window, { nowMs: NOW + 15_000 }),
    ])
    expect(asked.sessions).toBe(1)
    expect(asked.commits).toBe(1)
  })
})

/**
 * THE FAILURE PATH, pinned: every fetcher degrades to an empty result with a
 * blank `host` instead of rejecting. A degraded answer must never overwrite
 * what is held, never count as a sweep, and never blank the freshness block.
 */

/** Fetchers whose feeds can be switched to the degraded answer between syncs
 *  (`settled` downs only the chunks that end before NOW), and whose answers
 *  carry a session pairing and origins so a replacement is visible. */
const LIVE_ORIGINS: TemporalOrigins = { ada: { kind: 'local', stale: false } }
const SETTLED_ORIGINS: TemporalOrigins = { carl: { kind: 'remote', stale: false } }
const SESSION_ORIGINS: TemporalOrigins = { bob: { kind: 'remote', stale: true } }

function flakyFetchers() {
  const down = { activity: false, settled: false, sessions: false, commits: false }
  const asked = { activity: 0 }
  let n = 0
  const fetchers: TemporalFetchers = {
    activity: (fromMs, toMs) => {
      asked.activity += 1
      n += 1
      return Promise.resolve(
        down.activity || (down.settled && toMs < NOW)
          ? { host: '', from_ms: fromMs, to_ms: toMs, buckets: [] }
          : {
              host: 'ada',
              from_ms: fromMs,
              to_ms: toMs,
              buckets: [{ m: fromMs, s: null, cwd: null, k: 'agent', n }],
              // The live chunk's answer names `ada`; a settled chunk's, `carl`.
              origins: toMs < NOW ? SETTLED_ORIGINS : LIVE_ORIGINS,
            },
      )
    },
    sessions: () =>
      Promise.resolve(
        down.sessions
          ? { host: '', records: [] }
          : {
              host: 'ada',
              records: [{
                at: 1, fiber: 'work/a', uid: null, session: 's1', harness: null,
                host: 'ada', tmux: 'run-a', kind: 'dispatch' as const,
              }],
              origins: SESSION_ORIGINS,
            },
      ),
    commits: () =>
      Promise.resolve(
        down.commits
          ? { host: '', records: [], origins: {} }
          : {
              host: 'ada',
              records: [{
                at: 1, sha: 'a'.repeat(40), subject: 's', repo: null, files: 1,
                insertions: 1, deletions: 0, session: 's1', tmux: null, cwd: null, host: 'ada',
              }],
            },
      ),
  }
  return { fetchers, down, asked }
}

describe('ChronicleFeeds when a feed is down', () => {
  const window = windowAround(NOW, 28, 14)
  const chunks = activityChunks(window, NOW)
  const later = NOW + TEMPORAL_REFRESH_MS

  it('keeps the live chunk it holds when the sweep re-reading it fails', async () => {
    // Catches: storing a degraded answer, which blanks Chronicle's live column
    // until the next good sweep.
    const { fetchers, down } = flakyFetchers()
    const feeds = new ChronicleFeeds()
    await feeds.sync(fetchers, window, { nowMs: NOW })
    const held = feeds.buckets(window)
    down.activity = true
    await feeds.sync(fetchers, window, { nowMs: later })
    expect(feeds.buckets(window)).toStrictEqual(held)
  })

  it('keeps the session index and commit ledger it holds when their sweep fails', async () => {
    // Catches: replacing either ledger with the empty fallback, which drops
    // every join and every row's line counts on a tunnel blip.
    const { fetchers, down } = flakyFetchers()
    const feeds = new ChronicleFeeds()
    await feeds.sync(fetchers, window, { nowMs: NOW })
    expect(feeds.sessionIndex.bySession.get('s1')?.fiber).toBe('work/a')
    expect(feeds.commits?.records).toHaveLength(1)
    down.sessions = true
    down.commits = true
    await feeds.sync(fetchers, window, { nowMs: later })
    expect(feeds.sessionIndex.bySession.get('s1')?.fiber).toBe('work/a')
    expect(feeds.commits?.records).toHaveLength(1)
  })

  it('records no sweep time when any feed failed, so the next poll retries', async () => {
    // Catches: caching a failure for the whole refresh interval.
    for (const feed of ['activity', 'sessions', 'commits'] as const) {
      const { fetchers, down } = flakyFetchers()
      const feeds = new ChronicleFeeds()
      down[feed] = true
      await feeds.sync(fetchers, window, { nowMs: NOW })
      expect(feeds.sweptAt, feed).toBe(0)
      down[feed] = false
      await feeds.sync(fetchers, window, { nowMs: NOW + 15_000 })
      expect(feeds.sweptAt, feed).toBe(NOW + 15_000)
    }
  })

  it('starts from an empty session index while the first sweep has failed', async () => {
    // Catches: an index that is not a pair of maps until a ledger lands.
    const { fetchers, down } = flakyFetchers()
    down.sessions = true
    const feeds = new ChronicleFeeds()
    await feeds.sync(fetchers, window, { nowMs: NOW })
    expect(feeds.sessionIndex.byTmux.size).toBe(0)
    expect(feeds.sessionIndex.bySession.size).toBe(0)
  })

  it('stores no settled chunk from a failed read, so a later sync asks again', async () => {
    // Catches: storing a degraded settled chunk, which is never re-read and
    // leaves its days blank for the life of the page.
    const { fetchers, down, asked } = flakyFetchers()
    const feeds = new ChronicleFeeds()
    down.settled = true
    await feeds.sync(fetchers, window, { nowMs: NOW })
    expect(feeds.buckets(window)).toHaveLength(1) // the live chunk alone
    down.settled = false
    asked.activity = 0
    await feeds.sync(fetchers, window, { nowMs: NOW + 15_000 })
    expect(asked.activity).toBe(chunks.length - 1)
    expect(feeds.buckets(window)).toHaveLength(chunks.length)
  })

  it('reads origins from both feeds, the newest activity block winning, and keeps it through a pass that carries none', async () => {
    // Catches: dropping either feed's freshness block, and reading a pass that
    // fetched nothing (or failed) as "every origin is fresh".
    const { fetchers, down } = flakyFetchers()
    const feeds = new ChronicleFeeds()
    const bob = { kind: 'remote', stale: true }
    // The sweep reads the live chunk (`ada`), then the settled chunks (`carl`).
    await feeds.sync(fetchers, window, { nowMs: NOW })
    expect(feeds.origins()).toEqual({ bob, carl: { kind: 'remote', stale: false } })
    // The next sweep re-reads only the live chunk, and its block replaces.
    await feeds.sync(fetchers, window, { nowMs: later })
    const fresh = { bob, ada: { kind: 'local', stale: false } }
    expect(feeds.origins()).toEqual(fresh)
    down.activity = true
    await feeds.sync(fetchers, window, { nowMs: later + TEMPORAL_REFRESH_MS })
    expect(feeds.origins()).toEqual(fresh)
  })

})
