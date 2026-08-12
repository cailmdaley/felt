/**
 * DayView (hotkey 2) — one day, close up.
 *
 * TWO CLOCKS, ONE LANE. The page is a rail per fiber, read left to right,
 * carrying both of the day's clocks at once:
 *
 *   pale cobalt wash   the agent was working (merged runs of agent minutes)
 *   solid teal block   you were steering (attention minutes — a typed prompt)
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
 * THE RAIL ZOOMS. Which day's events belong to this page is the 06:00 → 06:00
 * civil day and nothing else; how much of that day gets DRAWN is a separate
 * question, and the answer is: only the part that happened. The frame runs from
 * the day's first action to now (on a live day) or to its last action (on a
 * finished one), padded a quarter-hour each side and never shorter than two
 * hours. A day whose work sits between 09:40 and 17:20 spends the whole sheet
 * on those hours instead of on eight inches of empty dawn.
 *
 * Week is the fixed-frame comparator — every row there is the same 24 hours, so
 * rows are comparable at a glance. Day is the close read, so Day zooms and says
 * so with its hour labels, which are real clock times anchored to local
 * midnight (see {@link railTicks}): the same instant lands on the same label
 * whatever the frame, and the label density steps down as the frame widens.
 *
 * DST-honest throughout. The civil day is 06:00 local to 06:00 local of the
 * NEXT day, so it is 23 or 25 hours twice a year, and every position on the
 * page is a fraction of the real span. Never hard-code 1440.
 *
 * WHICH DAY comes from the board's shared temporal cursor (`ctx.focusDate`),
 * not from anything this view remembers. The chevrons and the arrow keys write
 * to the cursor and stop; the refresh that write triggers is what redraws the
 * page. So paging here and pressing `4` opens Week around the same day, and
 * the two views can never drift apart.
 *
 * The join from a bucket to a fiber is the tmux session name and nothing else:
 * a Shuttle worker runs in `<slug>-<ULID>-shuttle`, and that ULID is the
 * fiber's `uid`. Work that does not join to a fiber is a tiny slice of the
 * day and is not drawn: no lane, no ledger entry — its minutes are simply not
 * on this page. The join ladder still refuses to attribute by working
 * directory (see `joinBucketToCard`); it just means unjoined minutes go
 * unshown instead of landing on a directory-named lane.
 *
 * NO COLOUR WITHOUT A MEANING. The board's ink has a grammar and this page
 * spends none of it decoratively: cobalt is agent activity and teal is human
 * steering. Cinnabar appears only as rubric — a section head.
 * Everything else on the page — bullets, rules, hovers, focus rings — is iron
 * gall at some weight. A hue here is a claim, so a hue that means nothing is a
 * claim the data never made.
 */

import { civilDayToLocalDate, dueCivilDay, instantMs, isoDayLocal, railCivilDay } from '../civilDay.js'
import { humanizeIdleAge, phasePillLabel } from '../KanbanSurfaces.js'
import { fileBytesUrl, renderMarkdown } from '../utils.js'
import { normalizeSentFiles, sentFilesInWindow, type SentFile } from '../sentFiles.js'
import type { KanbanCard } from '../KanbanTypes.js'
import {
  buildSessionIndex,
  foldActiveMinutes,
  isOriginStale,
  lookupTmux,
  parseCommitSlug,
  type ActivityBucket,
  type ActivityResult,
  type NarrationCommit,
  type SessionPairing,
  type TemporalOrigins,
} from './TemporalData.js'
import { createViewEmptyState, createViewPage } from './ViewPage.js'
import { cardPathSegments, cardUlids, sessionSlug, sessionUlid } from './sessionNames.js'
import { formatSpanMinutes, railBounds, shiftCivilDay } from './railTime.js'
import {
  ACTIVITY_KEY_ITEMS,
  MARK_GLYPH,
  STATE_GLYPH,
  STATE_KEY_ITEMS,
  STATE_WORD,
  cardState,
  messageClause,
  type LifecycleState,
} from './vocabulary.js'
import {
  keystrokeIsSpokenFor,
  normalizeFocusDate,
  registerView,
  type TemporalView,
  type ViewContext,
} from './ViewRegistry.js'
import {
  clockTime,
  dedupeSources,
  MomentLoader,
  renderTip,
  SLOT_KIND_ORDER,
  SLOT_PHRASE,
  type DrawnKind,
  type MomentSource,
  type MomentWords,
  type SlotTip,
  type SlotTipRow,
} from './momentTip.js'
import './DayView.css'

// ── Shape of a day ───────────────────────────────────────────────────────────

const MINUTE_MS = 60_000
/** Inactive minutes a wash/block span reaches across before it breaks. Five
 *  quiet minutes inside a work run is a pause, not an end. */
const BRIDGE_MINUTES = 5
/** Breathing room the drawn frame keeps outside the day's first and last
 *  action, so the earliest mark is not flush against the sheet's edge. */
export const FRAME_PAD_MINUTES = 15
/** The narrowest frame Day will draw. A day holding one five-minute burst
 *  would otherwise zoom to that burst and magnify a speck into the whole
 *  sheet, which reads as a busy day rather than an almost empty one. */
export const FRAME_MIN_MINUTES = 120

/**
 * The civil day the view opens on: today, unless local now is before 06:00,
 * in which case yesterday — the day this small-hours work grew out of.
 *
 * Delegates to civilDay's `railCivilDay`, which is the ONE definition of the
 * dawn-boundary rule; Week classifies its rows with the same call. Two copies
 * of this rule drifting apart is exactly the defect it exists to prevent.
 */
export function defaultDayISO(nowMs: number): string {
  return railCivilDay(nowMs)
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
  // An unparseable day falls back to today, as it always has — `railBounds`
  // would hand back a zero-length 1970 window and divide the rail by zero.
  const day = civilDayToLocalDate(dayISO) ? dayISO : isoDayLocal(Date.now())
  const { startMs, endMs } = railBounds(day)
  return { startMs, endMs, minutes: Math.round((endMs - startMs) / MINUTE_MS) }
}

/**
 * The part of the civil day the page actually DRAWS: first action → now on the
 * rail that contains this moment, first action → last action on a finished one,
 * padded {@link FRAME_PAD_MINUTES} each side and widened to
 * {@link FRAME_MIN_MINUTES} when the day is too sparse to fill that.
 *
 * Clamped to the rail at both ends, so the frame is always a sub-span of the
 * civil day — the zoom can never smuggle in a minute that belongs to another
 * page. A day with no activity at all keeps the full rail: there is no work to
 * frame, and zooming to nothing would be arbitrary.
 *
 * Every drawn bucket is inside the result by construction (the frame reaches
 * the first and last of them), so nothing is lost by positioning against this
 * rather than against the rail.
 */
