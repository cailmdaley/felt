/**
 * TemporalData — the read plane of the board's temporal feeds.
 *
 * Three daemon feeds, all read-only and all OPTIONAL:
 *
 *   activity   coarse per-minute activity buckets (what the machine was doing)
 *   sessions   the fiber↔session ledger (whose work a minute was)
 *   commits    the commit↔session ledger (whose work a COMMIT was)
 *
 * The two ledgers are RECORDS, written when the thing happened: the dispatcher
 * wrote the session down, a hook wrote the commit down. That is why they are
 * the only sources the views join on — a commit's subject line is a convention
 * a human types, and a page built on it attributes work by guessing.
 *
 * Each is read CROSS-HOST — `/api/v1/<feed>/composite`, which serves this
 * daemon's live read concatenated with every remote's cached read, each item
 * stamped with the host it came from, plus an `origins` block reporting
 * per-origin freshness (the fibers composite's block verbatim; see
 * {@link TemporalOrigin}). The result always carries hosts and an origins
 * block, so a view never has to ask where an item came from.
 *
 * EVERY ROUTE TAKES INSTANTS, and that is the point. A civil day resolved in
 * the DAEMON's zone is a different window from the same day resolved in the
 * browser's: a UTC daemon serving a UTC+2 browser moves it two hours and can
 * drop a day's work outright (measured). So a view resolves its own civil days
 * here, in the browser's zone, and the routes only ever speak `from_ms`/
 * `to_ms`.
 *
 * A feed that cannot be read must not break the board, so every failure path —
 * 404, 5xx, network error, malformed body — resolves to an EMPTY result rather
 * than rejecting. A view therefore never needs a
 * try/catch; it renders "nothing here" for a daemon that can't answer.
 *
 * Nothing is cached here. HOW OFTEN a feed is read is the caller's decision —
 * Chronicle holds what it fetched and re-reads on its own cadence — so the
 * fetchers only collapse IDENTICAL CONCURRENT requests onto one in-flight
 * promise: the burst of callers asking for the same window in one pass costs
 * one round trip, and the next ask after it settles goes to the daemon.
 */

import { daemonFetch } from '../daemonApi.js'

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
  k: 'attention' | 'notify' | 'agent' | 'reply'
  n: number
  /** Which daemon's events file produced it. The composite stamps every
   *  bucket; the fetcher fills an unstamped one from the response's own
   *  `host`, so a bucket always knows where it came from. Absent only on a
   *  bucket nobody stamped — a mock — which the joins read as "host unknown",
   *  never as "local". */
  host?: string | null
}

export interface ActivityResult {
  host: string
  from_ms: number
  to_ms: number
  buckets: ActivityBucket[]
  origins?: TemporalOrigins
}

/**
 * One origin's freshness, verbatim the fibers composite's block (see
 * `CompositeOrigin` in KanbanComposite.ts) plus activity's per-origin covered
 * `window`.
 *
 * The honesty contract: an unreachable remote keeps serving its last-good data
 * marked `stale`, and the view grays it rather than dropping it. A `window`
 * narrower than the span asked for is not an error either — that origin's data
 * simply thins out where it has nothing cached.
 */
export interface TemporalOrigin {
  kind: 'local' | 'remote'
  stale: boolean
  lastPolledAt?: string
  lastError?: string
  /** Activity only: the span this origin can actually answer for, or absent
   *  when it has never been polled successfully ("no idea", which is not the
   *  same claim as an empty window). */
  window?: { fromMs: number; toMs: number }
}

/** Origin name (host id) → its freshness. The fetchers always populate one
 *  (synthesizing a lone local origin for a daemon that serves no block); it is
 *  optional on the result types only so a mock can omit it. */
export type TemporalOrigins = Record<string, TemporalOrigin>

export interface ActiveMinutes {
  /** Minutes carrying ANY signal — a minute counts once, not once per kind, so
   *  this is wall-clock time and not a sum of overlaps. */
  all: number
  attention: number
  agent: number
}

