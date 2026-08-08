/**
 * ChronicleView (hotkey 2) — the long record: what was worked on, and for how
 * long.
 *
 * THE SHAPE. Days run left to right as calendar columns (28 back, 14 ahead);
 * fibers run top to bottom as rows. A fiber is drawn as one thin ink lifeline
 * from its birth to its close (or to today), so a week of work reads as a week
 * of horizontal extent — not as seven separate marks. Activity is inked ON that
 * line, one segment per civil day, in three restrained density steps. The page
 * is a chronicle, so nothing about the future is solid: ahead of today the row
 * carries only hollow marks for what is promised (`due:`) and what is armed
 * (`nextLaunchAt`).
 *
 * TIME KINDS. Every horizontal position on this page is a CIVIL DAY column.
 * Instants (`createdAt`, `closedAt`, `nextLaunchAt`, a bucket's `m`) are placed
 * by their LOCAL day via `isoDayLocal`; a `due:` is placed by the civil day it
 * names via `dueCivilDay`. The two never mix — see ../civilDay.ts for why that
 * distinction is load-bearing rather than pedantic. Day columns come from
 * `buildTimelineDays`, which strides by calendar day, so a 23-hour DST day is
 * still exactly one column.
 *
 * THE JOIN. Activity buckets know a session and a working directory; they do
 * not know a fiber. Resolving one to the other is a ladder of decreasing
 * confidence — see {@link attributeActivity}. Whatever the ladder cannot place
 * on a fiber is grouped by working directory into muted synthetic rows below
 * the fiber rows, so human work at a terminal stays visible instead of being
 * silently dropped.
 */

import { normalizeFocusDate, registerView, type TemporalView, type ViewContext } from './ViewRegistry.js'
import { createViewEmptyState, createViewPage } from './ViewPage.js'
import { buildSessionIndex, type ActivityBucket, type SessionPairing } from './TemporalData.js'
import type { KanbanCard, KanbanResponse } from '../KanbanTypes.js'
import { buildTimelineDays, type TimelineDay } from '../KanbanSurfaces.js'
import { civilDayToLocalDate, dueCivilDay, instantMs, isoDayLocal, railCivilDay } from '../civilDay.js'
import {
  activityChunks,
  daysBetween,
  planExtension,
  windowOf,
  type DayWindow,
} from './chronicleWindow.js'
import { cycleSpan } from '../KanbanRules.js'
import './ChronicleView.css'

// ── Window ───────────────────────────────────────────────────────────────────

/**
 * Two different spans, and the difference is the point.
 *
 * PAST_DAYS/FUTURE_DAYS are how much chronicle EXISTS — the columns built, the
 * activity window fetched. VISIBLE_PAST_DAYS/VISIBLE_FUTURE_DAYS are how much
 * of it is on screen at rest: "two weeks is plenty to show at a time". The day
 * column is sized at render so exactly that many columns fill the viewport,
 * and the rest of the record is a horizontal scroll away.
 */
const PAST_DAYS = 28
const FUTURE_DAYS = 14
const VISIBLE_PAST_DAYS = 14
const VISIBLE_FUTURE_DAYS = 7
const VISIBLE_DAYS = VISIBLE_PAST_DAYS + VISIBLE_FUTURE_DAYS + 1

/** Bounds on the fitted day width, so a very narrow or very wide board still
 *  gets columns a day numeral fits in and marks read at. */
const DAY_W_MIN_PX = 16
const DAY_W_MAX_PX = 56

/** Rows drawn before the "+N more" expander takes over. */
const MAX_ROWS = 40
/**
 * Where today sits across the day area on the first render. This is the same
 * statement as the visible split — 14 past of 22 visible days IS 65% — so the
 * anchor and the window agree by construction rather than by coincidence.
 */
const TODAY_ANCHOR = VISIBLE_PAST_DAYS / VISIBLE_DAYS
// The now-quantization that used to live here moved to
// `chronicleWindow.LIVE_QUANTUM_MS` when the fetch became chunked. Same reason
// as before — TemporalData keys its TTL cache on the argument tuple, so a raw
// `Date.now()` mints a fresh key every 15s poll — but it now applies ONLY to
// the chunk containing now. Every settled chunk keeps one stable key forever,
// which is what makes scrolling back through a year cost nothing twice.

/**
 * The page speaks in 6am RAILS, not midnights — the same day-boundary Day and
 * Week use, so the three views never disagree about which day it is.
 *
 * This matters for more than the seam. A rail is "work that runs past midnight
 * belongs to the day it started", so a 01:00 push is yesterday's — and if only
 * `isToday` moved to the rail while activity stayed on calendar days, then
 * every night between midnight and 6am the page would ink solid marks one
 * column PAST its own today line, on a page whose rule is that the future
 * carries no solid ink. Columns are still LABELLED by calendar date, because
 * that is what a rail is named by: the date it opened on.
 */
const RAIL_START_HOUR = 6

/** The current rail as a local Date at noon — the shape `buildTimelineDays`
 *  wants, and noon-anchored because midnight is the one wall-clock time a
 *  spring-forward day can lack. */
export function railDate(nowMs: number): Date {
  const d = civilDayToLocalDate(railCivilDay(nowMs, RAIL_START_HOUR))
  if (!d) return new Date(nowMs)
  d.setHours(12, 0, 0, 0)
  return d
}

/**
 * Daemon base for the two cycle writes. ViewContext is a READ contract — it
 * carries no base — so this resolves the same way `src/main.ts` does: empty for
 * the same-origin bundle the daemon serves (and for the offline harness, whose
 * build defines it empty), an absolute origin when `VITE_SHUTTLE_BASE` is set.
 * If writes ever become a third view's business, this belongs on ViewContext
 * rather than copied again.
 */
const SHUTTLE_BASE = (import.meta.env.VITE_SHUTTLE_BASE as string | undefined) ?? ''

// ── Pure join + aggregation (exported for chronicleJoin.test.ts) ─────────────

/**
 * A Crockford-base32 ULID embedded in a longer name. Shuttle's tmux sessions
 * are `<slug>-<26-char ULID>-shuttle`, so the ULID is the one token in a
 * session name that identifies a fiber exactly.
 */
const ULID_RE = /(?:^|[^0-9a-hjkmnp-tv-z])([0-7][0-9a-hjkmnp-tv-z]{25})(?![0-9a-hjkmnp-tv-z])/i

/** The fiber ULID a session name carries, upper-cased, or null. */
export function sessionUlid(name: string | null | undefined): string | null {
  if (typeof name !== 'string' || !name) return null
  const m = ULID_RE.exec(name)
  return m ? m[1].toUpperCase() : null
}

/**
 * The human-readable slug half of a session name: the tmux name with its
 * `-shuttle` suffix and its ULID stripped. `bmodes-2d-01K…-shuttle` → `bmodes-2d`.
 * This is the weaker join key — a slug is a fiber's leaf name, not its identity —
 * so it is only consulted after the ULID misses, and only when it resolves to
 * exactly one card.
 */
export function sessionSlug(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null
  let s = name.trim().toLowerCase()
  if (!s) return null
  s = s.replace(/-shuttle$/, '')
  s = s.replace(/-[0-7][0-9a-hjkmnp-tv-z]{25}$/, '')
  return s || null
}

/**
 * A working directory as a row label: a home prefix folds to `~`, and anything
 * else keeps its last three segments. There is no `$HOME` in a browser, so the
 * home shapes are matched structurally (`/home/<user>/…`, `/Users/<user>/…`).
 */
export function abbreviateCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  if (parts.length >= 2 && (parts[0] === 'home' || parts[0] === 'Users')) {
    const rest = parts.slice(2).join('/')
    return rest ? `~/${rest}` : '~'
  }
  if (parts.length <= 3) return `/${parts.join('/')}`
  return `…/${parts.slice(-3).join('/')}`
}

/** Every ULID a card can be recognized by. */
function cardUlids(card: KanbanCard): string[] {
  const out: string[] = []
  const push = (v: string | null): void => {
    if (v && !out.includes(v)) out.push(v)
  }
  if (typeof card.uid === 'string') push(card.uid.trim().toUpperCase())
  push(sessionUlid(card.id))
  push(sessionUlid(card.shuttleFiberId))
  push(sessionUlid(card.runningWorker))
  return out.filter((u) => /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(u))
}

/** Path segments a card can be recognized by when no ULID is available. */
function cardSlugs(card: KanbanCard): string[] {
  const raw = [...card.id.split('/'), ...(card.projectSlug ?? '').split('/')]
  const out: string[] = []
  for (const seg of raw) {
    const s = seg.trim().toLowerCase()
    if (s.length < 3 || out.includes(s)) continue
    out.push(s)
  }
  return out
}

export interface Attribution {
  /** Buckets that resolved to a fiber, keyed by card id. */
  byCard: Map<string, ActivityBucket[]>
  /** Buckets that did not, grouped by their raw working directory. */
  byCwd: Map<string, ActivityBucket[]>
  /** Buckets with neither a resolvable session nor a cwd — nowhere to draw. */
  dropped: number
}

/**
 * Place each activity bucket on a fiber, on a working directory, or nowhere.
 *
 * The ladder, strongest rung first:
 *
 *   0. the SESSION LEDGER pairs `s` with a fiber. A recorded fact about whose
 *      work the session was, so it beats every rung below it, all of which are
 *      inferences from a name.
 *   1. `s` is exactly a live worker's tmux name (`card.runningWorker`).
 *   2. `s` embeds a fiber ULID that a card claims. Exact identity.
 *   3. `s`'s slug half names exactly one card's path segment. A guess, but a
 *      good one — it is the name the dispatcher built the session from.
 *   4. otherwise the bucket belongs to its `cwd`, as human work.
 *
 * Rung 3 requires a UNIQUE match. A token matching several cards is a project
 * directory, not a fiber — `~/loom` names every fiber under the loom — so
 * ambiguity falls to the cwd row rather than picking an arbitrary winner.
 *
 * NO DIRECTORY RUNG. There used to be one: "`cwd`'s tail segment names exactly
 * one card". It was wrong in both directions, and each direction was caught on
 * real data:
 *
 *   - for a bucket WITH a session, a worker whose fiber is off this board
 *     (another store, a city-scoped board, a deleted fiber) had its minutes
 *     inked onto whichever card happened to own the directory's tail — a
 *     wedding-planning worker drawn on a website fiber's lifeline;
 *   - for a bucket WITHOUT one, an afternoon of a human's keystrokes in a
 *     project directory was filed under the single nested fiber whose path
 *     happened to contain that segment.
 *
 * The two failures share a cause, which is the principle this ladder now
 * follows: A DIRECTORY TAIL IS EVIDENCE ABOUT A PROJECT; A SESSION NAME IS
 * EVIDENCE ABOUT A WORKER. A project is not a fiber, so a directory can never
 * establish fiber identity — narrowing which buckets may use it only picks
 * which half of the error to keep. Work that names no fiber lands on a
 * synthetic cwd row, visible and labelled for what it is. Nothing is dropped;
 * it is simply not attributed to a fiber that did not earn it.
 */
