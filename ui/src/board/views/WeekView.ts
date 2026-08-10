/**
 * WeekView (hotkey 3) — the two-faced week.
 *
 * The week does not end at now. Above the gold seam (today's row) the week is
 * RECONSTRUCTED from what actually happened: fine tick rasters of the activity
 * buckets, one tick per active slot, inked. Below the seam it is EVALUATED —
 * no rasters, only hollow marks for what the calendar has promised: a due
 * (◴), a standing role's next firing (◐), a snooze returning (◌). One grammar,
 * two faces, read top to bottom in a single sweep.
 *
 * THE RAIL. Every row is a 6am→6am rail, not a midnight→midnight one: work
 * that runs past midnight belongs to the day it started. So a "day" here is
 * bounded by two instants (local 6am to the next local 6am) while the row is
 * LABELLED by a civil day. Those instants are derived by calendar-day stride
 * (see `weekCivilDays`), never by adding 86_400_000 — a DST week has a 23h and
 * a 25h rail, and must still have exactly seven rows.
 *
 * WHAT IS A CIVIL DAY HERE. `due:` is a civil day and is placed by
 * `dueCivilDay` (../civilDay.ts). `nextLaunchAt` is an INSTANT and is placed at
 * its real position on the rail. Conflating the two is the bug this whole
 * module is written around; read civilDay.ts before touching the arithmetic.
 *
 * DATA. One `activity` call per refresh, over the week's rail span capped at
 * now — see `weekWindow`. Week does NOT read narration: it once drew a commit
 * subject per past row, but a single truncated subject read as "the name of one
 * fiber" rather than as what the day was about, so the column went and the
 * request went with it. Narration belongs to Day, which has the room to do it
 * justice.
 */

import './WeekView.css'

import {
  keystrokeIsSpokenFor,
  normalizeFocusDate,
  registerView,
  type TemporalView,
  type ViewContext,
} from './ViewRegistry.js'
import { createViewPage, type ViewPage } from './ViewPage.js'
import { ACTIVITY_KEY_ITEMS, MARK_GLYPH, messageClause, type MarkKind } from './vocabulary.js'
import {
  civilDayNoon,
  RAIL_START_HOUR,
  railBounds,
  shiftCivilDay,
  type RailBounds,
} from './railTime.js'
import {
  buildSessionIndex,
  foldActiveMinutes,
  isOriginStale,
  staleOrigins,
  type ActivityBucket,
  type ActivityResult,
  type SessionPairing,
  type TemporalOrigins,
} from './TemporalData.js'
import {
  buildOriginIndex,
  originOf,
  type BucketOrigin,
  type MomentSource,
  type OriginIndex,
} from './activityOrigin.js'
import {
  clockTime,
  dedupeSources,
  MomentLoader,
  renderTip,
  SLOT_KIND_ORDER,
  SLOT_NO_TEXT_NOTE,
  SLOT_PHRASE,
  type MomentWords,
  type SlotTip,
  type SlotTipRow,
} from './momentTip.js'

// Re-exported because the tooltip vocabulary was Week's before it was shared,
// and callers (and tests) that learned it here keep working.
export { SLOT_NO_TEXT_NOTE, type SlotTip, type SlotTipRow }
import type { KanbanCard } from '../KanbanTypes.js'
import { cycleSpan, type CycleSpan } from '../KanbanRules.js'
import {
  civilDayToLocalDate,
  dueCivilDay,
  instantMs,
  isoDayLocal,
  railCivilDay,
} from '../civilDay.js'

// Week's rail vocabulary is the board's; re-exported here because this view's
// published surface has always carried it.
export { RAIL_START_HOUR, railBounds, type RailBounds }

// ── Constants ────────────────────────────────────────────────────────────────

/** How much time one raster tick stands for. The wire's minute buckets are
 *  folded into these, because a per-minute tick on a 24h rail would be a
 *  fraction of a pixel — a smear, not a raster.
 *
 *  FOUR minutes, not five: dropping the marginalia column gave the rails
 *  ~200px, and the honest thing to spend that on is RESOLUTION rather than
 *  thicker ink. 360 slots across ~1050px is ~2.9px apiece, which is what a
 *  5-minute slot used to get at the old narrower width — same density to the
 *  eye, a quarter more temporal detail. A DRAWING quantum only; it never
 *  touches the arithmetic, which counts minutes (see BUCKET_MS). */
const RASTER_SLOT_MS = 4 * 60_000

/** Where an undated obligation sits on the rail — mid-morning, 10am. */
const MID_MORNING_FRACTION = (10 - RAIL_START_HOUR) / 24

/** Day-weight thresholds. Internal vocabulary, deliberately three words wide:
 *  the view reports how full a day was, it does not grade it. */
const FULL_MS = 6 * 3_600_000
const HALF_MS = 2 * 3_600_000

/** Granularity the activity window's `to` is rounded up to. Coarser than the
 *  60s poll on purpose — see the module note on the fetcher's memo. */
const FETCH_CAP_QUANTUM_MS = 5 * 60_000

/** Labels under the shared tick row, one per 4h rule. */
const TICK_LABELS = ['6am', '10am', '2pm', '6pm', '10pm', '2am', '6am']

// ── Week arithmetic — civil days only ────────────────────────────────────────
//
// Every function here strides by CALENDAR DAY from a noon anchor. Noon because
// midnight is the one wall-clock time a spring-forward day can lack, and
// `setDate` from a noon anchor lands on noon of the next calendar day in every
// zone and across every transition. Adding 86_400_000 does not: it skips a day
// forward in spring and repeats one in autumn.

/** The Monday of the week containing `day`. Weeks start Monday, so Sunday
 *  belongs to the week that began six days earlier, not the one starting
 *  tomorrow. */
export function mondayOfWeek(day: string): string {
  const d = civilDayNoon(day)
  if (!d) return day
  // getDay(): 0=Sun … 6=Sat. Monday must map to 0 and Sunday to 6.
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return isoDayLocal(d.getTime())
}

/** The seven civil days of the week beginning at `monday`, Monday→Sunday. */
export function weekCivilDays(monday: string): string[] {
  const d = civilDayNoon(monday)
  if (!d) return []
  const days: string[] = []
  for (let i = 0; i < 7; i += 1) {
    days.push(isoDayLocal(d.getTime()))
    d.setDate(d.getDate() + 1)
  }
  return days
}

/** The Monday `weeks` weeks from `monday` (negative goes back). */
export function shiftWeekMonday(monday: string, weeks: number): string {
  return shiftCivilDay(monday, weeks * 7)
}

/**
 * The week to show for a given temporal cursor — the Monday of the week
 * containing the focus day.
 *
 * The cursor is shared across all four views and is the SOURCE OF TRUTH; this
 * view holds no week state of its own beyond a cache of what it last drew.
 * Null means today/current and is re-resolved against the clock every time,
 * never frozen at the day the view first saw — a board left open overnight must
 * roll onto the new week by itself.
 */
export function weekMondayForFocus(focusDate: string | null, nowMs: number): string {
  // `railCivilDay`, NOT `isoDayLocal`: at 01:00 on a Monday the rail being
  // worked is the previous week's Sunday, so the view must not have jumped to
  // the new week yet. Reading the midnight day here also made the week start
  // four hours in the future, which suppressed the activity request entirely.
  return mondayOfWeek(normalizeFocusDate(focusDate) ?? railCivilDay(nowMs))
}

