/**
 * DayView (hotkey 3) — one day, close up.
 *
 * TWO CLOCKS, ONE LANE. The page is a 24-hour rail per fiber, read left to
 * right, carrying both of the day's clocks at once:
 *
 *   pale cobalt wash   the agent was working (merged runs of agent minutes)
 *   solid teal block   you were steering (attention minutes — a typed prompt)
 *   cinnabar tick      the agent raised its hand (a notification)
 *
 * Below the rails, the same day told the other way: "the day, by fiber" —
 * the commit trail, grouped by its own `<slug>: ` prefixes, set as prose.
 * One reading is what the machine did; the other is what the work says it
 * did. They rarely agree, and the disagreement is the interesting part.
 *
 * THE DAY IS HUMAN-SHAPED. A civil day here runs 06:00 → 06:00, not midnight
 * to midnight: work done at 01:00 belongs to the evening it grew from, not to
 * the morning that happens to share its date. The same rule picks the default
 * day on mount — before 06:00 local, "today" is still yesterday.
 *
 * DST-honest. The window is 06:00 local of the day to 06:00 local of the NEXT
 * day, so it is 23 or 25 hours twice a year and every position is a fraction
 * of the real span. Never hard-code 1440.
 *
 * WHICH DAY comes from the board's shared temporal cursor (`ctx.focusDate`),
 * not from anything this view remembers. The chevrons and the arrow keys write
 * to the cursor and stop; the refresh that write triggers is what redraws the
 * page. So paging here and pressing `4` opens Week around the same day, and
 * the two views can never drift apart.
 *
 * The join from a bucket to a fiber is the tmux session name: a Shuttle worker
 * runs in `<slug>-<ULID>-shuttle`, and that ULID is the fiber's `uid`. A bucket
 * with no session, or one whose ULID matches no card on the board, is
 * interactive work — grouped by working directory into its own muted lanes
 * below the fiber lanes, because it happened and the day should say so.
 */

import { civilDayToLocalDate, instantMs, isoDayLocal, railCivilDay } from '../civilDay.js'
import type { KanbanCard } from '../KanbanTypes.js'
import type { ActivityBucket, ActivityResult, NarrationCommit } from './TemporalData.js'
import { createViewEmptyState, createViewPage } from './ViewPage.js'
import {
  normalizeFocusDate,
  registerView,
  type TemporalView,
  type ViewContext,
} from './ViewRegistry.js'
import './DayView.css'

// ── Shape of a day ───────────────────────────────────────────────────────────

/** Where a civil day starts and ends, for this view. */
const DAY_START_HOUR = 6
const MINUTE_MS = 60_000
/** Inactive minutes a wash/block span reaches across before it breaks. Five
 *  quiet minutes inside a work run is a pause, not an end. */
const BRIDGE_MINUTES = 5
/** Tick spacing on the rail: 6am 10am 2pm 6pm 10pm 2am 6am. */
const TICK_HOURS = 4

/**
 * The civil day the view opens on: today, unless local now is before 06:00,
 * in which case yesterday — the day this small-hours work grew out of.
 *
 * Delegates to civilDay's `railCivilDay`, which is the ONE definition of the
 * dawn-boundary rule; Week classifies its rows with the same call. Two copies
 * of this rule drifting apart is exactly the defect it exists to prevent.
 */
export function defaultDayISO(nowMs: number): string {
  return railCivilDay(nowMs, DAY_START_HOUR)
}

/** A civil day, `delta` days later (negative for earlier). */
export function shiftCivilDay(dayISO: string, delta: number): string {
  const d = civilDayToLocalDate(dayISO)
  if (!d) return dayISO
  d.setDate(d.getDate() + delta)
  return isoDayLocal(d.getTime())
}

/**
 * The day the page shows: the shared cursor when it holds one, else the
 * 06:00-aware default. The cursor is the authority — this view keeps no day
 * state of its own, so Day and Week never disagree about where "here" is.
 *
 * A null cursor is the LIVE present, not a snapshot: it re-resolves against
 * the clock on every call, so a board left open overnight rolls to the new
 * day at 06:00 instead of freezing on the day it mounted.
 */
export function resolveDayISO(focusDate: string | null | undefined, nowMs: number): string {
  return normalizeFocusDate(focusDate ?? null) ?? defaultDayISO(nowMs)
}

/**
 * What a chevron or arrow key writes back to the cursor.
 *
 * Stepping ONTO today hands the cursor back to null — the live present —
 * rather than pinning it to a date that would go stale at 06:00 tomorrow.
 * Every other day is written explicitly.
 */
export function stepTarget(fromDayISO: string, delta: number, nowMs: number): string | null {
  const next = shiftCivilDay(fromDayISO, delta)
  return next === defaultDayISO(nowMs) ? null : next
}

