import { describe, expect, it } from 'vitest'

import { railCivilDay } from '../civilDay.js'
import { ChronicleFeeds, TEMPORAL_REFRESH_MS } from './chronicleFeeds.js'
import { activityChunks, windowOf, type DayRange } from './chronicleWindow.js'
import { shiftCivilDay } from './railTime.js'
import type { TemporalFetchers } from './TemporalData.js'

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