/**
 * What paging ‹ › (or a swipe, or an arrow key) writes back to the cursor.
 *
 * THE SHARED RULE, which DayView's `stepTarget` states at its own scale: a
 * paging affordance that lands back on the view's LIVE PRESENT hands the cursor
 * to null rather than pinning it to a date. Null keeps tracking the clock; a
 * date does not, and a cursor pinned to "today's date" goes quietly stale at
 * the next boundary.
 *
 * The two views differ only in what their present IS. Day's unit is a day, so
 * it returns null when the step lands on today. Week's unit is a week, so it
 * returns null when the step lands anywhere in the current week — the same
 * predicate the week label uses to decide whether it is showing "This week",
 * so the label and the cursor can never disagree. Were this Day's literal rule
 * instead, paging out and back from a Wednesday would leave the cursor pinned
 * to that Wednesday while the header still claimed the live week, and pressing
 * `3` would open Day on Wednesday rather than today.
 */
export function weekStepTarget(focusDate: string | null, delta: number, nowMs: number): string | null {
  const from = normalizeFocusDate(focusDate) ?? railCivilDay(nowMs)
  const next = shiftCivilDay(from, delta * 7)
  return mondayOfWeek(next) === weekMondayForFocus(null, nowMs) ? null : next
}

/** Where an instant sits on a rail, as 0…1. Outside the rail it clamps, so a
 *  caller that has already decided the instant belongs to this day never
 *  positions a mark off the edge. */
export function railFraction(ms: number, bounds: RailBounds): number {
  const span = bounds.endMs - bounds.startMs
  if (span <= 0) return 0
  return Math.min(1, Math.max(0, (ms - bounds.startMs) / span))
}

/**
 * Where the 4-hourly rules fall on one day's rail — the interior ones only
 * (10am, 2pm, 6pm, 10pm, 2am), since 6am is the rail's own two edges.
 *
 * Even sixths would be wrong on a DST rail: a 25h day's 2pm is 8 of 25 along,
 * not 8 of 24, so fixed fractions would drift the rules up to an hour away from
 * the ink they are supposed to measure. Each rule is therefore a real
 * wall-clock instant put through `railFraction`, which is what makes them agree
 * with the rasters on the two days a year it matters.
 */
export function railRuleFractions(day: string, bounds: RailBounds): number[] {
  const out: number[] = []
  for (let step = 1; step < 6; step += 1) {
    const hour = RAIL_START_HOUR + step * 4
    const at = civilDayNoon(day)
    if (!at) continue
    // 26 is 2am tomorrow — the rail crosses midnight, so the late rules belong
    // to the next calendar day. On a spring-forward rail that 2am does not
    // exist; `setHours` resolves it to 03:00, which is exactly where the rule
    // belongs — the first instant at or after where 2am would have been.
    if (hour >= 24) at.setDate(at.getDate() + 1)
    at.setHours(hour % 24, 0, 0, 0)
    out.push(railFraction(at.getTime(), bounds))
  }
  return out
}

// ── The read window ──────────────────────────────────────────────────────────

export interface WeekWindow {
  /** The seven civil days, Monday→Sunday. Empty when `monday` is unparseable. */
  days: string[]
  /** Rail span, as instants: local 6am Monday to local 6am the next Monday. */
  fromMs: number
  toMs: number
  /** `to` for the activity call. Capped at now (see below); when it is not
   *  greater than `fromMs` the week is wholly future and must not be asked
   *  for at all. */
  activityToMs: number
}

/**
 * Everything one refresh needs to ask the read plane for. Pure, so the
 * argument shapes are testable without a DOM.
 *
 * The week is named by CIVIL DAYS but read by INSTANTS: `/api/v1/activity`
 * takes `from_ms`/`to_ms` in epoch ms, so the seven rows are resolved to a rail
 * span here, in the browser's zone, before anything is asked for. Week reads
 * activity only — see the module header for why the narration column went.
 *
 * The activity `to` is capped at now, rounded UP to `FETCH_CAP_QUANTUM_MS`.
 * Uncapped it would move every poll, so the fetcher's per-tuple memo would
 * never hit and its cache would gain an entry per poll forever.
 */
export function weekWindow(monday: string, nowMs: number): WeekWindow {
  const days = weekCivilDays(monday)
  if (days.length !== 7) {
    return { days: [], fromMs: 0, toMs: 0, activityToMs: 0 }
  }
  const fromMs = railBounds(days[0]).startMs
  const toMs = railBounds(days[6]).endMs
  return {
    days,
    fromMs,
    toMs,
    activityToMs: Math.min(toMs, Math.ceil(nowMs / FETCH_CAP_QUANTUM_MS) * FETCH_CAP_QUANTUM_MS),
  }
}

// ── Activity summarizing ─────────────────────────────────────────────────────

/**
 * How much time one bucket stands for. A CONSTANT, not something to infer.
 *
 * The wire contract is fixed: `Shuttle.Activity` keys every event by
 * `div(ts, @minute_ms) * @minute_ms` with `@minute_ms 60_000`
 * (lib/shuttle/activity.ex), unconditionally — there is no width parameter and
 * no window-dependent coarsening, and the controller serves those buckets
 * untouched.
 *
 * An earlier version inferred the width from the smallest gap between bucket
 * starts, to accommodate the harness mock's 5-minute grid. That was backwards
 * and actively wrong: on a sparse window — a light week, a week of nothing but
 * notifications, a week that just started — no two buckets are adjacent, so the
 * "grid" it measured was the SPARSITY, and every total was multiplied by it.
 * Four buckets scattered over half an hour reported 28 minutes of work for 4.
 * Since the daemon only ever emits minutes, the inference could never correct
 * anything; it could only over-report. The harness mock is the thing that is
 * wrong, and it is the harness's to fix.
 */
export const BUCKET_MS = 60_000

export interface ActivitySpend {
  /** Time in buckets carrying ANY signal — a bucket counts once, not once per
   *  kind, so the total is wall-clock time and not a sum of overlaps. */
  totalMs: number
  agentMs: number
  notifyCount: number
  /** Messages the human sent — every `user_prompt_submit`, counted as events
   *  and not as minutes. */
  sent: number
  /** Replies the human received — every finished agent turn (`k: "reply"`).
   *  Zero on a daemon too old to emit the kind, which reads correctly: a
   *  count nobody reported is not a count of nothing said, but the week header
   *  simply omits the clause rather than claiming silence. */
  received: number
}

/**
 * Fold buckets into the two currencies a week reads in. Callers pre-filter the
 * window.
 *
 * The asymmetry is the point. Agent work is measured in **time**, because that
 * is what a machine spends and what a long unattended run looks like. Human
 * presence is measured in **messages**, because nobody experiences their own
 * attention as wall-clock minutes — they remember how many times they came
 * back. So the human side sums `n` (events) while the agent side counts
 * distinct minutes.
 */
export function summarizeSpend(buckets: ActivityBucket[], bucketMs = BUCKET_MS): ActivitySpend {
  const minutes = foldActiveMinutes(buckets)
  let sent = 0
  let received = 0
  let notifyCount = 0
  for (const b of buckets) {
    if (b.k === 'attention') sent += b.n
    else if (b.k === 'reply') received += b.n
    else if (b.k === 'notify') notifyCount += 1
  }
  return {
    totalMs: minutes.all * bucketMs,
    agentMs: minutes.agent * bucketMs,
    // Counted here rather than taken from `foldActiveMinutes`, whose else-branch
    // sweeps every non-attention, non-agent kind (including "reply") into its
    // notify tally.
    notifyCount,
    sent,
    received,
  }
}

