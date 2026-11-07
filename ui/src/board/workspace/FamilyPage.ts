import type { KanbanCard } from '../KanbanTypes.js'
import { familyModel, type FamilyModel, type MapFeeds, type MapFile, type MapThread, type Standing } from '../family/model.js'
import { htmlEl as el, markPath, markSvg, shortAgo, standingLine } from '../family/drawing.js'
import { SECTION_WORD, opening, outline, underAll, type Line, type Under } from '../family/outline.js'
import { bindDrawnPage } from '../FileViewerPanel.js'
import type { Conversations } from '../conversationOpening.js'
import { threadKey, type ThreadIndex } from '../threads.js'
import { fiberKey, type DocKey } from './documents.js'
import { slug } from '../threadOutline.js'
import './family-page.css'

/** A sent file that is a thread's tapestry or report when its fiber's directory holds none. */
const LEAD_NAME = /^(tapestry|report)\.html$/i
/** How the fold of threads set aside names each kind, one and many. */
const ASIDE_WORDS: Readonly<Record<string, readonly [string, string]>> = { drafts: ['draft', 'drafts'], seat: ['seat', 'seats'] }

/** What the page reads, and how to ask for it again. */
export interface FamilyFeeds extends MapFeeds {
  refresh(): void
  /** The thread's tapestry or report, read when the page shows what the thread holds. */
  lead(card: KanbanCard): Promise<MapFile | undefined>
  /** One of a thread's documents drawn at its full height, for the page to hold in its own scroll. */
  embed(card: KanbanCard, doc: DocKey): EmbeddedDocument
}

/** A document unfolded under its row, and how to let it go. */
export interface EmbeddedDocument { el: HTMLElement; dispose(): void }

/**
 * Where a page stands, kept by its channel so it outlives the page's frame:
 * the rows and folds it has open, the row it has selected, the thread it
 * lands on, and the thread whose conversation Rex holds.
 */
export interface MapPlace {
  open: Set<string>
  selected: string | null
  /** The fiber it lands on, by host and identity, which holds before the family's cards have loaded. */
  landing?: string
  worker?: string
  /** The thread last entered (a click, Enter or `l`), which voice follows; the highlight alone commits nothing. */
  entered?: string | null
  /** The document each thread has unfolded under its row, by thread. */
  docs?: Map<string, DocKey>
}
const fiberOf = (card: KanbanCard): string => `${card.originId}:${card.uid ?? card.id}`
/** A page that lands on a fiber's row. */
export const placeAt = (card: KanbanCard): MapPlace => ({ open: new Set(), selected: null, landing: fiberOf(card) })

/**
 * A constitution's page: the family's root heads it with its outcome and what
 * it holds, and its threads follow as rows, the tree whole, siblings in the
 * order they ask for attention under one divider per kind, then the threads
 * set aside behind one fold.
 * A row leads with its name and what it came to (or what it asks); a click
 * unfolds it to what it holds (tapestry or report, constitution, sent files
 * oldest to newest) and its own threads, laid out the same way, and a second
 * click folds it. A document's chip unfolds that document under the row, full
 * width and at its full height, in the page's one scroll; a second click folds
 * it. A click moves Rex quietly to the thread's worker; only `c` opens a
 * conversation. It reads feeds and repaints only while its frame is selected in
 * an open reader; its frame's eviction ends it.
 */
export class FamilyPage {
  readonly el = el('div', 'ws-family-page family-map')
  private readonly scroller = el('div', 'ws-family-scroll')
  private readonly tree = el('div', 'fp-tree')
  private readonly announcement = el('p', 'ws-family-announce')
  private readonly rows = new Map<string, HTMLElement>()
  /** Each thread's tapestry: the read that finds it, and the file once it has. */
  private readonly leads = new Map<string, { read: Promise<MapFile | undefined>; file?: MapFile }>()
  private model: FamilyModel | null = null
  private under: ReadonlyMap<string, Under> = new Map()
  private lines: Line[] = []
  private scope: { index: ThreadIndex; card: KanbanCard } | null = null
  private signature = ''
  /** The landing this page has come to, and in which family: a family that grows an orchestrator lands again. */
  private landed = ''
  private awake = true
  private readonly conversations: Pick<Conversations, 'reach'>
  private readonly feeds: FamilyFeeds
  private readonly place: MapPlace
  private readonly disposed: () => void
  private readonly sighted: () => void
  private readonly selectionChanged: () => void
  /** `h` from a row: off the page, back where it was opened from. */
  leave?: () => void
  /** Each unfolded document, by thread, kept across repaints so a page holds its place. */
  private readonly embedded = new Map<string, EmbeddedDocument & { doc: DocKey }>()

