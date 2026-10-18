import { DESK_REGION_SELECTORS, type KeyIntent } from './keymap.js'
import { isMobileViewport } from './mobile.js'
import { folioScrollTarget } from './deskMobile.js'

export interface DeskAddress { uid: string; origin: string }
const identity = (el: HTMLElement): DeskAddress => ({ uid: el.dataset.cardUid!, origin: el.dataset.cardOrigin! })
const matches = (el: HTMLElement, address: DeskAddress): boolean => el.dataset.cardUid === address.uid && el.dataset.cardOrigin === address.origin
const behavior = (): ScrollBehavior => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'

/** Selection belongs to card identity, not a DOM node or a feed position. */
export class DeskKeyboard {
  private selected: DeskAddress | null = null
  private revealFrame = 0
  private root: HTMLElement
  private open: (address: DeskAddress) => void
  constructor(root: HTMLElement, open: (address: DeskAddress) => void) {
    this.root = root
    this.open = open
    root.addEventListener('click', this.onClick, true)
  }
  dispose(): void { cancelAnimationFrame(this.revealFrame); this.root.removeEventListener('click', this.onClick, true) }
  get selection(): DeskAddress | null { return this.selected }
  /** The row drawn for the selection, when one is on the Desk. */
  get selectedRow(): HTMLElement | null { return this.node() ?? null }

  /** The reader's column is exactly the Desk's navigable order, including expanded queues. */
  columnFor(address: DeskAddress): HTMLElement[] {
    return this.regions().find(region => region.some(el => matches(el, address))) ?? []
  }

  /** Restore focus without adding every card to the tab sequence. */
  focusSelection(): boolean {
    const el = this.node()
    if (!el) return false
    if (!el.hasAttribute('tabindex') && el.tabIndex < 0) el.tabIndex = -1
    el.focus({ preventScroll: true })
    return document.activeElement === el
  }

  private regions(): HTMLElement[][] {
    return DESK_REGION_SELECTORS.map(selector => [...this.root.querySelectorAll<HTMLElement>(`${selector} [data-card-uid]`)]
      .filter(el => !el.closest('[hidden]') || el.matches('.kbn-cluster-item[hidden]')))
      .filter(region => region.length > 0)
  }
  private node(): HTMLElement | undefined {
    return this.selected ? this.regions().flat().find(el => matches(el, this.selected!)) : undefined
  }
  select(address: DeskAddress, scroll = true): void {
    this.selected = address
    this.refresh(scroll)
  }
  clear(): void { this.selected = null; this.refresh() }

  /** Repaint after a poll, reopening the selected member's stack or cluster. */
  refresh(scroll = false): void {
    for (const el of this.root.querySelectorAll('.kbn-key-selected')) {
      el.classList.remove('kbn-key-selected')
      el.removeAttribute('aria-current')
    }
    const el = this.selected ? [...this.root.querySelectorAll<HTMLElement>('[data-card-uid]')].find(node => matches(node, this.selected!)) : undefined
    if (!el) return
    const queue = el.closest<HTMLElement>('.kbn-card-queued-list[hidden]')
    if (queue) {
      queue.hidden = false
      queue.parentElement?.querySelector('.kbn-card-queued')?.setAttribute('aria-expanded', 'true')
    }
    if (el.matches('.kbn-cluster-item[hidden]')) el.parentElement?.querySelector<HTMLButtonElement>('.kbn-cluster-more')?.click()
    el.classList.add('kbn-key-selected')
    el.setAttribute('aria-current', 'true')
    if (scroll) this.reveal(el)
  }

  handle(intent: KeyIntent): boolean {
    if (intent === 'back') { this.clear(); return true }
    const regions = this.regions()
    if (!regions.length) return false
    const current = this.node()
    const initial = ['awaitingReview', 'inFlight', 'drafts'].map(kind =>
      regions.findIndex(region => region[0].closest(`[data-column="${kind}"]`))).find(index => index >= 0) ?? 0
    let column = current ? regions.findIndex(region => region.includes(current)) : initial
    let row = current ? regions[column].indexOf(current) : 0
    if (intent === 'open') {
      if (!this.selected || !current) return false
      this.open(this.selected)
      return true
    }
    if (!['left', 'right', 'up', 'down', 'first', 'last'].includes(intent)) return false
    if (current) {
      if (intent === 'left' || intent === 'right') column = Math.max(0, Math.min(regions.length - 1, column + (intent === 'left' ? -1 : 1)))
      if (intent === 'up' || intent === 'down') row += intent === 'up' ? -1 : 1
    }
    if (intent === 'first') row = 0
    if (intent === 'last') row = regions[column].length - 1
    const target = regions[column][Math.max(0, Math.min(regions[column].length - 1, row))]
    this.select(identity(target))
    this.focusSelection()
    return true
  }

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement
    const el = target.closest<HTMLElement>('[data-card-uid]')
    if (el && this.root.contains(el)) this.select(identity(el), false)
  }

  private reveal(el: HTMLElement): void {
    cancelAnimationFrame(this.revealFrame)
    this.revealFrame = 0
    if (isMobileViewport()) { this.revealPlaced(el); return }
    const address = identity(el)
    this.revealFrame = requestAnimationFrame(() => {
      this.revealFrame = 0
      if (this.selected?.uid !== address.uid || this.selected.origin !== address.origin) return
      const current = this.node()
      if (current) this.revealPlaced(current)
    })
  }

  private revealPlaced(el: HTMLElement): void {
    const motion = behavior()
    if (isMobileViewport()) {
      const band = el.closest<HTMLElement>('.kbn-band-folded')
      band?.querySelector<HTMLElement>('.kbn-bandhead')?.click()
      const column = el.closest<HTMLElement>('[data-column]')
      const board = column?.parentElement
      if (board && column) {
        const index = [...board.children].indexOf(column)
        board.scrollTo?.({ left: folioScrollTarget(index, board.clientWidth, 3), behavior: motion })
      }
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: motion })
      return
    }
    const rect = el.getBoundingClientRect()
    let visible = rect.height > 0 && rect.width > 0 && rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth
    for (let parent = el.parentElement; visible && parent; parent = parent.parentElement) {
      const clipsY = parent.scrollHeight > parent.clientHeight && /auto|scroll|hidden/.test(getComputedStyle(parent).overflowY)
      const clipsX = parent.scrollWidth > parent.clientWidth && /auto|scroll|hidden/.test(getComputedStyle(parent).overflowX)
      if (!clipsY && !clipsX) continue
      const bounds = parent.getBoundingClientRect()
      const scaleY = parent.offsetHeight ? bounds.height / parent.offsetHeight : 1
      const scaleX = parent.offsetWidth ? bounds.width / parent.offsetWidth : 1
      const top = bounds.top + parent.clientTop * scaleY, left = bounds.left + parent.clientLeft * scaleX
      visible = (!clipsY || rect.top >= top && rect.bottom <= top + parent.clientHeight * scaleY)
        && (!clipsX || rect.left >= left && rect.right <= left + parent.clientWidth * scaleX)
    }
    if (!visible) el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: motion })
  }
}