export interface DayWindow {
  /** 06:00 local of the civil day. */
  startMs: number
  /** 06:00 local of the following civil day — 23, 24 or 25 hours later. */
  endMs: number
  /** Length of the window in whole minutes. */
  minutes: number
}

/** The 06:00→06:00 window a civil day names, in the viewer's zone. */
export function dayWindow(dayISO: string): DayWindow {
  const base = civilDayToLocalDate(dayISO) ?? new Date()
  const y = base.getFullYear()
  const m = base.getMonth()
  const d = base.getDate()
  const startMs = new Date(y, m, d, DAY_START_HOUR).getTime()
  const endMs = new Date(y, m, d + 1, DAY_START_HOUR).getTime()
  return { startMs, endMs, minutes: Math.round((endMs - startMs) / MINUTE_MS) }
}

/** A run of rail minutes; `end` is exclusive, so a single minute is `n..n+1`. */
export interface MinuteRun {
  start: number
  end: number
}

/**
 * Collapse active minute indices into runs, reaching across gaps of at most
 * `bridge` inactive minutes. Adjacent minutes always merge (gap 0).
 */
export function mergeMinuteRuns(minutes: Iterable<number>, bridge = BRIDGE_MINUTES): MinuteRun[] {
  const sorted = [...new Set(minutes)].sort((a, b) => a - b)
  const runs: MinuteRun[] = []
  for (const minute of sorted) {
    const last = runs[runs.length - 1]
    // `last.end` is exclusive, so `minute - last.end` IS the inactive gap.
    if (last && minute - last.end <= bridge) {
      last.end = minute + 1
      continue
    }
    runs.push({ start: minute, end: minute + 1 })
  }
  return runs
}