  /**
   * `conversations` moves Rex quietly to a thread's existing window;
   * `sighted` hears the selection move.
   */
  constructor(conversations: Pick<Conversations, 'reach'>, feeds: FamilyFeeds, place: MapPlace, disposed: () => void, sighted: () => void = () => {}, selectionChanged: () => void = () => {}) {
    this.conversations = conversations; this.feeds = feeds; this.place = place; this.disposed = disposed; this.sighted = sighted; this.selectionChanged = selectionChanged
    this.place.docs ??= new Map()
    this.tree.setAttribute('role', 'tree')
    this.tree.setAttribute('aria-label', 'The constitution and its threads, most urgent first')
    this.announcement.setAttribute('aria-live', 'polite')
    this.scroller.append(this.tree)
    const grid = el('div', 'ws-family-grid')
    grid.append(this.scroller, this.announcement)
    this.el.append(grid)
    this.tree.addEventListener('click', event => this.clicked(event))
    this.tree.addEventListener('keydown', event => this.key(event))
    bindDrawnPage(this.el, { suspend: () => this.suspend(), resume: () => this.resume(), dispose: () => this.dispose() })
  }

  update(card: KanbanCard, index: ThreadIndex, now = Date.now()): void {
    this.scope = { index, card }
    if (!this.awake) return
    this.feeds.refresh()
    const current = index.card(card), root = index.family(current).root, cards = [root, ...index.subtree(root)]
    const signature = JSON.stringify([threadKey(card), Math.floor(now / 60_000), cards, cards.map(thread => this.feeds.files(thread))])
    if (signature === this.signature) return
    this.signature = signature
    this.model = familyModel(index, root, current, this.feeds, now)
    this.under = underAll(this.model)
    const landing = [...this.model.threads.values()].find(thread => fiberOf(thread.card) === this.place.landing)
    if (landing && this.landed !== `${landing.key}@${fiberOf(root)}`) this.land(landing)
    else this.paint()
  }
  /** Takes the keys, on the selected row. */
  focus(): void { this.row(this.selectedKey)?.focus({ preventScroll: true }) }

  /** Shows the thread Rex moved to, leaving Rex be; false when it is not of this family. */
  flyTo(card: KanbanCard): boolean {
    const thread = this.model?.threads.get(threadKey(card))
    if (!thread) return false
    this.place.worker = thread.key
    this.place.landing = fiberOf(thread.card)
    this.land(thread)
    return true
  }
  /**
   * Unfolds the selected thread's tapestry, else its newest file, under its
   * row, or folds it, once the tapestry's read has landed. A page whose
   * selection has moved by then does nothing.
   */
  toggleLead(): void {
    const at = this.leadThread
    if (!at) return
    this.readLead(at)
    void this.leads.get(at.key)!.read.then(() => {
      const thread = this.leadThread
      if (!this.awake || thread?.key !== at.key) return
      const file = this.leadOf(thread) ?? thread.files[0]
      if (file) this.toggleDoc(thread, file.key)
    })
  }
  /** The thread the page rests on, which voice follows: the thread last entered, else the constitution heading it. */
  get settled(): KanbanCard | undefined { return (this.model?.threads.get(this.place.entered ?? '') ?? this.model?.root)?.card }
  /** The highlighted thread, excluding the head and the set-aside fold. */
  get selection(): KanbanCard | undefined { return this.place.selected ? this.model?.threads.get(this.place.selected)?.card : undefined }

  private get selectedKey(): string | null { return this.place.selected ?? this.model?.root.key ?? null }
  private get selectedThread(): MapThread | undefined { return this.model?.threads.get(this.selectedKey ?? '') }
  private get leadThread(): MapThread | undefined { return this.selectedThread ?? this.model?.root }
  private row(key: string | null): HTMLElement | undefined { return key ? this.rows.get(key) : undefined }
  /** A thread's tapestry or report: its fiber directory's, else the newest sent file named for one. */
  private leadOf(thread: MapThread): MapFile | undefined {
    const sent = thread.files.find(file => LEAD_NAME.test(file.name))
    return this.leads.get(thread.key)?.file ?? (sent && { ...sent, name: /^tapestry/i.test(sent.name) ? 'Tapestry' : 'Report' })
  }

