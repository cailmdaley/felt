/**
 * chronicleFeeds — what Chronicle holds of the temporal feeds, and when it
 * reads them again.
 *
 * THE CADENCE. The board polls its own feed every 15s, and every poll
 * repaints the chronicle from the cards it carries. The temporal feeds —
 * activity, the session ledger, the commit ledger — do not ride that poll.
 * They are SWEPT, re-read together, on the first sync, whenever
 * {@link TEMPORAL_REFRESH_MS} has passed since the last sweep, and on a forced
 * sync (the head's ↻). Between sweeps a sync fetches only what the window
 * newly needs: a settled chunk a scroll reached, the commits of a window that
 * grew. Everything else is answered from what is held.
 *
 * A sweep re-reads the LIVE activity chunk and keeps the settled ones: their
 * days are over, and a year of scroll-back is not worth re-reading every few
 * minutes. The chunk plan is drawn against `sweptAt` rather than the clock,
 * so the live chunk keeps one key between sweeps and a sync finds it held.
 *
 * No DOM, no view state: one instance per mount, so a fetch that lands after
 * an unmount stores into an instance nobody reads.
 */

import { civilDayToLocalDate } from '../civilDay.js'
import { activityChunks, type DayRange } from './chronicleWindow.js'
import {
  buildSessionIndex,
  type ActivityBucket,
  type ActivityResult,
  type CommitRecord,
  type SessionIndex,
  type TemporalFetchers,
  type TemporalOrigins,
} from './TemporalData.js'

/**
 * How often the temporal feeds are re-read while the page stays open. Activity
 * is minute-grained and the live chunk's edge is quantized to
 * `chronicleWindow.LIVE_QUANTUM_MS`, so a faster cadence would mostly re-read
 * the same answer.
 */
export const TEMPORAL_REFRESH_MS = 5 * 60_000

/** The commit ledger held for one drawn window. */
export interface WindowCommits {
  /** The window's identity — see {@link commitsKey}. */
  key: string
  records: readonly CommitRecord[]
}

export class ChronicleFeeds {
  private chunks = new Map<string, readonly ActivityBucket[]>()
  /** When the last sweep was issued, epoch-ms; 0 before the first lands. */
  private sweptAtMs = 0
  private sweeping: Promise<void> | null = null
  private index: SessionIndex = { byTmux: new Map(), bySession: new Map() }
  private sessionOrigins: TemporalOrigins = {}
  /** A pass that fetched no chunk carries no origins block, so the last one
   *  seen is kept rather than being read as "everything is fresh". */
  private activityOrigins: TemporalOrigins = {}
  private held: WindowCommits | null = null
  /** The window the newest commits request was for. A response for any other
   *  window is about a range the reader has left, and is dropped. */
  private commitsWanted: string | null = null

  /** The last sweep's instant — a key for anything read on the sweep's
   *  cadence, like the scoped era's look-back. */
  get sweptAt(): number {
    return this.sweptAtMs
  }

  /** The session ledger's two lookups, as of the last sweep. */
  get sessionIndex(): SessionIndex {
    return this.index
  }

  /** The commit ledger held for the drawn window, or null before one lands. It
   *  may answer for a narrower window than the one drawn while a grown
   *  window's ledger is out; its `key` says which. */
  get commits(): WindowCommits | null {
    return this.held
  }

  /** Per-origin freshness. Activity's block wins over the ledger's where they
   *  overlap — it is the feed the ink comes from. */
  origins(): TemporalOrigins {
    return { ...this.sessionOrigins, ...this.activityOrigins }
  }

  /**
   * Bring the held data up to what `window` needs. Resolves once everything it
   * asked for is stored; never rejects, because every fetcher degrades to an
   * empty result.
   */
  async sync(
    fetchers: TemporalFetchers,
    window: DayRange,
    opts: { force?: boolean; nowMs?: number } = {},
  ): Promise<void> {
    const nowMs = opts.nowMs ?? Date.now()
    if (opts.force || this.sweeping || nowMs - this.sweptAtMs >= TEMPORAL_REFRESH_MS) {
      await this.sweep(fetchers, window, nowMs)
    }
    await Promise.all([this.fetchMissingChunks(fetchers, window), this.fetchCommits(fetchers, window)])
  }

  /**
   * The buckets for every chunk `window` wants, and nothing else held: a year
   * of scrolling does not accumulate every chunk ever visited.
   */
  buckets(window: DayRange): ActivityBucket[] {
    const keep = new Map<string, readonly ActivityBucket[]>()
    for (const chunk of activityChunks(window, this.sweptAtMs)) {
      const held = this.chunks.get(chunk.key)
      if (held) keep.set(chunk.key, held)
    }
    this.chunks = keep
    return [...keep.values()].flat()
  }

