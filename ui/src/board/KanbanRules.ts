import { CronExpressionParser } from 'cron-parser';
import type { Fiber } from './KanbanFiber.js';
import { civilDayToLocalDate, dueCivilDay, isoDayLocal } from './civilDay.js';

// The kanban's single classifier, in the view. Shuttle (the engine) speaks
// engine vocabulary — eligible/blocked/running — and never names a kanban
// column; translating that into columns is view logic, so it lives here, in
// the frontend, as the SOLE implementation. (Historically this same code ran
// server-side in `server/src/KanbanRules.ts`; the "kanban reads Shuttle
// directly" cutover relocated it here so there is exactly one home.)

// Two surfaces, not three. `now` is desk presence and `stashed` is Resting;
// there is no separate scheduled surface, because a `due:` is a date a card
// wears, never a place it goes. (The old `soon` exiled every future-dated card
// to a permanent timeline strip; the strip is gone, so `soon` meant invisible.)
const KANBAN_HORIZONS = ['now', 'stashed'] as const;
export type KanbanHorizon = typeof KANBAN_HORIZONS[number];

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
 * Why a fiber belongs to a cycle. Membership is always DERIVED — a fiber is
 * never assigned to a cycle, so there is no field to write, nothing to keep in
 * sync, and no way for a cycle's roster to disagree with the calendar.
 *
 * Three rungs, in the order this function tries them:
 *
 *   'due'       the fiber's `due:` falls inside the span. The plain reading of
 *               "this is due this sprint".
 *   'in-flight' the fiber is being worked RIGHT NOW and the cycle is the one we
 *               are living in. Work in flight belongs to the current chapter by
 *               definition; it says nothing about a chapter that hasn't opened,
 *               which is why this rung is gated on the span covering today.
 *   'worked'    the fiber was worked on some day inside the span. This is the
 *               real historical rule, and it is the one the Desk CANNOT answer:
 *               activity days live in the temporal feeds, which the Desk does
 *               not fetch. The rung is implemented and tested here so the day a
 *               caller can supply `workedDays` it simply passes them; the Desk
 *               leaves the field undefined and the rung is skipped.
 */
export type CycleMembershipReason = 'due' | 'in-flight' | 'worked';

/** What membership reads off a fiber. Structural, like `CycleDropCandidate`:
 *  the rules module owns no view types, and `KanbanCard` satisfies this. */
export interface CycleMemberCandidate {
  due?: string;
  /** True when the fiber is currently being worked — on the Desk, that it sits
   *  in the In flight column. A fact supplied by the caller, not re-derived
   *  here, so the predicate stays independent of how a surface is assembled. */
  inFlight?: boolean;
  /** Civil days (`YYYY-MM-DD`) this fiber was worked on. Undefined wherever the
   *  caller has no activity data — see the `worked` rung above. */
  workedDays?: readonly string[];
}

/**
 * Does this fiber belong to `span`, and by which rung? Returns null for a
 * non-member. Both edges of the span are inclusive, and every comparison is
 * between bare civil days, so no caller re-parses a `due:` as an instant.
 */
export function cycleMembership(
  card: CycleMemberCandidate,
  span: CycleSpan,
  nowMs: number = Date.now(),
): CycleMembershipReason | null {
  const due = dueCivilDay(card.due);
  if (due !== undefined && due >= span.start && due <= span.end) return 'due';

  const today = isoDayLocal(nowMs);
  if (card.inFlight === true && span.start <= today && today <= span.end) return 'in-flight';

  if (card.workedDays?.some((d) => d >= span.start && d <= span.end)) return 'worked';

  return null;
}

/** One cycle offered as a lens on the Desk. */
export interface CycleLensChip {
  id: string;
  name: string;
  start: string;
  end: string;
  openEnded: boolean;
  /** True when the cycle has already opened and has not closed — the chapter
   *  we are living in. */
  running: boolean;
}

/**
 * The cycles the Desk offers as lenses — the current one plus everything still
 * ahead. A cycle qualifies when its span has not ended.
 *
 * Deliberately WIDER than `upcomingCycleDropTargets`, which is the drop-target
 * rule: that one refuses a cycle without a `start:`, because a bare deadline
 * has no opening day to snooze to. A lens needs no opening day — a one-day
 * span is a perfectly good filter — so a due-only cycle is admitted here.
 *
 * Ordered by start, then name, so the row holds still across polls.
 */
