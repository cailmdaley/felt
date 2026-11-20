import { inPlace, type FindRow, type FindScope, type FindSection, type ListScope } from './scope.js'
import { anchorPopover, type Release } from '../workspace/anchoredPopover.js'
import './search.css'

/** How many rows a section shows before its "more". */
export const SECTION_ROWS = 5
/**
 * How long the hand rests before the daemon is asked. The local half never
 * waits; a body search is a `felt ls --body` per store, about 0.6s on a live
 * loom, cheap enough to run per pause and far too expensive per keystroke.
 */
const READ_MS = 250

export interface SearchPanelOptions {
  /** The field it answers: the board bar's Find, which every view shares; without one the panel carries its own (the phone's sheet). */
  field?: HTMLInputElement
  /** The chip beside a shared field that names the scope; the panel makes its own beside its own field. */
  chip?: HTMLButtonElement
  /** Where the board's Find stands now. */
  scope(): FindScope
  /** The whole board: where a dropped chip widens to. */
  board(): ListScope
  /** The field was put away whole (Escape, or a pick). */
  onDone?(): void
}

/** One section's answer from the daemon, for one query. */
interface Read { query: string; rows?: FindRow[]; failed?: boolean; controller: AbortController; timer?: ReturnType<typeof setTimeout> }

/**
 * The board's Find: a field, the chip naming where it searches, and the list
 * of what it found hung beneath it, section by section, each capped with a
 * "more". Backspace in an empty field (or a press on the chip) drops the chip
 * and widens to the whole board. A scope that answers in place is handed the
 * field's words and keys instead of a list.
 */
/** Numbers each panel, so a field can name the one it controls. */
let panels = 0

export class SearchPanel {
  readonly el = document.createElement('div')
  readonly field: HTMLInputElement
  readonly chip: HTMLButtonElement
  private readonly list = document.createElement('div')
  /** Says, politely, that a read is on its way or that nothing was found. */
  private readonly status = document.createElement('p')
  private readonly opts: SearchPanelOptions
  private scope: FindScope | null = null
  private widened = false
  private query = ''
  private readonly reads = new Map<string, Read>()
  /** Sections whose read was asked for, for the query they were asked with. */
  private readonly asked = new Map<string, string>()
  /** Sections showing every row. */
  private readonly opened = new Set<string>()
  private shown = false
  private release: Release | null = null
  /** Where a shared field's list hangs. */
  private place: { host: HTMLElement; anchor?: HTMLElement } | null = null

  constructor(opts: SearchPanelOptions) {
    this.opts = opts
    this.el.className = 'ws-menu ws-switcher ws-find'
    this.el.id = `ws-find-${++panels}`
    this.list.className = 'ws-find-list'
    this.status.className = 'ws-search-note'
    this.status.setAttribute('role', 'status')
    this.field = opts.field ?? document.createElement('input')
    this.chip = opts.chip ?? document.createElement('button')
    this.chip.type = 'button'
    this.chip.classList.add('ws-find-chip')
    this.chip.hidden = true
    this.chip.addEventListener('click', () => { this.widen(); this.field.focus({ preventScroll: true }) })
    if (!opts.field) {
      this.field.type = 'search'
      this.field.className = 'ws-channel-find'
      this.field.placeholder = 'Find'
      this.field.setAttribute('aria-label', 'Find')
      const bar = document.createElement('label')
      bar.className = 'ws-find-field'
      bar.append(this.chip, this.field)
      this.el.append(bar)
      // A field of its own is served here; a shared one is served by its owner (`show`).
      this.field.addEventListener('focus', this.serve)
      this.field.addEventListener('input', this.serve)
    } else {
      // The bar's field opens a panel the arrows move focus into, section by section.
      this.el.setAttribute('role', 'dialog')
      this.el.setAttribute('aria-label', 'Find')
      this.field.setAttribute('role', 'combobox')
      this.field.setAttribute('aria-haspopup', 'dialog')
      this.field.setAttribute('aria-controls', this.el.id)
      this.field.setAttribute('aria-expanded', 'false')
    }
    this.el.append(this.list, this.status)
    document.addEventListener('keydown', this.keydown, true)
    document.addEventListener('pointerdown', this.outside)
  }

  get isOpen(): boolean { return this.shown }

  /** Answers the field where it stands: a list hung under `anchor` in `host`, or the in-place scope's own answer. */
  readonly serve = (): void => {
    const scope = this.widened ? this.opts.board() : this.opts.scope()
    if (this.scope && inPlace(this.scope) && !(inPlace(scope) && scope.chip === this.scope.chip)) this.scope.inPlace.clear()
    const opening = !this.scope || this.scope.chip !== scope.chip
    // Another scope's reads, asks and opened sections answer for it, not this one.
    if (opening) this.forget()
    this.scope = scope
    this.paintChip()
    if (inPlace(scope)) { this.hide(); scope.inPlace.input(this.field.value); return }
    if (opening || !this.shown) scope.open?.()
    if (this.place && !this.el.isConnected) {
      this.place.host.append(this.el)
      this.release = this.place.anchor ? anchorPopover(this.el, this.place.anchor, { placement: 'below-start', gap: 6, margin: 12 }) : null
    }
    this.shown = true
    this.refresh()
  }