export function attributeActivity(
  buckets: readonly ActivityBucket[],
  cards: readonly KanbanCard[],
  byTmux?: ReadonlyMap<string, SessionPairing>,
): Attribution {
  const byWorker = new Map<string, string>()
  const byUlid = new Map<string, string>()
  // `null` marks a token claimed by more than one card — ambiguous, unusable.
  const bySlug = new Map<string, string | null>()

  for (const card of cards) {
    if (card.runningWorker) byWorker.set(card.runningWorker, card.id)
    for (const ulid of cardUlids(card)) byUlid.set(ulid, card.id)
    for (const slug of cardSlugs(card)) {
      const seen = bySlug.get(slug)
      if (seen === undefined) bySlug.set(slug, card.id)
      else if (seen !== card.id) bySlug.set(slug, null)
    }
  }

  const cardIds = new Set(cards.map((c) => c.id))

  const byCard = new Map<string, ActivityBucket[]>()
  const byCwd = new Map<string, ActivityBucket[]>()
  let dropped = 0

  const push = (map: Map<string, ActivityBucket[]>, key: string, b: ActivityBucket): void => {
    const list = map.get(key)
    if (list) list.push(b)
    else map.set(key, [b])
  }

  for (const bucket of buckets) {
    const cardId = resolveCard(bucket, byWorker, byUlid, bySlug, byTmux, cardIds)
    if (cardId) {
      push(byCard, cardId, bucket)
      continue
    }
    if (bucket.cwd) push(byCwd, bucket.cwd, bucket)
    else dropped += 1
  }

  return { byCard, byCwd, dropped }
}

/**
 * Walk one bucket down the ladder. Written as explicit checks rather than a
 * chain of `map.get(x ?? SENTINEL)` — a lookup keyed on a stand-in for "absent"
 * only works while the stand-in is a string no real key could be, and that is a
 * property nobody can see at the call site.
 */
function resolveCard(
  bucket: ActivityBucket,
  byWorker: Map<string, string>,
  byUlid: Map<string, string>,
  bySlug: Map<string, string | null>,
  byTmux: ReadonlyMap<string, SessionPairing> | undefined,
  cardIds: ReadonlySet<string>,
): string | undefined {
  // 0. The session ledger. Both halves of the pairing are tried, because the
  // ULID is identity while the id is a path that can be moved underneath one.
  //
  // A pairing whose fiber is NOT on this board falls THROUGH rather than
  // resolving. Attributing to an absent card would drop the work from the page
  // entirely — it would leave the cwd rows without gaining a fiber row — and
  // silently losing minutes is the one thing worse than mis-filing them.
  if (bucket.s !== null && byTmux) {
    const pairing = byTmux.get(bucket.s)
    if (pairing) {
      if (cardIds.has(pairing.fiber)) return pairing.fiber
      const byUid = pairing.uid ? byUlid.get(pairing.uid.trim().toUpperCase()) : undefined
      if (byUid !== undefined) return byUid
    }
  }
  // 1. The exact tmux name of a worker the board knows is running.
  if (bucket.s !== null) {
    const worker = byWorker.get(bucket.s)
    if (worker !== undefined) return worker
  }
  // 2. A fiber ULID embedded in the session name. Exact identity.
  const ulid = sessionUlid(bucket.s)
  if (ulid !== null) {
    const byUlidId = byUlid.get(ulid)
    if (byUlidId !== undefined) return byUlidId
  }
  // 3. The session's slug half, when it names exactly one card.
  const slug = sessionSlug(bucket.s)
  if (slug !== null) {
    const bySlugId = bySlug.get(slug)
    if (bySlugId) return bySlugId
  }
  // And that is the end of the ladder. A working directory is NOT a fourth
  // rung: see the note above `attributeActivity` for why the directory-tail
  // rung was removed rather than narrowed.
  return undefined
}

/** One civil day's worth of one row's activity. */
export interface DayCell {
  /** Summed `n` over the day's agent buckets — the density signal. */
  agent: number
  attention: number
  notify: number
}

/**
 * Fold buckets into civil days by their LOCAL day. Never by `m / 86_400_000`:
 * a fixed-ms floor is a UTC day, which is the wrong day for half of every
 * evening west of Greenwich and half of every morning east of it, and which
 * mis-slices the 23- and 25-hour days at a DST transition.
 */
export function aggregateByCivilDay(buckets: readonly ActivityBucket[]): Map<string, DayCell> {
  const out = new Map<string, DayCell>()
  for (const b of buckets) {
    if (!Number.isFinite(b.m)) continue
    const day = railCivilDay(b.m, RAIL_START_HOUR)
    let cell = out.get(day)
    if (!cell) {
      cell = { agent: 0, attention: 0, notify: 0 }
      out.set(day, cell)
    }
    const n = Number.isFinite(b.n) ? Math.max(b.n, 1) : 1
    if (b.k === 'agent') cell.agent += n
    else if (b.k === 'attention') cell.attention += n
    else cell.notify += n
  }
  return out
}

/**
 * Density in three steps, relative to the busiest day anywhere in the window.
 * Relative rather than absolute because "busy" is a property of the week you
 * are looking at: fixed thresholds either saturate every segment during a
 * heavy sprint or flatten every segment during a quiet one.
 */
export function densityStep(agent: number, peak: number): 1 | 2 | 3 {
  if (agent <= 0) return 1
  if (peak <= 0) return 1
  const frac = agent / peak
  if (frac >= 0.55) return 3
  if (frac >= 0.20) return 2
  return 1
}

// ── Cycles ───────────────────────────────────────────────────────────────────
//
// A cycle is a fiber tagged `cycle` carrying a `start:` and a `due:`, both civil
// days. It is drawn as a named band across the days it spans — annotation over
// the record, not another row of data.

/**
 * What a band needs off a cycle card. Narrow on purpose: it lets an
 * optimistically drawn cycle — one that exists only in this session, between
 * the create and the poll that confirms it — be the same shape as a real one.
 */
export type CycleCard = Pick<KanbanCard, 'id' | 'name' | 'cycleStart' | 'due'>

/** A cycle placed on the day grid. */
export interface CycleBand {
  id: string
  name: string
  /** Inclusive day-column range, clamped to the window. */
  startIdx: number
  endIdx: number
  /** The real span reaches past this edge of the window — the band is drawn
   *  running off, rather than pretending the cycle begins or ends here. */
  openStart: boolean
  openEnd: boolean
  /** Sub-lane within the cycle strip; 0 is closest to the day headers. */
  lane: number
  /** Not yet confirmed by a poll — drawn immediately after a create. */
  pending?: boolean
}

/** Cycles stack this deep before overflow starts sharing a lane. */
export const MAX_CYCLE_LANES = 3

/**
 * Place one cycle card on the day grid, or null when it misses the window.
 *
 * The two civil days come from `cycleSpan` (KanbanRules) rather than being
 * re-derived here, so the awkward cases have one owner across the views: a
 * cycle with only an end is a SINGLE DAY, and one with only a start runs to
 * today and is open-ended. That second case is also the state a freshly drawn
 * cycle passes through between its two writes.
 *
 * CIVIL DAYS COMPARE AS STRINGS HERE, and that is safe in a way instants never
 * are: these are bare `YYYY-MM-DD` values, fixed-width and offset-free, so
 * lexicographic order IS calendar order. The prohibition in ../civilDay.ts is
 * about INSTANTS, whose offsets make a string compare order by wall clock. The
 * comparison is needed because `dayIndex.get` cannot tell "before the window"
 * from "after" — both are simply absent, and they clamp to opposite edges.
 */
export function readCycleBand(
  card: CycleCard,
  days: readonly TimelineDay[],
  dayIndex: Map<string, number>,
  nowMs: number = railDate(Date.now()).getTime(),
): Omit<CycleBand, 'lane'> | null {
  const first = days[0]?.iso
  const last = days[days.length - 1]?.iso
  if (first === undefined || last === undefined) return null

  const span = cycleSpan({ start: card.cycleStart ?? undefined, due: card.due }, nowMs)
  if (!span) return null
  if (span.end < first || span.start > last) return null // wholly outside the window

  const startsBefore = span.start < first
  const endsAfter = span.end > last
  const startIdx = startsBefore ? 0 : (dayIndex.get(span.start) ?? 0)
  const endIdx = Math.max(
    endsAfter ? days.length - 1 : (dayIndex.get(span.end) ?? days.length - 1),
    startIdx,
  )

  return {
    id: card.id,
    name: card.name,
    startIdx,
    endIdx,
    openStart: startsBefore,
    // Both readings draw the same open edge, and both are the same claim: this
    // band does not stop here. Either it runs past the window, or it has no
    // declared end and is still running.
    openEnd: endsAfter || span.openEnded,
  }
}

/**
 * Greedy interval partitioning: each cycle takes the first lane whose last band
 * has already ended. Sorted by start so the greedy choice is optimal in lane
 * count — the classic result — which matters because lanes are vertical space
 * on a page whose whole argument is density.
 *
 * Past {@link MAX_CYCLE_LANES} the strip would out-shout the lifelines it
 * annotates, so overflow joins the lane that frees up soonest and may visually
 * touch its neighbour. Overlapping is the lesser harm: a cycle silently omitted
 * from a page you draw cycles on is worse than two that crowd.
 */
export function assignCycleLanes<T extends { startIdx: number; endIdx: number }>(
  bands: readonly T[],
  maxLanes: number = MAX_CYCLE_LANES,
): Array<T & { lane: number }> {
  const ordered = [...bands].sort((a, b) => a.startIdx - b.startIdx || b.endIdx - a.endIdx)
  const laneEnds: number[] = []
  const out: Array<T & { lane: number }> = []
  for (const band of ordered) {
    let lane = laneEnds.findIndex((end) => end < band.startIdx)
    if (lane === -1) {
      if (laneEnds.length < maxLanes) {
        lane = laneEnds.length
        laneEnds.push(band.endIdx)
      } else {
        lane = laneEnds.indexOf(Math.min(...laneEnds))
        laneEnds[lane] = Math.max(laneEnds[lane], band.endIdx)
      }
    } else {
      laneEnds[lane] = band.endIdx
    }
    out.push({ ...band, lane })
  }
  return out
}

/** Every cycle on the grid, lane-assigned and in drawing order. */
export function buildCycleBands(
  cards: readonly CycleCard[],
  days: readonly TimelineDay[],
  dayIndex: Map<string, number>,
  nowMs: number = railDate(Date.now()).getTime(),
): CycleBand[] {
  const placed: Array<Omit<CycleBand, 'lane'>> = []
  for (const card of cards) {
    const band = readCycleBand(card, days, dayIndex, nowMs)
    if (band) placed.push(band)
  }
  return assignCycleLanes(placed)
}

// ── The look-back ────────────────────────────────────────────────────────────

/** Minutes of a given kind inside a span. A bucket is one minute of one kind,
 *  so distinct timestamps ARE the minute count — counting `n` would count
 *  events, and a busy minute is still one minute. */
export function spanMinutes(
  buckets: readonly ActivityBucket[],
  kind: ActivityBucket['k'],
  fromMs: number,
  toMs: number,
): number {
  const minutes = new Set<number>()
  for (const b of buckets) {
    if (b.k !== kind || b.m < fromMs || b.m > toMs) continue
    minutes.add(Math.floor(b.m / 60_000))
  }
  return minutes.size
}

