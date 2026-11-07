import type { KanbanCard } from '../KanbanTypes.js'
import { ATTENTION, ATTENTION_WORD, conversable, familyModel, isDrawn, needsHuman, type FamilyModel, type MapFeeds, type MapFile, type MapThread } from '../family/model.js'
import { htmlEl as el, markPath, markSelection, shortAgo, svgEl, type Drawing, type Holds, type Sight } from '../family/drawing.js'
import { aim, arrival, sighted } from '../family/orbit.js'
import { ROSTER, chooseDrawing, chosenDrawing } from '../family/roster.js'
import { FieldZoom, WHOLE, type View } from '../family/zoom.js'
import { bindDrawnPage } from '../FileViewerPanel.js'
import { threadItem } from '../ThreadPeek.js'
import { threadKey, type ThreadIndex } from '../threads.js'
import { fiberKey } from './documents.js'
import { renderThreadTree } from './ThreadTree.js'
import './family-page.css'

/** Sent files named in a peek before the rest become a count. */
const PEEK_FILES = 4
/** A resize's quiet after which the stage has its size: a page crossing resizes it every frame. */
const SETTLE_MS = 120
const STEPS: Readonly<Record<string, number>> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }

/** What the map reads, and how to ask for it again. */
export interface FamilyFeeds extends MapFeeds {
  refresh(): void
  /** The thread's tapestry or report, read when the map comes to it. */
  lead(card: KanbanCard): Promise<MapFile | undefined>
}

/**
 * Where a map stands, kept by its channel so it outlives the page's frame:
 * the thread it has unfolded, and the view a hand left it at, or null while
 * it holds that thread (or the whole family) in frame.
 */
export interface MapPlace {
  focus: string | null
  view: View | null
  /** The thread whose conversation Rex holds: moved by a click on a body or by Rex, never by a view. */
  worker?: string
}