  /** The view beneath moved (another channel opened): a Find serving it follows it there. */
  follow(): void {
    if (this.scope && !this.widened) this.serve()
  }

  /** Serves a shared field, its list hung in `host` under `anchor`. */
  show(host: HTMLElement, anchor?: HTMLElement): void {
    this.place = { host, anchor }
    this.serve()
  }

  /** What the list shows, drawn again from what the board holds now; the focused row keeps the focus. */
  refresh(): void {
    const scope = this.scope
    if (!this.shown || !scope || inPlace(scope)) return
    const query = this.field.value.trim()
    if (query !== this.query) { this.forget(); this.query = query }
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-find-key]')?.dataset.findKey
    const blocks = scope.sections.flatMap(section => this.section(section, query))
    this.say(query && !blocks.length ? scope.sections.some(section => this.reading(section, query)) ? 'Searching…' : 'Nothing found.' : '')
    this.list.replaceChildren(...blocks)
    this.el.hidden = !blocks.length && !this.status.textContent && !!this.opts.field
    this.expanded(!this.el.hidden)
    if (focused && document.activeElement === document.body) {
      (this.list.querySelector<HTMLElement>(`[data-find-key="${CSS.escape(focused)}"]`) ?? this.field).focus({ preventScroll: true })
    }
  }

  /** Puts the list away, the field's words kept. */
  close(): void {
    this.hide()
    if (this.scope && inPlace(this.scope)) this.scope.inPlace.clear()
    this.scope = null
    this.widened = false
    this.paintChip()
  }

  /** Empties the field and puts away whatever it did. */
  clear(): void {
    this.field.value = ''
    this.close()
  }

  dispose(): void {
    this.close()
    this.field.removeEventListener('input', this.serve)
    this.field.removeEventListener('focus', this.serve)
    document.removeEventListener('keydown', this.keydown, true)
    document.removeEventListener('pointerdown', this.outside)
    this.el.remove()
  }

  /** Drops the chip: the field searches the whole board. */
  private widen(): void {
    if (this.widened || !this.scope?.chip) return
    this.widened = true
    this.serve()
  }

  /** Abandons every read still on its way, and forgets what was asked and opened. */
  private forget(): void {
    for (const read of this.reads.values()) { read.controller.abort(); clearTimeout(read.timer) }
    this.reads.clear()
    this.asked.clear()
    this.opened.clear()
  }

  private hide(): void {
    this.shown = false
    this.forget()
    this.query = ''
    this.list.replaceChildren()
    this.say('')
    this.expanded(false)
    if (this.opts.field) { this.release?.(); this.release = null; this.el.remove() }
  }

  /** The status line's words, written only when they change, so a redraw is not announced again. */
  private say(words: string): void {
    if (this.status.textContent !== words) this.status.textContent = words
  }

  private expanded(open: boolean): void {
    if (this.opts.field) this.field.setAttribute('aria-expanded', String(open))
  }

  private paintChip(): void {
    const words = this.scope?.chip
    this.chip.hidden = !words
    this.chip.textContent = words ?? ''
    this.chip.title = words ? `Searching ${words.replace(/^in /, '')}: press to search the whole board (or Backspace in the empty field)` : ''
    this.chip.setAttribute('aria-label', words ? `${words}; search the whole board instead` : '')
  }

  /** Whether a section's read for this query is still on its way. */
  private reading(section: FindSection, query: string): boolean {
    const read = this.reads.get(section.id)
    return !!read && read.query === query && !read.rows && !read.failed
  }

  /** A section's caption and rows, nothing when it found nothing. */
  private section(section: FindSection, query: string): HTMLElement[] {
    const asking = !!section.ask && this.asked.get(section.id) !== query
    const long = query.replace(/\s/g, '').length >= (section.min ?? 1)
    if (section.read && long && !asking) this.read(section, query)
    const read = this.reads.get(section.id)
    const answered = read?.query === query ? read : undefined
    const rows = answered?.rows ?? section.rows(query)
    const items: HTMLElement[] = []
    const all = this.opened.has(section.id)
    for (const row of all ? rows : rows.slice(0, SECTION_ROWS)) items.push(this.row(section, row))
    if (!all && rows.length > SECTION_ROWS) items.push(this.more(section, rows.length - SECTION_ROWS))
    if (section.ask && asking && long) items.push(this.ask(section, query))
    if (answered?.failed && section.failed) {
      const note = document.createElement('p')
      note.className = 'ws-search-note'
      note.textContent = section.failed
      items.push(note)
    }
    if (!items.length) return []
    const block = document.createElement('section')
    block.className = 'ws-find-section'
    block.dataset.section = section.id
    const caption = document.createElement('h3')
    caption.className = 'kbn-flight-caption'
    caption.textContent = section.title
    caption.id = `${this.el.id}-${section.id}`
    block.setAttribute('role', 'group')
    block.setAttribute('aria-labelledby', caption.id)
    block.append(caption, ...items)
    return [block]
  }

  private read(section: FindSection, query: string): void {
    const held = this.reads.get(section.id)
    if (held?.query === query) return
    if (held) { held.controller.abort(); clearTimeout(held.timer) }
    const read: Read = { query, controller: new AbortController() }
    this.reads.set(section.id, read)
    read.timer = setTimeout(() => {
      section.read!(query, read.controller.signal).then(rows => { read.rows = rows }, () => { read.failed = true }).finally(() => {
        if (this.reads.get(section.id) === read && !read.controller.signal.aborted) this.refresh()
      })
    }, READ_MS)
  }

  private row(section: FindSection, row: FindRow): HTMLElement {
    const item = document.createElement('div')
    item.className = 'ws-find-item'
    const pick = document.createElement('button')
    pick.type = 'button'
    pick.className = ['ws-find-pick', row.className].filter(Boolean).join(' ')
    pick.dataset.findKey = `${section.id}:${row.key}`
    pick.setAttribute('aria-label', row.label)
    if (row.current) pick.setAttribute('aria-current', 'true')
    pick.append(row.content())
    if (row.pick) pick.addEventListener('click', () => { const chosen = row.pick!; this.done(); chosen() })
    else pick.setAttribute('aria-disabled', 'true')
    item.append(pick)
    if (row.extra) item.append(row.extra)
    return item
  }

  private more(section: FindSection, count: number): HTMLElement {
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'ws-find-more'
    more.dataset.findKey = `${section.id}:more`
    more.textContent = `${count} more`
    more.addEventListener('click', () => {
      this.opened.add(section.id)
      this.refresh()
      this.list.querySelectorAll<HTMLElement>(`[data-section="${CSS.escape(section.id)}"] .ws-find-pick`)[SECTION_ROWS]?.focus({ preventScroll: true })
    })
    return more
  }

  private ask(section: FindSection, query: string): HTMLElement {
    const ask = document.createElement('button')
    ask.type = 'button'
    ask.className = 'ws-find-ask'
    ask.dataset.findKey = `${section.id}:ask`
    ask.append(section.ask!(query))
    const key = document.createElement('kbd')
    key.textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘↵' : 'Ctrl↵'
    ask.append(key)
    ask.addEventListener('click', () => {
      this.asked.set(section.id, query)
      this.refresh()
      if (!this.el.contains(document.activeElement)) this.field.focus({ preventScroll: true })
    })
    return ask
  }

  /** A pick puts the field away whole. */
  private done(): void {
    this.clear()
    this.opts.onDone?.()
  }

  private readonly keydown = (event: KeyboardEvent): void => {
    const scope = this.scope
    const onField = event.target === this.field
    if ((!onField && !this.el.contains(event.target as Node)) || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    // Escape puts Find away even when what it served went away beneath the field (a route change while typing).
    if (event.key === 'Escape') {
      this.clear()
      this.opts.onDone?.()
    } else if (!scope) {
      return
    } else if (event.key === 'Backspace' && onField && !this.field.value && scope.chip && !this.widened) {
      this.widen()
    } else if (inPlace(scope)) {
      if (!onField || event.altKey || event.metaKey || event.ctrlKey) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') scope.inPlace.step(event.key === 'ArrowDown' ? 1 : -1)
      else if (event.key === 'Enter') { if (event.repeat) return; scope.inPlace.keep() }
      else return
    } else if (event.key === 'Enter' && onField && (event.metaKey || event.ctrlKey)) {
      this.list.querySelector<HTMLElement>('.ws-find-ask')?.click()
    } else if (event.key === 'Enter' && onField && !event.altKey && !event.shiftKey) {
      if (event.repeat) return
      this.list.querySelector<HTMLElement>('.ws-find-pick:not([aria-disabled])')?.click()
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const stops = [...this.list.querySelectorAll<HTMLElement>('button')]
      const at = stops.indexOf(event.target as HTMLElement)
      if (event.key === 'ArrowDown') stops[Math.min(stops.length - 1, at + 1)]?.focus({ preventScroll: false })
      else if (at <= 0) this.field.focus()
      else stops[at - 1]?.focus()
    } else return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  private readonly outside = (event: PointerEvent): void => {
    const target = event.target as Node
    if (this.shown && this.opts.field && !this.el.contains(target) && !this.field.contains(target) && !this.chip.contains(target)) this.close()
  }
}
