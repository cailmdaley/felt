/**
 * TemporalData — the read plane the temporal views share.
 *
 * Two daemon routes, both read-only and both OPTIONAL:
 *
 *   GET /api/v1/activity?from_ms=&to_ms=   coarse per-minute activity buckets
 *                                          (what the machine was doing, and where)
 *   GET /api/v1/narration?from_ms=&to_ms=  the commit trail over a window
 *                                          (what the work says it did)
 *
 * BOTH ROUTES TAKE INSTANTS, and that is the point. `narration` still *reads*
 * inclusive civil days from its callers — that is the unit a temporal view
 * thinks in — but it resolves them to epoch-ms HERE, in the browser's zone,
 * and sends `from_ms`/`to_ms`. Resolving a civil day in the DAEMON's zone
 * instead shifts the whole window by the offset between them: a UTC daemon
 * serving a UTC+2 browser moved it two hours and could drop a day's commits
 * outright (measured; see `Shuttle.Narration`'s moduledoc). Instants are
 * timezone-free, so the skew cannot happen — which is why the zone-resolving
 * form is the browser's job and the routes do not offer one.
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

import { civilDayToLocalDate } from '../civilDay.js'

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

export interface ActiveMinutes {
  /** Minutes carrying ANY signal — a minute counts once, not once per kind, so
   *  this is wall-clock time and not a sum of overlaps. */
  all: number
  attention: number
  agent: number
  /** Notify BUCKETS, not notify minutes. Buckets key on
   *  `{minute, tmuxSession, cwd, kind}` (Shuttle.Activity), so two workers
   *  raising a hand in the same minute are two here — deliberately: this
   *  counts requests, not time. */
  notifyBuckets: number
}

/**
 * Distinct active minutes by kind, inside an optional half-open span.
 *
 * A bucket IS a minute: `Shuttle.Activity` keys every event by
 * `div(ts, 60_000) * 60_000` unconditionally (lib/shuttle/activity.ex), so
 * distinct `m` values ARE the minute count. Counting buckets, or summing `n`,
 * would count events — and a busy minute is still one minute.
 *
 * `span` is `[fromMs, toMs)`, closed at the start and OPEN at the end. That is
 * what makes 06:00→06:00 day windows tile: the minute at one day's `endMs`
 * belongs to the next day, and to it only.
 */
export function foldActiveMinutes(
  buckets: readonly ActivityBucket[],
  span?: { fromMs: number; toMs: number },
): ActiveMinutes {
  const all = new Set<number>()
  const attention = new Set<number>()
  const agent = new Set<number>()
  let notifyBuckets = 0
  for (const b of buckets) {
    if (span && (b.m < span.fromMs || b.m >= span.toMs)) continue
    const minute = Math.floor(b.m / 60_000)
    all.add(minute)
    if (b.k === 'attention') attention.add(minute)
    else if (b.k === 'agent') agent.add(minute)
    else notifyBuckets += 1
  }
  return { all: all.size, attention: attention.size, agent: agent.size, notifyBuckets }
}

/** `slug: what happened` — felt's commit-subject convention. The slug is the
 *  bold/mono token the writer already chose as the grouping; the remainder is
 *  the sentence. A subject with no prefix parses to a null slug and its own
 *  text as the rest — each view decides where those land. */
const COMMIT_SLUG_RE = /^([A-Za-z0-9][A-Za-z0-9._/-]*):[ \t]+(\S.*)$/

export function parseCommitSlug(subject: string): { slug: string | null; rest: string } {
  const trimmed = subject.trim()
  const match = COMMIT_SLUG_RE.exec(trimmed)
  return match ? { slug: match[1], rest: match[2].trim() } : { slug: null, rest: trimmed }
}

/**
 * One line of this host's session ledger — a fiber↔session pairing and its
 * provenance, as `Shuttle.SessionLedger` wrote it.
 *
 * `fiber`, `session` and `kind` are always present: the daemon refuses to write
 * a line without them (an unpaired row is the one thing the ledger exists to
 * rule out). Everything else can be absent — notably `tmux`, and therefore
 * `uid`, which the daemon derives FROM the tmux name when it is not supplied.
 *
 *   at       epoch-ms of the pairing
 *   fiber    fiber id
 *   uid      the fiber's ULID, or null when it could not be derived
 *   session  harness session UUID — the ledger's own key
 *   harness  'claude-code', 'codex', …
 *   host     the daemon that recorded it (a cross-host view merges on this)
 *   tmux     tmux session name, or null for a session with no terminal
 *   kind     which moment produced the line
 */
export interface SessionRecord {
  at: number
  fiber: string
  uid: string | null
  session: string
  harness: string | null
  host: string | null
  tmux: string | null
  kind: 'dispatch' | 'claim' | 'resume'
}

export interface SessionsResult {
  host: string
  records: SessionRecord[]
}

/** What the ledger can tell you about a session: whose work it was. */
export interface SessionPairing {
  fiber: string
  uid: string | null
}

