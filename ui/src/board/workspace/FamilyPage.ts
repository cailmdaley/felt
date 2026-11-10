import type { KanbanCard } from '../KanbanTypes.js'
import { familyModel, type FamilyModel, type MapFeeds, type MapFile, type MapThread } from '../family/model.js'
import { htmlEl as el, markPath, markSvg } from '../family/drawing.js'
import { age } from '../civilDay.js'
import { ASIDE_SECTIONS, SECTION_WORD, opening, outline, tally, underAll, type AsideSection, type Line, type Under } from '../family/outline.js'
import { bindDrawnPage } from '../FileViewerPanel.js'
import type { Conversations } from '../conversationOpening.js'
import { threadKey, threadState, type ThreadIndex } from '../threads.js'
import { fiberKey, parseDocKey, type DocKey } from './documents.js'
import { slug } from '../threadOutline.js'
import type { FiberActs } from './Dock.js'
import { SENT_ICON, sendLines, type Send, type SentFile } from './sendLines.js'
import { headerIcon, type HeaderIcon } from './headerIcon.js'
import { Thumbnail } from './Thumbnail.js'
import './family-page.css'

/** A sent file that is a thread's tapestry or report when its fiber's directory holds none. */
const LEAD_NAME = /^(tapestry|report)\.html$/i
/** The sends a row's list shows before the older ones fold behind a count. */
const SHOWN_SENDS = 5
/** The height a sent figure is drawn at on its send's line, in px. */
const THUMB_HEIGHT = 44
/** The most marks a row's tally draws before the rest join the count. */
const TALLY_MARKS = 16
/** How the fold of threads set aside names each kind, one and many. */
const ASIDE_WORDS: Readonly<Record<AsideSection, readonly [string, string]>> = {
  resting: ['resting', 'resting'], drafts: ['draft', 'drafts'], roles: ['seat', 'seats'], archived: ['archived', 'archived'],
}

/** A sent file's mark, drawn on the acts' stroke grid in the view control's vocabulary. */
const fileIcon = (mark: SentFile['mark']): HTMLElement => {
  const icon = el('span', 'fp-file-glyph'); icon.dataset.mark = mark; icon.innerHTML = headerIcon(SENT_ICON[mark]); return icon
}

/** What the page reads, and how to ask for it again. */
export interface FamilyFeeds extends MapFeeds {
  refresh(): void
  /** The thread's tapestry or report, read when the page shows what the thread holds. */
  lead(card: KanbanCard): Promise<MapFile | undefined>
  /** One of a thread's documents drawn at its full height, for the page to hold in its own scroll. */
  embed(card: KanbanCard, doc: DocKey): EmbeddedDocument
  /** Records that the human has seen these files. */
  seen(files: readonly MapFile[]): void
  /** The short name of the fiber whose directory holds a path. */
  fiberAt(path: string): string | undefined
  /** Where the daemon serves files from, for a sent figure's thumbnail. */
  shuttleBase: string
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
  /** A lone constitution's tapestry has been unfolded for it once; folding it then holds. */
  leadShown?: boolean
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
 * unfolds it to what it holds (tapestry or report, constitution, sends
 * newest first) and its own threads, laid out the same way, and a second
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
  /** Draws a fiber's acts for its row; the band owns what they do. */
  private readonly actsFor?: (target: () => KanbanCard) => FiberActs
  /** Each row's acts, by thread. */
  private readonly acts = new Map<string, FiberActs>()
  /** `h` from a row: off the page, back where it was opened from. */
  leave?: () => void
  /** Each unfolded document, by thread, kept across repaints so a page holds its place. */
  private readonly embedded = new Map<string, EmbeddedDocument & { doc: DocKey }>()
  /** Each thread's sent figures, by file, kept while its list is open so going back to it draws them at once. */
  private readonly thumbs = new Map<string, Map<string, Thumbnail>>()

