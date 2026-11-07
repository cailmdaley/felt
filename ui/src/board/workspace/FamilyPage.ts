import type { KanbanCard } from '../KanbanTypes.js'
import { conversable, familyModel, type FamilyModel, type MapFeeds, type MapFile, type MapThread, type Standing } from '../family/model.js'
import { htmlEl as el, markPath, markSvg, shortAgo, standingLine } from '../family/drawing.js'
import { SECTIONS, SECTION_WORD, opening, outline, underAll, type Line, type Under } from '../family/outline.js'
import { bindDrawnPage } from '../FileViewerPanel.js'
import type { Conversations } from '../conversationOpening.js'
import { threadKey, type ThreadIndex } from '../threads.js'
import { fiberKey } from './documents.js'
import type { WorkerActions } from './workerActions.js'
import './family-page.css'

/** Sent files a thread shows before the earlier ones fold behind a count. */
const FILES = 8
/** A sent file that is a thread's tapestry or report when its fiber's directory holds none. */
const LEAD_NAME = /^(tapestry|report)\.html$/i
/** How the fold of threads set aside names each kind, one and many. */
const ASIDE_WORDS: Readonly<Record<string, readonly [string, string]>> = { drafts: ['draft', 'drafts'], seat: ['seat', 'seats'] }

/** What the page reads, and how to ask for it again. */
export interface FamilyFeeds extends MapFeeds {
  refresh(): void
  /** The thread's tapestry or report, read when the page shows what the thread holds. */
  lead(card: KanbanCard): Promise<MapFile | undefined>
}

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
}
const fiberOf = (card: KanbanCard): string => `${card.originId}:${card.uid ?? card.id}`
/** A page that lands on a fiber's row. */
export const placeAt = (card: KanbanCard): MapPlace => ({ open: new Set(), selected: null, landing: fiberOf(card) })

/**
 * A constitution's page: the family's root heads it with its outcome and what
 * it holds, and its threads follow as rows, the tree whole, siblings in the
 * order they ask for attention, then the threads set aside behind one fold.
 * A row leads with its name and what it came to (or what it asks); a click
 * unfolds it to what it holds (tapestry or report, constitution, sent files
 * oldest to newest) and its own threads, laid out the same way, and a second
 * click folds it. A click moves Rex quietly to the thread's worker; only
 * "Open in Rex" or `c` opens a conversation. It reads feeds and repaints only
 * while its frame is selected in an open reader; its frame's eviction ends it.
 */
export class FamilyPage {
  readonly el = el('div', 'ws-family-page family-map')
  private readonly counts = el('div', 'ws-family-counts')
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
  private readonly open: (card: KanbanCard, doc?: string) => void
  private readonly conversations: Conversations
  private readonly feeds: FamilyFeeds
  private readonly place: MapPlace
  private readonly disposed: () => void
  private readonly sighted: () => void
  /** Builds a thread's own worker line: its opening message, Resume and New session. */
  workerActions?: (card: KanbanCard) => WorkerActions
  /** Each unfolded thread's worker line, kept across repaints so a draft survives a poll. */
  private readonly actions = new Map<string, WorkerActions>()

