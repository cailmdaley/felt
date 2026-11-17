import { announce } from '@ui-sdk/core'
import type { KanbanCard } from '../KanbanTypes.js'
import { ATTENTION_ORDER, attentionOf, lastActive, quietWord, wantOf, type Want, type Waits } from '../attention.js'
import type { MapFeeds, MapFile } from '../family/model.js'
import { htmlEl as el } from '../family/drawing.js'
import { bindDrawnPage } from '../FileViewerPanel.js'
import { stateDot } from '../stateDot.js'
import { slug } from '../threadOutline.js'
import { renderMarkdown } from '../utils.js'
import type { ThreadIndex } from '../threads.js'
import type { FiberActs } from './Dock.js'
import { docButtons, type DocButtons, type DocFeeds } from './docButtons.js'
import { parseDocKey, type DocKey } from './documents.js'
import { Unfold } from '../elements/filePreview.js'
import { doing, threadRow } from '../elements/threadRow.js'
import { relative, timeEl } from '../elements/time.js'
import { lineHue } from '../lineHue.js'
import { drawFibres, type Knot } from './familyInk.js'
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
  /** What waits on the human, by fiber. */
  waits(): Waits
}

/** How far the page must be pulled down past its top before its orchestrator's view opens, in px. */
const PULL_PX = 120

/** What a waiting constitution asks of the human, in a word; a post it waits with says nothing its words below do not. */
const WANT_WORD: Readonly<Record<Want['kind'], string>> = { ask: 'asks', review: 'for review', post: '', blocked: 'blocked' }


/**
 * One view of a constitution, the same from the Desk, a channel, a role or a
 * thread, stacked at every width. Above it, pinned, its orchestrators as one
 * strip each, the family's top-level first, each indented to its depth, its
 * fibre in its identity colour curving into the next level, and its thread row (choosing
 * one opens its view; pulling the page
 * down past its top opens the nearest one's, moving neither Rex nor voice).
 * Then its head: its dot and slug, what it wants of the human or its faint
 * word, the age of what it last said or wants (or how long it has worked), its pages and its acts; the last thing it posted;
 * its sub-threads as thread rows (each opens the same view one level down),
 * only those that wait on the human or are working, what waits first,
 * each followed by every thread below it that waits on the human, and the
 * quiet ones (seats, drafts, rest, standing threads between runs, closes)
 * behind one quiet control that opens to them; then its tapestry, or
 * else its newest sent file, at the view's full width as a preview that
 * unfolds in place, stepping through its other sent files, and counts as
 * seen. Its head draws no outcome; a thread row says one when it is newer than its last post. It reads feeds and repaints only while its frame
 * is selected in an open reader; its frame's eviction ends it.
 */
const svgBox = (): SVGSVGElement => {
  const box = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  box.classList.add('ov-ink')
  box.setAttribute('aria-hidden', 'true')
  return box
}

export class FamilyPage {
  readonly el = el('div', 'ws-family-page family-map')
  private readonly scroller = el('div', 'ws-family-scroll')
  private readonly up = el('nav', 'ov-up')
  private readonly main = el('div', 'ov-main')
  private readonly head = el('header', 'ov-head')
  private readonly title = el('div', 'ov-title')
  private readonly name = el('h2', 'ov-name')
  private readonly facts = el('div', 'ov-facts')
  private readonly tools = el('div', 'ov-tools')
  private docs: DocButtons = { el: el('span', 'ws-doc-buttons'), refresh: () => {} }
  private readonly said = el('section', 'ov-said')
  private readonly threads = el('ol', 'ov-threads')
  /** The fine ink of its lines: one drawing over the pinned stack, one over the view below it. */
  private readonly upInk = svgBox()
  private readonly mainInk = svgBox()
  private inking = 0
  private readonly resized = new ResizeObserver(() => this.inkLater())
  private readonly unfold: Unfold
  private card: KanbanCard | null = null
  private index: ThreadIndex | null = null
  private signature = ''
  private awake = true
  private acts: FiberActs | null = null
  /** The files the preview shows, by key, and the card they were read for. */
  private shown: { card: string; files: Map<string, MapFile> } | null = null
  /** The latest read of its files: an older read that lands late draws nothing. */
  private reads = 0
  /** A file asked for before its files were read, unfolded once they are. */
  private wanted: DocKey | null = null
  private pull = 0
  /** The quiet threads are drawn too. */
  private quietShown = false
  private readonly quiet = el('button', 'ov-quiet')
  private readonly feeds: ViewFeeds
  private readonly disposed: () => void
  private readonly actsFor?: (target: () => KanbanCard) => FiberActs
  /** `h` at the top of the family: off the page, back where it was opened from. */
  leave?: () => void

