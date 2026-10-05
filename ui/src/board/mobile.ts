/** Viewport predicates shared by the board's responsive layouts. */
export const MOBILE_MAX_PX = 700
/** The short-and-handheld viewport threshold used for landscape phones. */
export const MOBILE_SHORT_MAX_PX = 500

/** The short-and-handheld half of the mobile viewport contract. */
export const SHORT_MEDIA = `(max-height: ${MOBILE_SHORT_MAX_PX}px) and (pointer: coarse)`
export const MOBILE_MEDIA = `(max-width: ${MOBILE_MAX_PX}px), ${SHORT_MEDIA}`

export function isMobileViewport(win: Pick<Window, 'matchMedia'> = window): boolean {
  return win.matchMedia?.(MOBILE_MEDIA)?.matches ?? false
}

export function coarsePointer(win: Pick<Window, 'matchMedia'> = window): boolean {
  return win.matchMedia?.('(pointer: coarse)')?.matches ?? false
}

/** Subscribe to the mobile viewport predicate; returns unsubscribe. */
export function onMobileChange(fn: (mobile: boolean) => void, win: Window = window): () => void {
  const lists = [win.matchMedia(`(max-width: ${MOBILE_MAX_PX}px)`), win.matchMedia(SHORT_MEDIA)]
  const handler = (): void => fn(lists.some((mq) => mq.matches))
  for (const mq of lists) mq.addEventListener('change', handler)
  return () => {
    for (const mq of lists) mq.removeEventListener('change', handler)
  }
}
