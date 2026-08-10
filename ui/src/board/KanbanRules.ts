import { CronExpressionParser } from 'cron-parser';
import type { Fiber } from './KanbanFiber.js';
import { civilDayToLocalDate, dueCivilDay, isoDayLocal } from './civilDay.js';

// The kanban's single classifier, in the view. Shuttle (the engine) speaks
// engine vocabulary — eligible/blocked/running — and never names a kanban
// column; translating that into columns is view logic, so it lives here, in
// the frontend, as the SOLE implementation. (Historically this same code ran
// server-side in `server/src/KanbanRules.ts`; the "kanban reads Shuttle
// directly" cutover relocated it here so there is exactly one home.)

const DAY_MS = 24 * 60 * 60 * 1000;

// Two surfaces, not three. `now` is desk presence and `stashed` is Resting;
// there is no separate scheduled surface, because a `due:` is a date a card
// wears, never a place it goes. (The old `soon` exiled every future-dated card
// to a permanent timeline strip; the strip is gone, so `soon` meant invisible.)
export const KANBAN_HORIZONS = ['now', 'stashed'] as const;
export type KanbanHorizon = typeof KANBAN_HORIZONS[number];
const HORIZON_SET = new Set<string>(KANBAN_HORIZONS);

export const KANBAN_TIMELINE_WINDOW = {
  pastDays: 14,
  futureDays: 14,
} as const;

// Forward-looking window for dormant standing roles on the timeline.
// This intentionally derives from the same future-day count the frontend uses.
export const STANDING_TIMELINE_HORIZON_MS = KANBAN_TIMELINE_WINDOW.futureDays * DAY_MS;

/**
 * The set of columns the kanban renders. Differs from KanbanTarget in that
 * KanbanTarget's legacy aliases are absent.
 */
export type KanbanColumn =
  | 'drafts'
  | 'scheduled'
  | 'pinned'
  | 'inFlight'
  | 'awaitingReview'
  | 'tempered'
  | 'composted'
  | 'cycles';

/** The tag that makes a fiber a cycle. Matched case-insensitively on a trimmed
 *  tag so `Cycle` and ` cycle ` are the same declaration. */
const CYCLE_TAG = 'cycle';

/**
 * Is this fiber a CYCLE — a named span of time rather than a piece of work?
 *
 * A cycle is an annotation on the calendar: `start:` opens it, `due:` closes
 * it, and the temporal views draw it as a band behind the work. It is not
 * something you do, so it never belongs in a lifecycle column — see the first
 * branch of `classifyFiber`, which is where that is enforced.
 */
export function isCycleFiber(f: Pick<Fiber, 'tags'>): boolean {
  return (f.tags ?? []).some((t) => typeof t === 'string' && t.trim().toLowerCase() === CYCLE_TAG);
}

/** The civil days a cycle covers, inclusive at both ends. */
export interface CycleSpan {
  /** First day of the band (`YYYY-MM-DD`). */
  start: string;
  /** Last day of the band (`YYYY-MM-DD`). */
  end: string;
  /** True when the cycle has no `due:` and so runs to today — a band with no
   *  right edge yet, which a view may want to draw differently (fading out,
   *  no end cap) rather than as a span that happens to stop at today. */
  openEnded: boolean;
}

/**
 * Resolve a cycle's span to two civil days, applying the three degenerate
 * cases so no view has to invent its own answer:
 *
 *   start + due   → the span as written.
 *   due, no start → a ONE-DAY span on the due day. A cycle that names only its
 *                   end is a deadline, and a deadline is a day.
 *   start, no due → OPEN-ENDED: runs from start to today. The band grows with
 *                   the calendar until someone closes it by writing a `due:`.
 *   neither       → null. There is no span to draw, and a view that guessed
 *                   one would be inventing a date the human never wrote.
 *
 * Both edges come back as bare civil days read through `dueCivilDay`, so a
 * caller must NOT re-parse them with `new Date` (that reads a civil day as UTC
 * midnight and labels it a day early west of Greenwich — see civilDay.ts).
 * An `end` before `start` is returned as written rather than swapped: that is
 * the human's typo to see and fix, not ours to silently paper over.
 */
