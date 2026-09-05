/**
 * The one mobile contract for the board.
 *
 * "Mobile" here is a viewport shape, not a device: a narrow window on a
 * desktop gets the same treatment as a phone, which keeps the layout
 * testable with nothing but a resized browser. CSS and TS must agree on the
 * threshold, so the number lives here and in the `--kbn-mobile-max` custom
 * property that `KanbanModal.css` declares from the same value; every
 * `@media (max-width: 700px)` in the board is this constant.
 *
 * `coarsePointer()` is a separate question — whether the primary input is a
 * finger — used only where the interaction, not the layout, must change
 * (drag-and-drop has no touch backend; tap targets need 44px).
 */
export const MOBILE_MAX_PX = 700;
export const MOBILE_MEDIA = `(max-width: ${MOBILE_MAX_PX}px)`;

export function isMobileViewport(win: Pick<Window, 'matchMedia'> = window): boolean {
  return win.matchMedia?.(MOBILE_MEDIA)?.matches ?? false;
}

export function coarsePointer(win: Pick<Window, 'matchMedia'> = window): boolean {
  return win.matchMedia?.('(pointer: coarse)')?.matches ?? false;
}

/** Subscribe to the viewport crossing the mobile threshold; returns unsubscribe. */
export function onMobileChange(fn: (mobile: boolean) => void, win: Window = window): () => void {
  const mq = win.matchMedia(MOBILE_MEDIA);
  const handler = (e: MediaQueryListEvent) => fn(e.matches);
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