export function lensCycles(
  cycles: readonly CycleDropCandidate[],
  nowMs: number = Date.now(),
): CycleLensChip[] {
  const today = isoDayLocal(nowMs);
  const chips: CycleLensChip[] = [];
  for (const c of cycles) {
    const span = cycleSpan({ start: c.cycleStart ?? undefined, due: c.due }, nowMs);
    if (!span) continue;
    if (span.end < today) continue;
    chips.push({
      id: c.id,
      name: c.name,
      start: span.start,
      end: span.end,
      openEnded: span.openEnded,
      running: span.start <= today,
    });
  }
  chips.sort((a, b) => (a.start === b.start ? a.name.localeCompare(b.name) : a.start < b.start ? -1 : 1));
  return chips;
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

/**
 * Would this `due:` pull a card straight back onto the desk the moment it was
 * put down in Resting?
 *
 * The question the Resting drop has to ask before it decides what to do with a
 * deadline it was not handed. Dragging into Resting PRESERVES a future `due:` —
 * that composition is the snooze, and it is the only reason a rested card ever
 * comes back on its own. But `effectiveHorizon`'s drift branch promotes any
 * card whose due day is today or already past, and it runs BEFORE the stashed
 * branch, so keeping a stale deadline would land the card back in Drafts on the
 * very next poll: the drag would read as ignored, which is the dissonance the
 * classifier's liveness note says the board must never produce. A due that
 * answers true here is dropped instead — out loud, never silently.
 *
 * Phrased as a question put TO `effectiveHorizon` rather than as its own day
 * comparison, so this rule cannot drift from the branch that causes the bounce.
 */
export function dueBouncesFromResting(
  due: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (due === undefined) return false;
  return effectiveHorizon({ due, horizon: 'stashed' }, nowMs).effectiveHorizon === 'now';
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

// ─── SEQUENCE GATING ──────────────────────────────────────────────────────
//
// `depends_on:` is a project-owned frontmatter field (felt does not interpret
// it), and it says one thing: this card is the NEXT one, behind that one. The
// board reads it as a sequence — a chain of cards where only the head is on
// the desk and the rest wait their turn in Resting.
//
// Every rule below is a pure derivation over the feed. Nothing about a gate is
// stored: when the dep tempers, the card returns to its natural column on the
// very next poll because the derivation now answers differently. There is no
// "ungate" write, no state to reconcile, and no way for the board to disagree
// with the documents.

/** What a dependency edge points at, as far as the gate is concerned. Only
 *  `tempered` unlocks — the same rung `toCard` has always read. */
export interface DepTarget {
  tempered?: boolean;
}

/** How one card's `depends_on:` list resolved against the feed. */
export interface DependencyResolution {
  /** True when nothing KNOWN stands in the way. FAIL-OPEN: a dep id the feed
   *  cannot resolve does not block — see `unresolved`. */
  satisfied: boolean;
  /** Deps that resolved to a real fiber that is not tempered yet. These are
   *  the ones actually holding the card back. */
  blocking: string[];
  /** Dep ids nothing in the feed answers to — a typo, a fiber from a store
   *  this board cannot see, or a rename. They are NOT treated as blocking:
   *  hiding a card behind an id that resolves to nothing is how work
   *  disappears with no way to find it. The card stays where it is and wears a
   *  warning instead. (`felt check` is the place that scolds about it.) */
  unresolved: string[];
}

/**
 * Resolve a card's `depends_on:` against a lookup over the whole feed.
 *
 * `lookup` rather than a map so a caller can resolve by uid as well as by id
 * without this module knowing how the feed is indexed.
 */
export function resolveDependencies(
  dependsOn: readonly string[] | undefined,
  lookup: (id: string) => DepTarget | undefined,
): DependencyResolution {
  const blocking: string[] = [];
  const unresolved: string[] = [];
  for (const id of dependsOn ?? []) {
    const target = lookup(id);
    if (target === undefined) unresolved.push(id);
    else if (target.tempered !== true) blocking.push(id);
  }
  return { satisfied: blocking.length === 0, blocking, unresolved };
}

/** The shape the gate reads off a card. Structural, so the rules module keeps
 *  owning no view types; `KanbanCard` satisfies it. */
export interface DepGateCandidate {
  status: string;
  dependsOnSatisfied: boolean;
  runningWorker?: string;
  /** The human's verdict, when there is one. Only a VERDICT exempts a card
   *  from the gate — `status:closed` on its own does not. */
  tempered?: boolean;
}

/**
 * Does the dependency gate hold this card off the desk?
 *
 * Two exemptions, and each is a case where resting would LIE about the card:
 *   • satisfied deps (or none)  → nothing to wait for.
 *   • a VERDICT already given   → tempered or composted is history, not an
 *                                 attention claim. Resting it would file a
 *                                 finished thing under "waiting its turn".
 *   • a LIVE worker             → the thing is happening right now. Whatever
 *                                 the frontmatter says, hiding a running
 *                                 worker in Resting is the board disagreeing
 *                                 with reality.
 *
 * NOT exempt, though it is `status:closed`: an AWAITING-REVIEW card — closed,
 * no verdict yet — with an unsatisfied dep. A review that cannot usefully
 * happen until the work ahead of it lands is exactly the thing queuing exists
 * to take off the desk; leaving it in the Awaiting review column while its own
 * head advertises it as "+1 queued" is the board saying both at once. It rests,
 * and returns to Awaiting review by itself the moment the dep tempers — the
 * same derivation, answering differently, with nothing stored.
 *
 * Everything else — a draft, an armed oneshot, a scheduled role — rests until
 * the dep tempers. This composes with `effectiveHorizon` by ADDITION, never by
 * override: an explicitly stashed card rests because it was put down, a gated
 * card rests because it is not its turn, and a card that is both rests once.
 */
export function depGated(card: DepGateCandidate): boolean {
  if (card.dependsOnSatisfied) return false;
  if (card.tempered !== undefined) return false;
  if (card.runningWorker) return false;
  return true;
}

/** A node in the dependency graph, as the reverse-edge builder needs it. */
export interface DepEdgeNode {
  id: string;
  dependsOn?: readonly string[];
}

/**
 * Reverse the dependency edges: id → the cards that name it in `depends_on:`.
 *
 * Forward edges are what the documents store ("I come after that one"); every
 * question the board asks is the other direction ("what is queued behind me?"),
 * so the reversal happens once, over the whole collection, and the chain
 * walkers below read it. Dependents are sorted by id so a chain reads the same
 * way on every poll — an order that reshuffles is an order nobody can aim at.
 */
export function buildDependents(nodes: readonly DepEdgeNode[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) {
      const list = out.get(dep);
      if (list) list.push(node.id);
      else out.set(dep, [node.id]);
    }
  }
  for (const list of out.values()) list.sort();
  return out;
}

/**
 * Everything queued behind a card, transitively, in chain order.
 *
 * Breadth-first from the head, so the list reads the way the work will happen:
 * the card that goes next first, then what goes after that. A `seen` set makes
 * a cycle in hand-written frontmatter finite rather than fatal — the board
 * draws what it can and moves on; `felt check` is where a cycle gets named.
 * The head itself is never in the result.
 */
export function queuedBehind(
  headId: string,
  dependents: ReadonlyMap<string, readonly string[]>,
): string[] {
  const seen = new Set<string>([headId]);
  const out: string[] = [];
  let frontier = [...(dependents.get(headId) ?? [])];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      next.push(...(dependents.get(id) ?? []));
    }
    frontier = next;
  }
  return out;
}