  /**
   * Scrolls the page alone to a row, to its top or just into view: a row's own
   * scrollIntoView would also slide the reader's page track under it.
   */
  private reveal(row: HTMLElement, top: boolean): void {
    const view = this.scroller.getBoundingClientRect(), box = row.getBoundingClientRect(), margin = 8
    if (top || box.top < view.top) this.scroller.scrollTop += box.top - view.top - margin
    else if (box.bottom > view.bottom) this.scroller.scrollTop += Math.min(box.bottom - view.bottom + margin, box.top - view.top - margin)
  }
  /** Comes to a thread: every fold above it opens, it unfolds, and it is selected and scrolled to. */
  private land(thread: MapThread): void {
    this.landed = `${thread.key}@${fiberOf(this.model!.root.card)}`
    for (const key of opening(this.model!, thread.key, this.under)) this.place.open.add(key)
    this.place.selected = thread === this.model!.root ? null : thread.key
    this.place.entered = thread.key
    this.paint()
    const row = this.row(thread.key)
    if (row && thread !== this.model!.root) this.reveal(row, true)
    this.sighted()
    this.selectionChanged()
  }

  private paint(): void {
    const model = this.model
    if (!model) return
    this.lines = outline(model, this.place.open, this.under)
    const keys = new Set([model.root.key, ...this.lines.map(line => line.key)])
    const lostSelection = this.place.selected !== null && !keys.has(this.place.selected)
    if (lostSelection) this.place.selected = null
    const order = [this.fillHead(model.root), ...this.lines.map(line => this.fill(line))]
    for (const [key, row] of this.rows) if (!keys.has(key)) { row.remove(); this.rows.delete(key) }
    for (const key of this.embedded.keys()) if (!keys.has(key)) this.dropDoc(key)
    order.forEach((row, n) => { if (this.tree.children[n] !== row) this.tree.insertBefore(row, this.tree.children[n] ?? null) })
    this.markSelected()
    if (lostSelection) this.selectionChanged()
    for (const thread of [model.root, ...this.lines.flatMap(line => line.kind === 'thread' ? [line.thread] : [])]) this.readLead(thread)
  }
  private made(key: string, make: () => HTMLElement): HTMLElement {
    let row = this.rows.get(key)
    if (!row) { row = make(); row.dataset.row = key; this.rows.set(key, row) }
    return row
  }
  private fillHead(thread: MapThread): HTMLElement {
    const row = this.made(thread.key, () => this.makeRow('fp-row fp-head'))
    this.fillThread(row, thread, thread.tone, true)
    row.setAttribute('aria-level', '1')
    return row
  }
  private fill(line: Line): HTMLElement {
    if (line.kind === 'section') {
      const head = this.made(line.key, () => { const head = el('div', 'fp-section', SECTION_WORD[line.section]); head.setAttribute('role', 'presentation'); return head })
      head.dataset.standing = line.section
      return head
    }
    const row = line.kind === 'aside' ? this.made(line.key, () => {
      const row = el('div', 'fp-aside'); row.setAttribute('role', 'treeitem'); row.tabIndex = -1
      row.append(el('span', 'fp-aside-words'))
      return row
    }) : this.made(line.key, () => this.makeRow('fp-row'))
    row.dataset.level = line.kind === 'aside' ? line.owner : line.thread.parent!
    row.setAttribute('aria-expanded', String(line.open))
    row.setAttribute('aria-level', String(line.level + 2))
    row.style.setProperty('--fp-level', String(line.level))
    if (line.kind === 'aside') {
      const words = new Map<string, number>()
      for (const thread of line.threads) words.set(thread.word, (words.get(thread.word) ?? 0) + 1)
      row.querySelector('.fp-aside-words')!.textContent = [...words].map(([word, n]) => `${n} ${ASIDE_WORDS[word]?.[n === 1 ? 0 : 1] ?? word}`).join(' · ')
      return row
    }
    this.fillThread(row, line.thread, line.section ?? 'aside', line.open)
    // The family's own threads sit under a divider that already names their kind, so their meta is the age alone.
    if (line.level === 0 && line.section) row.querySelector('.fp-meta')!.textContent = shortAgo(line.thread.lastMove, this.model!.now)
    const { threads, asks } = this.under.get(line.thread.key)!
    row.querySelector('.fp-count')!.textContent = !threads ? '' : asks ? `${asks} of ${threads} ask` : `${threads} ${threads === 1 ? 'thread' : 'threads'}`
    return row
  }
  private makeRow(cls: string): HTMLElement {
    const row = el('div', cls); row.setAttribute('role', 'treeitem'); row.tabIndex = -1
    const title = el('div', 'fp-title')
    title.append(markSvg('fp-mark', 'working'), el('span', 'fp-name'), el('span', 'fp-docs'), el('span', 'fp-meta'), el('span', 'fp-count'))
    row.append(title, el('p', 'fp-note'), el('div', 'fp-files'), el('div', 'fp-doc'))
    return row
  }
  /** A thread's row: one mark, the state its section says; its slug, the name in its tooltip as on the Desk; what it holds; its last move; what it came to or asks. */
  private fillThread(row: HTMLElement, thread: MapThread, standing: Standing, open: boolean): void {
    const model = this.model!
    row.dataset.thread = thread.key
    row.dataset.standing = standing
    row.toggleAttribute('data-open', open)
    row.toggleAttribute('data-fresh', thread.fresh)
    row.toggleAttribute('data-worker', thread.key === this.place.worker)
    row.toggleAttribute('data-current', thread.key === model.current)
    row.querySelector('.fp-mark path')!.setAttribute('d', markPath(standing, 4.5))
    const name = row.querySelector<HTMLElement>('.fp-name')!
    name.textContent = thread === model.root ? thread.name : slug(thread.card)
    name.title = thread.name
    row.querySelector('.fp-meta')!.textContent = standingLine(thread, model.now) || shortAgo(thread.lastMove, model.now)
    const note = row.querySelector<HTMLElement>('.fp-note')!
    note.textContent = thread.note
    note.hidden = !thread.note
    row.setAttribute('aria-label', [thread.name, thread.word].filter(Boolean).join(', '))
    this.fillDocs(row, thread)
    this.seatDoc(row.querySelector<HTMLElement>('.fp-doc')!, thread)
  }
  /**
   * What a thread holds, on its row in the one order every surface keeps, in
   * the mod's glyphs: ⌗ its tapestry or report, ☰ its constitution, ⧉ n its
   * sent files, which unfold as a list, newest first.
   */
  private fillDocs(row: HTMLElement, thread: MapThread): void {
    const lead = this.leadOf(thread), shown = this.place.docs!.get(thread.key)
    const files = thread.files.filter(file => file.key !== lead?.key)
    const listed = this.place.open.has(`files:${thread.key}`) && files.length > 0
    const shape = JSON.stringify([lead?.key, lead?.unread, files.map(file => [file.key, file.unread]), listed, shown, Math.floor(this.model!.now / 60_000)])
    const docs = row.querySelector<HTMLElement>('.fp-docs')!, list = row.querySelector<HTMLElement>('.fp-files')!
    list.hidden = !listed
    if (docs.dataset.shape === shape) return
    docs.dataset.shape = shape
    const chip = (cls: string, glyph: string, label: string, held?: string): HTMLButtonElement => {
      const button = el('button', `fp-chip ${cls}`, glyph); button.type = 'button'
      button.title = label; button.setAttribute('aria-label', label)
      button.dataset.owner = button.dataset.level = thread.key
      if (held) { button.dataset.held = held; button.setAttribute('aria-pressed', String(held === shown)) }
      return button
    }
    const chips: HTMLElement[] = []
    if (lead) chips.push(chip('fp-lead', '⌗', lead.name, lead.key))
    if (thread.card.path) chips.push(chip('fp-constitution', '☰', 'Constitution', fiberKey(thread.card.originId, thread.card.uid ?? thread.card.id)))
    if (files.length) {
      const all = chip('fp-sent', `⧉ ${files.length}`, `${files.length} sent ${files.length === 1 ? 'file' : 'files'}`)
      all.dataset.files = thread.key
      all.setAttribute('aria-expanded', String(listed))
      chips.push(all)
    }
    for (const [n, file] of [lead, ...files].entries()) if (file?.unread) chips[n === 0 ? 0 : chips.length - 1]?.toggleAttribute('data-unread', true)
    docs.replaceChildren(...chips)
    list.replaceChildren(...(listed ? files : []).map(file => {
      const item = el('button', 'fp-file'); item.type = 'button'
      item.dataset.held = file.key; item.dataset.owner = item.dataset.level = thread.key
      item.setAttribute('aria-pressed', String(file.key === shown))
      item.toggleAttribute('data-unread', file.unread)
      item.append(el('span', 'fp-file-name', file.name))
      if (file.at) item.append(el('span', 'fp-file-age', shortAgo(file.at, this.model!.now)))
      return item
    }))
  }
  /** The document the thread has unfolded, drawn under its row. */
  private seatDoc(slot: HTMLElement, thread: MapThread): void {
    const want = this.place.docs!.get(thread.key)
    let shown = this.embedded.get(thread.key)
    if (shown && shown.doc !== want) { this.dropDoc(thread.key); shown = undefined }
    if (want && !shown) {
      shown = { ...this.feeds.embed(thread.card, want), doc: want }
      this.embedded.set(thread.key, shown)
      slot.replaceChildren(shown.el)
    }
    slot.hidden = !shown
  }
  private dropDoc(key: string): void {
    const shown = this.embedded.get(key)
    if (!shown) return
    shown.dispose()
    shown.el.remove()
    this.embedded.delete(key)
  }
  /** A chip's document unfolds under its row, or folds; either enters the thread. */
  private toggleDoc(thread: MapThread, doc: DocKey): void {
    const docs = this.place.docs!
    if (docs.get(thread.key) === doc) docs.delete(thread.key)
    else docs.set(thread.key, doc)
    this.enter(thread.key)
    this.paint()
    const row = this.row(thread.key)
    if (row && docs.has(thread.key)) this.reveal(row, true)
  }
  private markSelected(): void {
    const selected = this.selectedKey
    for (const [key, row] of this.rows) {
      if (row.getAttribute('role') !== 'treeitem') continue
      const on = key === selected
      row.toggleAttribute('data-selected', on)
      row.setAttribute('aria-selected', String(on))
      row.tabIndex = on ? 0 : -1
    }
  }
  /** Reads a thread's tapestry once, repainting what it holds when it lands. */
  private readLead(thread: MapThread): void {
    if (this.leads.has(thread.key)) return
    const entry: { read: Promise<MapFile | undefined>; file?: MapFile } = {
      read: this.feeds.lead(thread.card).then(lead => {
        entry.file = lead
        if (lead && this.awake) this.paint()
        return lead
      }),
    }
    this.leads.set(thread.key, entry)
  }