/**
 * Distinct active minutes by kind, inside an optional half-open span.
 *
 * A bucket IS a minute: `Shuttle.Activity` keys every event by
 * `div(ts, 60_000) * 60_000` unconditionally (daemon/lib/shuttle/activity.ex), so
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
  for (const b of buckets) {
    if (span && (b.m < span.fromMs || b.m >= span.toMs)) continue
    const minute = Math.floor(b.m / 60_000)
    all.add(minute)
    if (b.k === 'attention') attention.add(minute)
    // A reply is agent-side ink: the turn that produced it was agent work.
    else if (b.k === 'agent' || b.k === 'reply') agent.add(minute)
    // `notify` still arrives on the wire and is counted in `all` as a minute
    // that happened, but it has no tally of its own: the board draws no notify
    // state anywhere.
  }
  return { all: all.size, attention: attention.size, agent: agent.size }
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
  /** The agent id the session was dispatched as, on ledger lines that name one. */
  agent?: string
}

export interface SessionsResult {
  host: string
  records: SessionRecord[]
  origins?: TemporalOrigins
}

/**
 * One line of the COMMIT LEDGER — a commit and the harness session that made
 * it, as the commit hook wrote it.
 *
 * A `slug: ` prefix is a convention a human types and can mistype; `session` is
 * the id the harness was running under at the moment of the commit, so joining
 * it through the session ledger names the fiber as a FACT rather than as a
 * reading of the subject line. It covers only commits made after the hook
 * existed — a page simply has no prose for the days before that, which is the
 * honest answer.
 *
 *   at          epoch-ms the commit was recorded
 *   sha         the commit's 40-hex sha — the commit's identity
 *   subject     the commit subject, verbatim
 *   repo        absolute path of the repo root, or null
 *   files       files touched
 *   insertions  lines added
 *   deletions   lines removed
 *   session     harness session UUID, or null for a commit made by hand
 *   tmux        tmux session name, or null
 *   cwd         where `git commit` ran
 *   host        the daemon the record came from (the composite stamps every one)
 */
export interface CommitRecord {
  at: number
  sha: string
  subject: string
  repo: string | null
  files: number
  insertions: number
  deletions: number
  session: string | null
  tmux: string | null
  cwd: string | null
  host: string | null
}

export interface CommitsResult {
  host: string
  records: CommitRecord[]
  origins?: TemporalOrigins
}

/** What the ledger can tell you about a session: whose work it was, and which
 *  harness session it was — the id a commit record names it by. */
export interface SessionPairing {
  fiber: string
  uid: string | null
  /** Harness session UUID (the ledger's `session`). */
  session: string
  /** The daemon that recorded the pairing. */
  host: string | null
}

/**
 * The ledger, turned into the two lookups a view actually performs.
 *
 * `byTmux` is JOIN RUNG 0 for activity: an `ActivityBucket`'s `s` is the
 * TMUX SESSION NAME (see `Shuttle.Activity` — buckets key on
 * `{minute, tmuxSession, cwd, kind}`), so this is the map a bucket joins
 * through, and it beats every existing rung because it is a recorded fact
 * rather than an inference from a name.
 *
 * `bySession` is keyed by harness session UUID — the key a commit record
 * carries, and so the commit ledger's join. It costs nothing to build in the
 * same pass.
 */
export interface SessionIndex {
  byTmux: Map<string, SessionPairing>
  bySession: Map<string, SessionPairing>
}

/** The fetchers a {@link import('./ViewRegistry.js').ViewContext} exposes to
 *  views. KanbanModal builds one per board; the harness injects a
 *  mock implementation of the same shape. */
export interface TemporalFetchers {
  activity(fromMs: number, toMs: number): Promise<ActivityResult>
  sessions(sinceMs: number): Promise<SessionsResult>
  /**
   * The FLEET's commit ledger over `[sinceMs, untilMs]` — every commit the
   * hook recorded, each carrying the harness session that made it.
   *
   * Both ends are INSTANTS, for the reason the whole module is: a civil window
   * resolved in the daemon's zone is a different window from the same one
   * resolved in the browser's.
   */
  commits(sinceMs: number, untilMs: number): Promise<CommitsResult>
}

/**
 * Build the fetchers for one daemon base. The in-flight map is per-instance
 * (not module-global) so two boards — or a test and a board — never share
 * state.
 *
 * @param shuttleBase daemon origin, or '' for same-origin relative fetches.
 */
