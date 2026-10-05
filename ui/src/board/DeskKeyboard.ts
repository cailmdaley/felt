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
  private root: HTMLElement
  private open: (address: DeskAddress) => void
  constructor(root: HTMLElement, open: (address: DeskAddress) => void) {
    this.root = root
    this.open = open
    root.addEventListener('click', this.onClick, true)
  }
  dispose(): void { this.root.removeEventListener('click', this.onClick, true) }
  get selection(): DeskAddress | null { return this.selected }

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
    }
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: motion })
  }
}