  /**
   * `conversations` moves Rex quietly to a thread's existing window;
   * `sighted` hears the selection move.
   */
  constructor(conversations: Pick<Conversations, 'reach'>, feeds: FamilyFeeds, place: MapPlace, disposed: () => void, sighted: () => void = () => {}, selectionChanged: () => void = () => {}, actsFor?: (target: () => KanbanCard) => FiberActs) {
    this.conversations = conversations; this.feeds = feeds; this.place = place; this.disposed = disposed; this.sighted = sighted; this.selectionChanged = selectionChanged; this.actsFor = actsFor
    this.place.docs ??= new Map()
    this.tree.setAttribute('role', 'tree')
    this.tree.setAttribute('aria-label', 'The constitution and its threads, most urgent first')
    this.announcement.setAttribute('aria-live', 'polite')
    this.scroller.append(this.tree)
    const grid = el('div', 'ws-family-grid')
    grid.append(this.scroller, this.announcement)
    this.el.append(grid)
    this.tree.addEventListener('click', event => this.clicked(event))
    // A row's act highlights its row before it acts, so the band and keys follow the fiber acted on.
    this.tree.addEventListener('click', event => {
      const key = (event.target as Element).closest('.fp-verbs')?.closest<HTMLElement>('[role="treeitem"]')?.dataset.row
      if (key) this.select(key)
    }, true)
    this.tree.addEventListener('keydown', event => this.key(event))
    this.scroller.addEventListener('scroll', () => this.easeHold(), { passive: true })
    bindDrawnPage(this.el, { suspend: () => this.suspend(), resume: () => this.resume(), dispose: () => this.dispose() })
  }