export function cycleSpan(
  f: Pick<Fiber, 'start' | 'due'>,
  nowMs: number = Date.now(),
): CycleSpan | null {
  const start = dueCivilDay(f.start);
  const end = dueCivilDay(f.due);
  if (start !== undefined && end !== undefined) return { start, end, openEnded: false };
  if (start === undefined && end !== undefined) return { start: end, end, openEnded: false };
  if (start !== undefined) return { start, end: isoDayLocal(nowMs), openEnded: true };
  return null;
}

/** The shape `upcomingCycleDropTargets` reads off a cycle card. Structural
 *  rather than `Pick<KanbanCard, …>` so the rules module keeps owning no
 *  view types; `KanbanCard` satisfies it. */
export interface CycleDropCandidate {
  id: string;
  name: string;
  cycleStart: string | null;
  due?: string;
}

/** One cycle offered as a drop target on the drag horizon. */
export interface CycleDropTarget {
  id: string;
  name: string;
  /** The span's edges, as civil days (`end` is today for an open-ended cycle). */
  start: string;
  end: string;
  openEnded: boolean;
  /** True when the cycle has already opened — today is on or after `start`. */
  running: boolean;
  /** The civil day a drop writes, i.e. the day cell this chip stands in for. */
  dropDay: string;
}

/**
 * The cycles the drag horizon offers alongside its day cells — "put this down
 * in the next chapter" rather than "put it down on the 14th".
 *
 * A cycle qualifies when it has a `start:` and has not already finished. A
 * cycle without a start is NOT a target: its span is a bare deadline (see
 * `cycleSpan`'s second branch), and there is no opening day to snooze to.
 *
 * `dropDay` is the cycle's start, CLAMPED FORWARD to tomorrow when the cycle
 * is already running. Dropping into a chapter you are living in means "later
 * this chapter", never a backdated due — and tomorrow is also the earliest day
 * the day cells themselves treat as a snooze (today means "onto the desk now").
 *
 * Ordered by start, so the horizon reads left to right as the calendar does.
 */
export function upcomingCycleDropTargets(
  cycles: readonly CycleDropCandidate[],
  nowMs: number = Date.now(),
): CycleDropTarget[] {
  const today = isoDayLocal(nowMs);
  // Stepped on the civil calendar, not by adding 24h: a DST-long day would
  // leave `nowMs + DAY_MS` on today, and the clamp would emit a backdate.
  const tomorrowDate = civilDayToLocalDate(today) ?? new Date(nowMs);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = isoDayLocal(tomorrowDate.getTime());

  const targets: CycleDropTarget[] = [];
  for (const c of cycles) {
    if (!c.cycleStart) continue;
    const span = cycleSpan({ start: c.cycleStart, due: c.due }, nowMs);
    if (!span) continue;
    if (span.end < today) continue;
    const running = span.start <= today;
    targets.push({
      id: c.id,
      name: c.name,
      start: span.start,
      end: span.end,
      openEnded: span.openEnded,
      running,
      dropDay: running ? tomorrow : span.start,
    });
  }
  targets.sort((a, b) => (a.start === b.start ? a.name.localeCompare(b.name) : a.start < b.start ? -1 : 1));
  return targets;
}

