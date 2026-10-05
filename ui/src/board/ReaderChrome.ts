import './ReaderWindow.css'

/**
 * ReaderChrome — the floating reader window's DOM.
 *
 * `ReaderTabs` is the tab set as arithmetic and leaves the DOM to its caller.
 * This module builds the window, its tab buttons and its view cells as bare
 * elements with no listeners, styled by `ReaderWindow.css`; the reader binds
 * its own click and close behaviour.
 */

/** The tab button, with its name span and close button already inside. The
 *  close button is handed back separately because it takes its own listener —
 *  and must stop the click reaching the tab under it. */
export function buildTabButton(
  basename: string,
  fullPath: string,
): { tab: HTMLElement; closeBtn: HTMLElement } {
  const tab = document.createElement('button')
  tab.type = 'button'
  tab.className = 'kbn-detail-tab'
  tab.setAttribute('role', 'tab')
  tab.title = fullPath

  const name = document.createElement('span')
  name.className = 'kbn-detail-tab-name'
  name.textContent = basename

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'kbn-detail-tab-close'
  closeBtn.setAttribute('aria-label', `Close ${basename}`)
  closeBtn.textContent = '✕'

  tab.append(name, closeBtn)
  return { tab, closeBtn }
}

/** The cell one file is drawn in. Inactive on birth: only the active tab's
 *  cell is shown, and a tab is not active until `setActive` says so. */
export function buildViewCell(): HTMLElement {
  const cell = document.createElement('div')
  cell.className = 'kbn-detail-view-cell'
  showCell(cell, false)
  return cell
}

/**
 * Make a view cell the shown one, or put it away.
 *
 * `hidden` marks an inactive cell, but the stylesheet does not take it out of
 * view: it stays rendered underneath the active cell, which covers it. A PDF
 * viewer that the browser is told is hidden — by `display` or `visibility`
 * alike — drops its scroll position and paint in WebKit, and the page cannot
 * read or restore a PDF's position itself. Since the covered cell is still
 * rendered, `inert` is what keeps focus, clicks and assistive technology out
 * of it.
 */
export function showCell(cell: HTMLElement, on: boolean): void {
  cell.hidden = !on
  cell.inert = !on
}

/**
 * The floating file-reader window used by ShelfReader.
 *
 * Its element tree uses `.kbn-detail-overlay` as the frame and the
 * file-viewer modifier for a flex column: a chrome bar that is also the tab
 * strip, then the full-bleed view area. A trailing ✕, pinned right of the
 * horizontally-scrolling tabs, closes the reader.
 *
 * Handed back with NO listeners and nothing else appended: the close handler,
 * any extra bar buttons (insert them before `closeBtn`), the wheel-zoom and
 * the geometry are the parts that genuinely differ, and stay with the caller.
 */
export function buildReaderWindow(opts: {
  ariaLabel: string
  /** An extra modifier class on the frame, for a reader whose stylesheet
   *  narrows the shared one. */
  extraClass?: string
  closeLabel: string
  closeTitle: string
}): {
  win: HTMLElement
  bar: HTMLElement
  tabs: HTMLElement
  closeBtn: HTMLElement
  views: HTMLElement
} {
  const win = document.createElement('div')
  win.className = 'kbn-detail-overlay kbn-fileview-window'
  if (opts.extraClass) win.classList.add(opts.extraClass)
  win.setAttribute('role', 'dialog')
  win.setAttribute('aria-label', opts.ariaLabel)

  const bar = document.createElement('div')
  bar.className = 'kbn-fileview-bar'

  const tabs = document.createElement('div')
  tabs.className = 'kbn-detail-tabstrip'
  tabs.setAttribute('role', 'tablist')

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'kbn-fileview-win-close'
  closeBtn.setAttribute('aria-label', opts.closeLabel)
  closeBtn.title = opts.closeTitle
  closeBtn.textContent = '\u00d7'

  bar.append(tabs, closeBtn)

  const views = document.createElement('div')
  views.className = 'kbn-detail-views'

  win.append(bar, views)
  return { win, bar, tabs, closeBtn, views }
}

/** The zoom cluster: − , FIT , + , and a percentage that says where you are.
 *
 *  Built bare, like everything else here — `installTouchZoom` in `ReaderZoom`
 *  binds it. It exists for the finger: a mouse has Cmd-wheel, which is a
 *  better gesture than any three buttons, so the cluster is only mounted on a
 *  coarse pointer and the wide board never sees it. */
export function buildZoomBar(): {
  bar: HTMLElement
  out: HTMLElement
  fit: HTMLElement
  plus: HTMLElement
  minus: HTMLElement
} {
  const bar = document.createElement('div')
  bar.className = 'kbn-reader-zoom'

  const btn = (label: string, aria: string, cls: string): HTMLElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `kbn-reader-zoom-btn ${cls}`
    b.setAttribute('aria-label', aria)
    b.textContent = label
    return b
  }

  const minus = btn('−', 'Zoom out', 'kbn-reader-zoom-out')
  // "FIT" rather than a glyph: every icon for this means something else to
  // somebody, and the word is two characters wider than the arrows nobody
  // agrees on.
  const fit = btn('FIT', 'Fit the whole page', 'kbn-reader-zoom-fit')
  const plus = btn('+', 'Zoom in', 'kbn-reader-zoom-in')

  const out = document.createElement('span')
  out.className = 'kbn-reader-zoom-pct'
  out.textContent = '100%'

  bar.append(minus, fit, plus, out)
  return { bar, out, fit, plus, minus }
}
