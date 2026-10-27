import { MOBILE_MEDIA } from '../mobile.js'
import { type KanbanCard } from '../KanbanTypes.js'
import { threadItem } from '../ThreadPeek.js'
import { deskColumn } from '../deskColumn.js'
import { threadKey, threadState, type ThreadIndex, type ThreadState } from '../threads.js'
import { turnOf } from '../turn.js'
import { documentLabelMetadata, lastSent, type Channel, type DocKey } from './documents.js'
import { sentDocuments, sentFileRow } from './SentFiles.js'
import './thread-rail.css'

const WIDTH_STORAGE = 'shuttle:workspace:thread-rail-width'
const MIN_WIDTH = 220, MAX_WIDTH = 640, STEP = 16
import { THREAD_GROUPS, threadGroup } from './threadGroups.js'

/**
 * The reader's right-hand column: the open constitution's threads above, its
 * sent files beneath, each region scrolling on its own.
 *
 * The threads region is a view of the open constitution's whole family, from the top-level
 * constitution down: inside a thread the same family stays, the open thread
 * marked in place and its ancestry's groups opened, so siblings and cousins
 * stay one click away. Navigation never changes containment.
 */
export class ThreadRail {
  readonly el = document.createElement('aside')
  private readonly scroller = document.createElement('div')
  readonly handle = document.createElement('div')
  private readonly tree = document.createElement('div')
  private readonly heading = document.createElement('h2')
  private readonly files = document.createElement('section')
  private readonly filesHeading = document.createElement('h2')
  private readonly fileList = document.createElement('div')
  private signature = ''
  private filesSignature = ''
  private width: number | null = null
  private card: KanbanCard | null = null
  /** Every thread in the family besides the open one is archived. */
  private familyQuiet = false
  /** Family presence is independent of the viewport's rail presentation. */
  hasFamily = false
  /** The open conversation has sent at least one file. */
  hasFiles = false
  /** The rail has something to draw: threads beside the open one, or sent files. */
  get present(): boolean { return this.hasFamily || this.hasFiles }
  /** Nothing in the rail asks for the eye: no sent files, and every other thread archived. */
  get quiet(): boolean { return this.familyQuiet && !this.hasFiles }
  /** The constitution whose subtree the rail draws: the family's head. */
  private scope: KanbanCard | null = null
  /** The thread last revealed, so a repaint does not reopen a group the reader folded. */
  private revealed = ''
  private index: ThreadIndex | null = null
  private readonly open: (card: KanbanCard) => void
  private readonly layout: () => void
  constructor(open: (card: KanbanCard) => void, layout: () => void) {
    this.open = open; this.layout = layout
    this.el.className = 'ws-thread-rail'
    this.el.setAttribute('aria-label', 'Thread tree')
    // The rail shows and hides from the reader's corner toggle; its heading only names it.
    this.heading.className = 'ws-thread-heading'; this.heading.textContent = 'Threads'; this.heading.tabIndex = -1
    this.tree.className = 'ws-thread-tree'
    this.scroller.className = 'ws-thread-scroll'; this.scroller.append(this.heading, this.tree)
    this.filesHeading.className = 'ws-thread-heading'; this.filesHeading.textContent = 'Sent files'; this.filesHeading.tabIndex = -1
    this.fileList.className = 'ws-rail-file-list'
    this.files.className = 'ws-rail-files'; this.files.setAttribute('aria-label', 'Sent files')
    this.files.append(this.filesHeading, this.fileList)
    this.handle.className = 'ws-thread-handle'; this.handle.setAttribute('role', 'separator'); this.handle.setAttribute('aria-orientation', 'vertical')
    this.handle.setAttribute('aria-label', 'Resize thread tree'); this.handle.title = 'Drag to resize · double-click to reset'; this.handle.tabIndex = 0
    this.handle.addEventListener('pointerdown', e => this.resizeStart(e))
    this.handle.addEventListener('keydown', e => this.resizeKey(e))
    this.handle.addEventListener('dblclick', () => this.setWidth(null, true))
    this.el.append(this.handle, this.scroller, this.files)
    try {
      const stored = Number(localStorage.getItem(WIDTH_STORAGE))
      if (Number.isFinite(stored) && stored > 0) this.width = stored
    } catch { /* Storage is optional. */ }
    this.applyWidth()
  }
  private bounds(): { min: number; max: number } {
    return { min: MIN_WIDTH, max: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.5))) }
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
    if (e.button !== 0) return
    e.preventDefault()
    const handle = this.handle, startX = e.clientX, startWidth = this.el.getBoundingClientRect().width, before = this.width
    try { handle.setPointerCapture(e.pointerId) } catch { /* Capture is an enhancement. */ }
    this.el.classList.add('ws-thread-resizing')
    let latched = false
    // The handle is the rail's left edge, so dragging left widens it.
    const move = (ev: PointerEvent): void => {
      const delta = startX - ev.clientX
      if (!latched && Math.abs(delta) < 4) return
      latched = true
      const { min, max } = this.bounds()
      this.setWidth(Math.min(max, Math.max(min, startWidth + delta)), false)
    }
    const finish = (commit: boolean): void => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', key, true)
      this.el.classList.remove('ws-thread-resizing')
      try { if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId) } catch { /* Already released. */ }
      if (!latched) return
      this.setWidth(commit ? this.width : before, commit)
    }
    const up = (): void => finish(true), cancel = (): void => finish(false)
    const key = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); finish(false) } }
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', cancel); window.addEventListener('keydown', key, true)
  }
  private resizeKey(e: KeyboardEvent): void {
    const { min, max } = this.bounds(), now = this.el.getBoundingClientRect().width, step = STEP * (e.shiftKey ? 4 : 1)
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
    this.applyPresence()
    if (window.matchMedia(MOBILE_MEDIA).matches) {
      this.tree.replaceChildren(); this.signature = ''
      return
    }
    const signature = JSON.stringify([card.id, card.originId, scope.id, ...ancestors.map(c => [c.id, c.name]), ...[scope, ...descendants].map(c => [c.id, c.orchestrator, c.name, c.status, c.tempered, c.runtimePhase, c.workerState, c.ask, c.outcome, c.originStale, c.launchError, c.effectiveHorizon, c.tags, c.shuttleBlockedOn])])
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
    this.applyPresence()
    if (window.matchMedia(MOBILE_MEDIA).matches) { this.fileList.replaceChildren(); this.filesSignature = ''; return }
    const signature = JSON.stringify([channel.uid, channel.owner, ...docs.map(doc => [doc.key, documentLabelMetadata(doc, doc.name, channel.owner).title, lastSent(doc), fresh.has(doc.key), doc.key === selected])])
    if (signature === this.filesSignature) return
    this.filesSignature = signature
    const active = document.activeElement
    const focus = active instanceof HTMLElement && this.fileList.contains(active) ? active.dataset.key : undefined
    if (!docs.length) {
      const empty = document.createElement('p'); empty.className = 'ws-rail-files-empty'; empty.textContent = 'No files sent yet.'
      this.fileList.replaceChildren(empty)
    } else this.fileList.replaceChildren(...docs.map(doc => sentFileRow(channel, doc, selected, fresh, choose, 'ws-rail-file', true)))
    if (focus !== undefined) {
      const target = [...this.fileList.querySelectorAll<HTMLElement>('.ws-rail-file')].find(el => el.dataset.key === focus)
      ;(target ?? this.filesHeading).focus({ preventScroll: true })
    }
  }
  /** Bring the sent files into view and give their heading focus. */
  focusFiles(): void {
    this.fileList.scrollTop = 0
    this.filesHeading.focus({ preventScroll: true })
  }
  /** A rail with nothing to draw hides; the threads region stands only for a family. */
  private applyPresence(): void {
    this.el.hidden = window.matchMedia(MOBILE_MEDIA).matches || !this.present
    this.scroller.hidden = !this.hasFamily
  }
  private paint(): void {
    if (!this.card || !this.scope) return
    const current = this.card, scope = this.scope
    const active = document.activeElement
    const focus = active instanceof HTMLElement && this.tree.contains(active) ? active.dataset.threadFocus : undefined
    const open = new Map([...this.tree.querySelectorAll<HTMLDetailsElement>('details[data-thread-details]')].map(el => [el.dataset.threadDetails!, el.open]))
    const index = this.index!
    const focusOf = (kind: string, card: KanbanCard): string => JSON.stringify([kind, card.originId, card.feltStore, card.id])
    // A row whose parent stands in the same group sits indented beneath it.
    const depthIn = (card: KanbanCard, members: ReadonlySet<string>, memo: Map<string, number>): number => {
      const key = threadKey(card), known = memo.get(key)
      if (known !== undefined) return known
      // Walk up only to the nearest ancestor already measured, so a deep chain costs its length once.
      const chain: KanbanCard[] = []
      let p = index.parentOf(card), base = 0
      for (; p && p.id !== scope.id; p = index.parentOf(p)) {
        const seen = memo.get(threadKey(p))
        if (seen !== undefined) { base = seen + (members.has(threadKey(p)) ? 1 : 0); break }
        chain.push(p)
      }
      for (let i = chain.length - 1; i >= 0; i--) {
        memo.set(threadKey(chain[i]), base)
        if (members.has(threadKey(chain[i]))) base++
      }
      memo.set(key, base)
      return base
    }
    // A mark appears only where a group needs a sub-state: whose turn a waiting thread is, a live worker under a working one, or a discarded one among the archived.
    const markOf = (card: KanbanCard, state: ThreadState): { kind: string; title: string } | null => {
      if (state === 'waiting') { const turn = turnOf(card); return { kind: turn.turn, title: turn.word } }
      if (state === 'archived' && deskColumn(card) === 'composted') return { kind: 'discarded', title: 'Discarded' }
      return null
    }
    const rowFor = (card: KanbanCard, group: string, label: string, members: ReadonlySet<string>, memo: Map<string, number>): HTMLElement => {
      const item = threadItem(card, index, this.open, focusOf(group, card))
      const row = item.querySelector<HTMLElement>('.kbn-thread-row')!, state = index.state(card)
      const depth = depthIn(card, members, memo)
      if (depth) { item.dataset.depth = String(depth); item.style.setProperty('--ws-thread-depth', String(depth)) }
      const mark = markOf(card, state)
      let title = label
      if (mark && ['question', 'blocked', 'discarded'].includes(mark.kind)) {
        const el = document.createElement('span'); el.className = 'ws-thread-mark'; el.dataset.kind = mark.kind
        el.title = mark.title; el.setAttribute('aria-hidden', 'true')
        el.textContent = mark.kind === 'discarded' ? '×' : mark.kind === 'question' ? '?' : mark.kind === 'blocked' ? '!' : ''
        row.append(el); title = mark.title
      }
      const here = card.id === current.id && card.originId === current.originId
      row.classList.toggle('ws-thread-current', here)
      if (here) row.setAttribute('aria-current', 'page')
      const pin = item.querySelector<HTMLButtonElement>('.kbn-thread-pin')!
      pin.hidden = !here && pin.getAttribute('aria-pressed') !== 'true'
      pin.tabIndex = pin.hidden ? -1 : 0
      row.setAttribute('aria-label', `${card.name}, ${title.toLowerCase()}`)
      return item
    }
    const rootRow = rowFor(scope, 'root', 'Root constitution', new Set(), new Map())
    rootRow.classList.add('ws-thread-root')
    this.tree.replaceChildren(rootRow)
    const subtree = index.subtree(scope)
    // Arriving at a thread opens the groups holding it and its ancestry, once; the reader may fold them after.
    const visit = JSON.stringify([current.id, current.originId, scope.id])
    const arriving = visit !== this.revealed
    this.revealed = visit
    const lineage = new Set<string>([threadKey(current)])
    for (let p = index.parentOf(current); p; p = index.parentOf(p)) lineage.add(threadKey(p))
    let currentRow: HTMLElement | null = null
    for (const [key, label] of THREAD_GROUPS) {
      const members = subtree.filter(c => threadGroup(c) === key)
      if (!members.length) continue
      const group = document.createElement('details'); group.className = 'ws-thread-group'; group.dataset.threadDetails = key
      group.open = (arriving && members.some(c => lineage.has(threadKey(c)))) || (open.get(key) ?? key !== 'archived')
      const summary = document.createElement('summary'); summary.dataset.threadFocus = focusOf(`group:${key}`, scope)
      const name = document.createElement('span'); name.className = 'ws-thread-group-label'; name.textContent = label
      const count = document.createElement('span'); count.className = 'ws-thread-group-count'; count.textContent = String(members.length)
      summary.append(name, count); summary.setAttribute('aria-label', `${label}, ${members.length}`)
      const keys = new Set(members.map(threadKey)), memo = new Map<string, number>()
      group.append(summary, ...members.map(card => rowFor(card, key, label, keys, memo)))
      currentRow ??= group.querySelector<HTMLElement>('.ws-thread-current')
      this.tree.append(group)
    }
    this.layout()
    if (arriving && currentRow && typeof currentRow.scrollIntoView === 'function') currentRow.scrollIntoView({ block: 'nearest' })
    if (focus) {
      const target = [...this.tree.querySelectorAll<HTMLElement>('[data-thread-focus]')].find(el => el.dataset.threadFocus === focus)
      ;(target ?? this.heading).focus({ preventScroll: true })
    }
  }
}