/** `3h 20m`, `45m`, `—`. */
export function formatMinutes(total: number): string {
  if (total <= 0) return '—'
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export interface NarrationGroup {
  slug: string
  count: number
  subjects: string[]
}

/**
 * The span's commit trail, gathered under the thing each commit was about.
 *
 * Shuttle's commit subjects are conventionally `slug: what happened`, so the
 * leading token is already the grouping the writer intended. A subject without
 * one goes under `elsewhere` rather than becoming its own group of one — the
 * point of the look-back is shape, and a list of singletons has none.
 */
export function groupNarration(
  commits: readonly { iso: string; subject: string }[],
  limit = 4,
): NarrationGroup[] {
  const bySlug = new Map<string, NarrationGroup>()
  for (const commit of commits) {
    const match = /^([a-z0-9][a-z0-9._/-]{1,40}):\s*(.+)$/i.exec(commit.subject.trim())
    const slug = match ? match[1].toLowerCase() : 'elsewhere'
    const rest = match ? match[2] : commit.subject.trim()
    let group = bySlug.get(slug)
    if (!group) {
      group = { slug, count: 0, subjects: [] }
      bySlug.set(slug, group)
    }
    group.count += 1
    // DISTINCT subjects. A run of identical messages is one thing said many
    // times — the count already carries "many", and repeating the sentence
    // three times turns a memoir into a stutter.
    if (group.subjects.length < 2 && !group.subjects.includes(rest)) group.subjects.push(rest)
  }
  return [...bySlug.values()].sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug)).slice(0, limit)
}

/** The first paragraph of a fiber body — the cycle's intention, as written. */
export function firstParagraph(body: string | undefined): string {
  if (!body) return ''
  for (const block of body.replace(/\r/g, '').split(/\n\s*\n/)) {
    const text = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('---'))
      .join(' ')
      .trim()
    if (text) return text
  }
  return ''
}

// ── Row model ────────────────────────────────────────────────────────────────

interface ChronicleRow {
  key: string
  kind: 'fiber' | 'cwd'
  label: string
  /** Tiny mono note under the name's right edge: owning host, or `interactive`. */
  note: string
  cardId?: string
  days: Map<string, DayCell>
  /** Inclusive day-column range the solid lifeline covers. Never past today. */
  startIdx: number
  endIdx: number
  /**
   * Where the close actually HAPPENED, which is not the same question as where
   * the lifeline ends. Null when the fiber is open, when the close carries no
   * date, or when it landed outside the window — and a null suppresses the
   * mark rather than defaulting it, the way `dueIdx`/`launchIdx` already do.
   * Stamping ✓ on today because we could not place the real close is the view
   * asserting something it does not know.
   */
  closeIdx: number | null
  live: boolean
  closed: boolean
  /** Composted (`tempered === false`) closes get ✗; everything else ✓. */
  closedOk: boolean
  dueIdx: number | null
  launchIdx: number | null
  sortMs: number
}

/** The owning host, as a bare name. Origin first (it is what the board keys
 *  freshness by), then the daemon's own host, then the fiber's dispatch host —
 *  each rung only consulted when the one above says the uninformative `local`. */
function hostLabel(card: KanbanCard, response: KanbanResponse): string {
  const origin = response.staleness?.[card.originId]?.hostname ?? card.originId.replace(/^remote-/, '')
  if (origin && origin !== 'local') return origin.toLowerCase()
  if (response.feltHost && response.feltHost !== 'local') return response.feltHost.toLowerCase()
  return (card.shuttleHost ?? 'local').toLowerCase()
}

/** The civil day `delta` calendar days on. Noon anchor: midnight is the one
 *  wall-clock time a spring-forward day can lack. */
function addCivilDays(day: string, delta: number): string {
  const d = civilDayToLocalDate(day)
  if (!d) return day
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() + delta)
  return isoDayLocal(d.getTime())
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Day-column index for an INSTANT, by its local day. Null when out of window. */
function idxOfInstant(iso: string | undefined, dayIndex: Map<string, number>): number | null {
  const ms = instantMs(iso)
  if (ms === undefined) return null
  return dayIndex.get(isoDayLocal(ms)) ?? null
}

/** Day-column index for a `due:`, by the civil day it names. */
function idxOfDue(due: string | undefined, dayIndex: Map<string, number>): number | null {
  const day = dueCivilDay(due)
  return day === undefined ? null : (dayIndex.get(day) ?? null)
}

/** Local-noon ms of a civil day — a sort key that cannot drift across a DST
 *  boundary the way local midnight can. */
function dayNoonMs(day: string): number {
  const d = civilDayToLocalDate(day)
  if (!d) return 0
  d.setHours(12, 0, 0, 0)
  return d.getTime()
}

/** What one fiber's line covers, and where its close belongs. */
export interface LifelineExtent {
  startIdx: number
  endIdx: number
  closeIdx: number | null
  closed: boolean
}

/**
 * Resolve a fiber's lifeline against the day columns.
 *
 * The distinction this function exists to hold: WHERE THE CLOSE HAPPENED
 * (`closeIdx`, which may be unknowable) is not WHERE THE LINE ENDS (`endIdx`,
 * which always has an answer). Collapsing the two is what put a ✓ under today
 * on every fiber closed before the window — the page asserting a close date it
 * did not have.
 *
 * Three closed cases, and only the first may draw a mark:
 *   - a close we can place        → line ends there, mark there.
 *   - a DATED close we cannot place → it is necessarily before the window
 *     (nothing closes in the future), so the line stops at the fiber's start
 *     rather than running to today and claiming a month of work. No mark.
 *   - an UNDATED close            → fall back to today, because we genuinely
 *     know nothing better; a closed fiber can carry a null `closed_at`. No mark.
 *
 * Activity then stretches both ends: a fiber born before the window opened
 * still shows the work it did inside it.
 */
export function lifelineExtent(
  card: Pick<KanbanCard, 'createdAt' | 'closedAt' | 'status'>,
  activityDays: Iterable<string>,
  dayIndex: Map<string, number>,
  todayIdx: number,
): LifelineExtent {
  let startIdx = idxOfInstant(card.createdAt, dayIndex) ?? 0
  const closed = Boolean(card.closedAt) || card.status === 'closed'
  const closeIdx = idxOfInstant(card.closedAt, dayIndex)
  const closedMs = instantMs(card.closedAt)
  let endIdx = closed ? (closeIdx ?? (closedMs !== undefined ? startIdx : todayIdx)) : todayIdx
  for (const day of activityDays) {
    const idx = dayIndex.get(day)
    if (idx === undefined) continue
    if (idx < startIdx) startIdx = idx
    if (idx > endIdx) endIdx = idx
  }
  startIdx = clamp(startIdx, 0, todayIdx)
  endIdx = clamp(Math.max(endIdx, startIdx), 0, todayIdx)
  return { startIdx, endIdx, closeIdx, closed }
}

function buildFiberRow(
  card: KanbanCard,
  buckets: readonly ActivityBucket[],
  response: KanbanResponse,
  dayIndex: Map<string, number>,
  todayIdx: number,
): ChronicleRow {
  const days = aggregateByCivilDay(buckets)
  const { startIdx, endIdx, closeIdx, closed } = lifelineExtent(
    card,
    days.keys(),
    dayIndex,
    todayIdx,
  )

  // Deliberately NOT `lastActivityAt`. It is a live worker's last hook event at
  // millisecond precision, so it moves on every poll — putting it in the sort
  // would mean putting it in the refresh signature, and rebuilding the page
  // every 15s to reorder rows that cannot visibly move: a live fiber already
  // floats to the top on its own flag, and at day granularity `modifiedAt` plus
  // the activity days say everything it would.
  let sortMs = Math.max(
    instantMs(card.modifiedAt) ?? 0,
    instantMs(card.closedAt) ?? 0,
    instantMs(card.createdAt) ?? 0,
  )
  for (const day of days.keys()) sortMs = Math.max(sortMs, dayNoonMs(day))

  return {
    key: `fiber:${card.id}`,
    kind: 'fiber',
    label: card.name,
    note: hostLabel(card, response),
    cardId: card.id,
    days,
    startIdx,
    endIdx,
    closeIdx,
    live: Boolean(card.runningWorker),
    closed,
    closedOk: card.tempered !== false,
    dueIdx: idxOfDue(card.due, dayIndex),
    launchIdx: idxOfInstant(card.nextLaunchAt, dayIndex),
    sortMs,
  }
}

function buildCwdRow(
  cwd: string,
  buckets: readonly ActivityBucket[],
  dayIndex: Map<string, number>,
  todayIdx: number,
): ChronicleRow {
  const days = aggregateByCivilDay(buckets)
  let startIdx = todayIdx
  let endIdx = 0
  let sortMs = 0
  for (const day of days.keys()) {
    const idx = dayIndex.get(day)
    if (idx === undefined) continue
    if (idx < startIdx) startIdx = idx
    if (idx > endIdx) endIdx = idx
    sortMs = Math.max(sortMs, dayNoonMs(day))
  }
  startIdx = clamp(startIdx, 0, todayIdx)
  endIdx = clamp(Math.max(endIdx, startIdx), 0, todayIdx)
  // `interactive` only when nothing here carried a session at all; otherwise a
  // session ran that the ladder could not tie to a fiber, and saying
  // "interactive" would be a small lie.
  const note = buckets.every((b) => b.s === null) ? 'interactive' : 'unmatched'
  return {
    key: `cwd:${cwd}`,
    kind: 'cwd',
    label: abbreviateCwd(cwd),
    note,
    days,
    startIdx,
    endIdx,
    closeIdx: null,
    live: false,
    closed: false,
    closedOk: true,
    dueIdx: null,
    launchIdx: null,
    sortMs,
  }
}

/**
 * Every row the chronicle draws, in reading order: live fibers, then fibers by
 * most-recent activity, then the working-directory rows.
 *
 * The fiber set is "anything with activity in the window" ∪ "anything still
 * open" — the three Now lanes, the pinned strip, and the two future timeline
 * pools. So an idle-but-open fiber still shows its lifeline, a scheduled one
 * still shows its ◴/◐ in the future region, and a closed one still shows the
 * week it took. Only `timeline.past` is left to the activity join: a finished,
 * tempered fiber earns its row by having actually been worked on in the window.
 */
/**
 * A fiber that finished before this window opened and did nothing inside it.
 *
 * The Now lanes carry closed-but-unreviewed fibers with no age bound, so a
 * fiber closed in January still arrives here in August. With the close mark now
 * suppressed rather than defaulted, such a row would draw a one-day stub at the
 * left edge and nothing else — a line that says only "this exists", on a page
 * about when work happened. It keeps its place on the Desk; it just has no
 * entry in this stretch of the record.
 *
 * Deliberately narrow: an UNDATED close is not silent history (we cannot say
 * when it happened, so it still reads as current), and anything with in-window
 * activity or a future promise has a mark to make.
 */
export function saysNothingHere(
  card: KanbanCard,
  buckets: readonly ActivityBucket[],
  dayIndex: Map<string, number>,
): boolean {
  const closed = Boolean(card.closedAt) || card.status === 'closed'
  if (!closed) return false
  if (instantMs(card.closedAt) === undefined) return false
  if (idxOfInstant(card.closedAt, dayIndex) !== null) return false
  if (idxOfDue(card.due, dayIndex) !== null) return false
  if (idxOfInstant(card.nextLaunchAt, dayIndex) !== null) return false
  // Work inside the window is a mark, whatever the close date says.
  for (const day of aggregateByCivilDay(buckets).keys()) {
    if (dayIndex.has(day)) return false
  }
  return true
}

