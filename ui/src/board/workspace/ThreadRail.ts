import { MOBILE_MEDIA } from '../mobile.js'
import { type KanbanCard } from '../KanbanTypes.js'
import { threadItem } from '../ThreadPeek.js'
import { threadState, type ThreadIndex } from '../threads.js'
import { turnOf } from '../turn.js'
import { documentLabelMetadata, lastSent, type Channel, type DocKey } from './documents.js'
import { foldSentFiles, sentDocuments, sentFileRow } from './SentFiles.js'
import './thread-rail.css'

const WIDTH_STORAGE = 'shuttle:workspace:thread-rail-width'
const MIN_WIDTH = 220
/** A sized region keeps at least its heading and a row; a drawn artifact keeps at least this much between them. */
const MIN_REGION = 72, MIN_ARTIFACT = 200
import { renderThreadTree } from './ThreadTree.js'
import { RailArtifact } from './RailArtifact.js'
import { HANDLE_STEP, RailFold, RailSplit, dragHandle } from './RailRegions.js'
import type { WorkspaceDocument } from './documents.js'

/**
 * The reader's right-hand column: the open constitution's threads first, then
 * its artifact, live, scaled to the rail's width and filling the height the
 * other two leave, then its sent files. Each region opens with a heading that
 * folds it, scrolls on its own, and is sized against the artifact by a
 * draggable boundary.
 *
 * The threads region is a view of the open constitution's whole family, from the top-level
 * constitution down: inside a thread the same family stays, the open thread
 * marked in place and its archived ancestry opened, so siblings and cousins
 * stay one click away. Navigation never changes containment.
 */