/**
 * The END of the chain a card heads — where a newly-stacked card attaches.
 *
 * Dropping onto a card means "after this work", and if that card already has
 * work queued behind it, "after" means after ALL of it. So the drop resolves
 * to the DEEPEST node reachable through the reverse edges, and the new card
 * depends on that one: A←B←C plus a dropped D becomes A←B←C←D, a queue rather
 * than a fan-out nobody asked for.
 *
 * A fan-in that a human hand-wrote (two cards both depending on A) has no
 * single tail; the deepest-then-first-in-chain-order rule picks one
 * deterministically rather than refusing the gesture. Returns the head itself
 * when nothing is queued behind it.
 */
export function chainTail(
  headId: string,
  dependents: ReadonlyMap<string, readonly string[]>,
): string {
  const seen = new Set<string>([headId]);
  let tail = headId;
  let frontier = [...(dependents.get(headId) ?? [])];
  while (frontier.length > 0) {
    const next: string[] = [];
    let deepest: string | null = null;
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (deepest === null) deepest = id;
      next.push(...(dependents.get(id) ?? []));
    }
    if (deepest !== null) tail = deepest;
    frontier = next;
  }
  return tail;
}

/**
 * Would stacking `sourceId` behind `targetId` close a loop?
 *
 * True when the target is the source itself, or is already somewhere in the
 * queue behind the source — dropping a card onto its own descendant. The
 * gesture refuses rather than writing frontmatter that would gate both cards
 * forever with no way out but a text editor.
 */
