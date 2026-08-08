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

import { registerView, type TemporalView, type ViewContext } from './ViewRegistry.js'
import { createViewEmptyState, createViewPage } from './ViewPage.js'
import type { ActivityBucket } from './TemporalData.js'
import type { KanbanCard, KanbanResponse } from '../KanbanTypes.js'
import { buildTimelineDays, type TimelineDay } from '../KanbanSurfaces.js'
import { civilDayToLocalDate, dueCivilDay, instantMs, isoDayLocal } from '../civilDay.js'
import './ChronicleView.css'

// ── Window ───────────────────────────────────────────────────────────────────

const PAST_DAYS = 28
const FUTURE_DAYS = 14
/** Rows drawn before the "+N more" expander takes over. */
const MAX_ROWS = 40
/** Where today sits in the viewport on the first render, as a fraction of the
 *  visible width. Matches the window's own 28/14 balance. */
const TODAY_ANCHOR = 0.65
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

/** Last path segment of a working directory, lower-cased. */
export function cwdTail(cwd: string | null | undefined): string | null {
  if (typeof cwd !== 'string') return null
  const parts = cwd.split('/').filter(Boolean)
  const tail = parts[parts.length - 1]
  return tail ? tail.toLowerCase() : null
}

/**
 * A working directory as a row label: a home prefix folds to `~`, and anything
 * else keeps its last three segments. There is no `$HOME` in a browser, so the
 * home shapes are matched structurally (`/home/<user>/…`, `/Users/<user>/…`).
 */
export function abbreviateCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  if (parts.length >= 2 && (parts[0] === 'home' || parts[0] === 'Users')) {
    return `~/${parts.slice(2).join('/')}` || '~'
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
 *   4. `cwd`'s tail segment names exactly one card's path segment.
 *   5. otherwise the bucket belongs to its `cwd`, as human work.
 *
 * Rungs 3 and 4 require a UNIQUE match. A token matching several cards is a
 * project directory, not a fiber — `~/loom` names every fiber under the loom —
 * so ambiguity deliberately falls through to the cwd rung rather than picking
 * an arbitrary winner.
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
    const cardId =
      (bucket.s ? byWorker.get(bucket.s) : undefined) ??
      byUlid.get(sessionUlid(bucket.s) ?? ' ') ??
      (bySlug.get(sessionSlug(bucket.s) ?? ' ') || undefined) ??
      (bySlug.get(cwdTail(bucket.cwd) ?? ' ') || undefined)
    if (cardId) {
      push(byCard, cardId, bucket)
      continue
    }
    if (bucket.cwd) push(byCwd, bucket.cwd, bucket)
    else dropped += 1
  }

  return { byCard, byCwd, dropped }
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

function buildFiberRow(
  card: KanbanCard,
  buckets: readonly ActivityBucket[],
  response: KanbanResponse,
  dayIndex: Map<string, number>,
  todayIdx: number,
): ChronicleRow {
  const days = aggregateByCivilDay(buckets)

  // The solid line spans birth → close (or today), then stretches to cover any
  // activity that landed outside that range — a fiber created before the window
  // opened still shows the work it did inside it.
  let startIdx = idxOfInstant(card.createdAt, dayIndex) ?? 0
  const closed = Boolean(card.closedAt) || card.status === 'closed'
  let endIdx = closed ? (idxOfInstant(card.closedAt, dayIndex) ?? todayIdx) : todayIdx
  for (const day of days.keys()) {
    const idx = dayIndex.get(day)
    if (idx === undefined) continue
    if (idx < startIdx) startIdx = idx
    if (idx > endIdx) endIdx = idx
  }
  startIdx = clamp(startIdx, 0, todayIdx)
  endIdx = clamp(Math.max(endIdx, startIdx), 0, todayIdx)

  let sortMs = Math.max(
    instantMs(card.modifiedAt) ?? 0,
    instantMs(card.closedAt) ?? 0,
    instantMs(card.createdAt) ?? 0,
    card.lastActivityAt ?? 0,
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
    fibers.push(buildFiberRow(card, attribution.byCard.get(id) ?? [], response, dayIndex, todayIdx))
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

  mount(host: HTMLElement, ctx: ViewContext): void {
    const page = createViewPage(this.title)
    this.root = page.root
    this.body = page.body
    this.ctx = ctx
    this.signature = ''
    this.didAnchor = false
    host.append(page.root)
    void this.load(ctx)
  }

  refresh(ctx: ViewContext): void {
    this.ctx = ctx
    void this.load(ctx)
  }

  unmount(): void {
    this.generation += 1
    this.root?.remove()
    this.root = null
    this.body = null
    this.scroller = null
    this.ctx = null
    this.signature = ''
    this.didAnchor = false
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

    const signature = this.signatureOf(days, activity.buckets, ctx.cards)
    if (signature === this.signature) return
    this.signature = signature
    this.render(ctx, days, activity.buckets)
  }

  /**
   * A cheap fingerprint of everything the render reads. Cards contribute the
   * fields that move a mark; buckets contribute their count and newest stamp,
   * which is enough — the daemon only ever appends to a window.
   */
  private signatureOf(
    days: TimelineDay[],
    buckets: readonly ActivityBucket[],
    cards: readonly KanbanCard[],
  ): string {
    let latest = 0
    for (const b of buckets) if (b.m > latest) latest = b.m
    const parts = [days[0].iso, String(buckets.length), String(latest), this.expanded ? 'x' : 'c']
    for (const c of cards) {
      parts.push(
        `${c.id}|${c.status}|${c.closedAt ?? ''}|${c.modifiedAt ?? ''}|${c.due ?? ''}|${c.nextLaunchAt ?? ''}|${c.runningWorker ?? ''}`,
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
    grid.append(this.buildCorner(fiberCount), ...this.buildHead(days))
    grid.append(...this.buildWashes(days, shown.length + (hidden > 0 ? 1 : 0)))
    for (let r = 0; r < shown.length; r += 1) {
      grid.append(...this.buildRow(shown[r], r, days, dayIndex, peak, ctx))
    }
    if (hidden > 0) grid.append(this.buildExpander(hidden, shown.length))

    scroller.append(grid)
    body.append(scroller)
    this.scroller = scroller

    if (this.didAnchor) {
      scroller.scrollLeft = scrollLeft
      scroller.scrollTop = scrollTop
    } else {
      this.anchorToday(scroller, todayIdx < 0 ? lastIdx : todayIdx)
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

  private buildHead(days: TimelineDay[]): HTMLElement[] {
    return days.map((day, i) => {
      const cell = document.createElement('div')
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

    if (row.closed) {
      const end = document.createElement('div')
      end.className = `chr-mark chr-end${row.closedOk ? '' : ' chr-end-compost'}`
      end.style.left = colLeft(row.endIdx)
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

  /** Put today at {@link TODAY_ANCHOR} of the visible width, once. Later
   *  renders restore whatever the reader had scrolled to instead. */
  private anchorToday(scroller: HTMLElement, todayIdx: number): void {
    requestAnimationFrame(() => {
      if (this.scroller !== scroller) return
      const styles = getComputedStyle(scroller)
      const dayW = parseFloat(styles.getPropertyValue('--chr-day-w')) || 24
      const labelW = parseFloat(styles.getPropertyValue('--chr-label-w')) || 240
      const center = labelW + (todayIdx + 0.5) * dayW
      scroller.scrollLeft = Math.max(0, center - scroller.clientWidth * TODAY_ANCHOR)
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