  private clicked(event: MouseEvent): void {
    const target = event.target as Element, model = this.model
    if (!model || event.detail > 1 || target.closest('.fp-doc')) return
    const held = target.closest<HTMLElement>('[data-held]'), files = target.closest<HTMLElement>('[data-files]')
    if (held) { this.toggleDoc(model.threads.get(held.dataset.owner!)!, held.dataset.held!); return }
    if (files) { this.select(files.dataset.files!); this.toggle(`files:${files.dataset.files}`); return }
    const key = target.closest<HTMLElement>('[role="treeitem"]')?.dataset.row
    if (key) this.activate(key)
  }
  /** A click or Enter: a thread's row unfolds or folds and is entered; the fold of threads set aside opens or closes; the head is entered. */
  private activate(key: string): void {
    const model = this.model!, thread = model.threads.get(key)
    this.select(key)
    if (thread && thread !== model.root) this.toggle(key)
    else if (!thread) { this.toggle(key); return }
    this.enter(key)
  }
  private toggle(key: string): void {
    if (!this.place.open.delete(key)) this.place.open.add(key)
    this.paint()
    this.focus()
  }
  /** Entering a thread commits to it: voice follows it, and Rex moves quietly to its worker's window. */
  private enter(key: string): void {
    const thread = this.model!.threads.get(key)
    if (!thread || this.place.entered === key) return
    this.place.entered = key
    this.sighted()
    void this.conversations.reach(thread.card).then(moved => {
      if (!moved) return
      this.place.worker = thread.key
      if (this.awake) this.paint()
    })
  }
  /** The highlight: what `c` opens and the keys move from; it commits to nothing. */
  private select(key: string): void {
    if (key === this.selectedKey) return
    this.place.selected = key === this.model?.root.key ? null : key
    this.markSelected()
    this.selectionChanged()
  }
  /** Escape: folds the open row the selection sits in, selecting it; false when nothing is open around it. */
  foldOut(): boolean {
    const model = this.model!
    for (let at = model.threads.get(this.selectedKey ?? ''); at && at !== model.root; at = at.parent ? model.threads.get(at.parent) : undefined) {
      if (!this.place.open.has(at.key)) continue
      this.select(at.key)
      this.toggle(at.key)
      return true
    }
    return false
  }
  /**
   * One vim grammar, depth along h and l. j and k (or down and up) move the
   * highlight among the rows, never committing; on a row's documents they
   * step among them. l (or right) goes in: from a row to its documents, entering
   * the thread, and from a document to its page unfolded under the row (⧉ n
   * lists the sent files). h (or left) goes out: from a document to its row,
   * folding what it had unfolded, and from a row back off the page. Enter does
   * what a click does.
   */
  private key(event: KeyboardEvent): void {
    const model = this.model, target = event.target as HTMLElement
    if (!model || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const item = target.closest<HTMLElement>('[data-row], [data-level]')
    if (!item || item.closest('.fp-doc')) return
    const onRow = item.getAttribute('role') === 'treeitem', owner = onRow ? item.dataset.row! : item.dataset.level!
    const thread = model.threads.get(owner)
    const docs = (): HTMLElement[] => [...(this.row(owner)?.querySelectorAll<HTMLElement>('.fp-docs button, .fp-files:not([hidden]) button') ?? [])]
    let next: HTMLElement | undefined
    const step = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 }[event.key]
    if (step) {
      const peers = onRow ? [...this.tree.querySelectorAll<HTMLElement>('[role="treeitem"]')] : docs()
      next = peers[peers.indexOf(item) + step]
    } else if (event.key === 'l' || event.key === 'ArrowRight') {
      if (onRow && thread) { this.enter(owner); next = docs()[0]; if (!next && !this.place.open.has(owner) && thread !== model.root) this.toggle(owner) }
      else if (onRow) { this.toggle(owner); return void event.preventDefault() }
      else if (item.dataset.files && !this.place.open.has(`files:${owner}`)) { this.toggle(`files:${owner}`); next = docs().find(doc => doc.closest('.fp-files')) }
      else if (item.dataset.held && thread && this.place.docs!.get(owner) !== item.dataset.held) { this.toggleDoc(thread, item.dataset.held); next = this.findDoc(owner, item.dataset.held) }
      else return void event.preventDefault()
    } else if (event.key === 'h' || event.key === 'ArrowLeft') {
      if (onRow) { event.preventDefault(); this.leave?.(); return }
      const listed = !!item.closest('.fp-files')
      this.place.docs!.delete(owner)
      if (listed) this.place.open.delete(`files:${owner}`)
      this.paint()
      next = this.row(owner)
    } else if ((event.key === 'Enter' || event.key === ' ') && onRow) {
      event.preventDefault()
      this.activate(owner)
      return
    } else return
    event.preventDefault()
    if (!next) return
    if (next.dataset.row) this.select(next.dataset.row)
    next.focus({ preventScroll: true })
    this.reveal(next, false)
    const at = next.dataset.row ? model.threads.get(next.dataset.row) : undefined
    this.announcement.textContent = at ? [at.name, at.note].filter(Boolean).join('. ') : next.title || next.textContent || ''
  }
  private findDoc(owner: string, held: string): HTMLElement | undefined {
    return [...(this.row(owner)?.querySelectorAll<HTMLElement>('[data-held]') ?? [])].find(doc => doc.dataset.held === held)
  }

  /** The page stops where it is, reading and drawing nothing, until its frame is selected again. */
  private suspend(): void { this.awake = false }
  private resume(): void {
    this.awake = true
    if (this.scope) this.update(this.scope.card, this.scope.index)
  }
  dispose(): void {
    this.suspend()
    for (const key of [...this.embedded.keys()]) this.dropDoc(key)
    this.disposed()
  }
}