export function createTemporalFetchers(shuttleBase: string): TemporalFetchers {
  const inFlight = new Map<string, Promise<unknown>>()

  /** One request per key at a time; the entry leaves the map as it settles,
   *  so the next ask is a fresh read. The produced promise never rejects (every
   *  feed degrades to empty), so `finally` is the only settle to hang on. */
  const dedupe = <T>(key: string, produce: () => Promise<T>): Promise<T> => {
    const held = inFlight.get(key)
    if (held) return held as Promise<T>
    const value = produce().finally(() => inFlight.delete(key))
    inFlight.set(key, value)
    return value
  }

  /**
   * Read a feed's cross-host composite. Every failure — 404, 5xx, network
   * error — returns null and the caller degrades to empty for this window
   * only; the next window asks again.
   */
  const readFeed = async (feed: string, query: string): Promise<unknown> => {
    const res = await daemonFetch(`${shuttleBase}/api/v1/${feed}/composite?${query}`)
    if (!res.ok) return null
    return await res.json()
  }

  return {
    activity(fromMs: number, toMs: number): Promise<ActivityResult> {
      return dedupe(`activity:${fromMs}:${toMs}`, async () => {
        const empty: ActivityResult = {
          host: '',
          from_ms: fromMs,
          to_ms: toMs,
          buckets: [],
          origins: {},
        }
        try {
          const body = await readFeed(
            'activity',
            `from_ms=${encodeURIComponent(String(fromMs))}&to_ms=${encodeURIComponent(String(toMs))}`,
          )
          return parseActivity(body, empty)
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
      return dedupe(`sessions:${sinceMs}`, async () => {
        const empty: SessionsResult = { host: '', records: [], origins: {} }
        try {
          const body = await readFeed(
            'sessions',
            `since_ms=${encodeURIComponent(String(sinceMs))}`,
          )
          return parseSessions(body, empty)
        } catch {
          return empty
        }
      })
    },

    /**
     * The commit ledger over a window. Same composite read as the other two
     * feeds, same degrade-to-empty on every failure path.
     *
     * Keyed on the window, not on a constant like `sessions(0)`: this file
     * grows one line per COMMIT rather than one per session, so a whole-history
     * read is not the cheap thing it is there, and every caller already knows
     * which window it is drawing.
     */
    commits(sinceMs: number, untilMs: number): Promise<CommitsResult> {
      return dedupe(`commits:${sinceMs}:${untilMs}`, async () => {
        const empty: CommitsResult = { host: '', records: [], origins: {} }
        try {
          const body = await readFeed(
            'commits',
            `since_ms=${encodeURIComponent(String(sinceMs))}` +
              `&until_ms=${encodeURIComponent(String(untilMs))}`,
          )
          return parseCommits(body, empty)
        } catch {
          return empty
        }
      })
    },
  }
}

const BUCKET_KINDS = new Set<ActivityBucket['k']>(['attention', 'notify', 'agent', 'reply'])

/** Coerce a wire body into an ActivityResult, dropping malformed buckets. */
function parseActivity(body: unknown, fallback: ActivityResult): ActivityResult {
  if (!isRecord(body)) return fallback
  const host = typeof body.host === 'string' ? body.host : fallback.host
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
      // The composite stamps each bucket; an unstamped one belongs to the
      // daemon that served the response.
      host: text(entry.host) ?? (host || null),
    })
  }
  return {
    host,
    from_ms: typeof body.from_ms === 'number' ? body.from_ms : fallback.from_ms,
    to_ms: typeof body.to_ms === 'number' ? body.to_ms : fallback.to_ms,
    buckets,
    origins: parseOrigins(body.origins, host),
  }
}

/**
 * Coerce the composite's `origins` block. Snake-case on the wire, camel here —
 * the same translation `parseCompositeFeed` does for the fibers composite,
 * because the two blocks are deliberately the same shape.
 *
 * The serving daemon is always an origin: if the block does not name it,
 * synthesize it as local and fresh. That keeps "is this origin stale?" a total
 * question for every host a response reports.
 */
