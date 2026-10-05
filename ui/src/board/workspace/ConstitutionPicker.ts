import type { KanbanCard } from '../KanbanTypes.js'

export interface ConstitutionPickerOptions {
  cards(): KanbanCard[]
  files?(card: KanbanCard): string[]
  current?(card: KanbanCard): boolean
  revealCurrent?: boolean
  onOpen(card: KanbanCard): void
}

/** Shared constitution rows and Find behavior for the sidebar and floating picker. */
export class ConstitutionPicker {
  readonly el = document.createElement('div')
  readonly find = document.createElement('input')
  private readonly list = document.createElement('div')
  private previous: HTMLElement | null = null
  private popup = false
  private selected: string | null = null
  private revealed: string | null = null
  private readonly rows = new Map<string, { el: HTMLButtonElement; name: HTMLElement; owner: HTMLElement; card: KanbanCard }>()
  private readonly opts: ConstitutionPickerOptions
  constructor(opts: ConstitutionPickerOptions) {
    this.opts = opts
    this.find.className = 'ws-channel-find'
    this.find.type = 'search'
    this.find.placeholder = 'Find a constitution'
    this.find.setAttribute('aria-label', 'Find a constitution')
    this.list.className = 'ws-channel-list'
    this.el.append(this.find, this.list)
    this.find.addEventListener('input', () => this.refresh())
    document.addEventListener('keydown', this.keydown, true)
    document.addEventListener('pointerdown', this.outside)
  }
  focus(): void {
    if (!this.el.contains(document.activeElement)) this.previous = document.activeElement as HTMLElement | null
    this.refresh()
    this.find.focus({ preventScroll: true })
  }
  show(host: HTMLElement, anchor?: HTMLElement): void {
    this.popup = true
    this.el.className = 'ws-menu ws-switcher'
    host.append(this.el)
    const rect = anchor?.getBoundingClientRect()
    this.el.style.left = `${Math.max(12, Math.min(rect?.left ?? 12, window.innerWidth - this.el.offsetWidth - 12))}px`
    this.el.style.top = `${(rect?.bottom ?? 48) + 6}px`
    this.focus()
  }
  get isOpen(): boolean { return this.popup && this.el.isConnected }
  close(restore = false): void {
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
    for (const [key, row] of this.rows) if (!keys.has(key)) { row.el.remove(); this.rows.delete(key) }
    let cursor = this.list.firstChild
    for (const card of visible) {
      const key = identity(card)
      let row = this.rows.get(key)
      if (!row) {
        const el = document.createElement('button')
        el.type = 'button'; el.className = 'ws-channel-row'
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
      row.el.setAttribute('aria-current', String(key === selected))
      row.el.title = card.outcome ?? card.path
      if (row.name.textContent !== card.name) row.name.textContent = card.name
      if (row.owner.textContent !== card.originId) row.owner.textContent = card.originId
      if (row.el !== cursor) this.list.insertBefore(row.el, cursor)
      cursor = row.el.nextSibling
    }
    if (reveal && selected && selected !== this.revealed) {
      const row = this.rows.get(selected)
      if (row) {
        row.el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
        this.revealed = selected
      }
    }
  }
  private readonly keydown = (event: KeyboardEvent): void => {
    if (!this.el.isConnected || !this.el.contains(event.target as Node) || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.metaKey || event.ctrlKey) return
    if (event.key === 'Escape') this.close(true)
    else if (event.key === 'Enter' && event.target === this.find) {
      if (event.repeat) return
      this.list.querySelector<HTMLButtonElement>('button')?.click()
    } else return
    event.preventDefault(); event.stopImmediatePropagation()
  }
  private readonly outside = (event: PointerEvent): void => {
    if (this.isOpen && !this.el.contains(event.target as Node)) this.close()
  }
  dispose(): void {
    document.removeEventListener('keydown', this.keydown, true)
    document.removeEventListener('pointerdown', this.outside)
    this.el.remove()
  }
}
