import { FiberSends } from '../fiberSends.js'
import { conversable, type MapFile } from '../family/model.js'
import { htmlEl as el, markPath, shortAgo, svgEl } from '../family/drawing.js'
import { keyIntent } from '../keymap.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { boardCards, threadIndexFor } from '../KanbanSurfaces.js'
import { unseenSince } from '../workspace/DocumentSeen.js'
import { registerView, keystrokeIsSpokenFor, type TemporalView, type ViewContext } from './ViewRegistry.js'
import { ROLLUP_KINDS, buildTree, openByDefault, pathTo, visibleRows, type Rollup, type RollupKind, type TreeItem, type TreeRow } from './treeModel.js'
import '../family/family-map.css'
import './TreeView.css'

const OPEN_KEY = 'shuttle.tree.open'
const ROW_HEIGHT = 26
const ROLLUP_WORD: Readonly<Record<RollupKind, string>> = { question: 'asking', fresh: 'new', turn: 'your turn', review: 'to review', working: 'working' }
const ROLLUP_TONE: Readonly<Record<RollupKind, string>> = { question: 'question', fresh: 'new', turn: 'turn', review: 'review', working: 'working' }
/** A letter no key takes starts the filter. */
const SEEDS = /^\p{L}$/u

function remembered(): Map<string, boolean> {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean>)) } catch { return new Map() }
}

function mark(standing: string, r = 3.5): SVGSVGElement {
  const svg = svgEl('svg', 'tree-mark')
  svg.setAttribute('viewBox', '-6 -6 12 12')
  svg.setAttribute('aria-hidden', 'true')
  svg.dataset.standing = standing
  const path = svgEl('path')
  path.setAttribute('d', markPath(standing as Parameters<typeof markPath>[0], r))
  svg.append(path)
  return svg
}

function rollupEls(rollup: Rollup): HTMLElement[] {
  return ROLLUP_KINDS.flatMap(kind => {
    if (!rollup[kind]) return []
    const part = el('span', 'tree-rollup')
    part.dataset.standing = ROLLUP_TONE[kind]
    part.title = `${rollup[kind]} ${ROLLUP_WORD[kind]}`
    part.append(mark(ROLLUP_TONE[kind], 3), el('span', '', String(rollup[kind])))
    return [part]
  })
}

/**
 * The whole hierarchy on one quiet page, the tried and trusted way
 * around it. One flat list of rows, rebuilt in place from `buildTree` and
 * `visibleRows`: a row's element is kept while what it says stands, so a poll
 * touches only what moved. Rows take no listeners and only two of them change
 * class on a key. The list stays in the DOM while the reader covers it.
 *
 * A click or Enter on a thread selects it and opens its Rex chat; arrows move
 * and fold and never reach Rex; Rex moving reveals its row.
 */
class TreePage {
  private readonly page = el('section', 'tree-page family-map')
  private readonly counts = el('div', 'tree-counts')
  private readonly filter = el('input', 'tree-filter')
  private readonly list = el('div', 'tree-list')
  private readonly trail = el('nav', 'tree-trail')
  private readonly empty = el('p', 'tree-empty', 'Nothing matches.')
  private readonly elements = new Map<string, HTMLElement>()
  private readonly said = new Map<string, string>()
  /** Each thread's tapestry as far as read, null for none. */
  private readonly leads = new Map<string, MapFile | null>()
  /** What a hand has opened or shut, kept per browser. */
  private readonly open = remembered()
  /** The ancestors of the row last shown from elsewhere. */
  private readonly way = new Set<string>()
  private context: ViewContext | null = null
  private host: HTMLElement | null = null
  private sends: FiberSends | null = null
  private top: TreeItem | null = null
  private rows: TreeRow[] = []
  private place = new Map<string, number>()
  private selected: string | null = null
  private scroll = 0
  private ids = 0
  private touch = false

