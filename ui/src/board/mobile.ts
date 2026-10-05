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
 * The third named form is READER_MEDIA, and it answers a narrower question:
 * does an opened FILE take the whole screen? It does on every mobile viewport,
 * and it also does under any finger at all — which is what brings in a tablet.
 * An iPad is wider than 700px and taller than 500px, so it is not mobile and
 * the Desk and document workspace keep their desktop arrangements there. The
 * floating file reader's desktop form is a window you drag and resize by its
 * edges, a posture built for a mouse; a hand on a tablet reads one document at
 * a time and wants it the size of the glass with one obvious way back. The
 * file reader is therefore the surface whose layout keys off the pointer
 * rather than the shape. Written out, the
 * form is `MOBILE_MEDIA, (pointer: coarse)` with the short-and-coarse face
 * absorbed into the broader `(pointer: coarse)`.
 *
 * So there are three named forms and no others: MOBILE_MEDIA (either face),
 * SHORT_MEDIA (the phone on its side) and READER_MEDIA (mobile, or any
 * finger). CSS and TS must agree, so the numbers live here and every prelude
 * in the board is one of the three written out by hand (media queries cannot
 * read a custom property). `test/mobileMedia.test.ts` fails the suite if a
 * stylesheet drifts from them.
 *
 * `coarsePointer()` stays a separate question — whether the primary input is a
 * finger — used where the interaction, not the layout, must change
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

/** Mobile, or any finger: where an opened file fills the screen. */
export const READER_MEDIA = `(max-width: ${MOBILE_MAX_PX}px), (pointer: coarse)`

export function isMobileViewport(win: Pick<Window, 'matchMedia'> = window): boolean {
  return win.matchMedia?.(MOBILE_MEDIA)?.matches ?? false
}

/** Does the floating file reader take the whole screen as a sheet with one ✕?
 *  True on a phone in either orientation and on a tablet; false on a desktop
 *  unless its window is narrower than a phone. */
export function readerFillsScreen(win: Pick<Window, 'matchMedia'> = window): boolean {
  return win.matchMedia?.(READER_MEDIA)?.matches ?? false
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

/** Subscribe to READER_MEDIA changing; returns unsubscribe. An open reader
 *  reframes on it — a sheet becomes a placed window again, a window becomes a
 *  sheet — because the stylesheet draws the sheet frame only while the query
 *  matches, and a frame decided once at open would fall out of step with it.
 *  Each half is watched on its own, as in `onMobileChange`, and the caller is
 *  told the resolved answer. */
export function onReaderChange(fn: (fills: boolean) => void, win: Window = window): () => void {
  const lists = [win.matchMedia(`(max-width: ${MOBILE_MAX_PX}px)`), win.matchMedia('(pointer: coarse)')]
  const handler = (): void => fn(lists.some((mq) => mq.matches))
  for (const mq of lists) mq.addEventListener('change', handler)
  return () => {
    for (const mq of lists) mq.removeEventListener('change', handler)
  }
}
