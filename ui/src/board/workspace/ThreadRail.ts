import { MOBILE_MEDIA } from '../mobile.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { threadRow } from '../ThreadPeek.js'
import type { ThreadIndex } from '../threads.js'
import './thread-rail.css'

/** A view of the selected constitution's own subtree; navigation never changes containment. */
export class ThreadRail {
  readonly el = document.createElement('aside')
  readonly breadcrumb = document.createElement('nav')
  private readonly tree = document.createElement('div')
  private readonly toggle = document.createElement('button')
  private readonly folded = new Set<string>()
  private readonly archivesOpen = new Set<string>()
  private signature = ''
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
    this.tree.className = 'ws-thread-tree'; this.el.append(this.toggle, this.tree)
  }
  show(card: KanbanCard, index: ThreadIndex): void {
    card = index.card(card)
    this.card = card; this.index = index
    const descendants = index.subtree(card)
    const ancestors: KanbanCard[] = []
    for (let parent = index.parentOf(card); parent; parent = index.parentOf(parent)) ancestors.unshift(parent)
    // The phone draws no tree under its chat; its threads get a page of their own.
    if (window.matchMedia(MOBILE_MEDIA).matches) {
      this.el.hidden = true; this.tree.replaceChildren(); this.signature = ''
      this.paintBreadcrumb(ancestors)
      return
    }
    const signature = JSON.stringify([card.id, card.originId, ...ancestors.map(c => [c.id, c.name]), ...descendants.map(c => [c.id, c.orchestrator, c.name, c.status, c.tempered, c.runtimePhase, c.workerState, c.ask, c.outcome, c.originStale, c.launchError, c.effectiveHorizon])])
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
    const identify = (el: HTMLElement, kind: string, card: KanbanCard): void => {
      el.dataset.threadFocus = JSON.stringify([kind, card.originId, card.feltStore, card.id])
    }
    const index = this.index!
    const rowFor = (card: KanbanCard, scope: string): HTMLButtonElement => {
      const row = threadRow(card, index, this.open); identify(row, scope, card); return row
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
    for (const [label, state] of [['Waiting', 'waiting'], ['To review', 'to-review'], ['Drafts', 'drafts']] as const) {
      const members = subtree.filter(c => index.state(c) === state)
      if (!members.length) continue
      const group = document.createElement(state !== 'waiting' ? 'details' : 'section'); group.className = 'ws-thread-pointers'
      if (group instanceof HTMLDetailsElement) group.dataset.threadDetails = `group:${state}`
      const heading = document.createElement(state !== 'waiting' ? 'summary' : 'h3')
      identify(heading, `group:${state}`, this.card)
      heading.textContent = `${label} · ${members.length}`; group.append(heading)
      for (const card of members) {
        const row = rowFor(card, `group:${state}`)
        const prefix = document.createElement('span'); prefix.className = 'ws-thread-path'
        prefix.textContent = `${card.id.slice(this.card.id.length + 1).split('/').slice(0, -1).join('/')} / `
        if (prefix.textContent !== ' / ') row.prepend(prefix)
        group.append(row)
      }
      this.tree.append(group)
    }
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