/**
 * Classify a fiber into the kanban column it belongs in. The single source
 * of truth for "what column is this?". Reads ONLY the document-lifecycle
 * signals the frozen Shuttle contract names — `status`, `tempered`, `kind`,
 * live tmux liveness (`runningWorker`), and dependency
 * satisfaction (`dependsOnSatisfied`). There is no `enabled` and no
 * `review.state`: lifecycle is `status + tempered`, uniform across kinds.
 *
 *   1. A closed fiber is a human verdict, terminal regardless of tags or
 *      liveness: `tempered:true` → tempered, `tempered:false` → composted,
 *      tempered absent → awaitingReview (worker exited; the agent handed off
 *      and the human hasn't ruled yet). This closed-state IS the
 *      don't-re-fire / anti-oscillation gate, and it is awaiting-review for
 *      BOTH kinds — a standing role's awaiting run is `status:closed`, not an
 *      `active` role carrying a review field.
 *
 *   2. A live tmux worker overrides the open/active branch — the user
 *      dragging a card and seeing it stay in drafts is the dissonance we're
 *      avoiding. Running comes from tmux (never stored); only shuttle fibers
 *      have workers. A running pinned role is caught here too, so it shows as
 *      live work in Now rather than at rest on the Pinned strip.
 *
 *   2b. A resting `kind:pinned` umbrella role (shuttle block, status:active,
 *      no live worker) → `pinned`. Schedule-less and never auto-dispatched;
 *      the strip holds it until someone force-dispatches it. Checked after the
 *      liveness override.
 *
 *   3. The open/active branch, on the document alone:
 *        - no shuttle block      → drafts   (human due-date card; visible,
 *                                            not dispatchable)
 *        - status:open           → drafts   (draft / paused — NOT dispatched;
 *                                            launch is open → active)
 *        - status:active oneshot → inFlight (armed: dispatches when deps are
 *                                            met — the daemon's call, but the
 *                                            card reads In flight either way)
 *        - status:active standing→ scheduled(armed but action-needed-nothing:
 *                                            it fires on its own cron, so it
 *                                            belongs on the timeline at its
 *                                            next launch, not in the Now nav. A
 *                                            *running* standing role returned
 *                                            inFlight at the liveness branch
 *                                            above — live work shows in Now.)
 *      A blocked-by-deps active oneshot still reads inFlight (launch intent —
 *      it flies when the dep clears), so the oneshot active branch collapses to
 *      a single inFlight regardless of `dependsOnSatisfied`.
 *
 * The kanban response splits classifyFiber's output across the
 * surfaces: now, timeline, stash, and the pinned strip. The classifier
 * itself doesn't care which surface — it produces a flat label that the
 * handler routes.
 */
export function classifyFiber(
  f: Fiber,
  opts: { runningWorker?: boolean; dependsOnSatisfied?: boolean } = {},
): KanbanColumn {
  // A CYCLE is an annotation on time, not work, so it leaves before any
  // lifecycle question is asked. This branch is FIRST on purpose and it is
  // unconditional: a cycle's `status`, its `due:`, even a `shuttle:` block
  // someone pasted onto it, must not put it on the desk. Every other branch
  // below would happily claim it — an open cycle reads as a draft, a cycle
  // whose end date has passed reads as a drifted card on the desk — and one
  // stray "Autumn 2026" sitting in Drafts teaches the human to distrust the
  // column.
  if (isCycleFiber(f)) return 'cycles';

  if (f.status === 'closed') {
    if (f.tempered === true) return 'tempered';
    if (f.tempered === false) return 'composted';
    return 'awaitingReview';
  }

  if (opts.runningWorker && f.hasShuttleBlock === true) {
    return 'inFlight';
  }

  // A resting pinned umbrella role: schedule-less, never auto-dispatched. It
  // gets its own strip rather than reading as an armed oneshot in the
  // Now/in-flight lane. Resting covers BOTH parked (`status:open`) and the
  // older armed-at-rest (`status:active`) generations — a pinned role belongs
  // on the strip whenever it is neither closed (handled above) nor actively
  // running (the running-worker override above sends a live pinned worker to
  // Now). Matching both statuses keeps parked roles like science/cmbx
  // (`status:open`) visible on the strip without ejecting legacy active ones.
  if (
    f.hasShuttleBlock === true &&
    f.shuttleKind === 'pinned' &&
    (f.status === 'active' || f.status === 'open')
  ) {
    return 'pinned';
  }

  // Everything still here carries a shuttle block: `shouldIncludeInKanban`
  // admits nothing else onto a Desk column, and the one block-less kind it does
  // admit — a cycle — left at the top of this function. A block-less row that
  // somehow reached this far falls through to `drafts` at the bottom, which is
  // where it would have been sent anyway.
  if (f.status === 'active') {
    // An armed standing role between firings needs no action now — it fires on
    // its own cron. Route it to `scheduled` (→ timeline, placed by the card's
    // `nextLaunchAt`) so the Now / in-flight surface stays action-needed only.
    // A *running* standing role already returned 'inFlight' above: a live worker
    // is activity worth showing in Now, not a waiting-on-the-clock card.
    if (f.shuttleKind === 'standing') return 'scheduled';
    return 'inFlight';
  }
  return 'drafts';
}

