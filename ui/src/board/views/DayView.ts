/**
 * DayView (hotkey 2) — one day, close up.
 *
 * TWO CLOCKS, ONE LANE. The page is a rail per fiber, read left to right,
 * carrying both of the day's clocks at once — as ONE curve on two channels:
 *
 *   height   how much the AGENTS did, in one pigment
 *   spine    the exact minute you spoke, in cinnabar, rising to the curve's
 *            own height at that minute
 *
 * The arithmetic and the doctrine behind both live in `./densityCurve.js`.
 *
 * Below the rails, the same day told the other way: "the day, by fiber" —
 * the commit trail, set as prose under the fiber that made it.
 * One reading is what the machine did; the other is what the work says it
 * did. They rarely agree, and the disagreement is the interesting part.
 *
 * WHICH FIBER MADE A COMMIT is answered by the COMMIT LEDGER first — a hook
 * recorded the harness session at commit time, and that session names a fiber
 * through the session ledger. Reading the `<slug>: ` prefix off the subject is
 * the fallback, for the history the hook never saw. See "The commit ledger"
 * below.
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
 * THIS PAGE DRAWS SHUTTLE WORK. Both halves of it — the rails and the prose —
 * are joined by recorded evidence alone (`./join.js`): the session ledger for
 * the minutes, the commit ledger for the sentences. A bucket or a commit that
 * joins no fiber is not drawn at all, and the day's totals count only what was
 * drawn, so the figures in the head and the ink beneath them are one claim.
 *
 * NO COLOUR WITHOUT A MEANING. The board's ink has a grammar and this page
 * spends none of it decoratively: cobalt is agent activity and cinnabar is a
 * message of yours — the board's attention pigment, spent on the one mark here
 * that was addressed to somebody. It doubles as rubric ink for a section head,
 * which no reader confuses with a line on a rail.
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
  type ActivityBucket,
  type ActivityResult,
  type CommitRecord,
  type SessionPairing,
  type TemporalOrigins,
} from './TemporalData.js'
import {
  buildCurveSvg,
  aloftPhrase,
  curveField,
  curveGrid,
  daySigma,
  fieldPeak,
  ladderCountRoom,
  ladderHeight,
  ladderPitch,
  ladderRows,
  type ActivitySample,
  type CurveField,
  type LadderInterval,
  type LadderLine,
} from './densityCurve.js'
import { createViewEmptyState, createViewPage } from './ViewPage.js'
import {
  buildJoinIndex,
  buildLedgerNarration,
  joinBucket,
  ledgerBetween,
  momentSource,
  type LedgerNarration,
} from './join.js'
import { formatSpanMinutes, railBounds, shiftCivilDay } from './railTime.js'
import {
  ALOFT_KEY_LABEL,
  MARK_GLYPH,
  MOUND_KEY_LABEL,
  SPINE_KEY_LABEL,
  STATE_GLYPH,
  STATE_KEY_ITEMS,
  STATE_WORD,
  cardState,
  diffClause,
  diffClauseEl,
  messageClause,
  sumDiff,
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
  lastExchange,
  MomentLoader,
  pickMark,
  placeTip,
  reconcileRows,
  renderTip,
  rowCount,
  SLOT_KIND_ORDER,
  SLOT_PHRASE,
  tipContent,
  type DrawnKind,
  type LastExchange,
  type MarkPick,
  type MomentSource,
  type MomentWords,
  type SlotTip,
  type SlotTipRow,
} from './momentTip.js'
import { isPast, RailScrub } from './railScrub.js'
import './DayView.css'

// ── Shape of a day ───────────────────────────────────────────────────────────

const MINUTE_MS = 60_000
/** Breathing room the drawn frame keeps outside the day's first and last
 *  action, so the earliest mark is not flush against the sheet's edge. */
const FRAME_PAD_MINUTES = 15
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

// ── Drag to zoom ─────────────────────────────────────────────────────────────
//
// Day's frame already crops the empty dawn away (see `drawnWindow`), and that
// is a good default and a bad only-option: the hour you actually want to read
// is usually one of eight. So the rail is draggable — sweep a span and the
// page redraws inside it, axis and curves and spines and ladder together,
// because every one of them is a fraction of the frame and the frame is the
// only thing that moved.
//
// VIEW STATE, NOT A CURSOR. The zoom is not written to `ctx.focusDate` and not
// persisted: it is a way of looking at a day, not a claim about which day you
// are on. Paging away drops it, which is right — the span you swept out of
// Tuesday means nothing on Wednesday.

/** The narrowest span a drag may zoom to. Under about ten minutes the hour
 *  hand runs out of labels it is allowed to draw (see {@link TICK_STEPS_MINUTES},
 *  whose finest step is half an hour) and the rail becomes a picture of two
 *  events with no clock under it. */
export const ZOOM_MIN_MINUTES = 10

/**
 * A dragged span, made into a frame: ordered, widened to
 * {@link ZOOM_MIN_MINUTES}, snapped to whole minutes and clamped inside the
 * civil day.
 *
 * Clamped rather than rejected at the edges, and widened around its own centre,
 * so a sloppy two-pixel drag near dawn still lands on a legible frame instead of
 * on nothing. A zoom can never smuggle in a minute belonging to another page —
 * the rail is the outer bound, exactly as it is for `drawnWindow`.
 */