/**
 * The host a row is waiting on, or null.
 *
 * A rail now carries ink from every daemon at once, so "is this row current?"
 * is a question about the origins its ink came from. The answer is muting ONLY
 * when the row is WHOLLY remote and every one of those origins is stale: mixed
 * ink includes this daemon's own minutes, which are current by definition, and
 * graying them would claim something false about the local record.
 *
 * A row with no ink says nothing — an empty rail is an empty rail, and a
 * remote whose window simply does not reach this week is thin data, not a
 * failure. Hosts are named in sorted order so the note is stable across polls.
 */
export function rowWaitingOn(
  buckets: readonly ActivityBucket[],
  origins: TemporalOrigins,
): string | null {
  if (buckets.length === 0) return null
  const hosts = new Set<string>()
  for (const b of buckets) {
    // A bucket nobody stamped cannot be attributed to a stale remote; it holds
    // the row current rather than being guessed onto one.
    if (!b.host) return null
    if (!isOriginStale(origins, b.host)) return null
    hosts.add(b.host)
  }
  return [...hosts].sort().join(', ')
}

export type DayWeight = 'full' | 'half' | 'quiet'

/** How full a day was. Three words, no fourth: the view describes the shape of
 *  the day, it does not judge it. */
export function dayWeight(totalMs: number): DayWeight {
  if (totalMs >= FULL_MS) return 'full'
  if (totalMs >= HALF_MS) return 'half'
  return 'quiet'
}

/** `6h 20m` · `35m` · `—`. Rounded down to the minute. */
export function formatSpan(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes <= 0) return '—'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

/**
 * The one line of right-edge text a row carries.
 *
 * Past and today report how the day went; a future row reports nothing, because
 * nothing has happened on it yet and `—` there would read as "no activity"
 * rather than "not yet". Today alone appends the aloft count.
 */
export function annotationFor(
  spend: { totalMs: number; sent?: number; received?: number } | null,
  isPast: boolean,
  isToday: boolean,
  aloft: number,
): string {
  if (!isPast && !isToday) return ''
  const quiet = !spend || spend.totalMs <= 0
  const parts = quiet ? ['—'] : [formatSpan(spend.totalMs), dayWeight(spend.totalMs)]
  // A day with no messages at all — a batch run, a cron sweep — says nothing
  // here rather than printing a pair of zeros. Silence is the honest render of
  // "no conversation happened", and also of a daemon that never sent the kind.
  if (!quiet && (spend.sent || spend.received)) parts.push(messageClause(spend.sent ?? 0, spend.received ?? 0))
  if (isToday && aloft > 0) parts.push(`${aloft} aloft`)
  return parts.join(' · ')
}

// Re-exported for callers that historically imported it from here — the
// definition now lives in vocabulary.ts, shared with Day and Chronicle.
export { messageClause } from './vocabulary.js'

/** `12h` · `45m` — the header's coarser hand. */
function formatCoarseSpan(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes <= 0) return '0h'
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

// ── Swipe paging ─────────────────────────────────────────────────────────────

/** Horizontal distance one page costs. Roughly a deliberate two-finger flick;
 *  low enough to feel willing, high enough that a diagonal scroll never pages. */
export const SWIPE_THRESHOLD_PX = 120
/** Quiet time that ends a gesture. Trackpads emit wheel events in a burst with
 *  a long inertial tail, so "the gesture ended" is silence, not a distance. */
export const SWIPE_SETTLE_MS = 200
/** How far the grid may lean while a swipe accumulates. */
export const SWIPE_NUDGE_CAP_PX = 24
/** Fraction of the accumulated distance the lean shows. Well under 1: the grid
 *  hints that it is attached to the finger, it does not track it. */
const SWIPE_NUDGE_RATIO = 0.25

export interface SwipeState {
  /** Signed distance accumulated since the last page or settle. */
  offset: number
  /** True after a page fires, until the gesture goes quiet. */
  locked: boolean
  /** When the last wheel event arrived. */
  lastMs: number
}

export const IDLE_SWIPE: SwipeState = { offset: 0, locked: false, lastMs: 0 }

export interface SwipeAdvance {
  state: SwipeState
  /** -1 (previous week), +1 (next), or 0 — this event paged or it did not. */
  step: number
  /** Signed px to translate the grid by, for the attached feel. */
  nudge: number
}

/**
 * Fold one wheel event into the swipe gesture.
 *
 * ONE PHYSICAL SWIPE IS ONE WEEK. A trackpad flick delivers dozens of wheel
 * events and keeps delivering them, decaying, long after the fingers lift, so
 * a bare threshold would page four or five times from a single gesture. The
 * lock is what prevents that: once a page fires the accumulator stops counting
 * and only silence — {@link SWIPE_SETTLE_MS} without an event — reopens it.
 *
 * Pure, and takes its clock as an argument, so the lockout is testable without
 * a trackpad or a timer.
 */
