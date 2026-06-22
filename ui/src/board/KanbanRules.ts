import { CronExpressionParser } from 'cron-parser';
import type { Fiber } from './KanbanFiber.js';

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

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  // presence when its due *day* is today or already past (local calendar day),
  // never on a forward-looking window. Anything due tomorrow or later lives on
  // the timeline at its date — drag a card to tomorrow and it leaves Now. The
  // comparison is day-aligned so it's correct across timezones for a bare
  // `YYYY-MM-DD` due (taken at face value as a tz-free calendar day).
  const due = dueDay(f.due);
  const duePromotesToNow = due !== undefined && due <= isoDayLocal(nowMs);

  if (duePromotesToNow) {
    return {
      storedHorizon,
      effectiveHorizon: 'now',
      drifted: storedHorizon !== undefined,
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

/** Local calendar day (`YYYY-MM-DD`) for a timestamp. */
function isoDayLocal(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** The calendar day a `due:` value falls on. A bare `YYYY-MM-DD` is taken at
 *  face value — a timezone-free calendar day — so the desk boundary matches
 *  what the user authored regardless of UTC offset; a full timestamp resolves
 *  to its local day. Undefined when absent or unparseable. */
function dueDay(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (DATE_ONLY_RE.test(trimmed)) return trimmed;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? isoDayLocal(ms) : undefined;
}

export function isKanbanHorizon(value: unknown): value is KanbanHorizon {
  return typeof value === 'string' && HORIZON_SET.has(value);
}

function normalizeHorizon(value: unknown): KanbanHorizon | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === 'now') return undefined;
  return HORIZON_SET.has(trimmed) ? trimmed as KanbanHorizon : undefined;
}