export function clampZoom(
  zoom: { startMs: number; endMs: number },
  rail: DayWindow,
): DayWindow {
  let startMs = Math.min(zoom.startMs, zoom.endMs)
  let endMs = Math.max(zoom.startMs, zoom.endMs)
  const shortfall = ZOOM_MIN_MINUTES * MINUTE_MS - (endMs - startMs)
  if (shortfall > 0) {
    startMs -= shortfall / 2
    endMs += shortfall / 2
  }
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
  return { startMs, endMs, minutes: Math.max(1, Math.round((endMs - startMs) / MINUTE_MS)) }
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

/**
 * A lane's beats as the curve wants them: weights per minute, and the minutes
 * you spoke in.
 *
 * A reply lands on the AGENT side. It is a message, but it is the machine's
 * message — counting it as human would let a talkative agent paint a rail teal
 * on its own, which is precisely the thing the colour channel exists to
 * prevent. Spines likewise mark attention minutes only.
 */
export function laneActivity(
  beats: readonly DayBeat[],
): { samples: ActivitySample[]; spines: number[] } {
  const samples: ActivitySample[] = []
  const spines: number[] = []
  for (const beat of beats) {
    let human = 0
    let agent = 0
    for (const { kind, count } of beat.kinds) {
      if (kind === 'attention') human += count
      else agent += count
    }
    // The minute is a bucket, so a mark belongs at its middle rather than at
    // the instant its first event happened to land.
    if (human > 0 || agent > 0) samples.push({ minute: beat.minute + 0.5, human, agent })
    if (human > 0) spines.push(beat.minute + 0.5)
  }
  return { samples, spines }
}

// ── Narration ────────────────────────────────────────────────────────────────

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
  /** The fiber this lane is. Every lane has one — an unjoined bucket is not
   *  drawn — so this is also the click target, unconditionally. */
  cardId: string
  /**
   * Distinct minutes carrying an attention / agent bucket — the figures the
   * ledger reports as "you 38m · agents 2h 10m".
   *
   * Counted from the buckets, never off the drawn curve. The curve is a
   * kernel-smoothed field: it has no edges to sum, and the smoothing reaches
   * minutes in which nothing happened. Ink and arithmetic answer to the same
   * events, but only one of them is allowed to be blurred.
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
   * What actually happened, minute by minute, oldest first — the ground truth
   * BOTH the curve and the hover are built from.
   *
   * The curve smooths these; the tooltip must not. A pointer near a lull is
   * standing on a curve that the kernel carried there from minutes on either
   * side, and answering with "work happened here" would be a lie the ink is
   * allowed to tell and the words are not. So the beats stay unsmoothed, each
   * carrying its own counts and its own transcripts, and the hover snaps to
   * them rather than hit-testing the paint.
   */
  beats: DayBeat[]
  /**
   * THE LADDER: this fiber's spans of time, as the rail draws them — the
   * sessions that ran (the floors) and the subagents they sent out (the
   * rungs). Joined exactly as a minute is, through the session ledger on the
   * tmux name the daemon stamped.
   *
   * Kept apart from the beats because it is not a per-minute fact: a session
   * and a delegation are SPANS, and the questions they answer — who was aloft,
   * between which two instants, how many at once — cannot be asked of a minute
   * at all.
   */
  ladder: LadderInterval[]
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
  /**
   * Lines added and removed across the whole day, summed from the COMMIT
   * LEDGER over the commits it actually joined to a fiber on this page.
   * Absent when the day's ledger is not covered (no ledger input, not merely
   * zero commits), which is not the same claim as a day of no change: an
   * absent figure prints nothing rather than `+0 −0`.
   */
  insertions?: number
  deletions?: number
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
function countExchange(
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

/**
 * What the whole day cost: agent minutes, attention minutes (still the rail's
 * own measure) and the exchange, summed across every fiber THE PAGE DRAWS.
 *
 * Counted over the joined buckets only, the same set the lanes are built from.
 * A head figure larger than the ink beneath it would be a number with nothing
 * to point at — and the minutes it counted would be work this board never
 * dispatched.
 */
export function dayTotals(
  activity: ActivityResult,
  cards: KanbanCard[],
  win: DayWindow,
  byTmux?: ReadonlyMap<string, SessionPairing>,
): DayTotals {
  const index = buildJoinIndex(cards, byTmux)
  const buckets = activity.buckets.filter((bucket) => joinBucket(index, bucket) !== null)
  const { attention, agent } = foldActiveMinutes(buckets, {
    fromMs: win.startMs,
    toMs: win.endMs,
  })
  const { sent, received } = countExchange(buckets, win)
  return { attention, agent, messages: sent, received }
}

function minuteIndex(ms: number, win: DayWindow): number | null {
  const index = Math.floor((ms - win.startMs) / MINUTE_MS)
  if (index < 0 || index >= win.minutes) return null
  return index
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
 * (hostnames are case-insensitive and a rail full of `Basalt-Login-02` beside
 * `basalt-login-02` would read as two machines), so the staleness lookup has to
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
      | 'ladder'
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
    /**
     * THE SESSIONS THIS LANE RAN, as first-minute → last-minute per session id.
     *
     * There is no "session started" record on the activity plane — a session is
     * only ever visible as the minutes it emitted. So its extent is exactly
     * that: the span between the first and last minute stamped with its id.
     * That is a recorded fact rather than an inference, and it is the honest
     * answer to "when was this session up": we know it was working then, and we
     * know nothing about the silence either side.
     */
    sessions: Map<string, { first: number; last: number }>
    spawns: LadderInterval[]
  }
  const acc = new Map<string, Acc>()

  for (const bucket of activity.buckets) {
    const minute = minuteIndex(bucket.m, win)
    if (minute === null) continue
    const card = joinBucket(index, bucket)
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
        },
        cardHost: (card.shuttleHost ?? '').trim().toLowerCase(),
        hosts: new Map(),
        agent: new Set(),
        attention: new Set(),
        all: new Set(),
        messages: 0,
        replies: 0,
        beats: new Map(),
        sessions: new Map(),
        spawns: [],
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
    // The session's own extent, widened by every minute it emitted — the
    // ladder's floor. See `Acc.sessions`.
    const session = (bucket.s ?? '').trim()
    if (session) {
      const held = entry.sessions.get(session)
      if (held) {
        if (bucket.m < held.first) held.first = bucket.m
        if (bucket.m > held.last) held.last = bucket.m
      } else entry.sessions.set(session, { first: bucket.m, last: bucket.m })
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
    // The same pairing that named this minute's fiber also names the session
    // whose transcript holds its words.
    beat.sources.push(momentSource(index, bucket))
  }

  // The delegations, onto the lanes the minutes already built. A spawn never
  // opens a lane of its own: an interval with no activity under it would be a
  // rail with a hairline and no curve, which says a fiber was working while
  // showing that it was not.
  for (const span of activity.spawns ?? []) {
    const card = joinBucket(index, span)
    if (!card) continue
    acc.get(`fiber:${card.id}`)?.spawns.push({
      start_ms: span.start_ms,
      end_ms: span.end_ms,
      open: span.open,
      kind: 'agent',
      // The label is the delegation's OWN name and nothing else — a workflow
      // has one, an Agent does not. The tool travels beside it rather than
      // standing in for it, so the words can say "workflow felt-cleanup-audit"
      // and "Agent" out of the same two fields.
      ...(span.label ? { label: span.label } : {}),
      ...(span.tool ? { tool: span.tool } : {}),
      ...(span.agents ? { agents: span.agents } : {}),
    })
  }

  const lanes: DayLane[] = [...acc.values()].map((entry) => {
    const host = dominantHost(entry.hosts) || entry.cardHost
    return {
      ...entry.lane,
      host,
      hostNote: host && host !== pageHost ? host : '',
      stale: isOriginStale(folded, host || null),
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
      // The floors, then the rungs. A session of a single minute still gets a
      // line: `ladderRows` clips but never drops, and the mark says "this
      // session was up, briefly", which is true and is the news.
      ladder: [
        ...[...entry.sessions.entries()].map(([session, at]): LadderInterval => ({
          start_ms: at.first,
          // The last minute is a full minute wide — a session whose last event
          // was at 14:03 was up through 14:04, not up to an instant.
          end_ms: at.last + MINUTE_MS,
          open: false,
          kind: 'session',
          label: session,
        })),
        ...entry.spawns,
      ],
    }
  })

  // Reading order is CHRONOLOGY OF LETTING GO: the lane that finished
  // earliest sits at the top, the one still running sits at the bottom — so
  // the page reads top-left to bottom-right like a day being written, and the
  // eye's resting place (the bottom) is where the live work that can still
  // want you is. Ties (and the live ones among themselves) break by when they
  // began, earliest first; volume no longer orders anything.
  // Beat minutes are FRAME-relative (see the render's `frame.startMs +
  // b.minute * MINUTE_MS`); the ladder speaks epoch ms. Both are brought to
  // epoch before any max/min may compare them.
  const laneEndMs = (lane: DayLane): number => {
    if (lane.ladder.some((r) => r.open)) return Number.POSITIVE_INFINITY
    let end = 0
    for (const r of lane.ladder) end = Math.max(end, r.end_ms)
    for (const b of lane.beats) end = Math.max(end, win.startMs + (b.minute + 1) * MINUTE_MS)
    return end
  }
  const laneStartMs = (lane: DayLane): number => {
    let start = Number.POSITIVE_INFINITY
    for (const r of lane.ladder) start = Math.min(start, r.start_ms)
    for (const b of lane.beats) start = Math.min(start, win.startMs + b.minute * MINUTE_MS)
    return start
  }
  lanes.sort((a, b) => {
    const end = laneEndMs(a) - laneEndMs(b)
    if (end !== 0) return end
    const start = laneStartMs(a) - laneStartMs(b)
    if (start !== 0) return start
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
  /**
   * Lines added and removed across this fiber's day, summed from the COMMIT
   * LEDGER — the one source that knows a diff's size, because it was written by
   * a hook standing beside the commit. Absent for a fiber whose day the ledger
   * does not cover, which is not the same claim as a day of no change: an
   * absent figure prints nothing rather than `+0 −0`.
   */
  insertions?: number
  deletions?: number
}

/**
 * `you 14 · 9 back · agents 2h 10m · 3 commits · +42 −7`, with empty terms
 * dropped rather than printed as zeros — a row of `0`s is noise, not
 * information.
 *
 * The diff clause is last and, like every other term here, MUTED: it is the
 * size of the day's change, not a score. Either side may be zero on its own (a
 * pure deletion adds nothing), and each is dropped independently; both zero, or
 * both absent, prints no clause at all.
 */
export function formatEntryStats(stats: DayEntryStats): string {
  const parts: string[] = []
  const received = stats.received ?? 0
  if (stats.messages > 0 || received > 0) {
    parts.push(messageClause(stats.messages, received))
  }
  if (stats.agent > 0) parts.push(`agents ${formatSpanMinutes(stats.agent, { pad: true })}`)
  if (stats.commits > 0) parts.push(`${stats.commits} commit${stats.commits === 1 ? '' : 's'}`)
  const diff = diffClause(stats.insertions ?? 0, stats.deletions ?? 0)
  if (diff) parts.push(diff)
  return parts.join(' · ')
}

export interface DayEntry {
  key: string
  /** Bold leading token: the lane's own label, word for word, so the two
   *  halves of the page name the same thing. */
  title: string
  /** The prose: subjects joined with "; ", or an italic outcome fallback. */
  body: string
  /** True for the outcome fallback — set in italic, it is not a commit. */
  fallback?: boolean
  cardId: string
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
 * "The day, by fiber": one entry per lane, in lane order, titled exactly as its
 * lane is — what it committed, or, when it committed nothing, the first
 * sentence of its own outcome.
 *
 * THE PROSE READS IN LANE ORDER. The two halves of the page are the same day
 * told twice — rails for when, prose for what — so the reader must be able to
 * go from a rail to its sentence without hunting. Ordering by commit chronology
 * instead (as this first did) puts the two halves in unrelated orders and turns
 * an obvious correspondence into a lookup.
 *
 * There is no third kind of row. A commit the ledger cannot attribute to a
 * fiber on this page is not this page's to narrate.
 */
export function buildDayEntries(
  lanes: DayLane[],
  cards: KanbanCard[],
  win: DayWindow,
  nowMs: number = Date.now(),
  /** What the COMMIT LEDGER attributed — the whole of the prose. */
  ledger?: LedgerNarration,
): DayEntry[] {
  const cardById = new Map(cards.map((card) => [card.id, card]))
  const isLiveRail = nowMs >= win.startMs && nowMs < win.endMs

  const entries: DayEntry[] = []
  for (const lane of lanes) {
    const recorded = ledger?.byCard.get(lane.cardId)
    const subjects = recorded?.subjects ?? []
    const card = cardById.get(lane.cardId)
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
        commits: recorded?.commits ?? 0,
        insertions: recorded?.insertions,
        deletions: recorded?.deletions,
      },
    }
    entries.push(
      subjects.length > 0
        ? { key: `lane:${lane.key}`, title: lane.label, body: subjects.join('; '), ...operational }
        : {
            // Worked, but said nothing: its own outcome stands in, in italic,
            // so the line cannot be mistaken for something the day reported.
            key: `lane:${lane.key}`,
            title: lane.label,
            body: firstSentence(card?.outcome) || 'worked, wrote nothing down',
            fallback: true,
            ...operational,
          },
    )
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
function mergeOrigins(
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

/**
 * The commit ledger as this page consumes it: the window's records, the session
 * index they join through, and the feed's own freshness block.
 *
 * Bundled rather than three more positional parameters — `buildDayModel`
 * already carries eight, and three of the four fields are useless without the
 * others.
 */
export interface DayLedgerInput {
  records: readonly CommitRecord[]
  bySession: ReadonlyMap<string, SessionPairing>
  origins?: TemporalOrigins
}

export function buildDayModel(
  dayISO: string,
  activity: ActivityResult,
  cards: KanbanCard[],
  shuttleBase: string,
  nowMs: number = Date.now(),
  byTmux?: ReadonlyMap<string, SessionPairing>,
  /** The LEDGER's origins block; activity's rides on `activity` itself. */
  sessionOrigins?: TemporalOrigins,
  /** The COMMIT ledger, and the session index it joins through. Absent on a
   *  daemon with no such route, which leaves the page its rails and no prose:
   *  there is no second source for what the day said. */
  ledger?: DayLedgerInput,
  /** A sub-span the reader dragged out on the rail. When set it REPLACES the
   *  computed frame, and every mark on the page is rebuilt against it — see
   *  {@link clampZoom}. Nothing else about the page changes: the civil day, the
   *  totals and the prose are all judged against the rail, not the frame. */
  zoom?: { startMs: number; endMs: number } | null,
): DayModel {
  const win = dayWindow(dayISO)
  // The lanes are built against the FRAME, so a lane's minute indices are
  // already the coordinates the chart draws in. Nothing is lost: the frame
  // reaches every bucket the rail holds — and when a zoom narrows it, the
  // minutes outside are dropped, which is what a zoom means.
  const frame = zoom ? clampZoom(zoom, win) : drawnWindow(win, activity.buckets, nowMs)
  const origins = mergeOrigins(
    mergeOrigins(activity.origins, sessionOrigins),
    ledger?.origins,
  )
  const lanes = buildDayLanes(activity, cards, frame, byTmux, origins)
  // The prose, cut to the RAIL — the same edges the lanes are drawn to, so
  // both halves of the page describe one day.
  const recorded = ledger
    ? buildLedgerNarration(ledgerBetween(ledger.records, win.startMs, win.endMs), cards, ledger.bySession)
    : undefined
  const totals = dayTotals(activity, cards, win, byTmux)
  // Only RECORDED, joined commits count toward the day's diff — no fallback
  // to an estimate the ledger didn't actually attribute.
  if (recorded) {
    const diff = sumDiff(recorded.byCard.values())
    totals.insertions = diff.insertions
    totals.deletions = diff.deletions
  }
  return {
    dayISO,
    window: win,
    frame,
    host: (activity.host ?? '').toLowerCase(),
    origins,
    totals,
    lanes,
    entries: buildDayEntries(lanes, cards, win, nowMs, recorded),
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
        // The beats ARE the curve's input, so digesting them digests the ink:
        // any minute whose weight or kind changed moves the shape and must
        // repaint. Cheaper than the curve and exactly as sensitive.
        `${lane.beats.map((b) => `${b.minute}:${b.kinds.map((k) => `${k.kind}${k.count}`).join('')}`).join(',')}`,
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
  // can give a bucket a fiber it had none for, and the page must repaint.
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
    `${model.dayISO}\n${model.totals.messages}/${model.totals.received}/${model.totals.agent}` +
    `/${model.totals.insertions ?? ''}/${model.totals.deletions ?? ''}\n` +
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

/** Day's swatch per drawn kind. There is one wash pigment now, and a reply is
 *  agent work like any other: what you did is the spine, not a colour. */
const DAY_KEY_CLASS: Record<DrawnKind, string> = {
  agent: 'kbn-day-key-agent',
  attention: 'kbn-day-key-agent',
  reply: 'kbn-day-key-agent',
}

/** One entry in the key: the mark itself, in miniature, then what it means. */
function buildKey(glyphClass: string, text: string): HTMLElement {
  const item = document.createElement('span')
  item.className = 'kbn-view-key-item kbn-day-key'
  const glyph = document.createElement('i')
  glyph.className = `kbn-day-keyglyph ${glyphClass}`
  item.append(glyph, document.createTextNode(text))
  return item
}

/**
 * The state group in Day's key: a glyph and its word for each state THIS PAGE
 * ACTUALLY DREW, in the life-order of a fiber.
 *
 * It used to print all six unconditionally, which made the key a glossary of
 * the Desk's vocabulary rather than a reading of this sheet: on a normal day
 * four of the six words named glyphs that appear nowhere on the page, and the
 * reader is left hunting the rails for a ✗ that was never inked. A key must
 * only teach the marks its own page draws — the same rule the aloft entry
 * already followed — so the caller hands in the states in the gutter and
 * nothing else is glossed.
 *
 * The pigments are the lane gutter's own, so the key cannot drift from the
 * marks it explains.
 */
function buildStateKey(present: ReadonlySet<LifecycleState>): HTMLElement | null {
  const states = STATE_KEY_ITEMS.filter((state) => present.has(state))
  if (states.length === 0) return null
  const item = document.createElement('span')
  item.className = 'kbn-view-key-item kbn-day-key kbn-day-key-states'
  for (const state of states) {
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

/** The gestures, taught once. This line replaced a per-lane `title`
 *  attribute: the rail's hover already belongs to the moment tooltip, and the
 *  OS's native gray box arriving late on top of it was two voices where the
 *  legend's one suffices.
 *
 *  It names the DIVIDER rather than the two halves, because the divider is
 *  drawn on the page: a reader who has read this line once can see, from then
 *  on, which of the two things a click is about to do. */
function buildGestureKey(): HTMLElement {
  const item = document.createElement('span')
  item.className = 'kbn-view-key-item kbn-day-key kbn-day-key-gesture'
  item.textContent = 'click in the day pins the moment (← → to scrub) · click past now opens the terminal · drag zooms'
  return item
}

/** Pixels a pointer may be from a minute and still be asking about it. Day's
 *  rails are wide — a whole day across the sheet — so the snap is generous
 *  enough that the marks are hoverable rather than a game of aim. */
const BEAT_SNAP_PX = 9

/** The width a `×122` claims to the right of the rung it belongs to — four
 *  digits of 6px type plus the gap that keeps it off the rung's own end. The
 *  clearance test is in fractions of the frame, so this is the numerator the
 *  render converts once per page. */
const COUNT_LABEL_PX = 26

/** Where a lane's click lands: the worker's terminal, or the fiber itself. */
export type LaneOpenTarget =
  | { kind: 'worker'; tmux: string; host?: string }
  | { kind: 'card' }

/**
 * Resolve a lane's click target from the card behind it.
 *
 * The terminal needs two things and this checks both: a worker actually in the
 * air, and a host wired to attach to one. Missing either, the click opens the
 * fiber — a real destination rather than a dead gesture, which is what a click
 * that resolved to nothing looked like from the outside.
 */
export function laneOpenTarget(
  card: KanbanCard | undefined,
  canAttach: boolean,
): LaneOpenTarget {
  const tmux = card?.runningWorker
  if (!tmux || !canAttach) return { kind: 'card' }
  return { kind: 'worker', tmux, ...(card.shuttleHost ? { host: card.shuttleHost } : {}) }
}

/**
 * One lane-minute as words, in the shared tooltip's shape.
 *
 * IT DOES NOT NEED THE LANE, which is the point: `where` is empty on every row
 * because on Day the rail you are pointing at is already labelled with the
 * fiber, a few centimetres to the left and in view the whole time the pointer
 * was travelling here. The row says which pigment and how much; the label
 * beside it says who, as it always did.
 */
export function beatTip(
  beat: DayBeat,
  win: DayWindow,
  words?: MomentWords,
  pinned = false,
): SlotTip {
  const startMs = win.startMs + beat.minute * MINUTE_MS
  const rows: SlotTipRow[] = []
  for (const kind of SLOT_KIND_ORDER) {
    const entry = beat.kinds.find((k) => k.kind === kind)
    if (!entry) continue
    rows.push({
      kind,
      phrase: SLOT_PHRASE[kind],
      // NO FIBER NAME. The lane's own label is on the same row, a few
      // centimetres to the left, and has been the whole time the pointer was
      // travelling to this minute. Repeating it spent the head line on the one
      // thing the reader could already see. The rule the card follows: never
      // restate what the surface already shows at the pointer's position —
      // which is why WEEK still names the fiber (its rows are days, and the
      // fiber is exactly what its surface cannot tell you).
      where: '',
      // Only where the tally counts messages — see `rowCount`. The agent
      // band's `n` counts harness hook events (a call's two ends, a session
      // start, a minute filled between them) and was the source of the slip's
      // oldest lie: "tool calls ×7" over whatever the transcript returned.
      // What ran is counted by the tools section, which lists what it counts.
      ...(rowCount(kind, entry.count) === undefined ? {} : { count: rowCount(kind, entry.count) }),
      // Day has no constitution stroke on its rails, so nothing here may claim
      // one: the flag exists to explain a mark's weight, and an unweighted mark
      // that wore it would be the legend lying.
      shuttle: false,
    })
  }
  const content = tipContent(words, pinned)
  return {
    time: `${clockTime(startMs)}–${clockTime(startMs + MINUTE_MS)}`,
    rows: reconcileRows(rows, content),
    ...content,
  }
}

/**
 * A minute the scrub bar landed on that holds no mark at all.
 *
 * Scrubbing steps by the MINUTE, not from mark to mark, so most steps on a
 * quiet lane land here — and an empty minute is a real answer about a day, not
 * a failure to answer. The slip says the time and says nothing happened, which
 * is the honest report and keeps the panel from flickering out of existence
 * every other keystroke.
 */
export function emptyMinuteTip(startMs: number, pinned = false): SlotTip {
  return {
    time: `${clockTime(startMs)}–${clockTime(startMs + MINUTE_MS)}`,
    rows: [],
    resolved: true,
    pinned,
    note: 'nothing recorded in this minute',
  }
}

/**
 * How far back the magnet's fetch may reach for the words of the last
 * exchange, in minutes.
 *
 * The two turns are located from the BEATS, which cost nothing — so this bounds
 * only the transcript read, and only in the uncommon case where your last
 * message and the agent's are hours apart. A turn older than this keeps its row
 * (the row is built from the recorded kinds) and simply arrives without its
 * words, which is the same honest degradation as a transcript that was cleaned
 * up. Inventing a sentence, or silently dropping the turn, would both be worse.
 */
const MAGNET_LOOKBACK_MINUTES = 90

/**
 * The magnet's slip: THE LAST EXCHANGE ON THIS LANE, in the order it happened.
 *
 * A row per turn, sequenced rather than sorted into register order — see
 * {@link lastExchange} for why the order carries the meaning — then the tool
 * calls that landed afterwards, if any, as their own muted line. The excerpts
 * underneath are the same cards an ordinary hover draws, so the registers
 * (cinnabar you, blue agent, muted tool call) are the ones already on the page.
 */
export function magnetTip(
  exchange: LastExchange,
  words?: MomentWords,
  pinned = false,
): SlotTip {
  const rows: SlotTipRow[] = exchange.turns.map((turn) => ({
    kind: turn.kind,
    phrase: SLOT_PHRASE[turn.kind],
    where: clockTime(turn.atMs),
    shuttle: false,
  }))
  if (exchange.toolsAfter) {
    rows.push({
      kind: 'agent',
      // "since" rather than "at": the span covers every minute after the last
      // word, and pointing it at one instant would understate it.
      phrase: SLOT_PHRASE.agent,
      where: `since ${clockTime(exchange.turns[exchange.turns.length - 1]?.atMs ?? exchange.toolsAfter.atMs)}`,
      // MINUTES, IN WORDS, NOT A `×N`. This row used to print the summed
      // bucket tally as a count, which read as "this many tool calls" and was
      // a sum of harness events — and, being a lane-wide sum, could never have
      // been listed under it in any case. How LONG it has been working since
      // it last spoke is the fact the magnet is actually reporting, and a
      // minute count with its unit attached promises nothing it cannot show.
      note: `${exchange.toolsAfter.minutes} min`,
      shuttle: false,
    })
  }
  // The heading says WHEN the lane last did anything — the magnet is answering
  // about a lane rather than about a minute, and "last at" is the part of that
  // the surface cannot show. The lane's name is not here for the reason it is
  // not on the rows: it is already on this row, to the left.
  const last = exchange.toolsAfter?.atMs ?? exchange.turns[exchange.turns.length - 1]?.atMs
  const content = tipContent(words, pinned)
  return {
    time: last === undefined ? '' : `last at ${clockTime(last)}`,
    rows: reconcileRows(rows, content),
    ...content,
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
  /** The gridline layer — the one element that spans exactly the rail column
   *  and the full stack of lanes, which is what the zoom band is drawn in. */
  private gridEl: HTMLElement | null = null
  private tip: HTMLElement | null = null
  /** The lane-minute the pointer is on (`<lane key>:<minute>`); a late answer
   *  is checked against it before it paints. */
  private hoveredKey: string | null = null
  /** The lane-minute a CLICK fixed the tooltip to, if any. While this is set
   *  the pointer no longer moves or closes the slip — see {@link showBeatTip}. */
  private pinnedKey: string | null = null
  /** Every lane's rail, by key — what a scrub needs to redraw a slip for a
   *  minute nobody is pointing at. Rebuilt with the chart. */
  private railByLane = new Map<string, { lane: DayLane; rail: HTMLElement }>()
  /**
   * The pinned moment's bar, and the keyboard that walks it.
   *
   * The geometry is handed over rather than reached for: the bar hangs in the
   * GRIDLINE layer, which is the one element spanning exactly the rail column
   * and exactly the stack of lanes — so a full-height mark is a percentage
   * across it, and the same box maps a drag's x back to an instant.
   */
  private readonly scrub = new RailScrub({
    frame: () => this.frame,
    rail: () => {
      const grid = this.gridEl
      if (!grid) return null
      const box = grid.getBoundingClientRect()
      return { host: grid, left: box.left, width: box.width }
    },
    stepMs: MINUTE_MS,
    onMove: (target) => this.showPinnedMinute(target.laneKey, target.atMs),
  })
  private moments = new MomentLoader((session, fromMs, toMs, host, full) =>
    this.ctx
      ? this.ctx.moment(session, fromMs, toMs, host, full)
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
  /** The model a repaint wanted to draw while a tooltip was pinned. Drawn when
   *  the pin closes; see the deferral in `apply`. */
  private pendingModel: DayModel | null = null
  /** Monotonic load id — a fetch that lands after a newer one is discarded. */
  private loadToken = 0

  // ── Zoom ───────────────────────────────────────────────────────────────────

  /** The span the reader dragged out, or null for the computed frame. VIEW
   *  STATE: never written to the cursor, never persisted, dropped on paging. */
  private zoom: { startMs: number; endMs: number } | null = null
  /** The last load's raw inputs, so a zoom can rebuild the model without going
   *  back to the network — the day did not change, only the window on it. */
  private lastLoad: {
    dayISO: string
    activity: ActivityResult
    sessionOrigins?: TemporalOrigins
    ledger: DayLedgerInput
  } | null = null
  /** A drag in flight: where it started, and the band drawn while it runs. */
  private drag: { startMs: number; endMs: number; band: HTMLElement } | null = null
  /** Set for exactly one click event — the synthetic one the browser fires
   *  after a drag's mouseup, which must not pin a tooltip. */
  private dragJustEnded = false
  /** The chart's own geometry while a drag runs, so the move handler is
   *  arithmetic rather than a `getBoundingClientRect` per pixel. */
  private dragBox: { left: number; width: number; win: DayWindow } | null = null
  /** How far the pointer must travel before a press becomes a zoom rather than
   *  a click. Below this the gesture is a pin, and the two never fight. */
  private static readonly DRAG_THRESHOLD_PX = 6
  private dragOrigin: { clientX: number; armed: boolean } | null = null

  /** Escape closes a pinned slip — before anything else looks at the key, and
   *  only when one is actually open, so Escape keeps every other meaning it has
   *  on this page. */
  private readonly onEscape = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    // The slip first, the zoom second — one Escape undoes one thing, and the
    // slip is the nearer of the two to whatever you were just doing.
    if (this.pinnedKey !== null) {
      e.stopPropagation()
      this.hideTip(true)
      return
    }
    if (this.zoom === null) return
    e.stopPropagation()
    this.applyZoom(null)
  }

  /** A click anywhere that is not a rail puts the slip away. Bubble phase, so
   *  the rail's own handler has already stopped the click that pinned it. */
  private readonly onDocClick = (): void => {
    if (this.pinnedKey !== null) this.hideTip(true)
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (keystrokeIsSpokenFor()) return
    // THE BAR GETS FIRST REFUSAL ON THE ARROWS. While a moment is pinned, left
    // and right mean "a minute earlier / later" — the reason the bar exists —
    // and paging the whole view to yesterday under a reader who is scrubbing
    // would throw away the thing they were reading. It declines every key it
    // does not use, so nothing else here is shadowed.
    if (this.scrub.handleKey(e)) return
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 't') return
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
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
    dateRow.className = 'kbn-view-nav kbn-day-daterow'
    dateRow.append(
      this.buildChevron('‹', 'Previous day', -1),
      this.headingEl,
      this.buildChevron('›', 'Next day', 1),
      this.todayEl,
    )

    // What the day cost, in the middle of the head rather than under the date.
    // It is a line the page states about itself, not a control — and the
    // scaffold's centre slot is out of flow, so stating it costs Day's head no
    // height and Day, Week and Chronicle all wear the same one-line head.
    this.statsEl = document.createElement('div')
    this.statsEl.className = 'kbn-view-headfigures kbn-day-stats'
    this.statsEl.textContent = ''

    page.titleCenter.append(this.statsEl)
    page.titleRow.append(dateRow)

    this.bodyEl = page.body
    this.root = page.root
    host.append(page.root)

    document.addEventListener('keydown', this.onKeyDown)
    document.addEventListener('keydown', this.onEscape, true)
    document.addEventListener('click', this.onDocClick)
    // The drag lives on the document once it starts, so a sweep that runs off
    // the sheet still selects to the edge and still ends when the button does.
    document.addEventListener('mousemove', this.onDragMove)
    document.addEventListener('mouseup', this.onDragUp)
    this.syncToCursor()
  }

  refresh(ctx: ViewContext): void {
    this.ctx = ctx
    this.syncToCursor()
  }

  unmount(): void {
    document.removeEventListener('keydown', this.onKeyDown)
    document.removeEventListener('keydown', this.onEscape, true)
    document.removeEventListener('click', this.onDocClick)
    document.removeEventListener('mousemove', this.onDragMove)
    document.removeEventListener('mouseup', this.onDragUp)
    this.scrub.dispose()
    this.railByLane.clear()
    this.pinnedKey = null
    this.zoom = null
    this.lastLoad = null
    this.drag = null
    this.dragOrigin = null
    this.dragBox = null
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
    this.gridEl = null
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
      // The span you swept out of Tuesday means nothing on Wednesday.
      this.zoom = null
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
    button.className = 'kbn-view-chev kbn-day-chev'
    button.textContent = glyph
    button.title = label
    button.setAttribute('aria-label', label)
    button.addEventListener('click', () => this.step(delta))
    return button
  }

  /** Three reads — activity, the session ledger and the commit ledger — all
   *  memoized upstream, all degrading to empty on their own. */
  private async load(dayISO: string): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    const win = dayWindow(dayISO)
    const token = (this.loadToken += 1)

    const [activity, sessions, commits] = await Promise.all([
      // `to_ms` is INCLUSIVE on both endpoints while the rail's own end is
      // exclusive, so ask for the last minute we draw, not the first we don't.
      ctx.activity(win.startMs, win.endMs - MINUTE_MS),
      // The whole ledger, with a CONSTANT argument: it is keyed by the tuple
      // upstream, so a moving `since` would mint a fresh cache entry per poll
      // and re-fetch a file that changes a few times a day.
      ctx.sessions(0),
      ctx.commits(win.startMs, win.endMs - MINUTE_MS),
    ])
    // A day the human has since navigated away from, or an unmounted view.
    if (token !== this.loadToken || !this.bodyEl || dayISO !== this.shownDay) return

    const index = buildSessionIndex(sessions.records)
    this.byTmux = index.byTmux
    this.lastLoad = {
      dayISO,
      activity,
      sessionOrigins: sessions.origins,
      ledger: { records: commits.records, bySession: index.bySession, origins: commits.origins },
    }
    const model = this.buildModel(this.lastLoad)
    const signature = dayModelSignature(model)
    if (signature === this.signature) {
      // Nothing new to draw, but the clock still moved.
      this.positionNow()
      return
    }
    // A PINNED TOOLTIP HOLDS THE PAGE STILL. `buildChart` throws the chart and
    // the slip away and builds both again, so a repaint under a pinned slip is
    // the slip vanishing mid-sentence — and it arrives on its own schedule,
    // which is the worst possible moment. The page is a few seconds stale for
    // exactly as long as someone is reading it, and the deferred model is
    // drawn the instant the pin closes.
    if (this.pinnedKey !== null) {
      this.pendingModel = model
      return
    }
    this.pendingModel = null
    this.signature = signature
    this.render(model)
  }

  /** One place the model is assembled, so a zoom rebuild and a fresh load
   *  cannot drift into two slightly different pages of the same day. */
  private buildModel(load: NonNullable<DayViewImpl['lastLoad']>): DayModel {
    const ctx = this.ctx
    return buildDayModel(
      load.dayISO,
      load.activity,
      ctx?.cards ?? [],
      ctx?.shuttleBase ?? '',
      Date.now(),
      this.byTmux,
      load.sessionOrigins,
      load.ledger,
      this.zoom,
    )
  }

  /**
   * Redraw the day inside a new window, from data already in hand.
   *
   * The signature is reset rather than compared: the frame is part of it, so a
   * zoom always differs — and resetting says why, which is that this is a
   * deliberate re-frame and not a poll that happened to notice a change.
   */
  private applyZoom(zoom: { startMs: number; endMs: number } | null): void {
    this.zoom = zoom
    const load = this.lastLoad
    if (!load || load.dayISO !== this.shownDay) return
    // A pinned slip belongs to a mark on the old frame; the frame is going.
    this.pinnedKey = null
    this.pendingModel = null
    const model = this.buildModel(load)
    this.signature = dayModelSignature(model)
    this.render(model)
  }

  /**
   * Begin a drag on the rails. NOT a zoom yet — a press is a pin until the
   * pointer has travelled {@link DayViewImpl.DRAG_THRESHOLD_PX}, which is what
   * keeps click-to-pin and drag-to-zoom out of each other's way on a surface
   * that has to carry both.
   */
  private readonly onDragDown = (e: MouseEvent): void => {
    if (e.button !== 0) return
    const chart = this.chartEl
    const win = this.frame
    if (!chart || !win) return
    // Only the rails are draggable. A press on the legend or the hour hand is
    // not a gesture about a span of time, and treating it as one would zoom the
    // page whenever somebody swept a selection over the caption.
    if (!(e.target instanceof Element) || !e.target.closest('.kbn-day-rail')) return
    const rail = chart.querySelector<HTMLElement>('.kbn-day-rail')
    if (!rail) return
    const box = rail.getBoundingClientRect()
    if (box.width <= 0 || e.clientX < box.left || e.clientX > box.right) return
    this.dragBox = { left: box.left, width: box.width, win }
    this.dragOrigin = { clientX: e.clientX, armed: false }
  }

  /** Where on the clock a pointer at `clientX` is standing, clamped to the
   *  frame — a drag that wanders off the sheet still selects to its edge. */
  private dragInstant(clientX: number): number {
    const geom = this.dragBox
    if (!geom) return 0
    const fraction = Math.min(1, Math.max(0, (clientX - geom.left) / geom.width))
    return geom.win.startMs + fraction * (geom.win.endMs - geom.win.startMs)
  }

  private readonly onDragMove = (e: MouseEvent): void => {
    const origin = this.dragOrigin
    const geom = this.dragBox
    if (!origin || !geom) return
    if (!origin.armed) {
      if (Math.abs(e.clientX - origin.clientX) < DayViewImpl.DRAG_THRESHOLD_PX) return
      origin.armed = true
      // The gesture has committed: put any hover slip away and raise the band.
      this.hideTip(true)
      const band = document.createElement('div')
      band.className = 'kbn-day-zoomband'
      // Into the GRIDLINE LAYER, not the chart: the grid is the element that
      // spans exactly the rail column and exactly the stack of lanes, so a
      // percentage across it is a percentage across the frame. Parented to the
      // chart the band would be offset by the whole label column.
      ;(this.gridEl ?? this.chartEl)?.append(band)
      this.drag = { startMs: this.dragInstant(origin.clientX), endMs: 0, band }
    }
    const drag = this.drag
    if (!drag) return
    drag.endMs = this.dragInstant(e.clientX)
    // Live: the band is the selection, drawn in the frame's own coordinates so
    // it lands exactly where the zoom will cut.
    const span = geom.win.endMs - geom.win.startMs
    const lo = Math.min(drag.startMs, drag.endMs)
    const hi = Math.max(drag.startMs, drag.endMs)
    drag.band.style.left = pct((lo - geom.win.startMs) / span)
    drag.band.style.width = pct((hi - lo) / span)
    e.preventDefault()
  }

  private readonly onDragUp = (): void => {
    const drag = this.drag
    this.dragOrigin = null
    this.dragBox = null
    this.drag = null
    if (!drag) return
    drag.band.remove()
    // The click the browser fires next belongs to this gesture, not to a pin.
    this.dragJustEnded = true
    this.applyZoom({ startMs: drag.startMs, endMs: drag.endMs })
  }

  /**
   * One ladder line as words: what it was, when it was up, and how long for.
   *
   * The DELEGATION REGISTER — the outgoing prompt and the report that came
   * back — rides on the same `/api/v1/moment` route the beats use, asked over
   * the interval the line spans. A session's line asks the same question of its
   * own span and gets the conversation, which is the honest answer for a mark
   * that means "this session was up".
   */
  private showAloftTip(lane: DayLane, line: LadderLine, e: MouseEvent, pin = false): void {
    if (this.pinnedKey !== null && !pin) return
    const chart = this.chartEl
    if (!chart) return
    const minutes = Math.max(1, Math.round((line.endMs - line.startMs) / MINUTE_MS))
    const tip = this.ensureTip()
    const key = `${lane.key}:aloft:${line.kind}:${line.startMs}:${line.row}`
    const words = (w?: MomentWords): SlotTip => {
      const content = tipContent(w, pin)
      return {
        time: `${clockTime(line.startMs)}–${clockTime(line.endMs)}`,
        rows: reconcileRows(
          [
            {
              kind: 'agent',
              phrase: aloftPhrase(line),
              where: '',
              // How long it was up — a duration, so it says "min" rather than
              // wearing a `×N` that would read as a count of the lines below.
              note: `${minutes} min`,
              shuttle: false,
            },
          ],
          content,
        ),
        ...content,
      }
    }
    // Sources come from the minutes the line spans — the same transcripts the
    // beats under it point at, which is what makes the delegation register
    // available here at all.
    const sources = dedupeSources(
      lane.beats
        .filter((b) => {
          const at = (this.frame?.startMs ?? 0) + b.minute * MINUTE_MS
          return at >= line.startMs && at < line.endMs
        })
        .flatMap((b) => b.sources),
    )
    this.openMoment(tip, key, pin, sources, line.startMs, line.endMs, words)
    // A rung is an interval, and the bar marks where it BEGAN — the instant the
    // delegation went out, which is the one point on the rung a reader can act
    // on. Stepping from there walks the span it covers.
    if (pin) this.scrub.pin({ laneKey: lane.key, atMs: line.startMs })

    const chartBox = chart.getBoundingClientRect()
    placeTip(tip, chartBox, e.clientX - chartBox.left, e.clientY - chartBox.top)
  }

  private render(model: DayModel): void {
    const body = this.bodyEl
    if (!body) return

    if (this.statsEl) {
      // The host belongs here, once: it is the same for the whole page, and a
      // lane only repeats it when it disagrees (see DayLane.hostNote).
      const diffEl = diffClauseEl(model.totals.insertions ?? 0, model.totals.deletions ?? 0)
      const prefix =
        (model.host ? `${model.host} · ` : '') +
        `${messageClause(model.totals.messages, model.totals.received)}` +
        ` · agents ${formatSpanMinutes(model.totals.agent, { pad: true })}` +
        (diffEl ? ' · ' : '')
      this.statsEl.textContent = ''
      this.statsEl.append(document.createTextNode(prefix))
      if (diffEl) this.statsEl.append(diffEl)
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
    this.gridEl = null
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
    // Sweep a span to read it close up. The press is only ever a press here —
    // whether it becomes a zoom or stays a pin is decided by how far the
    // pointer travels, in `onDragMove`.
    chart.addEventListener('mousedown', this.onDragDown)
    this.railByLane.clear()

    // One gridline layer behind every rail, so the hour rules run unbroken
    // down the whole stack instead of restarting per lane.
    const grid = document.createElement('div')
    grid.className = 'kbn-day-grid'
    this.gridEl = grid
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

    // Every lane's curve, then the tallest moment on the page — the one height
    // all of them are drawn against, so the rails can be read down the column.
    // The kernel is a fraction of THIS frame, so a zoomed rail resolves finer
    // work rather than magnifying the same mounds — see `daySigma`.
    const sigma = daySigma(win.minutes)
    const sampling = curveGrid(win.minutes, sigma)
    const fields = new Map<string, CurveField>()
    for (const lane of model.lanes) {
      const { samples, spines } = laneActivity(lane.beats)
      fields.set(lane.key, curveField(samples, sampling, spines, sigma))
    }
    const peak = fieldPeak([...fields.values()])

    // The ladders, laid out into rows before any lane is drawn: the pitch the
    // hairlines sit at is a property of the PAGE, like the curve's peak, so a
    // four-deep fan-out on one lane and a one-deep one on another can be read
    // against each other down the column.
    const ladders = new Map<string, LadderLine[]>()
    for (const lane of model.lanes) ladders.set(lane.key, ladderRows(lane.ladder, win))
    const pitch = ladderPitch(ladderHeight([...ladders.values()]))
    // The room a `×122` needs, in the fractions the layout speaks. Measured off
    // the chart when it has been laid out and guessed at a plausible width when
    // it has not — the guess only ever decides whether ONE label is drawn on a
    // first paint, and the rung's title says the same thing either way.
    const countRoom = COUNT_LABEL_PX / Math.max(320, this.chartEl?.clientWidth || 900)

    const chipByCardId = new Map(model.entries.map((entry) => [entry.cardId, entry.chip]))
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

      // The timeline row gets the same live worker signal as the prose row
      // below it. Ordinary aloft work stays implicit; only a raised hand or a
      // settled wait deserves a second mark beside the constitution's name.
      const workerChip = chipByCardId.get(lane.cardId)
      if (workerChip && workerChip.variant !== 'aloft') {
        label.append(this.buildChip(workerChip, lane.cardId))
      }

      const name = document.createElement('button')
      name.type = 'button'
      name.className = 'kbn-day-lanename'
      name.textContent = lane.label
      // The name is the fiber's door. The rail keeps the separate work-reading
      // gesture: its future half opens the terminal, while the lane name
      // always opens the fiber itself.
      name.title = `${lane.label} — open the fiber`
      name.addEventListener('click', (e) => {
        e.stopPropagation()
        this.ctx?.openCard(lane.cardId)
      })
      label.append(name)
      // The host is named ONCE. A stale lane's waiting badge already reads
      // "waiting on basalt-login-02", so the plain host note beside it said the
      // same word twice and — between them — overran the label column, clipping
      // both against the sheet's left edge.
      const staleBadge = lane.stale && !!lane.host
      if (lane.hostNote && !staleBadge) {
        const host = document.createElement('span')
        host.className = 'kbn-day-lanehost'
        host.textContent = lane.hostNote
        host.title = `ran on ${lane.hostNote}`
        label.append(host)
      }
      if (staleBadge) {
        // The Desk's own waiting badge, but SAID SHORT: the gutter is a fixed
        // 232px shared with the lane's name, and "⌛ waiting on basalt-login-02"
        // spent nearly all of it, leaving the name as "Ru…". The hourglass is
        // the claim and the host is the only new fact; the sentence lives in
        // the title, where there is room for it.
        // The rail still draws underneath it: those minutes happened, and what
        // is shown is that origin's last-good read, not a guess.
        const waiting = document.createElement('span')
        waiting.className = 'kbn-card-waiting kbn-day-lanewaiting'
        waiting.textContent = `⌛ ${lane.host}`
        waiting.title = `${lane.host} is unreachable — this rail is its last-known read`
        label.append(waiting)
      }

      const rail = document.createElement('div')
      rail.className = `kbn-day-rail${lane.stale ? ' kbn-card--stale' : ''}`
      rail.style.gridRow = row
      // THE ROW LIGHTS AS ONE. The label and the rail are two cells of the
      // chart's grid with a gridline layer between them, so there is no element
      // that IS the row to hang a `:hover` on — the two are joined here instead.
      // Without it the lane's clickability is invisible: a door with no handle.
      const lit = (on: boolean) => {
        label.classList.toggle('kbn-day-lane-lit', on)
        rail.classList.toggle('kbn-day-lane-lit', on)
      }
      for (const el of [label, rail]) {
        el.addEventListener('mouseenter', () => lit(true))
        el.addEventListener('mouseleave', () => lit(false))
      }
      label.addEventListener('click', (e) => {
        e.stopPropagation()
        this.openLaneTerminal(lane)
      })
      const field = fields.get(lane.key)
      if (field) {
        rail.append(
          buildCurveSvg(field, peak, { frameMinutes: win.minutes }),
        )
      }
      // THE LADDER. The session's own line on the ground, each subagent a rung
      // above it, spanning the real interval it was aloft — see `ladderRows`.
      // Standing on the same baseline the curve stands on, the lines read as
      // strata under the work rather than as annotation floating over it: four
      // agents launched together is four rungs with four visibly different
      // right-hand ends, and that is the fleet, drawn. An interval whose close
      // was never recorded is drawn faded: its length is a stub saying one
      // started, not a claim about how long it ran.
      const ladder = ladders.get(lane.key) ?? []
      for (const line of ladder) {
        // AN OPEN SPAN IS NOT GIVEN A WIDTH HERE. Its end is a stub the daemon
        // chose, not a return anybody recorded, so the view declines to draw a
        // length at all and the sheet gives it a fixed fading dash instead —
        // see `.kbn-day-aloft-open`. Drawing the stub would be inventing the
        // one fact the mark exists to say is missing.
        //
        // A MEASURED SPAN IS NOT A STUB, HOWEVER IT ENDS. A workflow's extent
        // is read off its fleet's own transcripts, so `open` on one of those
        // means "and it is still going" rather than "and nobody knows" — the
        // length is a measurement either way, and it is drawn. That is the
        // whole repair: an hour of fan-out used to draw as a 14px dash.
        const stub = line.open && !line.agents
        const flying = line.open && !stub
        const hair = document.createElement('i')
        hair.className =
          `kbn-day-aloft kbn-day-aloft-${line.kind}` +
          `${stub ? ' kbn-day-aloft-open' : ''}${flying ? ' kbn-day-aloft-flying' : ''}`
        hair.style.left = pct(line.start)
        if (!stub) hair.style.width = pct(Math.max(0, line.end - line.start))
        // Row 0 sits ON the lane's baseline — the floor of the filled region,
        // the same ground the curve stands on. It used to be lifted a pixel
        // clear of the rail's ground rule; that pixel made the session read as
        // the first rung of the ladder rather than as the ground under it.
        hair.style.bottom = `${line.row * pitch}px`
        // A FLEET, WRITTEN ON ITS OWN RUNG. One rung stands for 122 agents as
        // readily as for one, and the ladder's other channel for quantity —
        // height — is spent on concurrency. So a workflow says its size in
        // words, `×122` at the rung's right-hand end, in the ladder's own ink.
        //
        // The title carries the count unconditionally; the text only where
        // there is paper to write it on. See `ladderCountRoom` — at a three
        // pixel pitch, type written over a busy stretch of ladder is two
        // hairlines through the digits and nobody can read either.
        if (line.agents) {
          hair.title = aloftPhrase(line)
          if (ladderCountRoom(ladder, line, countRoom)) {
            const count = document.createElement('b')
            count.className = 'kbn-day-aloft-count'
            count.textContent = `×${line.agents}`
            hair.append(count)
          }
        }
        hair.addEventListener('mousemove', (e) => {
          e.stopPropagation()
          this.showAloftTip(lane, line, e)
        })
        hair.addEventListener('mouseleave', () => this.hideTip())
        hair.addEventListener('click', (e) => {
          e.stopPropagation()
          this.showAloftTip(lane, line, e, true)
        })
        rail.append(hair)
      }

      this.railByLane.set(lane.key, { lane, rail })
      rail.addEventListener('mousemove', (e) => {
        // A drag in progress is a zoom gesture, not a hover: the slip would
        // chase the pointer across the selection it is trying to draw.
        if (this.drag) return
        this.showBeatTip(lane, rail, win, e)
      })
      rail.addEventListener('mouseleave', () => {
        // The magnet goes with the pointer even when a pinned slip is holding
        // the tooltip open — it marks where the POINTER is being caught, not
        // what the slip is showing.
        if (this.pinnedKey === null) this.markMagnet(rail, null, 0)
        this.hideTip()
      })
      // A click fixes the slip where the pointer already is, so what you were
      // reading stops fleeing when you move to read it. The stopPropagation is
      // load-bearing: the document listener that unpins would otherwise see
      // this very click and close what it just opened.
      //
      // A click that ENDED A DRAG is not a click — the browser fires one anyway
      // after a mouseup, and pinning a tooltip on top of a freshly zoomed rail
      // is the last thing the gesture meant. `dragJustEnded` swallows exactly
      // that one event.
      //
      // THE RAIL CARRIES THREE GESTURES, and they settle in this order:
      //
      //   a drag past the threshold   → zoom      (decided in `onDragMove`)
      //   Alt- or Cmd-click           → pin, wherever the pointer is
      //   a click LEFT of the now-thread  → pin the moment under the pointer
      //   a click RIGHT of it             → the terminal
      //
      // ## Why the divider decides
      //
      // This was a flat rule twice, and both flat rules were wrong for the
      // same reason: the two halves of a lane are not the same surface.
      //
      // Pinning-everywhere failed first. Measured against a real day, on the
      // busiest lane of the page (291 inked minutes over a 435-minute frame,
      // 2.3px to the minute) a 9px snap plus the magnet's claim on everything
      // right of the last mark left 14% of the lane's width opening the
      // terminal — at two pixels per minute EVERY pixel is within three of a
      // beat, so no hitbox tight enough to be fair is tight enough to be
      // reachable, and the door was least available on exactly the lane you
      // most want to attach to.
      //
      // Opening-everywhere replaced it and cost the other half: the part of
      // the rail that is DENSE with answers — every inked minute of the day —
      // could only be held still through a modifier, and a reader who wants to
      // stop the slip fleeing and walk through a busy afternoon had to know a
      // key to do it.
      //
      // The gold thread already divides the lane into exactly those two
      // regions, visibly, on every page that has a now at all. Left of it is
      // the day that happened: covered in marks, every pixel of it an answer,
      // and a click there means "hold still, I am reading this" — which raises
      // the scrub bar and hands over the arrow keys. Right of it is paper the
      // day has not reached; nothing happened there and nothing can be pinned,
      // so the only sensible meaning left is the door. Neither half has to
      // give anything up, and the boundary is drawn on the page rather than
      // memorised.
      //
      // A day with no now on it (any past day) is entirely the first case, and
      // the lane's LABEL keeps the door open unconditionally — which it always
      // did, and is why nothing that used to work stopped.
      //
      // No `title` here, deliberately: the rail already owns a rich hover
      // surface (the moment tooltip), and a native tooltip layered on top of
      // it after the OS delay is a second, uglier voice saying less. The
      // click affordance is carried by the cursor and taught once, in the
      // legend, instead of re-whispered per lane.
      rail.addEventListener('click', (e) => {
        e.stopPropagation()
        if (this.dragJustEnded) {
          this.dragJustEnded = false
          return
        }
        if (e.altKey || e.metaKey || this.clickIsPast(rail, win, e)) {
          this.showBeatTip(lane, rail, win, e, true)
          return
        }
        this.openLaneTerminal(lane)
      })

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
    // a legend box, and CENTRED on them, because a caption belongs under the
    // middle of the plate it captions rather than shoved against its right
    // edge.
    //
    // EVERY ENTRY IS CONDITIONAL, without exception: the ladder entry appears
    // only where a ladder was drawn, and the states are exactly the states in
    // the gutter (see `buildStateKey`). A key is a reading of this page, not a
    // glossary of the board's whole vocabulary — anything it names that the
    // reader cannot find is a mark they will go looking for and not find.
    //
    // The GLYPHS are each view's own marks in miniature, which is why they are
    // shapes rather than uniform swatches — the key teaches the height
    // hierarchy (wash, then block, then tick) at the same time.
    const legend = document.createElement('div')
    legend.className = 'kbn-view-key kbn-day-legend'
    legend.style.gridRow = String(model.lanes.length + 2)
    const stateKey = buildStateKey(new Set(model.lanes.map((lane) => lane.state)))
    legend.append(
      buildKey(DAY_KEY_CLASS.agent, MOUND_KEY_LABEL),
      buildKey('kbn-day-key-spine', SPINE_KEY_LABEL),
      ...(model.lanes.some((lane) => lane.ladder.length > 0)
        ? [buildKey('kbn-day-key-aloft', ALOFT_KEY_LABEL)]
        : []),
      ...(stateKey ? [stateKey] : []),
      buildGestureKey(),
    )
    // The way back out of a zoom, and the only sign that you are in one. Quiet
    // and only ever present while it has something to undo — a permanent
    // control for a state you are usually not in is chrome.
    if (this.zoom) {
      const clear = document.createElement('button')
      clear.type = 'button'
      clear.className = 'kbn-day-zoomclear'
      clear.textContent = `⤢ ${formatSpanMinutes(win.minutes)} — whole day`
      clear.title = 'Back to the whole day (Esc)'
      clear.addEventListener('click', (e) => {
        e.stopPropagation()
        this.applyZoom(null)
      })
      legend.append(clear)
    }
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
  /**
   * Which mark the pointer resolves to, or null for empty paper — the one
   * question the click handler and the hover handler must never answer
   * differently, which is why they both ask it here.
   */
  private beatUnder(
    lane: DayLane,
    rail: HTMLElement,
    win: DayWindow,
    e: MouseEvent,
  ): MarkPick | null {
    if (lane.beats.length === 0) return null
    const box = rail.getBoundingClientRect()
    if (box.width <= 0 || win.minutes <= 0) return null
    const perMinute = box.width / win.minutes
    return pickMark(
      lane.beats.map((b) => (b.minute + 0.5) * perMinute),
      e.clientX - box.left,
      BEAT_SNAP_PX,
    )
  }

  /**
   * Is the pointer standing in the part of the day that has HAPPENED?
   *
   * The one question the click rule turns on — see the rail's click handler.
   * Read off the frame rather than off the now-thread's DOM, because a frame
   * that contains no now draws no thread and must still answer: a past day is
   * all past, and a day drawn entirely ahead of now is all future.
   */
  private clickIsPast(rail: HTMLElement, win: DayWindow, e: MouseEvent): boolean {
    const box = rail.getBoundingClientRect()
    if (box.width <= 0) return true
    const at = win.startMs + ((e.clientX - box.left) / box.width) * (win.endMs - win.startMs)
    return isPast(at, Date.now())
  }

  /**
   * Redraw the pinned slip for a minute the SCRUB walked to.
   *
   * The bar steps by the minute, so most steps on a quiet lane land where no
   * mark is — and that is an answer about the day, not a failure to answer.
   * The slip says the clock time and says nothing was recorded, and the panel
   * stays where it is: a reader walking an afternoon must not have the thing
   * they are reading blink out of existence between two marks.
   */
  private showPinnedMinute(laneKey: string, atMs: number): void {
    const held = this.railByLane.get(laneKey)
    const win = this.frame
    const chart = this.chartEl
    if (!held || !win || !chart) return
    const minute = Math.floor((atMs - win.startMs) / MINUTE_MS)
    const beat = held.lane.beats.find((b) => b.minute === minute)
    const tip = this.ensureTip()
    const startMs = win.startMs + minute * MINUTE_MS

    if (!beat) {
      // No fetch: there is no session behind a minute with no bucket, so there
      // is nothing to ask and nobody to ask it of.
      this.moments.cancel()
      this.hoveredKey = null
      this.pinnedKey = `${laneKey}:${minute}`
      renderTip(tip, emptyMinuteTip(startMs, true))
      tip.classList.add('kbn-tip-open', 'kbn-tip-pinned')
    } else {
      this.openMoment(
        tip,
        `${laneKey}:${beat.minute}`,
        true,
        beat.sources,
        startMs,
        startMs + MINUTE_MS,
        (words) => beatTip(beat, win, words, true),
      )
    }

    const chartBox = chart.getBoundingClientRect()
    const railBox = held.rail.getBoundingClientRect()
    const perMinute = railBox.width / win.minutes
    placeTip(
      tip,
      chartBox,
      railBox.left - chartBox.left + (minute + 0.5) * perMinute,
      railBox.top - chartBox.top,
    )
  }

  private showBeatTip(
    lane: DayLane,
    rail: HTMLElement,
    win: DayWindow,
    e: MouseEvent,
    pin = false,
  ): void {
    // A pinned slip belongs to the click that made it, not to the pointer. Only
    // another click (which arrives with `pin`) may move it.
    if (this.pinnedKey !== null && !pin) return
    const chart = this.chartEl
    if (!chart || lane.beats.length === 0) return this.hideTip(pin)
    const box = rail.getBoundingClientRect()
    if (box.width <= 0 || win.minutes <= 0) return this.hideTip(pin)

    const perMinute = box.width / win.minutes
    // The nearest beat, or — anywhere right of the lane's last one — that last
    // beat, caught out of the empty paper. See `pickMark`. "Last" is the last
    // beat IN THE FRAME, which is what makes this follow a zoom for free: the
    // lanes are rebuilt against the drawn window, so a beat outside it is not
    // in `lane.beats` at all.
    const pick = this.beatUnder(lane, rail, win, e)
    if (!pick) return this.hideTip(pin)
    this.markMagnet(rail, pick.magnetized ? lane.beats[pick.index] : null, perMinute)
    // Out in the dead zone the question is about the LANE, not about a minute,
    // and it gets a different answer: the last exchange, both ways round.
    if (pick.magnetized) return this.showMagnetTip(lane, win, e, pin)

    const beat = lane.beats[pick.index]
    const startMs = win.startMs + beat.minute * MINUTE_MS
    const tip = this.ensureTip()
    const key = `${lane.key}:${beat.minute}`
    // A pin asks again for the UNTRUNCATED words — the daemon does the cutting,
    // so the pinned slip cannot show the rest of a sentence it was never sent.
    this.openMoment(tip, key, pin, beat.sources, startMs, startMs + MINUTE_MS, (words) =>
      beatTip(beat, win, words, pin),
    )
    // The bar goes up at the minute the slip is about, and takes the keyboard
    // with it. From here the reader walks the day with the arrows rather than
    // hunting the next two-pixel mark with the pointer.
    if (pin) this.scrub.pin({ laneKey: lane.key, atMs: startMs })

    // Positioned against the chart; the anchor is the beat's own column.
    const chartBox = chart.getBoundingClientRect()
    const anchor = box.left - chartBox.left + (beat.minute + 0.5) * perMinute
    placeTip(tip, chartBox, anchor, box.top - chartBox.top)
  }

  /**
   * WHERE A RAIL CLICK GOES. Pure, and exported, because this is the branch
   * that decides whether the gesture reaches a terminal at all — the one place
   * the feature can silently do nothing, and therefore the one place worth
   * pinning down without a browser.
   *
   * A card with a live worker AND a host that can attach goes to the terminal.
   * Everything else goes to the fiber: no worker in the air, or a board mounted
   * without an attach handler (the offline harness). The lane name itself
   * always opens the fiber and does not use this rail-specific choice.
   */
  private openLaneTerminal(lane: DayLane): void {
    const ctx = this.ctx
    if (!ctx) return
    const target = laneOpenTarget(
      ctx.cards.find((c) => c.id === lane.cardId),
      Boolean(ctx.openWorker),
    )
    if (target.kind === 'worker') ctx.openWorker?.(target.tmux, target.host)
    else ctx.openCard(lane.cardId)
  }

  /**
   * The magnet's slip: this lane's last exchange, in the order it happened.
   *
   * The ROWS need no network — they are read off the recorded beats, so the
   * order, the clock times and the trailing tool count are all correct before
   * anything is fetched and stay correct if nothing comes back. The words are
   * asked for over the span the exchange covers and painted in when they land,
   * exactly as an ordinary hover's are.
   */
  private showMagnetTip(lane: DayLane, win: DayWindow, e: MouseEvent, pin: boolean): void {
    const chart = this.chartEl
    if (!chart) return
    const at = (beat: DayBeat): number => win.startMs + beat.minute * MINUTE_MS
    const exchange = lastExchange(lane.beats.map((b) => ({ atMs: at(b), kinds: b.kinds })))
    if (exchange.turns.length === 0 && !exchange.toolsAfter) return this.hideTip(pin)

    const lastBeat = lane.beats[lane.beats.length - 1]
    const toMs = at(lastBeat) + MINUTE_MS
    const first = exchange.turns[0]?.atMs ?? toMs - MINUTE_MS
    const fromMs = Math.max(first, toMs - MAGNET_LOOKBACK_MINUTES * MINUTE_MS)
    // Every transcript the spanned minutes point at — the exchange may cross
    // more than one session on a lane that was handed between workers.
    const sources = dedupeSources(
      lane.beats.filter((b) => at(b) >= fromMs && at(b) < toMs).flatMap((b) => b.sources),
    )

    const tip = this.ensureTip()
    // Keyed on the lane rather than on a minute: the magnet is one answer per
    // lane, and every pixel of the dead zone must reuse it rather than mint a
    // fresh cache entry and a fresh fetch on every mouse move.
    const key = `${lane.key}:magnet`
    this.openMoment(tip, key, pin, sources, fromMs, toMs, (words) =>
      magnetTip(exchange, words, pin),
    )
    // Pinned out in the dead zone, the bar stands on the lane's LAST mark —
    // the moment the slip is actually reporting — rather than under the
    // pointer, which is out in paper where nothing happened. Stepping from
    // there walks back into the day, which is the only direction there is.
    if (pin) this.scrub.pin({ laneKey: lane.key, atMs: at(lastBeat) })

    const chartBox = chart.getBoundingClientRect()
    placeTip(tip, chartBox, e.clientX - chartBox.left, e.clientY - chartBox.top)
  }

  /**
   * The magnet's affordance: a quiet upright at the beat being reported, drawn
   * ONLY while the pointer is out in the dead zone and the rail has caught it.
   *
   * Without it the magnet is a tooltip appearing over blank paper with nothing
   * to say which moment it belongs to — the reader would have to trust that it
   * meant the last one. With it the gesture explains itself: the mark lights,
   * the slip describes it, and the relation between the two is visible. It is
   * never drawn for an ordinary hover, where the pointer is already standing on
   * its own answer.
   */
  private markMagnet(rail: HTMLElement, beat: DayBeat | null, perMinute: number): void {
    let mark = rail.querySelector<HTMLElement>('.kbn-day-magnet')
    if (!beat) {
      mark?.remove()
      return
    }
    if (!mark) {
      mark = document.createElement('i')
      mark.className = 'kbn-day-magnet'
      rail.append(mark)
    }
    mark.style.left = `${((beat.minute + 0.5) * perMinute).toFixed(2)}px`
  }

  /** Put every lane's magnet away — the pointer has left, or the slip closed. */
  private clearMagnets(): void {
    this.chartEl?.querySelectorAll('.kbn-day-magnet').forEach((el) => el.remove())
  }

  private ensureTip(): HTMLElement {
    if (this.tip?.isConnected) return this.tip
    const tip = document.createElement('div')
    tip.className = 'kbn-tip'
    this.chartEl?.append(tip)
    this.tip = tip
    return tip
  }

  /**
   * OPEN A SLIP OVER A SPAN, AND THEN GO AND ASK IT WHAT WAS SAID.
   *
   * Every hover in this view has the same two-beat shape, and only `build`
   * differs: draw the answer that is already known from the recorded marks,
   * then ask `/api/v1/moment` for the words and redraw in place when they
   * land. The tooltip is correct before the network answers and stays correct
   * if it never does.
   *
   * The guard is why this must be one function rather than three: a late answer
   * belongs to the mark that asked for it, so it is dropped if the pointer has
   * moved on OR if the pin state has changed underneath it — a hover's cut text
   * painting back over a pinned slip's full text is the bug it exists to stop.
   *
   * The state is written AFTER the request, which is only safe because
   * `MomentLoader.request` never calls back synchronously (it debounces, or
   * resolves a promise, or returns having nothing to ask). Keep it that way.
   */
  private openMoment(
    tip: HTMLElement,
    key: string,
    pin: boolean,
    sources: readonly MomentSource[],
    fromMs: number,
    toMs: number,
    build: (words?: MomentWords) => SlotTip,
  ): void {
    renderTip(tip, build(this.moments.peek(key, pin)))
    this.moments.request(
      key,
      sources,
      fromMs,
      toMs,
      (words) => {
        if (this.hoveredKey !== key || (this.pinnedKey === key) !== pin) return
        renderTip(tip, build(words))
      },
      pin,
    )
    this.hoveredKey = key
    this.pinnedKey = pin ? key : null
    tip.classList.add('kbn-tip-open')
    // Pinned, the slip stops being a passing annotation and becomes something
    // you read: it takes the pointer (so a long transcript can be scrolled) and
    // is allowed to grow. See momentTip.css.
    tip.classList.toggle('kbn-tip-pinned', pin)
  }

  /** Close the slip. A pinned one ignores this — the pointer wandering off is
   *  exactly the thing pinning exists to survive — unless `force`, which is the
   *  click elsewhere, the Escape key, and a click that pins somewhere new. */
  private hideTip(force = false): void {
    if (this.pinnedKey !== null && !force) return
    const wasPinned = this.pinnedKey !== null
    this.pinnedKey = null
    this.scrub.clear()
    this.clearMagnets()
    this.tip?.classList.remove('kbn-tip-open', 'kbn-tip-pinned')
    this.hoveredKey = null
    this.moments.cancel()
    // Whatever the page wanted to become while you were reading, it becomes
    // now — the deferral is a pause, not a dropped update.
    if (wasPinned && this.pendingModel) {
      const model = this.pendingModel
      this.pendingModel = null
      this.signature = dayModelSignature(model)
      this.render(model)
    }
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

      const title = document.createElement('button')
      title.type = 'button'
      title.className = 'kbn-day-entrytitle'
      title.textContent = entry.title
      const entryCardId = entry.cardId
      title.addEventListener('click', () => this.ctx?.openCard(entryCardId))
      head.append(title)

      const statLine = entry.stats ? formatEntryStats(entry.stats) : ''
      if (statLine) {
        const stats = document.createElement('span')
        stats.className = 'kbn-day-entrystats'
        // The diff clause is always the last term (see formatEntryStats):
        // strip it back off the composed string and re-append it as coloured
        // elements rather than teaching the string builder to emit markup.
        const diffText = entry.stats
          ? diffClause(entry.stats.insertions ?? 0, entry.stats.deletions ?? 0)
          : ''
        const diffEl = entry.stats
          ? diffClauseEl(entry.stats.insertions ?? 0, entry.stats.deletions ?? 0)
          : null
        if (diffEl && diffText && statLine.endsWith(diffText)) {
          stats.append(document.createTextNode(statLine.slice(0, -diffText.length)), diffEl)
        } else {
          stats.textContent = statLine
        }
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
  private buildChip(chip: DayChip, cardId: string): HTMLButtonElement {
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
      else ctx?.openCard(cardId)
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
