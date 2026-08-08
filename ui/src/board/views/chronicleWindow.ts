/**
 * chronicleWindow — the arithmetic behind Chronicle's continuous scroll.
 *
 * Cail: "scroll to change the date range in a pretty continuous way." Scrolling
 * near an edge grows the day window rather than stopping at it: a block of past
 * days is PREPENDED at the left edge, a smaller block APPENDED at the right,
 * and the timeline keeps going until it hits a cap.
 *
 * PURE, AND DELIBERATELY SO. Every function here takes numbers and civil-day
 * strings and returns numbers and civil-day strings. Nothing reads the DOM,
 * nothing reads the clock, nothing fetches. That is what lets the two properties
 * this feature lives or dies by be tested without a browser:
 *
 *   NO VISUAL JUMP — prepending days pushes existing content right by exactly
 *     `added × dayWidthPx`, so `scrollLeft` must grow by the same amount in the
 *     same frame. Off by one day and the view lurches under the cursor.
 *   NO CORRUPTED JOINS — prepending SHIFTS EVERY EXISTING INDEX. Chronicle
 *     keys its rows, cycle bands and drag draft by day index, so any index held
 *     across an extension is silently wrong afterwards, pointing a fortnight off.
 *     See {@link shiftIndex}.
 *
 * WHAT A DAY IS HERE. The same 6am→6am rail the rest of the board uses
 * (`railCivilDay` in ../civilDay.ts). A chunk's instants are real local 6am
 * boundaries, so a DST day inside a chunk is 23 or 25 hours and the chunk is
 * that much longer — never `days × 86_400_000`.
 */

import { civilDayToLocalDate, isoDayLocal, railCivilDay } from '../civilDay.js'

// ── Shape ────────────────────────────────────────────────────────────────────

/** A contiguous run of civil days, inclusive at both ends. */
export interface DayWindow {
  first: string
  last: string
  /** Day count, both ends included. `first === last` is a window of 1. */
  length: number
}

/** How far the timeline may reach. A year of history is more than anyone
 *  scrolls; eight weeks ahead is past every standing role's next firing. */
export const MAX_PAST_DAYS = 365
export const MAX_FUTURE_DAYS = 56

/** How close to an edge (in day-widths) starts an extension. Three is enough
 *  warning to land the new block before the edge is actually reached. */
export const EDGE_TRIGGER_DAYS = 3

/** Past grows in fortnight-pairs; the future grows in halves of that. History
 *  is what gets scrolled through, so it is worth fetching in bulk; the future
 *  is thin and mostly empty, and a big block there buys nothing. */
export const PAST_BLOCK_DAYS = 28
export const FUTURE_BLOCK_DAYS = 14

/** Civil days per activity chunk. Matches the past block so a single scroll
 *  gesture usually costs exactly one request. */
export const CHUNK_DAYS = 28

/** The rail's opening hour — the same dawn boundary `railCivilDay` defaults to
 *  and the same one Chronicle folds its buckets on. */
export const RAIL_START_HOUR = 6

/** Rounding applied to the live chunk's right edge. Coarser than the poll on
 *  purpose: an uncapped or per-poll `to` mints a fresh entry in the fetcher's
 *  memo every single poll, so the cache never hits and never evicts. */
export const LIVE_QUANTUM_MS = 5 * 60_000

// ── Civil-day arithmetic ─────────────────────────────────────────────────────
//
// Strides go through a NOON anchor, because midnight is the one wall-clock time
// a spring-forward day can lack. Differences go through UTC parsing, which is
// exact for civil days precisely because no zone enters either side.

function noonOn(day: string): Date | undefined {
  const d = civilDayToLocalDate(day)
  if (!d) return undefined
  d.setHours(12, 0, 0, 0)
  return d
}

/** The civil day `delta` calendar days from `day`. */
export function addDays(day: string, delta: number): string {
  const d = noonOn(day)
  if (!d) return day
  d.setDate(d.getDate() + delta)
  return isoDayLocal(d.getTime())
}

/**
 * Whole days from `from` to `to`, signed. Both sides are parsed as UTC, so the
 * subtraction is a pure calendar difference with no zone and no DST in it —
 * the one place `/ 86_400_000` is not a bug.
 */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