export function advanceSwipe(state: SwipeState, deltaX: number, atMs: number): SwipeAdvance {
  // Silence since the last event means the previous gesture is over, whatever
  // it left behind.
  const settled = atMs - state.lastMs >= SWIPE_SETTLE_MS
  const base: SwipeState = settled ? { offset: 0, locked: false, lastMs: atMs } : { ...state, lastMs: atMs }

  if (base.locked) return { state: base, step: 0, nudge: 0 }

  const offset = base.offset + deltaX
  if (Math.abs(offset) >= SWIPE_THRESHOLD_PX) {
    return {
      state: { offset: 0, locked: true, lastMs: atMs },
      step: offset > 0 ? 1 : -1,
      nudge: 0,
    }
  }
  return {
    state: { ...base, offset },
    step: 0,
    // Negated: swiping right-to-left (positive deltaX) walks FORWARD in time,
    // so the sheet slides left and the next week comes in from the right.
    nudge: clamp(-offset * SWIPE_NUDGE_RATIO, -SWIPE_NUDGE_CAP_PX, SWIPE_NUDGE_CAP_PX),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// ── Cycles ───────────────────────────────────────────────────────────────────

/**
 * The span a cycle CARD covers, via the rule KanbanRules owns.
 *
 * `cycleSpan` there takes a fiber's `start`/`due`; a card carries the same two
 * civil days as `cycleStart`/`due`. Going through it rather than reading the
 * fields directly is deliberate — it owns the three degenerate cases (no start,
 * no end, neither), and a second reading of them here would be a second rule to
 * keep in step.
 */
export function spanOfCycleCard(card: KanbanCard, nowMs: number): CycleSpan | null {
  if (!card.isCycle) return null
  return cycleSpan({ start: card.cycleStart ?? undefined, due: card.due }, nowMs)
}

/**
 * The cycles the shown week falls inside, soonest-started first.
 *
 * Overlap is inclusive at both ends and asked in civil days, which compare
 * correctly as strings because they are fixed-width and zero-padded. A cycle
 * ending on the Monday and one starting on the Sunday both count — the week
 * touches them, which is what the header is asking.
 *
 * An OPEN-ENDED cycle has no right edge yet. `cycleSpan` clamps its `end` to
 * today so a view has something concrete to draw, but for intersection that
 * clamp would be a lie in two directions: it would drop every future week from
 * a cycle that is still running, and — where the cycle starts later today or
 * later this week — it would invert the span and match on the inversion rather
 * than on the cycle. So an open cycle is treated as covering everything from
 * its start onward, which is what "still running" means.
 */
export function cyclesInWeek(
  cycles: readonly KanbanCard[],
  days: readonly string[],
  nowMs: number,
): KanbanCard[] {
  if (days.length === 0) return []
  const weekStart = days[0]
  const weekEnd = days[days.length - 1]
  return cycles
    .map((card) => ({ card, span: spanOfCycleCard(card, nowMs) }))
    .filter(
      (entry): entry is { card: KanbanCard; span: CycleSpan } =>
        entry.span !== null &&
        entry.span.start <= weekEnd &&
        (entry.span.openEnded || entry.span.end >= weekStart),
    )
    .sort((a, b) => a.span.start.localeCompare(b.span.start) || a.card.name.localeCompare(b.card.name))
    .map((entry) => entry.card)
}

/** How many cycle names the header shows before it starts counting. */
const CYCLE_CHIP_LIMIT = 2

// ── Future marks ─────────────────────────────────────────────────────────────

export type { MarkKind }

export interface DayMark {
  kind: MarkKind
  glyph: string
  /** 0…1 along the rail. */
  fraction: number
  label: string
  cardId: string
}

/**
 * The hollow marks a day carries: obligations, not events. The three glyphs
 * and what they claim live in `./vocabulary.js`; here is where they land.
 *
 *   ◴ due       at mid-morning — a due has no time of day, so it may not
 *               pretend to one.
 *   ◐ launch    a standing role's `nextLaunchAt`, an INSTANT, at its real
 *               position on the rail.
 *   ◌ snooze    a stashed card whose due lands here.
 *
 * A stashed card takes the hollow ◌ instead of ◴, never both. Closed cards
 * carry no obligation and are skipped.
 */
export function marksForDay(cards: KanbanCard[], day: string, bounds: RailBounds): DayMark[] {
  const marks: DayMark[] = []
  for (const card of cards) {
    if (card.status === 'closed') continue
    // A cycle is a span of time, not an obligation, and its `due` is the span's
    // END rather than a deadline — drawn as a ◴ it would read as work owed on
    // the day the cycle happens to close. `classifyFiber` keeps cycles off
    // every lifecycle surface so they should never reach here, but this is the
    // one place where letting one through would silently invent a commitment.
    if (card.isCycle) continue
    // Rail membership, NOT the calendar day. A launch is an instant and is
    // drawn at its real rail fraction, so it has to be selected by the same
    // predicate the activity and narration ingesters use — otherwise a 03:00
    // firing is filed on that morning's row, where 03:00 lies before the rail
    // even opens, and `railFraction` clamps it to 0: a dawn cron drawn under
    // the 6am tick of the wrong day, while the row that owns it shows nothing.
    const launch = instantMs(card.nextLaunchAt)
    if (launch !== undefined && launch >= bounds.startMs && launch < bounds.endMs) {
      marks.push({
        kind: 'launch',
        glyph: MARK_GLYPH.launch,
        fraction: railFraction(launch, bounds),
        label: card.name,
        cardId: card.id,
      })
      continue
    }
    if (dueCivilDay(card.due) === day) {
      const kind: MarkKind = card.effectiveHorizon === 'stashed' ? 'snooze' : 'due'
      marks.push({
        kind,
        glyph: MARK_GLYPH[kind],
        fraction: MID_MORNING_FRACTION,
        label: card.name,
        cardId: card.id,
      })
    }
  }
  return marks.sort((a, b) => a.fraction - b.fraction)
}

// ── The view ─────────────────────────────────────────────────────────────────

interface LoadedActivity {
  monday: string
  /** Buckets grouped by the civil day whose RAIL they fall on (so a 2am bucket
   *  sits with the previous day, where the work started). */
  byDay: Map<string, ActivityBucket[]>
  week: ActivitySpend
  /** Per-origin freshness for the window this activity came from. */
  origins: TemporalOrigins
  /** Cheap fingerprint — bumps the render generation only on real change. */
  print: string
}

interface WeekRow {
  day: string
  root: HTMLElement
  rail: HTMLElement
  /** Everything that is patched: rasters, marks, the now line. */
  paint: HTMLElement
  /** Transparent layer above the ink that catches the pointer. The ticks
   *  themselves are 1.5px wide and cannot be hovered; this snaps to the nearest
   *  inked slot instead, which is the only way the tooltip is reachable. */
  hover: HTMLElement
  annot: HTMLElement
  /** What was last inked here — the tooltip's source. */
  slots: RasterSlot[]
  sig: string
}

/** How near the pointer must be to an inked slot for it to count, in px. Wide
 *  enough that a hairline tick is catchable, narrow enough that hovering empty
 *  paper says nothing. */
const HOVER_SNAP_PX = 9

class WeekView implements TemporalView {
  readonly id = 'week' as const
  readonly title = 'Week'
  readonly hotkey = '3'

  private page: ViewPage | null = null
  private ctx: ViewContext | null = null

  /**
   * The shown week, re-derived from `ctx.focusDate` on every mount and refresh.
   * NOT state this view owns — a cache of what the shared cursor currently
   * resolves to, kept as a field only so the async guards below can compare
   * "the week that request was for" against "the week on screen now".
   */
  private monday = weekMondayForFocus(null, Date.now())
  /** The week the current DOM shell was built for. */
  private shellMonday: string | null = null

  private label: HTMLElement | null = null
  private totals: HTMLElement | null = null
  private cycles: HTMLElement | null = null
  /** Last-rendered cycle chip key, so the header does not churn every poll. */
  private cyclesKey = ''
  private grid: HTMLElement | null = null
  private key: HTMLElement | null = null
  private rows: WeekRow[] = []

  /** Horizontal-swipe gesture state, and the timer that detects its end. */
  private swipe: SwipeState = IDLE_SWIPE
  private swipeSettleTimer: ReturnType<typeof setTimeout> | null = null

  private activity: LoadedActivity | null = null
  /** Bumped when loaded data actually changes; part of every row signature. */
  private dataGen = 0
  private activityKey = ''

  /**
   * The session ledger, as the tmux→fiber map. JOIN RUNG 0 for the rasters:
   * without it a tick can only guess whose minute it was from a session name.
   * Asked for once per board (`sessions(0)` is a constant argument, so the
   * fetcher's memo answers every later refresh), and absent — an old daemon,
   * a 404 — simply leaves the weaker rungs to do the work.
   */
  private byTmux: ReadonlyMap<string, SessionPairing> = new Map()
  private sessionsAsked = false
  /** Rebuilt each paint from the cards on screen plus the ledger. */
  private origins: OriginIndex = buildOriginIndex([])

  /** The one hover tooltip, parented to the grid so it positions against the
   *  rails rather than the page. */
  private tip: HTMLElement | null = null

  /** The slot the pointer is on (`<civil day>:<slot index>`), and the loader
   *  that fetches its words. The key is what a late answer is checked against. */
  private hoveredKey: string | null = null
  private moments = new MomentLoader((session, fromMs, toMs, host) =>
    this.ctx
      ? this.ctx.moment(session, fromMs, toMs, host)
      : Promise.resolve({ host: host ?? '', excerpts: [] }),
  )

  /**
   * ‹ › paging, and `t` for today — the same binding DayView carries, so one
   * key means "back to now" wherever you are in the temporal views.
   *
   * The guard is the SHARED one. This file used to hold its own copy that knew
   * only Radix's `[data-state="open"]`, which let a bare arrow page the week out
   * from under the hand-rolled Stash form — it is `aria-modal` and carries no
   * data-state at all.
   */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 't') return
    if (!this.page?.root.isConnected) return
    if (keystrokeIsSpokenFor()) return
    e.preventDefault()
    if (e.key === 't') this.goToday()
    else this.goWeek(e.key === 'ArrowLeft' ? -1 : 1)
  }

  /**
   * Trackpad paging. Only a horizontally-DOMINANT wheel event is ours; anything
   * with more vertical than horizontal travel belongs to the page's own scroll
   * and is left entirely alone, unprevented.
   */
  private readonly onWheel = (e: WheelEvent): void => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    e.preventDefault()
    const { state, step, nudge } = advanceSwipe(this.swipe, e.deltaX, e.timeStamp)
    this.swipe = state
    if (step !== 0) {
      this.leanGrid(0, true)
      this.goWeek(step)
    } else {
      this.leanGrid(nudge, false)
    }
    // The gesture ends in silence, so the only way to notice is to wait for it.
    if (this.swipeSettleTimer !== null) clearTimeout(this.swipeSettleTimer)
    this.swipeSettleTimer = setTimeout(() => {
      this.swipe = IDLE_SWIPE
      this.leanGrid(0, true)
      this.swipeSettleTimer = null
    }, SWIPE_SETTLE_MS)
  }

  /** Tip the sheet a few px so the gesture feels attached. `spring` eases the
   *  return; the lean itself tracks the finger and must not lag behind it. */
  private leanGrid(px: number, spring: boolean): void {
    const grid = this.grid
    if (!grid) return
    grid.classList.toggle('wk-grid-springing', spring)
    grid.style.transform = px === 0 ? '' : `translateX(${px.toFixed(1)}px)`
  }

  mount(host: HTMLElement, ctx: ViewContext): void {
    const page = createViewPage(this.title)
    this.page = page
    page.titleRow.append(this.buildHead())
    host.append(page.root)
    document.addEventListener('keydown', this.onKeyDown)
    // On the body, not the grid: `ensureShell` replaces the grid every time the
    // week changes, and a listener on it would be swept away by the first page.
    page.body.addEventListener('wheel', this.onWheel, { passive: false })
    this.refresh(ctx)
  }

  refresh(ctx: ViewContext): void {
    this.ctx = ctx
    if (!this.page) return
    // The cursor leads; this view follows. Re-resolved every time, so a null
    // cursor rolls onto the new week when the clock does.
    this.monday = weekMondayForFocus(ctx.focusDate, Date.now())
    this.ensureShell()
    this.load(ctx)
    this.paint()
  }

  unmount(): void {
    document.removeEventListener('keydown', this.onKeyDown)
    this.page?.body.removeEventListener('wheel', this.onWheel)
    if (this.swipeSettleTimer !== null) clearTimeout(this.swipeSettleTimer)
    this.swipeSettleTimer = null
    this.swipe = IDLE_SWIPE
    this.grid = null
    this.page?.root.remove()
    this.page = null
    this.ctx = null
    this.label = null
    this.totals = null
    this.cycles = null
    this.cyclesKey = ''
    this.key = null
    this.rows = []
    this.shellMonday = null
    this.activityKey = ''
  }

  // ── Head ───────────────────────────────────────────────────────────────────

  private buildHead(): HTMLElement {
    const head = document.createElement('div')
    head.className = 'wk-head'

    const nav = document.createElement('div')
    nav.className = 'wk-nav'

    const prev = navButton('‹', 'Previous week (←)', () => this.goWeek(-1))
    const next = navButton('›', 'Next week (→)', () => this.goWeek(1))

    const label = document.createElement('button')
    label.type = 'button'
    label.className = 'wk-weeklabel'
    label.addEventListener('click', () => this.goToday())
    this.label = label

    nav.append(prev, label, next)

    const totals = document.createElement('div')
    totals.className = 'wk-totals'
    this.totals = totals

    // Which cycle(s) this week falls inside — the week's place in something
    // longer than itself, in the marginal hand rather than the technical one.
    const cycles = document.createElement('div')
    cycles.className = 'wk-cycles'
    this.cycles = cycles

    head.append(nav, totals, cycles)
    return head
  }

  /**
   * Page the week. Moves the SHARED cursor by seven days rather than this
   * view's own idea of the week — so the weekday survives the jump (paging
   * from a Wednesday lands on the next Wednesday), and Day and Chronicle come
   * along. `setFocusDate` calls `refresh` for us; never refresh here as well.
   */
  private goWeek(delta: number): void {
    const ctx = this.ctx
    if (!ctx) return
    ctx.setFocusDate(weekStepTarget(ctx.focusDate, delta, Date.now()))
  }

  /** Back to the live present — null, not today's date, so the cursor keeps
   *  tracking the clock instead of pinning to the day this was clicked. */
  private goToday(): void {
    this.ctx?.setFocusDate(null)
  }

  // ── Shell ──────────────────────────────────────────────────────────────────

  /** Build the seven row skeletons and the tick row once per shown week. Row
   *  CONTENT is patched by `paint`; this only lays the ruled paper. */
  private ensureShell(): void {
    const page = this.page
    if (!page || this.shellMonday === this.monday) return

    page.body.innerHTML = ''
    this.rows = []

    const grid = document.createElement('div')
    grid.className = 'wk-grid'

    for (const day of weekCivilDays(this.monday)) {
      const row = this.buildRow(day)
      this.rows.push(row)
      grid.append(row.root)
    }

    grid.append(buildTickRow())
    this.key = buildKeyRow()
    grid.append(this.key)
    page.body.append(grid)
    this.grid = grid
    this.shellMonday = this.monday

    const date = civilDayToLocalDate(this.monday)
    if (this.label && date) {
      this.label.textContent = `Week of ${date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`
    }
  }

  /**
   * Whether the shown week is the live one — repainted every refresh, NOT once
   * per shell.
   *
   * The week's NAME only changes when the week does, so it belongs in the
   * shell. This does not: it compares the shown week against the clock, and the
   * clock moves while the shell stands still. With the cursor pinned to a date,
   * `this.monday` never changes, `ensureShell` early-returns, and a board left
   * open across a Sunday midnight went on calling last week "This week".
   */
  private paintWeekLabelState(): void {
    if (!this.label) return
    const isCurrent = this.monday === weekMondayForFocus(null, Date.now())
    this.label.classList.toggle('wk-weeklabel-away', !isCurrent)
    this.label.title = isCurrent ? 'This week' : 'Back to this week'
  }

  private buildRow(day: string): WeekRow {
    const date = civilDayToLocalDate(day)
    const root = document.createElement('div')
    root.className = 'wk-row'
    root.dataset.day = day
    if (date && (date.getDay() === 0 || date.getDay() === 6)) root.classList.add('wk-row-weekend')

    // The label block is the way down a level: the week names a day, clicking
    // the name opens it. It carries the cursor with it, so Day arrives already
    // on that date instead of flashing today first.
    const label = document.createElement('button')
    label.type = 'button'
    label.className = 'wk-daylabel'
    const full = date
      ? date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
      : day
    label.title = `Open ${full} in Day view`
    label.setAttribute('aria-label', label.title)
    label.addEventListener('click', () => this.ctx?.switchView('day', { focusDate: day }))
    const dow = document.createElement('span')
    dow.className = 'wk-dow'
    dow.textContent = date ? date.toLocaleDateString(undefined, { weekday: 'short' }) : ''
    const num = document.createElement('span')
    num.className = 'wk-daynum'
    num.textContent = date ? String(date.getDate()) : ''
    label.append(dow, num)

    const rail = document.createElement('div')
    rail.className = 'wk-rail'
    // Hour rules every 4h, at their real positions on THIS day's rail — static
    // for the row's lifetime, so they live outside the patched layer.
    const rules = document.createElement('div')
    rules.className = 'wk-rules'
    for (const fraction of railRuleFractions(day, railBounds(day))) {
      const rule = document.createElement('span')
      rule.className = 'wk-rule'
      rule.style.left = `${fraction * 100}%`
      rules.append(rule)
    }
    const paint = document.createElement('div')
    paint.className = 'wk-paint'
    const hover = document.createElement('div')
    hover.className = 'wk-hover'
    // UNDER the paint layer, not over it. `.wk-paint` is `pointer-events: none`
    // so the ink falls through to this catcher, but the hollow marks inside it
    // re-enable pointer events for themselves — and a hover layer stacked on top
    // would eat their clicks. Order is the whole mechanism; see WeekView.css.
    rail.append(rules, hover, paint)

    const annot = document.createElement('div')
    annot.className = 'wk-annot'
    root.append(label, rail, annot)
    const row: WeekRow = { day, root, rail, paint, hover, annot, slots: [], sig: '' }

    hover.addEventListener('mousemove', (e) => this.showTip(row, e))
    hover.addEventListener('mouseleave', () => this.hideTip())
    return row
  }

  // ── Hover ──────────────────────────────────────────────────────────────────

  /**
   * Report the inked slot under the pointer, or nothing.
   *
   * SNAPS rather than hit-tests. The ticks are hairlines at fractional pixel
   * positions; asking the pointer to land on one would make the tooltip a game.
   * The nearest slot within {@link HOVER_SNAP_PX} is the answer, and empty paper
   * — no slot that near — hides the tooltip rather than showing the closest
   * thing on the row.
   */
  private showTip(row: WeekRow, e: MouseEvent): void {
    const grid = this.grid
    if (!grid || row.slots.length === 0) return this.hideTip()
    const rail = row.hover.getBoundingClientRect()
    if (rail.width <= 0) return this.hideTip()

    const x = e.clientX - rail.left
    let best: RasterSlot | null = null
    let bestPx = Infinity
    for (const slot of row.slots) {
      const px = Math.abs(slot.fraction * rail.width - x)
      if (px < bestPx) {
        bestPx = px
        best = slot
      }
    }
    if (!best || bestPx > HOVER_SNAP_PX) return this.hideTip()

    const slot = best
    const tip = this.ensureTip()
    const key = `${row.day}:${slot.index}`
    renderTip(tip, slotTip(slot, this.moments.peek(key)))
    // The words arrive late or not at all; the tooltip is already correct
    // without them, and redraws in place when they land.
    this.moments.request(key, slot.sources, slot.startMs, slot.endMs, (words) => {
      if (this.hoveredKey !== key) return
      renderTip(tip, slotTip(slot, words))
    })
    this.hoveredKey = key
    tip.classList.add('kbn-tip-open')

    // Positioned against the grid, and flipped at the right edge so a slot late
    // in the day does not push the tooltip off the sheet.
    const box = grid.getBoundingClientRect()
    const anchor = rail.left - box.left + best.fraction * rail.width
    const top = rail.top - box.top
    tip.style.top = `${top}px`
    tip.classList.toggle('kbn-tip-flip', anchor > box.width * 0.62)
    tip.style.left = anchor > box.width * 0.62 ? 'auto' : `${anchor + 9}px`
    tip.style.right = anchor > box.width * 0.62 ? `${box.width - anchor + 9}px` : 'auto'
  }

  private ensureTip(): HTMLElement {
    if (this.tip?.isConnected) return this.tip
    const tip = document.createElement('div')
    tip.className = 'kbn-tip'
    this.grid?.append(tip)
    this.tip = tip
    return tip
  }

  private hideTip(): void {
    this.tip?.classList.remove('kbn-tip-open')
    this.hoveredKey = null
    this.moments.cancel()
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  /**
   * Ask for the week's activity. The call goes out on every refresh — the
   * fetcher memoizes per argument tuple, so a repeat is free — and lands into
   * `this.activity` only if the week it was asked for is still on screen.
   */
  private load(ctx: ViewContext): void {
    // The ledger is host-wide and window-free, so it is asked for once and then
    // served from the fetcher's memo. A failure leaves `byTmux` empty, which is
    // a weaker join rather than a broken view.
    if (!this.sessionsAsked) {
      this.sessionsAsked = true
      void ctx
        .sessions(0)
        .then((res) => {
          const byTmux = buildSessionIndex(res.records).byTmux
          if (byTmux.size === 0) return
          this.byTmux = byTmux
          // Rung 0 arriving can move a tick from a session name onto a fiber —
          // and can make it read as constitution-driven — so the rows repaint.
          this.dataGen += 1
          this.paint()
        })
        .catch(() => {
          // A transient failure should not permanently forfeit the ledger —
          // reset the latch so the next paint's `load` retries.
          this.sessionsAsked = false
        })
    }

    const monday = this.monday
    const win = weekWindow(monday, Date.now())
    if (win.days.length !== 7) return

    const key = `${monday}:${win.activityToMs}`
    if (win.activityToMs > win.fromMs && this.activityKey !== key) {
      this.activityKey = key
      void ctx.activity(win.fromMs, win.activityToMs).then((res) => {
        if (this.monday === monday) this.acceptActivity(monday, win.days, res)
      })
    } else if (win.activityToMs <= win.fromMs && this.activity?.monday !== monday) {
      // A week wholly in the future: no rasters, and no request either.
      this.activityKey = key
      this.acceptActivity(monday, win.days, {
        host: '',
        from_ms: win.fromMs,
        to_ms: win.fromMs,
        buckets: [],
      })
    }

  }

  private acceptActivity(monday: string, days: string[], res: ActivityResult): void {
    const byDay = new Map<string, ActivityBucket[]>()
    const edges = days.map((day) => ({ day, bounds: railBounds(day) }))
    for (const bucket of res.buckets) {
      const hit = edges.find((e) => bucket.m >= e.bounds.startMs && bucket.m < e.bounds.endMs)
      if (!hit) continue
      const list = byDay.get(hit.day)
      if (list) list.push(bucket)
      else byDay.set(hit.day, [bucket])
    }
    const origins = res.origins ?? {}
    // Staleness is in the print: a remote falling out of contact changes what
    // the rows say without changing a single bucket.
    const print = `${res.buckets.length}:${res.buckets.at(-1)?.m ?? 0}:${staleOrigins(origins).join(',')}`
    if (this.activity?.monday === monday && this.activity.print === print) return
    this.activity = {
      monday,
      byDay,
      week: summarizeSpend(res.buckets),
      origins,
      print,
    }
    this.dataGen += 1
    this.paint()
  }

  // ── Paint ──────────────────────────────────────────────────────────────────

  private paint(): void {
    const ctx = this.ctx
    if (!ctx || !this.page || this.rows.length !== 7) return

    const now = Date.now()
    // Coarse clock in every signature: today's row must follow the now-marker,
    // and no row may re-render for a millisecond that changed nothing.
    const minute = Math.floor(now / 60_000)
    // The rail that CONTAINS now, not the midnight calendar day — between
    // midnight and 6am those are different rows, and the live one is the rail's.
    const todayCivil = railCivilDay(now)
    const activity = this.activity?.monday === this.monday ? this.activity : null

    this.paintWeekLabelState()

    if (this.totals) {
      const week = activity?.week
      this.totals.textContent = week
        ? // Two currencies, one line: what the week cost a person is a number
          // of messages, what it cost the machines is hours.
          `${messageClause(week.sent, week.received)} · agents ${formatCoarseSpan(week.agentMs)}`
        : ''
    }

    // From `response.cycles`, NOT `ctx.cards`: a cycle is a span of time rather
    // than a piece of work, and `classifyFiber` keeps it off every lifecycle
    // surface, so `collectCards` never sees one.
    // Only explain ink that is on the page.
    if (this.key) this.key.style.display = (activity?.week.totalMs ?? 0) > 0 ? '' : 'none'

    this.paintCycles(cyclesInWeek(ctx.response.cycles ?? [], this.rows.map((r) => r.day), now))

    const inFlight = ctx.response.now.inFlight
    // Who did each minute of work, and whether a constitution is driving it.
    // Rebuilt here because both inputs move: cards on every poll, the ledger
    // when it lands.
    this.origins = buildOriginIndex(ctx.cards, this.byTmux)

    for (const row of this.rows) {
      const bounds = railBounds(row.day)
      const isToday = row.day === todayCivil
      const isPast = row.day < todayCivil
      const marks = isPast ? [] : marksForDay(ctx.cards, row.day, bounds)
      const visible = isToday ? marks.filter((m) => m.fraction > railFraction(now, bounds)) : marks

      const buckets = activity?.byDay.get(row.day) ?? []
      const waiting = activity ? rowWaitingOn(buckets, activity.origins) : null
      const sig = [
        row.day,
        this.dataGen,
        `w${waiting ?? ''}`,
        isToday ? `t${minute}` : isPast ? 'p' : 'f',
        visible.map((m) => `${m.kind}${m.cardId}`).join(','),
        isToday ? inFlight.map((c) => c.id).join(',') : '',
      ].join('|')
      if (row.sig === sig) continue
      row.sig = sig

      row.root.classList.toggle('wk-row-today', isToday)
      row.root.classList.toggle('wk-row-past', isPast)
      row.root.classList.toggle('wk-row-future', !isPast && !isToday)
      // The kanban's own muted register (KanbanModal.css), unchanged: a row
      // whose ink comes only from an origin we have lost contact with is
      // last-known-good, exactly as a stale card is.
      row.root.classList.toggle('kbn-card--stale', waiting !== null)

      row.paint.innerHTML = ''
      row.slots = buckets.length > 0 && activity
        ? rasterSlots(buckets, bounds, isToday ? now : bounds.endMs, (b) => originOf(this.origins, b))
        : []
      paintRaster(row.paint, row.slots)
      for (const mark of visible) row.paint.append(this.buildMark(mark, visible))
      if (isToday) {
        const nowLine = document.createElement('span')
        nowLine.className = 'wk-now'
        nowLine.style.left = `${railFraction(now, bounds) * 100}%`
        row.paint.append(nowLine)
      }

      // The only right-edge text now. Today additionally carries how many
      // workers are up: the seam and the live rasters say that SOMETHING is
      // running, and a count is the one thing they cannot say. Not their names
      // — a name at this size was the column we just removed.
      const spend = activity ? summarizeSpend(buckets) : null
      row.annot.textContent = annotationFor(spend, isPast, isToday, inFlight.length)
      const annotText = row.annot.textContent
      if (waiting !== null) {
        const badge = document.createElement('span')
        badge.className = 'kbn-card-waiting'
        badge.setAttribute('role', 'status')
        badge.textContent = `⌛ waiting on ${waiting}`
        row.annot.append(badge)
      }
      row.root.setAttribute(
        'aria-label',
        `${row.day} — ${annotText || 'no activity'}${
          waiting !== null ? `; waiting on ${waiting}` : ''
        }${
          visible.length > 0 ? `; ${visible.map((m) => `${m.kind} ${m.label}`).join(', ')}` : ''
        }`,
      )
    }

    // Read off the ink that ended up on the page, after every row is settled —
    // rows that skipped their repaint keep the slots they were last drawn with,
    // so this is the whole week either way.
    const constItem = this.key?.querySelector<HTMLElement>('.wk-key-const-item')
    if (constItem) {
      const anyConst = this.rows.some((r) => r.slots.some((s) => s.shuttle))
      constItem.style.display = anyConst ? '' : 'none'
    }
  }

  /**
   * "· in Sprint 14, Q3 push +1" — the week's place in something longer than
   * itself. Two names, then a count: the header states which cycles are in
   * play, it does not list them.
   */
  private paintCycles(cycles: KanbanCard[]): void {
    const host = this.cycles
    if (!host) return
    const key = cycles.map((c) => c.id).join(',')
    if (this.cyclesKey === key) return
    this.cyclesKey = key

    host.textContent = ''
    if (cycles.length === 0) return

    host.append(document.createTextNode('· in '))
    cycles.slice(0, CYCLE_CHIP_LIMIT).forEach((card, i) => {
      if (i > 0) host.append(document.createTextNode(', '))
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'wk-cycle'
      chip.textContent = card.name
      chip.title = `Open ${card.name}`
      chip.addEventListener('click', () => this.ctx?.openCard(card.id))
      host.append(chip)
    })
    const overflow = cycles.length - CYCLE_CHIP_LIMIT
    if (overflow > 0) {
      const more = document.createElement('span')
      more.className = 'wk-cycle-more'
      more.textContent = ` +${overflow}`
      more.title = cycles.slice(CYCLE_CHIP_LIMIT).map((c) => c.name).join(' · ')
      host.append(more)
    }
  }

  private buildMark(mark: DayMark, all: DayMark[]): HTMLElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = `wk-mark wk-mark-${mark.kind}`
    el.textContent = mark.glyph
    el.title = mark.label
    // Several obligations at the same position (every `due` sits at 10am) fan
    // out sideways rather than stacking into an illegible single glyph.
    const peers = all.filter((m) => m.fraction === mark.fraction)
    const offset = peers.indexOf(mark)
    el.style.left = `calc(${mark.fraction * 100}% + ${offset * 13}px)`
    el.addEventListener('click', () => this.ctx?.openCard(mark.cardId))
    return el
  }
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

