/**
 * The two pieces of state the mobile Desk needs, kept as pure functions so the
 * suite can hold them without a DOM.
 *
 * The Now triad becomes a horizontal pager below `MOBILE_MAX_PX` (see
 * `mobile.ts`). Which leaf you are looking at is derived from the scroller's
 * own `scrollLeft` rather than tracked as separate state — the scroll position
 * IS the state, and momentum scrolling means nothing else can stay honest.
 *
 * The two stacked bands (Pinned, Resting) remember whether they are open. That
 * lives in localStorage, which throws outright in some privacy modes, so every
 * touch of it is wrapped and a failure degrades to the defaults.
 */

export const FOLIO_STORAGE_KEY = 'shuttle.desk.mobile.bands'

/** Which leaf of an n-page pager sits under the viewport, from scroll offset.
 *
 * Rounds to the nearest page rather than flooring: a snap scroller settles
 * within a pixel or two of a boundary, and flooring makes the strip flicker to
 * the previous leaf on the way in. Clamped, because iOS rubber-banding reports
 * offsets past both ends. */
export function activeFolioIndex(
  scrollLeft: number,
  pageWidth: number,
  count: number,
): number {
  if (!(count > 0)) return 0
  if (!(pageWidth > 0) || !Number.isFinite(scrollLeft)) return 0
  const raw = Math.round(scrollLeft / pageWidth)
  return Math.min(count - 1, Math.max(0, raw))
}

/** Where to scroll the pager so leaf `index` lands flush at its left edge. */
export function folioScrollTarget(index: number, pageWidth: number, count: number): number {
  if (!(count > 0) || !(pageWidth > 0)) return 0
  return Math.min(count - 1, Math.max(0, Math.trunc(index))) * pageWidth
}

export type BandId = 'pinned' | 'resting'

export interface BandState {
  pinned: boolean
  resting: boolean
}

/** Pinned is a launcher you reach for; Resting is an archive you go looking
 *  for. So Pinned opens and Resting stays folded until asked. */
export const DEFAULT_BAND_STATE: BandState = { pinned: true, resting: false }

/** Coerce whatever came back out of storage into a BandState. Anything absent
 *  or malformed falls back per-key, so one corrupt field can't lose the other. */
export function parseBandState(raw: string | null): BandState {
  if (!raw) return { ...DEFAULT_BAND_STATE }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_BAND_STATE }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_BAND_STATE }
  const obj = parsed as Record<string, unknown>
  return {
    pinned: typeof obj.pinned === 'boolean' ? obj.pinned : DEFAULT_BAND_STATE.pinned,
    resting: typeof obj.resting === 'boolean' ? obj.resting : DEFAULT_BAND_STATE.resting,
  }
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function storage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function readBandState(store: StorageLike | null = storage()): BandState {
  try {
    return parseBandState(store?.getItem(FOLIO_STORAGE_KEY) ?? null)
  } catch {
    return { ...DEFAULT_BAND_STATE }
  }
}

export function writeBandState(state: BandState, store: StorageLike | null = storage()): void {
  try {
    store?.setItem(FOLIO_STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* private mode, quota, disabled site data — the bands just forget. */
  }
}
