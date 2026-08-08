/**
 * WeekView (hotkey 4) — the two-faced week.
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
 * DATA. One `activity` call and one `narration` call per refresh, both covering
 * the week's rail span — but the two routes take different KINDS of argument
 * (activity instants, narration bare civil days), so both are derived in one
 * place by `weekWindow`. Read its comment before changing either call.
 */

import './WeekView.css'

import {
  normalizeFocusDate,
  registerView,
  type TemporalView,
  type ViewContext,
} from './ViewRegistry.js'
import { createViewPage, type ViewPage } from './ViewPage.js'
import type { ActivityBucket, ActivityResult, NarrationResult } from './TemporalData.js'
import type { KanbanCard } from '../KanbanTypes.js'
import {
  civilDayToLocalDate,
  dueCivilDay,
  instantMs,
  isoDayLocal,
  railCivilDay,
} from '../civilDay.js'

// ── Constants ────────────────────────────────────────────────────────────────

/** The hour a rail opens (and the next one closes). Work past midnight belongs
 *  to the day it started, so the day boundary is dawn, not midnight. */
export const RAIL_START_HOUR = 6

/** How much time one raster tick stands for. The wire's minute buckets are
 *  folded into these, because a 24h rail is ~800px and a per-minute tick would
 *  be half a pixel — a smear, not a raster. 5 minutes gives 288 slots, ~2.8px
 *  apiece. This is a DRAWING quantum only; it never touches the arithmetic,
 *  which counts minutes (see BUCKET_MS). */
const RASTER_SLOT_MS = 5 * 60_000

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

/** A local `Date` parked at noon on a civil day — the safe stride anchor. */
function noonOn(day: string): Date | undefined {
  const d = civilDayToLocalDate(day)
  if (!d) return undefined
  d.setHours(12, 0, 0, 0)
  return d
}

/** The civil day `delta` calendar days from `day`. */
export function shiftCivilDay(day: string, delta: number): string {
  const d = noonOn(day)
  if (!d) return day
  d.setDate(d.getDate() + delta)
  return isoDayLocal(d.getTime())
}

/** The Monday of the week containing `day`. Weeks start Monday, so Sunday
 *  belongs to the week that began six days earlier, not the one starting
 *  tomorrow. */
export function mondayOfWeek(day: string): string {
  const d = noonOn(day)
  if (!d) return day
  // getDay(): 0=Sun … 6=Sat. Monday must map to 0 and Sunday to 6.
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return isoDayLocal(d.getTime())
}

/** The seven civil days of the week beginning at `monday`, Monday→Sunday. */
export function weekCivilDays(monday: string): string[] {
  const d = noonOn(monday)
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
  return mondayOfWeek(normalizeFocusDate(focusDate) ?? railCivilDay(nowMs, RAIL_START_HOUR))
}

export interface RailBounds {
  /** Local 6am on the day — the rail's left edge. */
  startMs: number
  /** Local 6am on the NEXT calendar day — the right edge. 23h, 24h or 25h. */
  endMs: number
}

/** The instant span one row covers. Both edges are real 6am wall-clock times,
 *  so a DST rail is genuinely 23h or 25h long and everything positioned on it
 *  by time fraction stays in the right place. */
export function railBounds(day: string): RailBounds {
  const start = noonOn(day)
  const end = noonOn(shiftCivilDay(day, 1))
  if (!start || !end) return { startMs: 0, endMs: 0 }
  start.setHours(RAIL_START_HOUR, 0, 0, 0)
  end.setHours(RAIL_START_HOUR, 0, 0, 0)
  return { startMs: start.getTime(), endMs: end.getTime() }
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
    const at = noonOn(day)
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
  /** `from` / `to` for the narration call — INCLUSIVE BARE CIVIL DAYS. */
  narrationFrom: string
  narrationTo: string
}

/**
 * Everything one refresh needs to ask the read plane for. Pure, so the two
 * argument shapes are testable without a DOM.
 *
 * THE TWO ROUTES DO NOT SPEAK THE SAME LANGUAGE, and this is the whole reason
 * this function exists:
 *
 *   /api/v1/activity   takes INSTANTS (`from_ms` / `to_ms`, epoch ms).
 *   /api/v1/narration  takes CIVIL DAYS, and only bare `YYYY-MM-DD`. The
 *                      daemon parses them with Elixir's `Date.from_iso8601/1`
 *                      (lib/shuttle_web/controllers/narration_controller.ex),
 *                      which rejects a full timestamp outright. Handing it
 *                      `2026-08-03T06:00:00.000Z` is a 400, the fetcher turns
 *                      every failure into an empty result, and the week's
 *                      marginalia goes blank with nothing to show for it — a
 *                      silent failure the offline harness cannot catch, because
 *                      its mock parses whatever it is given.
 *
 * `narrationTo` is the day AFTER Sunday, not Sunday. The daemon's range is
 * inclusive and midnight-bounded while a rail runs 6am→6am, so stopping at
 * Sunday would drop Sunday's after-midnight tail — the one row whose late-night
 * work would go unnarrated while every other row kept its own. One extra civil
 * day of commits comes back; the rail edges discard what falls outside.
 *
 * The activity `to` is capped at now, rounded UP to `FETCH_CAP_QUANTUM_MS`.
 * Uncapped it would move every poll, so the fetcher's per-tuple memo would
 * never hit and its cache would gain an entry per poll forever.
 */
