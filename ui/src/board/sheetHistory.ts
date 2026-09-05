/**
 * The phone's back gesture, for a board made of stacked sheets.
 *
 * A full-viewport sheet reads as a page, so the swipe that dismisses a page
 * must dismiss it — otherwise the one instinctive gesture on a phone leaves
 * the board entirely. The mechanism is a pushed history entry per open sheet,
 * given back when the sheet closes.
 *
 * Two things make that harder than it sounds, and both are why this is a
 * state machine with its own tests rather than a pair of calls at the call
 * site:
 *
 *   · A BACK WE ISSUED looks exactly like a back the user pressed. Closing a
 *     sheet calls `history.back()`, whose `popstate` arrives a tick later — by
 *     which time the sheet is long gone and the event, taken at face value,
 *     would close whatever sheet is on top by then. So every back this module
 *     issues is counted and the matching pop is swallowed.
 *
 *   · A SWAP IS NOT A CLOSE. The detail panel is one reused instance whose
 *     `open()` begins by calling `close()`, so opening card B while card A is
 *     up reads as close-then-open. Released and re-pushed, that is a back()
 *     racing a pushState — the queued pop then takes the new panel down with
 *     it. `swap()` marks the layer as staying open across the churn, so the
 *     entry is simply kept and no history call is made at all.
 *
 * LIFO is assumed, and it is what the board does: the card's close takes its
 * followed-reference panel and its file viewer down first, and both Escape and
 * back act on the newest sheet. A layer released out of order gives up its
 * claim without issuing a back — one stale entry beats popping someone else's.
 */

/** The board's three sheet layers, innermost last. Ids rather than an enum so
 *  the stack stays a plain string machine that tests can drive directly. */
export const SHEET_CARD = 'card'
export const SHEET_VIEWER = 'viewer'
export const SHEET_LINKED = 'linked'

export interface SheetHistoryDriver {
  push(): void
  back(): void
}

export class SheetHistory {
  /** Layers holding an entry, oldest first. The last one is the top. */
  private readonly layers: string[] = []
  /** Layers mid-swap: their release is deferred, not performed. */
  private readonly swapping = new Set<string>()
  /** Backs this module issued whose `popstate` has not landed yet. */
  private pendingBacks = 0

  private readonly driver: SheetHistoryDriver

  constructor(driver: SheetHistoryDriver) {
    this.driver = driver
  }

  /** Is this layer currently holding an entry? */
  holds(id: string): boolean {
    return this.layers.includes(id)
  }

  /** How many entries this module believes it is holding. For tests. */
  get depth(): number {
    return this.layers.length
  }

  /**
   * Declare whether this layer should hold a back-entry right now. Idempotent
   * in both directions, which is what lets a caller say it on every open, on
   * every close, and again when the viewport crosses the mobile threshold and
   * a window becomes a sheet (or stops being one).
   */
  set(id: string, held: boolean): void {
    if (held) {
      if (this.layers.includes(id)) return
      this.layers.push(id)
      this.driver.push()
      return
    }
    // A swap's inner close must not release: the same layer is about to be
    // re-opened with different content, and the entry it holds is still the
    // right entry for it.
    if (this.swapping.has(id)) return
    const i = this.layers.indexOf(id)
    if (i < 0) return
    this.layers.splice(i, 1)
    // Only the top can be given back — history has no way to remove an entry
    // from the middle, and issuing a back for a buried layer would pop the
    // sheet above it instead.
    if (i !== this.layers.length) return
    this.pendingBacks += 1
    this.driver.back()
  }

  /**
   * Run a content swap on one layer. Any release inside `fn` is deferred; the
   * layer's entry survives untouched, so no back()/pushState pair is issued and
   * there is no queued pop to race the new content.
   */
  swap<T>(id: string, fn: () => T): T {
    const nested = this.swapping.has(id)
    this.swapping.add(id)
    try {
      return fn()
    } finally {
      if (!nested) this.swapping.delete(id)
    }
  }

  /**
   * A `popstate` landed. Returns the layer the user asked to close, or null
   * when the pop was one this module caused and has already accounted for.
   */
  popped(): string | null {
    if (this.pendingBacks > 0) {
      this.pendingBacks -= 1
      return null
    }
    // The entry is already gone, so the layer must not issue a back of its own
    // on the way out — drop the claim here, before handing the id back.
    return this.layers.pop() ?? null
  }
}

/**
 * The board's one stack. A module singleton because the three sheet layers —
 * the card, its file viewer, the panel of followed references — live in three
 * files and must share one ordering; a stack per file would let each pop the
 * other's entries.
 */
let shared: SheetHistory | null = null
const closers = new Map<string, () => void>()

function sharedHistory(): SheetHistory {
  if (shared) return shared
  shared = new SheetHistory({
    push: () => window.history.pushState({ shuttleSheet: true }, ''),
    back: () => window.history.back(),
  })
  window.addEventListener('popstate', () => {
    const id = shared?.popped()
    if (!id) return
    const close = closers.get(id)
    closers.delete(id)
    close?.()
  })
  return shared
}

/**
 * Declare a sheet layer open (with the closer the back gesture should run) or
 * closed. The single entry point for every sheet on the board.
 */
export function holdSheet(id: string, held: boolean, onBack?: () => void): void {
  if (held && onBack) closers.set(id, onBack)
  else if (!held) closers.delete(id)
  sharedHistory().set(id, held)
}

/** Run a content swap on one layer without releasing its entry. */
export function swapSheet<T>(id: string, fn: () => T): T {
  return sharedHistory().swap(id, fn)
}

/** Test seam: replace the shared stack (and its closers) with a fresh one. */
export function resetSheetHistoryForTest(next: SheetHistory | null): void {
  shared = next
  closers.clear()
}