function buildRows(
  response: KanbanResponse,
  cards: readonly KanbanCard[],
  attribution: Attribution,
  dayIndex: Map<string, number>,
  todayIdx: number,
): ChronicleRow[] {
  const byId = new Map(cards.map((c) => [c.id, c]))
  const include = new Set<string>(attribution.byCard.keys())
  for (const card of [
    ...response.now.drafts,
    ...response.now.inFlight,
    ...response.now.awaitingReview,
    ...response.pinned,
    ...response.timeline.futureDated,
    ...response.timeline.anytimeSoon,
  ]) {
    include.add(card.id)
  }

  const fibers: ChronicleRow[] = []
  for (const id of include) {
    const card = byId.get(id)
    if (!card) continue
    const buckets = attribution.byCard.get(id) ?? []
    if (saysNothingHere(card, buckets, dayIndex)) continue
    fibers.push(buildFiberRow(card, buckets, response, dayIndex, todayIdx))
  }
  fibers.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1
    if (b.sortMs !== a.sortMs) return b.sortMs - a.sortMs
    return a.label.localeCompare(b.label)
  })

  const cwds: ChronicleRow[] = []
  for (const [cwd, buckets] of attribution.byCwd) {
    cwds.push(buildCwdRow(cwd, buckets, dayIndex, todayIdx))
  }
  cwds.sort((a, b) => b.sortMs - a.sortMs || a.label.localeCompare(b.label))

  return [...fibers, ...cwds]
}

