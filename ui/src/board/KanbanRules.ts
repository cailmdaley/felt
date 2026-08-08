import { CronExpressionParser } from 'cron-parser';
import type { Fiber } from './KanbanFiber.js';
import { dueCivilDay, isoDayLocal } from './civilDay.js';

// The kanban's single classifier, in the view. Shuttle (the engine) speaks
// engine vocabulary — eligible/blocked/running — and never names a kanban
// column; translating that into columns is view logic, so it lives here, in
// the frontend, as the SOLE implementation. (Historically this same code ran
// server-side in `server/src/KanbanRules.ts`; the "kanban reads Shuttle
// directly" cutover relocated it here so there is exactly one home.)

const DAY_MS = 24 * 60 * 60 * 1000;

export const KANBAN_HORIZONS = ['now', 'soon', 'stashed'] as const;
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
  | 'composted';

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

  if (f.hasShuttleBlock !== true) return 'drafts';
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
  // The Now desk holds only what's chosen for today: a `due:` card earns desk
  // presence when its due *day* is today or already past, never on a forward-
  // looking window. Anything due tomorrow or later lives on the timeline at its
  // date — drag a card to tomorrow and it leaves Now. Both sides of the
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
  // when it comes back. It is NOT `soon`: a soon card sits on the timeline and
  // nowhere else, while a snoozed one rests AND ghosts onto its due day.
  if (due !== undefined && storedHorizon === 'stashed') {
    return {
      storedHorizon,
      effectiveHorizon: 'stashed',
      drifted: false,
    };
  }

  if (due !== undefined) {
    return {
      storedHorizon,
      effectiveHorizon: 'soon',
      drifted: false,
    };
  }

  if (storedHorizon === 'stashed' || storedHorizon === 'soon') {
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
  if (trimmed === 'now') return undefined;
  return HORIZON_SET.has(trimmed) ? trimmed as KanbanHorizon : undefined;
}
