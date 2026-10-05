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
//
// THE ZONE IS A PARAMETER. Crossing between the two kinds — the local day of
// an instant, the instant a civil day starts — needs a time zone, and this
// module is the only code on the board that knows one. Every crossing takes a
// `Zone` as its last argument, defaulting to `hostZone()`; nothing here reads
// `Date`'s local getters, so a test can put the question to any zone in one
// process (`civilDay.properties.test.ts` does, across the IANA database). A
// structural test (`ui/test/zoneReads.test.ts`) keeps every other module off
// `Date`'s local-zone methods. Civil-day arithmetic — stepping days, weekdays,
// labels — needs no zone at all and takes none.

// ── Zones ────────────────────────────────────────────────────────────────────

const QUARTER_HOUR_MS = 900_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/**
 * An IANA time zone, ready to answer wall-clock questions. Build one with
 * {@link zone}; the board's own is {@link hostZone}.
 *
 * Offsets are read through `Intl.DateTimeFormat#formatToParts` and memoized
 * per quarter hour of UTC: a quarter hour whose two ends agree has one offset
 * throughout, and one whose ends differ holds a transition and is read
 * directly, to the second, every time. The views ask in loops, and a
 * `formatToParts` costs fifty times a `Date` getter.

 */
class Zone {
  readonly id: string
  readonly #fields: Intl.DateTimeFormat
  readonly #offsets = new Map<number, number>()

  constructor(id: string) {
    this.#fields = new Intl.DateTimeFormat('en-US', {
      timeZone: id,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    this.id = this.#fields.resolvedOptions().timeZone
  }

  /** Wall clock minus UTC at an instant, in ms (`-25_200_000` for PDT). */
  offsetMs(ms: number): number {
    if (!Number.isFinite(ms)) return 0
    const quarter = Math.floor(ms / QUARTER_HOUR_MS)
    let offset = this.#offsets.get(quarter)
    if (offset === undefined) {
      const first = this.#read(quarter * QUARTER_HOUR_MS)
      const last = this.#read((quarter + 1) * QUARTER_HOUR_MS - 1000)
      // NaN marks a quarter hour with a transition inside it.
      offset = first === last ? first : Number.NaN
      if (this.#offsets.size >= 8192) this.#offsets.clear()
      this.#offsets.set(quarter, offset)
    }
    return Number.isNaN(offset) ? this.#read(ms) : offset
  }

  /** The offset at an instant, straight from Intl, to the second. */
  #read(ms: number): number {
    const at = Math.floor(ms / 1000) * 1000
    const f: Record<string, number> = {}
    for (const part of this.#fields.formatToParts(at)) {
      if (part.type !== 'literal') f[part.type] = Number(part.value)
    }
    return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - at
  }
}
export type { Zone }

const zones = new Map<string, Zone>()

/** The zone an IANA id names (`'America/Los_Angeles'`, `'UTC'`). Cached, so
 *  calling it per use costs a map lookup. Throws a RangeError on an unknown id. */
export function zone(id: string): Zone {
  let z = zones.get(id)
  if (!z) {
    z = new Zone(id)
    zones.set(id, z)
  }
  return z
}

let host: { zone: Zone; resolvedAt: number } | undefined
const HOST_RECHECK_MS = 60_000

/** The machine's own zone — the default for every crossing. Resolving it costs
 *  a fresh `Intl.DateTimeFormat`, so it is re-read at most once a minute: a
 *  board left open across a flight follows the machine within that. */
export function hostZone(): Zone {
  const now = Date.now()
  if (!host || Math.abs(now - host.resolvedAt) > HOST_RECHECK_MS) {
    const id = new Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
    host = { zone: zone(id), resolvedAt: now }
  }
  return host.zone
}

/** An instant's wall clock in a zone, as a Date read with its UTC getters. */
function wall(ms: number, z: Zone): Date {
  return new Date(ms + z.offsetMs(ms))
}

function isoOfWall(w: Date): string {
  const m = String(w.getUTCMonth() + 1).padStart(2, '0')
  const d = String(w.getUTCDate()).padStart(2, '0')
  return `${w.getUTCFullYear()}-${m}-${d}`
}

/**
 * The instant a wall-clock time names in a zone (`wallMs` is that wall clock
 * written as if it were UTC). A repeated hour resolves to its first pass; a
 * skipped one is read with the offset in force before the jump, landing just
 * past it — the rule `new Date(y, m, d, h)` follows, so a spring-forward
 * midnight becomes the day's first real instant.
 */
function wallToInstant(wallMs: number, z: Zone): number {
  const before = z.offsetMs(wallMs - DAY_MS)
  const after = z.offsetMs(wallMs + DAY_MS)
  const early = wallMs - before
  const late = wallMs - after
  const earlyHolds = z.offsetMs(early) === before
  const lateHolds = z.offsetMs(late) === after
  if (earlyHolds && lateHolds) return Math.min(early, late)
  if (lateHolds) return late
  return early
}

// ── Instant → civil day ──────────────────────────────────────────────────────

