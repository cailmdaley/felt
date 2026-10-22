import { MOBILE_MEDIA } from '../mobile.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { threadRow } from '../ThreadPeek.js'
import { orchestratorOf, threadChildren, threadState, threadSubtree } from '../threads.js'
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
  private cards: KanbanCard[] = []
  private readonly open: (card: KanbanCard) => void
  private readonly layout: () => void
  constructor(open: (card: KanbanCard) => void, layout: () => void) {
    this.open = open; this.layout = layout
    this.el.className = 'ws-thread-rail'
    this.el.setAttribute('aria-label', 'Thread tree')
    this.breadcrumb.className = 'ws-thread-breadcrumb'; this.breadcrumb.setAttribute('aria-label', 'Thread breadcrumb')
    this.toggle.type = 'button'; this.toggle.className = 'ws-thread-toggle'; this.toggle.textContent = 'Threads'
    this.toggle.setAttribute('aria-expanded', String(!window.matchMedia(MOBILE_MEDIA).matches))
    this.el.classList.toggle('ws-thread-collapsed', this.toggle.getAttribute('aria-expanded') === 'false')
    this.toggle.addEventListener('click', () => {
      const collapsed = this.el.classList.toggle('ws-thread-collapsed')
      this.toggle.setAttribute('aria-expanded', String(!collapsed)); layout()
    })
    this.tree.className = 'ws-thread-tree'; this.el.append(this.toggle, this.tree)
  }
  show(card: KanbanCard, cards: KanbanCard[]): void {
    this.card = card; this.cards = cards
    const descendants = threadSubtree(card, cards)
    const ancestors: KanbanCard[] = []
    const seen = new Set<KanbanCard>([card])
    let parent = orchestratorOf(card, cards)
    while (parent && !seen.has(parent)) { seen.add(parent); ancestors.unshift(parent); parent = orchestratorOf(parent, cards) }
    const signature = JSON.stringify([card.id, card.originId, ...ancestors.map(c => [c.id, c.name]), ...descendants.map(c => [c.id, c.orchestrator, c.name, c.status, c.tempered, c.runtimePhase, c.workerState, c.ask, c.outcome, c.originStale, c.launchError])])
    if (signature === this.signature) return
    this.signature = signature
    for (const waiting of descendants.filter(c => threadState(c) === 'waiting-cail')) {
      let ancestor = orchestratorOf(waiting, cards)
      const expanded = new Set<KanbanCard>()
      while (ancestor && !expanded.has(ancestor)) {
        expanded.add(ancestor); this.folded.delete(JSON.stringify([ancestor.originId, ancestor.id])); ancestor = orchestratorOf(ancestor, cards)
      }
    }
    this.el.hidden = !descendants.length
    this.breadcrumb.hidden = !ancestors.length
    this.breadcrumb.replaceChildren()
    for (const ancestor of ancestors) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = `‹ ${ancestor.name}`
      button.addEventListener('click', () => this.open(ancestor)); this.breadcrumb.append(button)
    }
    this.paint()
  }
  private paint(): void {
    if (!this.card) return
    const cards = this.cards, subtree = threadSubtree(this.card, cards)
    const nodes = (parent: KanbanCard, seen: Set<KanbanCard>, archiveMode = false): HTMLElement => {
      const list = document.createElement('ul')
      const archived: KanbanCard[] = []
      for (const child of threadChildren(parent, cards).sort((a, b) => cards.indexOf(a) - cards.indexOf(b))) {
        if (seen.has(child)) continue
        const below = threadSubtree(child, cards)
        if (!archiveMode && threadState(child) === 'archived' && below.every(c => threadState(c) === 'archived')) { archived.push(child); continue }
        const item = document.createElement('li')
        const line = document.createElement('div'); line.className = 'ws-thread-line'
        const expandable = below.length > 0
        const key = JSON.stringify([child.originId, child.id])
        if (expandable) {
          const fold = document.createElement('button'); fold.type = 'button'; fold.textContent = this.folded.has(key) ? '▸' : '▾'
          fold.setAttribute('aria-label', `Toggle threads of ${child.name}`); fold.setAttribute('aria-expanded', String(!this.folded.has(key)))
          fold.addEventListener('click', () => { if (this.folded.has(key)) this.folded.delete(key); else this.folded.add(key); this.paint() })
          line.append(fold)
        }
        line.append(threadRow(child, this.open)); item.append(line)
        if (expandable && !this.folded.has(key)) item.append(nodes(child, new Set([...seen, child]), archiveMode))
        list.append(item)
      }
      if (archived.length) {
        const item = document.createElement('li'), archive = document.createElement('details')
        const key = JSON.stringify([parent.originId, parent.feltStore, parent.id])
        archive.open = this.archivesOpen.has(key)
        const summary = document.createElement('summary')
        summary.textContent = `${archived.reduce((n, c) => n + 1 + threadSubtree(c, cards).length, 0)} archived`
        archive.append(summary)
        for (const child of archived) archive.append(threadRow(child, this.open), nodes(child, new Set([...seen, child]), true))
        archive.addEventListener('toggle', () => { if (archive.open) this.archivesOpen.add(key); else this.archivesOpen.delete(key) })
        item.append(archive); list.append(item)
      }
      return list
    }
    this.tree.replaceChildren()
    for (const [label, state] of [['Waiting', 'waiting-cail'], ['To review', 'to-review']] as const) {
      const members = subtree.filter(c => threadState(c) === state)
      if (!members.length) continue
      const group = document.createElement(state === 'to-review' ? 'details' : 'section'); group.className = 'ws-thread-pointers'
      const heading = document.createElement(state === 'to-review' ? 'summary' : 'h3')
      heading.textContent = `${label} · ${members.length}`; group.append(heading)
      for (const card of members) {
        const row = threadRow(card, this.open)
        const prefix = document.createElement('span'); prefix.className = 'ws-thread-path'
        prefix.textContent = `${card.id.slice(this.card.id.length + 1).split('/').slice(0, -1).join('/')} / `
        if (prefix.textContent !== ' / ') row.prepend(prefix)
        group.append(row)
      }
      this.tree.append(group)
    }
    this.tree.append(nodes(this.card, new Set([this.card])))
    this.layout()
  }
}
