import type { Fiber } from './KanbanFiber.js';
import { dueCivilDay, isoDayLocal, shiftCivilDay } from './civilDay.js';

// The board's rules over time: cycles and the planning horizon. Where a card
// stands on its lifecycle is its owning daemon's to say (`column` on its feed
// row); these rules decide what a card wears and where a gesture lands.

// Two surfaces. `now` is desk presence and `stashed` is Resting; there is no
// scheduled surface, because a `due:` is a date a card wears, never a place it
// goes.
export type KanbanHorizon = 'now' | 'stashed';

/** The tag that makes a fiber a cycle. Matched case-insensitively on a trimmed
 *  tag so `Cycle` and ` cycle ` are the same declaration. */
const CYCLE_TAG = 'cycle';

/**
 * Is this fiber a CYCLE — a named span of time rather than a piece of work?
 *
 * A cycle is an annotation on the calendar: `start:` opens it, `due:` closes
 * it, and the temporal views draw it as a band behind the work. It is not
 * something you do, so it never belongs in a lifecycle column: the read model
 * files it among the cycles before it asks any card's column.
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

/** The shape `lensCycles` reads off a cycle card. Structural
 *  rather than `Pick<KanbanCard, …>` so the rules module keeps owning no
 *  view types; `KanbanCard` satisfies it. */
export interface CycleDropCandidate {
  id: string;
  name: string;
  cycleStart: string | null;
  due?: string;
}

/**
 * Why a fiber belongs to a cycle. Membership is always DERIVED — a fiber is
 * never assigned to a cycle, so there is no field to write, nothing to keep in
 * sync, and no way for a cycle's roster to disagree with the calendar.
 *
 * Two rungs, in the order `cycleMembership` tries them:
 *
 *   'due'       the fiber's `due:` falls inside the span. The plain reading of
 *               "this is due this sprint".
 *   'in-flight' the fiber is being worked RIGHT NOW and the cycle is the one we
 *               are living in. Work in flight belongs to the current chapter by
 *               definition; it says nothing about a chapter that hasn't opened,
 *               which is why this rung is gated on the span covering today.
 */
export type CycleMembershipReason = 'due' | 'in-flight';

/** What membership reads off a fiber. Structural, like `CycleDropCandidate`:
 *  the rules module owns no view types, and `KanbanCard` satisfies this. */
export interface CycleMemberCandidate {
  due?: string;
  /** True when the fiber is currently being worked — on the Desk, that it sits
   *  in the In flight column. A fact supplied by the caller, not re-derived
   *  here, so the predicate stays independent of how a surface is assembled. */
  inFlight?: boolean;
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
  /** The civil day a drop on this chip writes, i.e. the day cell the chip
   *  stands in for — undefined for a cycle with no `start:`, which offers no
   *  day and so refuses the drop. */
  dropDay?: string;
}

/**
 * The cycles the Desk offers as lenses — the current one plus everything still
 * ahead. A cycle qualifies when its span has not ended.
 *
 * Ordered by start, then name, so the row holds still across polls.
 *
 * Each chip is also a DROP TARGET, and `dropDay` is what a drop writes — but
 * only for a cycle that has a `start:`. A cycle without one is a bare deadline
 * (see `cycleSpan`'s second branch): there is no opening day to snooze to, so
 * it offers no `dropDay` and the drop refuses. A lens needs no opening day —
 * a one-day span is a perfectly good filter — so a due-only cycle still gets
 * its chip.
 *
 * `dropDay` is the cycle's start, CLAMPED FORWARD to tomorrow when the cycle
 * is already running. Dropping into a chapter you are living in means "later
 * this chapter", never a backdated due — and tomorrow is also the earliest day
 * the day cells themselves treat as a snooze (today means "onto the desk now").
 */
export function lensCycles(
  cycles: readonly CycleDropCandidate[],
  nowMs: number = Date.now(),
): CycleLensChip[] {
  const today = isoDayLocal(nowMs);
  // Stepped on the civil calendar, not by adding 24h: a DST-long day would
  // leave `nowMs + DAY_MS` on today, and the clamp would emit a backdate.
  const tomorrow = shiftCivilDay(today, 1);

  const chips: CycleLensChip[] = [];
  for (const c of cycles) {
    const span = cycleSpan({ start: c.cycleStart ?? undefined, due: c.due }, nowMs);
    if (!span) continue;
    if (span.end < today) continue;
    const running = span.start <= today;
    chips.push({
      id: c.id,
      name: c.name,
      start: span.start,
      end: span.end,
      openEnded: span.openEnded,
      running,
      dropDay: c.cycleStart ? (running ? tomorrow : span.start) : undefined,
    });
  }
  chips.sort((a, b) => (a.start === b.start ? a.name.localeCompare(b.name) : a.start < b.start ? -1 : 1));
  return chips;
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
  // a date nobody reads. The PRECEDENCE is the rule: drift WINS over a stored
  // `stashed`, never the other way round.
  //
  // SNOOZED — a future `due:` under a stored `stashed` — is the other half. The
  // two fields compose: `stashed` says where the card lives (Resting, off the
  // desk), `due:` says when it comes back. Only an EXPLICIT snooze takes a card
  // off the desk: a bare future `due:` reads `now`, so the card keeps its column
  // and simply wears the date. (`normalizeHorizon` only ever answers `stashed`
  // or undefined, so `stashed` below is exactly "there is a stored horizon".)
  const stashed = storedHorizon === 'stashed';
  return {
    storedHorizon,
    effectiveHorizon: duePromotesToNow || !stashed ? 'now' : 'stashed',
    drifted: duePromotesToNow && stashed,
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

function normalizeHorizon(value: unknown): KanbanHorizon | undefined {
  if (typeof value !== 'string') return undefined;
  // Only `stashed` is a value; everything else is absence. `now` is absence by
  // definition, and any other value (`soon` still turns up in old frontmatter)
  // names no surface, so the card belongs on the desk wearing whatever `due:`
  // it has.
  return value.trim() === 'stashed' ? 'stashed' : undefined;
}