function navButton(glyph: string, title: string, onClick: () => void): HTMLElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'wk-navbtn'
  el.textContent = glyph
  el.title = title
  el.setAttribute('aria-label', title)
  el.addEventListener('click', onClick)
  return el
}

/**
 * The one shared tick row under all seven rails.
 *
 * Nominal by necessity: one legend cannot track seven rails that are not all
 * the same length, so the labels sit at even sixths. That is exact for a normal
 * 24h rail and for six of the seven rows in a DST week — both zones move their
 * clocks on a Sunday, so only the last rail is off, and only by up to an hour.
 * The per-row rules (`railRuleFractions`) are the exact ones; this row names
 * them.
 */
function buildTickRow(): HTMLElement {
  const row = document.createElement('div')
  row.className = 'wk-row wk-tickrow'
  row.append(document.createElement('div')) // label gutter

  const rail = document.createElement('div')
  rail.className = 'wk-ticks'
  TICK_LABELS.forEach((label, i) => {
    const tick = document.createElement('span')
    tick.className = 'wk-tick'
    tick.style.left = `${(i / 6) * 100}%`
    if (i === 0) tick.classList.add('wk-tick-first')
    if (i === TICK_LABELS.length - 1) tick.classList.add('wk-tick-last')
    tick.textContent = label
    rail.append(tick)
  })

  row.append(rail, document.createElement('div'))
  return row
}

