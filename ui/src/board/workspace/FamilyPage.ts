import { announce } from '@ui-sdk/core'
import type { KanbanCard } from '../KanbanTypes.js'
import { ATTENTION, familyModel, type MapFeeds, type MapFile, type MapThread } from '../family/model.js'
import { htmlEl as el } from '../family/drawing.js'
import { ago } from '../civilDay.js'
import { bindDrawnPage } from '../FileViewerPanel.js'
import { stateDot } from '../stateDot.js'
import { slug } from '../threadOutline.js'
import { renderMarkdown } from '../utils.js'
import { threadState, type ThreadIndex } from '../threads.js'
import { parseDocKey, type DocKey } from './documents.js'
import type { FiberActs } from './Dock.js'
import { docButtons, type DocFeeds } from './docButtons.js'
import { runWords } from './runWords.js'
import { Thumbnail } from './Thumbnail.js'
import './family-page.css'

/** What the view reads, and where it goes. */
export interface ViewFeeds extends MapFeeds, DocFeeds {
  shuttleBase: string
  refresh(): void
  /** The last thing a constitution posted (a post, an ask or a review note), with when; undefined when it said nothing. */
  said(card: KanbanCard): { text: string; at: number } | undefined
  /** Opens a constitution's view, as a click on it does: Rex and voice follow, unless it opens `quiet`. */
  view(card: KanbanCard, quiet?: boolean): void
  /** The human has seen this file as it stood: it is no longer new. */
  seen(file: MapFile): void
}

/** How far the page must be pulled down past its top before its orchestrator's view opens, in px. */
const PULL_PX = 120

/** Whether a constitution needs the human, in a word. */
const needs = (card: KanbanCard): string => card.ask && card.status === 'active' ? 'asks' : threadState(card) === 'to-review' ? 'for review' : ''

/**
 * One view of a constitution, the same from the Desk, a channel, a role or a
 * thread: its orchestrators above as a path back up, each step its dot and
 * slug (choosing one opens its view; pulling the page down past its top opens
 * the nearest one's, moving neither Rex nor voice); its head (state dot,
 * slug, whether it needs the human, its run, its pages and its acts); the
 * last thing it posted; then its sub-threads as a narrow column of rows (dot,
 * slug, a word of state, its run, how many threads it has of its own, and a
 * chevron: each opens the same view one level down) beside a large preview
 * of its tapestry or newest sent file, which counts as seen. No outcome is
 * drawn. It reads feeds and repaints only while its frame is selected in an
 * open reader; its frame's eviction ends it.
 */
export class FamilyPage {
  readonly el = el('div', 'ws-family-page family-map')
  private readonly scroller = el('div', 'ws-family-scroll')
  private readonly up = el('nav', 'ov-up')
  private readonly main = el('div', 'ov-main')
  private readonly head = el('header', 'ov-head')
  private readonly name = el('h2', 'ov-name')
  private readonly facts = el('div', 'ov-facts')
  private readonly tools = el('div', 'ov-tools')
  private docs = el('span', 'ws-doc-buttons')
  private readonly said = el('section', 'ov-said')
  private readonly body = el('div', 'ov-body')
  private readonly figure = el('button', 'ov-figure')
  private readonly threads = el('ol', 'ov-threads')
  private card: KanbanCard | null = null
  private index: ThreadIndex | null = null
  private signature = ''
  private awake = true
  private acts: FiberActs | null = null
  private thumb: { doc: DocKey; thumbnail: Thumbnail } | null = null
  private pull = 0
  private readonly feeds: ViewFeeds
  private readonly disposed: () => void
  private readonly actsFor?: (target: () => KanbanCard) => FiberActs
  /** `h` at the top of the family: off the page, back where it was opened from. */
  leave?: () => void

  constructor(feeds: ViewFeeds, disposed: () => void, actsFor?: (target: () => KanbanCard) => FiberActs) {
    this.feeds = feeds; this.disposed = disposed; this.actsFor = actsFor
    this.up.setAttribute('aria-label', 'Orchestrators')
    // A tree: its rows own j, k, h and l while they have the keys.
    this.scroller.setAttribute('role', 'tree')
    this.scroller.setAttribute('aria-label', 'The constitution, its orchestrators and its threads')
    this.scroller.append(this.up, this.main)
    this.head.tabIndex = -1
    // An act zone, as the console is: a channel theme's rules stop at its controls.
    this.tools.dataset.part = 'act'
    this.tools.append(this.docs)
    this.head.append(el('span'), this.name, this.facts, this.tools)
    this.figure.type = 'button'
    this.figure.hidden = true
    this.threads.setAttribute('aria-label', 'Threads')
    this.body.append(this.threads, this.figure)
    this.main.append(this.head, this.said, this.body)
    const grid = el('div', 'ws-family-grid')
    grid.append(this.scroller)
    this.el.append(grid)
    this.el.addEventListener('keydown', event => this.key(event))
    // Only a gesture that begins at the top pulls: a scroll's momentum carried up to the top does not.
    let lastWheel = -Infinity, fromTop = false
    this.scroller.addEventListener('wheel', event => {
      if (event.timeStamp - lastWheel > 300) fromTop = this.scroller.scrollTop <= 0
      lastWheel = event.timeStamp
      if (fromTop) this.pulled(-event.deltaY)
    }, { passive: true })
    let touch: number | null = null
    this.scroller.addEventListener('touchstart', event => { touch = this.scroller.scrollTop <= 0 ? event.touches[0].clientY : null }, { passive: true })
    this.scroller.addEventListener('touchmove', event => { if (touch !== null && event.touches[0].clientY - touch > PULL_PX) { touch = null; this.pulled(PULL_PX) } }, { passive: true })
    bindDrawnPage(this.el, { suspend: () => { this.awake = false }, resume: () => { this.awake = true; this.repaint() }, dispose: () => this.dispose() })
  }