  constructor(feeds: ViewFeeds, disposed: () => void, actsFor?: (target: () => KanbanCard) => FiberActs) {
    this.feeds = feeds; this.disposed = disposed; this.actsFor = actsFor
    this.up.setAttribute('aria-label', 'Orchestrators')
    this.scroller.append(this.main)
    this.head.tabIndex = -1
    // An act zone, as the console is: a channel theme's rules stop at its controls.
    this.tools.dataset.part = 'act'
    this.tools.append(this.docs.el)
    this.title.append(el('span'), this.name)
    this.head.append(this.title, this.facts, this.tools)
    this.unfold = new Unfold({
      shuttleBase: feeds.shuttleBase, single: true, awake: () => this.awake,
      seen: key => { const file = this.shown?.files.get(key); if (file?.unread) feeds.seen(file) },
      full: key => { if (this.card) feeds.open(this.card, key) },
    })
    this.unfold.el.classList.add('ov-unfold')
    this.threads.setAttribute('aria-label', 'Threads')
    this.quiet.type = 'button'
    this.quiet.title = 'Quiet threads: seats, drafts, rest, standing threads between runs, closes'
    this.quiet.addEventListener('click', () => {
      this.quietShown = !this.quietShown
      if (this.card && this.index) this.paint(this.index.card(this.card), Date.now())
    })
    this.main.append(this.mainInk, this.head, this.said, this.threads, this.unfold.el)
    this.resized.observe(this.main)
    // A tree: its strips and rows own j, k, h and l while they have the keys.
    const grid = el('div', 'ws-family-grid')
    grid.setAttribute('role', 'tree')
    grid.setAttribute('aria-label', 'The constitution, its orchestrators and its threads')
    grid.append(this.up, this.scroller)
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
    bindDrawnPage(this.el, { suspend: () => { this.awake = false; this.unfold.suspend() }, resume: () => { this.awake = true; this.unfold.resume(); this.repaint() }, dispose: () => this.dispose() })
  }

