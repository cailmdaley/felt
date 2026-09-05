/**
 * ReaderChrome — the tab strip's DOM, for the readers that share it.
 *
 * `ReaderTabs` is the tab set as arithmetic and leaves the DOM entirely to its
 * callers, which is right: a tab set is rules, not markup. But the two callers
 * turned out to build the SAME markup — the same button, the same name span,
 * the same close glyph, the same hidden view cell — because they share
 * `FiberDetailModal.css`, which is where `.kbn-detail-tab` and
 * `.kbn-detail-view-cell` are styled. Two copies of an element tree whose
 * classes are declared once elsewhere is a copy that will drift.
 *
 * So the tree lives here and the wiring stays with the caller: this module
 * hands back bare elements with no listeners, and each reader binds its own
 * click and close behaviour, which is the part that genuinely differs.
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

/** The cell one file is drawn in. Hidden on birth: only the active tab's cell
 *  is shown, and a tab is not active until `setActive` says so. */
export function buildViewCell(): HTMLElement {
  const cell = document.createElement('div')
  cell.className = 'kbn-detail-view-cell'
  cell.hidden = true
  return cell
}

/**
 * The floating reader window itself — the frame all three readers share.
 *
 * The same element tree, class for class: the card's vellum frame
 * (`.kbn-detail-overlay`) with the file-viewer modifier that lays it out as a
 * flex column, a chrome bar that IS the tab strip (no separate title bar — the
 * tabs are the titles, and the bar's empty areas are the drag handle), and the
 * full-bleed view area under it. A trailing ✕, pinned right of the
 * horizontally-scrolling tabs, closes the whole reader at once.
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