/**
 * The ledger, turned into the two lookups a view actually performs.
 *
 * `byTmux` is JOIN RUNG 0 for today's views: an `ActivityBucket`'s `s` is the
 * TMUX SESSION NAME (see `Shuttle.Activity` — buckets key on
 * `{minute, tmuxSession, cwd, kind}`), so this is the map a bucket joins
 * through, and it beats every existing rung because it is a recorded fact
 * rather than an inference from a name.
 *
 * `bySession` is keyed by harness session UUID. Nothing on the activity path
 * carries one today; it is here for the transcript-side joins that will, and
 * it costs nothing to build in the same pass.
 */
export interface SessionIndex {
  byTmux: Map<string, SessionPairing>
  bySession: Map<string, SessionPairing>
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
  sessions(sinceMs: number): Promise<SessionsResult>
}

interface CacheEntry<T> {
  at: number
  value: Promise<T>
}

/**
 * Hard ceiling on cached windows. The TTL sweep alone is not enough: a view
 * that re-asks on a moving clock mints a NEW key every time (Day's window
 * slides, Week's `cap` tracks now), so keys arrive faster than they expire and
 * the map grows without bound over a long-lived board. Fifty is far more than
 * the handful of windows the four views hold at once, and each entry is one
 * result, so the cap costs nothing in practice — it only stops the leak.
 */
const TEMPORAL_CACHE_MAX = 50

/**
 * Build the fetch pair for one daemon base. The cache is per-instance (not
 * module-global) so two boards — or a test and a board — never share state.
 *
 * @param shuttleBase daemon origin, or '' for same-origin relative fetches.
 */
export function createTemporalFetchers(shuttleBase: string): TemporalFetchers {
  const cache = new Map<string, CacheEntry<unknown>>()

  /**
   * Bound the map on every access: first drop what the TTL already made
   * worthless, then, if the map is still at the ceiling, evict oldest-first.
   *
   * Oldest-first is insertion order, which `Map` preserves and which matches
   * `at` order here because an entry is only ever written once (a refresh
   * writes a NEW key — the windows themselves move). Evicting an entry whose
   * promise is still in flight is harmless: the awaiting caller keeps its own
   * reference and still resolves; a later caller simply re-requests. And a
   * pending entry is by definition among the newest, so oldest-first reaches
   * it last.
   */
  const prune = (now: number): void => {
    for (const [key, entry] of cache) {
      if (now - entry.at >= TEMPORAL_TTL_MS) cache.delete(key)
    }
    while (cache.size >= TEMPORAL_CACHE_MAX) {
      const oldest = cache.keys().next()
      if (oldest.done) break
      cache.delete(oldest.value)
    }
  }

  const memo = <T>(key: string, produce: () => Promise<T>): Promise<T> => {
    const now = Date.now()
    const hit = cache.get(key)
    if (hit && now - hit.at < TEMPORAL_TTL_MS) return hit.value as Promise<T>
    // Only prune on a MISS. A hit is the common path (the 15s poll re-asking
    // for a window it already has) and does not grow the map, so it should not
    // pay for a full sweep.
    prune(now)
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

    /**
     * @param fromISO first civil day, inclusive (`YYYY-MM-DD`).
     * @param toISO   last civil day, INCLUSIVE — the window runs through the
     *                end of this day, not up to its start.
     *
     * The cache key stays the caller's ISO tuple, not the resolved instants:
     * the day pair is what a view re-asks for, and keying on the instants
     * would only add a way for the two to disagree.
     */
    narration(fromISO: string, toISO: string): Promise<NarrationResult> {
      return memo(`narration:${fromISO}:${toISO}`, async () => {
        const empty: NarrationResult = { commits: [] }
        const span = civilDaysToInstants(fromISO, toISO)
        // Unreadable days used to be sent as-is and answered with a 400, which
        // the degrade path turned into an empty result. Same outcome, one round
        // trip cheaper.
        if (!span) return empty
        try {
          const body = await readJson(
            `${shuttleBase}/api/v1/narration?from_ms=${span.fromMs}&to_ms=${span.toMs}`,
          )
          return parseNarration(body, empty)
        } catch {
          return empty
        }
      })
    },

    /**
     * This host's session ledger from `sinceMs` onward, oldest first.
     *
     * `since_ms` is optional daemon-side and defaults to the whole ledger; pass
     * 0 for that. There is no width cap on this route — the file holds one line
     * per SESSION rather than one per hook event, so the whole history is
     * smaller than a busy hour of `/activity`.
     */
    sessions(sinceMs: number): Promise<SessionsResult> {
      return memo(`sessions:${sinceMs}`, async () => {
        const empty: SessionsResult = { host: '', records: [] }
        try {
          const body = await readJson(
            `${shuttleBase}/api/v1/sessions?since_ms=${encodeURIComponent(String(sinceMs))}`,
          )
          return parseSessions(body, empty)
        } catch {
          return empty
        }
      })
    },
  }
}

const LEADING_CIVIL_DAY_RE = /^(\d{4}-\d{2}-\d{2})/

