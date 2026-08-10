/**
 * ChronicleView (hotkey 4) — the long record: what was worked on, and for how
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
 * confidence — see {@link attributeActivity}. THE PAGE DRAWS FIBER ROWS ONLY:
 * whatever the ladder cannot place on a fiber is left undrawn. It is a thin
 * slice of the record, and a row named after a directory would teach the wrong
 * unit — this page is about fibers, and a chronicle that hedges about its own
 * unit is harder to read than one that leaves a little out. The attribution
 * still separates the unplaced work (`Attribution.byCwd`), so nothing about the
 * join's honesty depends on what the view chooses to ink.
 *
 * ERAS. The strip above the rows carries cycles. Two gestures make one: drag
 * across days to draw a span and name it, or press `+` to SPEAK an era — a
 * paragraph about what it is, starting today and open-ended, whose span the
 * same drag grips settle later. See {@link eraName} and `openEraComposer`.
 */

import { normalizeFocusDate, registerView, type TemporalView, type ViewContext } from './ViewRegistry.js'
import { createViewEmptyState, createViewPage } from './ViewPage.js'
import { cardPathSegments, cardUlids, sessionSlug, sessionUlid } from './sessionNames.js'
import { ACTIVITY_KEY_ITEMS, MARK_GLYPH, messageClause } from './vocabulary.js'
import { civilDayNoon, formatSpanMinutes, railBounds, shiftCivilDay } from './railTime.js'
import {
  buildSessionIndex,
  foldActiveMinutes,
  isOriginStale,
  lookupTmux,
  parseCommitSlug,
  staleOrigins,
  type ActivityBucket,
  type SessionPairing,
  type TemporalOrigins,
} from './TemporalData.js'
import type { KanbanCard, KanbanResponse } from '../KanbanTypes.js'
import { buildTimelineDays, type TimelineDay } from '../KanbanSurfaces.js'
import { civilDayToLocalDate, dueCivilDay, instantMs, isoDayLocal, railCivilDay } from '../civilDay.js'
import {
  activityChunks,
  daysBetween,
  planExtension,
  windowOf,
  type DayRange,
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
 * that is what a rail is named by: the date it opened on. The boundary itself
 * is `RAIL_START_HOUR` in ./railTime.js, which `railCivilDay` defaults to.
 */

/** The current rail as a local Date at noon — the shape `buildTimelineDays`
 *  wants, and noon-anchored because midnight is the one wall-clock time a
 *  spring-forward day can lack. */
export function railDate(nowMs: number): Date {
  const d = civilDayToLocalDate(railCivilDay(nowMs))
  if (!d) return new Date(nowMs)
  d.setHours(12, 0, 0, 0)
  return d
}

/**
 * The origin key a write is routed by — `local`, or a bare hostname for a
 * remote-owned fiber. Mirrors `shuttleOrigin` in src/forms/projectModel.ts;
 * duplicated rather than imported because the board does not otherwise depend
 * on the forms layer, and a one-line regex is a cheaper coupling than a
 * cross-layer import.
 */
export function shuttleOrigin(originId: string | undefined): string {
  return (originId ?? 'local').replace(/^remote-/, '')
}

/** Origin for a write with no card behind it yet — a cycle being created. The
 *  board's own scope: the remote it is pinned to, else this daemon. */
function boardOrigin(response: KanbanResponse): string {
  return shuttleOrigin(response.remoteScope?.originId)
}

// ── Pure join + aggregation (exported for chronicleJoin.test.ts) ─────────────

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
    for (const slug of cardPathSegments(card)) {
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
  //
  // HOST-SCOPED. A tmux name is unique within a host, never across the fleet,
  // and the buckets now arrive from every daemon at once — so `ada`'s
  // `run-shuttle` minutes must not join the pairing `bob` recorded under the
  // same session name. `lookupTmux` reads the scoped key first and only falls
  // back to the bare name for a bucket that cannot say where it ran.
  if (bucket.s !== null && byTmux) {
    const pairing = lookupTmux(byTmux, bucket.host, bucket.s)
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
  /**
   * WHERE in the rail the steering happened, as fractions of the rail's own
   * length — one entry per SPELL, not per minute. A day's agent work is a
   * density, so one segment per column says everything; a steering mark is an
   * event, and an event collapsed to the column's midpoint claims a time that
   * never happened. Two spells an evening apart are two ticks.
   */
  attentionAt: number[]
}

/** Minute-ms stamps folded into spells, then each spell placed at its own
 *  midpoint as a fraction of the rail `[startMs, endMs)`. ADJACENT minutes only
 *  — a 40-minute sitting is one tick, a gap of even one idle minute is two.
 *  Sorted, deduplicated, and clamped inside the column. */
export function spellFractions(
  minuteMs: readonly number[],
  day: string,
): number[] {
  const { startMs, endMs } = railBounds(day)
  const span = endMs - startMs
  if (!(span > 0) || minuteMs.length === 0) return []
  const sorted = [...new Set(minuteMs)].sort((a, b) => a - b)
  const out: number[] = []
  let lo = sorted[0]
  let hi = sorted[0]
  const flush = () => {
    // The spell covers its last minute too, so the midpoint of [lo, hi+1min).
    const mid = (lo + hi + MINUTE_MS) / 2
    out.push(clamp((mid - startMs) / span, 0, 1))
  }
  for (const m of sorted.slice(1)) {
    if (m - hi <= MINUTE_MS) {
      hi = m
      continue
    }
    flush()
    lo = m
    hi = m
  }
  flush()
  return out
}

const MINUTE_MS = 60_000

/**
 * Fold buckets into civil days by their LOCAL day. Never by `m / 86_400_000`:
 * a fixed-ms floor is a UTC day, which is the wrong day for half of every
 * evening west of Greenwich and half of every morning east of it, and which
 * mis-slices the 23- and 25-hour days at a DST transition.
 */
export function aggregateByCivilDay(buckets: readonly ActivityBucket[]): Map<string, DayCell> {
  const out = new Map<string, DayCell>()
  // The minute stamps behind the steering, kept per day until the whole day is
  // in hand — spells can only be found once the neighbours are known.
  const stamps = new Map<string, { attention: number[] }>()
  for (const b of buckets) {
    if (!Number.isFinite(b.m)) continue
    const day = railCivilDay(b.m)
    let cell = out.get(day)
    if (!cell) {
      cell = { agent: 0, attention: 0, attentionAt: [] }
      out.set(day, cell)
      stamps.set(day, { attention: [] })
    }
    const n = Number.isFinite(b.n) ? Math.max(b.n, 1) : 1
    const at = stamps.get(day)!
    if (b.k === 'agent') cell.agent += n
    else if (b.k === 'attention') {
      cell.attention += n
      at.attention.push(b.m)
    }
    // `notify` and `reply` fold into nothing: neither is a state of the work.
    // A reply's minute is already inked by its agent bucket, and a notify is
    // an idle nudge the board no longer draws anywhere.
  }
  for (const [day, cell] of out) {
    const at = stamps.get(day)!
    cell.attentionAt = spellFractions(at.attention, day)
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
export type CycleCard = Pick<KanbanCard, 'id' | 'name' | 'cycleStart' | 'due' | 'originId'>

/** A cycle placed on the day grid. */
export interface CycleBand {
  id: string
  name: string
  /** Whose daemon owns this cycle — the routing key for an edge or a review. */
  originId: string
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

/** The one sentence that teaches the strip's gesture. Said in three places —
 *  the gutter's tooltip, the lane's tooltip, and the hover hint — so it cannot
 *  drift into three different descriptions of one drag. */
const ERA_HINT = 'drag across days to draw an era'

/** What the `+` in the cycle gutter promises. */
const ERA_SPEAK_HINT = 'speak a new era'

/**
 * The NAME an era gets when it was spoken rather than named.
 *
 * A spoken era arrives as a paragraph — its ontology, its goal, what drives it,
 * what constrains it. The band on the strip is one capsule wide, so it needs a
 * handle, and the handle is the opening clause: the first sentence, or the
 * first line, whichever ends sooner, clipped at the width a band can carry.
 * The prose itself is not summarized away — it becomes the fiber's body, which
 * is where the era's intention is read from.
 */
export function eraName(prose: string): string {
  const first = prose.trim().split('\n')[0] ?? ''
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(first)
  const head = (sentence ? sentence[1] : first).trim().replace(/[.!?,;:]+$/, '')
  if (head.length <= 64) return head
  const cut = head.slice(0, 64)
  const space = cut.lastIndexOf(' ')
  return `${(space > 24 ? cut.slice(0, space) : cut).trim()}…`
}

/** How long a single click on a band waits to see whether it is half of a
 *  double. The platform's own double-click window; shorter drops renames on a
 *  slower hand, longer makes entering an era feel unanswered. */
const DOUBLE_CLICK_MS = 250

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
    originId: card.originId,
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

/**
 * A cycle drawn this session, held until the daemon's feed carries it.
 *
 * `id` is the fiber id the create endpoint answered with. It is the whole
 * difference between a band that is a picture and a band that is a cycle: with
 * it the ghost carries the SAME id the served card will, so entering the era,
 * reading its face and fetching its intention all work immediately. Without it
 * — the seconds between the drag and the create's answer — there is nothing on
 * disk to enter, and the band is drawn as `pending` and does not respond.
 */
export interface PendingCycle {
  name: string
  startDay: string
  endDay: string | null
  /** Set the moment the create returns; undefined only while it is in flight. */
  id?: string
}

/**
 * Which optimistic cycles are still worth drawing.
 *
 * A ghost retires when the served feed carries the same cycle — matched by ID
 * first, because that is the identity the daemon and the create response agree
 * on. The NAME fallback covers the ghost whose create has not answered yet, and
 * the older store where a create returned no id at all.
 *
 * Matching by name alone was the defect: the feed is polled, so a ghost stayed
 * on the strip for up to a poll interval after its fiber existed, and a ghost
 * cannot be clicked. The band was drawn, dated and named, and did nothing.
 */
export function retirePendingCycles(
  pending: readonly PendingCycle[],
  served: readonly Pick<CycleCard, 'id' | 'name'>[],
): PendingCycle[] {
  const ids = new Set(served.map((c) => c.id))
  const names = new Set(served.map((c) => c.name))
  return pending.filter((p) => !(p.id !== undefined && ids.has(p.id)) && !names.has(p.name))
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
    const { slug: parsed, rest } = parseCommitSlug(commit.subject)
    const slug = parsed ? parsed.toLowerCase() : 'elsewhere'
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

/** A name reduced to the shape a commit slug is written in. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The fiber a commit slug names, when the page can say so without guessing.
 *
 * Shuttle's commit subjects are `slug: what happened`, and the slug is nearly
 * always the fiber the work was about — so the look-back can open it. The match
 * is EXACT, against the id's last segment or the slugified name, and it must be
 * UNIQUE: two fibers answering to one slug means the trail does not identify
 * either, and a link that opens the wrong card is worse than a word that is not
 * a link. Undefined in both the ambiguous and the unknown case; the caller
 * leaves the slug as plain text.
 */
export function resolveNarrationSlug<T extends { id: string; name: string }>(
  slug: string,
  cards: readonly T[],
): T | undefined {
  const wanted = slugify(slug)
  if (!wanted) return undefined
  const hits = cards.filter(
    (c) => slugify(c.id.split('/').pop() ?? '') === wanted || slugify(c.name) === wanted,
  )
  return hits.length === 1 ? hits[0] : undefined
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

/** The document endpoint for one fiber id. Each id SEGMENT is encoded on its
 *  own, so a slug id (`cycles/before`) keeps its separators and reconstructs as
 *  the same id on the daemon's wildcard route. */
export function fiberDocUrl(shuttleBase: string, id: string): string {
  return `${shuttleBase}/api/v1/fibers/${id.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * The body out of a fiber-document response.
 *
 * The endpoint answers with the LIST envelope — `{ fibers: [{ fiber: {…} }] }`
 * — and the body rides the fiber object, only when the request asked for it
 * (`?body=1`). Reading `doc.fiber.body` off the envelope, as this once did,
 * finds nothing on every response the daemon has ever sent: the intention line
 * was not missing on some cycles, it was missing on all of them. The flatter
 * shapes are still accepted so a relayed or older daemon reads the same.
 */
export function fiberBodyOf(doc: unknown): string | undefined {
  if (typeof doc !== 'object' || doc === null) return undefined
  const d = doc as {
    fibers?: Array<{ fiber?: { body?: unknown }; body?: unknown }>
    fiber?: { body?: unknown }
    body?: unknown
  }
  const entry = d.fibers?.[0]
  for (const candidate of [entry?.fiber?.body, entry?.body, d.fiber?.body, d.body]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return undefined
}

// ── Row model ────────────────────────────────────────────────────────────────

interface ChronicleRow {
  key: string
  label: string
  /** Tiny mono note under the name's right edge: the owning host. */
  note: string
  /** The host this row is WAITING ON — set only when the fiber is wholly owned
   *  by a remote origin whose read is stale. Null is the ordinary case, and it
   *  is also what a thin window says: data that simply has not arrived is not
   *  an error, so nothing but a stale origin lights this. */
  waitingOn: string | null
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

/**
 * The host a row is waiting on, or null.
 *
 * WHOLLY REMOTE ONLY. A locally-owned fiber is read from this daemon, which
 * answers for itself, so nothing about a remote's freshness may gray it. A
 * remote-owned one has exactly one source, and when that source's last read is
 * stale the whole row — lifeline, ink and marks — is last-known-good rather
 * than current, which is what the muted register says.
 *
 * The origins block is keyed by ORIGIN NAME, and the board knows the same
 * origin by up to three spellings (`remote-ada`, `ada`, and the hostname the
 * staleness block reports). All three are tried; the label is what the reader
 * sees either way.
 */
export function rowWaitingOn(
  card: Pick<KanbanCard, 'originId'>,
  hostname: string,
  origins: TemporalOrigins,
): string | null {
  if (card.originId === 'local') return null
  const keys = [card.originId, card.originId.replace(/^remote-/, ''), hostname]
  return keys.some((key) => isOriginStale(origins, key)) ? hostname : null
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
  origins: TemporalOrigins,
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
  for (const day of days.keys()) sortMs = Math.max(sortMs, (civilDayNoon(day)?.getTime() ?? 0))

  const host = hostLabel(card, response)

  return {
    key: `fiber:${card.id}`,
    label: card.name,
    note: host,
    waitingOn: rowWaitingOn(card, host, origins),
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


/**
 * Every row the chronicle draws, in reading order: live fibers, then fibers by
 * most-recent activity.
 *
 * FIBER ROWS ONLY. Activity that joined to no fiber is not drawn: it is a thin
 * slice of the record, and a row named after a directory teaches the page's
 * unit wrong. The attribution still separates it (`Attribution.byCwd`), so the
 * join keeps its honesty — the chronicle simply has nothing to say about it.
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
  origins: TemporalOrigins,
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
    fibers.push(buildFiberRow(card, buckets, response, dayIndex, todayIdx, origins))
  }
  fibers.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1
    if (b.sortMs !== a.sortMs) return b.sortMs - a.sortMs
    return a.label.localeCompare(b.label)
  })

  return fibers
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

/**
 * Month bearings. A civil day is `YYYY-MM-DD`, so the first of a month is a
 * string test — no Date round trip, and therefore no timezone to get wrong.
 */
function isMonthStart(day: string): boolean {
  return day.slice(8, 10) === '01'
}

/** A civil day's month, named. `long` for the sticky bearing, `short` for the
 *  inline mark at a boundary column, which is one day-column wide. */
function monthName(day: string, style: 'long' | 'short'): string {
  const d = civilDayToLocalDate(day)
  return d ? d.toLocaleDateString(undefined, { month: style }) : day.slice(0, 7)
}

/** The month bearing for a column, with the year when it is not this one —
 *  scrolling back a year should not read as scrolling back a month. */
function monthBearing(day: string, nowYear: number): string {
  const year = Number(day.slice(0, 4))
  const name = monthName(day, 'long')
  return Number.isFinite(year) && year !== nowYear ? `${name} ${year}` : name
}

/** `left` for a mark sitting in day column `idx`. */
function colLeft(idx: number): string {
  return `calc(var(--chr-day-w) * ${idx})`
}

/** `left` for a mark `frac` of the way THROUGH day column `idx`. */
function colLeftAt(idx: number, frac: number): string {
  return `calc(var(--chr-day-w) * ${(idx + clamp(frac, 0, 1)).toFixed(4)})`
}

/**
 * Where a cell's event ticks go. Normally the spell midpoints the aggregation
 * found; a cell that carries a count but no stamps — a hand-built cell, an
 * older cached shape — still gets its one centered tick rather than vanishing.
 */
function spellPositions(at: readonly number[], count: number): readonly number[] {
  if (at.length > 0) return at
  return count > 0 ? [0.5] : []
}

// ── The view ─────────────────────────────────────────────────────────────────

class ChronicleView implements TemporalView {
  readonly id = 'chronicle' as const
  readonly title = 'Chronicle'
  readonly hotkey = '4'

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
  /** The sticky month bearing in the corner cell, and what it currently says.
   *  Held so a scroll can repaint one word without touching the grid. */
  private monthEl: HTMLElement | null = null
  private monthText = ''
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
  /** An in-place editor is open (a band rename, or the face's name/intention).
   *  Stands the poll down for the same reason `draft` does: a rebuild would
   *  take the field out from under the hand mid-word. */
  private editing = false
  /** Clicks on the face's title are ignored until this instant. An in-place
   *  editor's own open and close can emit a stray click on the element it
   *  covered, and that click must not be read as a request to open a modal. */
  private gestureLockUntil = 0
  /** Cycles created this session and not yet echoed by a poll. Held so the band
   *  appears under the cursor at once rather than up to 15s later.
   *
   *  `id` arrives with the create's own response, well before the daemon's feed
   *  carries the fiber. From that moment the band is a REAL band — see
   *  {@link PendingCycle}. */
  private pendingCycles: PendingCycle[] = []
  /** Edge drags written but not yet echoed by a poll, keyed by cycle id. Held
   *  so a dragged edge stays where it was dropped instead of snapping back for
   *  the seconds until the daemon's answer comes round. */
  private cycleEdits = new Map<string, { start?: string; due?: string }>()
  /** Renames written but not yet echoed by a poll, keyed by cycle id. Same
   *  contract as {@link cycleEdits}: held until the daemon's copy agrees. */
  private cycleNames = new Map<string, string>()
  private teardownDraw: (() => void) | null = null
  /** The day columns of the current render, so a gesture handler can convert a
   *  cursor position into a civil day without threading them through. */
  private currentDays: TimelineDay[] = []
  /**
   * The day range the chronicle currently EXISTS over. Grows at both edges as
   * the viewer scrolls (see `maybeExtend`); null until the first load, which
   * seeds it from PAST_DAYS/FUTURE_DAYS around the rail's today.
   */
  private window: DayRange | null = null
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
  /**
   * Per-origin freshness, as the composites report it. Activity's block wins
   * over the ledger's where they overlap — it is the feed the ink comes from.
   * A window served entirely from the chunk cache carries no block, so the last
   * one seen is kept rather than being read as "everything is fresh".
   */
  private activityOrigins: TemporalOrigins = {}
  private origins: TemporalOrigins = {}

  mount(host: HTMLElement, ctx: ViewContext): void {
    const page = createViewPage(this.title)
    this.root = page.root
    this.body = page.body
    this.ctx = ctx
    this.signature = ''
    // The anchor is TWO fields — "have we scrolled yet" and "onto which cursor
    // value" — and they only behave if they move together. Clearing one alone
    // leaves the view believing it is anchored on a cursor from a previous
    // visit, so both are cleared here and in unmount, side by side.
    this.didAnchor = false
    this.anchoredOn = null
    this.dayWidthPx = 0
    // The registry holds ONE instance of this view for the life of the page, so
    // every field here outlives the mount that set it. "Show me the other 40
    // rows" is a decision about one visit, not a preference — leaving it set
    // meant a board opened tomorrow still had yesterday's list unrolled, with
    // no expander visible to explain why.
    this.expanded = false
    this.monthEl = null
    this.monthText = ''
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
    this.editing = false
    this.pendingCycles = []
    this.cycleEdits.clear()
    this.cycleNames.clear()
    this.currentDays = []
    this.window = null
    this.pendingScrollDelta = 0
    this.fetchedChunks = new Map()
    this.onScroll = null
    this.monthEl = null
    this.monthText = ''
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.root?.remove()
    this.root = null
    this.body = null
    this.scroller = null
    this.ctx = null
    this.signature = ''
    this.didAnchor = false
    this.anchoredOn = null
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
    const today = railCivilDay(nowMs)
    // The window is the chronicle's own state once scrolling has grown it; the
    // constants only seed it.
    const window = this.window ?? windowOf(shiftCivilDay(today, -PAST_DAYS), shiftCivilDay(today, FUTURE_DAYS))
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
    const fresh: TemporalOrigins = {}
    const [chunkResults, sessions] = await Promise.all([
      Promise.all(
        wanted.map(async (chunk) => {
          const held = this.fetchedChunks.get(chunk.key)
          if (held) return [chunk.key, held] as const
          const res = await ctx.activity(chunk.fromMs, chunk.toMs)
          Object.assign(fresh, res.origins ?? {})
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
    if (Object.keys(fresh).length > 0) this.activityOrigins = fresh
    this.origins = { ...(sessions.origins ?? {}), ...this.activityOrigins }
    // A rebuild would tear out the half-drawn band, the naming input, or an
    // open rename under the reader's cursor. The poll's data is not worth that;
    // the next one lands 15s later and the gesture is over in seconds.
    if (this.draft !== null || this.editing) return

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
      // A remote falling behind (or catching up) mutes or un-mutes whole rows.
      `stale:${staleOrigins(this.origins).join(',')}`,
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
    // The corner cell went with the old body; `buildCorner` hands back a new one.
    this.monthEl = null
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
      this.origins,
    )

    if (rows.length === 0) {
      body.append(createViewEmptyState('— no hand has passed this way —'))
      return
    }

    const hidden = this.expanded ? 0 : Math.max(0, rows.length - MAX_ROWS)
    const shown = hidden > 0 ? rows.slice(0, MAX_ROWS) : rows
    // The density scale is the whole record's, not the visible slice's — the
    // expander must not redraw every other row's segments.
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

    grid.append(this.buildCorner(rows.length), ...this.buildHead(days, ctx))
    grid.append(...this.buildWashes(days, laneCount + bodyRows))
    grid.append(...this.buildCycleStrip(bands, laneCount, days, ctx))
    // Fiber rows start below the cycle strip.
    const rowOffset = laneCount
    const era = this.scopedCycleId === null ? null : bands.find((b) => b.id === this.scopedCycleId)
    let r = rowOffset
    for (let i = 0; i < shown.length; i += 1) {
      const parts = this.buildRow(shown[i], r++, days, dayIndex, peak, ctx)
      // Dimmed, never hidden: a row with no part in the era is still part of
      // the record, and removing it would make the era look emptier than it was.
      if (era && !this.rowInSpan(shown[i], era, days)) {
        for (const el of parts) el.classList.add('chr-outside')
      }
      grid.append(...parts)
    }
    if (hidden > 0) grid.append(this.buildExpander(hidden, r++))
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
      void this.loadIntention(scoped.id, ctx)
    } else if (this.scopedCycleId !== null) {
      // The era left the window (its dates moved, or it was deleted). Silently
      // stop scoping rather than showing a face for a band that is not there.
      this.scopedCycleId = null
    }
    body.append(scroller)
    body.append(this.buildKey(bands.length > 0))
    this.scroller = scroller
    // The scroller is a new element every rebuild, so the listener goes on with
    // it. Passive: extension never prevents the scroll it is reacting to.
    this.onScroll = () => {
      this.bearMonth()
      this.maybeExtend()
    }
    scroller.addEventListener('scroll', this.onScroll, { passive: true })
    this.fitDayWidth()
    this.bearMonth()

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
   *     the window grows on the NEXT SCROLL after release, not on the release
   *     itself: this method only runs from a scroll event, and mouseup is not
   *     one. Harmless, since anyone who lets go at the edge is about to scroll
   *     again, but do not go hunting for a trigger on mouseup — there isn't
   *     one, by design.
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
    // A half-drawn band, an open naming input or a rename in progress would be
    // torn out by the rebuild, exactly as the poll declines to do.
    if (this.draft !== null || this.editing) return

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
    this.pendingCycles = retirePendingCycles(this.pendingCycles, served)

    // Lay any un-echoed edge drag over the served card, and retire the override
    // the moment the daemon's copy agrees with it.
    const real: CycleCard[] = served.map((c) => {
      const edit = this.cycleEdits.get(c.id)
      const renamed = this.cycleNames.get(c.id)
      if (renamed !== undefined && renamed === c.name) this.cycleNames.delete(c.id)
      if (!edit && renamed === undefined) return c
      const next = {
        ...c,
        name: renamed ?? c.name,
        cycleStart: edit?.start ?? c.cycleStart,
        due: edit?.due ?? c.due,
      }
      if (edit && next.cycleStart === c.cycleStart && next.due === c.due) this.cycleEdits.delete(c.id)
      return next
    })

    const ghosts: CycleCard[] = this.pendingCycles.map((p) => ({
      id: p.id ?? `pending:${p.name}`,
      name: p.name,
      originId: boardOrigin(ctx.response),
      cycleStart: p.startDay,
      // A spoken era has no end yet: `cycleSpan` runs an open-ended cycle to
      // today, which is exactly what an era you have just entered looks like.
      due: p.endDay ?? undefined,
    }))
    const bands = buildCycleBands([...real, ...ghosts], days, dayIndex)
    // Only a cycle whose create is still IN FLIGHT is pending. Once the id has
    // come back the fiber exists, so the band takes its clicks even though the
    // feed has not come round yet.
    const unsaved = new Set(this.pendingCycles.filter((p) => p.id === undefined).map((p) => p.name))
    for (const band of bands) if (unsaved.has(band.name)) band.pending = true
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
      // Names the strip once, on the lane nearest the headers — and says, in
      // the same breath, that the strip is something you can write on. The
      // gesture is a drag, so there is nothing to click here; the `+` is a
      // legend for the lane beside it, not a button that would lie about it.
      if (lane === 0) {
        const tag = document.createElement('span')
        tag.className = 'chr-cycle-tag'
        tag.textContent = 'cycles'
        // The `+` used to be a legend for the drag gesture — a mark that could
        // not be clicked, on a page where the only way to make an era was to
        // draw one. It is a real button now: it opens the composer, where an
        // era is SPOKEN rather than measured. The two gestures answer different
        // questions. A drag says when; the composer says what.
        const plus = document.createElement('button')
        plus.type = 'button'
        plus.className = 'chr-cycle-plus'
        plus.textContent = '+'
        plus.title = ERA_SPEAK_HINT
        plus.setAttribute('aria-label', ERA_SPEAK_HINT)
        plus.addEventListener('click', (e) => {
          e.stopPropagation()
          this.openEraComposer(ctx)
        })
        gutter.append(tag, plus)
        gutter.title = ERA_HINT
      }
      out.push(gutter)

      const last = lane === laneCount - 1
      if (last) gutter.classList.add('chr-cycle-last')

      const track = document.createElement('div')
      track.className = `chr-cycle-lane${last ? ' chr-cycle-last' : ''}`
      track.style.gridColumn = `2 / span ${days.length}`
      track.style.gridRow = String(lane + 2)
      track.dataset.lane = String(lane)
      track.title = ERA_HINT
      this.installDrawToCreate(track, ctx)
      out.push(track)
    }

    // The invitation. It used to appear only on an EMPTY strip, which meant the
    // one gesture on this page that creates something was undiscoverable the
    // moment you had a single cycle — and a hint you only see before you have
    // ever used the feature is the wrong way round. So it now rides the LAST
    // lane always, right-aligned out of the bands' way, and fades in when the
    // cursor is over the strip. On an empty strip it is centered, because there
    // is nothing to keep clear of.
    const hint = document.createElement('div')
    hint.className = `chr-cycle-hint${bands.length === 0 ? ' chr-cycle-hint-empty' : ''}`
    hint.textContent = bands.length === 0 ? `· ${ERA_HINT} ·` : `· ${ERA_HINT}`
    out[(laneCount - 1) * 2 + 1]?.append(hint)

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
    title.title = 'Open this cycle’s fiber · double-click to rename'
    // Same two readings as the band: a click opens the document, a double-click
    // edits the one line of it that is on this page.
    // Opening the fiber is not idempotent the way entering an era is — it puts
    // a modal over the page — so this one has to tell a single click from half
    // of a double. The wait is the double-click window, and the lock covers the
    // stray click a closing editor can emit after it.
    let titleClick: number | null = null
    title.addEventListener('click', () => {
      if (titleClick !== null || this.editing || Date.now() < this.gestureLockUntil) return
      titleClick = window.setTimeout(() => {
        titleClick = null
        if (!this.editing && Date.now() >= this.gestureLockUntil) ctx.openCard(band.id)
      }, DOUBLE_CLICK_MS)
    })
    title.addEventListener('dblclick', (e) => {
      e.preventDefault()
      if (titleClick !== null) window.clearTimeout(titleClick)
      titleClick = null
      this.openBandRename(head, title, band, ctx, 'chr-face-rename')
    })
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

    // The intention, or the invitation to write one. A drawn era has no body —
    // the drag asks when, not what — and a face that simply omitted the line
    // read as a face that had failed to load. Saying the era is unwritten, and
    // where to write it, is the honest version of the same silence.
    const intent = this.intentions.get(band.id)
    if (intent) {
      const line = document.createElement('p')
      line.className = 'chr-face-intent'
      line.textContent = intent
      line.title = 'Double-click to write this era’s intention'
      line.addEventListener('dblclick', () => void this.openIntentionEditor(face, line, band, ctx))
      face.append(line)
    } else if (!band.pending) {
      const invite = document.createElement('button')
      invite.type = 'button'
      invite.className = 'chr-face-intent chr-face-intent-empty'
      invite.textContent = 'no intention written — click to say what this era is for'
      invite.title = 'Write this era’s intention'
      invite.addEventListener('click', () => void this.openIntentionEditor(face, invite, band, ctx))
      face.append(invite)
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
    // `toMs + 1` keeps the old inclusive right bound literally intact; the
    // shared fold's span is half-open.
    const spend = foldActiveMinutes(buckets, { fromMs, toMs: toMs + 1 })
    // Human presence is counted in MESSAGES, not minutes. Nobody remembers an
    // era as forty minutes of steering; they remember how many times they came
    // back to it. So the two sides of the ledger are measured differently on
    // purpose — the human in turns taken, the machine in wall-clock.
    let sent = 0
    let received = 0
    for (const b of buckets) {
      // Half-open, same convention as the fold two lines up.
      if (b.m < fromMs || b.m >= toMs + 1) continue
      if (b.k === 'attention') sent += b.n
      else if (b.k === 'reply') received += b.n
    }
    stat('you', sent === 0 && received === 0 ? '—' : messageClause(sent, received))
    stat('agents', formatSpanMinutes(spend.agent, { empty: '—' }))
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
          // The slug a commit was filed under is usually the fiber it was about,
          // so it opens that fiber — but only when the trail names exactly one.
          // A slug matching two fibers, or none, stays plain text: a link that
          // opens the wrong card is worse than a word you cannot click.
          const target = resolveNarrationSlug(group.slug, ctx.cards)
          const slug = document.createElement(target ? 'button' : 'span')
          slug.className = 'chr-face-slug'
          slug.textContent = group.slug
          if (target) {
            ;(slug as HTMLButtonElement).type = 'button'
            slug.classList.add('chr-face-open')
            slug.title = `Open ${target.name}`
            slug.addEventListener('click', () => ctx.openCard(target.id))
          }
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
          // A fiber the era closed is named here and nowhere else on the face —
          // so this is where you reach it. The whole name is the target; the
          // verdict mark stays a mark.
          const open = document.createElement('button')
          open.type = 'button'
          open.className = 'chr-face-open'
          open.textContent = card.name
          open.title = `Open ${card.name}`
          open.addEventListener('click', () => ctx.openCard(card.id))
          line.append(mark, document.createTextNode(' '), open)
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
      if (cell && (cell.agent > 0 || cell.attention > 0)) return true
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
  private async loadIntention(id: string, ctx: ViewContext): Promise<void> {
    if (this.intentions.has(id)) return
    this.intentions.set(id, '') // claim it, so a re-render does not re-ask
    try {
      const res = await fetch(`${fiberDocUrl(ctx.shuttleBase, id)}?body=1`)
      if (!res.ok) return
      const text = firstParagraph(fiberBodyOf(await res.json()))
      if (!text) return
      this.intentions.set(id, text)
      this.signature = ''
      if (this.ctx) void this.load(this.ctx)
    } catch {
      // No intention line is a fine outcome; the face stands without one.
    }
  }

  /**
   * Rename a band in place. The name becomes an input sitting exactly where it
   * was, so the gesture never moves the reader's eye — the same discipline the
   * naming-a-new-cycle input follows.
   */
  private openBandRename(
    host: HTMLElement,
    label: HTMLElement,
    band: CycleBand,
    ctx: ViewContext,
    className = 'chr-band-rename',
  ): void {
    if (host.querySelector('.chr-band-rename, .chr-face-rename')) return
    const input = document.createElement('input')
    input.type = 'text'
    input.className = className
    input.value = band.name
    label.style.visibility = 'hidden'
    host.append(input)
    this.editInPlace(input, {
      commit: (value) => void this.renameCycle(band, value, ctx),
      done: () => {
        input.remove()
        label.style.visibility = ''
      },
    })
  }

  /**
   * Write the era's intention from the face.
   *
   * The editor opens on the WHOLE body, read fresh, because felt's `--body` is
   * a destructive overwrite — see {@link writeIntention}. So the field may hold
   * more than the one paragraph the face displays, and that is the point: what
   * you send back is everything the fiber had.
   */
  private async openIntentionEditor(
    face: HTMLElement,
    line: HTMLElement,
    band: CycleBand,
    ctx: ViewContext,
  ): Promise<void> {
    if (face.querySelector('.chr-face-intent-edit')) return
    const field = document.createElement('textarea')
    field.className = 'chr-face-intent-edit'
    field.rows = 4
    field.placeholder = 'what this era is for — its goal, what drives it, what constrains it'
    // Claim the slot before the read, so a slow daemon cannot leave the reader
    // clicking a line that is already becoming an editor.
    line.replaceWith(field)
    this.editing = true
    try {
      field.value = await this.readBody(band.id, ctx)
    } catch {
      // An unreadable body would make the write a silent erasure. Put the line
      // back and say nothing was lost.
      this.editing = false
      field.replaceWith(line)
      window.console.error('[chronicle] could not read the cycle body to edit it')
      return
    }
    this.editing = false // editInPlace claims it for the edit proper
    this.editInPlace(field, {
      commit: (value) => {
        void this.writeIntention(band, value, ctx).catch((err: unknown) => {
          window.console.error('[chronicle] could not write the intention', err)
        })
      },
      done: () => field.replaceWith(line),
    })
  }

  /**
   * The one contract every in-place editor on this page keeps: Enter commits,
   * Escape abandons, blur commits what is there, and the page stands down from
   * rebuilding until it is over.
   *
   * That last part is not a nicety. A poll rebuilds the whole grid, and a
   * rebuild under an open editor tears the element out from under the hand
   * mid-word — the same hazard `this.draft` guards for the drag gestures.
   */
  private editInPlace(
    field: HTMLInputElement | HTMLTextAreaElement,
    { commit, done }: { commit: (value: string) => void; done: () => void },
  ): void {
    this.editing = true
    this.gestureLockUntil = Date.now() + DOUBLE_CLICK_MS
    field.focus()
    field.select()
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      this.editing = false
      this.gestureLockUntil = Date.now() + DOUBLE_CLICK_MS
      done()
      if (value !== null) commit(value)
      else if (this.ctx) void this.load(this.ctx)
    }
    // Typed by hand: `field` is a union of two element types, so the overload
    // resolution hands the listener a bare Event.
    field.addEventListener('keydown', (raw: Event) => {
      const e = raw as KeyboardEvent
      // Enter commits — except in a textarea, where it is a newline and the
      // commit is Cmd/Ctrl-Enter. Prose gets to have paragraphs.
      const enterCommits = field instanceof HTMLInputElement || e.metaKey || e.ctrlKey
      if (e.key === 'Enter' && enterCommits) {
        e.preventDefault()
        finish(field.value)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(null)
      }
      e.stopPropagation() // the board's own hotkeys must not eat the typing
    })
    field.addEventListener('blur', () => finish(field.value))
  }

  /**
   * Rename a cycle — the band's own name, written where it lives.
   *
   * The new name is held locally until a poll agrees with it, for the same
   * reason an edge drag is: the feed is polled, and a name that snapped back
   * to the old one for a poll interval would read as a rename that failed.
   *
   * `name` is felt-NATIVE, so it goes through `felt-edit`'s own `name` key —
   * `set` refuses native keys, which is why the daemon grew one.
   */
  private async renameCycle(band: CycleBand, next: string, ctx: ViewContext): Promise<void> {
    const name = next.trim()
    if (!name || name === band.name) return
    this.cycleNames.set(band.id, name)
    // A ghost is renamed in place too, or the retirement match (by name, for a
    // create still in flight) would look for a name nothing carries.
    for (const p of this.pendingCycles) if (p.id === band.id || p.name === band.name) p.name = name
    this.signature = ''
    if (this.ctx) void this.load(this.ctx)
    try {
      const res = await fetch(`${ctx.shuttleBase}/api/v1/felt-edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiber_id: band.id, origin: shuttleOrigin(band.originId), name }),
      })
      if (!res.ok) throw new Error(`felt-edit returned ${res.status}`)
      ctx.requestRefresh()
    } catch (err) {
      // Put the old name back rather than leave the strip claiming a rename the
      // store never took.
      this.cycleNames.delete(band.id)
      this.signature = ''
      if (this.ctx) void this.load(this.ctx)
      window.console.error('[chronicle] could not rename cycle', err)
    }
  }

  /**
   * Write an era's intention — the fiber's body, which is where the face reads
   * it from.
   *
   * felt's `--body` is a DESTRUCTIVE overwrite, so the editor opens on the
   * WHOLE body, freshly read, and sends the whole of it back. Editing only the
   * first paragraph (which is all the face displays) and writing that would
   * silently delete everything under it.
   */
  private async writeIntention(band: CycleBand, body: string, ctx: ViewContext): Promise<void> {
    const res = await fetch(`${ctx.shuttleBase}/api/v1/felt-edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fiber_id: band.id, origin: shuttleOrigin(band.originId), body }),
    })
    if (!res.ok) throw new Error(`felt-edit returned ${res.status}`)
    this.intentions.set(band.id, firstParagraph(body))
    this.signature = ''
    if (this.ctx) void this.load(this.ctx)
    ctx.requestRefresh()
  }

  /** The fiber's body as it stands right now — what the intention editor opens
   *  on, so a write can send back everything it did not change. */
  private async readBody(id: string, ctx: ViewContext): Promise<string> {
    const res = await fetch(`${fiberDocUrl(ctx.shuttleBase, id)}?body=1`)
    if (!res.ok) throw new Error(`fiber read returned ${res.status}`)
    return fiberBodyOf(await res.json()) ?? ''
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
    const origin = shuttleOrigin(band.originId)
    const res = await fetch(`${ctx.shuttleBase}/api/v1/felt-edit`, {
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
    el.title = band.pending
      ? `${band.name} — saving…`
      : `${band.name} — enter this era · double-click to rename`
    if (band.id === this.scopedCycleId) el.classList.add('chr-band-scoped')
    if (!band.pending) {
      // The band means "enter this era". Opening the fiber lives on the face's
      // own title, so the two readings of a cycle — the span and the document —
      // each have their own gesture instead of competing for one click.
      //
      // A click ENTERS the era; it does not toggle. That is what lets the same
      // band also carry a double-click rename: a double-click is two clicks,
      // and against a toggle the second one leaves the era it just entered —
      // which is exactly the defect this replaced, made worse by browsers that
      // emit a stray third click as the editor opens. Entering is idempotent,
      // so any number of clicks means the same thing. Leaving keeps its two
      // deliberate ways out, the face's ✕ and Escape.
      // Same defer as the face title: entering scopes the band away and
      // load() can replace this node before the second click of a
      // double-click lands, so the click must wait out the double-click
      // window before it commits — otherwise a rename attempt loses its
      // dblclick to a click #1 that already scoped in and reloaded.
      let bandClick: number | null = null
      el.addEventListener('click', () => {
        if (bandClick !== null || this.editing || this.scopedCycleId === band.id) return
        bandClick = window.setTimeout(() => {
          bandClick = null
          if (!this.editing && this.scopedCycleId !== band.id) this.scopeTo(band.id, ctx)
        }, DOUBLE_CLICK_MS)
      })
      el.addEventListener('dblclick', (e) => {
        e.preventDefault()
        if (bandClick !== null) window.clearTimeout(bandClick)
        bandClick = null
        this.openBandRename(el, label, band, ctx)
      })
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
   *
   * Like the draw gesture, this one closes over DOM that a rebuild replaces, so
   * `this.draft` stands down both the poll and the window extension for its
   * duration — see {@link installDrawToCreate} for why the civil-day anchors
   * are not enough on their own.
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
        // `originalDay`, not `origin` — this file now uses that word for the
        // daemon a write routes to, and one of them silently meaning "the day
        // the edge started on" is a trap for the next reader.
        const originalDay = edge === 'start' ? originStart : originEnd
        if (dropped !== originalDay) void this.writeCycleEdge(band, edge, dropped, ctx)
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
    band: CycleBand,
    edge: 'start' | 'due',
    day: string,
    ctx: ViewContext,
  ): Promise<void> {
    const id = band.id
    const previous = this.cycleEdits.get(id)
    this.cycleEdits.set(id, { ...previous, [edge]: day })
    this.signature = ''
    if (this.ctx) void this.load(this.ctx)

    // The CARD's origin, not the board's: a remote-owned cycle has to be
    // written where it lives, and same-host the two happen to agree.
    const origin = shuttleOrigin(band.originId)
    const payload =
      edge === 'start'
        ? { fiber_id: id, origin, set: { start: day } }
        : { fiber_id: id, origin, due: day }
    try {
      const res = await fetch(`${ctx.shuttleBase}/api/v1/felt-edit`, {
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
   *
   * A GESTURE CANNOT SURVIVE A REBUILD, and that is why `this.draft` is a
   * stand-down signal for everything that rebuilds — `load()` returns early on
   * it, and so does the window extension. The anchors are civil days, so the
   * ARITHMETIC would survive a prepend; the DOM would not. This handler closes
   * over its lane and its ghost, and `render()` replaces both, so a rebuild
   * mid-drag leaves the gesture measuring a detached rect and painting a ghost
   * nobody can see — right in the data, invisible on the page, which is worse
   * than either failure alone.
   *
   * The accepted consequence: auto-scroll pans within the window it started
   * with, and reaching the far edge stops rather than growing the record. The
   * window grows on the next scroll after release. Making the growth continuous
   * needs the ghost to outlive a rebuild, and there is no stable parent for it
   * — `render()` clears the whole page body — so it would have to hang off the
   * page root in viewport coordinates and track scrolling itself. Three moving
   * parts to convert a correct restriction into a fragile capability.
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
   * The era composer — the spoken half of making a cycle.
   *
   * A drag across the strip answers "when", and then asks for a name in one
   * line. This asks the other question first: WHAT this era is — its ontology,
   * its goal, what drives it, what constrains it — as a paragraph, dictated or
   * typed. The prose becomes the fiber's body, so the era face reads the
   * intention back in the words it was entered in; the opening clause becomes
   * the band's name (see {@link eraName}).
   *
   * The span it starts with is today, open-ended, because an era you are
   * entering has no end yet. The existing edge grips settle it later, so the
   * two gestures compose rather than duplicating each other.
   *
   * It is a sheet laid between the title and the grid, not a modal: the
   * chronicle it is about stays visible underneath, and dictating into a
   * textarea wants a large, plain target with nothing to dismiss by accident.
   */
  private openEraComposer(ctx: ViewContext): void {
    const root = this.root
    if (!root || !this.body) return
    const existing = root.querySelector('.chr-era-panel')
    if (existing) {
      ;(existing.querySelector('textarea') as HTMLTextAreaElement | null)?.focus()
      return
    }

    const panel = document.createElement('div')
    panel.className = 'chr-era-panel'

    const title = document.createElement('div')
    title.className = 'chr-era-title'
    title.textContent = 'a new era'

    const area = document.createElement('textarea')
    area.className = 'chr-era-text'
    area.rows = 4
    area.placeholder =
      'What is this era? Its ontology, its goal, what drives it, what constrains it.'

    const foot = document.createElement('div')
    foot.className = 'chr-era-foot'
    const note = document.createElement('span')
    note.className = 'chr-era-note'
    note.textContent = 'begins today · open-ended · drag its edges to settle the span'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'chr-era-cancel'
    cancel.textContent = 'abandon'
    const begin = document.createElement('button')
    begin.type = 'button'
    begin.className = 'chr-era-begin'
    begin.textContent = 'begin'
    foot.append(note, cancel, begin)

    panel.append(title, area, foot)
    // Between the page title and the grid, and OUTSIDE the body: the 15s poll
    // rebuilds the body wholesale, and a composer that vanished mid-sentence
    // because a refresh landed would lose the paragraph it exists to collect.
    root.insertBefore(panel, this.body)
    area.focus()

    let settled = false
    const finish = (prose: string | null): void => {
      if (settled) return
      settled = true
      panel.remove()
      if (prose === null) return
      const name = eraName(prose)
      if (!name) return
      void this.createCycle(name, isoDayLocal(Date.now()), null, ctx, prose)
    }
    cancel.addEventListener('click', () => finish(null))
    begin.addEventListener('click', () => finish(area.value.trim() || null))
    // Enter is a newline here — the point is a paragraph, and dictation puts
    // line breaks in it. Cmd/Ctrl+Enter commits, which is the capture form's
    // gesture, so the two captures on this board are learned once.
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        finish(area.value.trim() || null)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(null)
      }
      e.stopPropagation() // the board's hotkeys must not eat the dictation
    })
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
   *
   * `endDay` may be null: a spoken era is open-ended, and its span is settled
   * later with the same drag grips that reshape any other band. `prose` carries
   * the words an era was spoken in — the first paragraph of it is what the era
   * face reads back as the intention.
   */
  private async createCycle(
    name: string,
    startDay: string,
    endDay: string | null,
    ctx: ViewContext,
    prose = '',
  ): Promise<void> {
    const held: PendingCycle = { name, startDay, endDay }
    this.pendingCycles.push(held)
    if (this.ctx) {
      this.signature = '' // the pending band is not in the signature's inputs
      void this.load(this.ctx)
    }

    // No card exists yet, so this is the board's own scope rather than a
    // fiber's — the same resolution the capture forms use.
    const origin = boardOrigin(ctx.response)
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || `cycle-${Date.now()}`
    const id = `cycles/${slug}`

    try {
      const created = await fetch(`${ctx.shuttleBase}/api/v1/fiber/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          name,
          body: prose,
          frontmatter: {
            name,
            status: 'open',
            tags: ['cycle'],
            start: startDay,
            // Omitted, not null, when the era is open-ended: `due` absent is
            // how a cycle says "still running", and a null would be a date
            // field the daemon has to interpret.
            ...(endDay === null ? {} : { due: endDay }),
          },
          origin,
        }),
      })
      const body = (await created.json().catch(() => ({}))) as { id?: string; error?: string }
      if (!created.ok || !body.id) throw new Error(body.error || `create returned ${created.status}`)
      // The fiber exists now, so the band stops being a picture of a cycle and
      // becomes the cycle — clickable, enterable, its face readable — instead
      // of waiting inert for the feed to come round, which is a poll interval
      // of a band that does nothing when clicked.
      //
      // The id is the SLUG the create was given, and that is exactly right: the
      // board keys a fiber by its slug when it has one (`mapFeltJsonToFiber`
      // prefers `slug` over the ULID), so the ghost now carries the same id the
      // served card will. Adopting felt's ULID instead would look more precise
      // and be wrong — it matches no card, so entering the era would drop its
      // face the moment a poll landed.
      held.id = body.id
      this.signature = ''
      if (this.ctx) void this.load(this.ctx)
      ctx.requestRefresh()
    } catch (err) {
      // Drop the optimistic band rather than leave a cycle on screen that does
      // not exist on disk — a chronicle that shows work that never happened is
      // the one failure this page cannot afford.
      this.pendingCycles = this.pendingCycles.filter((p) => p !== held)
      this.signature = ''
      if (this.ctx) void this.load(this.ctx)
      window.console.error('[chronicle] could not create cycle', err)
    }
  }

  /**
   * Sticky top-left cell — the row-label column's own head. It carries two
   * things: the month you are currently looking at, and how many fibers are on
   * the page.
   *
   * The month is here rather than only at the boundary columns because a
   * boundary scrolls away and the question "which month am I in" does not. It
   * is the one word on this page that answers where you are.
   */
  private buildCorner(total: number): HTMLElement {
    const corner = document.createElement('div')
    corner.className = 'chr-corner'
    corner.style.gridColumn = '1'
    corner.style.gridRow = '1'
    const month = document.createElement('span')
    month.className = 'chr-corner-month'
    const count = document.createElement('span')
    count.className = 'chr-corner-count'
    count.textContent = `${total} ${total === 1 ? 'fiber' : 'fibers'}`
    corner.append(month, count)
    this.monthEl = month
    this.monthText = ''
    return corner
  }

  /**
   * Name the month at the left edge of the day area — the sticky bearing.
   *
   * The leftmost VISIBLE day, not the leftmost column: the gutter covers the
   * first stretch of the grid, so measuring from `scrollLeft` alone would name
   * a month the reader cannot see. Writes only when the word changes, because
   * this runs on every scroll event.
   */
  private bearMonth(): void {
    const scroller = this.scroller
    const el = this.monthEl
    if (!scroller || !el || this.currentDays.length === 0) return
    const dayW = this.dayWidthPx || 24
    const idx = clamp(
      Math.floor((scroller.scrollLeft + this.labelWidth(scroller)) / dayW),
      0,
      this.currentDays.length - 1,
    )
    const text = monthBearing(this.currentDays[idx].iso, new Date().getFullYear())
    if (text === this.monthText) return
    this.monthText = text
    el.textContent = text
  }

  /**
   * The key — a caption under the grid, in the margin, naming every mark the
   * page spends.
   *
   * The wording for the three activity pigments is {@link ACTIVITY_KEY_ITEMS},
   * verbatim, so a hue glossed here cannot come to mean something else on Day
   * or Week. The GLYPHS are Chronicle's own marks in miniature, which is the
   * rule the other two pages follow: a key teaches the marks you are actually
   * looking at, and Chronicle's segment is a day, not an hour.
   *
   * One entry is conditional: a page with no cycles should not explain bands —
   * a key for marks that are not on the page is the noise a key exists to
   * remove.
   */
  private buildKey(hasCycles: boolean): HTMLElement {
    const key = document.createElement('div')
    key.className = 'chr-key'

    const item = (glyph: HTMLElement, label: string): HTMLElement => {
      const el = document.createElement('span')
      el.className = 'chr-key-item'
      el.append(glyph, document.createTextNode(label))
      return el
    }
    const swatch = (cls: string): HTMLElement => {
      const el = document.createElement('span')
      el.className = cls
      return el
    }
    const glyph = (cls: string, text: string): HTMLElement => {
      const el = document.createElement('span')
      el.className = cls
      el.textContent = text
      return el
    }

    // Length first: it is the page's largest claim and the one nobody guesses.
    key.append(item(swatch('chr-key-life'), 'row spans first to last day'))
    // The pigments, in the shared words, with a density ramp that says
    // the steps are relative to the busiest day in view.
    const ramp = document.createElement('span')
    ramp.className = 'chr-key-ramp'
    for (const step of [1, 2, 3]) ramp.append(swatch(`chr-key-seg chr-key-seg-${step}`))
    for (const { kind, label } of ACTIVITY_KEY_ITEMS) {
      if (kind === 'agent') key.append(item(ramp, `${label} (busiest day in view sets the scale)`))
      else key.append(item(swatch(`chr-key-${kind}`), label))
    }
    // Hollow marks: what is owed, ahead of today. Nothing solid is drawn there.
    key.append(item(glyph('chr-key-glyph chr-key-due', MARK_GLYPH.due), 'due'))
    key.append(item(glyph('chr-key-glyph chr-key-launch', MARK_GLYPH.launch), 'next launch'))
    key.append(item(glyph('chr-key-glyph chr-key-end', '✓'), 'tempered · ✗ composted'))
    if (hasCycles) key.append(item(swatch('chr-key-band'), 'an era — click to read it'))
    return key
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
      // The first of a month takes the month's name in place of its weekday.
      // The weekday is recoverable from the column beside it; the month is not
      // recoverable from anything on the page, which is the whole complaint.
      const monthStart = isMonthStart(day.iso)
      if (monthStart) classes.push('chr-head-monthstart')
      cell.className = classes.join(' ')
      cell.style.gridColumn = String(i + 2)
      cell.style.gridRow = '1'
      cell.dataset.dayIso = day.iso

      const dow = document.createElement('span')
      dow.className = `chr-head-dow${monthStart && !day.isToday ? ' chr-head-month' : ''}`
      dow.textContent = day.isToday
        ? 'today'
        : monthStart
          ? monthName(day.iso, 'short')
          : day.weekdayLabel
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
      // A month opens with a rule the full height of the page — the bearing you
      // cross rather than the one you read.
      if (isMonthStart(day.iso)) classes.push('chr-wash-month')
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

    // A row whose only origin is out of contact is showing last-known-good. The
    // register is the Desk's — dimmed, with the ⌛ badge — but the classes are
    // the chronicle's own: a card's stale styling is a border and a ground, and
    // a one-line row has neither. See the note in ChronicleView.css.
    const waiting = row.waitingOn !== null

    const label = document.createElement('div')
    label.className = `chr-label${row.live ? ' chr-label-live' : ''}${waiting ? ' chr-label-waiting' : ''}`
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
    // The note's slot already names the owning host, so the waiting badge
    // replaces it rather than repeating it beside itself.
    note.className = row.waitingOn === null ? 'chr-note' : 'chr-note kbn-card-waiting'
    note.textContent = row.waitingOn === null ? row.note : `⌛ waiting on ${row.waitingOn}`
    if (row.waitingOn !== null) note.setAttribute('role', 'status')

    const span = document.createElement('span')
    span.className = 'chr-span'
    const spanDays = row.endIdx - row.startIdx + 1
    span.textContent = `${spanDays}d`
    span.title = `${spanDays} day${spanDays === 1 ? '' : 's'} on the chronicle`

    label.append(name, note, span)

    const track = document.createElement('div')
    track.className = `chr-track${waiting ? ' chr-track-waiting' : ''}`
    track.style.gridColumn = `2 / span ${days.length}`
    track.style.gridRow = gridRow

    const life = document.createElement('div')
    life.className = 'chr-life'
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
      // Steering is placed at the hour it happened, not at the column's
      // midpoint: one tick per spell, at its own time of day.
      for (const frac of spellPositions(cell.attentionAt, cell.attention)) {
        const tick = document.createElement('div')
        tick.className = 'chr-att'
        tick.style.left = colLeftAt(idx, frac)
        track.append(tick)
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
      due.textContent = MARK_GLYPH.due
      due.title = 'due'
      track.append(due)
    }
    if (row.launchIdx !== null) {
      const launch = document.createElement('div')
      launch.className = 'chr-mark chr-launch'
      launch.style.left = colLeft(row.launchIdx)
      launch.textContent = MARK_GLYPH.launch
      launch.title = 'next launch'
      track.append(launch)
    }

    // The gutter and the days are two grid children; the row they belong to is
    // only in the reader's head. Pointing at either one lights both, which is
    // what makes a name at the left edge and a mark 900px away readable as one
    // fact. Pure CSS cannot do it — grid siblings have no selector between
    // them — so the hover is linked here, in two lines.
    const hot = (on: boolean): void => {
      label.classList.toggle('chr-label-hot', on)
      track.classList.toggle('chr-track-hot', on)
    }
    for (const el of [label, track]) {
      el.addEventListener('mouseenter', () => hot(true))
      el.addEventListener('mouseleave', () => hot(false))
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
