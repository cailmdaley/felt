import type { KanbanCard } from '../KanbanTypes.js'
import { ATTENTION, ATTENTION_WORD, familyModel, isDrawn, needsHuman, type FamilyModel, type MapFeeds, type MapThread } from '../family/model.js'
import { htmlEl as el, markPath, markSelection, shortAgo, svgEl, type Drawing } from '../family/drawing.js'
import { ROSTER, chooseDrawing, chosenDrawing } from '../family/roster.js'
import { FieldZoom } from '../family/zoom.js'
import { bindDrawnPage } from '../FileViewerPanel.js'
import { threadItem } from '../ThreadPeek.js'
import { threadKey, type ThreadIndex } from '../threads.js'
import { renderThreadTree } from './ThreadTree.js'
import './family-page.css'

/** Sent files named in a peek before the rest become a count. */
const PEEK_FILES = 4
/** A resize's quiet after which the stage has its size: a page crossing resizes it every frame. */
const SETTLE_MS = 120
const STEPS: Readonly<Record<string, number>> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }

/** What the map reads, and how to ask for it again. */
export interface FamilyFeeds extends MapFeeds { refresh(): void }

/**
 * The family's page in the reader: the map on its stage with a roster of
 * drawings, the counts of what asks above it, and a peek at the selected
 * thread below it. Selection follows the pointer, the arrows and a first tap,
 * and survives leaving and coming back; the tree of every thread folds at the
 * foot. It reads feeds, repaints and animates only while its frame is selected
 * in an open reader; its frame's eviction ends it.
 */
export class FamilyPage {
  readonly el = el('div', 'ws-family-page family-map')
  private readonly counts = el('div', 'ws-family-counts')
  private readonly roster = el('div', 'ws-family-roster')
  private readonly scroller = el('div', 'ws-family-scroll')
  private readonly stage = el('div', '')
  private readonly peek = el('section', 'ws-family-peek')
  private readonly reading = el('p', 'ws-family-reading')
  private readonly all = el('details', 'ws-family-all')
  private readonly allLabel = el('summary', 'ws-family-all-label')
  private readonly allCounts = el('span', 'ws-family-all-counts')
  private readonly allShort = el('span', 'ws-family-all-short')
  private readonly allBody = el('div', 'ws-family')
  private readonly openFolds = new Map<string, boolean>([['resting', false]])
  private readonly announcement = el('p', 'ws-sr-only')
  private readonly observer: ResizeObserver | null
  private readonly zoom: FieldZoom
  private readonly disposed: () => void
  private drawing: Drawing = chosenDrawing() ?? ROSTER[0]
  private model: FamilyModel | null = null
  private last: { card: KanbanCard; index: ThreadIndex } | null = null
  private selected: string | null = null
  private signature = ''
  /** The peek as built, so a repaint keeps it when nothing in it moved. */
  private peekShape = ''
  private awake = true
  /** The stage's size at the last paint; 0 wide when it had none. */
  private size = { width: 0, height: 0 }
  private settling: ReturnType<typeof setTimeout> | null = null
  private refocus = false
  private touch = false
  /** The thread a first tap peeked at, which a second tap opens. */
  private peeked: string | null = null
  private readonly open: (card: KanbanCard, doc?: string) => void
  private readonly feeds: FamilyFeeds

