/**
 * shelfPromote — which card, if any, has stopped being a tile.
 *
 * The board's zoom is one transform on one surface, which scales a card's
 * chrome, its text and the document inside its frame together. That is exactly
 * right while you are looking at a wall of thumbnails and exactly wrong once
 * you have zoomed until a single report fills the screen: what you get then is
 * a 225px-wide page drawn enormous, not a page. Every line is huge, the column
 * measure is still 225px, and reading it means popping it out.
 *
 * So past a threshold ONE card is PROMOTED. Its real DOM box is multiplied by
 * the zoom and its own transform carries the reciprocal scale, which leaves it
 * on exactly the same rectangle of screen with a composite scale of 1 — its
 * iframe's viewport is genuinely large, and the document reflows and paints at
 * native pixel size. The card is not reparented out of the surface to do this,
 * deliberately: moving an iframe between parents reloads its document, and
 * throwing the page away at the moment you settle down to read it is the one
 * thing this feature must not do.
 *
 * This module is the DECISION only — pure arithmetic over rectangles, no DOM.
 * The consequences live in ShelfView.syncPromotion.
 */

/** A candidate, in SURFACE units: the same coordinates the layout and the pack
 *  speak. The camera is applied here, not by the caller. */
export interface PromoteCandidate {
  key: string
  x: number
  y: number
  w: number
  h: number
  /** Does this card have a document with a layout of its own to reflow? A
   *  `<pre>` of log text and an `<img>` scale exactly as they should under the
   *  camera; promoting one would only make its type SMALLER as you zoomed in. */
  reflows: boolean
}

export interface PromoteView {
  zoom: number
  panX: number
  panY: number
  width: number
  height: number
}

/**
 * When a card stops being a tile and becomes a page.
 *
 * THE BAR IS THE FIT POINT — cover 1, the zoom at which the card has grown to
 * meet the viewport exactly on its tighter axis — and that is a deliberate
 * correction of the first cut, which promoted at 0.6.
 *
 * Cover is measured on the card's WIDEST axis, and a card is a portrait page on
 * a landscape screen, so the height is almost always what the maximum picks up.
 * At 0.6 the card was three fifths of the screen's HEIGHT, which for an A4
 * proportion is barely two fifths of its width: reading mode engaged with the
 * page floating in the middle of a mostly empty screen. Whatever the arithmetic
 * said, that is not "I zoomed in until the card filled the screen", which is
 * the gesture this exists to serve.
 *
 * At cover 1 the promoted box is exactly
 *   min(viewport.w, viewport.h / aspect) × min(viewport.h, viewport.w * aspect)
 * — the page fitted to the screen, pillarboxed rather than stretched, since a
 * portrait page cannot fill a landscape screen without either distorting it or
 * reflowing it to proportions its author never chose. Note that this falls out
 * of the EXISTING geometry rather than being imposed on it: the promoted card
 * still occupies precisely the rectangle the camera would have given it, so
 * there is no jump at the moment of promotion and the page goes on growing
 * past it if you keep zooming. Snapping the box to the viewport instead would
 * buy the same size at the cost of the seam this design exists to avoid.
 *
 * TWO thresholds, not one, and the gap between them is the whole reason these
 * are named constants rather than inline numbers: a single threshold sits
 * exactly where a pinch is slowest and most deliberate, so the card would
 * flicker in and out of reading mode under the reader's own fingers. Promotion
 * takes the higher bar, demotion the lower.
 */
export const PROMOTE_ON = 1
export const PROMOTE_OFF = 0.75

/**
 * How much of a card must actually be on screen to be the one being read — as
 * a fraction of whichever is SMALLER, the card or the viewport.
 *
 * The denominator is the whole subtlety, and getting it wrong is what made the
 * first cut of this never promote anything at all. Measured against the card,
 * a card larger than the screen always scores badly — by the time it is worth
 * promoting it necessarily hangs off every edge — so the test would reject
 * exactly the case it exists to catch. Against the smaller of the two it asks
 * the question that was actually meant: is this card either mostly on screen,
 * or filling most of the screen?
 */
export const PROMOTE_MIN_VISIBLE = 0.4

/**
 * The card to promote, or null.
 *
 * ONE at a time, always. Two would be two documents laid out at full size for
 * no gain — and past the threshold there is by definition no room on screen for
 * a second. The winner is the largest qualifying card, measured by how much of
 * the viewport it covers on its widest axis.
 *
 * `current` is what is promoted now, and it is what makes the hysteresis work:
 * the incumbent is judged against the lower bar, everyone else against the
 * higher one.
 */
export function choosePromotion(
  candidates: readonly PromoteCandidate[],
  view: PromoteView,
  current: string | null,
): string | null {
  if (view.width <= 0 || view.height <= 0 || view.zoom <= 0) return null
  let winner: string | null = null
  let best = 0
  for (const card of candidates) {
    if (!card.reflows) continue
    const w = card.w * view.zoom
    const h = card.h * view.zoom
    if (w <= 0 || h <= 0) continue
    const cover = Math.max(w / view.width, h / view.height)
    const bar = card.key === current ? PROMOTE_OFF : PROMOTE_ON
    if (cover < bar || cover <= best) continue
    const left = view.panX + card.x * view.zoom
    const top = view.panY + card.y * view.zoom
    const seenW = Math.min(left + w, view.width) - Math.max(left, 0)
    const seenH = Math.min(top + h, view.height) - Math.max(top, 0)
    if (seenW <= 0 || seenH <= 0) continue
    const reference = Math.min(w * h, view.width * view.height)
    if ((seenW * seenH) / reference < PROMOTE_MIN_VISIBLE) continue
    winner = card.key
    best = cover
  }
  return winner
}
