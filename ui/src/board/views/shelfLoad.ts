/**
 * shelfLoad — how many bodies may be alive at once, and whose turn it is.
 *
 * A board card has two layers. The FACE is metadata: a name, a fiber, an age,
 * a glyph for its kind. It is synchronous, costs nothing, and is what a card
 * looks like at rest — never a skeleton shimmer, because a face is not a
 * placeholder for content, it IS content. The BODY is the file itself: an
 * iframe, an image, a page of text. Bodies are expensive and finite.
 *
 * The rule the old board broke: it mounted a body the first time a card came
 * near the viewport and then set a `mounted` flag it never once cleared. Live
 * iframes only accumulated. Scroll a canvas of seventy-five reports and you
 * end up with seventy-five live documents in one tab, each with its own
 * scripts and its own layout, and the surface that was supposed to be
 * skimmable becomes the slowest page on the machine. Bodies must be able to
 * DIE, and something has to decide which.
 *
 * That is this module: two pure decisions, kept away from the DOM so they can
 * be tested as arithmetic rather than as a browser.
 *
 *   chooseLoads      who starts loading now, given free loader slots. Nearest
 *                    to the centre of the viewport goes first, because that is
 *                    where the reader is looking.
 *   chooseEvictions  who gets taken down when there are too many alive. The
 *                    least recently seen goes first, and anything the reader
 *                    is touching is exempt.
 *
 * Eviction is hysteretic on purpose: it triggers at `maxLive` but cuts back to
 * `evictTo`, so a board sitting exactly at the limit does not thrash one body
 * up and down with every scroll of a few pixels.
 */

/** The state of a card's body. `stalled` is a load that has taken long enough
 *  that we say so and offer a retry, rather than leaving a blank rectangle. */
export type BodyState = 'idle' | 'loading' | 'live' | 'stalled'

export const LOAD_POLICY = {
  /** Live bodies allowed before a sweep runs. */
  maxLive: 16,
  /** How far the sweep cuts back — the gap from `maxLive` is the hysteresis. */
  evictTo: 12,
  /** Bodies allowed to be loading at once. Four keeps the connection pool and
   *  the main thread usable while still filling a screen quickly. */
  maxConcurrent: 4,
  /** How long an eviction sweep waits for the surface to settle. */
  sweepMs: 250,
  /** The ring around the viewport inside which a card is worth loading. */
  ring: '300px',
  /** How long before a load is called stalled — generous for a remote origin,
   *  where a multi-megabyte report crosses a tunnel. */
  softTimeoutLocalMs: 8_000,
  softTimeoutRemoteMs: 20_000,
} as const

// ── Who loads next ───────────────────────────────────────────────────────────

export interface LoadCandidate {
  key: string
  /** Distance from the centre of the viewport, in px. */
  distance: number
}

/**
 * Pick the cards to start loading, nearest the reader's eye first.
 *
 * `slots` is what remains of the concurrency budget. Ties break on key so the
 * choice is deterministic — a queue that reorders under equal distances would
 * make the fill order depend on Map iteration, which is a bug you only see
 * once a month.
 */
export function chooseLoads(
  candidates: readonly LoadCandidate[],
  slots: number,
): string[] {
  if (slots <= 0) return []
  return [...candidates]
    .sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key))
    .slice(0, slots)
    .map((c) => c.key)
}

// ── Who dies ─────────────────────────────────────────────────────────────────

export interface EvictCandidate {
  key: string
  /** When this card was last inside the ring (epoch ms). */
  lastVisible: number
  /**
   * Exempt from eviction: on screen, focused, starred, or mid-gesture. Taking
   * down a body the reader can see is the one thing a cache must never do —
   * it would read as the board deleting their work in front of them.
   */
  exempt: boolean
}

/**
 * Pick the bodies to take down, given how many are alive.
 *
 * Returns nothing until the population exceeds `maxLive`; then it cuts to
 * `evictTo`, oldest-unseen first. Exempt cards are never chosen, so a board
 * whose visible cards alone exceed the cap simply runs over the cap — the
 * right failure, since the alternative is unloading what the reader is
 * reading.
 */
export function chooseEvictions(
  candidates: readonly EvictCandidate[],
  policy: { maxLive: number; evictTo: number } = LOAD_POLICY,
): string[] {
  if (candidates.length <= policy.maxLive) return []
  const want = candidates.length - policy.evictTo
  return [...candidates]
    .filter((c) => !c.exempt)
    .sort((a, b) => a.lastVisible - b.lastVisible || a.key.localeCompare(b.key))
    .slice(0, want)
    .map((c) => c.key)
}

// ── Text bodies ──────────────────────────────────────────────────────────────

/**
 * A tiny insertion-ordered cache for text bodies.
 *
 * Text files are fetched as strings rather than framed, so they are cheap to
 * keep and expensive to re-fetch. A Map preserves insertion order, so the
 * oldest entry is the first key — eviction is one `keys().next()`.
 */
export class TextCache {
  private readonly entries = new Map<string, string>()
  private bytes = 0
  private readonly maxBytes: number

  constructor(maxBytes = 5_000_000) {
    this.maxBytes = maxBytes
  }

  get(path: string): string | undefined {
    return this.entries.get(path)
  }

  set(path: string, text: string): void {
    if (this.entries.has(path)) this.delete(path)
    this.entries.set(path, text)
    this.bytes += text.length
    while (this.bytes > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
  }

  private delete(path: string): void {
    const prior = this.entries.get(path)
    if (prior === undefined) return
    this.bytes -= prior.length
    this.entries.delete(path)
  }

  get size(): number {
    return this.entries.size
  }
}

// ── The visible window ───────────────────────────────────────────────────────

/**
 * The most recent `limit` files. The board is a working surface, not an
 * archive: past a hundred or so cards nobody is recognising anything, and the
 * cost of every extra card is paid on every layout, every collision solve and
 * every sweep. The window is applied AFTER dedupe, so a file sent twenty times
 * spends one slot.
 */
export function mostRecent<T extends { timestamp: number }>(
  files: readonly T[],
  limit: number,
): T[] {
  if (files.length <= limit) return [...files]
  return [...files].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit)
}

/** How many cards the board will hold at once. */
export const MAX_CARDS = 100

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * Filter the in-memory index by a plain substring of the name or the fiber.
 * Case-insensitive, no fuzz: on a surface you navigate by recognition, a
 * search that guesses is a search that hides the thing you asked for. An empty
 * query is not a filter.
 */
export function matchesQuery(
  file: { basename: string; fullPath: string; uid?: string },
  query: string,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    file.basename.toLowerCase().includes(q) ||
    (file.uid ?? '').toLowerCase().includes(q) ||
    file.fullPath.toLowerCase().includes(q)
  )
}