  constructor(open: (card: KanbanCard, doc?: string) => void, feeds: FamilyFeeds, disposed: () => void) {
    this.open = open; this.feeds = feeds; this.disposed = disposed
    this.stage.setAttribute('role', 'listbox')
    this.stage.setAttribute('aria-label', 'Threads, most urgent first')
    this.scroller.append(this.stage)
    this.peek.setAttribute('aria-label', 'Selected thread')
    this.announcement.setAttribute('aria-live', 'polite')
    this.roster.setAttribute('role', 'group')
    this.roster.setAttribute('aria-label', 'Drawing of the map')
    for (const drawing of ROSTER) {
      const button = el('button', 'ws-family-drawing', drawing.label); button.type = 'button'
      button.title = 'Change the drawing (v)'
      button.dataset.drawing = drawing.name
      button.addEventListener('click', () => this.show(drawing))
      this.roster.append(button)
    }
    this.allLabel.append(el('span', 'ws-family-all-word', 'All threads'), this.allCounts, this.allShort)
    this.all.append(this.allLabel, this.allBody)
    const grid = el('div', 'ws-family-grid')
    grid.append(this.counts, this.roster, this.scroller, this.peek, this.announcement, this.reading, this.all)
    this.el.append(grid)
    this.stage.addEventListener('keydown', event => this.key(event))
    this.stage.addEventListener('pointerover', event => this.rest(event))
    this.stage.addEventListener('pointerdown', event => { this.touch = event.pointerType === 'touch' })
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resized())
    this.observer?.observe(this.stage)
    this.zoom = new FieldZoom(this.stage, () => this.repaintStill())
    bindDrawnPage(this.el, { suspend: () => this.suspend(), resume: () => this.resume(), dispose: () => this.dispose() })
  }

  update(card: KanbanCard, index: ThreadIndex, now = Date.now()): void {
    this.last = { card, index }
    if (!this.awake) return
    this.feeds.refresh()
    const root = index.family(index.card(card)).root
    const family = [root, ...index.subtree(root)]
    this.take(chosenDrawing() ?? this.drawing)
    const signature = JSON.stringify([threadKey(card), Math.floor(now / 60_000), this.drawing.name, family, family.map(thread => [this.feeds.marks(thread), this.feeds.files(thread)])])
    if (signature === this.signature) return
    this.signature = signature
    this.model = familyModel(index, root, index.card(card), this.feeds, now)
    this.paint()
    this.paintTree(index, root, index.card(card))
  }
  /** The next drawing of the roster. */
  cycle(): void { this.show(ROSTER[(ROSTER.indexOf(this.drawing) + 1) % ROSTER.length]) }
  /** Takes the keys, on the selected thread. */
  focus(): void { this.option()?.focus({ preventScroll: true }) }

  private show(drawing: Drawing): void {
    chooseDrawing(drawing)
    this.take(drawing)
    this.repaint()
    this.option()?.scrollIntoView?.({ block: 'nearest' })
  }
  /** A drawing takes the stage from the one before it. */
  private take(drawing: Drawing): void {
    if (drawing === this.drawing) return
    this.drawing = drawing
    this.signature = ''
    this.refocus = this.stage.contains(document.activeElement)
    this.zoom.forget()
    this.stage.replaceChildren()
    this.stage.className = ''
  }
  private repaint(): void { if (this.last) this.update(this.last.card, this.last.index) }
  /** The map stops where it is, reading and drawing nothing, until its frame is selected again. */
  private suspend(): void {
    this.awake = false
    this.clearSettling()
    this.el.classList.add('family-map-parked')
  }
  private resume(): void {
    this.awake = true
    this.el.classList.remove('family-map-parked')
    this.repaint()
    this.resized()
  }
  private dispose(): void {
    this.suspend()
    this.observer?.disconnect()
    this.zoom.dispose()
    this.disposed()
  }
  private clearSettling(): void {
    if (this.settling !== null) clearTimeout(this.settling)
    this.settling = null
  }
  /** The first size paints at once; later ones, once the stage stops moving, without drifting there. */
  private resized(): void {
    const { clientWidth: width, clientHeight: height } = this.stage
    if (!this.awake || (width === this.size.width && height === this.size.height)) return
    this.clearSettling()
    if (!this.size.width) { this.paint(); return }
    this.settling = setTimeout(() => { this.settling = null; this.repaintStill() }, SETTLE_MS)
  }
  private repaintStill(): void {
    if (!this.awake) return
    this.stage.classList.add('family-map-still')
    this.paint()
    requestAnimationFrame(() => requestAnimationFrame(() => this.stage.classList.remove('family-map-still')))
  }
  private option(): HTMLElement | SVGElement | null {
    return this.stage.querySelector<HTMLElement | SVGElement>('[role="option"][tabindex="0"]')
  }
  private paint(): void {
    const model = this.model
    if (!model) return
    this.size = { width: this.stage.clientWidth, height: this.stage.clientHeight }
    this.el.dataset.drawing = this.drawing.name
    this.counts.replaceChildren(...ATTENTION.flatMap(kind => {
      const n = model.counts[kind]
      if (!n) return []
      const count = el('span', 'ws-family-count'); count.dataset.standing = kind
      const mark = svgEl('svg'); mark.setAttribute('viewBox', '-7 -7 14 14'); mark.setAttribute('aria-hidden', 'true')
      const path = svgEl('path'); path.setAttribute('d', markPath(kind, 4.5)); mark.append(path)
      count.append(mark, `${n} ${ATTENTION_WORD[kind].toLowerCase().replace(/s$/, n === 1 ? '' : 's')}`)
      return [count]
    }))
    for (const button of this.roster.querySelectorAll<HTMLElement>('button')) button.setAttribute('aria-pressed', String(button.dataset.drawing === this.drawing.name))
    this.drawing.draw(this.stage, model, thread => this.activate(thread), this.zoom.drawn)
    this.reading.replaceChildren(...this.drawing.reading.map(phrase => el('span', '', phrase)))
    const { drafts, resting, archived } = model.aside
    this.allShort.textContent = `${drafts + resting + archived} aside`
    this.allCounts.textContent = [drafts && `${drafts} ${drafts === 1 ? 'draft' : 'drafts'}`, resting && `${resting} resting`, archived && `${archived} archived`].filter(Boolean).join(' · ')
    const kept = this.selected ? model.threads.get(this.selected) : undefined
    const landing = model.current !== model.root.key ? model.threads.get(model.current ?? '') : undefined
    this.selected = null
    this.select([kept, landing].find(thread => thread && isDrawn(thread))?.key ?? model.order[0].key)
    if (this.refocus) { this.refocus = false; this.focus() }
  }
  private paintTree(index: ThreadIndex, root: KanbanCard, current: KanbanCard): void {
    for (const fold of this.allBody.querySelectorAll<HTMLDetailsElement>('details[data-thread-details]')) this.openFolds.set(fold.dataset.threadDetails!, fold.open)
    const active = document.activeElement
    const focus = active instanceof HTMLElement && this.allBody.contains(active) ? active.dataset.threadFocus : undefined
    this.allBody.replaceChildren(...renderThreadTree(index, root, current, (thread, key) => {
      const item = threadItem(thread, index, this.open, key), pin = item.querySelector<HTMLButtonElement>('.kbn-thread-pin')!
      pin.hidden = threadKey(thread) !== threadKey(current) && pin.getAttribute('aria-pressed') !== 'true'
      pin.tabIndex = pin.hidden ? -1 : 0
      return item
    }, this.openFolds))
    if (focus) [...this.allBody.querySelectorAll<HTMLElement>('[data-thread-focus]')].find(node => node.dataset.threadFocus === focus)?.focus({ preventScroll: true })
  }
  private select(key: string): void {
    const model = this.model
    if (!model || key === this.selected) return
    this.selected = key
    markSelection(this.stage, model, key)
    this.paintPeek(model.threads.get(key)!)
  }
  /** Moves only what changed in the peek, so focus inside it stays. */
  private paintPeek(thread: MapThread): void {
    const shape = JSON.stringify([thread.key, thread.name, thread.note, thread.files.map(file => [file.key, file.name, file.unread])])
    if (shape !== this.peekShape) {
      this.peekShape = shape
      this.buildPeek(thread)
    }
    const title = this.peek.querySelector<HTMLElement>('.ws-family-peek-title')!
    title.dataset.standing = thread.standing
    title.querySelector('.ws-family-peek-meta')!.textContent = this.peekMeta(thread)
    this.peek.dataset.asks = String(needsHuman(thread))
  }
  private peekMeta(thread: MapThread): string { return [thread.word, shortAgo(thread.lastMove, this.model!.now)].join(' · ') }
  private buildPeek(thread: MapThread): void {
    const card = (): KanbanCard => this.model!.threads.get(thread.key)!.card
    const name = el('button', 'ws-family-peek-name', thread.name); name.type = 'button'
    name.addEventListener('click', () => this.open(card()))
    const title = el('div', 'ws-family-peek-title'); title.append(name, el('span', 'ws-family-peek-meta'))
    const note = el('p', 'ws-family-peek-note', thread.note)
    const files = el('div', 'ws-family-peek-files')
    for (const file of thread.files.slice(0, PEEK_FILES)) {
      const chip = el('button', 'ws-family-peek-file', file.name); chip.type = 'button'
      chip.toggleAttribute('data-unread', file.unread)
      chip.addEventListener('click', () => this.open(card(), file.key))
      files.append(chip)
    }
    if (thread.files.length > PEEK_FILES) files.append(el('span', 'ws-family-peek-more', `+${thread.files.length - PEEK_FILES}`))
    this.peek.replaceChildren(title, note, files)
  }
  private rest(event: PointerEvent): void {
    this.touch = event.pointerType === 'touch'
    const key = (event.target as Element).closest('[data-thread]')?.getAttribute('data-thread')
    const thread = key ? this.model?.threads.get(key) : undefined
    if (thread && isDrawn(thread) && !this.touch) this.select(thread.key)
  }
  /** A click or Enter opens; a finger peeks first and opens on its second tap. */
  private activate(thread: MapThread): void {
    if (this.touch && this.peeked !== thread.key && isDrawn(thread)) {
      this.peeked = thread.key
      this.select(thread.key)
      return
    }
    this.peeked = null
    this.open(thread.card)
  }
  /** The keys of the listbox: its options', unmodified, leaving any control beside them its own. */
  private key(event: KeyboardEvent): void {
    const model = this.model
    if (!model || !(event.target as Element).matches('[role="option"]') || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const order = this.drawing.sequence?.(model) ?? model.order
    const at = order.findIndex(thread => thread.key === this.selected)
    const step = STEPS[event.key]
    let next: MapThread | undefined
    if (step) next = order[Math.max(0, Math.min(order.length - 1, at + step))]
    else if (event.key === 'Home') next = order[0]
    else if (event.key === 'End') next = order.at(-1)
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      this.open(order[at].card)
      return
    }
    if (!next) return
    event.preventDefault()
    this.select(next.key)
    const option = this.option()
    option?.focus()
    if (option) this.zoom.reveal(option)
    this.announcement.textContent = [next.note, next.files.length ? `${next.files.length} sent ${next.files.length === 1 ? 'file' : 'files'}` : ''].filter(Boolean).join('. ')
  }
}