export function weekWindow(monday: string, nowMs: number): WeekWindow {
  const days = weekCivilDays(monday)
  if (days.length !== 7) {
    return { days: [], fromMs: 0, toMs: 0, activityToMs: 0, narrationFrom: '', narrationTo: '' }
  }
  const fromMs = railBounds(days[0]).startMs
  const toMs = railBounds(days[6]).endMs
  return {
    days,
    fromMs,
    toMs,
    activityToMs: Math.min(toMs, Math.ceil(nowMs / FETCH_CAP_QUANTUM_MS) * FETCH_CAP_QUANTUM_MS),
    narrationFrom: days[0],
    narrationTo: shiftCivilDay(days[6], 1),
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
  attentionMs: number
  agentMs: number
  notifyCount: number
}

/** Fold buckets into wall-clock time per kind. */
export function summarizeSpend(buckets: ActivityBucket[], bucketMs = BUCKET_MS): ActivitySpend {
  const any = new Set<number>()
  const attention = new Set<number>()
  const agent = new Set<number>()
  let notifyCount = 0
  for (const b of buckets) {
    any.add(b.m)
    if (b.k === 'attention') attention.add(b.m)
    else if (b.k === 'agent') agent.add(b.m)
    else notifyCount += 1
  }
  return {
    totalMs: any.size * bucketMs,
    attentionMs: attention.size * bucketMs,
    agentMs: agent.size * bucketMs,
    notifyCount,
  }
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

/** `12h` · `45m` — the header's coarser hand. */
function formatCoarseSpan(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes <= 0) return '0h'
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

// ── Narration ────────────────────────────────────────────────────────────────

/** `board: fold the masthead` → `board — fold the masthead`. A subject with no
 *  slug prefix is returned as written. */
export function readableSubject(subject: string): string {
  const at = subject.indexOf(': ')
  if (at <= 0) return subject.trim()
  const slug = subject.slice(0, at).trim()
  // A prefix with a space in it is a sentence, not a slug — leave it alone.
  if (!slug || /\s/.test(slug)) return subject.trim()
  return `${slug} — ${subject.slice(at + 2).trim()}`
}

/**
 * Up to `limit` subjects that stand for the day. Commits cluster by slug, so
 * the day's shape is "which slugs did the work touch" — take the busiest slugs
 * and show each one's first subject. Ties keep the order the day ran in.
 */
export function pickDaySubjects(subjects: string[], limit = 2): string[] {
  const bySlug = new Map<string, { first: string; count: number; order: number }>()
  for (const subject of subjects) {
    const at = subject.indexOf(': ')
    const slug = at > 0 && !/\s/.test(subject.slice(0, at)) ? subject.slice(0, at) : subject
    const hit = bySlug.get(slug)
    if (hit) hit.count += 1
    else bySlug.set(slug, { first: subject, count: 1, order: bySlug.size })
  }
  return [...bySlug.values()]
    .sort((a, b) => (b.count - a.count) || (a.order - b.order))
    .slice(0, limit)
    .map((entry) => readableSubject(entry.first))
}

// ── Future marks ─────────────────────────────────────────────────────────────

export type MarkKind = 'due' | 'launch' | 'snooze'

export interface DayMark {
  kind: MarkKind
  glyph: string
  /** 0…1 along the rail. */
  fraction: number
  label: string
  cardId: string
}

const MARK_GLYPH: Record<MarkKind, string> = { due: '◴', launch: '◐', snooze: '◌' }

/**
 * The hollow marks a day carries: obligations, not events.
 *
 *   ◴ due       a card whose `due:` names this CIVIL DAY, at mid-morning —
 *               a due has no time of day, so it may not pretend to one.
 *   ◐ launch    a standing role's `nextLaunchAt`, an INSTANT, at its real
 *               position on the rail.
 *   ◌ snooze    a stashed card whose due lands here — deferred work returning.
 *
 * A stashed card takes the hollow ◌ instead of ◴, never both. Closed cards
 * carry no obligation and are skipped.
 */
export function marksForDay(cards: KanbanCard[], day: string, bounds: RailBounds): DayMark[] {
  const marks: DayMark[] = []
  for (const card of cards) {
    if (card.status === 'closed') continue
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
  /** Cheap fingerprint — bumps the render generation only on real change. */
  print: string
}

interface LoadedNarration {
  monday: string
  byDay: Map<string, string[]>
  print: string
}

interface WeekRow {
  day: string
  root: HTMLElement
  rail: HTMLElement
  /** Everything that is patched: rasters, marks, the now line. */
  paint: HTMLElement
  annot: HTMLElement
  margin: HTMLElement
  sig: string
}

class WeekView implements TemporalView {
  readonly id = 'week' as const
  readonly title = 'Week'
  readonly hotkey = '4'

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
  private rows: WeekRow[] = []

  private activity: LoadedActivity | null = null
  private narration: LoadedNarration | null = null
  /** Bumped when loaded data actually changes; part of every row signature. */
  private dataGen = 0
  private activityKey = ''

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    if (!this.page?.root.isConnected) return
    if (keystrokeIsSpokenFor()) return
    e.preventDefault()
    this.goWeek(e.key === 'ArrowLeft' ? -1 : 1)
  }

  mount(host: HTMLElement, ctx: ViewContext): void {
    const page = createViewPage(this.title)
    this.page = page
    page.titleRow.append(this.buildHead())
    host.append(page.root)
    document.addEventListener('keydown', this.onKeyDown)
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
    this.page?.root.remove()
    this.page = null
    this.ctx = null
    this.label = null
    this.totals = null
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

    head.append(nav, totals)
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
    const focus = normalizeFocusDate(ctx.focusDate) ?? railCivilDay(Date.now(), RAIL_START_HOUR)
    ctx.setFocusDate(shiftCivilDay(focus, delta * 7))
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
    page.body.append(grid)
    this.shellMonday = this.monday

    const date = civilDayToLocalDate(this.monday)
    if (this.label && date) {
      this.label.textContent = `Week of ${date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`
      const isCurrent = this.monday === weekMondayForFocus(null, Date.now())
      this.label.classList.toggle('wk-weeklabel-away', !isCurrent)
      this.label.title = isCurrent ? 'This week' : 'Back to this week'
    }
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
    rail.append(rules, paint)

    const annot = document.createElement('div')
    annot.className = 'wk-annot'
    const margin = document.createElement('div')
    margin.className = 'wk-margin'

    root.append(label, rail, annot, margin)
    return { day, root, rail, paint, annot, margin, sig: '' }
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  /**
   * Ask for the week's activity and narration. Both calls go out on every
   * refresh — the fetchers memoize per argument tuple, so a repeat is free —
   * and land into `this.activity` / `this.narration` only if the week they were
   * asked for is still the week on screen.
   */
  private load(ctx: ViewContext): void {
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

    void ctx.narration(win.narrationFrom, win.narrationTo).then((res) => {
      if (this.monday === monday) this.acceptNarration(monday, win.days, res)
    })
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
    const print = `${res.buckets.length}:${res.buckets.at(-1)?.m ?? 0}`
    if (this.activity?.monday === monday && this.activity.print === print) return
    this.activity = {
      monday,
      byDay,
      week: summarizeSpend(res.buckets),
      print,
    }
    this.dataGen += 1
    this.paint()
  }

  private acceptNarration(monday: string, days: string[], res: NarrationResult): void {
    const byDay = new Map<string, string[]>()
    const edges = days.map((day) => ({ day, bounds: railBounds(day) }))
    for (const commit of res.commits) {
      const at = instantMs(commit.iso)
      if (at === undefined) continue
      const hit = edges.find((e) => at >= e.bounds.startMs && at < e.bounds.endMs)
      if (!hit) continue
      const list = byDay.get(hit.day)
      if (list) list.push(commit.subject)
      else byDay.set(hit.day, [commit.subject])
    }
    const print = `${res.commits.length}:${res.commits.at(-1)?.iso ?? ''}`
    if (this.narration?.monday === monday && this.narration.print === print) return
    this.narration = { monday, byDay, print }
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
    const todayCivil = railCivilDay(now, RAIL_START_HOUR)
    const activity = this.activity?.monday === this.monday ? this.activity : null
    const narration = this.narration?.monday === this.monday ? this.narration : null

    if (this.totals) {
      const week = activity?.week
      this.totals.textContent = week
        ? `attention ${formatCoarseSpan(week.attentionMs)} · agents ${formatCoarseSpan(week.agentMs)}`
        : ''
    }

    const inFlight = ctx.response.now.inFlight

    for (const row of this.rows) {
      const bounds = railBounds(row.day)
      const isToday = row.day === todayCivil
      const isPast = row.day < todayCivil
      const marks = isPast ? [] : marksForDay(ctx.cards, row.day, bounds)
      const visible = isToday ? marks.filter((m) => m.fraction > railFraction(now, bounds)) : marks

      const buckets = activity?.byDay.get(row.day) ?? []
      const sig = [
        row.day,
        this.dataGen,
        isToday ? `t${minute}` : isPast ? 'p' : 'f',
        visible.map((m) => `${m.kind}${m.cardId}`).join(','),
        isToday ? inFlight.map((c) => c.id).join(',') : '',
      ].join('|')
      if (row.sig === sig) continue
      row.sig = sig

      row.root.classList.toggle('wk-row-today', isToday)
      row.root.classList.toggle('wk-row-past', isPast)
      row.root.classList.toggle('wk-row-future', !isPast && !isToday)

      row.paint.innerHTML = ''
      if (buckets.length > 0 && activity) {
        paintRaster(row.paint, buckets, bounds, isToday ? now : bounds.endMs)
      }
      for (const mark of visible) row.paint.append(this.buildMark(mark, visible))
      if (isToday) {
        const nowLine = document.createElement('span')
        nowLine.className = 'wk-now'
        nowLine.style.left = `${railFraction(now, bounds) * 100}%`
        row.paint.append(nowLine)
      }

      const spend = activity ? summarizeSpend(buckets) : null
      row.annot.textContent =
        isPast || isToday
          ? spend && spend.totalMs > 0
            ? `${formatSpan(spend.totalMs)} · ${dayWeight(spend.totalMs)}`
            : '—'
          : ''

      row.margin.className = 'wk-margin'
      row.margin.textContent = ''
      if (isToday) {
        row.margin.classList.add('wk-margin-live')
        row.margin.textContent = inFlight.map((c) => c.name).join(' · ')
      } else if (isPast) {
        row.margin.textContent = pickDaySubjects(narration?.byDay.get(row.day) ?? []).join(' · ')
      } else {
        row.margin.classList.add('wk-margin-marks')
        // The glyph keeps its rail colour in the margin, so the line and the
        // row read as one statement rather than a legend and a caption.
        visible.forEach((mark, i) => {
          if (i > 0) row.margin.append(document.createTextNode(' · '))
          const glyph = document.createElement('span')
          glyph.className = `wk-margin-glyph wk-mark-${mark.kind}`
          glyph.textContent = mark.glyph
          row.margin.append(glyph, document.createTextNode(` ${mark.label}`))
        })
      }
      row.margin.title = row.margin.textContent ?? ''
      row.root.setAttribute(
        'aria-label',
        `${row.day} — ${row.annot.textContent || 'no activity'}${row.margin.textContent ? `; ${row.margin.textContent}` : ''}`,
      )
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

  row.append(rail, document.createElement('div'), document.createElement('div'))
  return row
}

/**
 * Ink the day's rasters: one tick per active slot per kind, layered
 * agent → attention → notify so a notification always reads on top of the run
 * it interrupted. Opacity carries the run's weight, so a dense hour darkens
 * instead of merging into a block.
 */
function paintRaster(
  host: HTMLElement,
  buckets: ActivityBucket[],
  bounds: RailBounds,
  cutoffMs: number,
): void {
  const span = bounds.endMs - bounds.startMs
  if (span <= 0) return

  // slot index → kind → strongest event count seen in it
  const slots = new Map<number, Map<ActivityBucket['k'], number>>()
  for (const b of buckets) {
    if (b.m > cutoffMs) continue
    const index = Math.floor((b.m - bounds.startMs) / RASTER_SLOT_MS)
    let kinds = slots.get(index)
    if (!kinds) {
      kinds = new Map()
      slots.set(index, kinds)
    }
    kinds.set(b.k, Math.max(kinds.get(b.k) ?? 0, b.n))
  }

  const order: ActivityBucket['k'][] = ['agent', 'attention', 'notify']
  for (const kind of order) {
    for (const [index, kinds] of slots) {
      const n = kinds.get(kind)
      if (n === undefined) continue
      const at = bounds.startMs + (index + 0.5) * RASTER_SLOT_MS
      const tick = document.createElement('span')
      tick.className = `wk-ras wk-ras-${kind}`
      tick.style.left = `${((at - bounds.startMs) / span) * 100}%`
      // Agent runs carry a count; attention and notify are single events and
      // read at a fixed weight so a busy hour of typing doesn't out-shout them.
      if (kind === 'agent') tick.style.opacity = String(0.38 + 0.47 * Math.min(1, n / 12))
      host.append(tick)
    }
  }
}

/** The view's own copy of the board's "this keystroke belongs to someone else"
 *  guard — a text field, a Radix dialog, or the fiber-detail panel layered over
 *  the board. KanbanModal keeps its version private, and a shared-file edit is
 *  not this view's to make. */
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

registerView(new WeekView())