  update(card: KanbanCard, index: ThreadIndex, now = Date.now()): void {
    this.scope = { index, card }
    if (!this.awake) return
    this.feeds.refresh()
    const root = index.family(index.card(card)).root, cards = [root, ...index.subtree(root)]
    const signature = JSON.stringify([threadKey(card), Math.floor(now / 60_000), cards, cards.map(thread => this.feeds.files(thread))])
    if (signature === this.signature) return
    this.signature = signature
    this.model = familyModel(index, root, this.feeds, now)
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
  /** Highlights a thread of this family, as a click on its row would before acting. */
  choose(card: KanbanCard): void {
    const thread = this.model?.threads.get(threadKey(card))
    if (thread) this.select(thread.key)
  }
  /** The thread the page rests on, which voice follows: the thread last entered, else the constitution heading it. */
  get settled(): KanbanCard | undefined { return (this.model?.threads.get(this.place.entered ?? '') ?? this.model?.root)?.card }
  /** The highlighted thread, the head included; undefined on the set-aside fold. */
  get selection(): KanbanCard | undefined { return this.selectedThread?.card }
  /** `b`: the highlight climbs to the selected thread's orchestrator; false at the head. */
  selectParent(): boolean {
    const parent = this.selectedThread?.parent
    if (!parent) return false
    this.select(parent)
    const row = this.row(parent)
    if (row) { row.focus({ preventScroll: true }); this.reveal(row, false) }
    return true
  }

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
   * Scrolls the page alone to a row or document, to its top or just into view:
   * an element's own scrollIntoView would also slide the reader's page track under it.
   */
  private reveal(row: HTMLElement, top: boolean, margin = 8): void {
    const view = this.scroller.getBoundingClientRect(), box = row.getBoundingClientRect()
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
    this.unfoldLone(model)
    this.lines = outline(model, this.place.open, this.under)
    const keys = new Set([model.root.key, ...this.lines.map(line => line.key)])
    const lostSelection = this.place.selected !== null && !keys.has(this.place.selected)
    if (lostSelection) this.place.selected = null
    const order = [this.fillHead(model.root), ...this.lines.map(line => this.fill(line))]
    for (const [key, row] of this.rows) if (!keys.has(key)) { row.remove(); this.rows.delete(key); this.dropActs(key) }
    for (const key of this.embedded.keys()) if (!keys.has(key)) this.dropDoc(key)
    for (const key of [...this.thumbs.keys()]) if (!keys.has(key)) this.keepThumbs(key, new Set())
    order.forEach((row, n) => { if (this.tree.children[n] !== row) this.tree.insertBefore(row, this.tree.children[n] ?? null) })
    this.markSelected()
    if (lostSelection) this.selectionChanged()
    for (const thread of [model.root, ...this.lines.flatMap(line => line.kind === 'thread' ? [line.thread] : [])]) this.readLead(thread)
  }
  /** A constitution with no threads opens on its tapestry, unfolded under its head, once. */
  private unfoldLone(model: FamilyModel): void {
    const lead = model.threads.size === 1 && !this.place.leadShown ? this.leadOf(model.root) : undefined
    if (!lead) return
    this.place.leadShown = true
    if (!this.place.docs!.has(model.root.key)) this.place.docs!.set(model.root.key, lead.key)
  }
  private made(key: string, make: () => HTMLElement): HTMLElement {
    let row = this.rows.get(key)
    if (!row) { row = make(); row.dataset.row = key; this.rows.set(key, row) }
    return row
  }
  private fillHead(thread: MapThread): HTMLElement {
    const row = this.made(thread.key, () => this.makeRow('fp-row fp-head'))
    this.fillThread(row, thread, true)
    row.setAttribute('aria-level', '1')
    return row
  }
  private fill(line: Line): HTMLElement {
    if (line.kind === 'section') {
      const head = this.made(line.key, () => { const head = el('div', 'fp-section', SECTION_WORD[line.section]); head.setAttribute('role', 'presentation'); return head })
      head.dataset.standing = line.section
      head.style.setProperty('--fp-level', String(line.level))
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
      const counts = ASIDE_SECTIONS.map(section => [section, line.threads.filter(thread => threadState(thread.card) === section).length] as const)
      row.querySelector('.fp-aside-words')!.textContent = counts.filter(([, n]) => n).map(([section, n]) => `${n} ${ASIDE_WORDS[section][n === 1 ? 0 : 1]}`).join(' · ')
      return row
    }
    this.fillThread(row, line.thread, line.open)
    this.fillTally(row.querySelector<HTMLElement>('.fp-count')!, line.thread.key)
    return row
  }
  /**
   * The live threads a row holds below it, drawn: a mark for each in its
   * section's shape and pigment, most urgent first, the rest joining a quiet
   * count. Threads set aside are not counted. The words stay for screen
   * readers and the tooltip.
   */
  private fillTally(count: HTMLElement, key: string): void {
    const { live, asks } = tally(this.model!, key)
    const words = !live.length ? '' : asks ? `${asks} of ${live.length} ask` : `${live.length} ${live.length === 1 ? 'thread' : 'threads'}`
    const shape = JSON.stringify(live)
    count.title = words
    count.setAttribute('aria-label', words)
    if (count.dataset.shape === shape) return
    count.dataset.shape = shape
    const shown = live.slice(0, TALLY_MARKS)
    const marks = shown.map(section => { const mark = el('span', 'fp-tally-mark'); mark.dataset.standing = section; mark.append(markSvg('fp-tally-svg', section, 3.6)); return mark })
    const more = live.length - shown.length
    count.replaceChildren(...marks, ...(more ? [el('span', 'fp-tally-more', `+${more}`)] : []))
  }
  private makeRow(cls: string): HTMLElement {
    const row = el('div', cls); row.setAttribute('role', 'treeitem'); row.tabIndex = -1
    const title = el('div', 'fp-title')
    title.append(markSvg('fp-mark', 'working'), el('span', 'fp-name'), el('span', 'fp-word'), el('span', 'fp-docs'), el('span', 'fp-verbs'), el('span', 'fp-meta'))
    // The row's own lines, which the worker's rail runs beside; what it holds unfolds below.
    const line = el('div', 'fp-line')
    line.append(title, el('p', 'fp-note'), el('span', 'fp-count'))
    row.append(line, el('div', 'fp-files'), el('div', 'fp-doc'))
    return row
  }
  /**
   * A thread's row: one mark, its own state, named in the mark's tooltip; its
   * slug, the name in its tooltip as on the Desk; a word only for a thread with
   * no worker (held, stopped, armed), which no mark tells apart; what it holds;
   * its verbs; at the very right, the newest move in it or under it, which
   * orders the rows of a section; below, what it came to or asks and the
   * threads it holds.
   */
  private fillThread(row: HTMLElement, thread: MapThread, open: boolean): void {
    const model = this.model!
    row.dataset.thread = thread.key
    row.dataset.standing = thread.tone
    row.toggleAttribute('data-open', open)
    row.toggleAttribute('data-worker', thread.key === this.place.worker)
    const mark = row.querySelector('.fp-mark')!
    mark.querySelector('path')!.setAttribute('d', markPath(thread.tone, 4.5))
    let tip = mark.querySelector<SVGTitleElement>('title')
    if (!tip) { tip = document.createElementNS('http://www.w3.org/2000/svg', 'title'); mark.prepend(tip) }
    tip.textContent = thread.word
    const name = row.querySelector<HTMLElement>('.fp-name')!
    name.textContent = thread === model.root ? thread.name : slug(thread.card)
    name.title = thread.name
    row.querySelector('.fp-word')!.textContent = thread.tone === 'still' ? thread.word : ''
    row.querySelector('.fp-meta')!.textContent = age(model.now - (this.under.get(thread.key)?.lastMove ?? thread.lastMove))
    const note = row.querySelector<HTMLElement>('.fp-note')!
    note.textContent = thread.note
    note.hidden = !thread.note
    row.setAttribute('aria-label', [thread.name, thread.word].filter(Boolean).join(', '))
    this.fillDocs(row, thread)
    this.fillActs(row.querySelector<HTMLElement>('.fp-verbs')!, thread.key)
    this.seatDoc(row.querySelector<HTMLElement>('.fp-doc')!, thread)
  }
  /**
   * The fiber's acts on its row: its lifecycle verbs, its conversation and its
   * settings, drawn by the band ({@link Dock.actsFor}) so a row and the band
   * never offer different sets. They show on the highlighted row, and under the
   * pointer; the others stay quiet.
   */
  private fillActs(slot: HTMLElement, key: string): void {
    if (!this.actsFor) return
    let acts = this.acts.get(key)
    if (!acts) {
      acts = this.actsFor(() => this.model!.threads.get(key)!.card)
      this.acts.set(key, acts)
    }
    // An act zone, as the band is: a channel theme's rules stop at the row's controls.
    slot.dataset.part = 'act'
    if (acts.el.parentElement !== slot) slot.replaceChildren(acts.el)
    acts.paint()
  }
  private dropActs(key: string): void {
    this.acts.get(key)?.dispose()
    this.acts.delete(key)
  }
  /**
   * What a thread holds, as one segmented control on its row, in the one order
   * every surface keeps: its tapestry or report, its constitution, and its sent
   * files with their count, which unfold under the row as its sends, newest
   * first. Only the segments a thread has are drawn, and the one open is
   * pressed. A sent file opened takes the list's place, with the way back to it
   * above.
   */
  private fillDocs(row: HTMLElement, thread: MapThread): void {
    const lead = this.leadOf(thread), shown = this.place.docs!.get(thread.key)
    const files = this.sentOf(thread), open = files.find(file => file.key === shown)
    const listed = this.place.open.has(`files:${thread.key}`) && files.length > 0, older = this.place.open.has(`older:${thread.key}`)
    const shape = JSON.stringify([lead?.key, lead?.unread, files.map(file => [file.key, file.unread]), listed, older, shown, Math.floor(this.model!.now / 60_000)])
    const docs = row.querySelector<HTMLElement>('.fp-docs')!, list = row.querySelector<HTMLElement>('.fp-files')!
    list.hidden = !listed && !open
    if (docs.dataset.shape === shape) return
    docs.dataset.shape = shape
    const chip = (cls: string, icon: HeaderIcon, label: string, held?: string, count?: number): HTMLButtonElement => {
      const button = el('button', `fp-chip ${cls}`); button.type = 'button'
      button.innerHTML = headerIcon(icon)
      if (count !== undefined) button.append(el('span', 'fp-chip-count', String(count)))
      button.title = label; button.setAttribute('aria-label', label)
      button.dataset.owner = button.dataset.level = thread.key
      if (held) { button.dataset.held = held; button.setAttribute('aria-pressed', String(held === shown)) }
      return button
    }
    const chips: HTMLElement[] = []
    if (lead) chips.push(chip('fp-lead', 'tapestry', lead.name, lead.key))
    if (thread.card.path) chips.push(chip('fp-constitution', 'constitution', 'Constitution', fiberKey(thread.card.originId, thread.card.uid ?? thread.card.id)))
    if (files.length) {
      const all = chip('fp-sent', 'sends', `${files.length} sent ${files.length === 1 ? 'file' : 'files'}`, undefined, files.length)
      all.dataset.files = thread.key
      all.setAttribute('aria-expanded', String(listed))
      chips.push(all)
    }
    for (const [n, file] of [lead, ...files].entries()) if (file?.unread) chips[n === 0 ? 0 : chips.length - 1]?.toggleAttribute('data-unread', true)
    docs.replaceChildren(...chips)
    const sends = listed || open ? sendLines(files, path => this.feeds.fiberAt(path)) : []
    if (open) list.replaceChildren(this.openBar(thread, sends, open))
    else {
      const drawn = older ? sends : sends.slice(0, SHOWN_SENDS)
      list.replaceChildren(...drawn.map(send => this.sendLine(thread, send)), ...this.olderToggle(thread, sends.length, older))
      this.keepThumbs(thread.key, new Set(drawn.flatMap(send => send.files.map(sent => sent.file.key))))
    }
  }
  /** A thread's sent files, which its tapestry or report leaves for its own chip. */
  private sentOf(thread: MapThread): MapFile[] {
    const lead = this.leadOf(thread)
    return thread.files.filter(file => file.key !== lead?.key)
  }
  /** One send: its age once, at the left, then what it carried, figures drawn small as themselves. */
  private sendLine(thread: MapThread, send: Send): HTMLElement {
    const line = el('div', 'fp-send')
    line.append(el('span', 'fp-send-age', age(this.model!.now - send.at)), ...send.files.map(sent => {
      const item = el('button', 'fp-file'); item.type = 'button'
      item.dataset.held = sent.file.key; item.dataset.owner = item.dataset.level = thread.key
      item.title = sent.label; item.setAttribute('aria-label', sent.label)
      item.toggleAttribute('data-unread', sent.file.unread)
      if (sent.mark === 'image') { item.classList.add('fp-file-image'); item.append(this.thumbOf(thread.key, sent).el) }
      else item.append(fileIcon(sent.mark), el('span', 'fp-file-name', sent.label))
      return item
    }))
    return line
  }
  /** The count of older sends, which unfolds them, or the word that folds them again. */
  private olderToggle(thread: MapThread, sends: number, older: boolean): HTMLElement[] {
    const rest = sends - SHOWN_SENDS
    if (rest <= 0) return []
    const toggle = el('button', 'fp-older', older ? 'fewer' : `${rest} older ${rest === 1 ? 'send' : 'sends'}`); toggle.type = 'button'
    toggle.dataset.older = toggle.dataset.level = thread.key
    toggle.setAttribute('aria-expanded', String(older))
    return [toggle]
  }
  /** The open sent file's bar: back to the sends, its name and age, and the files either side of it. */
  private openBar(thread: MapThread, sends: Send[], open: MapFile): HTMLElement {
    const all = sends.flatMap(send => send.files), at = all.findIndex(sent => sent.file.key === open.key), sent = all[at]
    const bar = el('div', 'fp-open')
    const button = (cls: string, glyph: string, label: string): HTMLButtonElement => {
      const button = el('button', cls, glyph); button.type = 'button'
      button.title = label; button.setAttribute('aria-label', label)
      button.dataset.owner = button.dataset.level = thread.key
      return button
    }
    const back = button('fp-back', '← sends', 'Back to the sends'); back.dataset.back = thread.key
    const name = el('span', 'fp-open-name')
    name.append(fileIcon(sent.mark), el('span', 'fp-file-name', sent.label))
    name.title = sent.label
    const step = (by: number, glyph: string, word: string): HTMLButtonElement => {
      const to = all[at + by], move = button('fp-step', glyph, to ? `${word}: ${to.label}` : word)
      if (to) move.dataset.held = to.file.key
      else move.disabled = true
      return move
    }
    bar.append(back, name, el('span', 'fp-send-age', age(this.model!.now - open.at)), step(-1, '‹', 'Newer'), el('span', 'fp-open-count', `${at + 1} of ${all.length}`), step(1, '›', 'Older'))
    return bar
  }
  /** A sent figure's thumbnail, made once while its row's list is open. */
  private thumbOf(owner: string, sent: SentFile): Thumbnail {
    const kept = this.thumbs.get(owner) ?? new Map<string, Thumbnail>()
    this.thumbs.set(owner, kept)
    let thumb = kept.get(sent.file.key)
    if (thumb) return thumb
    const file = parseDocKey(sent.file.key)!
    const made: Thumbnail = thumb = new Thumbnail({
      key: `family:${sent.file.key}`, shuttleBase: this.feeds.shuttleBase, className: 'fp-thumb', fallback: sent.label, captioned: true,
      file: { fullPath: file.path, owner: file.owner, basename: sent.label },
      priority: () => this.awake && made.el.isConnected && !made.el.closest('[hidden]') ? 2 : 0,
      distance: () => 0,
      onAspect: aspect => { made.el.style.width = `${Math.round(Math.min(Math.max(aspect, .6), 2.4) * THUMB_HEIGHT)}px` },
    })
    kept.set(sent.file.key, thumb)
    return thumb
  }
  /** Lets go of a row's figures its list no longer draws; an empty set lets go of them all. */
  private keepThumbs(owner: string, drawn: ReadonlySet<string>): void {
    const kept = this.thumbs.get(owner)
    if (!kept) return
    for (const [key, thumb] of kept) if (!drawn.has(key)) { thumb.dispose(); kept.delete(key) }
    if (!kept.size) this.thumbs.delete(owner)
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
  /**
   * A chip's document unfolds under its row, selecting and entering the thread,
   * and the page stays where it is: only a slot that would open wholly out of
   * view is scrolled into it. A document taking another's place keeps the page's
   * offset whatever its height; folding one moves nothing else.
   */
  private toggleDoc(thread: MapThread, doc: DocKey): void {
    const docs = this.place.docs!
    if (docs.get(thread.key) === doc) {
      docs.delete(thread.key)
      this.paint()
      return
    }
    const replacing = docs.has(thread.key)
    if (replacing) this.hold()
    docs.set(thread.key, doc)
    this.select(thread.key)
    this.enter(thread.key)
    this.paint()
    this.notice(thread, [this.leadOf(thread), ...thread.files].filter(file => file?.key === doc) as MapFile[])
    const sent = this.sentOf(thread).some(file => file.key === doc)
    const slot = this.row(thread.key)?.querySelector<HTMLElement>(sent ? ':scope > .fp-files' : ':scope > .fp-doc')
    if (!slot || replacing) return
    const view = this.scroller.getBoundingClientRect(), box = slot.getBoundingClientRect()
    if (box.top >= view.bottom || box.bottom <= view.top) this.reveal(slot, false)
  }
  /** Keeps the page at least as tall as the view it is scrolled to, so a shorter document swapped in cannot pull it up. */
  private hold(): void {
    const view = this.scroller.getBoundingClientRect(), top = this.tree.getBoundingClientRect().top - view.top + this.scroller.scrollTop
    this.tree.style.minHeight = `${Math.ceil(this.scroller.scrollTop + this.scroller.clientHeight - top)}px`
  }
  /** The hold shrinks as the reader scrolls up, and lets go once the page no longer needs it. */
  private easeHold(): void {
    const held = parseFloat(this.tree.style.minHeight)
    if (!held) return
    const top = this.tree.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop
    const needed = Math.ceil(this.scroller.scrollTop + this.scroller.clientHeight - top)
    if (needed < held) this.tree.style.minHeight = needed > 0 ? `${needed}px` : ''
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
    if (!model || event.detail > 1 || target.closest('.fp-doc, .fp-verbs')) return
    const held = target.closest<HTMLElement>('[data-held]'), files = target.closest<HTMLElement>('[data-files]')
    const back = target.closest<HTMLElement>('[data-back]'), older = target.closest<HTMLElement>('[data-older]')
    if (back) { this.back(model.threads.get(back.dataset.back!)!); return }
    if (older) { this.toggleOlder(older.dataset.older!); return }
    if (held) { this.toggleDoc(model.threads.get(held.dataset.owner!)!, held.dataset.held!); return }
    if (files) { this.select(files.dataset.files!); this.toggleFiles(files.dataset.files!); return }
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
  /** A thread's sends list unfolds or folds; folding it folds a sent file open from it, and a cursor in it returns to the sends segment. */
  private toggleFiles(key: string): void {
    const list = this.row(key)?.querySelector<HTMLElement>('.fp-files'), thread = this.model!.threads.get(key)!
    const opened = this.sentOf(thread).some(file => file.key === this.place.docs!.get(key))
    if ((this.place.open.has(`files:${key}`) || opened) && list) {
      const within = list.contains(document.activeElement)
      if (opened) this.place.docs!.delete(key)
      this.place.open.delete(`files:${key}`)
      this.paint()
      if (within) this.row(key)?.querySelector<HTMLElement>('[data-files]')?.focus({ preventScroll: true })
      return
    }
    this.toggle(`files:${key}`)
  }
  /** A row's older sends unfold below its newest, or fold away again, the cursor staying on the toggle. */
  private toggleOlder(key: string): void {
    if (!this.place.open.delete(`older:${key}`)) this.place.open.add(`older:${key}`)
    this.paint()
    this.row(key)?.querySelector<HTMLElement>('[data-older]')?.focus({ preventScroll: true })
  }
  /** From a sent file open in the list's place, back to the list, its line for that file shown and under the cursor. */
  private back(thread: MapThread): void {
    const files = this.sentOf(thread), was = files.find(file => file.key === this.place.docs!.get(thread.key))
    this.place.docs!.delete(thread.key)
    this.place.open.add(`files:${thread.key}`)
    if (was && new Set(files.filter(file => file.at > was.at).map(file => file.at)).size >= SHOWN_SENDS) this.place.open.add(`older:${thread.key}`)
    this.paint()
    const item = was && this.findDoc(thread.key, was.key)
    if (!item) return
    item.focus({ preventScroll: true })
    this.reveal(item, false)
  }
  /** The sent file a step newer or older than the one open, opened in its place; the cursor stays on the way back. */
  private step(thread: MapThread, by: number): HTMLElement | undefined {
    const files = sendLines(this.sentOf(thread), () => undefined).flatMap(send => send.files.map(sent => sent.file))
    const to = files[files.findIndex(file => file.key === this.place.docs!.get(thread.key)) + by]
    if (to) this.toggleDoc(thread, to.key)
    return this.row(thread.key)?.querySelector<HTMLElement>('.fp-back') ?? undefined
  }
  private toggle(key: string): void {
    if (!this.place.open.delete(key)) this.place.open.add(key)
    this.paint()
    this.focus()
    // A sent-file list seen open counts its files as seen, without a click on each.
    const listed = key.startsWith('files:') && this.place.open.has(key) ? this.model?.threads.get(key.slice(6)) : undefined
    if (listed) this.notice(listed, listed.files)
  }
  /** The human has seen these files of a thread: their marks clear, here and wherever else they are drawn. */
  private notice(thread: MapThread, files: readonly MapFile[]): void {
    const unread = files.filter(file => file.unread)
    if (!unread.length) return
    this.feeds.seen(unread)
    const lead = this.leads.get(thread.key)?.file
    if (lead && unread.some(file => file.key === lead.key)) lead.unread = false
    this.signature = ''
    if (this.scope) this.update(this.scope.card, this.scope.index)
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
   * One vim grammar: rows along j and k, depth along h and l. j and k (or down
   * and up) move the highlight among the rows, never committing; from one of a
   * row's documents they move on from its row, leaving the document unfolded
   * there. l (or right) goes in: from a row it unfolds the first document under
   * the row, entering the thread, and from a document it unfolds the next in its
   * place (the sends segment lists the sent files and opens the newest); from a sent file in
   * the list it opens that file in the list's place. From an open sent file's
   * bar, l steps to the next older and h goes back to the list. h (or left)
   * otherwise goes out: from a document to its row, folding what it had
   * unfolded; from a row, it folds every document the page has unfolded, and
   * only a page with none unfolded is left. While a row has a sent file open,
   * left and right instead step to the newer and older file, as ‹ and › do.
   * Enter does what a click does.
   */
  private key(event: KeyboardEvent): void {
    const model = this.model, target = event.target as HTMLElement
    if (!model || target.closest('.fp-verbs') || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const item = target.closest<HTMLElement>('[data-row], [data-level]')
    if (!item || item.closest('.fp-doc')) return
    const onRow = item.getAttribute('role') === 'treeitem', owner = onRow ? item.dataset.row! : item.dataset.level!
    const thread = model.threads.get(owner)
    const docs = (): HTMLElement[] => [...(this.row(owner)?.querySelectorAll<HTMLElement>('.fp-docs button, .fp-files:not([hidden]) button') ?? [])]
    let next: HTMLElement | undefined
    const arrow = ({ ArrowLeft: -1, ArrowRight: 1 } as Record<string, number>)[event.key]
    if (thread && arrow && this.sentOf(thread).some(file => file.key === this.place.docs!.get(owner))) {
      event.preventDefault()
      const back = this.step(thread, arrow)
      if (!item.isConnected) back?.focus({ preventScroll: true })
      return
    }
    if (thread && (event.key === 'h' || event.key === 'l') && item.closest('.fp-open')) {
      event.preventDefault()
      if (event.key === 'h') return this.back(thread)
      this.step(thread, 1)?.focus({ preventScroll: true })
      return
    }
    const step = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 }[event.key]
    if (step) {
      const rows = [...this.tree.querySelectorAll<HTMLElement>('[role="treeitem"]')]
      next = rows[rows.indexOf(this.row(owner)!) + step]
    } else if (event.key === 'l' || event.key === 'ArrowRight') {
      if (onRow && !thread) { this.toggle(owner); return void event.preventDefault() }
      const chip = onRow ? docs()[0] : item.closest('.fp-send') ? item : docs()[docs().indexOf(item) + 1]
      if (chip) next = this.show(thread!, chip)
      else if (onRow) { this.enter(owner); if (!this.place.open.has(owner) && thread !== model.root) this.toggle(owner) }
      if (!next) return void event.preventDefault()
    } else if (event.key === 'h' || event.key === 'ArrowLeft') {
      if (onRow && !this.place.docs!.size) { event.preventDefault(); this.leave?.(); return }
      if (onRow) this.place.docs!.clear()
      else {
        this.place.docs!.delete(owner)
        if (item.closest('.fp-files')) this.place.open.delete(`files:${owner}`)
      }
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
  /** Unfolds a segment's document under its row (sends: its list, and the newest file), returning what to rest on: the segment, or an open sent file's way back. */
  private show(thread: MapThread, chip: HTMLElement): HTMLElement | undefined {
    if (chip.dataset.older) return
    if (chip.dataset.files) {
      if (!this.place.open.has(`files:${thread.key}`)) this.toggle(`files:${thread.key}`)
      const newest = sendLines(this.sentOf(thread), () => undefined)[0]?.files[0]
      return newest && this.unfold(thread, newest.file.key)
    }
    return this.unfold(thread, chip.dataset.held!)
  }
  private unfold(thread: MapThread, held: DocKey): HTMLElement | undefined {
    if (this.place.docs!.get(thread.key) !== held) this.toggleDoc(thread, held)
    else this.enter(thread.key)
    return this.findDoc(thread.key, held) ?? this.row(thread.key)?.querySelector<HTMLElement>('.fp-back') ?? undefined
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
    for (const key of [...this.thumbs.keys()]) this.keepThumbs(key, new Set())
    for (const key of [...this.acts.keys()]) this.dropActs(key)
    this.disposed()
  }
}
