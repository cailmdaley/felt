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
import type { ActivityBucket } from './TemporalData.js'
import type { KanbanCard, KanbanResponse } from '../KanbanTypes.js'
import { buildTimelineDays, type TimelineDay } from '../KanbanSurfaces.js'
import { civilDayToLocalDate, dueCivilDay, instantMs, isoDayLocal } from '../civilDay.js'
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
/**
 * `nowMs` is rounded UP to this, so the argument tuple handed to
 * `ctx.activity` is stable between polls. TemporalData keys its TTL cache on
 * that tuple; a raw `Date.now()` would mint a fresh key every 15s poll and turn
 * a cheap cache into a request-per-poll.
 */
const ACTIVITY_QUANTUM_MS = 5 * 60_000

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

  const byCard = new Map<string, ActivityBucket[]>()
  const byCwd = new Map<string, ActivityBucket[]>()
  let dropped = 0

  const push = (map: Map<string, ActivityBucket[]>, key: string, b: ActivityBucket): void => {
    const list = map.get(key)
    if (list) list.push(b)
    else map.set(key, [b])
  }

  for (const bucket of buckets) {
    const cardId = resolveCard(bucket, byWorker, byUlid, bySlug)
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
): string | undefined {
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
    const day = isoDayLocal(b.m)
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

  mount(host: HTMLElement, ctx: ViewContext): void {
    const page = createViewPage(this.title)
    this.root = page.root
    this.body = page.body
    this.ctx = ctx
    this.signature = ''
    this.didAnchor = false
    this.dayWidthPx = 0
    host.append(page.root)

    // Refit the columns when the board changes width. Only the CSS variable
    // moves; every mark's position is a calc() over it, so the whole chronicle
    // rescales without a rebuild.
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
    const now = new Date()
    const days = buildTimelineDays(PAST_DAYS, FUTURE_DAYS, now)
    const windowStart = civilDayToLocalDate(days[0].iso)?.getTime() ?? now.getTime()
    const toMs = Math.ceil(now.getTime() / ACTIVITY_QUANTUM_MS) * ACTIVITY_QUANTUM_MS

    const activity = await ctx.activity(windowStart, toMs)
    if (generation !== this.generation || !this.body) return

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

    const dayIndex = new Map(days.map((d, i) => [d.iso, i]))
    const todayIdx = days.findIndex((d) => d.isToday)
    const lastIdx = days.length - 1
    const attribution = attributeActivity(buckets, ctx.cards)
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

    const scroller = document.createElement('div')
    scroller.className = 'chr-scroll'

    const grid = document.createElement('div')
    grid.className = 'chr-grid'
    grid.style.gridTemplateColumns = `var(--chr-label-w) repeat(${days.length}, var(--chr-day-w))`
    grid.style.gridTemplateRows = `var(--chr-head-h) repeat(${shown.length + (hidden > 0 ? 1 : 0)}, var(--chr-row-h))`

    const fiberCount = rows.reduce((n, row) => (row.kind === 'fiber' ? n + 1 : n), 0)
    grid.append(this.buildCorner(fiberCount), ...this.buildHead(days, ctx))
    grid.append(...this.buildWashes(days, shown.length + (hidden > 0 ? 1 : 0)))
    for (let r = 0; r < shown.length; r += 1) {
      grid.append(...this.buildRow(shown[r], r, days, dayIndex, peak, ctx))
    }
    if (hidden > 0) grid.append(this.buildExpander(hidden, shown.length))

    scroller.append(grid)
    body.append(scroller)
    this.scroller = scroller
    this.fitDayWidth()

    // The cursor decides where the page opens. Null means today — re-resolved
    // against the clock every render, never frozen at the day we first saw. A
    // cursor pointing outside the window falls back to today rather than
    // scrolling to an edge that means nothing.
    const focus = normalizeFocusDate(ctx.focusDate)
    const focusIdx = focus === null ? null : (dayIndex.get(focus) ?? null)
    const anchorIdx = focusIdx ?? (todayIdx < 0 ? lastIdx : todayIdx)
    const focusMoved = focus !== this.anchoredOn

    if (this.didAnchor && !focusMoved) {
      scroller.scrollLeft = scrollLeft
      scroller.scrollTop = scrollTop
    } else {
      scroller.scrollTop = scrollTop
      this.anchorDay(scroller, anchorIdx)
    }
    this.anchoredOn = focus
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
  private anchorDay(scroller: HTMLElement, idx: number): void {
    requestAnimationFrame(() => {
      if (this.scroller !== scroller) return
      const styles = getComputedStyle(scroller)
      const dayW = parseFloat(styles.getPropertyValue('--chr-day-w')) || 24
      const labelW = this.labelWidth(scroller)
      const center = labelW + (idx + 0.5) * dayW
      const restingX = labelW + (scroller.clientWidth - labelW) * TODAY_ANCHOR
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
