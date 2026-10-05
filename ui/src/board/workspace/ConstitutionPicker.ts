import type { KanbanCard } from '../KanbanTypes.js'

export interface ConstitutionPickerOptions {
  cards(): KanbanCard[]
  files?(card: KanbanCard): string[]
  current?(card: KanbanCard): boolean
  onOpen(card: KanbanCard): void
}

/** Shared constitution rows and Find behavior for the sidebar and floating picker. */
export class ConstitutionPicker {
  readonly el = document.createElement('div')
  readonly find = document.createElement('input')
  private readonly list = document.createElement('div')
  private previous: HTMLElement | null = null
  private popup = false
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
  refresh(): void {
    const top = this.list.scrollTop
    const query = this.find.value.trim().toLowerCase()
    const rows = this.opts.cards().filter(card => !query || [card.name, card.path, ...(this.opts.files?.(card) ?? [])].some(v => v.toLowerCase().includes(query)))
    this.list.replaceChildren(...rows.map(card => {
      const row = document.createElement('button')
      row.type = 'button'; row.className = 'ws-channel-row'
      row.setAttribute('aria-label', card.name)
      row.setAttribute('aria-current', String(this.opts.current?.(card) ?? false))
      row.title = card.outcome ?? card.path
      const name = document.createElement('span')
      name.className = 'ws-channel-name'; name.textContent = card.name
      const owner = document.createElement('small'); owner.textContent = card.originId
      row.append(name, owner)
      row.addEventListener('click', () => { this.close(); this.opts.onOpen(card) })
      return row
    }))
    this.list.scrollTop = top
    const current = this.list.querySelector<HTMLElement>('[aria-current="true"]')
    if (current && (current.offsetTop < this.list.scrollTop || current.offsetTop + current.offsetHeight > this.list.scrollTop + this.list.clientHeight)) {
      this.list.scrollTop = Math.max(0, current.offsetTop - this.list.clientHeight / 3)
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