export function stackWouldCycle(
  sourceId: string,
  targetId: string,
  dependents: ReadonlyMap<string, readonly string[]>,
): boolean {
  if (sourceId === targetId) return true;
  return queuedBehind(sourceId, dependents).includes(targetId);
}

/**
 * The card's own hot zone for a stack drop — the inner fraction of its box.
 *
 * A card is a drop target for TWO different gestures: the column under it
 * takes lifecycle drops (drag to In flight to dispatch, to Drafts to reopen),
 * and the card itself takes sequence drops. Whichever claims the event wins,
 * so a card that claimed every drop landing on it would silently eat the
 * lifecycle gestures — a draft dropped on the In-flight column would stack
 * instead of dispatch, which is a different thing than the one you aimed at.
 *
 * So the card claims only a DELIBERATE hit: release near its middle. The outer
 * band is the column's, exactly as it was before sequences existed. The zone
 * is also what the plum highlight tracks, so the promise and the behavior are
 * the same rectangle.
 *
 * `rect` must be the card's VISIBLE rectangle, not its layout box — see
 * `intersectRects`. A card half-scrolled out of a column still offers a zone,
 * in the middle of the half you can see.
 */
export interface ZoneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The part of `a` that `b` actually shows — or null when `b` hides it entirely.
 *
 * The board's columns scroll (`.kbn-col-list` is `overflow-y: auto`), so a
 * card's box and the part of the card a cursor can reach are DIFFERENT
 * RECTANGLES, and the hot zone has to be computed on the second one. Computed
 * on the first, the bottom card of a full column has its middle band below the
 * fold: the zone is real, it just cannot be pointed at, and the card reads as
 * inert while every card above it highlights. That was the bug.
 */
export function intersectRects(a: ZoneRect, b: ZoneRect): ZoneRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

export function inStackHotZone(
  rect: { left: number; top: number; width: number; height: number },
  point: { x: number; y: number },
  fraction = 0.6,
): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  const marginX = (rect.width * (1 - fraction)) / 2;
  const marginY = (rect.height * (1 - fraction)) / 2;
  return (
    point.x >= rect.left + marginX &&
    point.x <= rect.left + rect.width - marginX &&
    point.y >= rect.top + marginY &&
    point.y <= rect.top + rect.height - marginY
  );
}

/**
 * Does the card claim this drag event, or does it fall through to the column?
 *
 * The whole discriminator, in one pure function, because it is the rule that
 * keeps every pre-existing gesture working. A refused stack claims nothing —
 * no interception, no banner, no flash — it simply is not a stack, and the
 * column handles the drop it always handled.
 *
 * A legal stack claims on either of two signals, and the second one exists
 * because the first turned out to be a moving target:
 *
 *   • THE HOT ZONE — the pointer is near the card's middle. Fast, and the
 *     original rule.
 *   • DWELL — the pointer has rested anywhere on the card for a beat. Aiming
 *     at a band is only easy if the band holds still, and on this board it does
 *     not: picking a card up materializes the drag horizon, which pushes the
 *     whole desk down some 60px, so the middle you aimed at before lifting is
 *     not the middle any more. A card near the bottom of a scrolling column
 *     gets it twice over — the same shift pushes it further under the fold, and
 *     its visible strip (which is what the zone is measured on) shrinks with
 *     it. That is how one card came to look permanently inert while its
 *     neighbours lit up.
 *
 * Dwell is the honest reading of the gesture anyway: a drag that CROSSES a card
 * on its way to a column is moving, and a drag that STOPS on a card is aiming
 * at it. Nothing about a pass-through arms, so the lifecycle drops keep every
 * gesture they had.
 */
export function stackClaimsDrop(
  verdict: StackVerdict | null,
  inHotZone: boolean,
  dwelled = false,
): boolean {
  if (verdict === null || !verdict.ok) return false;
  return inHotZone || dwelled;
}