/** `2h 05m`, or `47m` under the hour — the mono head line's unit. */
export function formatSpanHM(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

/**
 * A Crockford-base32 ULID embedded in a longer name. Shuttle's tmux sessions
 * are `<slug>-<ULID>-shuttle`, and the ULID is the one token in a session name
 * that identifies a fiber exactly.
 *
 * Case-INSENSITIVE and not anchored to the `-shuttle` suffix, deliberately.
 * An uppercase-only, suffix-anchored pattern misses a lowercased session name
 * and every session the dispatcher builds in another shape. Since `cwd` joins
 * nothing, the session name is the ONLY route from a bucket to a fiber: a miss
 * here does not merely mislabel the work, it costs the fiber its lane.
 */
const ULID_RE = /(?:^|[^0-9a-hjkmnp-tv-z])([0-7][0-9a-hjkmnp-tv-z]{25})(?![0-9a-hjkmnp-tv-z])/i

/** The fiber ULID a session name carries, upper-cased, or null. */
export function tmuxFiberUlid(session: string | null | undefined): string | null {
  if (typeof session !== 'string' || !session) return null
  return ULID_RE.exec(session)?.[1]?.toUpperCase() ?? null
}

/**
 * The human-readable half of a session name: the `-shuttle` suffix and the
 * ULID stripped. `bmodes-2d-01K…-shuttle` → `bmodes-2d`, and the legacy
 * leaf-only `morning-post-shuttle` → `morning-post`. The weaker join key —
 * a slug is a fiber's leaf name, not its identity — so it is consulted only
 * after the ULID misses, and only when it resolves to exactly one card.
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
 * The name of a lane for work that joined to no fiber.
 *
 * The suffix is a factual claim about who was at the keyboard, so it follows
 * the evidence: a bucket carrying a session id was a WORKER whose fiber we
 * could not identify (`unmatched`), while a bucket with no session at all was
 * someone typing (`interactive`). Calling an unmatched worker "interactive"
 * puts an agent's hours on a human's ledger.
 */
const HOME_RE = /^\/(?:home|Users)\/[^/]+(?=\/|$)/
export function cwdLaneLabel(cwd: string | null | undefined, fromWorker = false): string {
  const suffix = fromWorker ? 'unmatched' : 'interactive'
  if (!cwd) return `elsewhere · ${suffix}`
  return `${cwd.replace(HOME_RE, '~') || '/'} · ${suffix}`
}

// ── Narration ────────────────────────────────────────────────────────────────

/**
 * The civil days to ASK narration for, to cover a 06:00→06:00 rail.
 *
 * The two read routes do not speak the same language. `/activity` takes
 * instants, so it gets the rail exactly. `/narration` takes INCLUSIVE CIVIL
 * DAYS, midnight to midnight — so asking it for `(day, day)` returns
 * 00:00–06:00 of the day (which belongs to YESTERDAY's rail) and misses
 * 00:00–06:00 of the next day (which belongs to THIS one). On a store whose
 * author works past midnight that is not an edge case: those commits are the
 * end of the session the rail is drawing, and they would land a page early
 * while the fiber that made them got an outcome fallback saying it "worked,
 * wrote nothing down".
 *
 * So: widen by a day and discard by the rail's real edges
 * ({@link commitsOnRail}) — the same widen-then-discard WeekView uses.
 */
export function narrationRange(dayISO: string): { from: string; to: string } {
  return { from: dayISO, to: shiftCivilDay(dayISO, 1) }
}

/** The commits that actually fall inside the rail, by instant. Both the early
 *  and the late overhang of {@link narrationRange} are dropped here. */
export function commitsOnRail(commits: NarrationCommit[], win: DayWindow): NarrationCommit[] {
  return commits.filter((commit) => {
    const at = instantMs(commit.iso)
    return at !== undefined && at >= win.startMs && at < win.endMs
  })
}

/** `slug: what happened` — felt's commit convention. The slug is the bold
 *  token in the prose section; the remainder is the sentence. */
const SLUG_RE = /^([A-Za-z0-9][A-Za-z0-9._/-]*):[ \t]+(\S.*)$/

export interface SlugGroup {
  /** The commit prefix, or null for the commits that carried none. */
  slug: string | null
  /** Subjects with the `slug: ` prefix removed, verbatim otherwise. */
  subjects: string[]
}

/**
 * Group commit subjects by their leading `<slug>: ` prefix, keeping
 * first-appearance order. Commits with no prefix collect into a single
 * trailing group with a null slug.
 */
export function groupCommitsBySlug(commits: NarrationCommit[]): SlugGroup[] {
  const order: string[] = []
  const bySlug = new Map<string, string[]>()
  const loose: string[] = []
  for (const commit of commits) {
    const subject = commit.subject.trim()
    if (!subject) continue
    const match = SLUG_RE.exec(subject)
    if (!match) {
      loose.push(subject)
      continue
    }
    const slug = match[1]
    let bucket = bySlug.get(slug)
    if (!bucket) {
      bucket = []
      bySlug.set(slug, bucket)
      order.push(slug)
    }
    bucket.push(match[2].trim())
  }
  const groups: SlugGroup[] = order.map((slug) => ({ slug, subjects: bySlug.get(slug) ?? [] }))
  if (loose.length > 0) groups.push({ slug: null, subjects: loose })
  return groups
}

/** The first sentence of an outcome — the fallback line for a fiber that
 *  worked today but committed nothing. */
export function firstSentence(text: string | undefined): string {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return ''
  const match = /^(.+?[.!?])(?:\s|$)/.exec(trimmed)
  return (match ? match[1] : trimmed).trim()
}

// ── The day, assembled ───────────────────────────────────────────────────────

export interface DayLane {
  key: string
  kind: 'fiber' | 'loose'
  /** Fiber name, or the cwd-derived interactive label. */
  label: string
  /** Host the work ran on, rendered as tiny lowercase mono. */
  host: string
  /** Board card id, when the lane joined to one — the click target. */
  cardId?: string
  /** Slugs this lane answers to when matching commit prefixes. */
  slugs: string[]
  agent: MinuteRun[]
  attention: MinuteRun[]
  /** Minute indices where the agent asked for a human. */
  notify: number[]
  /** Distinct active minutes, of any kind — the lane's weight. */
  weight: number
}

export interface DayTotals {
  /** Minutes containing at least one attention bucket, over the whole day. */
  attention: number
  /** Minutes containing at least one agent bucket, over the whole day. */
  agent: number
}

/** Minutes the whole day was attended / worked, counted once per minute
 *  however many lanes were live in it. */
export function dayTotals(activity: ActivityResult, win: DayWindow): DayTotals {
  const attention = new Set<number>()
  const agent = new Set<number>()
  for (const bucket of activity.buckets) {
    const index = minuteIndex(bucket.m, win)
    if (index === null) continue
    if (bucket.k === 'attention') attention.add(index)
    else if (bucket.k === 'agent') agent.add(index)
  }
  return { attention: attention.size, agent: agent.size }
}

function minuteIndex(ms: number, win: DayWindow): number | null {
  const index = Math.floor((ms - win.startMs) / MINUTE_MS)
  if (index < 0 || index >= win.minutes) return null
  return index
}

/**
 * The slugs a fiber answers to WHEN MATCHING A COMMIT PREFIX: the leaf of its
 * id and of its project slug, and nothing else.
 *
 * Deliberately narrower than {@link cardPathSegments}, which the activity join
 * uses. A `felt: …` commit prefix names the fiber whose leaf is `felt`, not
 * every fiber that happens to live under `felt/` — widening this would make
 * one parent directory swallow the narration of everything beneath it.
 */
export function commitSlugsForCard(card: KanbanCard): string[] {
  const out = new Set<string>()
  for (const source of [card.id, card.projectSlug]) {
    const tail = source?.split('/').filter(Boolean).pop()
    if (tail) out.add(tail.toLowerCase())
  }
  return [...out]
}

/** Every ULID a card can be recognized by — its own `uid`, plus any embedded
 *  in the ids and session names it carries. */
function cardUlids(card: KanbanCard): string[] {
  const out = new Set<string>()
  const push = (value: string | null | undefined): void => {
    const trimmed = typeof value === 'string' ? value.trim().toUpperCase() : ''
    if (/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(trimmed)) out.add(trimmed)
    const embedded = tmuxFiberUlid(value)
    if (embedded) out.add(embedded)
  }
  push(card.uid)
  push(card.id)
  push(card.shuttleFiberId)
  push(card.runningWorker)
  return [...out]
}

/** Path segments a card can be recognized by when no ULID is available. Short
 *  segments are dropped — a two-letter directory name is not evidence. */
function cardPathSegments(card: KanbanCard): string[] {
  const out = new Set<string>()
  for (const segment of [...card.id.split('/'), ...(card.projectSlug ?? '').split('/')]) {
    const s = segment.trim().toLowerCase()
    if (s.length >= 3) out.add(s)
  }
  return [...out]
}

/**
 * Which fiber a bucket belongs to, strongest evidence first:
 *
 *   1. `s` is exactly a live worker's tmux name.
 *   2. `s` embeds a fiber ULID a card claims. Exact identity.
 *   3. `s`'s slug half names exactly one card's path segment — the name the
 *      dispatcher built the session from, including the legacy leaf-only form.
 *   4. nothing: the bucket belongs to its working directory.
 *
 * ATTRIBUTION BY DECLARED IDENTITY ONLY. Every rung above reads `s`, the
 * session — something the dispatcher WROTE about which fiber this worker is
 * realizing. `cwd` deliberately joins nothing. A directory names a project,
 * never a fiber: a repo root routinely shares its name with exactly one fiber
 * nested inside it, so `~/dev/felt` would resolve to whichever single card
 * happens to carry a `felt` segment, and an afternoon's work would be filed
 * under a fiber it may have nothing to do with. That holds whether or not the
 * bucket has a session — an unresolvable session is not made resolvable by the
 * folder it ran in — so there is no case left where a directory should name a
 * fiber. Unjoined work still appears, on a cwd lane that says exactly what is
 * known: which directory, and whether a worker or a human. Same ladder
 * ChronicleView runs; kept as its own copy rather than imported, since one view
 * importing another's internals is a coupling neither owner asked for.
 *
 * Rung 3 demands a UNIQUE match. A token several cards answer to is a project
 * directory, not a fiber, so ambiguity falls through rather than picking an
 * arbitrary winner.
 */
interface JoinIndex {
  byWorker: Map<string, KanbanCard>
  byUlid: Map<string, KanbanCard>
  /** null marks a token claimed by more than one card — unusable. */
  bySegment: Map<string, KanbanCard | null>
}

function buildJoinIndex(cards: KanbanCard[]): JoinIndex {
  const byWorker = new Map<string, KanbanCard>()
  const byUlid = new Map<string, KanbanCard>()
  const bySegment = new Map<string, KanbanCard | null>()
  for (const card of cards) {
    if (card.runningWorker) byWorker.set(card.runningWorker, card)
    for (const ulid of cardUlids(card)) byUlid.set(ulid, card)
    for (const segment of cardPathSegments(card)) {
      const seen = bySegment.get(segment)
      if (seen === undefined) bySegment.set(segment, card)
      else if (seen && seen.id !== card.id) bySegment.set(segment, null)
    }
  }
  return { byWorker, byUlid, bySegment }
}

export function joinBucketToCard(
  bucket: Pick<ActivityBucket, 's'>,
  index: JoinIndex,
): KanbanCard | null {
  if (bucket.s) {
    const worker = index.byWorker.get(bucket.s)
    if (worker) return worker
    const ulid = tmuxFiberUlid(bucket.s)
    if (ulid) {
      const byUlid = index.byUlid.get(ulid)
      if (byUlid) return byUlid
    }
    const slug = sessionSlug(bucket.s)
    if (slug) {
      const bySlug = index.bySegment.get(slug)
      if (bySlug) return bySlug
    }
  }
  return null
}

/**
 * One lane per fiber that was active in the window, then one per working
 * directory for everything that did not join to a fiber. Fiber lanes sort by
 * weight (the day's heaviest work reads first); interactive lanes follow, also
 * by weight.
 */
export function buildDayLanes(
  activity: ActivityResult,
  cards: KanbanCard[],
  win: DayWindow,
): DayLane[] {
  const index = buildJoinIndex(cards)

  interface Acc {
    lane: Omit<DayLane, 'agent' | 'attention' | 'notify' | 'weight'>
    agent: Set<number>
    attention: Set<number>
    notify: Set<number>
    all: Set<number>
  }
  const acc = new Map<string, Acc>()

  for (const bucket of activity.buckets) {
    const minute = minuteIndex(bucket.m, win)
    if (minute === null) continue
    const card = joinBucketToCard(bucket, index)
    // Unjoined buckets split by ORIGIN as well as by directory: a worker whose
    // fiber we could not name and a human at a shell are different claims
    // about the same folder, and merging them would put one behind the other's
    // label. See cwdLaneLabel.
    const fromWorker = bucket.s !== null
    const key = card
      ? `fiber:${card.id}`
      : `loose:${fromWorker ? 'worker' : 'human'}:${bucket.cwd ?? ''}`
    let entry = acc.get(key)
    if (!entry) {
      entry = {
        lane: card
          ? {
              key,
              kind: 'fiber',
              label: card.name,
              host: (card.shuttleHost ?? activity.host ?? '').toLowerCase(),
              cardId: card.id,
              slugs: commitSlugsForCard(card),
            }
          : {
              key,
              kind: 'loose',
              label: cwdLaneLabel(bucket.cwd, fromWorker),
              host: (activity.host ?? '').toLowerCase(),
              slugs: [],
            },
        agent: new Set(),
        attention: new Set(),
        notify: new Set(),
        all: new Set(),
      }
      acc.set(key, entry)
    }
    entry.all.add(minute)
    if (bucket.k === 'agent') entry.agent.add(minute)
    else if (bucket.k === 'attention') entry.attention.add(minute)
    else entry.notify.add(minute)
  }

  const lanes: DayLane[] = [...acc.values()].map((entry) => ({
    ...entry.lane,
    agent: mergeMinuteRuns(entry.agent),
    attention: mergeMinuteRuns(entry.attention),
    notify: [...entry.notify].sort((a, b) => a - b),
    weight: entry.all.size,
  }))

  lanes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'fiber' ? -1 : 1
    if (a.weight !== b.weight) return b.weight - a.weight
    return a.label.localeCompare(b.label)
  })
  return lanes
}

