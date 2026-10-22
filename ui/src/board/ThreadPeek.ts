import type { KanbanCard } from './KanbanTypes.js'
import { THREAD_LABEL, threadState, threadSubtree } from './threads.js'
import { waitingThreadEntries } from './threadPreferences.js'
import './threads.css'

export function threadRow(card: KanbanCard, open: (card: KanbanCard) => void): HTMLButtonElement {
  const row = document.createElement('button')
  row.type = 'button'; row.className = 'kbn-thread-row'; row.dataset.threadState = threadState(card)
  row.title = card.ask?.text ?? card.outcome ?? card.id
  const name = document.createElement('span'); name.className = 'kbn-thread-name'; name.textContent = card.name
  const state = document.createElement('small'); state.textContent = THREAD_LABEL[threadState(card)]
  const outcome = document.createElement('span'); outcome.className = 'kbn-thread-outcome'
  outcome.textContent = card.ask?.text ?? card.outcome ?? ''
  row.append(name, state, outcome)
  row.addEventListener('click', event => { event.stopPropagation(); open(card) })
  row.addEventListener('pointerdown', event => event.stopPropagation())
  return row
}

export function installThreadPeek(host: HTMLElement, badgeHost: HTMLElement, card: KanbanCard, cards: KanbanCard[], open: (card: KanbanCard) => void): void {
  const descendants = threadSubtree(card, cards)
  if (!descendants.length) return
  host.classList.add('kbn-thread-family')
  const badge = document.createElement('button'); badge.type = 'button'; badge.className = 'kbn-thread-badge'
  const live = descendants.filter(c => threadState(c) !== 'archived')
  const waiting = live.filter(c => threadState(c) === 'waiting-cail')
  const review = live.filter(c => threadState(c) === 'to-review')
  badge.textContent = `⑂ ${live.length}${review.length ? ` · ${review.length} to review` : ''}`
  badge.classList.toggle('kbn-thread-badge-waiting', waiting.length > 0)
  badge.title = `${live.length} unfinished threads · ${waiting.length} waiting · ${review.length} to review`
  badge.setAttribute('aria-label', badge.title)
  const peek = document.createElement('div'); peek.className = 'kbn-thread-peek'; peek.hidden = true
  const paint = (expanded: boolean): void => { peek.hidden = !expanded; badge.setAttribute('aria-expanded', String(expanded)) }
  badge.addEventListener('click', event => { event.stopPropagation(); paint(peek.hidden) })
  badge.addEventListener('thread-expand', () => paint(peek.hidden))
  host.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') paint(true) })
  host.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch' && !peek.contains(document.activeElement)) paint(false) })
  host.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); paint(false); badge.focus() } })
  peek.addEventListener('pointerdown', event => event.stopPropagation())
  peek.draggable = true
  peek.addEventListener('dragstart', event => { event.preventDefault(); event.stopPropagation() })
  for (const [label, members] of [
    ['Waiting', waiting],
    ['To review', review],
    ['Working', live.filter(c => threadState(c) === 'working')],
    ['Resting', live.filter(c => threadState(c) === 'resting')],
  ] as const) {
    if (!members.length) continue
    const heading = document.createElement('h4'); heading.textContent = label
    peek.append(heading, ...members.map(c => threadRow(c, open)))
  }
  const archived = descendants.length - live.length
  if (archived) { const note = document.createElement('small'); note.textContent = `${archived} archived`; peek.append(note) }
  paint(false)
  badgeHost.append(badge); host.append(peek)
  if (waitingThreadEntries() && waiting.length) {
    const entries = document.createElement('div'); entries.className = 'kbn-thread-subentries'
    entries.append(...waiting.slice(0, 2).map(c => threadRow(c, open)))
    if (waiting.length > 2) {
      const more = document.createElement('button'); more.type = 'button'; more.className = 'kbn-thread-more'
      more.textContent = `+ ${waiting.length - 2} more`
      more.addEventListener('click', event => { event.stopPropagation(); open(card) }); entries.append(more)
    }
    host.insertBefore(entries, peek)
  }
}
