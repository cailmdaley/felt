/**
 * ReaderTabs — the tab set, as arithmetic.
 *
 * Two surfaces on the board now open files into a tabbed window: the fiber
 * detail panel's file viewer (FiberDetailModal) and the Shelf's Reader
 * (views/ShelfReader). The DOM they build is different — one is a column
 * beside a card, the other an overlay over a canvas — but the RULES of a tab
 * set are the same everywhere, and they are the part that is easy to get
 * subtly wrong:
 *
 *   OPENING an already-open file activates its tab. It never adds a second.
 *     A file opened twice is one file you looked at twice.
 *   ORDER IS OPEN-ORDER. Activating does not reorder; a tab strip that
 *     resorted itself on every click would move the target out from under the
 *     next click.
 *   CLOSING the active tab falls to its NEIGHBOUR — the one that slid into
 *     its place, or the one before it if it was last. Not "the first", which
 *     throws the reader back to the top of a long strip.
 *
 * So they live here, as pure functions over `{ tabs, active }`, with the DOM
 * left entirely to the caller: `openTab` takes a factory and calls it only on
 * a genuine miss, which is exactly the dedupe rule expressed as control flow.
 *
 * No DOM, no storage — `coerceTabRefs` is the one concession to persistence,
 * and it only reads a parsed record.
 */

/** The one thing a tab must have: the file it stands for. */
export interface TabLike {
  path: string
}

/** A tab set: the open tabs in stable open-order, and which one is shown. */
export interface TabState<T extends TabLike> {
  tabs: readonly T[]
  active: string | null
}

export function emptyTabState<T extends TabLike>(): TabState<T> {
  return { tabs: [], active: null }
}

export function findTab<T extends TabLike>(state: TabState<T>, path: string): T | null {
  return state.tabs.find((t) => t.path === path) ?? null
}

/**
 * Open `path`, and make it active.
 *
 * `make` builds the entry — it is called ONLY when the path is not already
 * open, which is where the never-duplicate rule actually lives. `created`
 * tells the caller whether it needs to mount anything.
 */
export function openTab<T extends TabLike>(
  state: TabState<T>,
  path: string,
  make: () => T,
): { state: TabState<T>; entry: T; created: boolean } {
  const existing = findTab(state, path)
  if (existing) {
    return { state: { tabs: state.tabs, active: path }, entry: existing, created: false }
  }
  const entry = make()
  return { state: { tabs: [...state.tabs, entry], active: path }, entry, created: true }
}

/** Show an already-open tab. A path that isn't open leaves the set alone —
 *  activation is not a way to open something. */
export function activateTab<T extends TabLike>(state: TabState<T>, path: string): TabState<T> {
  if (!findTab(state, path)) return state
  return { tabs: state.tabs, active: path }
}

/**
 * Close one tab. Returns the entry that left (so the caller can unmount its
 * DOM) and the set that remains, with the active tab moved to the neighbour
 * if the closed one was the one being read.
 */
export function closeTab<T extends TabLike>(
  state: TabState<T>,
  path: string,
): { state: TabState<T>; closed: T | null } {
  const index = state.tabs.findIndex((t) => t.path === path)
  if (index < 0) return { state, closed: null }
  const closed = state.tabs[index]
  const tabs = state.tabs.filter((_, i) => i !== index)
  const active =
    state.active === path ? (tabs[index] ?? tabs[index - 1])?.path ?? null : state.active
  return { state: { tabs, active }, closed }
}

// ── Persistence shape ────────────────────────────────────────────────────────

/**
 * A tab as it survives a reload: the file, the label it was shown under, and
 * the reading state (scroll offset, zoom) that makes reopening a continuation
 * rather than a restart.
 */
export interface TabRef {
  path: string
  basename?: string
  /** The daemon that holds the bytes. A path alone does not identify a remote
   *  file, so a rehydrated tab that dropped this would read the wrong host's
   *  copy — or nothing. */
  host?: string
  scroll?: number
  zoom?: number
}

/**
 * Coerce a parsed `open` array into tab refs — field by field, dropping
 * anything pathless. A half-written store is a Reader with fewer tabs, never
 * a Reader that fails to open.
 */
export function coerceTabRefs(raw: unknown): TabRef[] {
  if (!Array.isArray(raw)) return []
  const out: TabRef[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (typeof rec.path !== 'string' || !rec.path) continue
    const ref: TabRef = { path: rec.path }
    if (typeof rec.basename === 'string' && rec.basename) ref.basename = rec.basename
    if (typeof rec.host === 'string' && rec.host) ref.host = rec.host
    if (typeof rec.scroll === 'number' && Number.isFinite(rec.scroll)) ref.scroll = rec.scroll
    if (typeof rec.zoom === 'number' && Number.isFinite(rec.zoom) && rec.zoom > 0) {
      ref.zoom = rec.zoom
    }
    out.push(ref)
  }
  // The same path twice in a store is the duplicate bug written to disk —
  // rehydrating it would reintroduce what openTab exists to prevent.
  const seen = new Set<string>()
  return out.filter((ref) => (seen.has(ref.path) ? false : (seen.add(ref.path), true)))
}