export interface DayEntry {
  key: string
  /** Bold leading token — a commit slug, or a fiber's own slug. */
  title: string
  /** The prose: subjects joined with "; ", or an italic outcome fallback. */
  body: string
  /** True for the outcome fallback — set in italic, it is not a commit. */
  fallback?: boolean
  /** True for the unprefixed-commit group, which sits last and muted. */
  loose?: boolean
  cardId?: string
}

/**
 * "The day, by fiber": one entry per commit slug, then one per fiber that was
 * live on a lane but committed nothing (its outcome's first sentence stands
 * in), then the unprefixed commits under a muted marginal head.
 *
 * A LEAF SLUG IS NOT AN IDENTITY. Nested ids are the norm in this store, so
 * `felt/board` and `lightcone/board` both answer to `board`. Attributing such
 * a commit to whichever lane came first would open the wrong fiber on click,
 * and — worse — would count BOTH lanes as narrated, silently deleting the
 * other fiber's entry from a page that draws its rail. So an ambiguous slug is
 * refused instead: the commit entry keeps its prose but carries no card, and
 * every lane that answers to that slug still gets its own fallback line. Same
 * refusal ChronicleView makes on the same hazard.
 */
export function buildDayEntries(
  commits: NarrationCommit[],
  lanes: DayLane[],
  cards: KanbanCard[],
): DayEntry[] {
  const groups = groupCommitsBySlug(commits)
  const cardById = new Map(cards.map((card) => [card.id, card]))

  // slug → the one lane that owns it, or null when several answer to it.
  const laneBySlug = new Map<string, DayLane | null>()
  for (const lane of lanes) {
    if (lane.kind !== 'fiber') continue
    for (const slug of lane.slugs) {
      const seen = laneBySlug.get(slug)
      if (seen === undefined) laneBySlug.set(slug, lane)
      else if (seen && seen.key !== lane.key) laneBySlug.set(slug, null)
    }
  }
  const ambiguous = new Set(
    [...laneBySlug.entries()].filter(([, lane]) => lane === null).map(([slug]) => slug),
  )
  // Narration suppresses a fallback PER LANE, never per slug: only the lane a
  // commit could actually be attributed to counts as having spoken.
  const narratedLanes = new Set<string>()
  for (const group of groups) {
    if (!group.slug) continue
    const lane = laneBySlug.get(group.slug.toLowerCase())
    if (lane) narratedLanes.add(lane.key)
  }

  const entries: DayEntry[] = []
  let loose: DayEntry | null = null
  for (const group of groups) {
    const body = group.subjects.join('; ')
    if (group.slug === null) {
      loose = { key: 'loose', title: '— elsewhere in the store —', body, loose: true }
      continue
    }
    // Only an unambiguous slug carries a card, so the prose entry always opens
    // the same fiber its lane label does — or nothing at all.
    const lane = laneBySlug.get(group.slug.toLowerCase()) ?? undefined
    entries.push({ key: `slug:${group.slug}`, title: group.slug, body, cardId: lane?.cardId })
  }

  for (const lane of lanes) {
    if (lane.kind !== 'fiber' || narratedLanes.has(lane.key)) continue
    const card = lane.cardId ? cardById.get(lane.cardId) : undefined
    const sentence = firstSentence(card?.outcome)
    entries.push({
      key: `lane:${lane.key}`,
      title: laneEntryTitle(lane, ambiguous),
      body: sentence || 'worked, wrote nothing down',
      fallback: true,
      cardId: lane.cardId,
    })
  }

  if (loose) entries.push(loose)
  return entries
}

