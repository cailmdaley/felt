/**
 * TemporalData — the read plane the temporal views share.
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
 * Each is asked for CROSS-HOST FIRST — `/api/v1/<feed>/composite`, which serves
 * this daemon's live read concatenated with every remote's cached read, each
 * item stamped with the host it came from, plus an `origins` block reporting
 * per-origin freshness (the fibers composite's block verbatim; see
 * {@link TemporalOrigin}). A daemon older than the composites answers 404 on
 * that path, so the feed falls back to the plain single-host route ONCE and
 * remembers — the offline harness and an old daemon keep working, and neither
 * pays a wasted probe per window. Either way the result carries hosts and an
 * origins block, so a view never branches on which route answered.
 *
 * EVERY ROUTE TAKES INSTANTS, and that is the point. A civil day resolved in
 * the DAEMON's zone is a different window from the same day resolved in the
 * browser's: a UTC daemon serving a UTC+2 browser moves it two hours and can
 * drop a day's work outright (measured). So a view resolves its own civil days
 * here, in the browser's zone, and the routes only ever speak `from_ms`/
 * `to_ms`.
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
  k: 'attention' | 'notify' | 'agent' | 'reply'
  n: number
  /** Which daemon's events file produced it. The composite stamps every
   *  bucket; the single-host route does not, and the fetcher fills it from the
   *  response's own `host` so a bucket always knows where it came from.
   *  Absent only on a bucket nobody stamped — a mock, or a pre-host daemon —
   *  which the joins read as "host unknown", never as "local". */
  host?: string | null
}

/**
 * One DELEGATION, as an interval — a subagent aloft between two instants.
 *
 * It carries a bucket's identity (`s`, `cwd`, `host`) rather than a fiber's,
 * so it joins to a lane through exactly the same ledger a minute does. `open`
 * marks an interval whose close was never recorded: the daemon draws those as
 * a short stub, and its length is a mark that one STARTED, not a duration.
 */
interface SpawnSpan {
  s: string | null
  cwd: string | null
  tool: string
  start_ms: number
  end_ms: number
  open: boolean
  host?: string | null
  /** What the delegation called itself — today only a workflow, out of its own
   *  launch script. Null for an Agent or a Task, which nobody names. */
  label?: string | null
  /** How many agents a workflow spawned, counted off its own directory on the
   *  host that ran it. Null when that directory could not be read — a remote
   *  host, another harness, a cleaned disk — which is a fact about the LOOKUP
   *  and never a claim that the workflow was empty. */
  agents?: number | null
}

export interface ActivityResult {
  host: string
  from_ms: number
  to_ms: number
  buckets: ActivityBucket[]
  /** The window's delegations. Empty on a daemon that predates them, which is
   *  indistinguishable from a window in which nobody delegated — and both draw
   *  nothing, which is the right answer to either. */
  spawns: SpawnSpan[]
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
  origins?: TemporalOrigins
}

/**
 * One line of the COMMIT LEDGER — a commit and the harness session that made
 * it, as the commit hook wrote it.
 *
 * This is the record that retired prefix-parsing. A `slug: ` prefix is a
 * convention a human types and can mistype; `session` is the id the harness was
 * running under at the moment of the commit, so joining it through the session
 * ledger names the fiber as a FACT rather than as a reading of the subject
 * line. It covers only commits made after the hook existed — a page simply has
 * no prose for the days before that, which is the honest answer.
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
 *  harness session it was — the id the transcript is filed under, and so the
 *  one thing that can lead a hover from a minute to the words spoken in it. */
export interface SessionPairing {
  fiber: string
  uid: string | null
  /** Harness session UUID (the ledger's `session`). */
  session: string
  /** The daemon that recorded the pairing — where the transcript is on disk. */
  host: string | null
}

/** Which REGISTER an excerpt belongs to: the conversation's own voices, a
 *  delegation going out, or its report coming back. */
type MomentKind = 'prose' | 'spawn' | 'return'