/**
 * The key. Rendered only when there are rasters to explain — a week wholly in
 * the future draws no ink, and a legend for marks that are not on the page is
 * the same noise the de-vibing removed.
 */
function buildKeyRow(): HTMLElement {
  const key = document.createElement('div')
  key.className = 'wk-key'
  for (const { kind, label } of ACTIVITY_KEY_ITEMS) {
    const item = document.createElement('span')
    item.className = 'wk-key-item'
    const glyph = document.createElement('span')
    glyph.className = `wk-key-glyph wk-key-${kind}`
    item.append(glyph, document.createTextNode(label))
    key.append(item)
  }

  // The second axis: the stroke. Kept OUT of ACTIVITY_KEY_ITEMS because that
  // list is the three pigments, shared verbatim with Day, and this is not a
  // fourth pigment — it is a weight any of the three can be drawn at. Hidden
  // until a constitution-driven tick is actually on the page (see `paint`), so
  // a week of plain fibers is not told about a distinction it never shows.
  const item = document.createElement('span')
  item.className = 'wk-key-item wk-key-const-item'
  const glyph = document.createElement('span')
  glyph.className = 'wk-key-glyph wk-key-agent wk-key-const'
  item.append(glyph, document.createTextNode('constitution-driven'))
  key.append(item)

  return key
}