/**
 * Is enough of this card on screen for its hot zone to be offered at all?
 *
 * A card at the fold of a scrolling column can show a 20px sliver, and the
 * zone is measured on what you can see — so the sliver becomes a hair-trigger
 * stack target sitting exactly where people aim when they mean "drop this at
 * the bottom of the column". That is how a stack gets authored by accident.
 *
 * A card has to be SUBSTANTIALLY present to be aimed at: at least two fifths of
 * itself, and at least a comfortable finger's worth of pixels. Below that the
 * card offers no zone and the drop belongs to the column, which is what the
 * human meant. Dwell still works — resting on a sliver for a beat is a
 * deliberate act in a way that passing over it is not.
 */
export function stackZoneOffered(cardHeight: number, visibleHeight: number): boolean {
  if (visibleHeight <= 0 || cardHeight <= 0) return false;
  return visibleHeight >= Math.max(cardHeight * 0.4, MIN_STACK_ZONE_PX);
}

/** The smallest visible strip that may carry a hot zone. Under this a card is
 *  a sliver at the fold, not a target. */
export const MIN_STACK_ZONE_PX = 44;

/**
 * May a CARD drag arm, given where the gesture began?
 *
 * The invariant this enforces: a peek-list row drag and a card drag can never
 * both be in flight. Every drop target on the board — sections, columns, day
 * cells, other cards — decides what to do by asking for the card drag's source,
 * so if a row drag could also arm that source, one gesture would be read as two
 * and the board would move a fiber nobody dragged. That is not a thing to be
 * careful about at each site; it has to be impossible at the one place a card
 * drag can start.
 *
 * Both refusals are about origin, not intent:
 *   • a row drag is already in flight — whatever this is, it is not a new card;
 *   • the gesture began inside a peek list — its rows, its chip, its padding.
 *     The rows handle their own drags; anything else in there is a near-miss on
 *     a row, and a near-miss must do nothing rather than move the head fiber.
 */
export function cardDragArms(opts: {
  rowDragInFlight: boolean;
  startedInsidePeekList: boolean;
}): boolean {
  return !opts.rowDragInFlight && !opts.startedInsidePeekList;
}

/** What a peek-list row's drag can do, and what to say on hover about it. */
export interface QueueRowGesture {
  /** May this row be picked up at all? */
  draggable: boolean;
  /** May it be dropped back into its own list to change the queue's order?
   *  A strictly narrower permission than `draggable`. */
  reorderable: boolean;
  /** `title` text for the row — what the drag will do, or why there isn't one.
   *  A row that cannot be dragged has to SAY so; a silent refusal reads as a
   *  broken board, and the human tries again harder. */
  hint: string;
}

/**
 * May one row of a "+N queued" peek list be dragged, and where to?
 *
 * TWO PERMISSIONS, not one, and conflating them is what broke this:
 *
 *   • TAKE IT OUT of the queue (drop on a column, a section, Resting). This
 *     clears exactly one `depends_on:` — the row's own — plus at most one
 *     repair edge on its successor. So it is a fact about THE ROW'S OWN FIBER
 *     and nothing else.
 *   • REORDER it within the list. This rewrites the `depends_on:` of every
 *     member the move steps over, so one hand-written list anywhere in the
 *     chain takes the affordance away from the whole chain — the same rule the
 *     stack drop follows, for the same reason: a fan-in someone assembled by
 *     hand carries intent no drag can reconstruct.
 *
 * The narrower one used to gate the wider one, which meant a queue of ONE — or
 * a queue with a single hand-written member anywhere in it — had no draggable
 * rows at all, and the row that was perfectly free to leave simply did not
 * move. Hence the signature: the row's own shape decides `draggable`, the
 * chain's shape decides `reorderable`.
 *
 * NOTHING ABOUT THE HEAD CARD IS AN INPUT. Not its column, not its state, not
 * whose daemon serves it. That is deliberate and it is why they are absent
 * here rather than merely unused: a row is the fiber it names, and where the
 * card it happens to hang off is sitting is not a fact about that fiber.
 *
 * Neither is ORIGIN. A remote-owned fiber drags like any other: `/felt-edit`
 * routes the write to the owning daemon over the socket and refreshes the
 * registry afterwards, so the board does not need to know who owns what to
 * offer the gesture. An owner that is genuinely dead fails the forward, and
 * THAT is reported when it happens — a real error naming a real host beats a
 * pre-emptive refusal that guesses.
 */
