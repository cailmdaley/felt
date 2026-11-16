/**
 * The Desk's pager, kept as pure functions.
 *
 * The three columns become a horizontal pager below `MOBILE_MAX_PX` (see
 * `mobile.ts`). Which leaf you are looking at is derived from the scroller's
 * own `scrollLeft` rather than tracked as separate state — the scroll position
 * IS the state, and momentum scrolling means nothing else can stay honest.
 */

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