/** The busiest single day across every row — the scale density steps map onto. */
function peakDayAgent(rows: readonly ChronicleRow[]): number {
  let peak = 0
  for (const row of rows) for (const cell of row.days.values()) peak = Math.max(peak, cell.agent)
  return peak
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

/** A civil day as `14 Jul`. Materialized as a LOCAL date — never `new Date` on
 *  a civil day, which reads it as UTC midnight and labels it a day early west
 *  of Greenwich. */
function prettyDay(day: string): string {
  const d = civilDayToLocalDate(day)
  return d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : day
}

/** `left` for a mark sitting in day column `idx`. */
function colLeft(idx: number): string {
  return `calc(var(--chr-day-w) * ${idx})`
}

// ── The view ─────────────────────────────────────────────────────────────────

class ChronicleView implements TemporalView {
  readonly id = 'chronicle' as const
  readonly title = 'Chronicle'
  readonly hotkey = '2'

  private root: HTMLElement | null = null
  private body: HTMLElement | null = null
  private scroller: HTMLElement | null = null
  private ctx: ViewContext | null = null

  /** Bumped on every load; a resolution from an older generation is discarded
   *  so a slow fetch can never overwrite a newer render. */
  private generation = 0
  private signature = ''
  private expanded = false
  private didAnchor = false
  /** The cursor value the scroll is currently anchored on, so a move re-anchors
   *  while an unrelated refresh leaves the reader where they were. */
  private anchoredOn: string | null = null
  /** Watches the page, not the scroller: the scroller's own width is set by the
   *  page, while its CONTENT width is what we change — observing the content
   *  side could feed back on itself. */
  private resizeObserver: ResizeObserver | null = null
  private dayWidthPx = 0

  /** The cycle being drawn right now: a live drag, or a span awaiting its name.
   *  Non-null suspends rebuilds so the gesture survives a poll. */
  /**
   * Anchors are CIVIL DAYS, never column indices. The window can grow at either
   * edge while a gesture is in flight — the gesture's own auto-scroll is what
   * reaches the edge that triggers it — and a prepend shifts every index by the
   * size of the block that arrived. A day survives that; an index does not.
   */
  private draft: { fromDay: string; toDay: string; naming: boolean } | null = null
  /** Cycles created this session and not yet echoed by a poll. Held so the band
   *  appears under the cursor at once rather than up to 15s later. */
  private pendingCycles: Array<{ name: string; startDay: string; endDay: string }> = []
  /** Edge drags written but not yet echoed by a poll, keyed by cycle id. Held
   *  so a dragged edge stays where it was dropped instead of snapping back for
   *  the seconds until the daemon's answer comes round. */
  private cycleEdits = new Map<string, { start?: string; due?: string }>()
  private teardownDraw: (() => void) | null = null
  /** The day columns of the current render, so a gesture handler can convert a
   *  cursor position into a civil day without threading them through. */
  private currentDays: TimelineDay[] = []
  /**
   * The day range the chronicle currently EXISTS over. Grows at both edges as
   * the viewer scrolls (see `maybeExtend`); null until the first load, which
   * seeds it from PAST_DAYS/FUTURE_DAYS around the rail's today.
   */
  private window: DayWindow | null = null
  /**
   * Pixels the next render must ADD to the restored `scrollLeft`.
   *
   * A prepend inserts columns to the left of everything on screen, displacing
   * it right by exactly that much. `render()` restores `scrollLeft` as a raw
   * pixel value, so the compensation has to be applied AT the restore or there
   * is a frame where the view sits a whole block to the left of where the hand
   * left it. Consumed once, then cleared.
   */
  private pendingScrollDelta = 0
  /** Activity chunks already requested, by key — see chronicleWindow. */
  private fetchedChunks = new Map<string, readonly ActivityBucket[]>()
  private onScroll: (() => void) | null = null
  private autoScrollTimer: number | null = null

  /** The era being read. Non-null puts the face above the grid and dims every
   *  row that had no part in the span. */
  private scopedCycleId: string | null = null
  /** Intention lines, fetched once per cycle and kept for the mount. */
  private intentions = new Map<string, string>()
  /** The scoped span's commit trail, keyed by `id:from:to` so a re-render does
   *  not re-ask and a different span does. */
  private lookback: { key: string; groups: NarrationGroup[] } | null = null
  private onEsc: ((e: KeyboardEvent) => void) | null = null
  private autoScrollStep = 0
  /** Join rung 0, rebuilt each load from the session ledger. */
  private byTmux: ReadonlyMap<string, SessionPairing> = new Map()

  mount(host: HTMLElement, ctx: ViewContext): void {
    const page = createViewPage(this.title)
    this.root = page.root
    this.body = page.body
    this.ctx = ctx
    this.signature = ''
    this.didAnchor = false
    this.dayWidthPx = 0
    // The registry holds ONE instance of this view for the life of the page, so
    // every field here outlives the mount that set it. "Show me the other 40
    // rows" is a decision about one visit, not a preference — leaving it set
    // meant a board opened tomorrow still had yesterday's list unrolled, with
    // no expander visible to explain why.
    this.expanded = false
    this.anchoredOn = null
    host.append(page.root)

    // Refit the columns when the board changes width. Only the CSS variable
    // moves; every mark's position is a calc() over it, so the whole chronicle
    // rescales without a rebuild.
    this.onEsc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || this.scopedCycleId === null || !this.ctx) return
      e.stopPropagation() // the board closes itself on Escape; leaving an era comes first
      this.scopeTo(null, this.ctx)
    }
    document.addEventListener('keydown', this.onEsc, true)

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.fitDayWidth())
      this.resizeObserver.observe(page.body)
    }
    void this.load(ctx)
  }

  refresh(ctx: ViewContext): void {
    this.ctx = ctx
    void this.load(ctx)
  }

  unmount(): void {
    this.generation += 1
    this.teardownDraw?.()
    this.teardownDraw = null
    if (this.onEsc) document.removeEventListener('keydown', this.onEsc, true)
    this.onEsc = null
    this.scopedCycleId = null
    this.intentions.clear()
    this.lookback = null
    this.stopAutoScroll()
    this.draft = null
    this.pendingCycles = []
    this.cycleEdits.clear()
    this.currentDays = []
    this.window = null
    this.pendingScrollDelta = 0
    this.fetchedChunks = new Map()
    this.onScroll = null
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.root?.remove()
    this.root = null
    this.body = null
    this.scroller = null
    this.ctx = null
    this.signature = ''
    this.didAnchor = false
    this.dayWidthPx = 0
  }

  /** One window fetch, then a signature check, then at most one DOM rebuild. */
  private async load(ctx: ViewContext): Promise<void> {
    const generation = (this.generation += 1)
    // Two different "now"s, and conflating them costs half a day of activity.
    // The COLUMNS are laid out around the current rail (noon-anchored, possibly
    // yesterday's date before 6am); the FETCH still has to reach the real
    // present, or everything since noon goes unrequested.
    const nowMs = Date.now()
    const today = railCivilDay(nowMs, RAIL_START_HOUR)
    // The window is the chronicle's own state once scrolling has grown it; the
    // constants only seed it.
    const window = this.window ?? windowOf(addCivilDays(today, -PAST_DAYS), addCivilDays(today, FUTURE_DAYS))
    this.window = window
    const days = buildTimelineDays(
      daysBetween(window.first, today),
      daysBetween(today, window.last),
      railDate(nowMs),
    )

    // Activity comes in CHUNKS on a fixed grid rather than one moving window:
    // a settled chunk keeps one cache key forever, so scrolling back through a
    // year re-requests nothing it already holds. Only the chunk containing now
    // carries the 5-minute quantization. See chronicleWindow.
    const wanted = activityChunks(window, nowMs)
    const [chunkResults, sessions] = await Promise.all([
      Promise.all(
        wanted.map(async (chunk) => {
          const held = this.fetchedChunks.get(chunk.key)
          if (held) return [chunk.key, held] as const
          const res = await ctx.activity(chunk.fromMs, chunk.toMs)
          return [chunk.key, res.buckets] as const
        }),
      ),
      // `sessions(0)` asks for the whole ledger with a constant argument, so
      // the TTL memo holds one entry for it forever rather than minting a fresh
      // key per poll the way a moving `since` would.
      ctx.sessions(0),
    ])
    if (generation !== this.generation || !this.body) return
    // Keep only what the current window wants, so a year of scrolling does not
    // accumulate every chunk ever visited.
    const keep = new Map<string, readonly ActivityBucket[]>()
    for (const [key, buckets] of chunkResults) keep.set(key, buckets)
    this.fetchedChunks = keep
    const activity = { buckets: chunkResults.flatMap(([, buckets]) => buckets) }
    this.byTmux = buildSessionIndex(sessions.records).byTmux
    // A rebuild would tear out the half-drawn band or the naming input under
    // the reader's cursor. The poll's data is not worth that; the next one
    // lands 15s later and the gesture is over in seconds.
    if (this.draft !== null) return

    const signature = this.signatureOf(days, activity.buckets, ctx)
    if (signature === this.signature) return
    this.signature = signature
    this.render(ctx, days, activity.buckets)
  }

  /**
   * A cheap fingerprint of everything the render reads.
   *
   * THE RULE: every field that can move a mark on this page appears here. A
   * field the render reads but the signature omits is a stale render nobody
   * will attribute to caching — a fiber renamed on disk kept its old label
   * until some other field happened to change, which is exactly how that bug
   * presents. So the list below is deliberately over-inclusive and is meant to
   * be extended whenever the render learns to read something new.
   *
   * Buckets contribute their count and newest stamp, which is enough — the
   * daemon only ever appends to a window.
   */
  private signatureOf(
    days: TimelineDay[],
    buckets: readonly ActivityBucket[],
    ctx: ViewContext,
  ): string {
    let latest = 0
    for (const b of buckets) if (b.m > latest) latest = b.m
    const { response, cards } = ctx
    const parts = [
      days[0].iso,
      String(buckets.length),
      String(latest),
      this.expanded ? 'x' : 'c',
      // The cursor is in here so a move made in another view re-anchors this
      // page's scroll on arrival, rather than being skipped as "no change".
      ctx.focusDate ?? '',
      `scope:${this.scopedCycleId ?? ''}`,
      `ledger:${this.byTmux.size}`,
      `look:${this.lookback?.key ?? ''}:${this.lookback?.groups.length ?? 0}`,
      `intent:${this.scopedCycleId ? (this.intentions.get(this.scopedCycleId) ?? '') : ''}`,
      // hostLabel's last two rungs.
      response.feltHost,
    ]
    // hostLabel's first rung: a hostname that lands late must repaint the notes.
    for (const originId of Object.keys(response.staleness ?? {})) {
      parts.push(`o:${originId}=${response.staleness[originId]?.hostname ?? ''}`)
    }
    // Which surface a card sits on decides whether it gets a row at all, and
    // the server owns that routing — read the lists rather than trying to
    // re-derive them from card fields and drifting when the rules change.
    for (const list of [
      response.now.drafts,
      response.now.inFlight,
      response.now.awaitingReview,
      response.pinned,
      response.timeline.futureDated,
      response.timeline.anytimeSoon,
    ]) {
      parts.push(list.map((c) => c.id).join(','))
    }
    // The cycle strip. Its own surface, so it is invisible to the per-card loop
    // below — and a band moves with its span, not just with its existence.
    for (const c of ctx.response.cycles ?? []) {
      parts.push(`y:${c.id}|${c.name}|${c.cycleStart ?? ''}|${c.due ?? ''}`)
    }
    for (const c of cards) {
      parts.push(
        [
          c.id, // row key, openCard target
          c.name, // label
          c.status, // closed
          c.createdAt, // lifeline start, sort
          c.closedAt ?? '', // close mark, lifeline end, sort
          c.modifiedAt ?? '', // sort
          c.due ?? '', // ◴
          c.nextLaunchAt ?? '', // ◐
          c.runningWorker ?? '', // live flag, join rung 1
          c.tempered === undefined ? '' : String(c.tempered), // ✓ vs ✗
          c.originId, // host note
          c.shuttleHost ?? '', // host note
          c.uid ?? '', // join rung 2
          c.shuttleFiberId ?? '', // join rung 2
          c.projectSlug ?? '', // join rungs 3-4
        ].join('|'),
      )
    }
    return fnv1a(parts.join('\n'))
  }

  private render(ctx: ViewContext, days: TimelineDay[], buckets: readonly ActivityBucket[]): void {
    const body = this.body
    if (!body) return

    const scrollLeft = this.scroller?.scrollLeft ?? 0
    const scrollTop = this.scroller?.scrollTop ?? 0
    body.replaceChildren()
    this.scroller = null
    // The fitted width lives as an inline variable ON the scroller, and this
    // rebuild makes a new one. Forget the cached value too, or fitDayWidth sees
    // "no change" and leaves the fresh element on the CSS fallback width.
    this.dayWidthPx = 0

    this.currentDays = days
    const dayIndex = new Map(days.map((d, i) => [d.iso, i]))
    const todayIdx = days.findIndex((d) => d.isToday)
    const lastIdx = days.length - 1
    const attribution = attributeActivity(buckets, ctx.cards, this.byTmux)
    const rows = buildRows(
      ctx.response,
      ctx.cards,
      attribution,
      dayIndex,
      todayIdx < 0 ? lastIdx : todayIdx,
    )

    if (rows.length === 0) {
      body.append(createViewEmptyState('— no hand has passed this way —'))
      return
    }

    const hidden = this.expanded ? 0 : Math.max(0, rows.length - MAX_ROWS)
    const shown = hidden > 0 ? rows.slice(0, MAX_ROWS) : rows
    const peak = peakDayAgent(rows)

    const bands = this.collectBands(ctx, days, dayIndex)
    // Always at least one lane: empty, the strip is the target you draw on.
    const laneCount = Math.max(1, ...bands.map((b) => b.lane + 1))
    const bodyRows = shown.length + (hidden > 0 ? 1 : 0)

    const scroller = document.createElement('div')
    scroller.className = 'chr-scroll'

    const grid = document.createElement('div')
    grid.className = 'chr-grid'
    grid.style.gridTemplateColumns = `var(--chr-label-w) repeat(${days.length}, var(--chr-day-w))`
    grid.style.gridTemplateRows =
      `var(--chr-head-h) repeat(${laneCount}, var(--chr-cycle-h)) repeat(${bodyRows}, var(--chr-row-h))`

    const fiberCount = rows.reduce((n, row) => (row.kind === 'fiber' ? n + 1 : n), 0)
    grid.append(this.buildCorner(fiberCount), ...this.buildHead(days, ctx))
    grid.append(...this.buildWashes(days, laneCount + bodyRows))
    grid.append(...this.buildCycleStrip(bands, laneCount, days, ctx))
    // Fiber rows start below the cycle strip.
    const rowOffset = laneCount
    const era = this.scopedCycleId === null ? null : bands.find((b) => b.id === this.scopedCycleId)
    for (let r = 0; r < shown.length; r += 1) {
      const parts = this.buildRow(shown[r], rowOffset + r, days, dayIndex, peak, ctx)
      // Dimmed, never hidden: a row with no part in the era is still part of
      // the record, and removing it would make the era look emptier than it was.
      if (era && !this.rowInSpan(shown[r], era, days)) {
        for (const el of parts) el.classList.add('chr-outside')
      }
      grid.append(...parts)
    }
    if (hidden > 0) grid.append(this.buildExpander(hidden, rowOffset + shown.length))
    // Appended LAST so it paints over the bands and the lifelines: today is one
    // unbroken line down the page, not a line that stops at whatever happens to
    // overlap it. Same stacking level as the tracks, so DOM order decides — and
    // it stays under the sticky gutter (z 3), which must keep covering the days
    // that scroll behind it.
    if (todayIdx >= 0) grid.append(this.buildTodaySeam(todayIdx))

    scroller.append(grid)
    const scoped = this.scopedCycleId === null ? null : bands.find((b) => b.id === this.scopedCycleId)
    if (scoped) {
      body.append(this.buildFace(scoped, days, shown, buckets, ctx))
      void this.loadIntention(scoped.id)
    } else if (this.scopedCycleId !== null) {
      // The era left the window (its dates moved, or it was deleted). Silently
      // stop scoping rather than showing a face for a band that is not there.
      this.scopedCycleId = null
    }
    body.append(scroller)
    this.scroller = scroller
    // The scroller is a new element every rebuild, so the listener goes on with
    // it. Passive: extension never prevents the scroll it is reacting to.
    this.onScroll = () => this.maybeExtend()
    scroller.addEventListener('scroll', this.onScroll, { passive: true })
    this.fitDayWidth()

    // The cursor decides where the page opens. Null means today — re-resolved
    // against the clock every render, never frozen at the day we first saw. A
    // cursor pointing outside the window falls back to today rather than
    // scrolling to an edge that means nothing.
    const focus = normalizeFocusDate(ctx.focusDate)
    const focusIdx = focus === null ? null : (dayIndex.get(focus) ?? null)
    // Entering an era takes the grid to it — otherwise the face describes a
    // span that is scrolled off the page it sits above.
    const anchorIdx = era ? era.startIdx : (focusIdx ?? (todayIdx < 0 ? lastIdx : todayIdx))
    const focusMoved = focus !== this.anchoredOn

    if (this.didAnchor && !focusMoved) {
      // `scrollLeft` was captured in pixels before the rebuild; a prepend has
      // since displaced every one of those pixels rightward. Adding the delta
      // HERE — rather than after the assignment — is what makes the extension
      // invisible instead of a lurch.
      scroller.scrollLeft = scrollLeft + this.pendingScrollDelta
      scroller.scrollTop = scrollTop
    } else {
      scroller.scrollTop = scrollTop
      // An era anchors near the left edge so the whole span reads forward
      // into the viewport; today anchors where the window's own split puts it.
      this.anchorDay(scroller, anchorIdx, era ? 0.1 : TODAY_ANCHOR)
    }
    this.anchoredOn = focus
    this.pendingScrollDelta = 0
  }

  /**
   * Grow the window when a scroll reaches an edge — the whole of "continuous".
   *
   * The arithmetic is `chronicleWindow`'s and is unit-tested there; this method
   * is only the plumbing. Three things it must not do, each of which would be
   * felt immediately:
   *
   *   • It DOES stand down mid-gesture, and not for the reason you would
   *     guess. The gesture sites hold civil days now, so a widened grid can no
   *     longer corrupt their arithmetic — that hazard is gone. What remains is
   *     DOM: `installDrawToCreate` and `installEdgeDrag` close over the `track`
   *     element and their ghost, and a rebuild detaches both. `dayAt(track, x)`
   *     then measures a detached rect, the ghost paints where nobody can see
   *     it, and the naming input opens on an orphan. So an extension mid-draw
   *     would leave the gesture arithmetically correct and visually dead. Until
   *     a gesture can re-acquire its track — or extension can widen the grid
   *     without a full rebuild — auto-scroll pans within the window it has and
   *     the window grows once the hand lets go.
   *   • It must not re-anchor. `didAnchor` stays set, or the view would snap
   *     back to today at the moment the reader is reaching away from it.
   *   • It must not double-compensate. `fitDayWidth` also adjusts `scrollLeft`,
   *     but only when the WIDTH changes, and extension changes the extent
   *     rather than the width (the fit divides by a constant VISIBLE_DAYS).
   */
  private maybeExtend(): void {
    const scroller = this.scroller
    const ctx = this.ctx
    if (!scroller || !ctx || !this.window) return
    // A half-drawn band or an open naming input would be torn out by the
    // rebuild, exactly as the poll declines to do.
    if (this.draft !== null) return

    const plan = planExtension(
      this.window,
      {
        scrollLeft: scroller.scrollLeft,
        clientWidth: scroller.clientWidth,
        scrollWidth: scroller.scrollWidth,
        dayWidthPx: this.dayWidthPx,
      },
      Date.now(),
    )
    if (!plan) return

    this.window = plan.next
    this.pendingScrollDelta = plan.scrollDelta
    // The window changed, so the signature must too — otherwise `load` sees
    // identical fiber data and declines the rebuild that grows the grid.
    this.signature = ''
    void this.load(ctx)
  }

  /**
   * Size the day column so exactly {@link VISIBLE_DAYS} of them fill the space
   * beside the label gutter — two weeks back and one forward, at rest. The
   * deeper window stays where it is, one scroll to the left.
   *
   * Scroll position is carried across in DAYS rather than pixels: after a
   * resize the reader should still be looking at the same week, not at the same
   * pixel offset into a differently-scaled record.
   */
  private fitDayWidth(): void {
    const scroller = this.scroller
    if (!scroller) return
    const available = scroller.clientWidth - this.labelWidth(scroller)
    if (available <= 0) return
    const next = clamp(available / VISIBLE_DAYS, DAY_W_MIN_PX, DAY_W_MAX_PX)
    const previous = this.dayWidthPx
    if (Math.abs(next - previous) < 0.5) return
    // Read the scroll offset BEFORE the variable moves. Narrowing the columns
    // shrinks the content, and the browser clamps scrollLeft to the new maximum
    // the moment that happens — so a read afterwards reports a position the
    // reader never chose, and the carried-over week comes out wrong.
    const previousScroll = scroller.scrollLeft
    scroller.style.setProperty('--chr-day-w', `${next.toFixed(2)}px`)
    this.dayWidthPx = next
    if (previous > 0 && previousScroll > 0) {
      scroller.scrollLeft = (previousScroll / previous) * next
    }
  }

  private labelWidth(scroller: HTMLElement): number {
    return parseFloat(getComputedStyle(scroller).getPropertyValue('--chr-label-w')) || 300
  }

  /** Real cycles plus any created this session that no poll has echoed yet. A
   *  pending one drops out the moment a real card carries its name. */
  private collectBands(
    ctx: ViewContext,
    days: TimelineDay[],
    dayIndex: Map<string, number>,
  ): CycleBand[] {
    // Cycles have their own surface — they are deliberately absent from
    // `ctx.cards`, so a cycle can never be mistaken for a piece of work.
    const served: CycleCard[] = ctx.response.cycles ?? []
    const known = new Set(served.map((c) => c.name))
    this.pendingCycles = this.pendingCycles.filter((p) => !known.has(p.name))

    // Lay any un-echoed edge drag over the served card, and retire the override
    // the moment the daemon's copy agrees with it.
    const real: CycleCard[] = served.map((c) => {
      const edit = this.cycleEdits.get(c.id)
      if (!edit) return c
      const next = { ...c, cycleStart: edit.start ?? c.cycleStart, due: edit.due ?? c.due }
      if (next.cycleStart === c.cycleStart && next.due === c.due) this.cycleEdits.delete(c.id)
      return next
    })

    const ghosts: CycleCard[] = this.pendingCycles.map((p) => ({
      id: `pending:${p.name}`,
      name: p.name,
      cycleStart: p.startDay,
      due: p.endDay,
    }))
    const bands = buildCycleBands([...real, ...ghosts], days, dayIndex)
    const pendingNames = new Set(this.pendingCycles.map((p) => p.name))
    for (const band of bands) if (pendingNames.has(band.name)) band.pending = true
    return bands
  }

  /**
   * The cycle strip: one gutter cell and one full-width lane per sub-lane, with
   * the bands positioned inside. The gutter cells matter as much as the bands —
   * column 1 is the only opaque sticky column, and a lane without one lets the
   * day washes show through where a label should be.
   */
  private buildCycleStrip(
    bands: CycleBand[],
    laneCount: number,
    days: TimelineDay[],
    ctx: ViewContext,
  ): HTMLElement[] {
    const out: HTMLElement[] = []
    for (let lane = 0; lane < laneCount; lane += 1) {
      const gutter = document.createElement('div')
      gutter.className = 'chr-cycle-gutter'
      gutter.style.gridColumn = '1'
      gutter.style.gridRow = String(lane + 2)
      // Names the strip once, on the lane nearest the headers.
      if (lane === 0) {
        const tag = document.createElement('span')
        tag.className = 'chr-cycle-tag'
        tag.textContent = 'cycles'
        gutter.append(tag)
      }
      out.push(gutter)

      const last = lane === laneCount - 1
      if (last) gutter.classList.add('chr-cycle-last')

      const track = document.createElement('div')
      track.className = `chr-cycle-lane${last ? ' chr-cycle-last' : ''}`
      track.style.gridColumn = `2 / span ${days.length}`
      track.style.gridRow = String(lane + 2)
      track.dataset.lane = String(lane)
      this.installDrawToCreate(track, ctx)
      out.push(track)
    }

    if (bands.length === 0) {
      // Only when there is nothing to crowd: the invitation, on hover.
      const hint = document.createElement('div')
      hint.className = 'chr-cycle-hint'
      hint.textContent = '· draw a cycle ·'
      out[1]?.append(hint)
    }

    for (const band of bands) {
      const lane = out[band.lane * 2 + 1]
      if (lane) lane.append(this.buildBand(band, ctx))
    }
    return out
  }

  /** Enter or leave an era. One at a time — overlapping cycles are read one
   *  after another, because "which era is this row part of" has no answer when
   *  two are open at once. */
  private scopeTo(id: string | null, ctx: ViewContext): void {
    this.scopedCycleId = this.scopedCycleId === id ? null : id
    this.lookback = null
    this.signature = ''
    this.didAnchor = false // re-anchor on the era, or back on today when leaving
    void this.load(ctx)
  }

  /**
   * The face: what this era was for, what it cost, and what came of it.
   *
   * Parchment, not a dashboard — one head line, a row of quiet figures, and a
   * memoir composed from the commit trail. Everything here is derived from data
   * already on the page except the intention line and the commits, which are
   * fetched once per era.
   */
  private buildFace(
    band: CycleBand,
    days: TimelineDay[],
    rows: ChronicleRow[],
    buckets: readonly ActivityBucket[],
    ctx: ViewContext,
  ): HTMLElement {
    const face = document.createElement('section')
    face.className = 'chr-face'

    const fromDay = days[band.startIdx].iso
    const toDay = days[band.endIdx].iso
    const fromMs = civilDayToLocalDate(fromDay)?.getTime() ?? 0
    const toMs = (civilDayToLocalDate(toDay)?.getTime() ?? 0) + 86_399_000
    const spanDays = band.endIdx - band.startIdx + 1
    const future = fromMs > Date.now()

    // ── head ────────────────────────────────────────────────────────────────
    const head = document.createElement('div')
    head.className = 'chr-face-head'
    const title = document.createElement('button')
    title.type = 'button'
    title.className = 'chr-face-title'
    title.textContent = band.name
    title.title = 'Open this cycle’s fiber'
    title.addEventListener('click', () => ctx.openCard(band.id))
    const when = document.createElement('span')
    when.className = 'chr-face-span'
    when.textContent = `${prettyDay(fromDay)} – ${prettyDay(toDay)} · ${spanDays}d${band.openEnd ? ' · running' : ''}`
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'chr-face-close'
    close.textContent = '✕'
    close.title = 'Leave this era (Esc)'
    close.addEventListener('click', () => this.scopeTo(null, ctx))
    head.append(title, when, close)
    face.append(head)

    const intent = this.intentions.get(band.id)
    if (intent) {
      const line = document.createElement('p')
      line.className = 'chr-face-intent'
      line.textContent = intent
      face.append(line)
    }

    // ── figures ─────────────────────────────────────────────────────────────
    const inSpan = (idx: number | null): boolean =>
      idx !== null && idx >= band.startIdx && idx <= band.endIdx
    const touched = rows.filter((r) => this.rowInSpan(r, band, days)).length
    const dues = ctx.cards.filter((c) => inSpan(idxOfDue(c.due, new Map(days.map((d, i) => [d.iso, i]))))).length
    const closed = ctx.cards.filter((c) => {
      const ms = instantMs(c.closedAt)
      return ms !== undefined && ms >= fromMs && ms <= toMs
    })

    const stats = document.createElement('dl')
    stats.className = 'chr-face-stats'
    const stat = (label: string, value: string): void => {
      const dt = document.createElement('dt')
      dt.textContent = label
      const dd = document.createElement('dd')
      dd.textContent = value
      stats.append(dt, dd)
    }
    stat('fibers touched', String(touched))
    stat('dues inside', String(dues))
    stat('closed', String(closed.length))
    stat('steering', formatMinutes(spanMinutes(buckets, 'attention', fromMs, toMs)))
    stat('agents', formatMinutes(spanMinutes(buckets, 'agent', fromMs, toMs)))
    face.append(stats)

    // ── the look back ───────────────────────────────────────────────────────
    const memoir = document.createElement('div')
    memoir.className = 'chr-face-memoir'
    const memoirHead = document.createElement('h3')
    memoirHead.className = 'chr-face-memoir-head'
    memoirHead.textContent = 'the look back'
    memoir.append(memoirHead)

    const key = `${band.id}:${fromDay}:${toDay}`
    if (future) {
      memoir.append(this.memoirEmpty('— not yet lived —'))
    } else if (this.lookback?.key === key) {
      const groups = this.lookback.groups
      if (groups.length === 0 && closed.length === 0) {
        memoir.append(this.memoirEmpty('— the era left no trail —'))
      } else {
        for (const group of groups) {
          const line = document.createElement('p')
          line.className = 'chr-face-line'
          const slug = document.createElement('span')
          slug.className = 'chr-face-slug'
          slug.textContent = group.slug
          const count = document.createElement('span')
          count.className = 'chr-face-count'
          count.textContent = `×${group.count}`
          line.append(slug, count, document.createTextNode(` ${group.subjects.join('; ')}`))
          memoir.append(line)
        }
        for (const card of closed) {
          const line = document.createElement('p')
          line.className = 'chr-face-line chr-face-closed'
          const mark = document.createElement('span')
          mark.className = card.tempered === false ? 'chr-face-mark-x' : 'chr-face-mark-ok'
          mark.textContent = card.tempered === false ? '✗' : '✓'
          line.append(mark, document.createTextNode(` ${card.name}`))
          memoir.append(line)
        }
      }
    } else {
      memoir.append(this.memoirEmpty('gathering the trail…'))
      void this.loadLookback(key, fromMs, toMs, ctx)
    }
    face.append(memoir)

    if (!future) {
      const inscribe = document.createElement('button')
      inscribe.type = 'button'
      inscribe.className = 'chr-face-inscribe'
      inscribe.textContent = 'inscribe this review'
      inscribe.addEventListener('click', () => {
        inscribe.disabled = true
        inscribe.textContent = 'inscribing…'
        void this.inscribeReview(band, memoir, ctx).then(
          () => {
            inscribe.textContent = 'inscribed'
          },
          () => {
            inscribe.disabled = false
            inscribe.textContent = 'could not inscribe'
          },
        )
      })
      face.append(inscribe)
    }
    return face
  }

  private memoirEmpty(text: string): HTMLElement {
    const el = document.createElement('p')
    el.className = 'chr-face-quiet'
    el.textContent = text
    return el
  }

  /** Did this row take any part in the era — work inside it, or something due? */
  private rowInSpan(row: ChronicleRow, band: CycleBand, days: TimelineDay[]): boolean {
    if (row.dueIdx !== null && row.dueIdx >= band.startIdx && row.dueIdx <= band.endIdx) return true
    for (let i = band.startIdx; i <= band.endIdx; i += 1) {
      const cell = row.days.get(days[i].iso)
      if (cell && (cell.agent > 0 || cell.attention > 0 || cell.notify > 0)) return true
    }
    return false
  }

  private async loadLookback(
    key: string,
    fromMs: number,
    toMs: number,
    ctx: ViewContext,
  ): Promise<void> {
    const result = await ctx.narration(new Date(fromMs).toISOString(), new Date(toMs).toISOString())
    if (this.scopedCycleId === null) return
    this.lookback = { key, groups: groupNarration(result.commits) }
    this.signature = ''
    if (this.ctx) void this.load(this.ctx)
  }

  /** The intention line, read once from the cycle fiber's body. */
  private async loadIntention(id: string): Promise<void> {
    if (this.intentions.has(id)) return
    this.intentions.set(id, '') // claim it, so a re-render does not re-ask
    try {
      const res = await fetch(`${SHUTTLE_BASE}/api/v1/fibers/${id.split('/').map(encodeURIComponent).join('/')}`)
      if (!res.ok) return
      const doc = (await res.json()) as { fiber?: { body?: string }; body?: string }
      const text = firstParagraph(doc.fiber?.body ?? doc.body)
      if (!text) return
      this.intentions.set(id, text)
      this.signature = ''
      if (this.ctx) void this.load(this.ctx)
    } catch {
      // No intention line is a fine outcome; the face stands without one.
    }
  }

  /**
   * Write the composed memoir onto the cycle fiber so the era keeps it.
   *
   * `outcome` is the era's LATEST READING and is replaced, never appended —
   * felt's own convention for that field. The intention is not lost: it lives
   * in the body, which is where the face reads it from.
   */
  private async inscribeReview(
    band: CycleBand,
    memoir: HTMLElement,
    ctx: ViewContext,
  ): Promise<void> {
    const text = [...memoir.querySelectorAll('.chr-face-line')]
      .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' · ')
    if (!text) throw new Error('nothing to inscribe')
    const origin = ctx.response.remoteScope?.originId?.replace(/^remote-/, '') ?? 'local'
    const res = await fetch(`${SHUTTLE_BASE}/api/v1/felt-edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fiber_id: band.id, origin, set: { outcome: text } }),
    })
    if (!res.ok) throw new Error(`felt-edit returned ${res.status}`)
    ctx.requestRefresh()
  }

  /** The gold "now" line, as its own element so nothing can interrupt it. */
  private buildTodaySeam(todayIdx: number): HTMLElement {
    const seam = document.createElement('div')
    seam.className = 'chr-seam'
    seam.style.gridColumn = String(todayIdx + 2)
    seam.style.gridRow = '2 / -1'
    return seam
  }

  private buildBand(band: CycleBand, ctx: ViewContext): HTMLElement {
    const el = document.createElement('button')
    el.type = 'button'
    const classes = ['chr-band']
    if (band.openStart) classes.push('chr-band-open-start')
    if (band.openEnd) classes.push('chr-band-open-end')
    if (band.pending) classes.push('chr-band-pending')
    el.className = classes.join(' ')
    el.style.left = colLeft(band.startIdx)
    el.style.width = `calc(var(--chr-day-w) * ${band.endIdx - band.startIdx + 1})`
    const label = document.createElement('span')
    label.className = 'chr-band-label'
    label.textContent = band.name
    el.append(label)
    el.title = band.pending ? `${band.name} — saving…` : `${band.name} — enter this era`
    if (band.id === this.scopedCycleId) el.classList.add('chr-band-scoped')
    if (!band.pending) {
      // The band means "enter this era". Opening the fiber lives on the face's
      // own title, so the two readings of a cycle — the span and the document —
      // each have their own gesture instead of competing for one click.
      el.addEventListener('click', () => this.scopeTo(band.id, ctx))
      // Only a saved cycle can be reshaped — there is nothing on disk to write
      // an edge to until the create has come back.
      for (const edge of ['start', 'due'] as const) {
        const grip = document.createElement('span')
        grip.className = `chr-grip chr-grip-${edge}`
        grip.dataset.edge = edge
        el.append(grip)
        this.installEdgeDrag(grip, el, band, edge, ctx)
      }
    }
    return el
  }

  /**
   * Drag a band's edge to move its `start:` or its `due:`.
   *
   * The band is repainted from the cursor as it moves, so the gesture reads as
   * pulling the span rather than as a request that a later poll might honour.
   * The write goes out once, on release.
   */
  private installEdgeDrag(
    grip: HTMLElement,
    bandEl: HTMLElement,
    band: CycleBand,
    edge: 'start' | 'due',
    ctx: ViewContext,
  ): void {
    grip.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation() // not a click on the band, and not a new draw

      const lane = bandEl.parentElement
      const days = this.currentDays
      if (!lane || days.length === 0) return
      const originStart = days[band.startIdx].iso
      const originEnd = days[band.endIdx].iso
      let fromDay = originStart
      let toDay = originEnd
      this.draft = { fromDay, toDay, naming: false }
      bandEl.classList.add('chr-band-resizing')

      const paint = (): void => {
        const span = this.spanColumns(fromDay, toDay)
        if (!span) return
        bandEl.style.left = colLeft(span.lo)
        bandEl.style.width = `calc(var(--chr-day-w) * ${span.hi - span.lo + 1})`
      }

      const onMove = (ev: MouseEvent): void => {
        const day = this.dayAt(lane, ev.clientX)
        if (day !== null) {
          // An edge may not cross its partner; it stops at a one-day span.
          if (edge === 'start') fromDay = day > toDay ? toDay : day
          else toDay = day < fromDay ? fromDay : day
        }
        this.draft = { fromDay, toDay, naming: false }
        paint()
        this.autoScrollAt(ev.clientX)
      }
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        this.stopAutoScroll()
        this.teardownDraw = null
        this.draft = null
        bandEl.classList.remove('chr-band-resizing')
        const dropped = edge === 'start' ? fromDay : toDay
        const origin = edge === 'start' ? originStart : originEnd
        if (dropped !== origin) void this.writeCycleEdge(band.id, edge, dropped, ctx)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      this.teardownDraw = (): void => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        this.stopAutoScroll()
      }
    })
  }

  /** One `felt-edit` per dropped edge. `start:` is opaque frontmatter and rides
   *  `set`; `due` is felt-native and has its own field on the endpoint. */
  private async writeCycleEdge(
    id: string,
    edge: 'start' | 'due',
    day: string,
    ctx: ViewContext,
  ): Promise<void> {
    const previous = this.cycleEdits.get(id)
    this.cycleEdits.set(id, { ...previous, [edge]: day })
    this.signature = ''
    if (this.ctx) void this.load(this.ctx)

    const origin = ctx.response.remoteScope?.originId?.replace(/^remote-/, '') ?? 'local'
    const payload =
      edge === 'start'
        ? { fiber_id: id, origin, set: { start: day } }
        : { fiber_id: id, origin, due: day }
    try {
      const res = await fetch(`${SHUTTLE_BASE}/api/v1/felt-edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(`felt-edit returned ${res.status}`)
      ctx.requestRefresh()
    } catch (err) {
      // Snap back rather than leave the band somewhere the fiber is not.
      if (previous) this.cycleEdits.set(id, previous)
      else this.cycleEdits.delete(id)
      this.signature = ''
      if (this.ctx) void this.load(this.ctx)
      window.console.error('[chronicle] could not move cycle edge', err)
    }
  }

  /**
   * Drag horizontally across an empty stretch of a lane to draw a cycle.
   *
   * The move/up listeners go on the DOCUMENT, not the lane: a drag that leaves
   * the strip — upward past the headers, or off the right edge — must still
   * track and still commit, and a lane-scoped listener would drop it silently
   * mid-gesture.
   */
  private installDrawToCreate(track: HTMLElement, ctx: ViewContext): void {
    track.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      // A press on an existing band is a click on that band, not a new draw.
      if ((e.target as HTMLElement).closest('.chr-band, .chr-cycle-name')) return
      e.preventDefault()

      const anchor = this.dayAt(track, e.clientX)
      if (anchor === null) return
      this.draft = { fromDay: anchor, toDay: anchor, naming: false }

      const ghost = document.createElement('div')
      ghost.className = 'chr-band chr-band-ghost'
      track.append(ghost)
      // Days in, columns out, every frame — so the ghost follows the grid it is
      // drawn on even if that grid grew a block since the drag began.
      const paint = (): void => {
        if (!this.draft) return
        const span = this.spanColumns(this.draft.fromDay, this.draft.toDay)
        if (!span) return
        ghost.style.left = colLeft(span.lo)
        ghost.style.width = `calc(var(--chr-day-w) * ${span.hi - span.lo + 1})`
      }
      paint()

      const onMove = (ev: MouseEvent): void => {
        if (!this.draft || this.draft.naming) return
        const day = this.dayAt(track, ev.clientX)
        if (day !== null) this.draft.toDay = day
        paint()
        this.autoScrollAt(ev.clientX)
      }
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        this.stopAutoScroll()
        this.teardownDraw = null
        if (!this.draft) return
        this.draft.naming = true
        const [from, to] = [this.draft.fromDay, this.draft.toDay].sort()
        this.openNameInput(track, ghost, from, to, ctx)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      this.teardownDraw = (): void => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        ghost.remove()
      }
    })
  }

  /**
   * Near either edge of the viewport, keep scrolling while the cursor stays
   * there — so a cycle can be drawn or stretched past what is currently on
   * screen instead of stopping at the frame. Speed rises as the cursor presses
   * further into the margin, which makes both a nudge and a long haul feel
   * controllable from the same gesture.
   */
  private autoScrollAt(clientX: number): void {
    const scroller = this.scroller
    if (!scroller) return
    const rect = scroller.getBoundingClientRect()
    const margin = 48
    const leftPress = rect.left + margin - clientX
    const rightPress = clientX - (rect.right - margin)
    const press = leftPress > 0 ? -leftPress : rightPress > 0 ? rightPress : 0
    if (press === 0) {
      this.stopAutoScroll()
      return
    }
    // The step lives on the instance, not in the closure: the cursor keeps
    // moving inside the margin, and a step captured when the timer started
    // would freeze the speed at whatever the first frame happened to be.
    this.autoScrollStep = Math.sign(press) * Math.min(24, 4 + Math.abs(press) / 3)
    if (this.autoScrollTimer !== null) return
    this.autoScrollTimer = window.setInterval(() => {
      if (!this.scroller) return this.stopAutoScroll()
      this.scroller.scrollLeft += this.autoScrollStep
    }, 16)
  }

  private stopAutoScroll(): void {
    if (this.autoScrollTimer === null) return
    window.clearInterval(this.autoScrollTimer)
    this.autoScrollTimer = null
    this.autoScrollStep = 0
  }

  /** The CIVIL DAY a client-x falls on, clamped to the window. Null only when
   *  there are no columns to fall on. */
  private dayAt(track: HTMLElement, clientX: number): string | null {
    const days = this.currentDays
    if (days.length === 0) return null
    const rect = track.getBoundingClientRect()
    const dayW = this.dayWidthPx || rect.width / days.length || 1
    return days[clamp(Math.floor((clientX - rect.left) / dayW), 0, days.length - 1)].iso
  }

  /** Two civil days as the column range they currently occupy, in order. Null
   *  when either has fallen outside the window — the caller keeps its last
   *  painted position rather than jumping to an edge. */
  private spanColumns(a: string, b: string): { lo: number; hi: number } | null {
    const days = this.currentDays
    const ia = days.findIndex((d) => d.iso === a)
    const ib = days.findIndex((d) => d.iso === b)
    if (ia < 0 || ib < 0) return null
    return { lo: Math.min(ia, ib), hi: Math.max(ia, ib) }
  }

  /** Name the span in place. Enter commits, Escape abandons; either way the
   *  ghost and the suspended-rebuild state are cleared on exactly one path. */
  private openNameInput(
    track: HTMLElement,
    ghost: HTMLElement,
    startDay: string,
    endDay: string,
    ctx: ViewContext,
  ): void {
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'chr-cycle-name'
    input.placeholder = 'name this cycle'
    input.style.left = ghost.style.left
    input.style.width = `max(${ghost.style.width}, 150px)`
    track.append(input)
    input.focus()

    let settled = false
    const finish = (name: string | null): void => {
      if (settled) return
      settled = true
      input.remove()
      ghost.remove()
      this.draft = null
      this.teardownDraw = null
      if (name) void this.createCycle(name, startDay, endDay, ctx)
      else if (this.ctx) void this.load(this.ctx)
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(input.value.trim() || null)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(null)
      }
      e.stopPropagation() // the board's own hotkeys must not eat the typing
    })
    input.addEventListener('blur', () => finish(input.value.trim() || null))
  }

  /**
   * Write the cycle. ONE call, both dates.
   *
   * This used to be two — create with `start`, then a `felt-edit` for `due` —
   * because the daemon dropped a `due` sent at create: `@felt_native_keys`
   * excluded it from the frontmatter splice as "felt's to write", and `felt add`
   * was never told. Both halves disowned it. b71787b passes `-D`/`-o` through,
   * so `due` and `outcome` now round-trip in the create itself.
   *
   * Worth the change beyond tidiness: two non-atomic writes meant a failed
   * second call left a real, saved, open-ended cycle nobody drew. There is no
   * intermediate state to fail into now. `start` still rides the frontmatter as
   * an opaque key; `due` rides it as a native one. The band still appears
   * immediately — `pendingCycles` holds it until a poll returns the real card.
   */
  private async createCycle(
    name: string,
    startDay: string,
    endDay: string,
    ctx: ViewContext,
  ): Promise<void> {
    this.pendingCycles.push({ name, startDay, endDay })
    if (this.ctx) {
      this.signature = '' // the pending band is not in the signature's inputs
      void this.load(this.ctx)
    }

    const origin = ctx.response.remoteScope?.originId?.replace(/^remote-/, '') ?? 'local'
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || `cycle-${Date.now()}`
    const id = `cycles/${slug}`

    try {
      const created = await fetch(`${SHUTTLE_BASE}/api/v1/fiber/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          name,
          body: '',
          frontmatter: {
            name,
            status: 'open',
            tags: ['cycle'],
            start: startDay,
            due: endDay,
          },
          origin,
        }),
      })
      const body = (await created.json().catch(() => ({}))) as { id?: string; error?: string }
      if (!created.ok || !body.id) throw new Error(body.error || `create returned ${created.status}`)
      ctx.requestRefresh()
    } catch (err) {
      // Drop the optimistic band rather than leave a cycle on screen that does
      // not exist on disk — a chronicle that shows work that never happened is
      // the one failure this page cannot afford.
      this.pendingCycles = this.pendingCycles.filter((p) => p.name !== name)
      this.signature = ''
      if (this.ctx) void this.load(this.ctx)
      window.console.error('[chronicle] could not create cycle', err)
    }
  }

  /** Sticky top-left cell — the row-label column's own head. Counts fibers
   *  only; the working-directory rows below them are not fibers. */
  private buildCorner(total: number): HTMLElement {
    const corner = document.createElement('div')
    corner.className = 'chr-corner'
    corner.style.gridColumn = '1'
    corner.style.gridRow = '1'
    const count = document.createElement('span')
    count.className = 'chr-corner-count'
    count.textContent = `${total} ${total === 1 ? 'fiber' : 'fibers'}`
    corner.append(count)
    return corner
  }

  /**
   * The almanac head. Each day is a real `<button>`, not a tinted div: clicking
   * a column opens the Day view on that civil day, and making it a button is
   * what gets that gesture keyboard focus, Enter/Space, and a name in the
   * accessibility tree for free.
   *
   * `day.iso` is already the bare civil day the cursor wants — it comes from
   * `buildTimelineDays`, which strides the local calendar. No Date round trip
   * on the way out, so nothing can lose a day here.
   */
  private buildHead(days: TimelineDay[], ctx: ViewContext): HTMLElement[] {
    return days.map((day, i) => {
      const cell = document.createElement('button')
      cell.type = 'button'
      const classes = ['chr-head']
      if (day.isToday) classes.push('chr-head-today')
      if (day.isPast) classes.push('chr-head-past')
      if (day.isWeekend) classes.push('chr-head-weekend')
      if (day.weekBoundary) classes.push('chr-head-week')
      cell.className = classes.join(' ')
      cell.style.gridColumn = String(i + 2)
      cell.style.gridRow = '1'
      cell.dataset.dayIso = day.iso

      const dow = document.createElement('span')
      dow.className = 'chr-head-dow'
      dow.textContent = day.isToday ? 'today' : day.weekdayLabel
      const num = document.createElement('span')
      num.className = 'chr-head-num'
      num.textContent = day.label
      cell.append(dow, num)

      const spoken = civilDayToLocalDate(day.iso)?.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      })
      cell.title = `Open ${spoken ?? day.iso} in the Day view`
      cell.setAttribute('aria-label', cell.title)
      cell.addEventListener('click', () => ctx.switchView('day', { focusDate: day.iso }))
      return cell
    })
  }

  /** The washes are one element per day spanning every row — the weekend and
   *  past tints and the vertical hairlines live here, behind the ink, so a row
   *  never has to draw its own background. */
  private buildWashes(days: TimelineDay[], rowCount: number): HTMLElement[] {
    if (rowCount <= 0) return []
    return days.map((day, i) => {
      const wash = document.createElement('div')
      const classes = ['chr-wash']
      if (day.isToday) classes.push('chr-wash-today')
      if (day.isPast) classes.push('chr-wash-past')
      if (day.isWeekend) classes.push('chr-wash-weekend')
      if (day.weekBoundary) classes.push('chr-wash-week')
      wash.className = classes.join(' ')
      wash.style.gridColumn = String(i + 2)
      wash.style.gridRow = '2 / -1'
      return wash
    })
  }

  private buildRow(
    row: ChronicleRow,
    r: number,
    days: TimelineDay[],
    dayIndex: Map<string, number>,
    peak: number,
    ctx: ViewContext,
  ): HTMLElement[] {
    const gridRow = String(r + 2)

    const label = document.createElement('div')
    label.className = `chr-label${row.kind === 'cwd' ? ' chr-label-cwd' : ''}${row.live ? ' chr-label-live' : ''}`
    label.style.gridColumn = '1'
    label.style.gridRow = gridRow

    const name = document.createElement(row.cardId ? 'button' : 'span')
    name.className = 'chr-name'
    name.textContent = row.label
    name.title = row.label
    if (row.cardId) {
      const cardId = row.cardId
      ;(name as HTMLButtonElement).type = 'button'
      name.addEventListener('click', () => ctx.openCard(cardId))
    }

    const note = document.createElement('span')
    note.className = 'chr-note'
    note.textContent = row.note

    const span = document.createElement('span')
    span.className = 'chr-span'
    const spanDays = row.endIdx - row.startIdx + 1
    span.textContent = `${spanDays}d`
    span.title = `${spanDays} day${spanDays === 1 ? '' : 's'} on the chronicle`

    label.append(name, note, span)

    const track = document.createElement('div')
    track.className = `chr-track${row.kind === 'cwd' ? ' chr-track-cwd' : ''}`
    track.style.gridColumn = `2 / span ${days.length}`
    track.style.gridRow = gridRow

    const life = document.createElement('div')
    life.className = `chr-life${row.kind === 'cwd' ? ' chr-life-cwd' : ''}`
    life.style.left = colLeft(row.startIdx)
    life.style.width = `calc(var(--chr-day-w) * ${row.endIdx - row.startIdx + 1})`
    track.append(life)

    for (const [day, cell] of row.days) {
      const idx = dayIndex.get(day)
      if (idx === undefined) continue
      if (cell.agent > 0) {
        const seg = document.createElement('div')
        seg.className = `chr-seg chr-seg-${densityStep(cell.agent, peak)}`
        seg.style.left = colLeft(idx)
        track.append(seg)
      }
      if (cell.attention > 0) {
        const tick = document.createElement('div')
        tick.className = 'chr-att'
        tick.style.left = colLeft(idx)
        track.append(tick)
      }
      if (cell.notify > 0) {
        const dot = document.createElement('div')
        dot.className = 'chr-notify'
        dot.style.left = colLeft(idx)
        track.append(dot)
      }
    }

    if (row.closed && row.closeIdx !== null) {
      const end = document.createElement('div')
      end.className = `chr-mark chr-end${row.closedOk ? '' : ' chr-end-compost'}`
      end.style.left = colLeft(row.closeIdx)
      end.textContent = row.closedOk ? '✓' : '✗'
      track.append(end)
    }
    // Ahead of today: promises only, never ink.
    if (row.dueIdx !== null) {
      const due = document.createElement('div')
      due.className = 'chr-mark chr-due'
      due.style.left = colLeft(row.dueIdx)
      due.textContent = '◴'
      due.title = 'due'
      track.append(due)
    }
    if (row.launchIdx !== null) {
      const launch = document.createElement('div')
      launch.className = 'chr-mark chr-launch'
      launch.style.left = colLeft(row.launchIdx)
      launch.textContent = '◐'
      launch.title = 'next launch'
      track.append(launch)
    }

    return [label, track]
  }

  /** Lives in the label gutter, not across the whole row: the gutter is the one
   *  column with an opaque sticky backing, so a full-width expander would let
   *  the day washes show through where a row label normally covers them. */
  private buildExpander(hidden: number, r: number): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'chr-more'
    btn.style.gridColumn = '1'
    btn.style.gridRow = String(r + 2)
    btn.textContent = `+${hidden} more`
    btn.addEventListener('click', () => {
      this.expanded = true
      this.signature = ''
      if (this.ctx) void this.load(this.ctx)
    })
    return btn
  }

  /**
   * Put day column `idx` at {@link TODAY_ANCHOR} across the DAY AREA — the area
   * beside the sticky gutter, not the whole viewport. Measuring against the
   * viewport would push the day right by the gutter's width and quietly hide a
   * chunk of the recent past behind it. Runs on the first render and whenever
   * the cursor moves; otherwise a render restores whatever the reader had
   * scrolled to.
   */
  private anchorDay(scroller: HTMLElement, idx: number, fraction = TODAY_ANCHOR): void {
    requestAnimationFrame(() => {
      if (this.scroller !== scroller) return
      const styles = getComputedStyle(scroller)
      const dayW = parseFloat(styles.getPropertyValue('--chr-day-w')) || 24
      const labelW = this.labelWidth(scroller)
      const center = labelW + (idx + 0.5) * dayW
      const restingX = labelW + (scroller.clientWidth - labelW) * fraction
      scroller.scrollLeft = Math.max(0, center - restingX)
      this.didAnchor = true
    })
  }
}

/** FNV-1a over a string — a short, stable signature, not a hash for security. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

registerView(new ChronicleView())