export function queueRowGesture(opts: {
  /** The ROW's own `depends_on:` shape. */
  shape?: 'scalar' | 'list';
  /** Members in the queue, the head excluded. */
  queueLength: number;
  /** Is every member of the chain scalar-shaped? */
  chainAllScalar: boolean;
  /** Is a reorder handler wired at all? */
  canReorder: boolean;
  /** Is an unqueue handler wired at all? */
  canUnqueue: boolean;
}): QueueRowGesture {
  // A hand-written `depends_on:` LIST is the one honest refusal. Dropping the
  // row would have to guess which of several edges the human meant to cut, and
  // the list is the record of a decision no gesture can re-make.
  if (opts.shape === 'list') {
    return {
      draggable: false,
      reorderable: false,
      hint: 'Waits on a hand-written depends_on: list — open it and edit that list to move it.',
    };
  }
  const reorderable = opts.canReorder && opts.queueLength > 1 && opts.chainAllScalar;
  if (!opts.canUnqueue && !reorderable) {
    return {
      draggable: false,
      reorderable: false,
      hint: 'This board is read-only for sequences right now.',
    };
  }
  return {
    draggable: true,
    reorderable,
    hint: reorderable
      ? 'Drag to reorder the queue, or out to a column or Resting to take it out.'
      : 'Drag it out to a column or Resting to take it out of the queue.',
  };
}

/** How long the pointer must rest on a card before the card arms as a stack
 *  target. Long enough that crossing a card en route to a column never arms
 *  it, short enough to feel like the card answered you. */
export const STACK_DWELL_MS = 350;

/** One card's `depends_on:` as a reorder would leave it. */
export interface QueueRewrite {
  fiberId: string;
  /** The card this one now comes after — the head for the first position, the
   *  member above it otherwise. */
  newDep: string;
}

/**
 * Rewire a queue after a row is dragged to a new position.
 *
 * The queue is a CHAIN, and the chain is stored as one `depends_on:` per
 * member pointing at whoever comes before it: the head for position one, the
 * member above for the rest. So "move row 3 to the top" is not a stored order
 * anyone can write — it is a handful of edges that change, and this function
 * says exactly which. Everything else in the queue keeps the predecessor it
 * had and is not touched, which matters: a write per member would rewrite
 * frontmatter (and bump `modified_at`) on cards the human did not move.
 *
 * `from` and `to` are both indices into `queue` — `to` is the position the row
 * ENDS UP at, the ordinary array-move reading, so moving 0→2 in [a,b,c] gives
 * [b,c,a]. Out-of-range or equal indices are a no-op, and a queue of fewer
 * than two members has no reorder to make.
 */
export function reorderQueueWrites(
  headId: string,
  queue: readonly string[],
  from: number,
  to: number,
): QueueRewrite[] {
  if (queue.length < 2) return [];
  if (!Number.isInteger(from) || !Number.isInteger(to)) return [];
  if (from < 0 || from >= queue.length) return [];
  if (to < 0 || to >= queue.length) return [];
  if (from === to) return [];

  const next = [...queue];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);

  const predecessorBefore = (id: string): string => {
    const i = queue.indexOf(id);
    return i <= 0 ? headId : queue[i - 1];
  };

  const writes: QueueRewrite[] = [];
  next.forEach((id, i) => {
    const newDep = i === 0 ? headId : next[i - 1];
    if (newDep !== predecessorBefore(id)) writes.push({ fiberId: id, newDep });
  });
  return writes;
}

/**
 * SPLICE a member out of the queue: the chain closes over the gap.
 *
 * Dragging a row off the list is "this one is not in the queue any more", and
 * a queue with a hole in it is not a queue — whoever was behind the departing
 * member has to be handed to whoever was in front of it, or the rest of the
 * chain is orphaned behind a card that no longer waits for anything.
 *
 * Exactly one edge changes (the successor's), so this returns at most one
 * write. The departing row's own `depends_on` is NOT in the result: clearing
 * it is the gesture itself, not part of repairing the chain, and keeping the
 * two separate is what lets the caller apply the drop's own meaning — a
 * column, a surface — on top.
 */
export function unqueueRowWrites(
  headId: string,
  queue: readonly string[],
  index: number,
): QueueRewrite[] {
  if (!Number.isInteger(index) || index < 0 || index >= queue.length) return [];
  const successor = queue[index + 1];
  if (successor === undefined) return [];
  const predecessor = index === 0 ? headId : queue[index - 1];
  return [{ fiberId: successor, newDep: predecessor }];
}