/** A window from its two ends. */
export function windowOf(first: string, last: string): DayWindow {
  return { first, last, length: Math.max(0, daysBetween(first, last) + 1) }
}

/** The furthest the window may ever reach, measured from the rail's today. */
export function windowLimits(nowMs: number): { earliest: string; latest: string } {
  const today = railCivilDay(nowMs, RAIL_START_HOUR)
  return { earliest: addDays(today, -MAX_PAST_DAYS), latest: addDays(today, MAX_FUTURE_DAYS) }
}

// ── Extension ────────────────────────────────────────────────────────────────

/** What the scroller looks like right now. The only DOM this module knows
 *  about, and it arrives as four numbers. */
export interface ScrollProbe {
  scrollLeft: number
  clientWidth: number
  scrollWidth: number
  /** Chronicle's fitted column width. Zero before the first measure. */
  dayWidthPx: number
}

export interface ExtensionPlan {
  side: 'past' | 'future'
  /** Days actually added — fewer than a full block when a cap intervenes. */
  added: number
  /** The window after the extension. */
  next: DayWindow
  /**
   * Pixels to ADD to `scrollLeft`, in the same frame the days are inserted.
   * Non-zero only when prepending: new content to the left of the viewport
   * displaces everything right, and this cancels it exactly.
   */
  scrollDelta: number
  /**
   * How far every pre-existing day index moves. Equals `added` on a prepend and
   * zero on an append. Feed any retained index through {@link shiftIndex}.
   */
  indexShift: number
}

/**
 * Decide whether this scroll position should grow the window, and by how much.
 *
 * Null means "leave it alone" — not near an edge, already at a cap, or the
 * column width has not been measured yet (extending against a zero width would
 * compute a zero scroll compensation and jump).
 */
export function planExtension(
  window: DayWindow,
  probe: ScrollProbe,
  nowMs: number,
): ExtensionPlan | null {
  if (probe.dayWidthPx <= 0 || window.length <= 0) return null
  const trigger = EDGE_TRIGGER_DAYS * probe.dayWidthPx
  const { earliest, latest } = windowLimits(nowMs)

  if (probe.scrollLeft <= trigger) {
    const room = daysBetween(earliest, window.first)
    const added = Math.min(PAST_BLOCK_DAYS, Math.max(0, room))
    if (added > 0) {
      return {
        side: 'past',
        added,
        next: windowOf(addDays(window.first, -added), window.last),
        scrollDelta: added * probe.dayWidthPx,
        indexShift: added,
      }
    }
  }

  const distanceToRight = probe.scrollWidth - (probe.scrollLeft + probe.clientWidth)
  if (distanceToRight <= trigger) {
    const room = daysBetween(window.last, latest)
    const added = Math.min(FUTURE_BLOCK_DAYS, Math.max(0, room))
    if (added > 0) {
      return {
        side: 'future',
        added,
        next: windowOf(window.first, addDays(window.last, added)),
        // Appending happens to the right of everything already rendered, so
        // nothing the viewer is looking at moves.
        scrollDelta: 0,
        indexShift: 0,
      }
    }
  }

  return null
}

/**
 * Move a day index across an extension.
 *
 * THE TRAP THIS EXISTS FOR: a prepend inserts days at position 0, so index 12
 * afterwards names a day 28 columns later than it did before. Chronicle holds
 * indices in at least its drag draft (`fromIdx`/`toIdx`) and its cycle bands
 * (`startIdx`/`endIdx`); every one of them is wrong the instant the window
 * grows leftward, and wrong quietly — the band simply lands on the wrong
 * fortnight.
 *
 * The better fix, where a call site can take it, is to hold the CIVIL DAY and
 * look the index up again: a day survives any extension untouched, which is
 * the whole reason the rest of the board keys by civil day. Use this for state
 * that genuinely must stay numeric.
 */
export function shiftIndex(index: number, plan: ExtensionPlan | null): number {
  if (!plan) return index
  return index + plan.indexShift
}

/** {@link shiftIndex} for an inclusive index span — a cycle band, a drag draft. */
export function shiftSpan<T extends { startIdx: number; endIdx: number }>(
  span: T,
  plan: ExtensionPlan | null,
): T {
  if (!plan || plan.indexShift === 0) return span
  return { ...span, startIdx: span.startIdx + plan.indexShift, endIdx: span.endIdx + plan.indexShift }
}