export class ThreadRail {
  readonly el = document.createElement('aside')
  private readonly scroller = document.createElement('div')
  readonly handle = document.createElement('div')
  /** The boundaries above and below a drawn artifact, each sizing the region on its far side. */
  readonly splitAbove: RailSplit
  readonly splitBelow: RailSplit
  private readonly threadsFold: RailFold
  private readonly filesFold: RailFold
  private readonly tree = document.createElement('div')
  private readonly files = document.createElement('section')
  private readonly fileList = document.createElement('div')
  private signature = ''
  private filesSignature = ''
  private filesExpanded = false
  private lastFiles: { channel: Channel; selected: DocKey; fresh: ReadonlySet<DocKey>; choose: (key: DocKey) => void } | null = null
  private width: number | null = null
  /** The reader stands the rail open beside the stage; the page loads only while the rail is also drawn. */
  private artifactWanted = false
  private card: KanbanCard | null = null
  /** Every thread in the family besides the open one is archived. */
  private familyQuiet = false
  /** Family presence is independent of the viewport's rail presentation. */
  hasFamily = false
  /** Another thread in the family waits on the human: a question, or something blocked. */
  needsHuman = false
  /** The open conversation has sent at least one file. */
  hasFiles = false
  /** The open constitution has an artifact the rail can show. */
  get hasArtifact(): boolean { return this.artifact.present }
  /** The rail has something to draw: an artifact, threads beside the open one, or sent files. */
  get present(): boolean { return this.hasArtifact || this.hasFamily || this.hasFiles }
  /** Nothing in the rail asks for the eye: no artifact, no sent files, and every other thread archived. */
  get quiet(): boolean { return this.familyQuiet && !this.hasFiles && !this.hasArtifact }
  readonly artifact: RailArtifact
  private readonly observer: ResizeObserver | null
  /** The constitution whose subtree the rail draws: the family's head. */
  private scope: KanbanCard | null = null
  /** The thread last revealed, so a repaint does not reopen a fold the reader closed. */
  private revealed = ''
  private index: ThreadIndex | null = null
  private readonly open: (card: KanbanCard) => void
  private readonly layout: () => void
  constructor(open: (card: KanbanCard) => void, layout: () => void, shuttleBase = '', navigate?: (source: WorkspaceDocument, href: string) => void) {
    this.open = open; this.layout = layout
    this.artifact = new RailArtifact(shuttleBase, navigate)
    this.artifact.onLayout = () => this.fit()
    this.el.className = 'ws-thread-rail'
    this.el.setAttribute('aria-label', 'Thread tree')
    this.threadsFold = new RailFold('Threads', 'shuttle:workspace:rail-threads-open', () => this.fit())
    this.filesFold = new RailFold('Sent files', 'shuttle:workspace:rail-files-open', () => this.fit())
    this.tree.className = 'ws-thread-tree'
    this.scroller.className = 'ws-thread-scroll'; this.scroller.append(this.threadsFold.heading, this.tree)
    this.fileList.className = 'ws-rail-file-list'
    this.files.className = 'ws-rail-files'; this.files.setAttribute('aria-label', 'Sent files')
    this.files.append(this.filesFold.heading, this.fileList)
    this.handle.className = 'ws-thread-handle'; this.handle.setAttribute('role', 'separator'); this.handle.setAttribute('aria-orientation', 'vertical')
    this.handle.setAttribute('aria-label', 'Resize thread tree'); this.handle.title = 'Drag to resize · double-click to reset'; this.handle.tabIndex = 0
    this.handle.addEventListener('pointerdown', e => this.resizeStart(e))
    this.handle.addEventListener('keydown', e => this.resizeKey(e))
    this.handle.addEventListener('dblclick', () => this.setWidth(null, true))
    // Each boundary leaves the artifact its minimum beside whatever the region across from it holds.
    const room = (other: HTMLElement): { min: number; max: number } =>
      ({ min: MIN_REGION, max: Math.max(MIN_REGION, Math.floor(this.el.clientHeight - (other.hidden ? 0 : other.getBoundingClientRect().height) - MIN_ARTIFACT)) })
    this.splitAbove = new RailSplit(this.el, { label: 'Resize threads and artifact', storage: 'shuttle:workspace:thread-rail-threads-height', region: this.scroller, below: false, bounds: () => room(this.files), changed: () => this.fit() })
    this.splitBelow = new RailSplit(this.el, { label: 'Resize artifact and sent files', storage: 'shuttle:workspace:thread-rail-files-height', region: this.files, below: true, bounds: () => room(this.scroller), changed: () => this.fit() })
    this.el.append(this.handle, this.scroller, this.splitAbove.el, this.artifact.el, this.splitBelow.el, this.files)
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.fit())
    this.observer?.observe(this.el)
    try {
      const stored = Number(localStorage.getItem(WIDTH_STORAGE))
      if (Number.isFinite(stored) && stored > 0) this.width = stored
    } catch { /* Storage is optional. */ }
    this.applyWidth()
  }
  private bounds(): { min: number; max: number } {
    return { min: MIN_WIDTH, max: Math.max(MIN_WIDTH, Math.floor(window.innerWidth * 0.5)) }
  }
  /** The viewer's width clamped to the viewport; absent, the stylesheet's default. */
  private applyWidth(): void {
    const { min, max } = this.bounds()
    if (this.width === null) this.el.style.removeProperty('--ws-thread-rail-width')
    else this.el.style.setProperty('--ws-thread-rail-width', `${Math.min(max, Math.max(min, Math.round(this.width)))}px`)
    this.handle.setAttribute('aria-valuemin', String(min)); this.handle.setAttribute('aria-valuemax', String(max))
    if (this.width !== null) this.handle.setAttribute('aria-valuenow', String(Math.min(max, Math.max(min, Math.round(this.width)))))
    else this.handle.removeAttribute('aria-valuenow')
  }
  private setWidth(width: number | null, persist: boolean): void {
    this.width = width; this.applyWidth(); this.layout()
    if (!persist) return
    try {
      if (width === null) localStorage.removeItem(WIDTH_STORAGE)
      else localStorage.setItem(WIDTH_STORAGE, String(Math.round(width)))
    } catch { /* Storage is optional. */ }
  }
  private resizeStart(e: PointerEvent): void {
    const startWidth = this.el.getBoundingClientRect().width, before = this.width
    // The handle is the rail's left edge, so dragging left widens it.
    dragHandle(this.handle, e, 'x', this.el, delta => {
      const { min, max } = this.bounds()
      this.setWidth(Math.min(max, Math.max(min, startWidth - delta)), false)
    }, commit => this.setWidth(commit ? this.width : before, commit))
  }
  private resizeKey(e: KeyboardEvent): void {
    const { min, max } = this.bounds(), now = this.el.getBoundingClientRect().width, step = HANDLE_STEP * (e.shiftKey ? 4 : 1)
    const next = e.key === 'ArrowLeft' ? now + step : e.key === 'ArrowRight' ? now - step
      : e.key === 'Home' ? min : e.key === 'End' ? max : e.key === 'Enter' ? null : undefined
    if (next === undefined) return
    e.preventDefault(); e.stopPropagation()
    this.setWidth(next === null ? null : Math.min(max, Math.max(min, next)), true)
  }
  show(card: KanbanCard, index: ThreadIndex): void {
    card = index.card(card)
    const ancestors: KanbanCard[] = []
    for (let parent = index.parentOf(card); parent; parent = index.parentOf(parent)) ancestors.unshift(parent)
    const scope = ancestors[0] ?? card
    this.card = card; this.scope = scope; this.index = index
    const descendants = index.subtree(scope)
    const others = [scope, ...descendants].filter(c => !(c.id === card.id && c.originId === card.originId))
    this.hasFamily = others.length > 0
    this.familyQuiet = others.every(c => threadState(c) === 'archived')
    this.needsHuman = others.some(c => threadState(c) === 'waiting' && ['question', 'blocked'].includes(turnOf(c).turn))
    this.applyPresence()
    if (window.matchMedia(MOBILE_MEDIA).matches) {
      this.tree.replaceChildren(); this.signature = ''
      return
    }
    const signature = JSON.stringify([card.id, card.originId, scope.id, ...ancestors.map(c => [c.id, c.name]), ...[scope, ...descendants].map(c => [c.id, c.orchestrator, c.name, c.createdAt, c.status, c.tempered, c.runtimePhase, c.workerState, c.ask, c.outcome, c.originStale, c.launchError, c.effectiveHorizon, c.tags, c.shuttleBlockedOn])])
    if (signature === this.signature) return
    this.signature = signature
    this.paint()
  }
  /**
   * The open conversation's sent files, newest first, repainted only when a
   * row would change; a click opens the file in the reader.
   */
  showFiles(channel: Channel, selected: DocKey, fresh: ReadonlySet<DocKey>, choose: (key: DocKey) => void): void {
    const docs = sentDocuments(channel)
    this.hasFiles = docs.length > 0
    if (this.lastFiles && (this.lastFiles.channel.uid !== channel.uid || this.lastFiles.channel.owner !== channel.owner)) this.filesExpanded = false
    this.lastFiles = { channel, selected, fresh, choose }
    this.applyPresence()
    if (window.matchMedia(MOBILE_MEDIA).matches) { this.fileList.replaceChildren(); this.filesSignature = ''; return }
    const signature = JSON.stringify([channel.uid, channel.owner, new Date().toDateString(), this.filesExpanded, ...docs.map(doc => [doc.key, documentLabelMetadata(doc, doc.name, channel.owner).title, lastSent(doc), fresh.has(doc.key), doc.key === selected])])
    if (signature === this.filesSignature) return
    this.filesSignature = signature
    const active = document.activeElement
    const focus = active instanceof HTMLElement && this.fileList.contains(active) ? active.dataset.key : undefined
    if (!docs.length) {
      const empty = document.createElement('p'); empty.className = 'ws-rail-files-empty'; empty.textContent = 'No files sent yet.'
      this.fileList.replaceChildren(empty)
    } else {
      const rows = docs.map(doc => sentFileRow(channel, doc, selected, fresh, choose, 'ws-rail-file', true))
      this.fileList.replaceChildren(...foldSentFiles(rows, this.filesExpanded, expanded => {
        this.filesExpanded = expanded
        const last = this.lastFiles
        if (last) this.showFiles(last.channel, last.selected, last.fresh, last.choose)
        this.fileList.querySelector<HTMLElement>('[data-part="sent-files-more"]')?.focus({ preventScroll: true })
      }, 'ws-rail-files-more'))
    }
    if (focus !== undefined) {
      const target = [...this.fileList.querySelectorAll<HTMLElement>('.ws-rail-file')].find(el => el.dataset.key === focus)
      if (target) target.focus({ preventScroll: true })
      else this.filesFold.focus()
    }
  }
  /** The artifact the rail shows, or none. */
  showArtifact(doc: WorkspaceDocument | null, openFull: (key: string) => void, onStage = false): void {
    this.artifact.show(doc, openFull, onStage)
    this.applyPresence()
  }
  /** Load the artifact while the rail stands open beside the stage; unload it otherwise. */
  setArtifactLive(live: boolean): void {
    this.artifactWanted = live
    this.artifact.setLive(live && !this.el.hidden)
    this.fit()
  }
  /**
   * Lay the regions out: which one takes the rail's free height (a drawn
   * artifact, else open sent files, else open threads), which leads (and so
   * leaves room for the corner toggle), and which boundaries stand. Then scale
   * the artifact to the rail's width.
   */
  fit(): void {
    const threads = this.hasFamily, artifact = this.artifact.present, fills = this.artifact.fills
    this.scroller.hidden = !threads
    this.tree.hidden = !this.threadsFold.open
    this.fileList.hidden = !this.filesFold.open
    this.el.dataset.fill = fills ? 'artifact' : this.filesFold.open ? 'files' : threads && this.threadsFold.open ? 'threads' : 'none'
    const lead = threads ? this.scroller : artifact ? this.artifact.el : this.files
    for (const region of [this.scroller, this.artifact.el, this.files]) region.toggleAttribute('data-lead', region === lead)
    if (this.el.hidden) return
    this.splitAbove.apply(fills && threads && this.threadsFold.open)
    this.splitBelow.apply(fills && this.filesFold.open)
    this.artifact.resize()
  }
  dispose(): void { this.observer?.disconnect(); this.artifact.dispose() }
  /** A conversation with no constitution card has no family to draw. */
  clearFamily(): void {
    this.card = null; this.scope = null; this.index = null
    this.hasFamily = false; this.familyQuiet = true; this.needsHuman = false
    this.tree.replaceChildren(); this.signature = ''
    this.applyPresence()
  }
  /** Bring the sent files into view and give their heading focus. */
  focusFiles(): void {
    this.fileList.scrollTop = 0
    this.filesFold.focus()
  }
  /** A rail with nothing to draw hides; the threads region stands only for a family. */
  private applyPresence(): void {
    this.el.hidden = window.matchMedia(MOBILE_MEDIA).matches || !this.present
    this.artifact.setLive(this.artifactWanted && !this.el.hidden)
    this.fit()
  }
  private paint(): void {
    if (!this.card || !this.scope) return
    const current = this.card, scope = this.scope
    const active = document.activeElement
    const focus = active instanceof HTMLElement && this.tree.contains(active) ? active.dataset.threadFocus : undefined
    const open = new Map([...this.tree.querySelectorAll<HTMLDetailsElement>('details[data-thread-details]')].map(el => [el.dataset.threadDetails!, el.open]))
    const index = this.index!
    const visit = JSON.stringify([current.id, current.originId, current.feltStore, scope.id])
    const arriving = visit !== this.revealed
    this.revealed = visit
    const rows = renderThreadTree(index, scope, current, (card, focus) => {
      const item = threadItem(card, index, this.open, focus)
      const pin = item.querySelector<HTMLButtonElement>('.kbn-thread-pin')!
      const here = card.id === current.id && card.originId === current.originId && card.feltStore === current.feltStore
      pin.hidden = !here && pin.getAttribute('aria-pressed') !== 'true'
      pin.tabIndex = pin.hidden ? -1 : 0
      return item
    }, open, arriving)
    this.tree.replaceChildren(...rows)
    const currentRow = this.tree.querySelector<HTMLElement>('.ws-thread-current')
    this.layout()
    if (arriving && currentRow && (this.tree.scrollTop > 0 || currentRow !== this.tree.firstElementChild?.querySelector('.kbn-thread-row')) && typeof currentRow.scrollIntoView === 'function') currentRow.scrollIntoView({ block: 'nearest' })
    if (focus) {
      const target = [...this.tree.querySelectorAll<HTMLElement>('[data-thread-focus]')].find(el => el.dataset.threadFocus === focus)
      if (target) target.focus({ preventScroll: true })
      else this.threadsFold.focus()
    }
  }
}