  constructor() {
    const head = el('header', 'tree-head')
    this.filter.type = 'search'
    this.filter.placeholder = 'Filter'
    this.filter.setAttribute('aria-label', 'Filter the tree by name')
    this.filter.addEventListener('input', () => this.filtered())
    this.filter.addEventListener('keydown', event => this.filterKey(event))
    head.append(this.counts, this.filter)
    this.list.setAttribute('role', 'tree')
    this.list.setAttribute('aria-label', 'All work')
    this.list.tabIndex = 0
    this.list.addEventListener('click', event => this.clicked(event))
    this.list.addEventListener('pointerdown', event => { this.touch = event.pointerType === 'touch' }, { passive: true })
    this.list.addEventListener('scroll', () => { if (this.list.clientHeight) this.scroll = this.list.scrollTop }, { passive: true })
    // The reader takes the list's box away, and its scroll with it.
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => {
      if (!this.list.clientHeight) return
      this.list.scrollTop = this.scroll
      if (document.activeElement === document.body) this.list.focus({ preventScroll: true })
    }).observe(this.list)
    this.counts.addEventListener('click', event => {
      const kind = (event.target as Element).closest<HTMLElement>('[data-next]')?.dataset.next as RollupKind | undefined
      if (kind) this.next(kind)
    })
    this.trail.setAttribute('aria-label', 'Selected path')
    this.trail.addEventListener('click', event => {
      const key = (event.target as Element).closest<HTMLElement>('[data-key]')?.dataset.key
      if (key) { this.select(key); this.list.focus({ preventScroll: true }) }
    })
    this.empty.hidden = true
    this.page.append(head, this.list, this.empty, this.trail)
  }

  mount(host: HTMLElement, context: ViewContext): void {
    this.host = host
    host.classList.add('kbn-view-host-held')
    host.append(this.page)
    this.sends ??= new FiberSends(context.shuttleBase, () => this.repaint(), Infinity)
    this.refresh(context)
    this.list.scrollTop = this.scroll
    if (!keystrokeIsSpokenFor()) this.list.focus({ preventScroll: true })
  }
  refresh(context: ViewContext): void {
    this.context = context
    void this.sends?.refresh()
    this.repaint()
  }
  unmount(): void {
    this.context = null
    this.host?.classList.remove('kbn-view-host-held')
    this.host = null
    this.page.remove()
  }

  /** Rex moved to this fiber: select and show its row, leaving Rex be. */
  reveal(id: string, origin: string): boolean {
    const hit = this.search(node => !!node.thread && node.thread.card.originId === origin && (node.thread.card.uid === id || node.thread.card.id === id))
    if (!hit) return false
    if (this.place.has(hit.key)) this.mark(hit.key, true)
    else if (!this.filter.value) this.show(hit)
    return true
  }
  keydown(event: KeyboardEvent): boolean {
    if (keystrokeIsSpokenFor() || !this.context) return false
    if (['Enter', ' '].includes(event.key) && (event.target as Element | null)?.closest?.('button, a')) return false
    const intent = keyIntent(event, 'tree')
    const row = this.current
    const move = (by: number): void => { const at = row ? this.place.get(row.item.key)! : -1; this.selectRow(this.rows[Math.max(0, Math.min(this.rows.length - 1, at + by))]) }
    switch (intent) {
      case 'down': move(1); return true
      case 'up': move(-1); return true
      case 'first': this.selectRow(this.rows[0]); return true
      case 'last': this.selectRow(this.rows.at(-1)); return true
      case 'pageDown': move(this.pageRows); return true
      case 'pageUp': move(-this.pageRows); return true
      case 'right':
        if (row?.open === false) this.toggle(row.item, true)
        else if (row?.open) move(1)
        return true
      case 'left':
        if (row?.open) this.toggle(row.item, false)
        else if (row?.item.parent?.parent) this.select(row.item.parent.key)
        return true
      case 'open': if (row) this.act(row); return true
      case 'conversation': if (row) this.converse(row.item); return true
      case 'map': if (row) this.map(row.item); return true
      case 'nextAsk': this.next(); return true
      case 'find': this.filter.focus(); this.filter.select(); return true
      case 'back':
        if (this.filter.value) { this.filter.value = ''; this.filtered(); return true }
        return false
      default:
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && SEEDS.test(event.key)) {
      this.filter.value = event.key
      this.filter.focus()
      this.filtered()
      return true
    }
    return false
  }

  private get current(): TreeRow | undefined {
    const at = this.selected === null ? undefined : this.place.get(this.selected)
    return at === undefined ? undefined : this.rows[at]
  }
  private get pageRows(): number { return Math.max(1, Math.floor(this.list.clientHeight / ROW_HEIGHT)) }
  private isOpen = (node: TreeItem): boolean => this.open.get(node.key) ?? (this.way.has(node.key) || openByDefault(node))

  private filesOf(card: KanbanCard): MapFile[] {
    return (this.sends?.sends(card) ?? []).map(send => ({ key: send.key, name: send.basename, at: send.timestamp, unread: unseenSince(send.key, send.timestamp) }))
  }
  private leadOf(card: KanbanCard): MapFile | undefined { return this.leads.get(card.uid ?? card.id) ?? undefined }

  private repaint(): void {
    const context = this.context
    if (!context) return
    const index = threadIndexFor(context.response)
    this.top = buildTree(index, boardCards(context.response), { files: card => this.filesOf(card), lead: card => this.leadOf(card) }, Date.now())
    this.paintCounts(this.top)
    this.paint()
  }

  private paintCounts(top: TreeItem): void {
    const owed = ROLLUP_KINDS.flatMap(kind => {
      if (!top.rollup[kind]) return []
      const button = el('button', 'tree-count-button')
      button.type = 'button'
      button.dataset.next = kind
      button.dataset.standing = ROLLUP_TONE[kind]
      button.title = `Next ${ROLLUP_WORD[kind]}`
      button.append(mark(ROLLUP_TONE[kind]), el('span', 'tree-count-n', String(top.rollup[kind])), el('span', 'tree-count-word', ROLLUP_WORD[kind]))
      return [button]
    })
    this.counts.replaceChildren(...owed)
  }

  /** Sets the list to the rows, touching only those whose words moved. */
  private paint(): void {
    if (!this.top) return
    const now = Date.now()
    this.rows = visibleRows(this.top, this.isOpen, this.filter.value)
    this.place = new Map(this.rows.map((row, n) => [row.item.key, n]))
    this.empty.hidden = this.rows.length > 0
    for (const child of [...this.list.children] as HTMLElement[]) {
      const key = child.dataset.key!
      if (!this.place.has(key)) { child.remove(); this.elements.delete(key); this.said.delete(key) }
    }
    let cursor = this.list.firstElementChild
    for (const row of this.rows) {
      const key = row.item.key
      let rowEl = this.elements.get(key)
      if (!rowEl) { rowEl = this.createRow(key); this.elements.set(key, rowEl) }
      const said = this.saying(row, now)
      if (this.said.get(key) !== said) { this.said.set(key, said); this.fill(rowEl, row, now) }
      if (rowEl === cursor) cursor = cursor.nextElementSibling
      else this.list.insertBefore(rowEl, cursor)
    }
    this.settleSelection()
    this.readLeads()
  }

  private saying(row: TreeRow, now: number): string {
    const { item } = row
    return JSON.stringify([item.name, item.thread?.tone, item.thread?.fresh, item.thread?.word, row.level, row.pos, row.size, row.open, item.threads, item.files, item.live, item.rollup, shortAgo(item.at, now), item.file?.unread, item.thread && this.foreign(item)])
  }

  private createRow(key: string): HTMLElement {
    const row = el('div', 'tree-row')
    row.setAttribute('role', 'treeitem')
    row.id = `tree-row-${++this.ids}`
    row.dataset.key = key
    return row
  }

  /** A thread away from this daemon, where the row above does not already say so. */
  private foreign(item: TreeItem): boolean {
    const origin = item.thread?.card.originId
    return !!origin && origin !== this.context?.response.feltHost && pathTo(item).at(-2)?.thread?.card.originId !== origin
  }

  private fill(rowEl: HTMLElement, row: TreeRow, now: number): void {
    const { item, level, pos, size, open } = row
    rowEl.dataset.kind = item.kind
    rowEl.style.setProperty('--tree-level', String(level - 1))
    rowEl.setAttribute('aria-level', String(level))
    rowEl.setAttribute('aria-posinset', String(pos))
    rowEl.setAttribute('aria-setsize', String(size))
    if (open === null) rowEl.removeAttribute('aria-expanded')
    else rowEl.setAttribute('aria-expanded', String(open))
    rowEl.toggleAttribute('data-quiet', !item.live && item.kind !== 'file')
    const parts: Array<HTMLElement | SVGElement> = []
    const caret = el('span', 'tree-caret')
    if (open !== null) caret.append(el('span', 'tree-caret-glyph'))
    parts.push(caret)
    if (item.thread) {
      rowEl.dataset.standing = item.thread.tone
      parts.push(mark(item.thread.tone))
      rowEl.setAttribute('aria-label', `${item.name}, ${item.thread.word}`)
    } else {
      delete rowEl.dataset.standing
      rowEl.removeAttribute('aria-label')
      if (item.kind === 'file') {
        rowEl.dataset.role = item.role!
        if (item.file?.unread) { rowEl.dataset.standing = 'new'; parts.push(mark('new')) }
        else parts.push(el('span', 'tree-mark tree-file-mark'))
      } else parts.push(el('span', 'tree-mark'))
    }
    parts.push(el('span', 'tree-name', item.name))
    const meta = el('span', 'tree-meta')
    if (open === false) meta.append(...rollupEls(item.rollup))
    const under = item.shelf === 'files' ? String(item.files) : [item.threads ? `${item.threads} ${item.threads === 1 ? 'thread' : 'threads'}` : '', item.files ? `${item.files} ${item.files === 1 ? 'file' : 'files'}` : ''].filter(Boolean).join(' · ')
    if (under) meta.append(el('span', 'tree-under', under))
    if (this.foreign(item)) meta.append(el('span', 'tree-host', item.thread!.card.originId))
    if (item.at) meta.append(el('span', 'tree-age', shortAgo(item.at, now)))
    parts.push(meta)
    if (item.thread) {
      const map = el('button', 'tree-map', 'map')
      map.type = 'button'
      map.tabIndex = -1
      map.title = 'Open its map (m)'
      parts.push(map)
    }
    rowEl.replaceChildren(...parts)
  }

  private settleSelection(): void {
    if (!this.top) return
    let key = this.selected
    if (key !== null && !this.place.has(key)) {
      let up = this.searchKey(key)?.parent
      while (up && !this.place.has(up.key)) up = up.parent
      key = up?.key ?? null
    }
    key ??= this.rows[0]?.item.key ?? null
    this.mark(key, this.selected !== key)
  }
  private mark(key: string | null, moved: boolean): void {
    if (this.selected !== null) this.elements.get(this.selected)?.setAttribute('aria-selected', 'false')
    this.selected = key
    const rowEl = key === null ? undefined : this.elements.get(key)
    rowEl?.setAttribute('aria-selected', 'true')
    if (rowEl) this.list.setAttribute('aria-activedescendant', rowEl.id)
    else this.list.removeAttribute('aria-activedescendant')
    if (moved) rowEl?.scrollIntoView({ block: 'nearest' })
    this.paintTrail()
  }
  private paintTrail(): void {
    const row = this.current
    const crumbs = row ? pathTo(row.item) : []
    const parts = crumbs.flatMap((node, n) => {
      const crumb = el('button', 'tree-crumb', node.name)
      crumb.type = 'button'
      crumb.dataset.key = node.key
      crumb.tabIndex = -1
      return n ? [el('span', 'tree-sep', '/'), crumb] : [crumb]
    })
    this.trail.replaceChildren(...parts)
  }

  private selectRow(row: TreeRow | undefined): void { if (row) this.mark(row.item.key, true) }
  private select(key: string): void {
    if (this.place.has(key)) this.mark(key, true)
    else { const item = this.searchKey(key); if (item) this.show(item) }
  }
  /** Holds the way to an item open until the next such item, and selects it. */
  private show(item: TreeItem): void {
    this.way.clear()
    for (let up = item.parent; up?.parent; up = up.parent) { this.way.add(up.key); this.open.delete(up.key) }
    this.filter.value = ''
    this.paint()
    this.mark(item.key, true)
  }
  private search(found: (node: TreeItem) => boolean): TreeItem | undefined {
    const walk = (node: TreeItem): TreeItem | undefined => {
      if (found(node)) return node
      for (const child of node.children) { const hit = walk(child); if (hit) return hit }
      return undefined
    }
    return this.top ? walk(this.top) : undefined
  }
  private searchKey(key: string): TreeItem | undefined { return this.search(node => node.key === key) }

  private toggle(item: TreeItem, open: boolean): void {
    this.open.set(item.key, open)
    this.remember()
    this.paint()
  }
  private remember(): void {
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(Object.fromEntries(this.open))) } catch { /* Storage is optional. */ }
  }

  /** Reads a tapestry for each open thread once. */
  private readLeads(): void {
    const workspace = this.context?.workspace
    if (!workspace) return
    for (const { item, open } of this.rows) {
      const card = item.thread?.card
      if (!card || !open || this.leads.has(card.uid ?? card.id)) continue
      this.leads.set(card.uid ?? card.id, null)
      void workspace.readLead(card).then(file => {
        if (!file) return
        this.leads.set(card.uid ?? card.id, file)
        this.repaint()
      })
    }
  }

  private next(kind?: RollupKind): void {
    const asks = (node: TreeItem): boolean => {
      const tone = node.thread?.tone
      if (!tone) return false
      if (!kind) return tone === 'question' || tone === 'blocked' || tone === 'turn' || tone === 'review'
      if (kind === 'fresh') return node.thread!.fresh
      return tone === kind || (kind === 'question' && tone === 'blocked')
    }
    const all: TreeItem[] = []
    const walk = (node: TreeItem): void => { if (asks(node)) all.push(node); node.children.forEach(walk) }
    if (this.top) walk(this.top)
    if (!all.length) return
    const at = all.findIndex(node => node.key === this.selected)
    this.show(all[(at + 1) % all.length])
  }

  private clicked(event: MouseEvent): void {
    const target = event.target as Element
    const rowEl = target.closest<HTMLElement>('.tree-row')
    const row = rowEl ? this.rows[this.place.get(rowEl.dataset.key!)!] : undefined
    if (!row) return
    this.list.focus({ preventScroll: true })
    const again = row.item.key === this.selected
    this.mark(row.item.key, false)
    if (target.closest('.tree-map')) { this.map(row.item); return }
    if (target.closest('.tree-caret') && row.open !== null) { this.toggle(row.item, !row.open); return }
    // A finger comes to a thread on a first tap and opens its chat on a second.
    if (this.touch && !again && row.item.thread) { if (row.open === false) this.toggle(row.item, true); return }
    this.act(row)
  }

  /** A thread opens its chat and shows what it holds; a file opens on the stage; anything else folds. */
  private act(row: TreeRow): void {
    const { item, open } = row
    if (item.kind === 'file') { this.context?.workspace?.openPage(item.card!, item.file!.key); return }
    if (item.thread) {
      this.converse(item)
      if (open === false) this.toggle(item, true)
      return
    }
    if (open !== null) this.toggle(item, !open)
  }
  /** The thread a row belongs to, itself or the nearest above it. */
  private threadOf(item: TreeItem): KanbanCard | undefined {
    for (let up: TreeItem | null = item; up; up = up.parent) if (up.thread) return up.thread.card
    return undefined
  }
  private converse(item: TreeItem): void {
    const card = this.threadOf(item)
    if (card && conversable(card)) this.context?.workspace?.dock.openConversation(card)
  }
  private map(item: TreeItem): void {
    const card = this.threadOf(item)
    if (card) this.context?.workspace?.openFromDesk(card)
  }

  private filtered(): void {
    this.paint()
    this.selectRow(this.rows.find(row => row.open === null) ?? this.rows[0])
    this.list.scrollTop = 0
  }
  private filterKey(event: KeyboardEvent): void {
    const handled = event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === 'Escape'
    if (!handled) return
    event.preventDefault()
    event.stopPropagation()
    const at = this.current ? this.place.get(this.current.item.key)! : -1
    if (event.key === 'ArrowDown') this.selectRow(this.rows[Math.min(at + 1, this.rows.length - 1)])
    else if (event.key === 'ArrowUp') this.selectRow(this.rows[Math.max(at - 1, 0)])
    else if (event.key === 'Enter') { const row = this.current; if (row) this.act(row) }
    else {
      const had = this.filter.value
      this.filter.value = ''
      if (had) this.show(this.searchKey(this.selected ?? '') ?? this.top!.children[0])
      this.list.focus({ preventScroll: true })
    }
  }
}

/** Builds its page on the first visit and keeps it, with its place, for the next. */
class TreeView implements TemporalView {
  readonly id = 'tree' as const
  readonly title = 'Tree'
  readonly hotkey = '4'
  private page: TreePage | null = null
  private shown = false
  mount(host: HTMLElement, context: ViewContext): void { this.shown = true; (this.page ??= new TreePage()).mount(host, context) }
  refresh(context: ViewContext): void { this.page?.refresh(context) }
  unmount(): void { this.shown = false; this.page?.unmount() }
  keydown(event: KeyboardEvent): boolean { return this.shown && !!this.page?.keydown(event) }
  reveal(id: string, origin: string): boolean { return this.shown && !!this.page?.reveal(id, origin) }
}
registerView(new TreeView())