export function effectiveHorizon(
  f: Pick<Fiber, 'due' | 'horizon'>,
  nowMs: number = Date.now(),
): { storedHorizon?: KanbanHorizon; effectiveHorizon: KanbanHorizon; drifted: boolean } {
  const storedHorizon = normalizeHorizon(f.horizon);
  // A `due:` day that is today or already past PROMOTES: it overrides a stored
  // `stashed` and pulls the card back onto the desk. A future `due:` alone
  // changes nothing about where the card lives — only an explicit snooze
  // (`horizon: stashed`) takes it off the desk. Both sides of the
  // comparison are civil days: `dueCivilDay` reads the day the `due:` names
  // (including through felt's UTC-midnight storage — see civilDay.ts), and
  // `isoDayLocal` gives today's local day. Without that, a negative-offset zone
  // read tomorrow's due as today's and yanked the card onto the desk a day early.
  const due = dueCivilDay(f.due);
  const duePromotesToNow = due !== undefined && due <= isoDayLocal(nowMs);

  // Due-drift OVERRIDES a stored `stashed`, and that override is snooze's
  // return ticket. A snoozed card is `horizon:stashed` + a future `due:`; when
  // the due day arrives this branch pulls it back onto the desk. Without the
  // override, snooze would be a black hole — the card would rest forever with
  // a date nobody reads. The branch order IS the rule: drift is checked before
  // the stashed branch below, never after.
  if (duePromotesToNow) {
    return {
      storedHorizon,
      effectiveHorizon: 'now',
      drifted: storedHorizon !== undefined,
    };
  }

  // SNOOZED — a future `due:` under a stored `stashed`. The two fields compose:
  // `stashed` says where the card lives (Resting, off the desk), `due:` says
  // when it comes back. Only an EXPLICIT snooze takes a card off the desk: a
  // bare future `due:` falls through to `now` below, so the card keeps its
  // column and simply wears the date.
  if (due !== undefined && storedHorizon === 'stashed') {
    return {
      storedHorizon,
      effectiveHorizon: 'stashed',
      drifted: false,
    };
  }

  if (storedHorizon === 'stashed') {
    return {
      storedHorizon,
      effectiveHorizon: 'stashed',
      drifted: false,
    };
  }

  return {
    storedHorizon,
    effectiveHorizon: 'now',
    drifted: false,
  };
}

/**
 * The civil day a resting card wakes on, or undefined when it rests without a
 * date. A snoozed card is the composition `horizon:stashed` + a future `due:`;
 * this reads the second half back out, for the timeline ghost's placement and
 * its "resting until <day>" title. Returns undefined once the day arrives —
 * from that moment the card is drifted onto the desk, not resting.
 */
