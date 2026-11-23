import type { Fiber } from './KanbanFiber.js';
import { dueCivilDay, isoDayLocal } from '../sdk/civilDay.js';

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

function normalizeHorizon(value: unknown): KanbanHorizon | undefined {
  if (typeof value !== 'string') return undefined;
  // Only `stashed` is a value; everything else is absence. `now` is absence by
  // definition, and any other value (`soon` still turns up in old frontmatter)
  // names no surface, so the card belongs on the desk wearing whatever `due:`
  // it has.
  return value.trim() === 'stashed' ? 'stashed' : undefined;
}