/**
 * Turn an INSERTION POINT into the final index `reorderQueueWrites` wants.
 *
 * The gesture aims at a gap — "put it between rows 2 and 3" — which is a
 * position in the list BEFORE the row leaves it. Once the row is lifted out,
 * every gap below it shifts up by one. Keeping that arithmetic here (rather
 * than in the drop handler) is what lets the drop handler stay three lines and
 * lets the off-by-one be tested.
 *
 * `insertAt` runs 0..length inclusive: 0 is above the first row, `length` is
 * below the last.
 */
export function queueDropIndex(from: number, insertAt: number): number {
  return insertAt > from ? insertAt - 1 : insertAt;
}

/**
 * Is this card's work ACCEPTED — the one state that ends a queue?
 *
 * `tempered: true` is the only verdict that satisfies a dependency, so it is
 * the only state a card cannot be queued behind: the dep would be met the
 * instant it was written and the card would never wait at all. Everything else
 * — open, active, awaiting review, even COMPOSTED — leaves a dependency
 * genuinely unsatisfied, and a stack behind it means exactly what it says.
 *
 * `status: closed` is deliberately NOT the test. It covers awaiting review
 * (live work waiting on a human) and composted alike, and refusing those was
 * over-restriction: it made a draft dragged onto an awaiting-review card fall
 * through to the column and get transitioned instead.
 */
export function isAccepted(card: Pick<StackCandidate, 'tempered'>): boolean {
  return card.tempered === true;
}

/** A queue member that is closed but not accepted: still in the chain, no
 *  longer waiting for its turn. `null` means an ordinary waiting member. */
export type QueueMemberNote = 'awaiting review' | 'composted';

/**
 * How does a queue member sit — waiting its turn, or closed without a verdict?
 *
 * The peek list counts every UNTEMPERED follower, because that is the graph the
 * drop gesture reasons over: a card in awaiting review still occupies its place
 * in the chain, still ends it, and still refuses a second card dropped onto its
 * head. Counting only the live ones made that queue INVISIBLE — an unexplained
 * refusal over a card wearing no chip at all. So the closed members are shown,
 * and shown as what they are rather than as work still waiting.
 */
export function queueMemberNote(
  member: Pick<StackCandidate, 'status' | 'tempered'>,
): QueueMemberNote | null {
  if (member.status !== 'closed') return null;
  return member.tempered === false ? 'composted' : 'awaiting review';
}

/**
 * What the "+N queued" chip reads for a queue of this size.
 *
 * ONE NUMBER, and it is the WHOLE chain — the closed members are queued behind
 * this card in every sense the gesture cares about, and a count that skipped
 * them would disagree with the refusal you get for dropping onto the same card.
 * The chip used to append a second clause counting the settled ones ("· 1 in
 * review"); it made a glance at the desk do arithmetic to answer a question the
 * glance was not asking. How each member sits is a fact about that member, so
 * it belongs where the members are: the peek list, where every row says its own
 * state and wears its own colour (`queueMemberNote`).
 */
export function queuedChipLabel(total: number): string {
  return `+${total} queued`;
}

/** What the stack gesture needs to know about a card to rule on a drop.
 *  `KanbanCard` satisfies it. */
export interface StackCandidate {
  id: string;
  status: string;
  /** The human's verdict, when there is one: `true` tempered, `false`
   *  composted, absent means no verdict yet (open, active, or awaiting
   *  review). This — not `status` — is what settles a card. */
  tempered?: boolean;
  shuttleKind?: string;
  isCycle?: boolean;
  dependsOn?: readonly string[];
  dependsOnShape?: 'scalar' | 'list';
}

/** The gesture's ruling: where the dropped card attaches, or why it may not. */
export type StackVerdict =
  | { ok: true; tail: string }
  | { ok: false; reason: string; code?: StackRefusal };

/** Machine-readable refusals, for the cases the SURFACE has something to say
 *  about mid-drag. Only the ones a hover can honestly narrate get a code; the
 *  rest live in `reason` alone. */
export type StackRefusal = 'alreadyQueued';

