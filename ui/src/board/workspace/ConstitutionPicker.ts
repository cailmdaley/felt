import type { KanbanCard } from '../KanbanTypes.js'
import { deskCardKey } from '../deskOrdering.js'
import { anchorPopover, type Release } from './anchoredPopover.js'

export interface ConstitutionPickerOptions {
  cards(): KanbanCard[]
  files?(card: KanbanCard): string[]
  current?(card: KanbanCard): boolean
  onOpen(card: KanbanCard): void
  /** Extra results after constitution rows, used only by the desktop bar Find. */
  supplement?: { el: HTMLElement; refresh(query: string): void; close(): void; dispose(): void }
  /** A field the picker reads instead of its own (the board bar's Find), heard only while `active`. */
  find?: HTMLInputElement
  active?(): boolean
  /** Escape on one of the list's rows, where the list reads a shared field: its owner puts the list away. */
  onEscape?(): void
}

/** The word a closed card's row wears: tempered and discarded work is archived, review work awaits the human. */
const CLOSED_STATE: Partial<Record<KanbanCard['column'], string>> = { tempered: 'tempered', composted: 'discarded', awaitingReview: 'awaiting review' }

/** The floating list of constitutions, filtered by Find. */
export class ConstitutionPicker {
  readonly el = document.createElement('div')
  readonly find: HTMLInputElement
  private readonly list = document.createElement('div')
  private previous: HTMLElement | null = null
  private popup = false
  private release: Release | null = null
  private readonly rows = new Map<string, { el: HTMLButtonElement; name: HTMLElement; owner: HTMLElement; card: KanbanCard }>()
  private readonly opts: ConstitutionPickerOptions
  constructor(opts: ConstitutionPickerOptions) {
    this.opts = opts
    this.find = opts.find ?? document.createElement('input')
    this.list.className = 'ws-channel-list'
    if (opts.find) this.el.append(this.list)
    else {
      this.find.className = 'ws-channel-find'
      this.find.type = 'search'
      this.find.placeholder = 'Find a constitution'
      this.find.setAttribute('aria-label', 'Find a constitution')
      this.el.append(this.find, this.list)
    }
    if (opts.supplement) this.list.append(opts.supplement.el)
    this.find.addEventListener('input', this.input)
    document.addEventListener('keydown', this.keydown, true)
    document.addEventListener('pointerdown', this.outside)
  }
  private readonly input = (): void => { if (this.listening) this.refresh() }
  /** An own field always listens; a shared one only while the picker is the one it serves. */
  private get listening(): boolean { return !this.opts.find || (this.opts.active?.() ?? true) }
  focus(): void {
    if (!this.el.contains(document.activeElement) && document.activeElement !== this.find) this.previous = document.activeElement as HTMLElement | null
    this.refresh()
    this.find.focus({ preventScroll: true })
  }
  show(host: HTMLElement, anchor?: HTMLElement): void {
    this.popup = true
    this.el.className = 'ws-menu ws-switcher'
    host.append(this.el)
    this.release?.()
    if (anchor) this.release = anchorPopover(this.el, anchor, { placement: 'below-start', gap: 6, margin: 12 })
    else { this.release = null; this.el.style.left = '12px'; this.el.style.top = '54px' }
    this.focus()
  }
  get isOpen(): boolean { return this.popup && this.el.isConnected }
  close(restore = false): void {
    this.opts.supplement?.close()
    this.release?.(); this.release = null
    if (this.popup) this.el.remove()
    if (restore && this.previous?.isConnected) this.previous.focus({ preventScroll: true })
    this.previous = null
  }
  refresh(): void {
    if (this.listening) this.opts.supplement?.refresh(this.find.value)
    const focused = this.el.contains(document.activeElement) ? document.activeElement as HTMLElement : null
    this.placeRows()
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true })
  }
  private placeRows(): void {
    const cards = [...new Map(this.opts.cards().map(card => [deskCardKey(card), card])).values()]
    const query = this.find.value.trim().toLowerCase()
    const matches = (card: KanbanCard): boolean => !query || [card.name, card.path, ...(this.opts.files?.(card) ?? [])].some(v => v.toLowerCase().includes(query))
    const visible = cards.filter(matches)
    const keys = new Set(visible.map(deskCardKey))
    for (const [key, row] of this.rows) if (!keys.has(key)) { row.el.remove(); this.rows.delete(key) }
    let cursor = this.list.firstChild
    for (const card of visible) {
      const key = deskCardKey(card)
      let row = this.rows.get(key)
      if (!row) {
        const el = document.createElement('button')
        el.type = 'button'
        el.className = 'ws-channel-row'
        const name = document.createElement('span'); name.className = 'ws-channel-name'
        const owner = document.createElement('small')
        el.append(name, owner)
        row = { el, name, owner, card }
        const record = row
        el.addEventListener('click', () => { this.close(); this.opts.onOpen(record.card) })
        this.rows.set(key, row)
      }
      row.card = card
      row.el.dataset.channelUid = card.uid ?? card.id
      row.el.dataset.channelOwner = card.originId
      row.el.setAttribute('aria-label', card.name)
      row.el.setAttribute('aria-current', String(!!this.opts.current?.(card)))
      row.el.title = card.outcome ?? card.path
      if (row.name.textContent !== card.name) row.name.textContent = card.name
      const state = CLOSED_STATE[card.column]
      if (state) row.el.dataset.state = state; else delete row.el.dataset.state
      const owner = state ? `${card.originId} · ${state}` : card.originId
      if (row.owner.textContent !== owner) row.owner.textContent = owner
      if (row.el !== cursor) this.list.insertBefore(row.el, cursor)
      cursor = row.el.nextSibling
    }
  }
  private readonly keydown = (event: KeyboardEvent): void => {
    const mine = this.el.contains(event.target as Node) || (event.target === this.find && this.listening)
    if (!this.el.isConnected || !mine || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.metaKey || event.ctrlKey) return
    // A shared field's owner puts it away on Escape, from the field or from a row.
    if (event.key === 'Escape') {
      if (!this.opts.find) this.close(true)
      else if (event.target === this.find) return
      else this.opts.onEscape?.()
    }
    else if (this.opts.supplement && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const rows = [...this.el.querySelectorAll<HTMLElement>('.ws-channel-row, .ws-search-result button')]
      const at = rows.indexOf(event.target as HTMLElement)
      if (event.key === 'ArrowDown') rows[Math.min(rows.length - 1, at + 1)]?.focus()
      else if (at <= 0) this.find.focus()
      else rows[at - 1]?.focus()
    }
    else if (event.key === 'Enter' && event.target === this.find) {
      if (event.repeat) return
      this.el.querySelector<HTMLElement>('.ws-channel-row')?.click()
    } else return
    event.preventDefault(); event.stopImmediatePropagation()
  }
  private readonly outside = (event: PointerEvent): void => {
    if (this.isOpen && !this.el.contains(event.target as Node) && event.target !== this.find) this.close()
  }
  dispose(): void {
    this.find.removeEventListener('input', this.input)
    this.opts.supplement?.dispose()
    document.removeEventListener('keydown', this.keydown, true)
    document.removeEventListener('pointerdown', this.outside)
    this.el.remove()
    this.rows.clear()
  }
}
