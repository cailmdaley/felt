/**
 * ViewPage — the parchment scaffold every temporal view is built on.
 *
 * A view page is one sheet: an illuminated title in the board's column-title
 * hand, a hairline under it, then the view's own body. Views own their body
 * and nothing else, so the four pages sit at the same optical margin and wear
 * the same head. Styles live in ./views.css.
 */

import { appendCappedText } from '../KanbanSurfaces.js'

export interface ViewPage {
  /** The page root — append this to the host you were handed. */
  root: HTMLElement
  /** Where the view puts its content. Empty on creation. */
  body: HTMLElement
  /** The title row, for a view that wants to hang controls off its right edge. */
  titleRow: HTMLElement
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
  titleRow.append(heading)

  const body = document.createElement('div')
  body.className = 'kbn-view-body'

  root.append(titleRow, body)
  return { root, body, titleRow }
}

/**
 * The board's empty-state marginal line, sized for a full page rather than a
 * column. The fleurons are drawn by CSS (`.kbn-view-empty::before/::after`),
 * matching `.kbn-empty` in KanbanModal.css — pass the text alone.
 */
export function createViewEmptyState(text = '— not yet inked —'): HTMLElement {
  const el = document.createElement('div')
  el.className = 'kbn-view-empty'
  el.textContent = text
  return el
}