/**
 * Rule on "put this card behind that one" — the drag of one card onto another.
 *
 * The gesture writes exactly one scalar `depends_on:`, so it declines every
 * case where one edge is not the whole truth:
 *
 *   • a hand-written LIST on the source — a fan-in someone assembled on
 *     purpose; a drag cannot know which of those edges it was meant to replace.
 *   • a CYCLE fiber on either end — a band of time is not a queue position.
 *   • a closed source — its work is over; queueing it behind something would
 *     be scheduling the past.
 *   • a standing or pinned source — those run on a cron or from the strip, and
 *     a dep would be dead frontmatter the dispatcher does not read (the same
 *     ground as `setSurface`'s standing/pinned guards).
 *   • a LOOP — the target already sits somewhere behind the source. Writing it
 *     would gate both cards forever with no gesture that undoes it.
 *
 * On success the attach point is the chain's TAIL, not the card under the
 * cursor: you aimed at a queue, and joining a queue means joining the end.
 */
export function stackDropVerdict(
  source: StackCandidate,
  target: StackCandidate,
  dependents: ReadonlyMap<string, readonly string[]>,
  lookup?: (id: string) => StackCandidate | undefined,
): StackVerdict {
  if (source.id === target.id) return { ok: false, reason: 'a card cannot wait on itself' };
  if (source.isCycle || target.isCycle) {
    return { ok: false, reason: 'a cycle is a span of time, not a step in a queue' };
  }
  if (source.dependsOnShape === 'list') {
    return { ok: false, reason: 'its depends_on was written by hand — edit it there' };
  }
  // NOTE what is NOT refused here: the source's lifecycle state. Any card may
  // be queued behind another. An awaiting-review or composted source means "if
  // this reopens, it reopens behind that one". A composted source is inert
  // until that day (`depGated` exempts a card that already has a verdict); an
  // awaiting-review one rests immediately, which is the point — the review
  // waits for the work ahead of it. The one refusal this gesture makes about
  // lifecycle is about the TAIL, below.
  if (source.shuttleKind === 'standing') {
    return { ok: false, reason: 'a standing role runs on its schedule' };
  }
  if (source.shuttleKind === 'pinned') {
    return { ok: false, reason: 'a pinned role waits on the strip, not in a queue' };
  }
  // The cycle test runs against the TAIL, because the tail is what the edge is
  // actually written to. Testing the card under the cursor passes a real loop:
  // with X waiting on both T and S, dropping S onto T resolves the tail to X —
  // and `S.depends_on = X` closes S←X←S, gating both forever with no gesture
  // that undoes it. Nothing about T said so.
  const tail = chainTail(target.id, dependents);
  // THE ONE LIFECYCLE REFUSAL, and it is about the TAIL — the card the edge
  // actually points at, not the one the cursor happened to be over. A tempered
  // tail would promise nothing: `dependsOnSatisfied` reads true the moment the
  // edge is written, so the card would never wait. Composted is not refused —
  // a dep on composted work is still unsatisfied, so the stack means what it
  // says.
  const tailCard = tail === target.id ? target : lookup?.(tail);
  if (tailCard && isAccepted(tailCard)) {
    return { ok: false, reason: 'that one is already tempered — there is nothing left to wait for' };
  }
  // ALREADY BEHIND IT — the honest refusal, and the one worth SAYING.
  //
  // Two shapes of the same fact: the source sits somewhere in the chain behind
  // the target (so the tail is the source itself, or the source is one of the
  // members between), or it holds exactly the edge this drop would write. Both
  // used to fall through to "that would make a loop", which is true of the
  // mechanics and useless to the human: a card that is ALREADY where you are
  // trying to put it is not a loop, it is a no-op. The `code` lets the surface
  // name it during the drag without the refusal claiming the event.
  if (tail === source.id || queuedBehind(target.id, dependents).includes(source.id)) {
    return { ok: false, code: 'alreadyQueued', reason: 'it is already queued behind this one' };
  }
  if (stackWouldCycle(source.id, tail, dependents)) {
    return { ok: false, reason: 'that would make a loop' };
  }
  if ((source.dependsOn ?? []).length === 1 && source.dependsOn?.[0] === tail) {
    return { ok: false, code: 'alreadyQueued', reason: 'it is already queued behind that' };
  }
  return { ok: true, tail };
}

function normalizeHorizon(value: unknown): KanbanHorizon | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  // `now` is absence, and legacy `soon` frontmatter reads as absence too: the
  // surface it named no longer exists, and a card that carried it belongs on
  // the desk wearing whatever `due:` it has.
  if (trimmed === 'now' || trimmed === 'soon') return undefined;
  return trimmed === 'stashed' ? 'stashed' : undefined;
}