function parseOrigins(value: unknown, localHost: string): TemporalOrigins {
  const out: TemporalOrigins = {}
  if (isRecord(value)) {
    for (const [name, raw] of Object.entries(value)) {
      if (!isRecord(raw)) continue
      const origin: TemporalOrigin = {
        kind: raw.kind === 'local' ? 'local' : 'remote',
        stale: raw.stale === true,
      }
      const polled = text(raw.last_polled_at)
      const error = text(raw.last_error)
      if (polled) origin.lastPolledAt = polled
      if (error) origin.lastError = error
      const window = parseWindow(raw.window)
      if (window) origin.window = window
      out[name] = origin
    }
  }
  if (localHost && !out[localHost]) out[localHost] = { kind: 'local', stale: false }
  return out
}

function parseWindow(value: unknown): { fromMs: number; toMs: number } | null {
  if (!isRecord(value)) return null
  const from = value.from_ms
  const to = value.to_ms
  if (typeof from !== 'number' || !Number.isFinite(from)) return null
  if (typeof to !== 'number' || !Number.isFinite(to)) return null
  return { fromMs: from, toMs: to }
}

/**
 * Is `origin`'s data stale, by name? Unknown names read fresh: an origin the
 * block does not mention is one nothing claims to be waiting on, and graying
 * data on a name we cannot resolve would be a guess dressed as a fact.
 */
export function isOriginStale(origins: TemporalOrigins, host: string | null): boolean {
  if (!host) return false
  return origins[host]?.stale === true
}

/** The origins the block reports stale, in name order. */
export function staleOrigins(origins: TemporalOrigins): string[] {
  return Object.entries(origins)
    .filter(([, origin]) => origin.stale)
    .map(([name]) => name)
    .sort()
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
  const host = typeof body.host === 'string' ? body.host : fallback.host
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
      // A record the serving daemon wrote before it stamped hosts belongs to
      // that daemon; on the composite every record carries its own.
      host: text(entry.host) ?? (host || null),
      tmux: text(entry.tmux),
      kind: kind as SessionRecord['kind'],
      ...(text(entry.agent) ? { agent: text(entry.agent)! } : {}),
    })
  }
  return { host, records, origins: parseOrigins(body.origins, host) }
}

const SHA_RE = /^[0-9a-f]{40}$/

/** A 40-hex sha, lower-cased, or null. Anything else is not an identity, and a
 *  half-sha would let two different commits dedupe against each other. */
function normalizeSha(value: unknown): string | null {
  const raw = text(value)?.toLowerCase()
  return raw && SHA_RE.test(raw) ? raw : null
}

/**
 * Coerce a wire body into a CommitsResult, dropping malformed lines.
 *
 * A line with no readable SHA is dropped, not repaired. The sha is a commit's
 * identity, and it is what lets the same commit served twice — a remote's
 * cached read overlapping the local one — be recognized as one commit rather
 * than narrated twice.
 *
 * `kind` is read but not required: the route serves commits, and a daemon that
 * stamps the field is only agreeing with the path it was reached on. A record
 * announcing some OTHER kind is dropped, because that is a body this parser
 * does not understand.
 */
export function parseCommits(body: unknown, fallback: CommitsResult): CommitsResult {
  if (!isRecord(body)) return fallback
  const host = typeof body.host === 'string' ? body.host : fallback.host
  const raw = Array.isArray(body.records) ? body.records : []
  const records: CommitRecord[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const sha = normalizeSha(entry.sha)
    const subject = typeof entry.subject === 'string' ? entry.subject : null
    const kind = text(entry.kind)
    if (!sha || subject === null) continue
    if (kind && kind !== 'commit') continue
    records.push({
      at: count(entry.at),
      sha,
      subject,
      repo: text(entry.repo),
      files: count(entry.files),
      insertions: count(entry.insertions),
      deletions: count(entry.deletions),
      session: text(entry.session),
      tmux: text(entry.tmux),
      cwd: text(entry.cwd),
      // As with the session ledger: a record the serving daemon wrote before it
      // stamped hosts belongs to that daemon; on the composite each carries its
      // own.
      host: text(entry.host) ?? (host || null),
    })
  }
  return { host, records, origins: parseOrigins(body.origins, host) }
}