/** The civil day (`YYYY-MM-DD`) an instant falls on in a zone. */
export function isoDayLocal(ms: number, z: Zone = hostZone()): string {
  return isoOfWall(wall(ms, z))
}

/** An instant's wall-clock time in a zone, 24-hour. */
export function wallClock(
  ms: number,
  z: Zone = hostZone(),
): { hour: number; minute: number; second: number } {
  const w = wall(ms, z)
  return { hour: w.getUTCHours(), minute: w.getUTCMinutes(), second: w.getUTCSeconds() }
}

/** The hour a rail opens, and the next one closes. Work past midnight belongs
 *  to the day it started, so the day boundary is dawn, not midnight. Every
 *  surface that asks "which day is it" draws from this one value — two
 *  surfaces disagreeing about which day it is, is the defect it exists to
 *  prevent. */
export const RAIL_START_HOUR = 6

/**
 * The civil day whose RAIL contains an instant — the "which day is it" a view
 * whose day begins at dawn has to ask.
 *
 * The chronicle draws a day as a `startHour → startHour` rail, because work
 * that runs past midnight belongs to the evening it grew from. That makes this a
 * different question from {@link isoDayLocal}: at 02:00 on Wednesday the rail
 * being worked is TUESDAY's. Asking the midnight question while drawing the dawn
 * one is a real defect — it puts "today" on a column that has not started yet
 * and inks the night's work one column past its own today line.
 *
 * The boundary is a WALL-CLOCK hour, so this reads the wall hour and steps back
 * a calendar day rather than subtracting `startHour` hours of milliseconds. On
 * a DST day those are not the same thing, and only the wall-clock reading
 * agrees with the rail the view actually drew ({@link railBounds}).
 */
export function railCivilDay(
  ms: number,
  startHour = RAIL_START_HOUR,
  z: Zone = hostZone(),
): string {
  const w = wall(ms, z)
  const day = isoOfWall(w)
  return w.getUTCHours() >= startHour ? day : shiftCivilDay(day, -1)
}

// ── Civil day → instant ──────────────────────────────────────────────────────

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

// Date.parse normalizes some impossible dates (for example February 30).
// Reject them rather than giving malformed timestamps a real sort position.
function validCalendarDay(day: string): boolean {
  const [year, month, date] = day.split('-').map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month >= 1 && month <= 12 && date >= 1 && date <= days[month - 1]
}

/** A civil day as `Date.UTC` midnight — a zone-free calendar coordinate, never
 *  an instant anyone lived. Undefined when the string is not a civil day. */