// ── Raster slots: the ink, and what it is willing to say ─────────────────────

/** One kind's worth of one slot. */
export interface SlotKind {
  kind: ActivityBucket['k']
  /** Events in the slot — the sum of the buckets' `n`. What the tooltip says. */
  count: number
  /** The largest single minute in the slot. What the ink's weight reads. */
  peak: number
  /** Distinct names the slot's work joined to, strongest evidence first
   *  (fiber names; a session or directory when nothing earned it). */
  where: string[]
  /** Any of those names is a fiber carrying a `shuttle:` block. */
  shuttle: boolean
}

/** One drawn column of the raster, and everything a hover may report. */
export interface RasterSlot {
  index: number
  startMs: number
  endMs: number
  /** Centre of the slot, 0…1 along the rail. */
  fraction: number
  kinds: SlotKind[]
  /** Any kind in the slot is constitution-driven — the flag the tick's line
   *  style reads. */
  shuttle: boolean
  /** The transcripts behind this slot's minutes, deduped — what the hover asks
   *  `/api/v1/moment` for. Empty when nothing in the slot joined a recorded
   *  session, which is exactly when the words cannot be recovered. */
  sources: MomentSource[]
}

/**
 * Fold a day's buckets into drawable slots, joined to whoever did the work.
 *
 * Pure and DOM-free so the join, the counts and the tooltip text are testable
 * without a rail. `origin` is the join; passing it in rather than reaching for
 * the index keeps this function honest about its one input that is not data.
 */