/**
 * Resolve an INCLUSIVE civil-day pair to the epoch-ms window covering it, in
 * the BROWSER's timezone — the whole substance of the instant migration.
 *
 * `from` becomes local midnight of its day; `to` becomes local 23:59:59.999 of
 * its day, because `to` is inclusive and the window has to reach the end of it.
 * Those two land exactly where the daemon's legacy civil form put them
 * (`--since=<day> 00:00:00` / `--until=<day> 23:59:59`), so a browser and
 * daemon sharing a timezone see byte-identical results before and after — the
 * migration only bites where the two zones DIFFER, which is the bug.
 *
 * `new Date(y, m, d, …)` is the local-time constructor, so DST is handled by
 * the platform: a 23-hour day is 23 hours here. The one place it slips is a
 * zone whose DST transition is at midnight itself (America/Santiago, Lord
 * Howe), where local midnight does not exist and the runtime rolls forward an
 * hour. That costs an hour at the head of the window in two zones twice a
 * year, against a decorative commit strip — not worth a timezone library.
 *
 * Null when either end carries no readable civil day. A full ISO timestamp is
 * read for its leading day, which keeps a caller that hands over an instant
 * working rather than blanking its strip.
 */
export function civilDaysToInstants(
  fromISO: string,
  toISO: string,
): { fromMs: number; toMs: number } | null {
  const fromDay = LEADING_CIVIL_DAY_RE.exec(fromISO.trim())?.[1]
  const toDay = LEADING_CIVIL_DAY_RE.exec(toISO.trim())?.[1]
  if (!fromDay || !toDay) return null
  const from = civilDayToLocalDate(fromDay)
  const to = civilDayToLocalDate(toDay)
  if (!from || !to) return null
  to.setHours(23, 59, 59, 999)
  return { fromMs: from.getTime(), toMs: to.getTime() }
}

const BUCKET_KINDS = new Set<ActivityBucket['k']>(['attention', 'notify', 'agent'])

/** Coerce a wire body into an ActivityResult, dropping malformed buckets. */
function parseActivity(body: unknown, fallback: ActivityResult): ActivityResult {
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
function parseNarration(body: unknown, fallback: NarrationResult): NarrationResult {
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

const SESSION_KINDS = new Set<SessionRecord['kind']>(['dispatch', 'claim', 'resume'])

/**
 * Coerce a wire body into a SessionsResult, dropping malformed lines.
 *
 * A line without `fiber`, `session` or a known `kind` is dropped rather than
 * repaired: the daemon never writes one, so its presence means the body is not
 * a ledger, and a half-record would pair a session to nothing. Blank strings
 * count as absent — `""` is what a missing field looks like after a bad
 * serializer, not a fiber named empty.
 */
export function parseSessions(body: unknown, fallback: SessionsResult): SessionsResult {
  if (!isRecord(body)) return fallback
  const raw = Array.isArray(body.records) ? body.records : []
  const records: SessionRecord[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const fiber = text(entry.fiber)
    const session = text(entry.session)
    const kind = text(entry.kind)
    if (!fiber || !session) continue
    if (!kind || !SESSION_KINDS.has(kind as SessionRecord['kind'])) continue
    records.push({
      at: typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0,
      fiber,
      uid: text(entry.uid),
      session,
      harness: text(entry.harness),
      host: text(entry.host),
      tmux: text(entry.tmux),
      kind: kind as SessionRecord['kind'],
    })
  }
  return {
    host: typeof body.host === 'string' ? body.host : fallback.host,
    records,
  }
}

/**
 * Turn ledger records into the two pairing lookups, in ONE pass.
 *
 * LAST RECORD WINS, and "last" means newest by `at`, not last in the array. The
 * wire is oldest-first, so array order would usually do — but the ledger is
 * host-scoped and a cross-host view merges several daemons' records, and a
 * merged array is not globally sorted. Ordering by `at` (ties broken by the
 * later array position) makes the result independent of how the caller
 * assembled its input, which is the only way two views can be relied on to
 * agree. It matters in practice: a session dispatched, then resumed, has two
 * lines, and the resume is the one that describes it now.
 *
 * A record with no `tmux` contributes to `bySession` only. That is not an
 * error — a session with no terminal is a real thing the ledger records — so it
 * is silently absent from `byTmux` rather than dropped from both.
 */
export function buildSessionIndex(records: readonly SessionRecord[]): SessionIndex {
  const byTmux = new Map<string, SessionPairing>()
  const bySession = new Map<string, SessionPairing>()
  // `at` of whatever currently occupies each key, so a later-arriving OLDER
  // record does not overwrite a newer one.
  const tmuxAt = new Map<string, number>()
  const sessionAt = new Map<string, number>()

  const claim = (
    into: Map<string, SessionPairing>,
    stamps: Map<string, number>,
    key: string,
    at: number,
    pairing: SessionPairing,
  ): void => {
    const held = stamps.get(key)
    if (held !== undefined && held > at) return
    stamps.set(key, at)
    into.set(key, pairing)
  }

  for (const record of records) {
    const pairing: SessionPairing = { fiber: record.fiber, uid: record.uid }
    claim(bySession, sessionAt, record.session, record.at, pairing)
    if (record.tmux) claim(byTmux, tmuxAt, record.tmux, record.at, pairing)
  }
  return { byTmux, bySession }
}

/** A wire string, or null — treating blank as absent. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