  /**
   * `open` shows a page of a thread on the stage; `conversations` moves Rex
   * quietly to a thread's existing window or opens its conversation outright;
   * `sighted` hears the selection move.
   */
  constructor(open: (card: KanbanCard, doc?: string) => void, conversations: Conversations, feeds: FamilyFeeds, place: MapPlace, disposed: () => void, sighted: () => void = () => {}) {
    this.open = open; this.conversations = conversations; this.feeds = feeds; this.place = place; this.disposed = disposed; this.sighted = sighted
    this.tree.setAttribute('role', 'tree')
    this.tree.setAttribute('aria-label', 'The constitution and its threads, most urgent first')
    this.announcement.setAttribute('aria-live', 'polite')
    this.scroller.append(this.tree)
    const grid = el('div', 'ws-family-grid')
    grid.append(this.counts, this.scroller, this.announcement)
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
   * Hands `then` what `l` opens from the selected thread, its tapestry else its
   * newest file, once the tapestry's read has landed. A page whose selection
   * has moved by then hears nothing.
   */
  leading(then: (lead?: { card: KanbanCard; doc: string }) => void): void {
    const at = this.leadThread
    if (at) this.readLead(at)
    void Promise.resolve(at && this.leads.get(at.key)?.read).then(() => {
      const thread = this.leadThread
      if (!this.awake || thread?.key !== at?.key) return
      const file = (thread && this.leadOf(thread)) ?? thread?.files[0]
      then(thread && file ? { card: thread.card, doc: file.key } : undefined)
    })
  }
  /** The page has selected a thread other than its own. */
  get elsewhere(): boolean { return !!this.selectedThread && this.selectedThread.key !== this.model?.current }
  /** The thread the page rests on, which voice follows: the selected thread, else the constitution heading it. */
  get settled(): KanbanCard | undefined { return this.leadThread?.card }
  /** The thread the page has selected, which `c` opens the worker of. */
  get selection(): KanbanCard | undefined { return this.selectedThread?.card }

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
    this.paint()
    const row = this.row(thread.key)
    if (row && thread !== this.model!.root) this.reveal(row, true)
    this.sighted()
  }

