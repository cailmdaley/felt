import { MOBILE_MEDIA } from '../mobile.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { threadItem } from '../ThreadPeek.js'
import { deskColumn } from '../deskColumn.js'
import { type ThreadIndex, type ThreadState } from '../threads.js'
import { turnOf } from '../turn.js'
import './thread-rail.css'

const WIDTH_STORAGE = 'shuttle:workspace:thread-rail-width'
const MIN_WIDTH = 220, MAX_WIDTH = 640, STEP = 16
/** The groups, in the order they are drawn; roles rest with Resting and discarded threads sit with the Tempered. */
const GROUPS: readonly { key: string; label: string; states: readonly ThreadState[] }[] = [
  { key: 'waiting', label: 'Waiting', states: ['waiting'] },
  { key: 'working', label: 'Working', states: ['working'] },
  { key: 'to-review', label: 'To review', states: ['to-review'] },
  { key: 'drafts', label: 'Drafts', states: ['drafts'] },
  { key: 'resting', label: 'Resting', states: ['resting', 'roles'] },
  { key: 'tempered', label: 'Tempered', states: ['archived'] },
]

/** A view of the selected constitution's own subtree; navigation never changes containment. */
export class ThreadRail {
  readonly el = document.createElement('aside')
  readonly breadcrumb = document.createElement('nav')
  private readonly scroller = document.createElement('div')
  readonly handle = document.createElement('div')
  private readonly tree = document.createElement('div')
  private readonly toggle = document.createElement('button')
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
    this.tree.className = 'ws-thread-tree'
    this.scroller.className = 'ws-thread-scroll'; this.scroller.append(this.toggle, this.tree)
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
    this.el.hidden = !descendants.length
    this.paintBreadcrumb(ancestors)
    this.paint()
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
    const open = new Map([...this.tree.querySelectorAll<HTMLDetailsElement>('details[data-thread-details]')].map(el => [el.dataset.threadDetails!, el.open]))
    const index = this.index!
    const focusOf = (kind: string, card: KanbanCard): string => JSON.stringify([kind, card.originId, card.feltStore, card.id])
    // Containment reads from the muted slugs of the two nearest ancestors below the open constitution, a cut chain led by an ellipsis.
    const slug = (c: KanbanCard): string => c.id.split('/').pop()!
    const pathOf = (card: KanbanCard): string => {
      const root = this.card!, parent = index.parentOf(card)
      if (!parent || parent.id === root.id) return ''
      const grand = index.parentOf(parent)
      if (!grand || grand.id === root.id) return slug(parent)
      const above = index.parentOf(grand)
      return `${above && above.id !== root.id ? '…/' : ''}${slug(grand)}/${slug(parent)}`
    }
    // A mark appears only where a group needs a sub-state: whose turn a waiting thread is, or a discarded one among the tempered.
    const markOf = (card: KanbanCard, state: ThreadState): { kind: string; title: string } | null => {
      if (state === 'waiting') { const turn = turnOf(card); return { kind: turn.turn, title: turn.word } }
      if (state === 'archived' && deskColumn(card) === 'composted') return { kind: 'discarded', title: 'Discarded' }
      return null
    }
    const rowFor = (card: KanbanCard, group: string, label: string): HTMLElement => {
      const item = threadItem(card, index, this.open, focusOf(group, card))
      const row = item.querySelector<HTMLElement>('.kbn-thread-row')!, state = index.state(card)
      row.querySelector('small')?.remove()
      const head = document.createElement('span'); head.className = 'ws-thread-head'
      const path = pathOf(card)
      if (path) {
        const prefix = document.createElement('span'); prefix.className = 'ws-thread-path'; prefix.textContent = path; prefix.title = path
        head.append(prefix)
      }
      head.append(row.querySelector('.kbn-thread-name')!)
      row.prepend(head)
      const mark = markOf(card, state)
      let title = label
      if (mark) {
        const el = document.createElement('span'); el.className = 'ws-thread-mark'; el.dataset.kind = mark.kind
        el.title = mark.title; el.setAttribute('aria-hidden', 'true'); el.textContent = mark.kind === 'discarded' ? '×' : ''
        row.prepend(el); title = mark.title
      }
      row.classList.toggle('ws-thread-marked', mark !== null)
      row.setAttribute('aria-label', `${card.name}, ${title.toLowerCase()}`)
      return item
    }
    this.tree.replaceChildren()
    const subtree = index.subtree(this.card)
    for (const { key, label, states } of GROUPS) {
      const members = subtree.filter(c => states.includes(index.state(c)))
      if (!members.length) continue
      const group = document.createElement('details'); group.className = 'ws-thread-group'; group.dataset.threadDetails = key
      group.open = open.get(key) ?? key !== 'tempered'
      const summary = document.createElement('summary'); summary.dataset.threadFocus = focusOf(`group:${key}`, this.card)
      summary.textContent = `${label} · ${members.length}`
      group.append(summary, ...members.map(card => rowFor(card, key, label)))
      this.tree.append(group)
    }
    this.layout()
    if (focus) {
      const target = [...this.tree.querySelectorAll<HTMLElement>('[data-thread-focus]')].find(el => el.dataset.threadFocus === focus)
      ;(target ?? this.toggle).focus({ preventScroll: true })
    }
  }
}