/** A fallback entry's bold token. Two lanes sharing a leaf both appear here,
 *  so a contested leaf is qualified by its parent rather than printed twice. */
function laneEntryTitle(lane: DayLane, ambiguous: Set<string>): string {
  const leaf = lane.slugs[0]
  if (!leaf) return lane.label
  if (!ambiguous.has(leaf)) return leaf
  const parts = (lane.cardId ?? '').split('/').filter(Boolean)
  return parts.length >= 2 ? parts.slice(-2).join('/') : leaf
}

export interface DayModel {
  dayISO: string
  window: DayWindow
  totals: DayTotals
  lanes: DayLane[]
  entries: DayEntry[]
}

export function buildDayModel(
  dayISO: string,
  activity: ActivityResult,
  commits: NarrationCommit[],
  cards: KanbanCard[],
): DayModel {
  const win = dayWindow(dayISO)
  const lanes = buildDayLanes(activity, cards, win)
  return {
    dayISO,
    window: win,
    totals: dayTotals(activity, win),
    lanes,
    // The commits are the widened civil-day range; the rail decides which of
    // them are this day's. Filtering here rather than at the call site keeps
    // every caller of buildDayModel honest.
    entries: buildDayEntries(commitsOnRail(commits, win), lanes, cards),
  }
}