export function drawnWindow(
  rail: DayWindow,
  buckets: readonly ActivityBucket[],
  nowMs: number,
): DayWindow {
  let first = Infinity
  let last = -Infinity
  for (const bucket of buckets) {
    if (bucket.m < rail.startMs || bucket.m >= rail.endMs) continue
    if (bucket.m < first) first = bucket.m
    if (bucket.m > last) last = bucket.m
  }
  if (first === Infinity) return rail

  const pad = FRAME_PAD_MINUTES * MINUTE_MS
  const live = nowMs >= rail.startMs && nowMs < rail.endMs
  let startMs = first - pad
  // The last action's own minute is a full minute wide; and a live day runs to
  // now however long ago the last mark was, because the empty stretch between
  // the last action and this moment is itself the day's news.
  let endMs = Math.max(last + MINUTE_MS, live ? nowMs : -Infinity) + pad

  const shortfall = FRAME_MIN_MINUTES * MINUTE_MS - (endMs - startMs)
  if (shortfall > 0) {
    startMs -= shortfall / 2
    endMs += shortfall / 2
  }
  // Overflow at one edge pushes the frame the other way rather than truncating
  // it, so the minimum span survives a burst at dawn or at dusk.
  if (startMs < rail.startMs) {
    endMs += rail.startMs - startMs
    startMs = rail.startMs
  }
  if (endMs > rail.endMs) {
    startMs -= endMs - rail.endMs
    endMs = rail.endMs
  }
  startMs = Math.max(rail.startMs, Math.floor(startMs / MINUTE_MS) * MINUTE_MS)
  endMs = Math.min(rail.endMs, Math.ceil(endMs / MINUTE_MS) * MINUTE_MS)
  return { startMs, endMs, minutes: Math.round((endMs - startMs) / MINUTE_MS) }
}

/** The spacings the hour hand is allowed to use, coarsest last. Half an hour is
 *  the finest: the frame is never shorter than two hours, and a rail ruled at
 *  ten-minute grain would be a chart of its own gridlines. */
const TICK_STEPS_MINUTES = [30, 60, 120, 180, 240, 360, 720]
/** Labels a frame may carry. Six over the full day is the spacing this page has
 *  always used; holding the count fixed is what makes a zoomed frame get
 *  finer marks instead of denser ones. */
const MAX_TICKS = 7

/** The coarsest-to-finest step that keeps a frame of `spanMinutes` under
 *  {@link MAX_TICKS} labels — 4-hourly across a whole day, half-hourly at the
 *  minimum zoom. */
export function tickStepMinutes(spanMinutes: number): number {
  for (const step of TICK_STEPS_MINUTES) {
    if (spanMinutes / step <= MAX_TICKS) return step
  }
  return TICK_STEPS_MINUTES[TICK_STEPS_MINUTES.length - 1]
}

/**
 * The hour hand for a frame: real clock times inside it, ANCHORED TO LOCAL
 * MIDNIGHT rather than to the frame's own edge. Two frames over the same day
 * therefore rule their lines in the same places, and a label always names a
 * round hour of the actual clock instead of an offset from wherever the day's
 * first action happened to fall.
 *
 * Stepped through a local `Date` rather than by adding milliseconds, so a
 * spring-forward frame skips the hour that does not exist instead of labelling
 * it.
 */
export function railTicks(win: DayWindow): { ms: number; label: string }[] {
  const step = tickStepMinutes(win.minutes)
  const cursor = new Date(win.startMs)
  cursor.setHours(0, 0, 0, 0)
  const out: { ms: number; label: string }[] = []
  // Bounded: the walk starts at most 25 hours before the frame and the finest
  // step is half an hour, so this can never be the loop that runs away.
  for (let guard = 0; guard < 512; guard += 1) {
    const ms = cursor.getTime()
    if (ms >= win.endMs) break
    if (ms >= win.startMs) {
      out.push({ ms, label: step < 60 ? formatClockTime(ms) : formatHourTick(ms) })
    }
    cursor.setMinutes(cursor.getMinutes() + step)
  }
  return out
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

// ── Narration ────────────────────────────────────────────────────────────────

/**
 * The civil days to ASK narration for, to cover a 06:00→06:00 rail.
 *
 * Both daemon routes take instants. The asymmetry is one layer up, in what
 * `TemporalData` accepts: `activity` is asked in instants and gets the rail
 * exactly, while `narration` is asked in INCLUSIVE CIVIL DAYS — the unit a
 * temporal view thinks in — and resolves them to midnight-to-midnight local
 * instants itself. So asking it for `(day, day)` returns 00:00–06:00 of the
 * day (which belongs to YESTERDAY's rail) and misses 00:00–06:00 of the next
 * day (which belongs to THIS one). On a store whose author works past midnight
 * that is not an edge case: those commits are the end of the session the rail
 * is drawing, and they would land a page early while the fiber that made them
 * got an outcome fallback saying it "worked, wrote nothing down".
 *
 * So: widen by a day and discard by the rail's real edges
 * ({@link commitsOnRail}).
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
    if (!commit.subject.trim()) continue
    const { slug, rest } = parseCommitSlug(commit.subject)
    if (!slug) {
      loose.push(rest)
      continue
    }
    let bucket = bySlug.get(slug)
    if (!bucket) {
      bucket = []
      bySlug.set(slug, bucket)
      order.push(slug)
    }
    bucket.push(rest)
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
  /** The fiber's own name. */
  label: string
  /**
   * Where this lane's WORK ran, lower-cased, or '' when nothing said.
   *
   * Taken from the activity buckets that built the lane — the composite stamps
   * every bucket with the daemon whose events file produced it, so this is a
   * recorded fact about the minutes drawn rather than an inference from the
   * card. A card's `shuttleHost` stands in only when no bucket carried a host
   * (an old daemon, or a mock), because that is the board's own claim about
   * where the fiber's worker lives and it is better than nothing.
   */
  host: string
  /**
   * The host to print beside the label — set ONLY when this lane ran somewhere
   * other than the host the page is reading. Every lane wearing the same
   * hostname is a constant repeated once per row, which reads as information
   * and is not; a hostname that appears means "this one ran elsewhere".
   */
  hostNote: string
  /**
   * True when the lane's host is an origin the composite reports STALE — its
   * daemon is unreachable and what is drawn is that origin's last-good read.
   * The rail still draws: the minutes happened, and hiding them would be a
   * bigger lie than dimming them. Same register as a stale card on the Desk.
   */
  stale: boolean
  /** Where the fiber stands, drawn as a glyph before the lane's name. */
  state: LifecycleState
  /** Board card id, when the lane joined to one — the click target. */
  cardId?: string
  /** Slugs this lane answers to when matching commit prefixes. */
  slugs: string[]
  agent: MinuteRun[]
  attention: MinuteRun[]
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
  /**
   * Messages you sent to this fiber today — the sum of `n` over its attention
   * buckets, and what the ledger row reports as "you 14 msgs".
   *
   * Summed, not counted per minute, deliberately: three prompts in one minute
   * are three messages. That is the opposite rule from `attentionMinutes`
   * above, and it has to be — one measures time, this one measures acts.
   */
  attentionMessages: number
  /** Messages this fiber sent BACK today — the sum of `n` over its `k:
   *  "reply"` buckets. Counted as acts for the same reason `attentionMessages`
   *  is: the two halves of an exchange must be in the same unit to be read as
   *  one. Zero on a daemon that does not emit the kind. */
  replyMessages: number
  /** Distinct active minutes, of any kind — the lane's weight. */
  weight: number
  /**
   * What actually happened, minute by minute, oldest first — the HOVER's ground
   * truth.
   *
   * The runs above are drawing spans: they bridge up to five idle minutes so a
   * work run reads as one stroke. Perfect for ink, useless for a tooltip, which
   * must never report a bridged minute as work. So the beats are kept
   * unmerged, each carrying its own counts and its own transcripts.
   */
  beats: DayBeat[]
}

