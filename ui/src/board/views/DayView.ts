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
 * The join from a bucket to a fiber is the tmux session name and nothing else:
 * a Shuttle worker runs in `<slug>-<ULID>-shuttle`, and that ULID is the
 * fiber's `uid`. Work that does not join still appears, on a lane named for its
 * working directory and labelled for what is actually known about it — a
 * session we could not resolve is `unmatched`, no session at all is
 * `interactive`.
 *
 * NO COLOUR WITHOUT A MEANING. The board's ink has a grammar and this page
 * spends none of it decoratively: cobalt is agent activity, teal is human
 * steering, cinnabar is attention demanded (and, as rubric, a section head).
 * Everything else on the page — bullets, rules, hovers, focus rings — is iron
 * gall at some weight. A hue here is a claim, so a hue that means nothing is a
 * claim the data never made.
 */

import { civilDayToLocalDate, dueCivilDay, instantMs, isoDayLocal, railCivilDay } from '../civilDay.js'
import { humanizeIdleAge, phasePillLabel } from '../KanbanSurfaces.js'
import { fileBytesUrl, renderMarkdown } from '../utils.js'
import type { KanbanCard } from '../KanbanTypes.js'
import {
  buildSessionIndex,
  type ActivityBucket,
  type ActivityResult,
  type NarrationCommit,
  type SessionPairing,
} from './TemporalData.js'
import { createViewEmptyState, createViewPage } from './ViewPage.js'
import {
  keystrokeIsSpokenFor,
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
 *
 * The shared doctrine, stated the same way in WeekView's `weekStepTarget`: a
 * paging affordance that lands back on the view's live present hands the
 * cursor to null; the views differ only in what their present is — a day for
 * Day, a week for Week. So Day snaps on an exact date match while Week snaps
 * anywhere inside the current week, and Day's exact-today test would never
 * fire at week grain.
 */
export function stepTarget(fromDayISO: string, delta: number, nowMs: number): string | null {
  const next = shiftCivilDay(fromDayISO, delta)
  return next === defaultDayISO(nowMs) ? null : next
}

/**
 * Is the page showing the live present? Drives the back-to-today affordance,
 * which exists only while you are away from it.
 *
 * The same 06:00 rule as everything else here: at 02:00 the live present is
 * still yesterday's rail, so a page showing yesterday at that hour IS home and
 * must not offer to take you there.
 */
export function isLivePresent(dayISO: string, nowMs: number): boolean {
  return dayISO === defaultDayISO(nowMs)
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

// MIND THE NAMES. The wire kind spelled `attention` is a HUMAN typing — the
// key glosses it "you steering". The kind that means an agent asked for a human
// is `notify`, glossed "attention called". So the word *attention* names one
// kind and describes the other, and the pairing looks backwards at a glance.
// It is correct as written; TemporalData's bucket docs are the authority.
// (Flagged by builder-week, who hit the same inversion wiring Week's key.)

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
  /**
   * The host to print beside the label — set ONLY when this lane ran somewhere
   * other than the host the page is reading. Every lane wearing the same
   * hostname is a constant repeated once per row, which reads as information
   * and is not; a hostname that appears means "this one ran elsewhere".
   */
  hostNote: string
  /** Board card id, when the lane joined to one — the click target. */
  cardId?: string
  /** Slugs this lane answers to when matching commit prefixes. */
  slugs: string[]
  agent: MinuteRun[]
  attention: MinuteRun[]
  /** Minute indices where the agent asked for a human. */
  notify: number[]
  /**
   * Distinct minutes carrying an attention / agent bucket — the figures the
   * ledger reports as "you 38m · agents 2h 10m".
   *
   * Counted BEFORE the merge, deliberately. `agent`/`attention` above are
   * render spans that bridge gaps of up to five idle minutes so a run reads as
   * one stroke; summing those would bill the pauses as work and quietly
   * inflate every number on the page.
   */
  attentionMinutes: number
  agentMinutes: number
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
 *   0. The SESSION LEDGER — the daemon wrote down which fiber this tmux
 *      session was dispatched for. Not an inference at all: a record. It goes
 *      first because it is the only rung that can read a session name carrying
 *      no ULID and no recognizable slug (`pi-2f9c41`), which every rung below
 *      must miss.
 *   1. `s` is exactly a live worker's tmux name.
 *   2. `s` embeds a fiber ULID a card claims. Exact identity.
 *   3. `s`'s slug half names exactly one card's path segment — the name the
 *      dispatcher built the session from, including the legacy leaf-only form.
 *   4. nothing: the bucket belongs to its working directory.
 *
 * A LEDGER PAIRING NAMING A FIBER THIS BOARD DOES NOT CARRY falls THROUGH
 * rather than resolving — same refusal ChronicleView makes. Attributing to an
 * absent card would drop the minutes off the page entirely: no fiber lane to
 * receive them, and no cwd lane either, because they would count as joined.
 * Silently losing time is worse than mis-filing it.
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
  byId: Map<string, KanbanCard>
  /** The session ledger's tmux→fiber pairings, when the board has them. */
  byTmux?: ReadonlyMap<string, SessionPairing>
}

function buildJoinIndex(
  cards: KanbanCard[],
  byTmux?: ReadonlyMap<string, SessionPairing>,
): JoinIndex {
  const byWorker = new Map<string, KanbanCard>()
  const byUlid = new Map<string, KanbanCard>()
  const bySegment = new Map<string, KanbanCard | null>()
  const byId = new Map<string, KanbanCard>()
  for (const card of cards) {
    byId.set(card.id, card)
    if (card.runningWorker) byWorker.set(card.runningWorker, card)
    for (const ulid of cardUlids(card)) byUlid.set(ulid, card)
    for (const segment of cardPathSegments(card)) {
      const seen = bySegment.get(segment)
      if (seen === undefined) bySegment.set(segment, card)
      else if (seen && seen.id !== card.id) bySegment.set(segment, null)
    }
  }
  return { byWorker, byUlid, bySegment, byId, byTmux }
}

export function joinBucketToCard(
  bucket: Pick<ActivityBucket, 's'>,
  index: JoinIndex,
): KanbanCard | null {
  if (bucket.s) {
    // 0. What the daemon recorded. Both halves of the pairing are tried: the
    // ULID is identity, while the fiber id is a path that can be moved out from
    // under one.
    const pairing = index.byTmux?.get(bucket.s)
    if (pairing) {
      const byFiber = index.byId.get(pairing.fiber)
      if (byFiber) return byFiber
      const uid = pairing.uid?.trim().toUpperCase()
      const byUid = uid ? index.byUlid.get(uid) : undefined
      if (byUid) return byUid
    }
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
  byTmux?: ReadonlyMap<string, SessionPairing>,
): DayLane[] {
  const index = buildJoinIndex(cards, byTmux)
  const pageHost = (activity.host ?? '').toLowerCase()
  const noteFor = (host: string | undefined): string => {
    const own = (host ?? '').toLowerCase()
    return own && own !== pageHost ? own : ''
  }

  interface Acc {
    lane: Omit<
      DayLane,
      'agent' | 'attention' | 'notify' | 'attentionMinutes' | 'agentMinutes' | 'weight'
    >
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
              hostNote: noteFor(card.shuttleHost),
              cardId: card.id,
              slugs: commitSlugsForCard(card),
            }
          : {
              key,
              kind: 'loose',
              label: cwdLaneLabel(bucket.cwd, fromWorker),
              hostNote: '',
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
    attentionMinutes: entry.attention.size,
    agentMinutes: entry.agent.size,
    weight: entry.all.size,
  }))

  lanes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'fiber' ? -1 : 1
    if (a.weight !== b.weight) return b.weight - a.weight
    return a.label.localeCompare(b.label)
  })
  return lanes
}

