import { MOBILE_MEDIA } from '../mobile.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { threadItem } from '../ThreadPeek.js'
import { THREAD_LABEL, type ThreadIndex, type ThreadState } from '../threads.js'
import { turnOf } from '../turn.js'
import './thread-rail.css'

const WIDTH_STORAGE = 'shuttle:workspace:thread-rail-width'
const MIN_WIDTH = 220, MAX_WIDTH = 640, STEP = 16
/** Each state's mark: the sidebar's dot for a worker's turn, its ✓ for the human's move; the rest are quiet shapes. */
const MARK: Record<ThreadState, { text: string; dot?: boolean }> = {
  waiting: { text: '', dot: true }, working: { text: '', dot: true }, 'to-review': { text: '✓' },
  drafts: { text: '◌' }, roles: { text: '◇' }, resting: { text: '○' }, archived: { text: '–' },
}
const LEGEND_ORDER: readonly ThreadState[] = ['waiting', 'to-review', 'working', 'drafts', 'roles', 'resting']

/** A view of the selected constitution's own subtree; navigation never changes containment. */
export class ThreadRail {
  readonly el = document.createElement('aside')
  readonly breadcrumb = document.createElement('nav')
  private readonly scroller = document.createElement('div')
  readonly handle = document.createElement('div')
  readonly legend = document.createElement('div')
  private readonly tree = document.createElement('div')
  private readonly toggle = document.createElement('button')
  private readonly folded = new Set<string>()
  private readonly archivesOpen = new Set<string>()
  private signature = ''
  private width: number | null = null
  private card: KanbanCard | null = null
  private index: ThreadIndex | null = null
  private readonly open: (card: KanbanCard) => void
  private readonly layout: () => void
  constructor(open: (card: KanbanCard) => void, layout: () => void) {
    this.open = open; this.layout = layout
    this.el.className = 'ws-thread-rail'
    this.el.setAttribute('aria-label', 'Thread tree')
    this.breadcrumb.className = 'ws-thread-breadcrumb'; this.breadcrumb.setAttribute('aria-label', 'Thread breadcrumb')
    this.toggle.type = 'button'; this.toggle.className = 'ws-thread-toggle'; this.toggle.textContent = 'Threads'
    this.toggle.setAttribute('aria-expanded', 'true')
    this.el.classList.toggle('ws-thread-collapsed', this.toggle.getAttribute('aria-expanded') === 'false')
    this.toggle.addEventListener('click', () => {
      const collapsed = this.el.classList.toggle('ws-thread-collapsed')
      this.toggle.setAttribute('aria-expanded', String(!collapsed)); layout()
    })
    this.legend.className = 'ws-thread-legend'; this.legend.setAttribute('aria-label', 'Thread marks')
    this.tree.className = 'ws-thread-tree'
    this.scroller.className = 'ws-thread-scroll'; this.scroller.append(this.toggle, this.legend, this.tree)
    this.handle.className = 'ws-thread-handle'; this.handle.setAttribute('role', 'separator'); this.handle.setAttribute('aria-orientation', 'vertical')
    this.handle.setAttribute('aria-label', 'Resize thread tree'); this.handle.title = 'Drag to resize · double-click to reset'; this.handle.tabIndex = 0
    this.handle.addEventListener('pointerdown', e => this.resizeStart(e))
    this.handle.addEventListener('keydown', e => this.resizeKey(e))
    this.handle.addEventListener('dblclick', () => this.setWidth(null, true))
    this.el.append(this.handle, this.scroller)
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
    this.card = card; this.index = index
    const descendants = index.subtree(card)
    const ancestors: KanbanCard[] = []
    for (let parent = index.parentOf(card); parent; parent = index.parentOf(parent)) ancestors.unshift(parent)
    // The phone draws no tree under its chat, only the breadcrumb.
    if (window.matchMedia(MOBILE_MEDIA).matches) {
      this.el.hidden = true; this.tree.replaceChildren(); this.signature = ''
      this.paintBreadcrumb(ancestors)
      return
    }
    const signature = JSON.stringify([card.id, card.originId, ...ancestors.map(c => [c.id, c.name]), ...descendants.map(c => [c.id, c.orchestrator, c.name, c.status, c.tempered, c.runtimePhase, c.workerState, c.ask, c.outcome, c.originStale, c.launchError, c.effectiveHorizon, c.tags])])
    if (signature === this.signature) return
    this.signature = signature
    // A waiting thread opens the path down to it. Walks stop at an ancestor an
    // earlier walk already opened, so a deep chain of asks stays linear.
    const opened = new Set<KanbanCard>()
    for (const waiting of descendants) {
      if (index.state(waiting) !== 'waiting') continue
      for (let ancestor = index.parentOf(waiting); ancestor && !opened.has(ancestor); ancestor = index.parentOf(ancestor)) {
        opened.add(ancestor); this.folded.delete(JSON.stringify([ancestor.originId, ancestor.id]))
      }
    }
    this.el.hidden = !descendants.length
    this.paintBreadcrumb(ancestors)
    this.paint()
  }
  private paintLegend(present: readonly ThreadState[]): void {
    const states = LEGEND_ORDER.filter(state => present.includes(state))
    this.legend.hidden = !states.length
    this.legend.replaceChildren(...states.map(state => {
      const entry = document.createElement('span'); entry.className = 'ws-thread-legend-entry'
      const mark = document.createElement('span'); mark.className = 'ws-thread-mark'; mark.dataset.state = state
      mark.setAttribute('aria-hidden', 'true'); mark.textContent = MARK[state].text
      if (MARK[state].dot) mark.dataset.turn = state === 'waiting' ? 'question' : 'working'
      entry.append(mark, THREAD_LABEL[state].toLowerCase())
      return entry
    }))
  }
  private paintBreadcrumb(ancestors: readonly KanbanCard[]): void {
    this.breadcrumb.hidden = !ancestors.length
    this.breadcrumb.replaceChildren()
    for (const ancestor of ancestors) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = `‹ ${ancestor.name}`
      button.addEventListener('click', () => this.open(ancestor)); this.breadcrumb.append(button)
    }
  }
  private paint(): void {
    if (!this.card) return
    const active = document.activeElement
    const focus = active instanceof HTMLElement && this.tree.contains(active) ? active.dataset.threadFocus : undefined
    const detailsState = new Map([...this.tree.querySelectorAll<HTMLDetailsElement>('details[data-thread-details]')].map(el => [el.dataset.threadDetails!, el.open]))
    const focusOf = (kind: string, card: KanbanCard): string => JSON.stringify([kind, card.originId, card.feltStore, card.id])
    const identify = (el: HTMLElement, kind: string, card: KanbanCard): void => { el.dataset.threadFocus = focusOf(kind, card) }
    const index = this.index!
    // The state is a mark, not a word: the word stays in the mark's title and the row's label.
    const rowFor = (card: KanbanCard, scope: string, path = ''): HTMLElement => {
      const item = threadItem(card, index, this.open, focusOf(scope, card))
      const row = item.querySelector<HTMLElement>('.kbn-thread-row')!, state = index.state(card)
      row.querySelector('small')?.remove()
      const mark = document.createElement('span'); mark.className = 'ws-thread-mark'; mark.dataset.state = state
      mark.title = THREAD_LABEL[state]; mark.setAttribute('aria-hidden', 'true'); mark.textContent = MARK[state].text
      if (MARK[state].dot) mark.dataset.turn = turnOf(card).turn
      const head = document.createElement('span'); head.className = 'ws-thread-head'
      if (path) {
        const prefix = document.createElement('span'); prefix.className = 'ws-thread-path'; prefix.textContent = path; prefix.title = path
        head.append(prefix)
      }
      head.append(row.querySelector('.kbn-thread-name')!)
      row.prepend(mark, head)
      row.setAttribute('aria-label', `${card.name}, ${THREAD_LABEL[state].toLowerCase()}`)
      return item
    }
    const subtree = index.subtree(this.card)
    const nodes = (parent: KanbanCard, archiveMode = false): HTMLElement => {
      const list = document.createElement('ul')
      const archived: KanbanCard[] = []
      for (const child of index.children(parent)) {
        const below = index.summary(child)
        if (!archiveMode && index.state(child) === 'archived' && below.unfinished === 0) { archived.push(child); continue }
        const item = document.createElement('li')
        const line = document.createElement('div'); line.className = 'ws-thread-line'
        const expandable = index.size(child) > 0
        const key = JSON.stringify([child.originId, child.id])
        if (expandable) {
          const fold = document.createElement('button'); fold.type = 'button'; fold.textContent = this.folded.has(key) ? '▸' : '▾'
          identify(fold, 'fold', child)
          fold.setAttribute('aria-label', `Toggle threads of ${child.name}`); fold.setAttribute('aria-expanded', String(!this.folded.has(key)))
          fold.addEventListener('click', () => { if (this.folded.has(key)) this.folded.delete(key); else this.folded.add(key); this.paint() })
          line.append(fold)
        } else {
          const spacer = document.createElement('span'); spacer.className = 'ws-thread-fold-gap'; spacer.setAttribute('aria-hidden', 'true'); line.append(spacer)
        }
        line.append(rowFor(child, 'tree')); item.append(line)
        if (expandable && !this.folded.has(key)) item.append(nodes(child, archiveMode))
        list.append(item)
      }
      if (archived.length) {
        const item = document.createElement('li'), archive = document.createElement('details')
        const key = JSON.stringify([parent.originId, parent.feltStore, parent.id])
        archive.dataset.threadDetails = `archive:${key}`
        archive.open = this.archivesOpen.has(key)
        const summary = document.createElement('summary'); identify(summary, 'archive', parent)
        summary.textContent = `${archived.reduce((n, c) => n + 1 + index.size(c), 0)} archived`
        archive.append(summary)
        for (const child of archived) archive.append(rowFor(child, 'tree'), nodes(child, true))
        archive.addEventListener('toggle', () => { if (archive.isConnected) { if (archive.open) this.archivesOpen.add(key); else this.archivesOpen.delete(key) } })
        item.append(archive); list.append(item)
      }
      return list
    }
    this.tree.replaceChildren()
    const waiting = subtree.filter(c => index.state(c) === 'waiting')
    if (waiting.length) {
      const strip = document.createElement('section'); strip.className = 'ws-thread-waiting'
      const heading = document.createElement('h3'); identify(heading, 'waiting', this.card); heading.textContent = `Waiting · ${waiting.length}`
      strip.append(heading)
      for (const card of waiting) strip.append(rowFor(card, 'waiting', card.id.slice(this.card.id.length + 1).split('/').slice(0, -1).join('/')))
      this.tree.append(strip)
    }
    this.paintLegend(subtree.map(c => index.state(c)))
    this.tree.append(nodes(this.card))
    for (const details of this.tree.querySelectorAll<HTMLDetailsElement>('details[data-thread-details]')) {
      const open = detailsState.get(details.dataset.threadDetails!)
      if (open !== undefined) details.open = open
    }
    this.layout()
    if (focus) {
      const target = [...this.tree.querySelectorAll<HTMLElement>('[data-thread-focus]')].find(el => el.dataset.threadFocus === focus)
      ;(target ?? this.toggle).focus({ preventScroll: true })
    }
  }
}