/** One minute of a lane: what happened in it, and where its words are. */
export interface DayBeat {
  /** Index into the day window, as the rail measures it. */
  minute: number
  kinds: { kind: ActivityBucket['k']; count: number }[]
  /** The transcripts behind this minute — what the hover asks
   *  `/api/v1/moment` for. Empty when the minute joined no recorded session. */
  sources: MomentSource[]
}

export interface DayTotals {
  /** Minutes containing at least one attention bucket, over the whole day. */
  attention: number
  /** Minutes containing at least one agent bucket, over the whole day. */
  agent: number
  /** Messages you sent — see {@link countExchange}. */
  messages: number
  /** Messages you got back: the sum of `n` over the day's `k: "reply"`
   *  buckets, one per finished agent turn. Zero on a daemon too old to emit
   *  the kind, which the header reads as "say nothing" rather than "nothing
   *  was said" — see `messageClause`. */
  received: number
}

/**
 * THE EXCHANGE — messages sent and messages back, not minutes attended. The
 * conversational half of the day, counted the way a human counts it.
 *
 * An attention bucket is a minute in which you typed at a worker, and `n` is
 * how many prompts landed in it. Minutes were the wrong unit for that: a minute
 * is what the AGENT spends, and reporting your side in the same unit invited
 * the comparison "you 38m · agents 2h 10m", which reads as a productivity
 * ratio and is not one — you are not idle in the 2h 10m, you are elsewhere.
 * Messages are a count of things you actually did, and they do not pretend to
 * be time.
 *
 * Positions on the rail are untouched by this: the ticks still mark the minutes
 * the buckets name. Only the unit in the prose changed.
 */
export function countExchange(
  buckets: readonly ActivityBucket[],
  win: DayWindow,
): { sent: number; received: number } {
  let sent = 0
  let received = 0
  for (const bucket of buckets) {
    if (bucket.m < win.startMs || bucket.m >= win.endMs) continue
    if (bucket.k === 'attention') sent += bucket.n
    // A reply is the same kind of thing counted the same way: an act, not a
    // span. The agent's minutes are already reported as time beside it.
    else if (bucket.k === 'reply') received += bucket.n
  }
  return { sent, received }
}

/** What the whole day cost: agent minutes, attention minutes (still the rail's
 *  own measure) and the exchange across every fiber. */
export function dayTotals(activity: ActivityResult, win: DayWindow): DayTotals {
  const { attention, agent } = foldActiveMinutes(activity.buckets, {
    fromMs: win.startMs,
    toMs: win.endMs,
  })
  const { sent, received } = countExchange(activity.buckets, win)
  return { attention, agent, messages: sent, received }
}

function minuteIndex(ms: number, win: DayWindow): number | null {
  const index = Math.floor((ms - win.startMs) / MINUTE_MS)
  if (index < 0 || index >= win.minutes) return null
  return index
}

/**
 * The slug a fiber answers to WHEN MATCHING A COMMIT PREFIX: the leaf of its
 * id, and nothing else.
 *
 * Deliberately narrower than `cardPathSegments` (./sessionNames.js), which the
 * activity join uses. A `felt: …` commit prefix names the fiber whose leaf is
 * `felt`, not every fiber that happens to live under `felt/` — widening this
 * would make one parent directory swallow the narration of everything beneath
 * it.
 */