/**
 * The family's page in the reader: the map on its stage with a roster of
 * drawings, the counts of what asks above it, and a peek at the selected
 * thread below it. Selection follows the pointer, the arrows and a first tap.
 * Zooming moves freely over every thread and never reaches Rex; a click or
 * Enter flies to a thread, unfolds it and opens its conversation at once.
 * Stepping out retraces the tree. A finger comes to a thread on a first tap
 * and opens the conversation on a second.
 * Where the map stands survives leaving and coming back; the tree of every
 * thread folds at the foot. It reads feeds, repaints and animates only while
 * its frame is selected in an open reader; its frame's eviction ends it.
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
  private readonly announcement = el('p', 'ws-family-announce')
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
  /** The thread a first tap came to, which a second tap converses with. */
  private peeked: string | null = null
  /** Each thread's tapestry as far as it has been read, null for none yet or none at all. */
  private readonly leads = new Map<string, MapFile | null>()
  private readonly open: (card: KanbanCard, doc?: string) => void
  private readonly feeds: FamilyFeeds
  private readonly place: MapPlace
  private readonly levelled: () => void

  private readonly converse: (card: KanbanCard, quiet?: boolean) => void

  /** `open` leaves for a document, or a thread the map has no place for; `converse` opens a conversation, `quiet` leaving the keyboard here; `levelled` hears the map change level or come to rest. */
  constructor(open: (card: KanbanCard, doc?: string) => void, converse: (card: KanbanCard, quiet?: boolean) => void, feeds: FamilyFeeds, place: MapPlace, disposed: () => void, levelled: () => void = () => {}) {
    this.open = open; this.converse = converse; this.feeds = feeds; this.place = place; this.disposed = disposed; this.levelled = levelled
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
    this.stage.addEventListener('click', event => this.openHeld(event))
    this.stage.addEventListener('pointerdown', event => { this.touch = event.pointerType === 'touch' })
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resized())
    this.observer?.observe(this.stage)
    this.zoom = new FieldZoom(this.stage, () => this.moved(), inward => this.gestured(inward), () => this.stepOut())
    if (place.view) this.zoom.jump(place.view)
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
    if (this.place.focus && !this.model.threads.has(this.place.focus)) this.place.focus = null
    if (this.lone) this.place.focus = this.model.root.key
    this.paint()
    this.readLead()
    this.paintTree(index, root, index.card(card))
  }
  /** The next drawing of the roster. */
  cycle(): void { this.show(ROSTER[(ROSTER.indexOf(this.drawing) + 1) % ROSTER.length]) }
  /** Takes the keys, on the selected thread. */
  focus(): void { this.option()?.focus({ preventScroll: true }) }

  /** Comes to the thread Rex moved to, leaving Rex be; false off this map. */
  flyTo(card: KanbanCard): boolean {
    const thread = this.model?.threads.get(threadKey(card))
    if (!thread || !isDrawn(thread)) return false
    this.place.worker = thread.key
    this.come(thread)
    return true
  }
  /** One level out, along the tree to the whole family; false once it is whole. */
  stepOut(): boolean {
    const model = this.model, focus = this.focused
    if (!model || !this.outward) return false
    const parent = focus?.parent && focus.depth > 1 ? model.threads.get(focus.parent) : undefined
    if (parent) this.come(parent)
    else {
      this.setFocus(null)
      this.place.view = null
      this.zoom.fly(WHOLE)
      this.drawField()
      this.levelled()
    }
    return true
  }
  /** The name of the level stepping out reaches, while there is one to reach. */
  get outward(): string | undefined {
    const focus = this.focused
    const whole = this.zoom.drawn.k === 1 && (!focus || (focus === this.model?.root && !!this.drawing.layout))
    if (!this.unfolds || this.lone || whole) return undefined
    const parent = focus?.parent && focus.depth > 1 ? this.model?.threads.get(focus.parent) : undefined
    return parent?.name ?? 'Whole family'
  }
  /** The map has come to a thread other than its page's own. */
  get elsewhere(): boolean { return !!this.focused && this.focused.key !== this.model?.current }
  /** What `l` opens from a thread: its tapestry, else its newest file. */
  get leading(): { card: KanbanCard; doc: string } | undefined {
    const focus = this.focused ?? (this.drawing.layout ? this.model?.root : undefined), file = (focus && this.leads.get(focus.key)) ?? focus?.files[0]
    return focus && file ? { card: focus.card, doc: file.key } : undefined
  }

  /** A constitution with no threads: one body, held unfolded, with no level above it. */
  private get lone(): boolean { return this.model?.threads.size === 1 }
  /** The drawing has somewhere to unfold a thread: a field, or a fold in its rows. */
  private get unfolds(): boolean { return !!this.drawing.layout || !!this.drawing.folds }
  private get focused(): MapThread | undefined { return this.place.focus ? this.model?.threads.get(this.place.focus) : undefined }
  private get sight(): Sight {
    return { key: this.focused?.key ?? null, holds: thread => this.holds(thread) }
  }
  private holds(thread: MapThread): Holds {
    return {
      lead: this.leads.get(thread.key) ?? undefined,
      constitution: { key: fiberKey(thread.card.originId, thread.card.uid ?? thread.card.id), name: 'Constitution', at: 0, unread: false },
    }
  }
  private stageSize(): { width: number; height: number } { return { width: this.stage.clientWidth || 1000, height: this.stage.clientHeight || 680 } }
  /** The view that holds the focused thread in frame, or the whole family. */
  private aimed(): View {
    const layout = this.drawing.layout, thread = this.focused
    if (!layout || !thread || !this.model) return WHOLE
    const { width, height } = this.stageSize()
    return aim(layout(this.model, width, height), thread)
  }
  private setFocus(key: string | null): void {
    if (key === this.place.focus) return
    this.place.focus = key
    if (key) this.leads.delete(key)
    this.readLead()
  }
  /** Reads the tapestry of the focused thread and of each body showing what it holds, once each. */
  private readLead(): void {
    const owners = [...this.stage.querySelectorAll<HTMLElement>('.fm-mini-set')].map(set => set.dataset.owner!)
    for (const key of [this.focused?.key ?? this.model?.root.key, ...owners]) {
      const thread = key ? this.model?.threads.get(key) : undefined
      if (!thread || this.leads.has(thread.key)) continue
      this.leads.set(thread.key, null)
      void this.feeds.lead(thread.card).then(lead => {
        if (!lead) return
        this.leads.set(thread.key, lead)
        if (this.awake) this.drawField()
      })
    }
  }
  /** Comes to a thread: the map flies to it, and whatever it holds unfolds. */
  private come(thread: MapThread): void {
    this.select(thread.key)
    if (!this.unfolds) { this.levelled(); return }
    this.setFocus(thread.key)
    this.place.view = null
    this.zoom.fly(this.aimed())
    this.drawField()
    this.levelled()
  }
  /** The field has moved a frame, by a hand or a flight: everything on it follows, to whichever thread a hand has reached. */
  private moved(): void {
    if (!this.awake || this.lone) return
    if (!this.zoom.flying) this.sightFocus()
    this.drawField()
  }
  private sightFocus(): void {
    const model = this.model, layout = this.drawing.layout
    if (!model || !layout) return
    const { width, height } = this.stageSize()
    this.setFocus(sighted(layout(model, width, height), this.zoom.drawn, this.place.focus))
  }
  /** A hand has let go of the field: the map stands where it left it, except that a zoom inward comes to rest on the scene of the thread it reached. */
  private gestured(inward: boolean): void {
    if (this.lone) { this.zoom.jump(this.aimed()); this.repaintStill(); return }
    this.sightFocus()
    const model = this.model, layout = this.drawing.layout
    if (inward && model && layout) {
      const { width, height } = this.stageSize()
      this.setFocus(arrival(layout(model, width, height), this.zoom.drawn, this.place.focus))
    }
    const thread = this.focused
    if (inward && thread && thread !== model?.root) {
      this.place.view = null
      this.select(thread.key)
      this.zoom.fly(this.aimed())
      this.drawField()
      this.readLead()
      this.levelled()
      return
    }
    this.place.view = this.zoom.drawn.k === 1 ? null : this.zoom.drawn
    const before = this.selected
    this.repaintStill()
    this.readLead()
    if (this.place.focus && this.place.focus !== before) this.select(this.place.focus)
    this.levelled()
  }
  /** A thing a thread holds opens on the stage, leaving the map standing where it is. */
  private openHeld(event: Event): void {
    const way = (event.target as Element).closest<HTMLElement>('[data-held]')
    const thread = this.model?.threads.get(way?.dataset.owner ?? '')
    if (way && thread) this.open(thread.card, way.dataset.held)
  }

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
    this.place.view = null
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
    if (!this.zoom.flying) this.zoom.jump(this.place.view ?? this.aimed())
    this.drawField()
    this.reading.replaceChildren(...this.drawing.reading.map(phrase => el('span', '', phrase)))
    const { drafts, resting, archived } = model.aside
    this.allShort.textContent = `${drafts + resting + archived} aside`
    this.allCounts.textContent = [drafts && `${drafts} ${drafts === 1 ? 'draft' : 'drafts'}`, resting && `${resting} resting`, archived && `${archived} archived`].filter(Boolean).join(' · ')
    const kept = this.selected ? model.threads.get(this.selected) : undefined
    const landing = model.current !== model.root.key ? model.threads.get(model.current ?? '') : undefined
    this.selected = null
    const walk = this.walk(model)
    this.select([kept, this.focused, landing].find(thread => thread && walk.includes(thread))?.key ?? walk[0].key)
    if (this.refocus) { this.refocus = false; this.focus() }
  }
  /** The threads the drawing shows, in the arrow keys' order. */
  private walk(model: FamilyModel): MapThread[] { return this.drawing.sequence?.(model, this.place.focus) ?? model.order }
  /** The field alone, as the view or the focus moves. */
  private drawField(): void {
    const model = this.model
    if (!model) return
    this.drawing.draw(this.stage, model, thread => this.activate(thread), this.zoom.drawn, this.sight)
    markSelection(this.stage, model, this.selected)
    for (const body of this.stage.querySelectorAll('.fm-star, .fm-row')) body.toggleAttribute('data-worker', body.getAttribute('data-thread') === this.place.worker)
  }
  private paintTree(index: ThreadIndex, root: KanbanCard, current: KanbanCard): void {
    for (const fold of this.allBody.querySelectorAll<HTMLDetailsElement>('details[data-thread-details]')) this.openFolds.set(fold.dataset.threadDetails!, fold.open)
    const active = document.activeElement
    const focus = active instanceof HTMLElement && this.allBody.contains(active) ? active.dataset.threadFocus : undefined
    this.allBody.replaceChildren(...renderThreadTree(index, root, current, (thread, key) => {
      const item = threadItem(thread, index, card => this.reach(card), key), pin = item.querySelector<HTMLButtonElement>('.kbn-thread-pin')!
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
    title.dataset.standing = thread.tone
    title.querySelector('.ws-family-peek-meta')!.textContent = this.peekMeta(thread)
    this.peek.dataset.asks = String(needsHuman(thread))
  }
  private peekMeta(thread: MapThread): string { return [thread.word, shortAgo(thread.lastMove, this.model!.now)].join(' · ') }
  private buildPeek(thread: MapThread): void {
    const live = (): MapThread => this.model!.threads.get(thread.key)!
    const card = (): KanbanCard => live().card
    const name = el('button', 'ws-family-peek-name', thread.name); name.type = 'button'
    name.addEventListener('click', () => this.reach(card()))
    const title = el('div', 'ws-family-peek-title'); title.append(name, el('span', 'ws-family-peek-meta'))
    if (conversable(thread.card)) {
      const worker = el('button', 'ws-family-peek-worker', thread.card.terminalBackend === 'rex' ? 'Open in Rex' : 'Open conversation'); worker.type = 'button'
      worker.title = `${worker.textContent} · c`
      worker.addEventListener('click', () => this.converse(card()))
      title.append(worker)
    }
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
  /** The thread the map has come to rest on, which voice follows: never a hover, and the family's root while it stands whole. */
  get settled(): KanbanCard | undefined {
    const key = this.unfolds ? this.place.focus : this.selected
    return (key ? this.model?.threads.get(key) : this.model?.root)?.card
  }
  /** The thread the map has selected, which `c` opens the worker of. */
  get selection(): KanbanCard | undefined {
    return this.selected ? this.model?.threads.get(this.selected)?.card : undefined
  }
  private rest(event: PointerEvent): void {
    this.touch = event.pointerType === 'touch'
    const key = (event.target as Element).closest('[data-thread]')?.getAttribute('data-thread')
    const thread = key ? this.model?.threads.get(key) : undefined
    if (thread && isDrawn(thread) && !this.touch) this.select(thread.key)
  }
  /** A row of the fold or the peek does what a click on its body does, with the fold out of the way of the flight; a thread the map has no place for opens on its own. */
  private reach(card: KanbanCard): void {
    const thread = this.model?.threads.get(threadKey(card))
    if (!thread || !isDrawn(thread)) { this.open(card); return }
    this.all.open = false
    this.activate(thread)
    this.focus()
  }
  /** A click or Enter comes to a thread and moves Rex to it; a finger comes to it first and opens the conversation on its second tap. */
  private activate(thread: MapThread): void {
    if (this.touch && this.peeked !== thread.key) {
      this.peeked = thread.key
      this.come(thread)
      return
    }
    this.peeked = null
    this.come(thread)
    if (!conversable(thread.card)) return
    this.place.worker = thread.key
    this.converse(thread.card, true)
    this.drawField()
  }
  /** The keys of the listbox: its options', unmodified, leaving any control beside them its own. */
  private key(event: KeyboardEvent): void {
    const model = this.model
    if (!model || !(event.target as Element).matches('[role="option"]') || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const order = this.walk(model)
    const at = order.findIndex(thread => thread.key === this.selected)
    const step = STEPS[event.key]
    let next: MapThread | undefined
    if (step) next = order[Math.max(0, Math.min(order.length - 1, at + step))]
    else if (event.key === 'Home') next = order[0]
    else if (event.key === 'End') next = order.at(-1)
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      this.touch = false
      this.activate(order[at])
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