/** The index a civil day sits at within a window, or null when outside it.
 *  The extension-proof way to hold a position. */
export function indexOfDay(window: DayWindow, day: string): number | null {
  const offset = daysBetween(window.first, day)
  return offset >= 0 && offset < window.length ? offset : null
}

/** The civil day at an index, or null when out of range. */
export function dayAtIndex(window: DayWindow, index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index >= window.length) return null
  return addDays(window.first, index)
}

// ── Chunked activity ─────────────────────────────────────────────────────────

export interface ActivityChunk {
  /** Stable identity — the same span always produces the same key, however the
   *  window grew to contain it. This is what makes the fetcher's memo hit. */
  key: string
  /** First and last civil day the chunk covers. */
  first: string
  last: string
  /** Local 6am of `first`. */
  fromMs: number
  /** Local 6am after `last`, capped at now for the live chunk. */
  toMs: number
  /** True for the chunk containing now — the only one whose `toMs` moves. */
  live: boolean
}

/** Local 6am on a civil day. */
function railStartMs(day: string): number {
  const d = noonOn(day)
  if (!d) return 0
  d.setHours(RAIL_START_HOUR, 0, 0, 0)
  return d.getTime()
}

/**
 * Which chunk a civil day belongs to.
 *
 * Chunks are laid out on a FIXED grid counted from the epoch, not from the
 * window's own edges. That is the point: a window that grew left in 28-day
 * blocks and one that grew in dribs must agree about where chunk boundaries
 * fall, or the same days get refetched under a different key every time the
 * window changes shape, and the memo never hits.
 */
export function chunkIndexOf(day: string): number {
  return Math.floor(daysBetween('1970-01-01', day) / CHUNK_DAYS)
}

/** The civil-day span of a chunk index. */
export function chunkBounds(chunkIndex: number): { first: string; last: string } {
  const first = addDays('1970-01-01', chunkIndex * CHUNK_DAYS)
  return { first, last: addDays(first, CHUNK_DAYS - 1) }
}

/**
 * The activity requests a window needs, one per chunk it touches.
 *
 * Chunks lying entirely in the future are omitted rather than requested empty —
 * there is nothing there to fetch, and asking would spend a round trip and a
 * cache entry to be told so. The chunk containing now is `live`: its right edge
 * is capped at now rounded UP to {@link LIVE_QUANTUM_MS}, so it re-keys at most
 * every five minutes, while a settled chunk's key never changes at all.
 *
 * A STABLE KEY IS NOT A KEPT ENTRY. TemporalData prunes — entries expire at
 * their TTL and are evicted oldest-first at a ceiling — so a settled chunk's
 * memo entry is gone a minute after it is written even though its key is
 * eternal. What actually makes a chunk cost one request per session is the
 * CALLER's own record of what it has fetched; see {@link pendingChunks} and the
 * `fetched` set it takes. That set is load-bearing, not an optimization.
 */
export function activityChunks(window: DayWindow, nowMs: number): ActivityChunk[] {
  if (window.length <= 0) return []
  const cap = Math.ceil(nowMs / LIVE_QUANTUM_MS) * LIVE_QUANTUM_MS
  const out: ActivityChunk[] = []
  const firstChunk = chunkIndexOf(window.first)
  const lastChunk = chunkIndexOf(window.last)

  for (let index = firstChunk; index <= lastChunk; index += 1) {
    const { first, last } = chunkBounds(index)
    const fromMs = railStartMs(first)
    const rawEnd = railStartMs(addDays(last, 1))
    if (fromMs >= cap) continue // wholly in the future — nothing happened there
    const live = cap < rawEnd
    out.push({
      key: `chronicle:${index}${live ? `:${cap}` : ''}`,
      first,
      last,
      fromMs,
      toMs: live ? cap : rawEnd,
      live,
    })
  }
  return out
}

/** Chunks a window needs that have not been requested yet, by key. */
export function pendingChunks(
  window: DayWindow,
  nowMs: number,
  fetched: ReadonlySet<string>,
): ActivityChunk[] {
  return activityChunks(window, nowMs).filter((chunk) => !fetched.has(chunk.key))
}