/** A finite non-negative wire number, or 0. A missing count is not a negative
 *  one, and a NaN in a sum poisons every figure downstream of it. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
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
 *
 * CROSS-HOST: a tmux name is only unique WITHIN a host. Two daemons each
 * running a session called `run-shuttle` are two different sessions, and a
 * flat map merging their ledgers would let either claim the other's minutes.
 * So `byTmux` carries three kinds of key, and {@link lookupTmux} reads them in
 * this order:
 *
 *   `<host>NUL<tmux>`  the scoped key — exact, written for every record that
 *                      carries a host
 *   `NUL<tmux>`        a marker that SOME host owns this name, which is what
 *                      stops a bucket that knows its host from borrowing a
 *                      different host's pairing
 *   `<tmux>`           the bare name, for a bucket whose host is unknown (an
 *                      old daemon's unstamped response) or a name no host has
 *                      claimed (a ledger line written before host stamping)
 *
 * A NUL byte cannot occur in a hostname or a tmux name, so the namespaces
 * cannot collide. All obey last-record-wins by `at`; on the bare key that
 * means a collision resolves to whichever host paired most recently — a guess,
 * and reached only when nothing in the question says where the work ran.
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
    const pairing: SessionPairing = {
      fiber: record.fiber,
      uid: record.uid,
      session: record.session,
      host: record.host,
    }
    claim(bySession, sessionAt, record.session, record.at, pairing)
    if (record.tmux) {
      claim(byTmux, tmuxAt, record.tmux, record.at, pairing)
      if (record.host) {
        claim(byTmux, tmuxAt, tmuxJoinKey(record.host, record.tmux), record.at, pairing)
        claim(byTmux, tmuxAt, tmuxOwnedKey(record.tmux), record.at, pairing)
      }
    }
  }
  return { byTmux, bySession }
}

/** The host-scoped key a cross-host tmux join reads. */
export function tmuxJoinKey(host: string, tmux: string): string {
  return `${host}\u0000${tmux}`
}

/** Marker key: SOME host has claimed this tmux name. Its presence is what
 *  stops a bucket that knows its own host from falling back onto a different
 *  host's pairing. */
function tmuxOwnedKey(tmux: string): string {
  return `\u0000${tmux}`
}

/**
 * Resolve a tmux name to its pairing, preferring the host that owns it.
 *
 * The scoped key first — that is the fact. The bare name only when the caller
 * cannot say which host it is asking about, or when the ledger line predates
 * host stamping; on a fleet where two hosts share a session name, that fallback
 * can land on the wrong one, which is exactly why nothing that KNOWS its host
 * ever reaches it.
 */
export function lookupTmux(
  byTmux: ReadonlyMap<string, SessionPairing>,
  host: string | null | undefined,
  tmux: string | null | undefined,
): SessionPairing | undefined {
  if (!tmux) return undefined
  if (host) {
    const scoped = byTmux.get(tmuxJoinKey(host, tmux))
    if (scoped) return scoped
    // A caller that KNOWS its host never borrows another host's pairing: if
    // some host has claimed this name and it is not this one, the honest answer
    // is that nothing here pairs it. Only a name no host has claimed — an
    // unstamped ledger line — reaches the bare key from here.
    if (byTmux.has(tmuxOwnedKey(tmux))) return undefined
  }
  return byTmux.get(tmux)
}

/**
 * Resolve a harness session UUID to its pairing, host-scoped.
 *
 * The same refusal {@link lookupTmux} makes, reached differently. A tmux name
 * is ambiguous across a fleet and so needs scoped KEYS; a session UUID is not,
 * so the map stays keyed by the id alone and the scoping is a CHECK on the way
 * out: when the asker and the pairing both say where they are and they
 * disagree, the honest answer is that nothing here pairs it.
 *
 * A UUID colliding across hosts would be a broken harness, but two daemons'
 * ledgers merged by a composite can carry the same id for other reasons — a
 * home directory synced between machines, a ledger copied during a migration —
 * and either would silently file one host's commits under the other's fiber.
 * Either side saying nothing falls back to the id alone, which is what an
 * unstamped record has always meant here.
 */
export function lookupSession(
  bySession: ReadonlyMap<string, SessionPairing>,
  host: string | null | undefined,
  session: string | null | undefined,
): SessionPairing | undefined {
  if (!session) return undefined
  const pairing = bySession.get(session)
  if (!pairing) return undefined
  if (host && pairing.host && !sameHost(host, pairing.host)) return undefined
  return pairing
}

/** Hostnames are case-insensitive; the board lower-cases them for display and
 *  the joins have to meet them there rather than miss on case alone. */
function sameHost(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
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
