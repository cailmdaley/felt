// Civil days vs instants — the one place the board reconciles the two.
//
// A `due:` names a CIVIL CALENDAR DAY: "this is due Thursday", not "this is due
// at some instant". felt, however, stores it as a `*time.Time` — `2026-07-30`
// is parsed with `time.Parse("2006-01-02")` (internal/felt/felt.go) and
// serialized back as the UTC instant `2026-07-30T00:00:00Z`. The day survives
// the round trip only if you read the value as the calendar day it names.
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

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
// felt's serialization of a civil day: midnight, exactly, in UTC. The optional
// fractional seconds cover the `.000Z` variants other writers emit.
const UTC_MIDNIGHT_RE = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?(?:Z|\+00:00)$/;

/**
 * The civil calendar day (`YYYY-MM-DD`) a `due:` value names.
 *
 *   - bare `YYYY-MM-DD` → taken verbatim; it is already a civil day.
 *   - exact UTC midnight → the leading date, verbatim. This is felt's storage
 *     of a civil day (see the module comment); the time-of-day is an artifact
 *     of the round trip, not information.
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
  const utcMidnight = UTC_MIDNIGHT_RE.exec(trimmed);
  if (utcMidnight) return utcMidnight[1];
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? isoDayLocal(ms) : undefined;
}

/**
 * The timeline day-column for a `due:` value — the due-aware sibling of
 * KanbanSurfaces' `dayIndexForIso`. The two must stay separate: the day columns
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
