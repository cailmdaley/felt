// Civil days vs instants — the one place the board reconciles the two.
//
// Every time value on the board is one of two kinds, and every bug of this
// class is one kind silently becoming the other:
//
//   CIVIL DAY — "the 30th". No zone. It means the same day wherever you are.
//     `due:` is the only one on the board.
//   INSTANT — a real point on the timeline. It stays pinned when you fly.
//     `createdAt`, `closedAt`, `modifiedAt`, `nextLaunchAt`.
//
// THE RULE for reading a `due:`: a value that is EXACTLY MIDNIGHT IN THE
// OFFSET IT ITSELF DECLARES is a civil day — take its leading `YYYY-MM-DD`
// verbatim, whatever that offset is. Only a value carrying a real time-of-day
// is an instant, and only that falls back to local-day resolution.
//
// The rule is about kind, not encoding, so it holds for every writer. felt
// stores a `due:` as a `*time.Time` — `2026-07-30` is parsed with
// `time.Parse("2006-01-02")` (internal/felt/felt.go) and serialized back as
// `2026-07-30T00:00:00Z` — but a value authored on a machine at UTC+2 comes
// back as `2026-06-15T00:00:00+02:00`, and the human meant the 15th in both
// cases. Matching only `Z` would render that one as the 14th in Berkeley while
// `felt show` printed the 15th.
//
// Read it as an instant instead — `new Date(iso)` then a LOCAL day — and every
// negative-offset zone loses a day: UTC midnight is the previous evening in
// America/Los_Angeles, so a card due Thursday renders on Wednesday. That was a
// real bug: drop a card on a future timeline column and it landed one day
// earlier, both optimistically and after the refetch.
//
// So: do NOT "simplify" `dueCivilDay` back to `new Date(v)`. The Date round
// trip is exactly the defect. The deeper fix — felt storing `due:` as a bare
// civil date — is a data-model change plus a migration; until it happens the
// UI must keep reading the existing `T00:00:00Z` values correctly, and after it
// happens the date-only branch below already handles them.