/** Cheap structural fingerprint — the refresh path rebuilds the DOM only when
 *  this changes, so a 15s poll over an unchanged day is a no-op. */
export function dayModelSignature(model: DayModel): string {
  const lanes = model.lanes
    .map(
      (lane) =>
        `${lane.key}|${lane.label}|${lane.host}|${lane.weight}|` +
        `${lane.agent.map((r) => `${r.start}-${r.end}`).join(',')}|` +
        `${lane.attention.map((r) => `${r.start}-${r.end}`).join(',')}|${lane.notify.join(',')}`,
    )
    .join('\n')
  const entries = model.entries.map((e) => `${e.key}|${e.title}|${e.body}`).join('\n')
  return `${model.dayISO}\n${model.totals.attention}/${model.totals.agent}\n${lanes}\n${entries}`
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** `Tuesday, August 4` — pinned to en-US so the heading keeps its shape. */
function formatDayHeading(dayISO: string): string {
  const date = civilDayToLocalDate(dayISO)
  if (!date) return dayISO
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

/** `6am`, `2pm` — the rail's tick hand. */
function formatHourTick(ms: number): string {
  const h = new Date(ms).getHours()
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12}${h < 12 ? 'am' : 'pm'}`
}

function pct(value: number): string {
  return `${(value * 100).toFixed(4)}%`
}

/** The board's own guard, minimally replicated: a keystroke belongs to a text
 *  field or a layered dialog before it belongs to this view. */
function keystrokeIsSpokenFor(): boolean {
  const active = document.activeElement as HTMLElement | null
  if (active) {
    const tag = active.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    if (active.isContentEditable) return true
  }
  if (document.querySelector('[role="dialog"][data-state="open"]')) return true
  if (document.querySelector('.kbn-detail-overlay')) return true
  return false
}

class DayViewImpl implements TemporalView {
  readonly id = 'day' as const
  readonly title = 'Day'
  readonly hotkey = '3'

  private root: HTMLElement | null = null
  private headingEl: HTMLElement | null = null
  private statsEl: HTMLElement | null = null
  private bodyEl: HTMLElement | null = null
  private ctx: ViewContext | null = null
  /** The day currently PAINTED. Not authority — the cursor is (see
   *  {@link resolveDayISO}); this only says what the DOM is showing, so a
   *  refresh can tell whether the heading and body need to move. */
  private shownDay: string | null = null
  private signature: string | null = null
  /** Monotonic load id — a fetch that lands after a newer one is discarded. */
  private loadToken = 0

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    if (keystrokeIsSpokenFor()) return
    e.preventDefault()
    this.step(e.key === 'ArrowLeft' ? -1 : 1)
  }

  mount(host: HTMLElement, ctx: ViewContext): void {
    this.ctx = ctx
    this.shownDay = null
    this.signature = null

    const page = createViewPage(this.title)

    const head = document.createElement('div')
    head.className = 'kbn-day-head'

    // The date is a quiet way up a zoom level: it hands the week the day you
    // are looking at, so Week opens around it rather than on the current week.
    this.headingEl = document.createElement('button')
    this.headingEl.className = 'kbn-day-date'
    ;(this.headingEl as HTMLButtonElement).type = 'button'
    this.headingEl.title = 'See the week this day sits in'
    this.headingEl.addEventListener('click', () => {
      const ctxNow = this.ctx
      if (ctxNow) ctxNow.switchView('week', { focusDate: this.currentDay() })
    })

    const dateRow = document.createElement('div')
    dateRow.className = 'kbn-day-daterow'
    dateRow.append(
      this.buildChevron('‹', 'Previous day', -1),
      this.headingEl,
      this.buildChevron('›', 'Next day', 1),
    )

    this.statsEl = document.createElement('div')
    this.statsEl.className = 'kbn-day-stats'
    this.statsEl.textContent = ''

    head.append(dateRow, this.statsEl)
    page.titleRow.append(head)

    this.bodyEl = page.body
    this.root = page.root
    host.append(page.root)

    document.addEventListener('keydown', this.onKeyDown)
    this.syncToCursor()
  }

  refresh(ctx: ViewContext): void {
    this.ctx = ctx
    this.syncToCursor()
  }

  unmount(): void {
    document.removeEventListener('keydown', this.onKeyDown)
    this.loadToken += 1
    this.root?.remove()
    this.root = null
    this.headingEl = null
    this.statsEl = null
    this.bodyEl = null
    this.ctx = null
    this.shownDay = null
    this.signature = null
  }

  /** The day to show right now, read from the shared cursor. */
  private currentDay(): string {
    return resolveDayISO(this.ctx?.focusDate, Date.now())
  }

  /**
   * Bring the page to the cursor. Called from mount and from every refresh —
   * including the refresh `setFocusDate` itself triggers, which is why paging
   * writes to the cursor and then does nothing else.
   */
  private syncToCursor(): void {
    const day = this.currentDay()
    if (day !== this.shownDay) {
      this.shownDay = day
      if (this.headingEl) this.headingEl.textContent = formatDayHeading(day)
      // A different day is different content; never let the old day's
      // signature suppress its render.
      this.signature = null
    }
    void this.load(day)
  }

  /** Page the cursor, and let the refresh it triggers do the drawing. */
  private step(delta: number): void {
    const ctx = this.ctx
    if (!ctx) return
    ctx.setFocusDate(stepTarget(this.currentDay(), delta, Date.now()))
  }

  private buildChevron(glyph: string, label: string, delta: number): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'kbn-day-chev'
    button.textContent = glyph
    button.title = label
    button.setAttribute('aria-label', label)
    button.addEventListener('click', () => this.step(delta))
    return button
  }

  /** One activity call + one narration call, both memoized upstream. */
  private async load(dayISO: string): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    const win = dayWindow(dayISO)
    const token = (this.loadToken += 1)

    const range = narrationRange(dayISO)
    const [activity, narration] = await Promise.all([
      // `to_ms` is INCLUSIVE on the endpoint while the rail's own end is
      // exclusive, so ask for the last minute we draw, not the first we don't.
      ctx.activity(win.startMs, win.endMs - MINUTE_MS),
      ctx.narration(range.from, range.to),
    ])
    // A day the human has since navigated away from, or an unmounted view.
    if (token !== this.loadToken || !this.bodyEl || dayISO !== this.shownDay) return

    const model = buildDayModel(dayISO, activity, narration.commits, ctx.cards)
    const signature = dayModelSignature(model)
    if (signature === this.signature) return
    this.signature = signature
    this.render(model)
  }

  private render(model: DayModel): void {
    const body = this.bodyEl
    if (!body) return

    if (this.statsEl) {
      this.statsEl.textContent =
        `attention ${formatSpanHM(model.totals.attention)}` +
        ` · agents ${formatSpanHM(model.totals.agent)}`
      this.statsEl.classList.toggle('kbn-day-stats-quiet', model.lanes.length === 0)
    }

    body.textContent = ''
    if (model.lanes.length === 0 && model.entries.length === 0) {
      body.append(createViewEmptyState('— an unwritten day —'))
      return
    }
    if (model.lanes.length > 0) body.append(this.buildChart(model))
    if (model.entries.length > 0) body.append(this.buildNarration(model))
  }

  private buildChart(model: DayModel): HTMLElement {
    const win = model.window
    const span = win.endMs - win.startMs
    const chart = document.createElement('div')
    chart.className = 'kbn-day-chart'

    // One gridline layer behind every rail, so the hour rules run unbroken
    // down the whole stack instead of restarting per lane.
    const grid = document.createElement('div')
    grid.className = 'kbn-day-grid'
    grid.style.gridRow = `1 / span ${model.lanes.length}`
    for (let hour = TICK_HOURS; hour * 3_600_000 < span; hour += TICK_HOURS) {
      const line = document.createElement('i')
      line.className = 'kbn-day-gridline'
      line.style.left = pct((hour * 3_600_000) / span)
      grid.append(line)
    }
    // Midnight — the date itself turning over, mid-rail. Not on a 4h tick.
    const midnight = civilDayToLocalDate(shiftCivilDay(model.dayISO, 1))?.getTime()
    if (midnight !== undefined && midnight > win.startMs && midnight < win.endMs) {
      const line = document.createElement('i')
      line.className = 'kbn-day-midnight'
      line.style.left = pct((midnight - win.startMs) / span)
      grid.append(line)
    }
    chart.append(grid)

    model.lanes.forEach((lane, index) => {
      const row = String(index + 1)

      const label = document.createElement('div')
      label.className = `kbn-day-label kbn-day-label-${lane.kind}`
      label.style.gridRow = row
      const name = document.createElement(lane.cardId ? 'button' : 'span')
      name.className = 'kbn-day-lanename'
      name.textContent = lane.label
      name.title = lane.label
      if (lane.cardId && name instanceof HTMLButtonElement) {
        name.type = 'button'
        const cardId = lane.cardId
        name.addEventListener('click', () => this.ctx?.openCard(cardId))
      }
      label.append(name)
      if (lane.host) {
        const host = document.createElement('span')
        host.className = 'kbn-day-lanehost'
        host.textContent = lane.host
        label.append(host)
      }

      const rail = document.createElement('div')
      rail.className = `kbn-day-rail kbn-day-rail-${lane.kind}`
      rail.style.gridRow = row
      for (const run of lane.agent) rail.append(this.buildMark('kbn-day-wash', run, win))
      for (const run of lane.attention) rail.append(this.buildMark('kbn-day-att', run, win))
      for (const minute of lane.notify) {
        const tick = document.createElement('i')
        tick.className = 'kbn-day-notify'
        tick.style.left = pct(minute / win.minutes)
        rail.append(tick)
      }

      chart.append(label, rail)
    })

    // The hour hand, once, under every lane.
    const axis = document.createElement('div')
    axis.className = 'kbn-day-axis'
    axis.style.gridRow = String(model.lanes.length + 1)
    for (let hour = 0; hour * 3_600_000 <= span; hour += TICK_HOURS) {
      const at = win.startMs + hour * 3_600_000
      const tick = document.createElement('span')
      tick.className = 'kbn-day-tick'
      tick.textContent = formatHourTick(at)
      const fraction = (at - win.startMs) / span
      if (fraction <= 0) tick.classList.add('kbn-day-tick-first')
      else if (fraction >= 0.999) tick.classList.add('kbn-day-tick-last')
      tick.style.left = pct(Math.min(fraction, 1))
      axis.append(tick)
    }
    chart.append(axis)
    return chart
  }

  private buildMark(className: string, run: MinuteRun, win: DayWindow): HTMLElement {
    const mark = document.createElement('i')
    mark.className = className
    mark.style.left = pct(run.start / win.minutes)
    mark.style.width = pct((run.end - run.start) / win.minutes)
    return mark
  }

  private buildNarration(model: DayModel): HTMLElement {
    const section = document.createElement('section')
    section.className = 'kbn-day-narr'

    const head = document.createElement('h3')
    head.className = 'kbn-day-narrhead'
    head.textContent = 'the day, by fiber'
    section.append(head)

    const list = document.createElement('div')
    list.className = 'kbn-day-entries'
    model.entries.forEach((entry, index) => {
      const item = document.createElement('p')
      item.className = 'kbn-day-entry'
      if (entry.loose) item.classList.add('kbn-day-entry-loose')

      const square = document.createElement('i')
      square.className = 'kbn-day-sq'
      if (!entry.loose) square.dataset.hue = String(index % 4)
      item.append(square)

      const title = document.createElement(entry.cardId ? 'button' : 'strong')
      title.className = 'kbn-day-entrytitle'
      title.textContent = entry.title
      if (entry.cardId && title instanceof HTMLButtonElement) {
        title.type = 'button'
        const cardId = entry.cardId
        title.addEventListener('click', () => this.ctx?.openCard(cardId))
      }
      item.append(title)

      const bodyText = document.createElement('span')
      bodyText.className = entry.fallback ? 'kbn-day-entrybody kbn-day-entrybody-fallback' : 'kbn-day-entrybody'
      bodyText.textContent = entry.body
      item.append(bodyText)

      list.append(item)
    })
    section.append(list)
    return section
  }
}

registerView(new DayViewImpl())