export function commitSlugsForCard(card: KanbanCard): string[] {
  const tail = card.id.split('/').filter(Boolean).pop()
  return tail ? [tail.toLowerCase()] : []
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
 * ChronicleView runs, over the shared vocabulary in `./sessionNames.js` — a
 * leaf module both views import, so neither reaches into the other.
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
  bucket: Pick<ActivityBucket, 's' | 'host'>,
  index: JoinIndex,
): KanbanCard | null {
  if (bucket.s) {
    // 0. What the daemon recorded. Both halves of the pairing are tried: the
    // ULID is identity, while the fiber id is a path that can be moved out from
    // under one.
    //
    // HOST-SCOPED. A tmux name is unique only within a host, and this ledger is
    // now several daemons' merged: two machines each running `run-shuttle`
    // would otherwise let either claim the other's minutes. `lookupTmux` tries
    // the scoped key first and falls back to the bare name only for a bucket
    // that cannot say where it ran.
    const pairing = index.byTmux ? lookupTmux(index.byTmux, bucket.host, bucket.s) : undefined
    if (pairing) {
      const byFiber = index.byId.get(pairing.fiber)
      if (byFiber) return byFiber
      const uid = pairing.uid?.trim().toUpperCase()
      const byUid = uid ? index.byUlid.get(uid) : undefined
      if (byUid) return byUid
    }
    const worker = index.byWorker.get(bucket.s)
    if (worker) return worker
    const ulid = sessionUlid(bucket.s)
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

/** One host's claim on a lane: how many of its buckets, and how recent. */
interface HostTally {
  count: number
  last: number
}

/**
 * Which host a lane ran on, from the buckets that built it.
 *
 * The buckets of one lane should agree — a fiber's worker runs on one machine
 * — but nothing enforces it: a fiber worked on two machines in one day, or a
 * tmux name colliding across hosts, both produce a mixed lane. So the tally is
 * kept honest rather than assumed: the host with the MOST minutes wins, ties
 * broken by whichever was seen most recently. Picking arbitrarily would make a
 * one-bucket stray rename the whole lane.
 */
function dominantHost(hosts: ReadonlyMap<string, HostTally>): string {
  let best = ''
  let bestTally: HostTally | null = null
  for (const [host, tally] of hosts) {
    if (
      !bestTally ||
      tally.count > bestTally.count ||
      (tally.count === bestTally.count && tally.last > bestTally.last)
    ) {
      best = host
      bestTally = tally
    }
  }
  return best
}

/**
 * Origins keyed by LOWER-CASED name. Lane hosts are lower-cased for display
 * (hostnames are case-insensitive and a rail full of `Cineca-Login-02` beside
 * `cineca-login-02` would read as two machines), so the staleness lookup has to
 * meet them there rather than miss on case alone.
 */
function foldOrigins(origins: TemporalOrigins | undefined): TemporalOrigins {
  const out: TemporalOrigins = {}
  for (const [name, origin] of Object.entries(origins ?? {})) {
    const key = name.trim().toLowerCase()
    if (!key) continue
    const held = out[key]
    // Stale wins a collision: if any spelling of this host is waiting, the
    // honest answer for the host is "waiting".
    out[key] = held?.stale ? held : origin
  }
  return out
}

/**
 * One lane per fiber that was active in the window. Buckets that joined to no
 * fiber are skipped entirely — un-fibered work is a tiny slice of the day and
 * is not worth a lane of its own. Lanes sort by weight, the day's heaviest
 * work reading first.
 *
 * `origins` is the composite's freshness block — activity's, merged with the
 * ledger's by the caller. A lane whose host it reports stale is marked, and the
 * view dims it. A `window` narrower than the rail is NOT marked: an origin that
 * only cached part of the day is answering honestly, and its data simply thins
 * out where it has none.
 */
export function buildDayLanes(
  activity: ActivityResult,
  cards: KanbanCard[],
  win: DayWindow,
  byTmux?: ReadonlyMap<string, SessionPairing>,
  origins: TemporalOrigins = activity.origins ?? {},
): DayLane[] {
  const index = buildJoinIndex(cards, byTmux)
  const pageHost = (activity.host ?? '').toLowerCase()
  const folded = foldOrigins(origins)

  interface Acc {
    lane: Omit<
      DayLane,
      | 'agent'
      | 'attention'
      | 'attentionMinutes'
      | 'agentMinutes'
      | 'attentionMessages'
      | 'replyMessages'
      | 'weight'
      | 'beats'
      | 'host'
      | 'hostNote'
      | 'stale'
    >
    /** The card's own claim, the fallback when no bucket carries a host. */
    cardHost: string
    hosts: Map<string, HostTally>
    agent: Set<number>
    attention: Set<number>
    all: Set<number>
    /** Attention EVENTS, summed — see `DayLane.attentionMessages`. */
    messages: number
    /** Reply EVENTS, summed — see `DayLane.replyMessages`. */
    replies: number
    /** Per-minute counts and transcripts, unmerged — see `DayLane.beats`. */
    beats: Map<number, { kinds: Map<ActivityBucket['k'], number>; sources: (MomentSource | null)[] }>
  }
  const acc = new Map<string, Acc>()

  for (const bucket of activity.buckets) {
    const minute = minuteIndex(bucket.m, win)
    if (minute === null) continue
    const card = joinBucketToCard(bucket, index)
    // A bucket that joined to no fiber is not drawn — see the module doc.
    if (!card) continue
    // Notify is not a drawn state. It is dropped at ingest rather than at
    // paint time so a minute of pure nudge cannot give a lane weight, a beat,
    // or a tooltip row it has nothing to say in.
    if (bucket.k === 'notify') continue
    const key = `fiber:${card.id}`
    let entry = acc.get(key)
    if (!entry) {
      entry = {
        lane: {
          key,
          label: card.name,
          state: cardState(card),
          cardId: card.id,
          slugs: commitSlugsForCard(card),
        },
        cardHost: (card.shuttleHost ?? '').trim().toLowerCase(),
        hosts: new Map(),
        agent: new Set(),
        attention: new Set(),
        all: new Set(),
        messages: 0,
        replies: 0,
        beats: new Map(),
      }
      acc.set(key, entry)
    }
    const host = (bucket.host ?? '').trim().toLowerCase()
    if (host) {
      const tally = entry.hosts.get(host)
      if (tally) {
        tally.count += 1
        if (bucket.m > tally.last) tally.last = bucket.m
      } else entry.hosts.set(host, { count: 1, last: bucket.m })
    }
    entry.all.add(minute)
    if (bucket.k === 'agent') entry.agent.add(minute)
    else if (bucket.k === 'attention') {
      entry.attention.add(minute)
      entry.messages += bucket.n
    } else if (bucket.k === 'reply') entry.replies += bucket.n

    let beat = entry.beats.get(minute)
    if (!beat) {
      beat = { kinds: new Map(), sources: [] }
      entry.beats.set(minute, beat)
    }
    beat.kinds.set(bucket.k, (beat.kinds.get(bucket.k) ?? 0) + bucket.n)
    // Rung 0 again, for a different purpose: the pairing that names this
    // minute's fiber also names the session whose transcript holds its words.
    const pairing = byTmux ? lookupTmux(byTmux, bucket.host, bucket.s) : undefined
    beat.sources.push(
      pairing?.session ? { session: pairing.session, host: bucket.host ?? pairing.host ?? null } : null,
    )
  }

  const lanes: DayLane[] = [...acc.values()].map((entry) => {
    const host = dominantHost(entry.hosts) || entry.cardHost
    return {
      ...entry.lane,
      host,
      hostNote: host && host !== pageHost ? host : '',
      stale: isOriginStale(folded, host || null),
      agent: mergeMinuteRuns(entry.agent),
      attention: mergeMinuteRuns(entry.attention),
      attentionMinutes: entry.attention.size,
      agentMinutes: entry.agent.size,
      attentionMessages: entry.messages,
      replyMessages: entry.replies,
      weight: entry.all.size,
      beats: [...entry.beats.entries()]
        .map(([minute, beat]) => ({
          minute,
          kinds: [...beat.kinds.entries()].map(([kind, count]) => ({ kind, count })),
          sources: dedupeSources(beat.sources),
        }))
        .sort((a, b) => a.minute - b.minute),
    }
  })

  lanes.sort((a, b) => {
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
  /** ◐ a standing role's next firing · ◴ something owed today. See vocabulary.ts. */
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
        glyph: MARK_GLYPH.launch,
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
        glyph: MARK_GLYPH.due,
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
export function buildDayPreviews(
  lanes: DayLane[],
  cards: KanbanCard[],
  shuttleBase: string,
): DayPreview[] {
  const cardById = new Map(cards.map((card) => [card.id, card]))
  const out: DayPreview[] = []
  for (const lane of lanes) {
    if (!lane.cardId) continue
    const card = cardById.get(lane.cardId)
    if (!card) continue
    out.push({
      key: `preview:${lane.cardId}`,
      cardId: lane.cardId,
      label: lane.label,
      reportUrl: card.fiberDir
        ? fileBytesUrl(shuttleBase, `${card.fiberDir}/${REPORT_FILENAME}`, card.originId)
        : undefined,
      outcome: card.outcome ?? '',
      originId: card.originId,
    })
  }
  return out
}

export interface DayEntryStats {
  /** Messages you sent this fiber today. Your half of the day is COUNTED, not
   *  timed — see {@link countMessages}. */
  messages: number
  /** Minutes its agents were working. Theirs still is time. */
  agent: number
  /** Messages it sent BACK — the lane's `k: "reply"` buckets. Zero, not
   *  absent, whenever a lane was built: a daemon that emits no replies and a
   *  fiber that sent none are the same claim, and `formatEntryStats` drops the
   *  clause either way. Optional only for the entries with no lane behind
   *  them. */
  received?: number
  commits: number
}

/** `you 14 · 9 back · agents 2h 10m · 3 commits`, with empty terms dropped
 *  rather than printed as zeros — a row of `0`s is noise, not information. */
export function formatEntryStats(stats: DayEntryStats): string {
  const parts: string[] = []
  const received = stats.received ?? 0
  if (stats.messages > 0 || received > 0) {
    parts.push(messageClause(stats.messages, received))
  }
  if (stats.agent > 0) parts.push(`agents ${formatSpanMinutes(stats.agent, { pad: true })}`)
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
  /** The fiber's ULID and origin — what `/api/v1/sent-files` is asked with,
   *  after render, for the day's deliverables. Absent on a row with no card,
   *  and on a card the feed carries no uid for (nothing to ask). */
  uid?: string
  originId?: string
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
    const subjects = subjectsForLane.get(lane.key)
    const card = lane.cardId ? cardById.get(lane.cardId) : undefined
    const operational = {
      cardId: lane.cardId,
      uid: typeof card?.uid === 'string' && card.uid.trim() ? card.uid.trim() : undefined,
      originId: card?.originId,
      // A chip is a claim about THIS MOMENT — "there is a worker in the air".
      // On a past day that claim is false however true it is right now, so the
      // chip belongs only to the rail that contains now. The stats below are
      // the opposite kind of fact (what this day cost) and stay on every day.
      chip: isLiveRail ? laneChip(card, nowMs) : undefined,
      closed: closureMark(card, win),
      stats: {
        messages: lane.attentionMessages,
        received: lane.replyMessages,
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
  /** The civil day: 06:00 → 06:00. What BELONGS to this page — commits,
   *  closures, obligations are all judged against it. */
  window: DayWindow
  /** The part of it that gets drawn. Every position on the chart — marks,
   *  gridlines, hour labels, the now-thread, the hover's minute arithmetic —
   *  is a fraction of THIS. See {@link drawnWindow}. */
  frame: DayWindow
  /** Obligations between now and the end of THIS rail. Empty on a past day. */
  stillAhead: StillAheadItem[]
  /** One pane per fiber lane — its report, or its outcome. */
  previews: DayPreview[]
  /** How many tmux pairings the ledger offered — for the render signature. */
  ledgerSize: number
  /** The host this page's activity came from — printed once, in the head. */
  host: string
  /** Per-origin freshness over both feeds — what the lanes' `stale` reads. */
  origins: TemporalOrigins
  totals: DayTotals
  lanes: DayLane[]
  entries: DayEntry[]
}

/**
 * Two freshness blocks over the same fleet, read as one. An origin either feed
 * reports stale IS stale: the lanes are built from both files, so a host whose
 * activity is current but whose ledger is not is still a host we are waiting on.
 */
export function mergeOrigins(
  a: TemporalOrigins | undefined,
  b: TemporalOrigins | undefined,
): TemporalOrigins {
  const out: TemporalOrigins = { ...(a ?? {}) }
  for (const [name, origin] of Object.entries(b ?? {})) {
    const held = out[name]
    if (!held || (origin.stale && !held.stale)) out[name] = origin
  }
  return out
}

export function buildDayModel(
  dayISO: string,
  activity: ActivityResult,
  commits: NarrationCommit[],
  cards: KanbanCard[],
  shuttleBase: string,
  nowMs: number = Date.now(),
  byTmux?: ReadonlyMap<string, SessionPairing>,
  /** The LEDGER's origins block; activity's rides on `activity` itself. */
  sessionOrigins?: TemporalOrigins,
): DayModel {
  const win = dayWindow(dayISO)
  // The lanes are built against the FRAME, so a lane's minute indices are
  // already the coordinates the chart draws in. Nothing is lost: the frame
  // reaches every bucket the rail holds.
  const frame = drawnWindow(win, activity.buckets, nowMs)
  const origins = mergeOrigins(activity.origins, sessionOrigins)
  const lanes = buildDayLanes(activity, cards, frame, byTmux, origins)
  return {
    dayISO,
    window: win,
    frame,
    host: (activity.host ?? '').toLowerCase(),
    origins,
    totals: dayTotals(activity, win),
    lanes,
    // The commits are the widened civil-day range; the rail decides which of
    // them are this day's. Filtering here rather than at the call site keeps
    // every caller of buildDayModel honest.
    entries: buildDayEntries(commitsOnRail(commits, win), lanes, cards, win, nowMs),
    stillAhead: buildStillAhead(cards, dayISO, win, nowMs),
    previews: buildDayPreviews(lanes, cards, shuttleBase),
    ledgerSize: byTmux?.size ?? 0,
  }
}

/** Cheap structural fingerprint — the refresh path rebuilds the DOM only when
 *  this changes, so a 15s poll over an unchanged day is a no-op. */
export function dayModelSignature(model: DayModel): string {
  const lanes = model.lanes
    .map(
      (lane) =>
        `${lane.key}|${lane.label}|${lane.state}|${lane.hostNote}|${lane.stale ? 'stale' : ''}|${lane.weight}|` +
        `${lane.agent.map((r) => `${r.start}-${r.end}`).join(',')}|` +
        `${lane.attention.map((r) => `${r.start}-${r.end}`).join(',')}`,
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
  // The frame rides the signature — every mark's position is a fraction of it,
  // so a frame that moved is a page that must repaint even when the lanes are
  // unchanged. QUANTIZED TO FIVE MINUTES because a live day's frame ends at
  // `now`: at full precision this would differ on every poll and rebuild the
  // whole page every fifteen seconds to slide the ink by a hair.
  const grain = 5 * MINUTE_MS
  const frame =
    `frame:${Math.floor(model.frame.startMs / grain)}-${Math.floor(model.frame.endMs / grain)}`
  return (
    `${model.dayISO}\n${model.totals.messages}/${model.totals.received}/${model.totals.agent}\n` +
    `${lanes}\n${entries}\n${ahead}\n${ledger}\n${frame}`
  )
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

/** Day's own mark for each activity kind — the same pigments the shared key
 *  names, drawn as this view draws them. */
const DAY_KEY_CLASS: Record<DrawnKind, string> = {
  agent: 'kbn-day-key-wash',
  attention: 'kbn-day-key-att',
  // A reply is agent-side ink; it wears the wash, never its own mark.
  reply: 'kbn-day-key-wash',
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

/** The state group in Day's key: every glyph and its word, one line. The
 *  pigments are the lane gutter's own, so the key cannot drift from the marks
 *  it explains. */
function buildStateKey(): HTMLElement {
  const item = document.createElement('span')
  item.className = 'kbn-day-key kbn-day-key-states'
  for (const state of STATE_KEY_ITEMS) {
    const pair = document.createElement('span')
    pair.className = 'kbn-day-key-state'
    const glyph = document.createElement('i')
    glyph.className = `kbn-day-stateglyph kbn-state-${state}`
    glyph.textContent = STATE_GLYPH[state]
    pair.append(glyph, document.createTextNode(STATE_WORD[state]))
    item.append(pair)
  }
  return item
}

/** Pixels a pointer may be from a minute and still be asking about it. Day's
 *  rails are wide — a whole day across the sheet — so the snap is generous
 *  enough that the marks are hoverable rather than a game of aim. */
const BEAT_SNAP_PX = 9

/**
 * One lane-minute as words, in the shared tooltip's shape.
 *
 * The `where` on every row is the lane's own name, because on Day the lane IS
 * the attribution — the rail you are pointing at is already labelled with the
 * fiber, so the row says which pigment and how much, and the label says who.
 */
export function beatTip(
  lane: DayLane,
  beat: DayBeat,
  win: DayWindow,
  words?: MomentWords,
): SlotTip {
  const startMs = win.startMs + beat.minute * MINUTE_MS
  const rows: SlotTipRow[] = []
  for (const kind of SLOT_KIND_ORDER) {
    const entry = beat.kinds.find((k) => k.kind === kind)
    if (!entry) continue
    rows.push({
      kind,
      phrase: SLOT_PHRASE[kind],
      where: lane.label,
      count: entry.count,
      // Day has no constitution stroke on its rails, so nothing here may claim
      // one: the flag exists to explain a mark's weight, and an unweighted mark
      // that wore it would be the legend lying.
      shuttle: false,
    })
  }
  return {
    time: `${clockTime(startMs)}–${clockTime(startMs + MINUTE_MS)}`,
    rows,
    ...(words?.excerpts.length ? { detail: words.excerpts } : {}),
    ...(words?.note ? { note: words.note } : {}),
  }
}

class DayViewImpl implements TemporalView {
  readonly id = 'day' as const
  readonly title = 'Day'
  readonly hotkey = '2'

  private root: HTMLElement | null = null
  private headingEl: HTMLElement | null = null
  private statsEl: HTMLElement | null = null
  private bodyEl: HTMLElement | null = null
  /** The now-thread, when the shown day is the one containing this moment. */
  private nowEl: HTMLElement | null = null
  /** The back-to-today control, hidden while today is what you are looking at. */
  private todayEl: HTMLButtonElement | null = null
  /**
   * The hover tooltip and the words behind it — the same slip of paper Week
   * draws, from the same module (momentTip.ts). Parented to the chart so it
   * positions against the rails.
   */
  private chartEl: HTMLElement | null = null
  private tip: HTMLElement | null = null
  /** The lane-minute the pointer is on (`<lane key>:<minute>`); a late answer
   *  is checked against it before it paints. */
  private hoveredKey: string | null = null
  private moments = new MomentLoader((session, fromMs, toMs, host) =>
    this.ctx
      ? this.ctx.moment(session, fromMs, toMs, host)
      : Promise.resolve({ host: host ?? '', excerpts: [] }),
  )

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
  /** The window the CHART is drawn in — the model's frame, held because the
   *  now-thread slides between renders and must slide against the same
   *  coordinates the ink was laid in. Null until a chart exists. */
  private frame: DayWindow | null = null
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
    this.frame = null
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
    const win = this.frame
    if (!el || !win) return
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
      ctx.shuttleBase,
      Date.now(),
      this.byTmux,
      sessions.origins,
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
        `${messageClause(model.totals.messages, model.totals.received)}` +
        ` · agents ${formatSpanMinutes(model.totals.agent, { pad: true })}`
      this.statsEl.classList.toggle('kbn-day-stats-quiet', model.lanes.length === 0)
    }

    // Lift the strip out before the body is emptied: `textContent = ''` would
    // destroy its iframes, and they are the one part of this page that is
    // expensive to rebuild.
    this.previewsEl?.remove()
    body.textContent = ''
    // No chart until one is built; a stale frame would let the now-thread of a
    // page that has none slide against a window nothing is drawn in.
    this.frame = null
    this.nowEl = null
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
    const win = model.frame
    this.frame = win
    const span = win.endMs - win.startMs
    const chart = document.createElement('div')
    chart.className = 'kbn-day-chart'
    this.chartEl = chart
    this.tip = null
    this.hoveredKey = null
    this.moments.cancel()

    // One gridline layer behind every rail, so the hour rules run unbroken
    // down the whole stack instead of restarting per lane.
    const grid = document.createElement('div')
    grid.className = 'kbn-day-grid'
    grid.style.gridRow = `1 / span ${model.lanes.length}`
    // One line per LABELLED tick, so the rules and the hour hand under them
    // agree; the edges are skipped, where a line would just thicken the frame.
    const ticks = railTicks(win)
    for (const tick of ticks) {
      const fraction = (tick.ms - win.startMs) / span
      if (fraction <= 0.001 || fraction >= 0.999) continue
      const line = document.createElement('i')
      line.className = 'kbn-day-gridline'
      line.style.left = pct(fraction)
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
      // The Desk's own stale register, verbatim — a lane whose daemon is
      // unreachable must not look like a second kind of "not quite here".
      label.className = `kbn-day-label${lane.stale ? ' kbn-card--stale' : ''}`
      label.style.gridRow = row
      // The state, ahead of the name — outside the click target for the same
      // reason Chronicle keeps it outside: the button opens the card, and a
      // glyph inside it would read as part of the fiber's title.
      const state = document.createElement('span')
      state.className = `kbn-day-lanestate kbn-state-${lane.state}`
      state.textContent = STATE_GLYPH[lane.state]
      state.title = STATE_WORD[lane.state]
      state.setAttribute('aria-label', STATE_WORD[lane.state])
      state.setAttribute('role', 'img')
      label.append(state)

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
      if (lane.stale && lane.host) {
        // Same badge and the same words the Desk puts on a stale card. The
        // rail still draws underneath it: those minutes happened, and what is
        // shown is that origin's last-good read, not a guess.
        const waiting = document.createElement('span')
        waiting.className = 'kbn-card-waiting kbn-day-lanewaiting'
        waiting.textContent = `⌛ waiting on ${lane.host}`
        waiting.title = `${lane.host} is unreachable — this rail is its last-known read`
        label.append(waiting)
      }

      const rail = document.createElement('div')
      rail.className = `kbn-day-rail${lane.stale ? ' kbn-card--stale' : ''}`
      rail.style.gridRow = row
      for (const run of lane.agent) rail.append(this.buildMark('kbn-day-wash', run, win))
      for (const run of lane.attention) rail.append(this.buildMark('kbn-day-att', run, win))

      rail.addEventListener('mousemove', (e) => this.showBeatTip(lane, rail, win, e))
      rail.addEventListener('mouseleave', () => this.hideTip())

      chart.append(label, rail)
    })

    // The hour hand, once, under every lane.
    const axis = document.createElement('div')
    axis.className = 'kbn-day-axis'
    axis.style.gridRow = String(model.lanes.length + 1)
    for (const { ms, label } of ticks) {
      const tick = document.createElement('span')
      tick.className = 'kbn-day-tick'
      tick.textContent = label
      const fraction = (ms - win.startMs) / span
      // A label landing within a hair of either edge is pulled inboard rather
      // than centred, so it cannot hang off the sheet.
      if (fraction <= 0.02) tick.classList.add('kbn-day-tick-first')
      else if (fraction >= 0.98) tick.classList.add('kbn-day-tick-last')
      tick.style.left = pct(Math.min(Math.max(fraction, 0), 1))
      axis.append(tick)
    }
    chart.append(axis)

    // The key. A page whose pigments need a narrator is as unfinished as one
    // whose pigments mean nothing — "I don't know what the blue, red and green
    // are" is a fair complaint about a grammar that is never stated. So it is
    // stated, once, in the margin under the rails it explains: a caption, not
    // a legend box, and only on a page that actually drew the marks.
    //
    // The GLYPHS are each view's own marks in miniature, which is why they are
    // shapes rather than uniform swatches — the key teaches the height
    // hierarchy (wash, then block, then tick) at the same time.
    const legend = document.createElement('div')
    legend.className = 'kbn-day-legend'
    legend.style.gridRow = String(model.lanes.length + 2)
    legend.append(
      ...ACTIVITY_KEY_ITEMS.map(({ kind, label }) => buildKey(DAY_KEY_CLASS[kind], label)),
      buildStateKey(),
    )
    chart.append(legend)
    return chart
  }

  // ── Hover ──────────────────────────────────────────────────────────────────

  /**
   * Report the lane-minute under the pointer, or nothing.
   *
   * SNAPS to the nearest BEAT rather than hit-testing the ink. Two reasons, and
   * the second is the important one: the ink can be a hairline nobody can land
   * on, and the washes are merged runs that bridge idle minutes — so
   * hit-testing the drawn mark would happily report a minute in which nothing
   * happened. The beats are the unmerged record, so snapping to them can only
   * name a minute that is real. Empty rail — no beat within
   * {@link BEAT_SNAP_PX} — hides the tooltip rather than answering about the
   * nearest work on the row.
   */
  private showBeatTip(lane: DayLane, rail: HTMLElement, win: DayWindow, e: MouseEvent): void {
    const chart = this.chartEl
    if (!chart || lane.beats.length === 0) return this.hideTip()
    const box = rail.getBoundingClientRect()
    if (box.width <= 0 || win.minutes <= 0) return this.hideTip()

    const perMinute = box.width / win.minutes
    const x = e.clientX - box.left
    let best: DayBeat | null = null
    let bestPx = Infinity
    for (const beat of lane.beats) {
      const px = Math.abs((beat.minute + 0.5) * perMinute - x)
      if (px < bestPx) {
        bestPx = px
        best = beat
      }
    }
    if (!best || bestPx > BEAT_SNAP_PX) return this.hideTip()

    const beat = best
    const startMs = win.startMs + beat.minute * MINUTE_MS
    const tip = this.ensureTip()
    const key = `${lane.key}:${beat.minute}`
    renderTip(tip, beatTip(lane, beat, win, this.moments.peek(key)))
    // The words arrive late or not at all; the tooltip is already correct
    // without them, and redraws in place when they land.
    this.moments.request(key, beat.sources, startMs, startMs + MINUTE_MS, (words) => {
      if (this.hoveredKey !== key) return
      renderTip(tip, beatTip(lane, beat, win, words))
    })
    this.hoveredKey = key
    tip.classList.add('kbn-tip-open')

    // Positioned against the chart, and flipped past the right edge so a late
    // minute does not push the slip off the sheet.
    const chartBox = chart.getBoundingClientRect()
    const anchor = box.left - chartBox.left + (beat.minute + 0.5) * perMinute
    const flip = anchor > chartBox.width * 0.62
    tip.style.top = `${box.top - chartBox.top}px`
    tip.classList.toggle('kbn-tip-flip', flip)
    tip.style.left = flip ? 'auto' : `${anchor + 9}px`
    tip.style.right = flip ? `${chartBox.width - anchor + 9}px` : 'auto'
  }

  private ensureTip(): HTMLElement {
    if (this.tip?.isConnected) return this.tip
    const tip = document.createElement('div')
    tip.className = 'kbn-tip'
    this.chartEl?.append(tip)
    this.tip = tip
    return tip
  }

  private hideTip(): void {
    this.tip?.classList.remove('kbn-tip-open')
    this.hoveredKey = null
    this.moments.cancel()
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
      // The deliverables come from a second call, per fiber, after the ledger
      // is on screen — the same manner as the moment tooltips. The ledger must
      // not wait on them, and a fiber that sent nothing (the common case) must
      // cost nothing to say so.
      if (entry.uid) void this.attachSentFiles(item, entry, model.window)
    }
    section.append(list)
    return section
  }

  /**
   * Hang today's sent files off one ledger row.
   *
   * Degrades to silence at every step it can fail: no board context, an older
   * daemon with no `/api/v1/sent-files` route, a network error, a fiber whose
   * whole trail predates this day. A row that says nothing about deliverables
   * is the honest rendering of "we could not ask" and of "there were none"
   * alike — a visible empty slot would claim to distinguish them.
   */
  private async attachSentFiles(
    item: HTMLElement,
    entry: DayEntry,
    win: DayWindow,
  ): Promise<void> {
    const ctx = this.ctx
    if (!ctx || !entry.uid) return
    const params = new URLSearchParams({ uid: entry.uid })
    if (entry.originId) params.set('origin', entry.originId)
    let files: SentFile[]
    try {
      const res = await fetch(`${ctx.shuttleBase}/api/v1/sent-files?${params.toString()}`)
      if (!res.ok) return
      const data = (await res.json()) as { files?: unknown }
      files = sentFilesInWindow(normalizeSentFiles(data.files), win.startMs, win.endMs)
    } catch {
      return
    }
    // The page may have moved to another day, or re-rendered, while the call
    // was in flight — the row we were handed is then no longer on it.
    if (files.length === 0 || !item.isConnected) return

    const row = document.createElement('div')
    row.className = 'kbn-day-entryfiles'
    for (const file of files) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'kbn-day-file'
      chip.textContent = file.basename
      chip.title = file.fullPath
      chip.setAttribute('aria-label', `${file.basename} — open`)
      chip.addEventListener('click', (e) => {
        e.stopPropagation()
        window.open(
          fileBytesUrl(ctx.shuttleBase, file.fullPath, entry.originId ?? ''),
          '_blank',
          'noopener',
        )
      })
      row.append(chip)
    }
    item.append(row)
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
    // ten-fiber day does not open ten reports at once. Against the VIEWPORT,
    // not the strip — the strip wraps and scrolls nothing of its own, so
    // rooting the observer there would call every pane visible at once and
    // undo the staging.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          observer.unobserve(entry.target)
          void this.hydratePane(entry.target as HTMLElement)
        }
      },
      { rootMargin: '200px' },
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

      // The whole plate is the way in. It sits UNDER the outcome prose (which
      // is click-through except for its own links) and OVER the frame, which is
      // inert by design — so a pane reads as one target however it is filled.
      const hit = document.createElement('button')
      hit.type = 'button'
      hit.className = 'kbn-day-panehit'
      hit.title = `${preview.label} — open`
      hit.setAttribute('aria-label', `${preview.label} — open`)
      hit.addEventListener('click', () => this.openPreview(pane, preview))
      body.append(hit)
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

    const hit = pane.querySelector<HTMLButtonElement>('.kbn-day-panehit')

    const fallback = (): void => {
      // Keep the hit target: emptying the body would take the pane's own way in
      // with it, and a fiber without a report is exactly the one you most want
      // to open.
      body.querySelector('.kbn-day-paneveil')?.remove()
      body.querySelector('.kbn-day-paneframe')?.remove()
      body.querySelector('.kbn-day-paneoutcome')?.remove()
      const out = document.createElement('div')
      out.className = 'kbn-day-paneoutcome'
      const rubric = document.createElement('span')
      rubric.className = 'kbn-day-paneoutcomerubric'
      rubric.textContent = 'outcome'
      const prose = document.createElement('div')
      prose.className = 'kbn-day-paneoutcomebody'
      const text = pane.dataset.outcome ?? ''
      if (text) prose.innerHTML = renderMarkdown(text)
      else
        prose.append(
          Object.assign(document.createElement('em'), { textContent: 'no outcome yet' }),
        )
      out.append(rubric, prose)
      body.append(out)
      this.markPane(pane, hit, false)
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
    this.markPane(pane, hit, true)
  }

  /**
   * Settle what a pane is and where it goes, once its report is known to exist
   * or not. The class carries the distinction to CSS; the dataset carries it to
   * the click; the label says out loud which of the two this click will do.
   */
  private markPane(
    pane: HTMLElement,
    hit: HTMLButtonElement | null,
    hasReport: boolean,
  ): void {
    pane.classList.toggle('kbn-day-pane-report', hasReport)
    pane.classList.toggle('kbn-day-pane-outcome', !hasReport)
    pane.dataset.report = hasReport ? '1' : ''
    if (!hit) return
    const label = pane.querySelector('.kbn-day-panename')?.textContent ?? ''
    const what = hasReport ? 'open the report' : 'open the fiber'
    hit.title = `${label} — ${what}`
    hit.setAttribute('aria-label', `${label} — ${what}`)
  }

  /**
   * A pane's click: its report when it has one, the fiber itself when it does
   * not. Before the probe settles the pane opens the fiber — the answer that is
   * always true, and one click from the report anyway (the detail panel embeds
   * it).
   */
  private openPreview(pane: HTMLElement, preview: DayPreview): void {
    if (pane.dataset.report === '1' && preview.reportUrl) {
      window.open(preview.reportUrl, '_blank', 'noopener')
      return
    }
    this.ctx?.openCard(preview.cardId)
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