/** Local calendar day (`YYYY-MM-DD`) for an instant. */
export function isoDayLocal(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** The hour a rail opens, and the next one closes. Work past midnight belongs
 *  to the day it started, so the day boundary is dawn, not midnight. Day, Week
 *  and Chronicle all draw from this one value (re-exported by
 *  views/railTime.ts) — three views disagreeing about which day it is, is the
 *  defect it exists to prevent. */
export const RAIL_START_HOUR = 6;

/**
 * The civil day whose RAIL contains an instant — the "which day is it" a view
 * whose day begins at dawn has to ask.
 *
 * The temporal views draw a day as a `startHour → startHour` rail, because work
 * that runs past midnight belongs to the evening it grew from. That makes this a
 * different question from {@link isoDayLocal}: at 02:00 on Wednesday the rail
 * being worked is TUESDAY's. Asking the midnight question while drawing the dawn
 * one is a real defect — it puts "today" on a row that has not started yet, pins
 * the now-marker to the left edge of an empty rail, and greys out the live row as
 * past, taking its in-flight marginalia and its obligation marks with it.
 *
 * The boundary is a WALL-CLOCK hour, so this reads `getHours()` and steps back a
 * calendar day rather than subtracting `startHour` hours of milliseconds. On a
 * DST day those are not the same thing, and only the wall-clock reading agrees
 * with the rail the view actually drew.
 *
 * One definition, shared: WeekView's row classification and DayView's
 * `defaultDayISO` are the same rule and must not drift apart.
 */
export function railCivilDay(ms: number, startHour = RAIL_START_HOUR): string {
  const d = new Date(ms);
  if (d.getHours() >= startHour) return isoDayLocal(ms);
  // Noon anchor before the stride — midnight is the one wall-clock time a
  // spring-forward day can lack.
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - 1);
  return isoDayLocal(d.getTime());
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
// A civil day serialized as a timestamp: midnight, exactly, in whatever offset
// the value itself declares — `Z`, `+00:00`, `+02:00`, `-07:00`. The optional
// fractional seconds cover the `.000Z` variants other writers emit.
const DECLARED_MIDNIGHT_RE =
  /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * The civil calendar day (`YYYY-MM-DD`) a `due:` value names.
 *
 *   - bare `YYYY-MM-DD` → taken verbatim; it is already a civil day.
 *   - exact midnight in its own declared offset → the leading date, verbatim.
 *     This is a civil day that went through a `time.Time` (see the module
 *     comment); the time-of-day is an artifact of the round trip, not
 *     information, and the offset says only where the value was written.
 *   - anything else → a genuine instant carrying a real time-of-day; resolve it
 *     to its local day, which is what the board's columns are keyed by.
 *
 * Undefined when absent or unparseable.
 */
export function dueCivilDay(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (DATE_ONLY_RE.test(trimmed)) return trimmed;
  const declaredMidnight = DECLARED_MIDNIGHT_RE.exec(trimmed);
  if (declaredMidnight) return declaredMidnight[1];
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? isoDayLocal(ms) : undefined;
}

/**
 * A civil day (`YYYY-MM-DD`) materialized as a LOCAL `Date` — noon-safe
 * midnight in the viewer's zone, ready for `toLocaleDateString`. Never re-parse
 * a civil day with `new Date(iso)`: that reads it as UTC midnight and labels it
 * a day early west of Greenwich. Undefined when the string is not a civil day.
 */
export function civilDayToLocalDate(day: string | undefined): Date | undefined {
  if (!day) return undefined;
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!parts) return undefined;
  const d = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Sort key for an INSTANT: milliseconds since the epoch, or undefined when
 * absent/unparseable.
 *
 * Instants must never be compared as STRINGS. RFC3339 carries an offset, so a
 * string compare orders by local wall clock: `2026-07-27T09:00:00-07:00` sorts
 * below `2026-07-27T18:00:00+02:00` although they are the SAME instant. Work
 * created in Berkeley therefore sank below older Paris work everywhere the
 * board sorts by time.
 */
export function instantMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Sort key for a `due:`: local midnight of the civil day it names. */
export function dueSortMs(value: unknown): number | undefined {
  return civilDayToLocalDate(dueCivilDay(value))?.getTime();
}

/**
 * Descending comparator over sort keys — "most recent first", the shape most
 * lists on the board want. An absent key sorts LAST in both directions: a card
 * with no timestamp is not a card from 1970.
 */
export function descByKey(a: number | undefined, b: number | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return b - a;
}

/** Ascending comparator over sort keys — "soonest first". Absent keys last. */
export function ascByKey(a: number | undefined, b: number | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

/**
 * The timeline day-column for a `due:` value. Due values and instants must be
 * placed separately: the day columns
 * are keyed by local civil days, so a genuine instant (closedAt, modifiedAt,
 * nextLaunchAt) is placed by its LOCAL day, while a `due:` is placed by the
 * civil day it names. Null when there's no value or the day is outside the
 * rendered window.
 */
export function dayIndexForDue(
  due: string | undefined,
  dayIndex: Map<string, number>,
): number | null {
  const day = dueCivilDay(due);
  if (day === undefined) return null;
  return dayIndex.get(day) ?? null;
}

/**
 * Do two `due:` values name the SAME CIVIL DAY? The board's drop guard —
 * "already in this surface, nothing to write" — asks this, and it must ask it
 * in civil days, not in raw strings: the card carries felt's serialization
 * (`2026-07-30T00:00:00Z`, or `…+02:00` from a machine that was in Paris) while
 * the drop supplies the bare `2026-07-30` the timeline column names. As a
 * string compare those look like a real change, so a genuine no-op ran a write
 * and the board flickered through an optimistic move it then had to undo.
 * `next === null` means "clear the due" and matches only a card with none.
 */
export function sameCivilDue(cardDue: string | undefined, next: string | null): boolean {
  if (next === null) return (cardDue ?? '') === '';
  const a = dueCivilDay(cardDue);
  return a !== undefined && a === dueCivilDay(next);
}

// ── Durations ────────────────────────────────────────────────────────────────
// Not a civil-day concern — a span has no zone. It lives here because this is
// the module every time-facing surface already imports, views and the fiber
// detail panel alike.

/**
 * A span of minutes as `2h 05m` / `47m`.
 *
 * `pad` zero-pads the minutes when there are hours, for mono columns that must
 * line up. `empty`, when given, replaces any non-positive span — omit it to
 * render `0m` (and to let a negative span show as itself, which is a bug worth
 * seeing rather than hiding).
 *
 * WeekView keeps its own `formatSpan`: it renders a whole hour as `1h`, not
 * `1h 0m`, and that difference does not fit an option.
 */
export function formatSpanMinutes(
  minutes: number,
  opts: { pad?: boolean; empty?: string } = {},
): string {
  if (opts.empty !== undefined && minutes <= 0) return opts.empty;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${opts.pad ? String(m).padStart(2, '0') : m}m`;
}