  /** One sweep at a time; a sync arriving mid-sweep waits on the one out. */
  private sweep(fetchers: TemporalFetchers, window: DayRange, at: number): Promise<void> {
    this.sweeping ??= this.runSweep(fetchers, window, at).finally(() => {
      this.sweeping = null
    })
    return this.sweeping
  }

  /** Stored in one step once everything is back, so a paint never sees a new
   *  live chunk beside an old ledger. */
  private async runSweep(fetchers: TemporalFetchers, window: DayRange, at: number): Promise<void> {
    const live = activityChunks(window, at).filter((chunk) => chunk.live)
    const key = commitsKey(window)
    this.commitsWanted = key
    const [results, sessions, commits] = await Promise.all([
      Promise.all(live.map((chunk) => fetchers.activity(chunk.fromMs, chunk.toMs))),
      fetchers.sessions(0),
      fetchers.commits(...commitsSpan(window)),
    ])
    // An error never clears data. Every fetcher degrades to an empty result
    // rather than rejecting, and marks it by leaving `host` blank — so a
    // tunnel blip is indistinguishable from a quiet day unless we check.
    // Storing one would blank Chronicle's live column and the 15s board poll
    // would repaint that blank until the next sweep or a manual refresh.
    live.forEach((chunk, i) => {
      if (landed(results[i])) this.chunks.set(chunk.key, results[i].buckets)
    })
    this.noteActivityOrigins(results)
    if (landed(sessions)) {
      this.index = buildSessionIndex(sessions.records)
      this.sessionOrigins = sessions.origins ?? {}
    }
    if (this.commitsWanted === key && landed(commits)) this.held = { key, records: commits.records }
    // Only a sweep that actually read something counts as a sweep; otherwise
    // the failure would be cached for the whole refresh interval.
    if (results.every(landed) && landed(sessions) && landed(commits)) this.sweptAtMs = at
  }

  /** The chunks `window` wants that are not held — the settled ones a scroll
   *  reached. Concurrent syncs asking for the same chunk share one request
   *  (the fetchers dedupe identical in-flight asks). */
  private async fetchMissingChunks(fetchers: TemporalFetchers, window: DayRange): Promise<void> {
    const missing = activityChunks(window, this.sweptAtMs).filter((chunk) => !this.chunks.has(chunk.key))
    if (missing.length === 0) return
    const results = await Promise.all(missing.map((chunk) => fetchers.activity(chunk.fromMs, chunk.toMs)))
    // Same rule as the sweep, and it bites harder here: these chunks are
    // settled, so a stored failure is never re-read and the day stays blank
    // for the life of the page.
    missing.forEach((chunk, i) => {
      if (landed(results[i])) this.chunks.set(chunk.key, results[i].buckets)
    })
    this.noteActivityOrigins(results)
  }

  /** The window's commit ledger, when the one held answers a different
   *  window. A sweep re-reads it on the sweep's own cadence. */
  private async fetchCommits(fetchers: TemporalFetchers, window: DayRange): Promise<void> {
    const key = commitsKey(window)
    if (this.held?.key === key) return
    this.commitsWanted = key
    const res = await fetchers.commits(...commitsSpan(window))
    if (this.commitsWanted === key) this.held = { key, records: res.records }
  }

  private noteActivityOrigins(results: readonly ActivityResult[]): void {
    const fresh: TemporalOrigins = {}
    for (const res of results) Object.assign(fresh, res.origins ?? {})
    if (Object.keys(fresh).length > 0) this.activityOrigins = fresh
  }
}

/** Whether a temporal fetch actually reached its daemon. Every fetcher in
 *  `TemporalData` degrades to an empty result rather than rejecting, and the
 *  only thing distinguishing that from a genuinely empty window is the blank
 *  `host` the fallback carries. */
function landed(result: { host: string }): boolean {
  return result.host !== ''
}

/** A drawn window's identity for its commit ledger. */
function commitsKey(window: DayRange): string {
  return `${window.first}:${window.last}`
}

/** The instants a drawn window's commit ledger is asked over: local midnight
 *  of its first day to the last second of its last. */
function commitsSpan(window: DayRange): [number, number] {
  const fromMs = civilDayToLocalDate(window.first)?.getTime() ?? 0
  const toMs = (civilDayToLocalDate(window.last)?.getTime() ?? 0) + 86_399_000
  return [fromMs, toMs]
}
