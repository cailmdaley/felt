import type { KanbanCard } from '../KanbanTypes.js'
import { ATTENTION, ATTENTION_WORD, familyModel, needsHuman, type FamilyModel, type MapFeeds, type MapThread } from '../family/model.js'
import { htmlEl as el, markPath, markSelection, shortAgo, svgEl, type Drawing } from '../family/drawing.js'
import { ROSTER, chooseDrawing, chosenDrawing } from '../family/roster.js'
import { threadItem } from '../ThreadPeek.js'
import { threadKey, type ThreadIndex } from '../threads.js'
import { renderThreadTree } from './ThreadTree.js'
import './family-page.css'

/** Sent files named in a peek before the rest become a count. */
const PEEK_FILES = 4
const STEPS: Readonly<Record<string, number>> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }

/**
 * The family's page in the reader: the map on its stage with a roster of
 * drawings, the counts of what asks above it, and a peek at the selected
 * thread below it. Selection follows the pointer, the arrows and a first tap,
 * and survives leaving and coming back; the tree of every thread folds at the
 * foot.
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
  private readonly observer: ResizeObserver | null
  private drawing: Drawing = chosenDrawing() ?? ROSTER[0]
  private model: FamilyModel | null = null
  private last: { card: KanbanCard; index: ThreadIndex } | null = null
  private selected: string | null = null
  private signature = ''
  private touch = false
  /** The thread a first tap peeked at, which a second tap opens. */
  private peeked: string | null = null
  private readonly open: (card: KanbanCard, doc?: string) => void
  private readonly feeds: MapFeeds

  constructor(open: (card: KanbanCard, doc?: string) => void, feeds: MapFeeds) {
    this.open = open; this.feeds = feeds
    this.stage.setAttribute('role', 'listbox')
    this.stage.setAttribute('aria-label', 'Threads, most urgent first')
    this.scroller.append(this.stage)
    this.peek.setAttribute('aria-live', 'polite')
    this.peek.setAttribute('aria-label', 'Selected thread')
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
    grid.append(this.counts, this.roster, this.scroller, this.peek, this.reading, this.all)
    this.el.append(grid)
    this.stage.addEventListener('keydown', event => this.key(event))
    this.stage.addEventListener('pointerover', event => this.rest(event))
    this.stage.addEventListener('pointerdown', event => { this.touch = event.pointerType === 'touch' })
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { this.stage.classList.add('family-map-still'); this.paint(); requestAnimationFrame(() => this.stage.classList.remove('family-map-still')) })
    this.observer?.observe(this.stage)
  }

  update(card: KanbanCard, index: ThreadIndex, now = Date.now()): void {
    this.last = { card, index }
    const root = index.family(index.card(card)).root
    const family = [root, ...index.subtree(root)]
    this.drawing = chosenDrawing() ?? this.drawing
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
    this.drawing = drawing
    this.signature = ''
    const focused = this.stage.contains(document.activeElement)
    this.stage.replaceChildren()
    this.stage.className = ''
    this.stage.ondblclick = null
    this.repaint()
    if (focused) this.focus()
    this.option()?.scrollIntoView?.({ block: 'nearest' })
  }
  private repaint(): void { if (this.last) this.update(this.last.card, this.last.index) }
  private option(): HTMLElement | SVGElement | null {
    return this.stage.querySelector<HTMLElement | SVGElement>('[role="option"][tabindex="0"]')
  }
  private paint(): void {
    const model = this.model
    if (!model) return
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
    this.drawing.draw(this.stage, model, thread => this.activate(thread))
    this.reading.replaceChildren(...this.drawing.reading.map(phrase => el('span', '', phrase)))
    const { drafts, resting, archived } = model.aside
    this.allShort.textContent = `${drafts + resting + archived} aside`
    this.allCounts.textContent = [drafts && `${drafts} ${drafts === 1 ? 'draft' : 'drafts'}`, resting && `${resting} resting`, archived && `${archived} archived`].filter(Boolean).join(' · ')
    const keep = this.selected && model.threads.has(this.selected) ? this.selected : null
    const landing = model.current !== model.root.key ? model.current : null
    this.selected = null
    this.select(keep ?? (landing && model.threads.get(landing)!.rank >= 0 ? landing : null) ?? model.order[0]?.key ?? model.root.key)
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
  private paintPeek(thread: MapThread): void {
    const name = el('button', 'ws-family-peek-name', thread.name); name.type = 'button'
    name.addEventListener('click', () => this.open(thread.card))
    const meta = el('span', 'ws-family-peek-meta', [thread.word, shortAgo(thread.lastMove, this.model!.now)].join(' · '))
    const title = el('div', 'ws-family-peek-title'); title.append(name, meta)
    title.dataset.standing = thread.standing
    const note = el('p', 'ws-family-peek-note', thread.note)
    const files = el('div', 'ws-family-peek-files')
    for (const file of thread.files.slice(0, PEEK_FILES)) {
      const chip = el('button', 'ws-family-peek-file', file.name); chip.type = 'button'
      chip.toggleAttribute('data-unread', file.unread)
      chip.addEventListener('click', () => this.open(thread.card, file.key))
      files.append(chip)
    }
    if (thread.files.length > PEEK_FILES) files.append(el('span', 'ws-family-peek-more', `+${thread.files.length - PEEK_FILES}`))
    this.peek.dataset.asks = String(needsHuman(thread))
    this.peek.replaceChildren(title, note, files)
  }
  private rest(event: PointerEvent): void {
    this.touch = event.pointerType === 'touch'
    const key = (event.target as Element).closest('[data-thread]')?.getAttribute('data-thread')
    if (key && !this.touch) this.select(key)
  }
  /** A click or Enter opens; a finger peeks first and opens on its second tap. */
  private activate(thread: MapThread): void {
    if (this.touch && this.peeked !== thread.key) {
      this.peeked = thread.key
      this.select(thread.key)
      return
    }
    this.peeked = null
    this.open(thread.card)
  }
  private key(event: KeyboardEvent): void {
    const model = this.model
    if (!model?.order.length) return
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
    this.option()?.focus()
  }
}