/**
 * One excerpt from a harness transcript: what was said, when, and in which
 * register. `name` is the agent's, on the two delegation kinds only.
 *
 * `kind` is OPTIONAL on the type and never absent from a parsed response: a
 * daemon older than the registers sends excerpts with no kind at all, and
 * those are prose — which is what every excerpt was before this existed. The
 * renderer therefore reads a missing kind as prose rather than branching.
 */
export interface MomentExcerpt {
  at_ms: number
  role: 'user' | 'assistant' | 'notification'
  text: string
  kind?: MomentKind
  name?: string | null
}

export interface MomentResult {
  host: string
  excerpts: MomentExcerpt[]
  /**
   * How many messages the window held, before `excerpts` was cut to the
   * daemon's cap. Never smaller than `excerpts.length`.
   *
   * THE COUNT IS WHAT MAKES THE CUT SAYABLE. A slip shown six of fourteen
   * messages can only be honest about it if it knows there were fourteen —
   * without this it either states a number from somewhere else (the activity
   * plane's per-minute event tally, which counts something different) or says
   * nothing and lets six look like all of them. Absent from a daemon older
   * than the field, which is read as "the list is all there was".
   */
  excerptCount?: number
  /** One line per tool call (`"Bash — run the tests"`), oldest first, cut to
   *  the daemon's cap for this fetch — six on a hover, all of them on a pin. */
  toolLines?: string[]
  /** How many calls the window held, before `toolLines` was cut. The number a
   *  `×N` beside that list is allowed to say, and the only one. */
  toolCount?: number
  /** What ran, in the older single-string form — `"Bash ×2 · Read"`, or one
   *  call per line. Superseded by `toolLines`/`toolCount` and read only from a
   *  daemon that sends no `tool_lines`. */
  tools?: string
  /** Set when the words exist but not on the daemon that answered — a remote
   *  that is unreachable says where they live rather than pretending they are
   *  gone. */
  note?: string
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

/** Cache lifetime. Comfortably longer than the board's 15s poll, so a view
 *  that refreshes on every poll hits the network at most once a minute. */
/** Below the 15s poll interval on purpose: the memo exists to dedupe the
 *  burst of identical fetches within one render pass (many lanes, one
 *  window), not to outlive the poll — a TTL above the poll cadence made
 *  the views feel dead (new activity took up to ~75s to appear). */
const TEMPORAL_TTL_MS = 10_000

/** The pair of fetchers a {@link import('./ViewRegistry.js').ViewContext}
 *  exposes to views. KanbanModal builds one per board; the harness injects a
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
   *
   * Degrades to an empty ledger on a daemon that has no such route, so a view
   * that adopts it must keep its prefix-parsing fallback for the history the
   * hook never saw.
   */
  commits(sinceMs: number, untilMs: number): Promise<CommitsResult>
  /**
   * The words a session spoke inside a window — the hover's payload.
   *
   * `host` names the daemon whose disk holds the transcript; omit it and the
   * serving daemon consults its own session ledger. Failure of any kind — a
   * 4xx, a dead tunnel, a body that is not a moment — resolves to an EMPTY
   * result rather than rejecting, because the caller is a tooltip and the
   * honest fallback (the words were not recovered) is already its default.
   *
   * `full` asks the daemon not to truncate each excerpt — the fetch a PINNED
   * tooltip makes. The cut is server-side, so a pinned slip that only relaxed
   * its CSS would still be showing an ellipsis; the two fetches are cached
   * separately, because they are two different answers about the same minute.
   */
  moment(
    session: string,
    fromMs: number,
    toMs: number,
    host?: string | null,
    full?: boolean,
  ): Promise<MomentResult>
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

  /**
   * Feeds whose composite route is known absent. A daemon older than the
   * cross-host routes answers 404 on `/…/composite`; we fall back to the plain
   * per-host route ONCE and remember, so the offline harness and an old daemon
   * do not pay a wasted round trip on every window. Per-feed rather than
   * global: the three routes shipped together, but a proxy that serves one and
   * not another should degrade one feed, not all three.
   */
  const noComposite = new Set<string>()

