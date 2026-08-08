/**
 * TemporalData — the read plane the temporal views share.
 *
 * Two daemon routes, both read-only and both OPTIONAL:
 *
 *   GET /api/v1/activity?from_ms=&to_ms=   coarse per-minute activity buckets
 *                                          (what the machine was doing, and where)
 *   GET /api/v1/narration?from=&to=        the commit trail over a window
 *                                          (what the work says it did)
 *
 * A daemon older than these routes answers 404. That must not break the board,
 * so every failure path — 404, 5xx, network error, malformed body — resolves to
 * an EMPTY result rather than rejecting. A view therefore never needs a
 * try/catch; it renders "nothing here" for a daemon that can't answer.
 *
 * Responses are cached in memory for {@link TEMPORAL_TTL_MS}, keyed on the
 * argument tuple, and the cache holds the in-flight PROMISE — so the 15s board
 * poll driving several views' refresh() at once collapses to one request per
 * window. Empty (failed) results are cached the same way, which keeps an old
 * daemon from being re-probed every poll.
 */

/** One coarse activity bucket. Field names are the wire's — deliberately
 *  terse, because a day of minute buckets is a lot of JSON:
 *    m   epoch-ms of the bucket start
 *    s   session id, or null when unattributed
 *    cwd working directory, or null when unattributed
 *    k   what kind of signal produced it
 *    n   event count in the bucket */
export interface ActivityBucket {
  m: number
  s: string | null
  cwd: string | null
  k: 'attention' | 'notify' | 'agent'
  n: number
}

export interface ActivityResult {
  host: string
  from_ms: number
  to_ms: number
  buckets: ActivityBucket[]
}

export interface NarrationCommit {
  iso: string
  subject: string
}

export interface NarrationResult {
  commits: NarrationCommit[]
}

/** Cache lifetime. Comfortably longer than the board's 15s poll, so a view
 *  that refreshes on every poll hits the network at most once a minute. */
export const TEMPORAL_TTL_MS = 60_000

/** The pair of fetchers a {@link import('./ViewRegistry.js').ViewContext}
 *  exposes to views. KanbanModal builds one per board; the harness injects a
 *  mock implementation of the same shape. */
export interface TemporalFetchers {
  activity(fromMs: number, toMs: number): Promise<ActivityResult>
  narration(fromISO: string, toISO: string): Promise<NarrationResult>
}

interface CacheEntry<T> {
  at: number
  value: Promise<T>
}

/**
 * Build the fetch pair for one daemon base. The cache is per-instance (not
 * module-global) so two boards — or a test and a board — never share state.
 *
 * @param shuttleBase daemon origin, or '' for same-origin relative fetches.
 */
export function createTemporalFetchers(shuttleBase: string): TemporalFetchers {
  const cache = new Map<string, CacheEntry<unknown>>()

  const memo = <T>(key: string, produce: () => Promise<T>): Promise<T> => {
    const now = Date.now()
    const hit = cache.get(key)
    if (hit && now - hit.at < TEMPORAL_TTL_MS) return hit.value as Promise<T>
    const value = produce()
    cache.set(key, { at: now, value: value as Promise<unknown> })
    return value
  }

  const readJson = async (url: string): Promise<unknown> => {
    const res = await fetch(url)
    if (!res.ok) return null
    return await res.json()
  }

  return {
    activity(fromMs: number, toMs: number): Promise<ActivityResult> {
      return memo(`activity:${fromMs}:${toMs}`, async () => {
        const empty: ActivityResult = { host: '', from_ms: fromMs, to_ms: toMs, buckets: [] }
        try {
          const body = await readJson(
            `${shuttleBase}/api/v1/activity?from_ms=${encodeURIComponent(String(fromMs))}&to_ms=${encodeURIComponent(String(toMs))}`,
          )
          return parseActivity(body, empty)
        } catch {
          return empty
        }
      })
    },

    narration(fromISO: string, toISO: string): Promise<NarrationResult> {
      return memo(`narration:${fromISO}:${toISO}`, async () => {
        const empty: NarrationResult = { commits: [] }
        try {
          const body = await readJson(
            `${shuttleBase}/api/v1/narration?from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}`,
          )
          return parseNarration(body, empty)
        } catch {
          return empty
        }
      })
    },
  }
}

const BUCKET_KINDS = new Set<ActivityBucket['k']>(['attention', 'notify', 'agent'])

/** Coerce a wire body into an ActivityResult, dropping malformed buckets.
 *  Exported for the views' own tests; the fetchers apply it themselves. */
export function parseActivity(body: unknown, fallback: ActivityResult): ActivityResult {
  if (!isRecord(body)) return fallback
  const raw = Array.isArray(body.buckets) ? body.buckets : []
  const buckets: ActivityBucket[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const m = entry.m
    const k = entry.k
    const n = entry.n
    if (typeof m !== 'number' || !Number.isFinite(m)) continue
    if (typeof k !== 'string' || !BUCKET_KINDS.has(k as ActivityBucket['k'])) continue
    buckets.push({
      m,
      s: typeof entry.s === 'string' ? entry.s : null,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
      k: k as ActivityBucket['k'],
      n: typeof n === 'number' && Number.isFinite(n) ? n : 0,
    })
  }
  return {
    host: typeof body.host === 'string' ? body.host : fallback.host,
    from_ms: typeof body.from_ms === 'number' ? body.from_ms : fallback.from_ms,
    to_ms: typeof body.to_ms === 'number' ? body.to_ms : fallback.to_ms,
    buckets,
  }
}

/** Coerce a wire body into a NarrationResult, dropping malformed commits. */
export function parseNarration(body: unknown, fallback: NarrationResult): NarrationResult {
  if (!isRecord(body)) return fallback
  const raw = Array.isArray(body.commits) ? body.commits : []
  const commits: NarrationCommit[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    if (typeof entry.iso !== 'string' || typeof entry.subject !== 'string') continue
    commits.push({ iso: entry.iso, subject: entry.subject })
  }
  return { commits }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
