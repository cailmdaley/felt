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