export function rasterSlots(
  buckets: readonly ActivityBucket[],
  bounds: RailBounds,
  cutoffMs: number,
  origin: (bucket: ActivityBucket) => BucketOrigin,
): RasterSlot[] {
  const span = bounds.endMs - bounds.startMs
  if (span <= 0) return []

  const byIndex = new Map<number, Map<ActivityBucket['k'], SlotKind>>()
  // Which transcripts the slot's minutes came out of — the hover's route to
  // the words. Kept beside the kinds rather than inside them: a slot's words
  // are the slot's, whichever pigment the minute happened to be drawn in.
  const sourcesByIndex = new Map<number, (MomentSource | null)[]>()
  for (const b of buckets) {
    if (b.m > cutoffMs) continue
    const index = Math.floor((b.m - bounds.startMs) / RASTER_SLOT_MS)
    let kinds = byIndex.get(index)
    if (!kinds) {
      kinds = new Map()
      byIndex.set(index, kinds)
    }
    let entry = kinds.get(b.k)
    if (!entry) {
      entry = { kind: b.k, count: 0, peak: 0, where: [], shuttle: false }
      kinds.set(b.k, entry)
    }
    entry.count += b.n
    entry.peak = Math.max(entry.peak, b.n)
    const who = origin(b)
    if (!entry.where.includes(who.label)) entry.where.push(who.label)
    if (who.shuttle) entry.shuttle = true
    let found = sourcesByIndex.get(index)
    if (!found) {
      found = []
      sourcesByIndex.set(index, found)
    }
    found.push(who.source)
  }

  const slots: RasterSlot[] = []
  for (const [index, kinds] of byIndex) {
    const startMs = bounds.startMs + index * RASTER_SLOT_MS
    const list = [...kinds.values()]
    slots.push({
      index,
      startMs,
      endMs: startMs + RASTER_SLOT_MS,
      fraction: (index + 0.5) * RASTER_SLOT_MS / span,
      kinds: list,
      shuttle: list.some((k) => k.shuttle),
      sources: dedupeSources(sourcesByIndex.get(index) ?? []),
    })
  }
  return slots.sort((a, b) => a.index - b.index)
}

/**
 * One slot as words. Kinds read strongest-signal first — a hand raised, then a
 * human steering, then the agent work underneath both — which is the order the
 * ink is layered in, read top to bottom.
 *
 * `words` are what `/api/v1/moment` recovered for the slot, when anything was;
 * with none the renderer draws the honest note instead.
 */
export function slotTip(slot: RasterSlot, words?: MomentWords): SlotTip {
  const rows: SlotTipRow[] = []
  for (const kind of SLOT_KIND_ORDER) {
    const entry = slot.kinds.find((k) => k.kind === kind)
    if (!entry) continue
    rows.push({
      kind,
      phrase: SLOT_PHRASE[kind],
      where: entry.where.join(' · '),
      count: entry.count,
      shuttle: entry.shuttle,
    })
  }
  return {
    time: `${clockTime(slot.startMs)}–${clockTime(slot.endMs)}`,
    rows,
    ...(words?.excerpts.length ? { detail: words.excerpts } : {}),
    ...(words?.note ? { note: words.note } : {}),
  }
}

/**
 * Ink the day's rasters: one tick per active slot per kind, layered
 * agent → attention → notify so a notification always reads on top of the run
 * it interrupted. Opacity carries the run's weight, so a dense hour darkens
 * instead of merging into a block.
 *
 * A slot whose work is constitution-driven takes the heavier line
 * (`wk-ras-const`): same hue, same height hierarchy — those two already carry
 * the KIND — so the second axis has to be the stroke itself. See the key.
 */
function paintRaster(host: HTMLElement, slots: readonly RasterSlot[]): void {
  // `reply` is absent on purpose. The daemon emits it alongside an `agent`
  // bucket for the same minute, so that minute is already inked in the agent
  // pigment; a second tick would darken the same instant twice and invent a
  // distinction the eye should not be asked to make. Replies are read in the
  // annotation, not in the raster.
  const order: ActivityBucket['k'][] = ['agent', 'attention', 'notify']
  for (const kind of order) {
    for (const slot of slots) {
      const entry = slot.kinds.find((k) => k.kind === kind)
      if (!entry) continue
      const tick = document.createElement('span')
      tick.className = `wk-ras wk-ras-${kind}${entry.shuttle ? ' wk-ras-const' : ''}`
      tick.style.left = `${slot.fraction * 100}%`
      // Agent runs carry a count; attention and notify are single events and
      // read at a fixed weight so a busy hour of typing doesn't out-shout them.
      if (kind === 'agent') tick.style.opacity = String(0.38 + 0.47 * Math.min(1, entry.peak / 12))
      host.append(tick)
    }
  }
}

registerView(new WeekView())