  update(card: KanbanCard, index: ThreadIndex, now = Date.now()): void {
    this.card = card; this.index = index
    if (!this.awake) return
    this.feeds.refresh()
    const current = index.card(card), children = index.children(current), above = this.ancestors()
    const said = this.feeds.said(current)
    const signature = JSON.stringify([Math.floor(now / 60_000), current, above, children, said, this.feeds.files(current).map(file => file.key)])
    if (signature === this.signature) return
    this.signature = signature
    this.paint(current, now)
  }
  /** Takes the keys on its head: no row looks chosen, and Enter opens nothing until j or k picks one. */
  focus(): void { this.head.focus({ preventScroll: true }) }
  /** `t`: opens the constitution's tapestry, else its newest sent file. */
  openLead(): void {
    const card = this.card
    if (!card) return
    void this.feeds.lead(card).then(lead => {
      const doc = lead?.key ?? this.feeds.files(card)[0]?.key
      if (doc) this.feeds.open(card, doc)
    })
  }

  private repaint(): void {
    this.signature = ''
    if (this.card && this.index) this.update(this.card, this.index)
  }
  /** Its orchestrators, the family's top-level first. */
  private ancestors(): KanbanCard[] {
    const index = this.index!, above: KanbanCard[] = []
    for (let parent = index.parentOf(index.card(this.card!)); parent; parent = index.parentOf(parent)) above.unshift(parent)
    return above
  }
  /**
   * Draws the view in place: the head, its words, the preview, and the
   * acts stay the same elements across repaints, so what has focus in them,
   * an open menu, and a thumbnail's live page all survive; the rows that are
   * drawn again keep the row the keys were on.
   */
  private paint(card: KanbanCard, now: number): void {
    const above = this.ancestors()
    const model = familyModel(this.index!, card, this.feeds, now)
    const urgency = (thread: MapThread): number => {
      const rank = (ATTENTION as readonly string[]).indexOf(thread.standing)
      return rank >= 0 ? rank : ATTENTION.length + ['still', 'quiet', 'aside'].indexOf(thread.standing)
    }
    const threads = model.root.children.map(key => model.threads.get(key)!)
      .sort((a, b) => urgency(a) - urgency(b) || b.lastMove - a.lastMove)
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.ov-ancestor, .ov-thread')
    const held = focused && this.el.contains(focused) ? `${focused.className}:${focused.dataset.fiber}` : undefined
    this.up.replaceChildren(...above.map(ancestor => this.ancestor(ancestor)))
    this.paintHead(card, now)
    this.paintSaid(card, now)
    this.paintFigure(card)
    this.threads.replaceChildren(...threads.map(thread => {
      const row = this.row(thread, now)
      const item = el('li')
      item.append(row)
      return item
    }))
    this.threads.hidden = !threads.length
    if (held) [...this.el.querySelectorAll<HTMLElement>('.ov-ancestor, .ov-thread')].find(row => `${row.className}:${row.dataset.fiber}` === held)?.focus({ preventScroll: true })
  }
  /** A row that opens a constitution's view, as a click on it does. */
  private opener(card: KanbanCard, className: string): HTMLElement {
    const row = el('div', className)
    row.tabIndex = 0
    row.setAttribute('role', 'treeitem')
    row.dataset.fiber = card.uid ?? card.id
    row.title = card.name
    row.addEventListener('click', () => this.feeds.view(card))
    return row
  }
  /** An orchestrator above, a step of the path back up: its dot and slug. */
  private ancestor(card: KanbanCard): HTMLElement {
    const step = this.opener(card, 'ov-ancestor')
    step.append(stateDot(card, () => this.feeds.view(card)), el('span', 'ov-slug', slug(card)))
    return step
  }
  /** A thread below: its dot, slug, a word of state, its run, how many threads it has of its own, and the chevron that says it opens. */
  private row(thread: MapThread, now: number): HTMLElement {
    const card = thread.card, row = this.opener(card, 'ov-thread'), below = this.index!.children(card).length
    row.dataset.standing = thread.tone
    const open = el('span', 'ov-open', '›')
    open.setAttribute('aria-hidden', 'true')
    row.append(stateDot(card, () => this.feeds.view(card)), el('span', 'ov-slug', slug(card)), el('span', 'ov-word', thread.word ?? ''), el('span', 'ov-time', runWords(card, now)),
      el('span', 'ov-count', below ? `${below} ${below === 1 ? 'thread' : 'threads'}` : ''), open)
    return row
  }
  private paintHead(card: KanbanCard, now: number): void {
    const head = this.head
    head.title = card.name
    this.name.textContent = slug(card)
    const need = needs(card)
    this.facts.replaceChildren(...need ? [el('span', 'ov-needs', need)] : [], el('span', 'ov-time', runWords(card, now)))
    // Its pages are drawn again; the one in focus keeps it.
    const part = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.ws-doc-button')
    const kept = part && this.docs.contains(part) ? part.dataset.part : undefined
    const docs = docButtons(card, this.feeds)
    this.docs.replaceWith(docs)
    this.docs = docs
    if (kept) docs.querySelector<HTMLElement>(`[data-part="${kept}"]`)?.focus({ preventScroll: true })
    head.firstElementChild!.replaceWith(stateDot(card, () => {}))
    if (this.actsFor && !this.acts) {
      this.acts = this.actsFor(() => this.card!)
      this.tools.append(this.acts.el)
    }
    this.acts?.paint()
  }
  /** The last thing it posted, under its head. */
  private paintSaid(card: KanbanCard, now: number): void {
    const said = this.feeds.said(card)
    this.said.hidden = !said
    if (!said) { this.said.replaceChildren(); return }
    const text = el('div', 'ov-said-text')
    text.innerHTML = renderMarkdown(said.text)
    this.said.replaceChildren(el('span', 'ov-said-age', ago(said.at, now)), text)
  }
  /** Its tapestry or newest sent file, large, beside its threads. */
  private paintFigure(card: KanbanCard): void {
    const figure = this.figure
    void this.feeds.lead(card).then(lead => {
      const shown = lead ?? this.feeds.files(card)[0], file = shown && parseDocKey(shown.key)
      figure.hidden = !file
      if (!shown || !file) return
      const doc = shown.key
      // Shown here, it is seen: its thread's row stops saying "new file".
      if (shown.unread) this.feeds.seen(shown)
      if (this.thumb?.doc !== doc) {
        this.thumb?.thumbnail.dispose()
        const name = file.path.split('/').pop() ?? file.path
        const made: Thumbnail = new Thumbnail({
          key: `view:${doc}`, shuttleBase: this.feeds.shuttleBase, className: 'ov-thumb', fallback: name,
          file: { fullPath: file.path, owner: file.owner, basename: name }, pageWidth: 1200,
          priority: () => this.awake && made.el.isConnected ? 2 : 0, distance: () => 0,
        })
        this.thumb = { doc, thumbnail: made }
        figure.replaceChildren(made.el)
      }
      figure.title = `Open ${lead?.name ?? file.path.split('/').pop()}`
      figure.setAttribute('aria-label', figure.title)
      figure.onclick = () => this.feeds.open(card, doc)
    })
  }
  /** Pulled past its top: its orchestrator's view opens, quietly, for a scroll is not a click. */
  private pulled(by: number): void {
    if (this.scroller.scrollTop > 0 || by <= 0) { this.pull = 0; return }
    this.pull += by
    if (this.pull < PULL_PX) return
    this.pull = 0
    const parent = this.ancestors().at(-1)
    if (parent) this.feeds.view(parent, true)
  }
  /**
   * j and k (or down and up) move among the orchestrators and the threads;
   * Enter or l opens the one in focus; h opens the orchestrator's view, and
   * from the top of the family leaves the page.
   */
  private key(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || (event.target as Element).closest('.ov-tools')) return
    const rows = [...this.el.querySelectorAll<HTMLElement>('.ov-ancestor, .ov-head, .ov-thread')]
    const at = rows.indexOf(event.target as HTMLElement)
    const step = ({ j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 } as Record<string, number>)[event.key]
    if (step) {
      const next = rows[Math.max(0, Math.min(rows.length - 1, (at < 0 ? rows.findIndex(row => row.matches('.ov-head')) : at) + step))]
      next?.focus({ preventScroll: false })
      if (next) announce(next.title || next.textContent || '')
    } else if ((event.key === 'Enter' || event.key === 'l') && at >= 0 && !rows[at].matches('.ov-head')) rows[at].click()
    else if (event.key === 'h') {
      const parent = this.ancestors().at(-1)
      if (parent) this.feeds.view(parent)
      else this.leave?.()
    } else return
    event.preventDefault()
  }
  dispose(): void {
    this.awake = false
    this.acts?.dispose()
    this.thumb?.thumbnail.dispose()
    this.disposed()
  }
}