// ── The operating surface ────────────────────────────────────────────────────
//
// The Desk is where you change what a fiber IS — its column, its verdict, its
// schedule. Day is where you work the ones already in the air. So a ledger row
// here is not a label with prose under it; it is the fiber's cockpit strip: how
// it stands right now, what it has cost today, and what it says it did.
//
// The chip is the Desk's own worker pill — same vocabulary, same CSS classes,
// same gesture — because a live worker must not look like two different things
// on two pages of one board.

/** Below a minute of idling, a paused worker is just working; the Desk applies
 *  the same gate before letting `waiting` take over its pill. */
const WAITING_GATE_MS = 60_000

export interface DayChip {
  label: string
  /** Drives the Desk pill class: `kbn-card-worker-<variant>`. */
  variant: 'aloft' | 'attention' | 'waiting'
  title: string
  tmux: string
  host?: string
}

/**
 * The live chip for a fiber with a worker in the air, or nothing.
 *
 * Deliberately a re-derivation of KanbanSurfaces' pill logic rather than an
 * import of its DOM builder: the Desk builds a card, we build a ledger row, but
 * the RULE ("attention takes over immediately, waiting only after a minute,
 * otherwise aloft") and the wording both come from there — `phasePillLabel` is
 * imported so the strings can never drift.
 */
export function laneChip(card: KanbanCard | undefined, nowMs: number): DayChip | undefined {
  if (!card?.runningWorker) return undefined
  const tmux = card.runningWorker
  const phase = card.runtimePhase
  const idleMs = card.lastActivityAt !== undefined ? nowMs - card.lastActivityAt : Infinity
  const age = card.lastActivityAt !== undefined ? humanizeIdleAge(idleMs) : null
  const takesOver = phase === 'attention' || (phase === 'waiting' && idleMs >= WAITING_GATE_MS)
  if (takesOver && phase) {
    return {
      label: phasePillLabel(phase, card.lastActivityAt, nowMs),
      variant: phase === 'attention' ? 'attention' : 'waiting',
      title:
        phase === 'attention'
          ? `Worker raised its hand${age ? ` ${age} ago` : ''} — open ${tmux}`
          : `Worker paused on input${age ? ` ${age} ago` : ''} — open ${tmux}`,
      tmux,
      host: card.shuttleHost,
    }
  }
  return { label: '▸ aloft', variant: 'aloft', title: `Worker aloft — open ${tmux}`, tmux, host: card.shuttleHost }
}

/**
 * How a fiber that ENDED inside this rail is marked. Display only — the verdict
 * itself belongs to the Desk, and offering Temper/Compost here would make two
 * places to do one irreversible thing.
 */