  /**
   * Read a feed composite-first. `query` is shared by both routes — the
   * composites take exactly the params their single-host originals do.
   *
   * A composite 404 is the ONLY signal that means "older daemon": a 5xx, a
   * network error or a malformed body could equally be a transient hiccup on a
   * daemon that does have the route, and latching those would strand a fleet
   * on single-host data until the board reloads. Those paths return null and
   * the caller degrades to empty for this window only.
   */
  const readFeed = async (feed: string, query: string): Promise<unknown> => {
    if (!noComposite.has(feed)) {
      const res = await fetch(`${shuttleBase}/api/v1/${feed}/composite?${query}`)
      if (res.ok) return await res.json()
      if (res.status !== 404) return null
      noComposite.add(feed)
    }
    return await readJson(`${shuttleBase}/api/v1/${feed}?${query}`)
  }

  return {
    activity(fromMs: number, toMs: number): Promise<ActivityResult> {
      return memo(`activity:${fromMs}:${toMs}`, async () => {
        const empty: ActivityResult = {
          host: '',
          from_ms: fromMs,
          to_ms: toMs,
          buckets: [],
          spawns: [],
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
      return memo(`sessions:${sinceMs}`, async () => {
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
     * The commit ledger over a window. Same composite-first read as the other
     * three feeds, same degrade-to-empty on every failure path.
     *
     * Keyed on the window, not on a constant like `sessions(0)`: this file
     * grows one line per COMMIT rather than one per session, so a whole-history
     * read is not the cheap thing it is there, and every caller already knows
     * which window it is drawing.
     */
    commits(sinceMs: number, untilMs: number): Promise<CommitsResult> {
      return memo(`commits:${sinceMs}:${untilMs}`, async () => {
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

    /**
     * There is no `/moment/composite` and there should not be: a transcript is
     * not a feed to merge but a file on ONE machine, so the request is aimed at
     * that machine (`host`) and the serving daemon forwards it. Hence the plain
     * `readJson` rather than `readFeed`.
     */
    moment(
      session: string,
      fromMs: number,
      toMs: number,
      host?: string | null,
      full = false,
    ): Promise<MomentResult> {
      const where = host ?? ''
      return memo(`moment:${where}:${session}:${fromMs}:${toMs}:${full ? 'full' : 'brief'}`, async () => {
        const empty: MomentResult = { host: where, excerpts: [] }
        if (!session) return empty
        const query =
          `session=${encodeURIComponent(session)}` +
          `&from_ms=${encodeURIComponent(String(fromMs))}` +
          `&to_ms=${encodeURIComponent(String(toMs))}` +
          (where ? `&host=${encodeURIComponent(where)}` : '') +
          (full ? '&full=1' : '')
        try {
          return parseMoment(await readJson(`${shuttleBase}/api/v1/moment?${query}`), empty)
        } catch {
          return empty
        }
      })
    },
  }
}

const MOMENT_ROLES = new Set<MomentExcerpt['role']>(['user', 'assistant', 'notification'])

const MOMENT_KINDS = new Set<MomentKind>(['prose', 'spawn', 'return'])

/** Coerce a wire body into a MomentResult, dropping anything malformed. A
 *  half-excerpt is dropped rather than repaired: an excerpt with no text is
 *  not a quieter excerpt, it is not one. */
export function parseMoment(body: unknown, fallback: MomentResult): MomentResult {
  if (!isRecord(body)) return fallback
  const host = typeof body.host === 'string' ? body.host : fallback.host
  const raw = Array.isArray(body.excerpts) ? body.excerpts : []
  const excerpts: MomentExcerpt[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const value = text(entry.text)
    const role = text(entry.role)
    if (!value || !role || !MOMENT_ROLES.has(role as MomentExcerpt['role'])) continue
    // A daemon that predates the registers sends no `kind`; its excerpts are
    // prose, which is exactly what they always were.
    const kind = text(entry.kind)
    excerpts.push({
      at_ms: typeof entry.at_ms === 'number' && Number.isFinite(entry.at_ms) ? entry.at_ms : 0,
      role: role as MomentExcerpt['role'],
      text: value,
      kind: kind && MOMENT_KINDS.has(kind as MomentKind) ? (kind as MomentKind) : 'prose',
      name: text(entry.name),
    })
  }
  const note = text(body.note)
  const tools = text(body.tools)
  // The per-call lines, and the two totals. Each is optional on the wire and
  // absent from a daemon that predates them — never defaulted to zero, which
  // would be a claim that nothing ran rather than an admission that nobody
  // said. A total below the list it counts is a daemon disagreeing with
  // itself; the list wins, because the list is the thing that is actually here.
  const toolLines = Array.isArray(body.tool_lines)
    ? body.tool_lines.filter((line): line is string => typeof line === 'string')
    : undefined
  const toolCount = total(body.tool_count, toolLines?.length ?? 0)
  const excerptCount = total(body.excerpt_count, excerpts.length)
  return {
    host,
    excerpts,
    ...(excerptCount === undefined ? {} : { excerptCount }),
    ...(toolLines ? { toolLines } : {}),
    ...(toolCount === undefined ? {} : { toolCount }),
    ...(note ? { note } : {}),
    ...(tools ? { tools } : {}),
  }
}

/** A wire total, never allowed below the list it is a total OF. */
function total(value: unknown, atLeast: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(Math.floor(value), atLeast)
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
      // The composite stamps each bucket; the single-host route stamps only the
      // response. Filling the response's host in here means a bucket's `host`
      // is the truth on both routes, so nothing downstream has to know which
      // one answered.
      host: text(entry.host) ?? (host || null),
    })
  }
  return {
    host,
    from_ms: typeof body.from_ms === 'number' ? body.from_ms : fallback.from_ms,
    to_ms: typeof body.to_ms === 'number' ? body.to_ms : fallback.to_ms,
    buckets,
    spawns: parseSpawns(body.spawns, host),
    origins: parseOrigins(body.origins, host),
  }
}

/**
 * Coerce the wire's `spawns`, dropping anything malformed.
 *
 * An interval with no readable pair of instants is dropped rather than
 * repaired: half an interval is not a shorter delegation, it is not one. An
 * inverted pair is dropped for the same reason.
 */
function parseSpawns(value: unknown, host: string): SpawnSpan[] {
  if (!Array.isArray(value)) return []
  const out: SpawnSpan[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const startMs = entry.start_ms
    const endMs = entry.end_ms
    const tool = text(entry.tool)
    if (typeof startMs !== 'number' || !Number.isFinite(startMs)) continue
    if (typeof endMs !== 'number' || !Number.isFinite(endMs)) continue
    if (endMs < startMs || !tool) continue
    out.push({
      s: text(entry.s),
      cwd: text(entry.cwd),
      tool,
      start_ms: startMs,
      end_ms: endMs,
      open: entry.open === true,
      label: text(entry.label),
      // A count that is not a positive whole number is not a fleet size. It is
      // dropped rather than rounded: "unknown" is a state this field already
      // has, and it is the honest one for a value nobody can read.
      agents:
        typeof entry.agents === 'number' && Number.isInteger(entry.agents) && entry.agents > 0
          ? entry.agents
          : null,
      // Same rule the buckets follow: the composite stamps each item, the
      // single-host route stamps only the response.
      host: text(entry.host) ?? (host || null),
    })
  }
  return out
}

/**
 * Coerce the composite's `origins` block. Snake-case on the wire, camel here —
 * the same translation `parseCompositeFeed` does for the fibers composite,
 * because the two blocks are deliberately the same shape.
 *
 * The single-host routes carry no block at all. Rather than leave the views
 * with nothing to key on, synthesize the one origin such a response describes:
 * itself, local and fresh. That keeps "is this origin stale?" a total question
 * on both routes.
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