  update(card: KanbanCard, index: ThreadIndex, now = Date.now()): void {
    if ((this.card?.uid ?? this.card?.id) !== (card.uid ?? card.id)) this.quietShown = false
    this.card = card; this.index = index
    if (!this.awake) return
    this.feeds.refresh()
    const current = index.card(card), children = index.children(current), above = this.ancestors()
    const said = this.feeds.said(current), waits = this.feeds.waits()
    // What each of them wants and whether it works: a grandchild's worker starting unfolds the thread above it.
    const wants = [current, ...above, ...index.subtree(current)].map(card => [wantOf(card, waits), attentionOf(card, waits)])
    const signature = JSON.stringify([Math.floor(now / 60_000), current, above, children, said, [...above, ...index.subtree(current)].map(card => this.feeds.said(card)), wants, this.feeds.files(current).map(file => file.key)])
    if (signature === this.signature) return
    this.signature = signature
    this.paint(current, now)
  }
  /** Gives the keys to its unfolded file, else to its head: no row looks chosen, and Enter opens nothing until j or k picks one. */
  focus(): void {
    if (!this.unfold.focus()) this.head.focus({ preventScroll: true })
  }
  /** The reader showed `key` full screen: an unfolded file here steps to it, when it is one of this view's files. */
  follow(key: DocKey): void {
    if (this.unfold.unfolded) this.unfold.unfold(key)
  }
  /** `l` away from the rows: unfolds the constitution's tapestry (else its newest sent file) here, or folds it if it is the one unfolded. */
  openLead(): void {
    const card = this.card
    if (!card) return
    void this.feeds.lead(card).then(lead => {
      const doc = lead?.key ?? this.feeds.files(card)[0]?.key
      if (doc) this.show(card, doc)
    })
  }
  /**
   * One of its pages, asked for from its head: a file the view holds (its
   * tapestry, a sent file) unfolds below, in sight, or folds if it is the one
   * unfolded; any other page (its constitution, its edits) opens in the reader.
   */
  private show(card: KanbanCard, doc: DocKey): void {
    // Its files not yet read, a file waits for them.
    if (this.shown?.card !== (card.uid ?? card.id) && parseDocKey(doc)) { this.wanted = doc; return }
    if (!this.shown?.files.has(doc)) { this.feeds.open(card, doc); return }
    if (this.unfold.unfolded === doc) { this.unfold.fold(); return }
    this.unfold.unfold(doc)
    this.unfold.el.scrollIntoView({ block: 'start' })
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
    const above = this.ancestors(), index = this.index!, waits = this.feeds.waits()
    // A thread with a wait anywhere below it stands with what waits, and every such wait is drawn beneath it.
    // A thread with a worker anywhere below it ranks and stands with what works.
    const threads = index.children(card).map(child => {
      const subtree = index.subtree(child), below = subtree.filter(each => wantOf(each, waits))
      const own = attentionOf(child, waits)
      const moving = below.length || own === 'waiting' ? 'waiting' : own === 'working' || subtree.some(each => attentionOf(each, waits) === 'working') ? 'working' : 'quiet'
      return { child, below, moving, rank: ATTENTION_ORDER.indexOf(moving) }
    }).sort((a, b) => a.rank - b.rank || lastActive(b.child) - lastActive(a.child))
    const quietHeld = document.activeElement === this.quiet
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.ov-ancestor, .ov-thread')
    const held = focused && this.el.contains(focused) ? `${focused.className}:${focused.dataset.fiber}` : undefined
    this.up.replaceChildren(...above.map((ancestor, depth) => this.ancestor(ancestor, depth, above, now)), this.upInk)
    this.paintHead(card, now)
    this.paintSaid(card, now)
    this.paintFiles(card)
    // A quiet thread with nothing waiting or working below it stands behind the quiet control.
    const tucked = threads.filter(({ moving }) => moving === 'quiet')
    if (!tucked.length) this.quietShown = false
    const drawn = this.quietShown ? threads : threads.filter(thread => !tucked.includes(thread))
    this.quiet.textContent = this.quietShown ? 'hide quiet' : `${tucked.length} quiet`
    this.quiet.setAttribute('aria-expanded', String(this.quietShown))
    const more = el('li', 'ov-more')
    more.append(this.quiet)
    this.threads.replaceChildren(...drawn.map(({ child, below }) => {
      const item = el('li')
      item.append(this.opener(child, 'ov-thread', now, waits), ...below.map(deep => this.opener(deep, 'ov-thread ov-deep', now, waits)))
      return item
    }), ...tucked.length ? [more] : [])
    this.threads.hidden = !threads.length
    if (quietHeld && this.quiet.isConnected) this.quiet.focus({ preventScroll: true })
    if (held) [...this.el.querySelectorAll<HTMLElement>('.ov-ancestor, .ov-thread')].find(row => `${row.className}:${row.dataset.fiber}` === held)?.focus({ preventScroll: true })
    this.inkLater()
  }
  private inkLater(): void {
    if (this.inking) return
    this.inking = requestAnimationFrame(() => { this.inking = 0; this.ink() })
  }
  /**
   * Draws its lines in fine ink once the rows stand: each orchestrator's
   * fibre into the next level's dot (the last down into the view, where it
   * meets the constitution's dot), and the constitution's own fibre into
   * each of its threads.
   */
  private ink(): void {
    const card = this.card && this.index?.card(this.card)
    if (!card || !this.awake) return
    const above = this.ancestors(), dotOf = (row: Element | null | undefined) => row?.querySelector(':scope > .constitution-state-dot') ?? undefined
    const centre = (dot: Element | undefined, frame: DOMRect): [number, number] | undefined => {
      const box = dot?.getBoundingClientRect()
      return box && box.width ? [box.left + box.width / 2 - frame.left, box.top + box.height / 2 - frame.top] : undefined
    }
    const upFrame = this.up.getBoundingClientRect(), mainFrame = this.main.getBoundingClientRect()
    const headDot = centre(this.title.querySelector('.constitution-state-dot') ?? undefined, mainFrame)
    const strips = [...this.up.querySelectorAll(':scope > .ov-ancestor')]
    const chain: Knot[] = above.flatMap((each, k) => { const at = centre(dotOf(strips[k]), upFrame); return at ? [{ at, hue: lineHue(each), seed: each.uid ?? each.id }] : [] })
    for (const [box, frame] of [[this.upInk, upFrame], [this.mainInk, mainFrame]] as const) { box.setAttribute('width', String(frame.width)); box.setAttribute('height', String(frame.height)) }
    this.upInk.replaceChildren()
    drawFibres(this.upInk, { chain, foot: headDot && chain.length ? [headDot[0], upFrame.height] : undefined })
    if (!headDot) { this.mainInk.replaceChildren(); return }
    const self: Knot = { at: headDot, hue: lineHue(card), seed: card.uid ?? card.id }
    const branches = [...this.threads.querySelectorAll(':scope > li > .ov-thread:not(.ov-deep)')].map(row => centre(dotOf(row), mainFrame)).filter(at => at !== undefined)
    this.mainInk.replaceChildren()
    // The last orchestrator's fibre comes on into the view from its top and down into the constitution's dot.
    const parent = above.at(-1)
    if (parent) drawFibres(this.mainInk, { chain: [{ at: [headDot[0], -4], hue: lineHue(parent), seed: `${parent.uid ?? parent.id}:in` }], foot: [headDot[0], headDot[1] - 5] })
    drawFibres(this.mainInk, { chain: [self], branches, trunk: Math.max(6, (branches[0]?.[0] ?? headDot[0]) - 16) })
  }
  /** A thread row (elements/threadRow.ts) the view's keys move among, which opens that constitution's view. */
  private opener(card: KanbanCard, className: string, now: number, waits: Waits): HTMLElement {
    const row = threadRow(card, { waits, now, said: this.feeds.said(card), open: each => this.feeds.view(each), hue: lineHue(card) })
    row.classList.add(...className.split(' '))
    row.tabIndex = 0
    row.setAttribute('role', 'treeitem')
    return row
  }
  /**
   * An orchestrator above, one strip of the pinned stack, indented to its
   * depth: its thread row, its fibre drawn from its dot into the next level's
   * ({@link ink}).
   */
  private ancestor(card: KanbanCard, depth: number, above: readonly KanbanCard[], now: number): HTMLElement {
    const waits = this.feeds.waits(), strip = this.opener(card, 'ov-ancestor', now, waits)
    strip.style.setProperty('--ov-depth', String(depth))
    strip.style.setProperty('--ov-below', String(above.length - 1 - depth))
    return strip
  }
  private paintHead(card: KanbanCard, now: number): void {
    const head = this.head
    head.title = card.name
    head.dataset.hue = lineHue(card)
    this.name.textContent = slug(card)
    const waits = this.feeds.waits(), want = wantOf(card, waits), faint = attentionOf(card, waits) === 'quiet' ? quietWord(card) : ''
    this.facts.replaceChildren(...want && WANT_WORD[want.kind] ? [el('span', 'ov-needs', WANT_WORD[want.kind])] : faint ? [el('span', 'ov-word', faint)] : [], timeEl(doing(card, waits, this.feeds.said(card)).at, now, 'ov-time'))
    // Its pages are drawn again, the one in focus keeping it; while a list hangs from one, whose focus returns there, they only read their files again.
    if (!this.docs.el.querySelector('[aria-expanded="true"]')) {
      const part = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.ws-doc-button')
      const kept = part && this.docs.el.contains(part) ? part.dataset.part : undefined
      const docs = docButtons(card, { ...this.feeds, open: (each, doc) => this.show(each, doc) })
      this.docs.el.replaceWith(docs.el)
      this.docs = docs
      if (kept) docs.el.querySelector<HTMLElement>(`[data-part="${kept}"]`)?.focus({ preventScroll: true })
    } else this.docs.refresh()
    this.name.previousElementSibling!.replaceWith(stateDot(card, waits, () => {}))
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
    text.title = relative(said.at, now)
    this.said.replaceChildren(text)
  }
  /**
   * Its tapestry, else its newest sent file, as the preview that unfolds in
   * place, stepping through every sent file once unfolded. Shown, it is seen.
   */
  private paintFiles(card: KanbanCard): void {
    const uid = card.uid ?? card.id
    if (this.shown && this.shown.card !== uid) { this.unfold.update([]); this.shown = null }
    const read = ++this.reads
    void this.feeds.lead(card).then(lead => {
      if (read !== this.reads) return
      const files = [...lead ? [lead] : [], ...this.feeds.files(card).filter(file => file.key !== lead?.key)]
      this.shown = { card: uid, files: new Map(files.map(file => [file.key, file])) }
      this.unfold.update(files)
      // Shown here, it is seen.
      if (files[0]?.unread) this.feeds.seen(files[0])
      const wanted = this.wanted
      this.wanted = null
      if (wanted) this.show(card, wanted)
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
    // An unfolded file keeps its keys.
    if (this.unfold.unfolded && this.unfold.el.contains(event.target as Node)) return
    const rows = [...this.up.querySelectorAll<HTMLElement>('.ov-ancestor'), this.head, ...this.threads.querySelectorAll<HTMLElement>('.ov-thread')]
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
    this.resized.disconnect()
    cancelAnimationFrame(this.inking)
    this.acts?.dispose()
    this.unfold.dispose()
    this.disposed()
  }
}