  private paint(): void {
    const model = this.model
    if (!model) return
    // What asks across the family, by state; a lone constitution's head already says it.
    this.counts.replaceChildren(...SECTIONS.flatMap(section => {
      const n = [...model.threads.values()].filter(thread => thread.tone === section).length
      if (!n || section === 'still' || model.threads.size === 1) return []
      const count = el('span', 'ws-family-count'), word = SECTION_WORD[section].toLowerCase()
      count.dataset.standing = section
      count.append(markSvg('', section), `${n} ${n === 1 ? word.replace(/s$/, '') : word}`)
      return [count]
    }))
    this.lines = outline(model, this.place.open, this.under)
    const keys = new Set([model.root.key, ...this.lines.map(line => line.key)])
    if (!keys.has(this.place.selected ?? '')) this.place.selected = null
    const order = [this.fillHead(model.root), ...this.lines.map(line => this.fill(line))]
    for (const [key, row] of this.rows) if (!keys.has(key)) { row.remove(); this.rows.delete(key) }
    order.forEach((row, n) => { if (this.tree.children[n] !== row) this.tree.insertBefore(row, this.tree.children[n] ?? null) })
    this.markSelected()
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
    const { threads, asks } = this.under.get(line.thread.key)!
    row.querySelector('.fp-count')!.textContent = !threads ? '' : asks ? `${asks} of ${threads} ask` : `${threads} ${threads === 1 ? 'thread' : 'threads'}`
    return row
  }
  private makeRow(cls: string): HTMLElement {
    const row = el('div', cls); row.setAttribute('role', 'treeitem'); row.tabIndex = -1
    const title = el('div', 'fp-title')
    const lead = el('button', 'fp-lead'); lead.type = 'button'
    title.append(markSvg('fp-mark', 'working'), el('span', 'fp-name'), lead, el('span', 'fp-meta'), el('span', 'fp-count'))
    row.append(title, el('p', 'fp-note'), el('div', 'fp-held'))
    return row
  }
  /** A thread's row: one mark, the state its section says; its name, and its tapestry or report while folded; its own state and last move; what it came to or asks. */
  private fillThread(row: HTMLElement, thread: MapThread, standing: Standing, open: boolean): void {
    const model = this.model!
    row.dataset.thread = thread.key
    row.dataset.standing = standing
    row.toggleAttribute('data-open', open)
    row.toggleAttribute('data-fresh', thread.fresh)
    row.toggleAttribute('data-worker', thread.key === this.place.worker)
    row.toggleAttribute('data-current', thread.key === model.current)
    row.querySelector('.fp-mark path')!.setAttribute('d', markPath(standing, 4.5))
    row.querySelector('.fp-name')!.textContent = thread.name
    row.querySelector('.fp-meta')!.textContent = standingLine(thread, model.now) || shortAgo(thread.lastMove, model.now)
    const note = row.querySelector<HTMLElement>('.fp-note')!
    note.textContent = thread.note
    note.hidden = !thread.note
    row.setAttribute('aria-label', [thread.name, thread.word].filter(Boolean).join(', '))
    const lead = this.leadOf(thread), way = row.querySelector<HTMLButtonElement>('.fp-lead')!
    way.hidden = open || !lead
    if (lead) Object.assign(way.dataset, { held: lead.key, owner: thread.key })
    way.textContent = lead?.name ?? ''
    way.toggleAttribute('data-unread', !!lead?.unread)
    const held = row.querySelector<HTMLElement>('.fp-held')!
    held.hidden = !open
    if (open) this.fillHeld(held, thread)
    this.seatActions(held, thread, open)
  }
  /** An unfolded thread's own worker line ends what it holds; the page's own constitution has its line in the band. */
  private seatActions(held: HTMLElement, thread: MapThread, open: boolean): void {
    let line = this.actions.get(thread.key)
    if (!open || !this.workerActions || thread.key === this.model!.current) {
      line?.el.remove()
      return
    }
    if (!line) { line = this.workerActions(thread.card); this.actions.set(thread.key, line) }
    line.update(thread.card)
    if (line.el.parentElement !== held || held.lastElementChild !== line.el) held.append(line.el)
  }
  /** What a thread holds, in the one order every surface keeps: its tapestry or report, its constitution, its sent files oldest to newest. */
  private fillHeld(held: HTMLElement, thread: MapThread): void {
    const lead = this.leadOf(thread)
    const files = thread.files.filter(file => file.key !== lead?.key).reverse()
    const earlier = this.place.open.has(`earlier:${thread.key}`) ? 0 : Math.max(0, files.length - FILES)
    const shape = JSON.stringify([lead?.key, lead?.unread, files.map(file => [file.key, file.unread]), earlier, conversable(thread.card), Math.floor(this.model!.now / 60_000)])
    if (held.dataset.shape === shape) return
    held.dataset.shape = shape
    const way = (file: MapFile, kind: string): HTMLButtonElement => {
      const button = el('button', 'fp-file'); button.type = 'button'
      button.dataset.held = file.key; button.dataset.owner = thread.key; button.dataset.kind = kind; button.dataset.level = thread.key
      button.toggleAttribute('data-unread', file.unread)
      button.append(el('span', 'fp-file-name', file.name))
      if (file.at && kind === 'file') button.append(el('span', 'fp-file-age', shortAgo(file.at, this.model!.now)))
      return button
    }
    const items: HTMLElement[] = []
    if (lead) items.push(way(lead, 'lead'))
    if (thread.card.path) items.push(way({ key: fiberKey(thread.card.originId, thread.card.uid ?? thread.card.id), name: 'Constitution', at: 0, unread: false }, 'constitution'))
    if (earlier) {
      const more = el('button', 'fp-earlier', `${earlier} earlier`); more.type = 'button'
      more.dataset.earlier = more.dataset.level = thread.key
      items.push(more)
    }
    items.push(...files.slice(earlier).map(file => way(file, 'file')))
    if (conversable(thread.card)) {
      const rex = el('button', 'fp-converse', thread.card.terminalBackend === 'rex' ? 'Open in Rex' : 'Open conversation'); rex.type = 'button'
      rex.title = `${rex.textContent} · c`
      rex.dataset.converse = rex.dataset.level = thread.key
      items.push(rex)
    }
    held.replaceChildren(...items)
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
    if (!model || event.detail > 1 || target.closest('.ws-worker-acts')) return
    const held = target.closest<HTMLElement>('[data-held]'), earlier = target.closest<HTMLElement>('[data-earlier]'), rex = target.closest<HTMLElement>('[data-converse]')
    if (held) { this.open(model.threads.get(held.dataset.owner!)!.card, held.dataset.held); return }
    if (earlier) { this.toggle(`earlier:${earlier.dataset.earlier}`); return }
    if (rex) { this.chat(model.threads.get(rex.dataset.converse!)!); return }
    const key = target.closest<HTMLElement>('[role="treeitem"]')?.dataset.row
    if (key) this.activate(key)
  }
  /** A click or Enter: a thread's row unfolds and moves Rex quietly to its worker, or folds; the fold of threads set aside opens or closes; the head moves Rex. */
  private activate(key: string): void {
    const model = this.model!, thread = model.threads.get(key)
    this.select(key)
    if (thread === model.root) { this.quietly(thread); return }
    const unfolding = !this.place.open.has(key)
    this.toggle(key)
    if (thread && unfolding) this.quietly(thread)
  }
  private toggle(key: string): void {
    if (!this.place.open.delete(key)) this.place.open.add(key)
    this.paint()
    this.focus()
  }
  /** Moves Rex to the thread's worker without a new tab; the ring moves only if Rex moved. */
  private quietly(thread: MapThread): void {
    void this.conversations.reach(thread.card).then(moved => { if (moved) this.ring(thread) })
  }
  private chat(thread: MapThread): void {
    if (this.conversations.open(thread.card)) this.ring(thread)
  }
  private ring(thread: MapThread): void {
    this.place.worker = thread.key
    if (this.awake) this.paint()
  }
  private select(key: string): void {
    if (key === this.selectedKey) return
    this.place.selected = key === this.model?.root.key ? null : key
    this.markSelected()
    this.sighted()
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
   * The tree's keys, unmodified, a level at a time. A level is the head's
   * holdings and the family's threads, or, inside an unfolded thread, its
   * holdings and its own threads. j and k (or down and up) step between the
   * pieces of the level; l (or right) unfolds a row and steps into it; h (or
   * left) steps out to the thread above and folds it, and from the family's
   * threads to the head. Enter does what a click does, the only key to reach Rex.
   */
  private key(event: KeyboardEvent): void {
    const model = this.model, target = event.target as HTMLElement
    if (!model || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const head = this.row(model.root.key)!
    const item = target === head ? head : target.closest<HTMLElement>('[data-level]')
    if (!item || item.closest('.ws-worker-acts')) return
    const owner = item === head ? undefined : item.dataset.level!, row = item.dataset.row
    if (row) this.select(row)
    else if (owner) this.select(owner)
    const level = (key: string): HTMLElement[] => [...this.tree.querySelectorAll<HTMLElement>('[data-level]')].filter(el => el.dataset.level === key && !el.hidden && !el.closest('[hidden]'))
    const down = (): HTMLElement | undefined => {
      if (item === head) return level(model.root.key)[0]
      if (!row) return undefined
      if (!this.place.open.has(row)) this.toggle(row)
      if (!row.startsWith('aside:')) return level(row)[0]
      const peers = level(owner!)
      return peers[peers.indexOf(item) + 1]
    }
    let next: HTMLElement | undefined
    const step = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 }[event.key]
    if (step) {
      if (owner === undefined) next = step > 0 ? level(model.root.key)[0] : undefined
      else { const peers = level(owner); next = peers[peers.indexOf(item) + step] }
    } else if (event.key === 'l' || event.key === 'ArrowRight') {
      if (!row && item !== head) { event.preventDefault(); item.click(); return }
      next = down()
    } else if (event.key === 'h' || event.key === 'ArrowLeft') {
      if (owner === undefined) return
      if (owner === model.root.key) next = head
      else { next = this.row(owner); if (this.place.open.has(owner)) this.toggle(owner) }
      if (next) this.select(next.dataset.row ?? model.root.key)
    } else if ((event.key === 'Enter' || event.key === ' ') && (row || item === head)) {
      event.preventDefault()
      this.activate(row ?? model.root.key)
      return
    } else return
    event.preventDefault()
    if (!next) return
    if (next.dataset.row) this.select(next.dataset.row)
    next.focus({ preventScroll: true })
    this.reveal(next, false)
    const thread = next.dataset.row ? model.threads.get(next.dataset.row) : undefined
    this.announcement.textContent = thread ? [thread.name, thread.note].filter(Boolean).join('. ') : next.textContent ?? ''
  }

  /** The page stops where it is, reading and drawing nothing, until its frame is selected again. */
  private suspend(): void { this.awake = false }
  private resume(): void {
    this.awake = true
    if (this.scope) this.update(this.scope.card, this.scope.index)
  }
  dispose(): void {
    this.suspend()
    for (const line of this.actions.values()) line.dispose()
    this.actions.clear()
    this.disposed()
  }
}