function civilUtc(day: string | undefined): number | undefined {
  if (!day || !DATE_ONLY_RE.test(day) || !validCalendarDay(day)) return undefined
  const [y, m, d] = day.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/**
 * The instant a civil day reaches wall-clock `hour:00` in a zone — `hour` 0 is
 * the day's start, 12 its noon. Never re-parse a civil day with `new Date(iso)`:
 * that reads it as UTC midnight and labels it a day early west of Greenwich.
 * On a spring-forward day whose midnight does not exist this is the first
 * instant that does. Undefined when the string is not a civil day.
 */
export function civilDayAt(
  day: string | undefined,
  hour = 0,
  z: Zone = hostZone(),
): number | undefined {
  const utc = civilUtc(day)
  return utc === undefined ? undefined : wallToInstant(utc + hour * HOUR_MS, z)
}

/**
 * The instant span one civil day's rail covers: `RAIL_START_HOUR` on the day
 * to `RAIL_START_HOUR` on the next. Both edges are real wall-clock times, so a
 * DST rail is genuinely 23h or 25h long and everything positioned on it by
 * time fraction stays in the right place; consecutive rails abut exactly.
 *
 * Unparseable input yields `{0, 0}`; a caller that needs a different fallback
 * must validate before calling.
 */
export function railBounds(day: string, z: Zone = hostZone()): { startMs: number; endMs: number } {
  const startMs = civilDayAt(day, RAIL_START_HOUR, z)
  const endMs = civilDayAt(shiftCivilDay(day, 1), RAIL_START_HOUR, z)
  if (startMs === undefined || endMs === undefined) return { startMs: 0, endMs: 0 }
  return { startMs, endMs }
}

/** The instants a run of civil days covers in a zone, both ends included:
 *  the start of `first` to the last second of `last`. An end that is not a
 *  civil day reads as the epoch. */
export function civilDaySpan(first: string, last: string, z: Zone = hostZone()): [number, number] {
  const fromMs = civilDayAt(first, 0, z) ?? 0
  const after = civilDayAt(shiftCivilDay(last, 1), 0, z)
  return [fromMs, after === undefined ? 0 : after - 1000]
}

// ── Civil-day arithmetic — no zone ───────────────────────────────────────────

/**
 * The civil day `delta` CALENDAR days from `day`, negative for earlier; `day`
 * itself when it is not a civil day. Pure calendar arithmetic: no zone enters,
 * so no DST transition can skip or repeat a day.
 */
export function shiftCivilDay(day: string, delta: number): string {
  const utc = civilUtc(day)
  return utc === undefined ? day : isoOfWall(new Date(utc + delta * DAY_MS))
}

/** Day of the week a civil day is, 0 = Sunday. Undefined when not a civil day. */
export function civilWeekday(day: string): number | undefined {
  const utc = civilUtc(day)
  return utc === undefined ? undefined : new Date(utc).getUTCDay()
}

const formats = new Map<string, Intl.DateTimeFormat>()

function formatter(zoneId: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${zoneId}|${JSON.stringify(opts)}`
  let f = formats.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, { ...opts, timeZone: zoneId })
    formats.set(key, f)
  }
  return f
}

/** A civil day said in the reader's locale (`Jul 30`, `Thursday`, …). The
 *  same words in every zone, because a civil day has none. Undefined when the
 *  string is not a civil day. */
export function formatCivilDay(
  day: string | undefined,
  opts: Intl.DateTimeFormatOptions,
): string | undefined {
  const utc = civilUtc(day)
  return utc === undefined ? undefined : formatter('UTC', opts).format(utc + 12 * HOUR_MS)
}

/** `toLocaleString()`'s fields: the date and the time, numerically. */
export const DATE_AND_TIME: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
}

/** `toLocaleTimeString()`'s fields: the time alone. */
export const TIME_OF_DAY: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
}

/** An instant said in the reader's locale, on a zone's wall clock. */
export function formatInstant(
  ms: number,
  opts: Intl.DateTimeFormatOptions,
  z: Zone = hostZone(),
): string {
  return formatter(z.id, opts).format(ms)
}

// ── `due:` ───────────────────────────────────────────────────────────────────

// A civil day serialized as a timestamp: midnight, exactly, in whatever offset
// the value itself declares — `Z`, `+00:00`, `+02:00`, `-07:00`. The optional
// fractional seconds cover the `.000Z` variants other writers emit.
const DECLARED_MIDNIGHT_RE =
  /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?(?:Z|[+-]\d{2}:?\d{2})$/

/**
 * The civil calendar day (`YYYY-MM-DD`) a `due:` value names.
 *
 *   - bare `YYYY-MM-DD` → taken verbatim; it is already a civil day.
 *   - exact midnight in its own declared offset → the leading date, verbatim.
 *     This is a civil day that went through a `time.Time` (see the module
 *     comment); the time-of-day is an artifact of the round trip, not
 *     information, and the offset says only where the value was written.
 *   - anything else → a genuine instant carrying a real time-of-day; resolve it
 *     to its day in `z`, which is what the board's columns are keyed by.
 *
 * Undefined when absent or unparseable.
 */
export function dueCivilDay(value: unknown, z: Zone = hostZone()): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (DATE_ONLY_RE.test(trimmed)) return validCalendarDay(trimmed) ? trimmed : undefined
  const ms = instantMs(trimmed)
  if (ms === undefined) return undefined
  const declaredMidnight = DECLARED_MIDNIGHT_RE.exec(trimmed)
  return declaredMidnight ? declaredMidnight[1] : isoDayLocal(ms, z)
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
  if (typeof value !== 'string' || !value.trim()) return undefined
  const day = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(value.trim())?.[1]
  if (day && !validCalendarDay(day)) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/** Sort key for a `due:`: the start, in `z`, of the civil day it names. */
export function dueSortMs(value: unknown, z: Zone = hostZone()): number | undefined {
  return civilDayAt(dueCivilDay(value, z), 0, z)
}

/**
 * Descending comparator over sort keys — "most recent first", the shape most
 * lists on the board want. An absent key sorts LAST in both directions: a card
 * with no timestamp is not a card from 1970.
 */
export function descByKey(a: number | undefined, b: number | undefined): number {
  if (a === b) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  return b - a
}

/** Ascending comparator over sort keys — "soonest first". Absent keys last. */
export function ascByKey(a: number | undefined, b: number | undefined): number {
  if (a === b) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  return a - b
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
export function sameCivilDue(
  cardDue: string | undefined,
  next: string | null,
  z: Zone = hostZone(),
): boolean {
  if (next === null) return (cardDue ?? '') === ''
  const a = dueCivilDay(cardDue, z)
  return a !== undefined && a === dueCivilDay(next, z)
}

// ── Durations ────────────────────────────────────────────────────────────────
// Not a civil-day concern — a span has no zone. It lives here because this is
// the module every time-facing surface already imports, views and the
// fiber page alike.

/**
 * A span of minutes as `2h 05m` / `47m`.
 *
 * `pad` zero-pads the minutes when there are hours, for mono columns that must
 * line up. `empty`, when given, replaces any non-positive span — omit it to
 * render `0m` (and to let a negative span show as itself, which is a bug worth
 * seeing rather than hiding).
 */
export function formatSpanMinutes(
  minutes: number,
  opts: { pad?: boolean; empty?: string } = {},
): string {
  if (opts.empty !== undefined && minutes <= 0) return opts.empty
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h <= 0) return `${m}m`
  return `${h}h ${opts.pad ? String(m).padStart(2, '0') : m}m`
}