export function restingUntil(
  card: Pick<Fiber, 'due' | 'horizon'>,
  nowMs: number = Date.now(),
): string | undefined {
  const h = effectiveHorizon(card, nowMs);
  if (h.effectiveHorizon !== 'stashed') return undefined;
  return dueCivilDay(card.due);
}

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * A cron expression as a human would say it — "weekdays 9:00", "daily 6:30",
 * "Mon 8:00". Undefined for anything this vocabulary can't say faithfully
 * (multiple hours, minute steps, day-of-month or month constraints), so the
 * caller falls back to the raw expression rather than printing a lie.
 *
 * Faithful-or-silent is the whole contract here: a schedule the human reads
 * wrong is worse than one they have to parse themselves, and the raw string
 * always stays available on the `title`.
 */
export function humanizeCron(expr: string | undefined): string | undefined {
  if (typeof expr !== 'string' || !expr.trim()) return undefined;
  let fields;
  try {
    fields = CronExpressionParser.parse(expr.trim()).fields;
  } catch {
    return undefined;
  }
  const minutes = [...fields.minute.values];
  const hours = [...fields.hour.values];
  if (minutes.length !== 1 || hours.length !== 1) return undefined;
  // Only an unconstrained day-of-month + month can be said as a weekly cadence.
  if (fields.dayOfMonth.values.length !== 31) return undefined;
  if (fields.month.values.length !== 12) return undefined;

  const time = `${hours[0]}:${String(minutes[0]).padStart(2, '0')}`;
  // cron-parser lists Sunday as both 0 and 7 for `*`; collapse to 0..6 so the
  // set comparisons below have one representation to reason about. The field
  // values are typed loosely enough to admit the non-numeric cron tokens
  // (`L`, `W`), so coerce and drop anything that isn't a weekday number.
  const dow = [
    ...new Set(
      fields.dayOfWeek.values
        .map((d) => Number(d))
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 7)
        .map((d) => (d === 7 ? 0 : d)),
    ),
  ].sort((a, b) => a - b);
  const key = dow.join(',');
  if (key === '0,1,2,3,4,5,6') return `daily ${time}`;
  if (key === '1,2,3,4,5') return `weekdays ${time}`;
  if (key === '0,6') return `weekends ${time}`;
  if (dow.length <= 3) return `${dow.map((d) => DOW_NAMES[d]).join(', ')} ${time}`;
  return undefined;
}

/**
 * The next cron occurrence for an *armed* standing role, for timeline
 * placement. A standing role is armed iff `status:active` — the sole
 * dispatch gate under the frozen contract. A paused role (`status:open`) or
 * a role awaiting/finished review (`status:closed`) has no next launch: an
 * open role isn't dispatched, and a closed one waits on a human verdict
 * before it re-arms. Returns undefined for non-standing fibers and for any
 * schedule that won't parse.
 */
export function nextStandingLaunch(
  f: Pick<Fiber, 'shuttleKind' | 'shuttleSchedule' | 'status'>,
  nowMs: number = Date.now(),
): string | undefined {
  if (f.shuttleKind !== 'standing') return undefined;
  if (f.status !== 'active') return undefined;
  const expr = f.shuttleSchedule?.expr;
  if (typeof expr !== 'string' || !expr.trim()) return undefined;
  const rawTz = f.shuttleSchedule?.tz;
  const tz = typeof rawTz === 'string' && rawTz.trim() ? rawTz : 'UTC';
  try {
    const it = CronExpressionParser.parse(expr, {
      tz,
      currentDate: new Date(nowMs),
    });
    return it.next().toISOString() ?? undefined;
  } catch {
    return undefined;
  }
}

export function parseDueMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function normalizeHorizon(value: unknown): KanbanHorizon | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  // `now` is absence, and legacy `soon` frontmatter reads as absence too: the
  // surface it named no longer exists, and a card that carried it belongs on
  // the desk wearing whatever `due:` it has.
  if (trimmed === 'now' || trimmed === 'soon') return undefined;
  return HORIZON_SET.has(trimmed) ? trimmed as KanbanHorizon : undefined;
}
