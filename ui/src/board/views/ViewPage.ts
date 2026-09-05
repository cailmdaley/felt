/**
 * ViewPage — the parchment scaffold every temporal view is built on.
 *
 * A view page is one sheet: an illuminated title in the board's column-title
 * hand, a hairline under it, then the view's own body. Views fill their body
 * and may hang controls off `titleRow`; the scaffold owns the rest, so every
 * page sits at the same optical margin and wears the same head. Styles live
 * in ./views.css.
 *
 * THE HEAD IS ONE LINE HIGH ON EVERY PAGE. A view with something to say beyond
 * its navigation used to say it on a second row, which made that view's head
 * taller than its siblings' — and paging between Day and Week jogged the whole
 * sheet down and up again. So the scaffold offers a third slot, `titleCenter`,
 * held in the optical middle of the row and taken out of flow, so what it
 * carries can never add height. Marginalia go there; controls stay on the ends.
 */

import { appendCappedText } from '../KanbanSurfaces.js'

export interface ViewPage {
  /** The page root — append this to the host you were handed. */
  root: HTMLElement
  /** Where the view puts its content. Empty on creation. */
  body: HTMLElement
  /** The title row, for a view that wants to hang controls off its right edge. */
  titleRow: HTMLElement
  /**
   * The middle of the title row — centred on the sheet and OUT OF FLOW, so
   * whatever is put here costs the head no height and moves neither end. For a
   * line the page is stating, not a control the reader operates: nothing in
   * here can grow the row, and a long line truncates rather than colliding
   * with its neighbours.
   */
  titleCenter: HTMLElement
}

/**
 * Build an empty page. `title` is set in the illuminated column-title style —
 * its leading letter picks up the layered EBGI F2/F1 dropcap via
 * {@link appendCappedText}, exactly as the Now board's column heads do.
 */
export function createViewPage(title: string): ViewPage {
  const root = document.createElement('section')
  root.className = 'kbn-view-page'
  root.setAttribute('role', 'region')
  root.setAttribute('aria-label', title)

  const titleRow = document.createElement('div')
  titleRow.className = 'kbn-view-titlerow'

  const heading = document.createElement('h2')
  heading.className = 'kbn-view-title'
  appendCappedText(heading, title)
  const titleCenter = document.createElement('div')
  titleCenter.className = 'kbn-view-titlecenter'

  titleRow.append(heading, titleCenter)

  const body = document.createElement('div')
  body.className = 'kbn-view-body'

  root.append(titleRow, body)
  return { root, body, titleRow, titleCenter }
}

/**
 * The stand-in page the CHASSIS renders when a view cannot be given a context —
 * before the first board response, or after a fetch has failed.
 *
 * Built here, in the same idiom as a real view page, so a board that cannot
 * reach its daemon still looks like the board: the illuminated title tells you
 * which page you are on, and the marginal line tells you why it is empty.
 * Previously this state was rendered as literally nothing, which reads as a
 * broken app rather than an unreachable daemon.
 *
 * `onRetry` adds a retry affordance; omit it for the loading state, where there
 * is nothing to retry yet.
 */
export function createViewFallbackPage(
  title: string,
  opts: { message: string; onRetry?: () => void },
): HTMLElement {
  const page = createViewPage(title)
  const note = createViewEmptyState(opts.message)
  page.body.append(note)
  if (opts.onRetry) {
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'kbn-view-retry'
    retry.textContent = 'try again'
    retry.addEventListener('click', () => opts.onRetry?.())
    // Inside the empty-state block so the two read as one centered line of
    // marginalia rather than a message and a detached control.
    note.append(retry)
  }
  return page.root
}

/**
 * The board's empty-state marginal line, sized for a full page rather than a
 * column. The fleurons are drawn by CSS (`.kbn-view-empty::before/::after`),
 * matching `.kbn-empty` in KanbanModal.css — pass the text alone.
 */
export function createViewEmptyState(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'kbn-view-empty'
  el.textContent = text
  return el
}