export function closureMark(
  card: KanbanCard | undefined,
  win: DayWindow,
): { glyph: string; title: string } | undefined {
  const at = instantMs(card?.closedAt)
  if (at === undefined || at < win.startMs || at >= win.endMs) return undefined
  if (card?.tempered === true) return { glyph: '✓', title: 'Tempered today' }
  if (card?.tempered === false) return { glyph: '✗', title: 'Composted today' }
  return { glyph: '◦', title: 'Closed today — awaiting a verdict on the Desk' }
}

export interface StillAheadItem {
  key: string
  /** ◐ a standing role's next firing · ◴ something owed today. Week's glyphs. */
  glyph: string
  label: string
  /** Clock time, for a launch. A `due:` names a day and carries no hour. */
  when?: string
  atMs?: number
  cardId: string
  title: string
}

/** `2:30pm` — the hour a launch is expected, in the rail's own register. */
export function formatClockTime(ms: number): string {
  const d = new Date(ms)
  const h = d.getHours()
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12}:${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`
}

/**
 * What the day still owes: role firings between now and the end of the rail,
 * and work due on this civil day.
 *
 * ONLY for the rail that contains now. A past day owes nothing — it is over,
 * and a list of obligations on a finished day would be describing a future
 * that has already resolved. Returning empty is how the strip disappears.
 *
 * A launch outranks a due for the same card: the concrete hour is the better
 * statement of the same obligation.
 */
export function buildStillAhead(
  cards: KanbanCard[],
  dayISO: string,
  win: DayWindow,
  nowMs: number,
): StillAheadItem[] {
  if (nowMs < win.startMs || nowMs >= win.endMs) return []
  const launches: StillAheadItem[] = []
  const dues: StillAheadItem[] = []
  for (const card of cards) {
    if (card.closedAt) continue
    const launch = instantMs(card.nextLaunchAt)
    if (launch !== undefined && launch > nowMs && launch < win.endMs) {
      launches.push({
        key: `launch:${card.id}`,
        glyph: '◐',
        label: card.name,
        when: formatClockTime(launch),
        atMs: launch,
        cardId: card.id,
        title: `Standing role fires at ${formatClockTime(launch)}`,
      })
      continue
    }
    if (dueCivilDay(card.due) === dayISO) {
      dues.push({
        key: `due:${card.id}`,
        glyph: '◴',
        label: card.name,
        cardId: card.id,
        title: 'Due today',
      })
    }
  }
  launches.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0))
  dues.sort((a, b) => a.label.localeCompare(b.label))
  return [...launches, ...dues]
}

// ── Where things stand ───────────────────────────────────────────────────────
//
// The rails say WHEN, the ledger says WHAT — and neither shows the thing the
// work actually produced. A fiber that renders a `report.html` has already
// written its own status in spatial form: tables, plots, headings, the shape of
// the argument. So the day closes with those pages themselves, shrunk to
// thumbnails, rather than with another paraphrase of them.
//
// A fiber with no report falls back to its outcome. That is not a placeholder —
// an outcome IS the fiber's statement of where it stands; it is simply a
// sentence where the report would have been a page.

/** The file a fiber's rendered status lives in, by convention. */
const REPORT_FILENAME = 'report.html'

/**
 * The daemon origin for file reads. Read from the same env var main.ts reads
 * (`VITE_SHUTTLE_BASE`), not threaded through ViewContext: it is one build-time
 * constant with one source of truth, and asking the context to carry it would
 * make two. Empty means same-origin, which is how the daemon serves the bundle.
 */
const SHUTTLE_BASE: string =
  (import.meta.env?.VITE_SHUTTLE_BASE as string | undefined) ?? ''

export interface DayPreview {
  key: string
  cardId: string
  label: string
  /** The fiber's report, when it declares a directory to hold one. */
  reportUrl?: string
  /** Its outcome — the fallback, and a statement in its own right. */
  outcome: string
  /** Origin, for the owner-routed read of a remote fiber's report. */
  originId: string
}

/**
 * One pane per fiber that had a rail today, in lane order — the same set and
 * the same sequence as the ledger, so the page reads down consistently.
 *
 * A fiber the feed carries no `fiberDir` for (an older daemon, or a remote
 * snapshot without one) gets no report URL and goes straight to its outcome;
 * guessing a path would produce a 404 per pane per render.
 */
export function buildDayPreviews(lanes: DayLane[], cards: KanbanCard[]): DayPreview[] {
  const cardById = new Map(cards.map((card) => [card.id, card]))
  const out: DayPreview[] = []
  for (const lane of lanes) {
    if (lane.kind !== 'fiber' || !lane.cardId) continue
    const card = cardById.get(lane.cardId)
    if (!card) continue
    out.push({
      key: `preview:${lane.cardId}`,
      cardId: lane.cardId,
      label: lane.label,
      reportUrl: card.fiberDir
        ? fileBytesUrl(SHUTTLE_BASE, `${card.fiberDir}/${REPORT_FILENAME}`, card.originId)
        : undefined,
      outcome: card.outcome ?? '',
      originId: card.originId,
    })
  }
  return out
}

export interface DayEntryStats {
  /** Minutes you were steering this fiber today. */
  attention: number
  /** Minutes its agents were working. */
  agent: number
  commits: number
}

/** `you 38m · agents 2h 10m · 3 commits`, with empty terms dropped rather than
 *  printed as zeros — a row of `0m`s is noise, not information. */
export function formatEntryStats(stats: DayEntryStats): string {
  const parts: string[] = []
  if (stats.attention > 0) parts.push(`you ${formatSpanHM(stats.attention)}`)
  if (stats.agent > 0) parts.push(`agents ${formatSpanHM(stats.agent)}`)
  if (stats.commits > 0) parts.push(`${stats.commits} commit${stats.commits === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

export interface DayEntry {
  key: string
  /** Bold leading token. For a lane's entry it is the lane's own label, word
   *  for word, so the two halves of the page name the same thing; for a commit
   *  with no lane it is the slug the commit itself carried. */
  title: string
  /** The prose: subjects joined with "; ", or an italic outcome fallback. */
  body: string
  /** True for the outcome fallback — set in italic, it is not a commit. */
  fallback?: boolean
  /** True when the commit's slug names no lane on this page — work that was
   *  committed here but did none of its running here. */
  noLane?: boolean
  /** True for the unprefixed-commit group, which sits last and muted. */
  loose?: boolean
  cardId?: string
  /** Live worker state, when one is in the air for this fiber. */
  chip?: DayChip
  /** Today's cost, for a lane's entry. Absent on rows that have no rail. */
  stats?: DayEntryStats
  /** Set when the fiber closed inside this rail. Display only. */
  closed?: { glyph: string; title: string }
}

/**
 * "The day, by fiber": one entry per commit slug, then one per fiber that was
 * live on a lane but committed nothing (its outcome's first sentence stands
 * in), then the unprefixed commits under a muted marginal head.
 *
 * THE LEDGER READS IN LANE ORDER, and each lane's entry is titled with that
 * lane's own label. The two halves of the page are the same day told twice —
 * rails for when, prose for what — so the reader must be able to go from a
 * rail to its sentence without hunting. Ordering the ledger by commit
 * chronology instead (as this first did) puts the two halves in unrelated
 * orders and turns an obvious correspondence into a lookup.
 *
 * So: one entry per fiber lane, in lane order, each titled exactly as its lane
 * is; then commits whose slug names no lane on this page; then the commits
 * that named no fiber at all. A title that is a bare slug therefore MEANS
 * "there is no rail above for this" — the name form carries the distinction
 * rather than a decoration.
 *
 * A LEAF SLUG IS NOT AN IDENTITY. Nested ids are the norm in this store, so
 * `felt/board` and `lightcone/board` both answer to `board`. Attributing such
 * a commit to whichever lane came first would open the wrong fiber on click,
 * and — worse — would count BOTH lanes as narrated, silently deleting the
 * other fiber's entry from a page that draws its rail. So an ambiguous slug is
 * refused instead: it falls to the no-lane group, carrying no card, and every
 * lane that answers to it still gets its own line. Same refusal ChronicleView
 * makes on the same hazard.
 */
export function buildDayEntries(
  commits: NarrationCommit[],
  lanes: DayLane[],
  cards: KanbanCard[],
  win: DayWindow,
  nowMs: number = Date.now(),
): DayEntry[] {
  const groups = groupCommitsBySlug(commits)
  const cardById = new Map(cards.map((card) => [card.id, card]))
  const isLiveRail = nowMs >= win.startMs && nowMs < win.endMs

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

  // Sort the commit groups into: the lane each narrates (by lane key), the
  // ones naming no lane, and the one that named no fiber at all.
  const subjectsForLane = new Map<string, string[]>()
  const noLane: SlugGroup[] = []
  let loose: SlugGroup | null = null
  for (const group of groups) {
    if (group.slug === null) {
      loose = group
      continue
    }
    const lane = laneBySlug.get(group.slug.toLowerCase())
    if (!lane) {
      noLane.push(group)
      continue
    }
    const existing = subjectsForLane.get(lane.key)
    if (existing) existing.push(...group.subjects)
    else subjectsForLane.set(lane.key, [...group.subjects])
  }

  const entries: DayEntry[] = []
  for (const lane of lanes) {
    if (lane.kind !== 'fiber') continue
    const subjects = subjectsForLane.get(lane.key)
    const card = lane.cardId ? cardById.get(lane.cardId) : undefined
    const operational = {
      cardId: lane.cardId,
      // A chip is a claim about THIS MOMENT — "there is a worker in the air".
      // On a past day that claim is false however true it is right now, so the
      // chip belongs only to the rail that contains now. The stats below are
      // the opposite kind of fact (what this day cost) and stay on every day.
      chip: isLiveRail ? laneChip(card, nowMs) : undefined,
      closed: closureMark(card, win),
      stats: {
        attention: lane.attentionMinutes,
        agent: lane.agentMinutes,
        commits: subjects?.length ?? 0,
      },
    }
    if (subjects) {
      entries.push({
        key: `lane:${lane.key}`,
        title: lane.label,
        body: subjects.join('; '),
        ...operational,
      })
      continue
    }
    // Worked, but said nothing: its own outcome stands in, in italic, so the
    // line cannot be mistaken for something the day actually reported.
    entries.push({
      key: `lane:${lane.key}`,
      title: lane.label,
      body: firstSentence(card?.outcome) || 'worked, wrote nothing down',
      fallback: true,
      ...operational,
    })
  }

  for (const group of noLane) {
    entries.push({
      key: `slug:${group.slug}`,
      title: group.slug as string,
      body: group.subjects.join('; '),
      noLane: true,
    })
  }

  if (loose) {
    entries.push({
      key: 'loose',
      title: '— elsewhere in the store —',
      body: loose.subjects.join('; '),
      loose: true,
    })
  }
  return entries
}

export interface DayModel {
  dayISO: string
  window: DayWindow
  /** Obligations between now and the end of THIS rail. Empty on a past day. */
  stillAhead: StillAheadItem[]
  /** One pane per fiber lane — its report, or its outcome. */
  previews: DayPreview[]
  /** How many tmux pairings the ledger offered — for the render signature. */
  ledgerSize: number
  /** The host this page's activity came from — printed once, in the head. */
  host: string
  totals: DayTotals
  lanes: DayLane[]
  entries: DayEntry[]
}

export function buildDayModel(
  dayISO: string,
  activity: ActivityResult,
  commits: NarrationCommit[],
  cards: KanbanCard[],
  nowMs: number = Date.now(),
  byTmux?: ReadonlyMap<string, SessionPairing>,
): DayModel {
  const win = dayWindow(dayISO)
  const lanes = buildDayLanes(activity, cards, win, byTmux)
  return {
    dayISO,
    window: win,
    host: (activity.host ?? '').toLowerCase(),
    totals: dayTotals(activity, win),
    lanes,
    // The commits are the widened civil-day range; the rail decides which of
    // them are this day's. Filtering here rather than at the call site keeps
    // every caller of buildDayModel honest.
    entries: buildDayEntries(commitsOnRail(commits, win), lanes, cards, win, nowMs),
    stillAhead: buildStillAhead(cards, dayISO, win, nowMs),
    previews: buildDayPreviews(lanes, cards),
    ledgerSize: byTmux?.size ?? 0,
  }
}

/** Cheap structural fingerprint — the refresh path rebuilds the DOM only when
 *  this changes, so a 15s poll over an unchanged day is a no-op. */
export function dayModelSignature(model: DayModel): string {
  const lanes = model.lanes
    .map(
      (lane) =>
        `${lane.key}|${lane.label}|${lane.hostNote}|${lane.weight}|` +
        `${lane.agent.map((r) => `${r.start}-${r.end}`).join(',')}|` +
        `${lane.attention.map((r) => `${r.start}-${r.end}`).join(',')}|${lane.notify.join(',')}`,
    )
    .join('\n')
  const entries = model.entries
    .map(
      (e) =>
        `${e.key}|${e.title}|${e.body}|${e.chip?.label ?? ''}|${e.closed?.glyph ?? ''}` +
        `|${e.stats ? formatEntryStats(e.stats) : ''}`,
    )
    .join('\n')
  const ahead = model.stillAhead.map((i) => `${i.key}|${i.when ?? ''}`).join(',')
  // The ledger's size rides the signature: a pairing arriving on a later poll
  // can move a bucket from a cwd lane onto a fiber, and the page must repaint.
  const ledger = `ledger:${model.ledgerSize}`
  return `${model.dayISO}\n${model.totals.attention}/${model.totals.agent}\n${lanes}\n${entries}\n${ahead}\n${ledger}`
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

/** One entry in the key: the mark itself, in miniature, then what it means. */
function buildKey(glyphClass: string, text: string): HTMLElement {
  const item = document.createElement('span')
  item.className = 'kbn-day-key'
  const glyph = document.createElement('i')
  glyph.className = `kbn-day-keyglyph ${glyphClass}`
  item.append(glyph, document.createTextNode(text))
  return item
}

class DayViewImpl implements TemporalView {
  readonly id = 'day' as const
  readonly title = 'Day'
  readonly hotkey = '3'

  private root: HTMLElement | null = null
  private headingEl: HTMLElement | null = null
  private statsEl: HTMLElement | null = null
  private bodyEl: HTMLElement | null = null
  /** The now-thread, when the shown day is the one containing this moment. */
  private nowEl: HTMLElement | null = null
  /** The back-to-today control, hidden while today is what you are looking at. */
  private todayEl: HTMLButtonElement | null = null
  /** The previews strip, kept across renders — see buildPreviews. */
  private previewsEl: HTMLElement | null = null
  private previewsKey: string | null = null
  private previewObserver: IntersectionObserver | null = null
  /** url → does this report exist. Remembered so a rebuild costs no probes. */
  private readonly reportProbe = new Map<string, boolean>()
  /** The session ledger's tmux→fiber pairings — rung 0 of the join. */
  private byTmux: ReadonlyMap<string, SessionPairing> = new Map()
  private ctx: ViewContext | null = null
  /** The day currently PAINTED. Not authority — the cursor is (see
   *  {@link resolveDayISO}); this only says what the DOM is showing, so a
   *  refresh can tell whether the heading and body need to move. */
  private shownDay: string | null = null
  private signature: string | null = null
  /** Monotonic load id — a fetch that lands after a newer one is discarded. */
  private loadToken = 0

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 't') return
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    if (keystrokeIsSpokenFor()) return
    e.preventDefault()
    // `t` for today — the same binding WeekView carries, so one key means
    // "back to now" wherever you are in the temporal views.
    if (e.key === 't') this.ctx?.setFocusDate(null)
    else this.step(e.key === 'ArrowLeft' ? -1 : 1)
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

    // Back to the live present. Only ever visible while you are away from it,
    // and gold because gold is this board's "now" — the same signal Week's
    // away-state label carries.
    this.todayEl = document.createElement('button')
    this.todayEl.type = 'button'
    this.todayEl.className = 'kbn-day-today'
    this.todayEl.textContent = 'today'
    this.todayEl.title = 'Back to today (t)'
    this.todayEl.setAttribute('aria-label', 'Back to today')
    this.todayEl.addEventListener('click', () => this.ctx?.setFocusDate(null))

    const dateRow = document.createElement('div')
    dateRow.className = 'kbn-day-daterow'
    dateRow.append(
      this.buildChevron('‹', 'Previous day', -1),
      this.headingEl,
      this.buildChevron('›', 'Next day', 1),
      this.todayEl,
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
    this.disconnectPreviewObserver()
    this.previewsEl = null
    this.previewsKey = null
    this.loadToken += 1
    this.root?.remove()
    this.root = null
    this.headingEl = null
    this.statsEl = null
    this.bodyEl = null
    this.nowEl = null
    this.todayEl = null
    this.ctx = null
    this.shownDay = null
    this.signature = null
  }

  /** The day to show right now, read from the shared cursor. */
  private currentDay(): string {
    return resolveDayISO(this.ctx?.focusDate, Date.now())
  }

  /**
   * Slide the now-thread to the current minute. Called on every refresh and
   * kept OUT of the render signature deliberately: the clock moves constantly,
   * and rebuilding the whole page every poll to advance one hairline would
   * throw away the signature-skip for no gain.
   */
  private positionNow(): void {
    const el = this.nowEl
    if (!el || !this.shownDay) return
    const win = dayWindow(this.shownDay)
    const span = win.endMs - win.startMs
    const now = Date.now()
    if (span <= 0 || now < win.startMs || now >= win.endMs) {
      el.style.display = 'none'
      return
    }
    el.style.display = ''
    el.style.left = pct((now - win.startMs) / span)
  }

  /**
   * Bring the page to the cursor. Called from mount and from every refresh —
   * including the refresh `setFocusDate` itself triggers, which is why paging
   * writes to the cursor and then does nothing else.
   */
  private syncToCursor(): void {
    const day = this.currentDay()
    if (this.todayEl) {
      this.todayEl.classList.toggle('kbn-day-today-shown', !isLivePresent(day, Date.now()))
    }
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
    const [activity, narration, sessions] = await Promise.all([
      // `to_ms` is INCLUSIVE on the endpoint while the rail's own end is
      // exclusive, so ask for the last minute we draw, not the first we don't.
      ctx.activity(win.startMs, win.endMs - MINUTE_MS),
      ctx.narration(range.from, range.to),
      // The whole ledger, with a CONSTANT argument: it is keyed by the tuple
      // upstream, so a moving `since` would mint a fresh cache entry per poll
      // and re-fetch a file that changes a few times a day.
      ctx.sessions(0),
    ])
    // A day the human has since navigated away from, or an unmounted view.
    if (token !== this.loadToken || !this.bodyEl || dayISO !== this.shownDay) return

    this.byTmux = buildSessionIndex(sessions.records).byTmux
    const model = buildDayModel(
      dayISO,
      activity,
      narration.commits,
      ctx.cards,
      Date.now(),
      this.byTmux,
    )
    const signature = dayModelSignature(model)
    if (signature === this.signature) {
      // Nothing new to draw, but the clock still moved.
      this.positionNow()
      return
    }
    this.signature = signature
    this.render(model)
  }

  private render(model: DayModel): void {
    const body = this.bodyEl
    if (!body) return

    if (this.statsEl) {
      // The host belongs here, once: it is the same for the whole page, and a
      // lane only repeats it when it disagrees (see DayLane.hostNote).
      this.statsEl.textContent =
        (model.host ? `${model.host} · ` : '') +
        `attention ${formatSpanHM(model.totals.attention)}` +
        ` · agents ${formatSpanHM(model.totals.agent)}`
      this.statsEl.classList.toggle('kbn-day-stats-quiet', model.lanes.length === 0)
    }

    // Lift the strip out before the body is emptied: `textContent = ''` would
    // destroy its iframes, and they are the one part of this page that is
    // expensive to rebuild.
    this.previewsEl?.remove()
    body.textContent = ''
    if (model.lanes.length === 0 && model.entries.length === 0) {
      body.append(createViewEmptyState('— an unwritten day —'))
      // A day with nothing behind it can still have something in front of it.
      if (model.stillAhead.length > 0) body.append(this.buildStillAheadStrip(model.stillAhead))
      return
    }
    if (model.lanes.length > 0) body.append(this.buildChart(model))
    if (model.entries.length > 0) body.append(this.buildNarration(model))
    if (model.previews.length > 0) body.append(this.buildPreviews(model))
    if (model.stillAhead.length > 0) body.append(this.buildStillAheadStrip(model.stillAhead))
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
    // Now — only on the rail that contains it. Without it the hours to the
    // right of this moment read as an idle evening rather than as a day that
    // has not happened yet. Same deep-gold thread WeekView draws.
    this.nowEl = null
    if (Date.now() >= win.startMs && Date.now() < win.endMs) {
      this.nowEl = document.createElement('i')
      this.nowEl.className = 'kbn-day-now'
      this.nowEl.title = 'now'
      grid.append(this.nowEl)
      this.positionNow()
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
      if (lane.hostNote) {
        const host = document.createElement('span')
        host.className = 'kbn-day-lanehost'
        host.textContent = lane.hostNote
        host.title = `ran on ${lane.hostNote}`
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

    // The key. A page whose pigments need a narrator is as unfinished as one
    // whose pigments mean nothing — "I don't know what the blue, red and green
    // are" is a fair complaint about a grammar that is never stated. So it is
    // stated, once, in the margin under the rails it explains: a caption, not
    // a legend box, and only on a page that actually drew the marks.
    //
    // The wording is shared with WeekView, which spends the same three
    // pigments; the GLYPHS are each view's own marks in miniature, which is
    // why they are shapes rather than uniform swatches — the key teaches the
    // height hierarchy (wash, then block, then tick) at the same time.
    const legend = document.createElement('div')
    legend.className = 'kbn-day-legend'
    legend.style.gridRow = String(model.lanes.length + 2)
    legend.append(
      buildKey('kbn-day-key-wash', 'agents working'),
      buildKey('kbn-day-key-att', 'you steering'),
      buildKey('kbn-day-key-tick', 'attention called'),
    )
    chart.append(legend)
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
    for (const entry of model.entries) {
      const item = document.createElement('div')
      item.className = 'kbn-day-entry'
      if (entry.loose) item.classList.add('kbn-day-entry-loose')
      if (entry.chip || entry.stats) item.classList.add('kbn-day-entry-op')

      // The head: what this fiber IS right now. The chip leads because it is
      // the only element here you can act on.
      const head = document.createElement('div')
      head.className = 'kbn-day-entryhead'
      if (entry.chip) head.append(this.buildChip(entry.chip, entry.cardId))
      if (entry.closed) {
        const mark = document.createElement('span')
        mark.className = 'kbn-day-closed'
        mark.textContent = entry.closed.glyph
        mark.title = entry.closed.title
        head.append(mark)
      }
      if (!entry.chip && !entry.closed) {
        const square = document.createElement('i')
        square.className = 'kbn-day-sq'
        head.append(square)
      }

      const title = document.createElement(entry.cardId ? 'button' : 'strong')
      title.className = 'kbn-day-entrytitle'
      title.textContent = entry.title
      if (entry.cardId && title instanceof HTMLButtonElement) {
        title.type = 'button'
        const cardId = entry.cardId
        title.addEventListener('click', () => this.ctx?.openCard(cardId))
      }
      head.append(title)

      const statLine = entry.stats ? formatEntryStats(entry.stats) : ''
      if (statLine) {
        const stats = document.createElement('span')
        stats.className = 'kbn-day-entrystats'
        stats.textContent = statLine
        head.append(stats)
      }
      item.append(head)

      const bodyText = document.createElement('p')
      bodyText.className = entry.fallback
        ? 'kbn-day-entrybody kbn-day-entrybody-fallback'
        : 'kbn-day-entrybody'
      bodyText.textContent = entry.body
      item.append(bodyText)

      list.append(item)
    }
    section.append(list)
    return section
  }

  /**
   * The Desk's worker pill, in the ledger. Same classes, so the two pages
   * cannot drift into two dialects of "there is a worker here".
   *
   * Clicking attaches to the terminal when the board exposes that (see the
   * `openWorker` note on the class); until then it opens the fiber, where the
   * worker actions already live. Both land somewhere useful — the fallback is
   * one click further from the tmux session.
   */
  private buildChip(chip: DayChip, cardId: string | undefined): HTMLButtonElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = `kbn-card-worker kbn-day-chip${
      chip.variant === 'aloft' ? '' : ` kbn-card-worker-${chip.variant}`
    }`
    el.textContent = chip.label
    el.title = chip.title
    el.setAttribute('aria-label', `${chip.label} — open worker terminal ${chip.tmux}`)
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      // `openWorker` is optional on the context — a board mounted without an
      // attach handler (the offline harness) simply has none. The chip stays
      // either way, because it is a STATUS before it is a control, and it
      // opens the fiber instead, where the worker actions live.
      const ctx = this.ctx
      if (ctx?.openWorker) ctx.openWorker(chip.tmux, chip.host)
      else if (cardId) ctx?.openCard(cardId)
    })
    return el
  }

  /**
   * The previews strip: each fiber's own rendered page, at thumbnail size.
   *
   * REBUILT ONLY WHEN THE SET CHANGES, not on every render. A live day's
   * signature moves whenever a minute of activity lands, and rebuilding these
   * panes with it would re-fetch and re-paint every report a minute — flicker,
   * and a heavy day of HTTP for nothing. So the strip is keyed on the day plus
   * the fibers in it, detached before the body is cleared, and put back
   * untouched when that key is unchanged.
   */
  private buildPreviews(model: DayModel): HTMLElement {
    const key = `${model.dayISO}|${model.previews.map((p) => p.cardId).join(',')}`
    if (this.previewsEl && this.previewsKey === key) return this.previewsEl

    this.disconnectPreviewObserver()
    const section = document.createElement('section')
    section.className = 'kbn-day-previews'

    const head = document.createElement('h3')
    head.className = 'kbn-day-narrhead'
    head.textContent = 'where things stand'
    section.append(head)

    const strip = document.createElement('div')
    strip.className = 'kbn-day-previewstrip'

    // One observer for the strip: panes hydrate as they are scrolled to, so a
    // ten-fiber day does not open ten reports at once.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          observer.unobserve(entry.target)
          void this.hydratePane(entry.target as HTMLElement)
        }
      },
      { root: strip, rootMargin: '200px' },
    )
    this.previewObserver = observer

    for (const preview of model.previews) {
      const pane = document.createElement('figure')
      pane.className = 'kbn-day-pane'
      pane.dataset.url = preview.reportUrl ?? ''
      pane.dataset.outcome = preview.outcome

      const body = document.createElement('div')
      body.className = 'kbn-day-panebody'
      const veil = document.createElement('div')
      veil.className = 'kbn-day-paneveil'
      veil.textContent = 'reading…'
      body.append(veil)
      pane.append(body)

      const caption = document.createElement('figcaption')
      caption.className = 'kbn-day-panecap'
      const name = document.createElement('button')
      name.type = 'button'
      name.className = 'kbn-day-panename'
      name.textContent = preview.label
      name.title = `${preview.label} — open the fiber`
      name.addEventListener('click', () => this.ctx?.openCard(preview.cardId))
      caption.append(name)
      pane.append(caption)

      strip.append(pane)
      observer.observe(pane)
    }
    section.append(strip)

    this.previewsEl = section
    this.previewsKey = key
    return section
  }

  /**
   * Fill one pane, once it is near enough to matter.
   *
   * The report's existence is settled by a HEAD before any frame is created —
   * the daemon runs `Plug.Head`, so the status is authoritative and no bytes
   * move. Pointing an iframe at a missing file instead would fire `load`, not
   * `error` (a 404 has a body), and the pane would show the daemon's error page
   * as though it were the fiber's report.
   */
  private async hydratePane(pane: HTMLElement): Promise<void> {
    const token = this.loadToken
    const url = pane.dataset.url ?? ''
    const body = pane.querySelector<HTMLElement>('.kbn-day-panebody')
    if (!body) return

    const fallback = (): void => {
      body.textContent = ''
      const out = document.createElement('div')
      out.className = 'kbn-day-paneoutcome'
      const text = pane.dataset.outcome ?? ''
      if (text) out.innerHTML = renderMarkdown(text)
      else out.append(Object.assign(document.createElement('em'), { textContent: 'no outcome yet' }))
      body.append(out)
    }

    if (!url) {
      fallback()
      return
    }
    let exists = this.reportProbe.get(url)
    if (exists === undefined) {
      try {
        const res = await fetch(url, { method: 'HEAD' })
        // A 200 is not enough: the content type has to say HTML. A route that
        // answers every path with a JSON body — an error envelope, or the
        // offline harness's catch-all stub — would otherwise pass the probe and
        // put a broken frame in the pane, which is the one outcome this check
        // exists to prevent. A report is an HTML document SERVED as HTML.
        exists = res.ok && (res.headers.get('content-type') ?? '').includes('html')
      } catch {
        exists = false
      }
      this.reportProbe.set(url, exists)
    }
    // Unmounted, or moved to another day, while the probe was in flight.
    if (token !== this.loadToken || !pane.isConnected) return
    if (!exists) {
      fallback()
      return
    }

    const frame = document.createElement('iframe')
    frame.className = 'kbn-day-paneframe'
    frame.setAttribute('loading', 'lazy')
    frame.setAttribute('scrolling', 'no')
    frame.setAttribute('tabindex', '-1')
    frame.setAttribute('aria-hidden', 'true')
    frame.src = url
    frame.addEventListener('load', () => {
      pane.classList.add('kbn-day-pane-loaded')
    })
    frame.addEventListener('error', fallback)
    body.prepend(frame)
  }

  private disconnectPreviewObserver(): void {
    this.previewObserver?.disconnect()
    this.previewObserver = null
  }

  /**
   * "Still ahead" — what today has not done yet. Only ever present on the rail
   * containing now (see buildStillAhead); a finished day closes with its
   * ledger, because a list of obligations on a day already over is a promise
   * about a future that has resolved.
   */
  private buildStillAheadStrip(items: StillAheadItem[]): HTMLElement {
    const section = document.createElement('section')
    section.className = 'kbn-day-ahead'

    const head = document.createElement('h3')
    head.className = 'kbn-day-narrhead'
    head.textContent = 'still ahead'
    section.append(head)

    const list = document.createElement('div')
    list.className = 'kbn-day-aheaditems'
    for (const item of items) {
      const el = document.createElement('button')
      el.type = 'button'
      el.className = 'kbn-day-aheaditem'
      el.title = item.title
      const glyph = document.createElement('span')
      glyph.className = 'kbn-day-aheadglyph'
      glyph.textContent = item.glyph
      const name = document.createElement('span')
      name.className = 'kbn-day-aheadname'
      name.textContent = item.label
      el.append(glyph, name)
      if (item.when) {
        const when = document.createElement('span')
        when.className = 'kbn-day-aheadwhen'
        when.textContent = item.when
        el.append(when)
      }
      el.addEventListener('click', () => this.ctx?.openCard(item.cardId))
      list.append(el)
    }
    section.append(list)
    return section
  }
}

registerView(new DayViewImpl())
