/**
 * The one mobile contract for the board.
 *
 * "Mobile" here is a viewport SHAPE, not a device, and the shape has two
 * faces. A narrow viewport is the obvious one: a phone held upright, or a
 * narrow window on a desktop, which keeps the layout testable with nothing
 * but a resized browser. The second face is the one that caught us out — a
 * phone turned on its side is 874x402, comfortably WIDER than any width
 * threshold, and yet it has less room top-to-bottom than any laptop ever has.
 * Treating that as a desktop gave it the desktop's stacked chrome and left a
 * third of the screen for the work.
 *
 * So the threshold is a disjunction: too narrow, OR too short AND held in a
 * hand. `(pointer: coarse)` is what keeps a short desktop window — someone
 * who dragged their browser flat, with a mouse and a whole screen behind it —
 * out of the phone layout, where it would be an insult rather than a help.
 *
 * CSS and TS must agree, so the numbers live here and every
 * `@media (max-width: 700px), (max-height: 500px) and (pointer: coarse)` in
 * the board is this expression written out by hand (media queries cannot read
 * a custom property). `test/mobileMedia.test.ts` fails the suite if a
 * stylesheet drifts from it.
 *
 * `coarsePointer()` stays a separate question — whether the primary input is a
 * finger — used only where the interaction, not the layout, must change
 * (drag-and-drop has no touch backend; tap targets need 44px; there is no
 * wheel to zoom a PDF with).
 */
export const MOBILE_MAX_PX = 700
/** A viewport shorter than this, under a finger, is a phone on its side. */
export const MOBILE_SHORT_MAX_PX = 500

/** The short-and-handheld half of the contract, on its own — the layouts that
 *  must additionally give up vertical chrome key off this. */
export const SHORT_MEDIA = `(max-height: ${MOBILE_SHORT_MAX_PX}px) and (pointer: coarse)`
export const MOBILE_MEDIA = `(max-width: ${MOBILE_MAX_PX}px), ${SHORT_MEDIA}`

export function isMobileViewport(win: Pick<Window, 'matchMedia'> = window): boolean {
  return win.matchMedia?.(MOBILE_MEDIA)?.matches ?? false
}

/** True on a hand-held viewport with no room to spare vertically — the phone
 *  in landscape. Always also `isMobileViewport()`. */
export function isShortViewport(win: Pick<Window, 'matchMedia'> = window): boolean {
  return win.matchMedia?.(SHORT_MEDIA)?.matches ?? false
}

export function coarsePointer(win: Pick<Window, 'matchMedia'> = window): boolean {
  return win.matchMedia?.('(pointer: coarse)')?.matches ?? false
}

/** Subscribe to the viewport crossing the mobile threshold; returns unsubscribe.
 *
 *  A rotation crosses it in BOTH directions at once (width grows past 700 as
 *  height falls under 500), which a single `matchMedia` on the disjunction
 *  reports as no change at all — the list still matches, so no `change` event
 *  fires and the board never re-renders into the landscape shape. So each half
 *  is watched separately and the caller is told the resolved answer. */
export function onMobileChange(fn: (mobile: boolean) => void, win: Window = window): () => void {
  const lists = [win.matchMedia(`(max-width: ${MOBILE_MAX_PX}px)`), win.matchMedia(SHORT_MEDIA)]
  const handler = (): void => fn(lists.some((mq) => mq.matches))
  for (const mq of lists) mq.addEventListener('change', handler)
  return () => {
    for (const mq of lists) mq.removeEventListener('change', handler)
  }
}
