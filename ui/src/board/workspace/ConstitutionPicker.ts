import type { KanbanCard } from '../KanbanTypes.js'
import { anchorPopover, type Release } from './anchoredPopover.js'

export interface ConstitutionPickerOptions {
  cards(): KanbanCard[]
  files?(card: KanbanCard): string[]
  current?(card: KanbanCard): boolean
  revealCurrent?: boolean
  renderCard?(card: KanbanCard): HTMLElement
  group?(card: KanbanCard): string | undefined
  /** The retained root, after placement and revision patching, on every refresh. */
  onRow?(el: HTMLElement, card: KanbanCard): void
  onRemove?(el: HTMLElement): void
  /** After every refresh, once rows and captions are placed. */
  onRefresh?(): void
  onOpen(card: KanbanCard): void
  /** A field the picker reads instead of its own (the board bar's Find), heard only while `active`. */
  find?: HTMLInputElement
  active?(): boolean
  /** Escape on one of the list's rows, where the list reads a shared field: its owner puts the list away. */
  onEscape?(): void
}

/** Shared constitution rows and Find behavior for the sidebar and floating picker. */
export class ConstitutionPicker {
  readonly el = document.createElement('div')
  readonly find: HTMLInputElement
  private readonly list = document.createElement('div')
  private previous: HTMLElement | null = null
  private popup = false
  private release: Release | null = null
  private selected: string | null = null
  private revealed: string | null = null
  private readonly rows = new Map<string, { el: HTMLElement; name: HTMLElement; owner: HTMLElement; card: KanbanCard; revision: string }>()
  /** Each group's box: its caption, then its rows, so a sticky caption leaves with its group. */
  private readonly groups = new Map<string, HTMLElement>()
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
    this.find.addEventListener('input', () => { if (this.listening) this.refresh() })
    document.addEventListener('keydown', this.keydown, true)
    document.addEventListener('pointerdown', this.outside)
  }
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
    this.release?.(); this.release = null
    if (this.popup) this.el.remove()
    if (restore && this.previous?.isConnected) this.previous.focus({ preventScroll: true })
    this.previous = null
  }
  refresh(reveal = true): void {
    const identity = (card: KanbanCard): string => JSON.stringify([card.originId, card.uid ?? card.id])
    const cards = [...new Map(this.opts.cards().map(card => [identity(card), card])).values()]
    const current = cards.find(card => this.opts.current?.(card))
    const selected = current ? identity(current) : null
    let query = this.find.value.trim().toLowerCase()
    const matches = (card: KanbanCard): boolean => !query || [card.name, card.path, ...(this.opts.files?.(card) ?? [])].some(v => v.toLowerCase().includes(query))
    // A navigation choice supersedes sidebar Find only when it hides that choice;
    // the visible indicator and Enter's first filtered match must agree.
    if (selected !== this.selected && current && this.opts.revealCurrent && !matches(current)) {
      this.find.value = ''; query = ''
    }
    this.selected = selected
    const visible = cards.filter(matches)
    const keys = new Set(visible.map(identity))
    for (const [key, row] of this.rows) if (!keys.has(key)) { row.el.remove(); this.opts.onRemove?.(row.el); this.rows.delete(key) }
    let listCursor = this.list.firstChild
    let parent: HTMLElement = this.list
    let cursor = listCursor
    let previousGroup: string | undefined
    const groups = new Set<string>()
    for (const card of visible) {
      const group = this.opts.group?.(card)
      if (group !== previousGroup) {
        if (group) {
          let box = this.groups.get(group)
          if (!box) {
            box = document.createElement('div'); box.className = 'ws-channel-group'
            const caption = document.createElement('h3'); caption.className = 'kbn-flight-caption'; caption.textContent = group
            box.append(caption); this.groups.set(group, box)
          }
          groups.add(group)
          if (box !== listCursor) this.list.insertBefore(box, listCursor)
          listCursor = box.nextSibling
          parent = box; cursor = box.firstChild!.nextSibling
        } else { parent = this.list; cursor = listCursor }
      }
      previousGroup = group
      const key = identity(card)
      let row = this.rows.get(key)
      if (!row) {
        const el = this.opts.renderCard?.(card) ?? document.createElement('button')
        el.classList.add('ws-channel-row')
        if (el instanceof HTMLButtonElement) el.type = 'button'
        else { el.setAttribute('role', 'button'); el.tabIndex = 0 }
        const name = el.querySelector<HTMLElement>('.ws-channel-name') ?? document.createElement('span'); name.classList.add('ws-channel-name')
        const owner = el.querySelector<HTMLElement>('.ws-channel-owner') ?? document.createElement('small')
        if (!this.opts.renderCard) el.append(name, owner)
        row = { el, name, owner, card, revision: JSON.stringify(card) }
        const record = row
        const open = (): void => { this.close(); this.opts.onOpen(record.card) }
        el.addEventListener('click', event => {
          const control = (event.target as Element).closest('button,a')
          if (control && control !== el) return
          open()
        })
        if (!(el instanceof HTMLButtonElement)) el.addEventListener('keydown', event => {
          if (event.target !== el || !['Enter', ' '].includes(event.key) || event.isComposing || event.repeat) return
          event.preventDefault(); open()
        })
        this.rows.set(key, row)
      }
      if (this.opts.renderCard && row.revision !== JSON.stringify(card)) {
        const face = this.opts.renderCard(card)
        row.el.replaceChildren(...face.childNodes)
        row.name = row.el.querySelector<HTMLElement>('.ws-channel-name')!
        row.owner = row.el.querySelector<HTMLElement>('.ws-channel-owner')!
      }
      row.revision = JSON.stringify(card)
      row.card = card
      row.el.dataset.channelUid = card.uid ?? card.id
      row.el.dataset.channelOwner = card.originId
      row.el.setAttribute('aria-label', card.name)
      row.el.setAttribute('aria-current', String(key === selected))
      row.el.title = card.outcome ?? card.path
      if (row.name.textContent !== card.name) row.name.textContent = card.name
      if (!this.opts.renderCard && row.owner.textContent !== card.originId) row.owner.textContent = card.originId
      if (row.el !== cursor) parent.insertBefore(row.el, cursor)
      cursor = row.el.nextSibling
      if (parent === this.list) listCursor = cursor
      this.opts.onRow?.(row.el, card)
    }
    for (const [group, box] of this.groups) if (!groups.has(group)) { box.remove(); this.groups.delete(group) }
    if (reveal && selected && selected !== this.revealed) this.reveal()
    this.opts.onRefresh?.()
  }
  /** Scroll the current row into view; its scroll margin keeps its group's caption in sight above it. */
  reveal(): void {
    const row = this.selected ? this.rows.get(this.selected) : undefined
    if (!row) return
    row.el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    this.revealed = this.selected
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
    else if (event.key === 'Enter' && event.target === this.find) {
      if (event.repeat) return
      this.list.querySelector<HTMLElement>('.ws-channel-row')?.click()
    } else return
    event.preventDefault(); event.stopImmediatePropagation()
  }
  private readonly outside = (event: PointerEvent): void => {
    if (this.isOpen && !this.el.contains(event.target as Node) && event.target !== this.find) this.close()
  }
  dispose(): void {
    document.removeEventListener('keydown', this.keydown, true)
    document.removeEventListener('pointerdown', this.outside)
    this.el.remove()
    for (const row of this.rows.values()) this.opts.onRemove?.(row.el)
    this.rows.clear()
  }
}
