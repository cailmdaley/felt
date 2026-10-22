import type { KanbanCard } from './KanbanTypes.js'
import { THREAD_LABEL, threadState, threadSubtree } from './threads.js'
import { waitingThreadEntries } from './threadPreferences.js'
import './threads.css'

export function threadRow(card: KanbanCard, open: (card: KanbanCard) => void): HTMLButtonElement {
  const row = document.createElement('button')
  row.type = 'button'; row.className = 'kbn-thread-row'; row.dataset.threadState = threadState(card)
  // The Desk keyboard's identity: an expanded row is a stop in its column.
  row.dataset.cardUid = card.uid ?? card.id; row.dataset.cardOrigin = card.originId
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

/** Why a card the Desk would not otherwise draw is here: a settled root kept for its threads, or a thread whose orchestrator is gone. */
export function threadMark(card: KanbanCard): HTMLElement | null {
  if (!card.threadPromoted && !card.threadOrphaned) return null
  const mark = document.createElement('span')
  mark.className = 'kbn-thread-mark'
  if (card.threadOrphaned) {
    mark.textContent = 'orphaned thread'
    mark.title = `Its orchestrator, ${card.orchestrator}, is not on the board.`
  } else {
    mark.textContent = 'threads open'
    mark.title = 'This constitution is settled or resting; it is here because its threads still hold work.'
  }
  return mark
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
  let entries: HTMLElement | undefined
  // Expanded, the peek holds every waiting row, so the sub-entries step aside
  // rather than give the keyboard two stops for one thread.
  const paint = (expanded: boolean): void => {
    peek.hidden = !expanded; badge.setAttribute('aria-expanded', String(expanded))
    if (entries) entries.hidden = expanded
  }
  badge.addEventListener('click', event => { event.stopPropagation(); paint(peek.hidden) })
  badge.addEventListener('thread-expand', () => paint(peek.hidden))
  host.addEventListener(THREAD_REVEAL, () => paint(true))
  host.addEventListener(THREAD_COLLAPSE, () => { paint(false); badge.focus({ preventScroll: true }) })
  host.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') paint(true) })
  host.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch' && !peek.contains(document.activeElement)) paint(false) })
  peek.addEventListener('pointerdown', event => event.stopPropagation())
  peek.draggable = true
  peek.addEventListener('dragstart', event => { event.preventDefault(); event.stopPropagation() })
  for (const [label, members] of [
    ['Waiting', waiting],
    ['To review', review],
    ['Working', live.filter(c => threadState(c) === 'working')],
    ['Drafts', live.filter(c => threadState(c) === 'drafts')],
    ['Resting', live.filter(c => threadState(c) === 'resting')],
  ] as const) {
    if (!members.length) continue
    const heading = document.createElement('h4'); heading.textContent = label
    peek.append(heading, ...members.map(c => threadRow(c, open)))
  }
  const archived = descendants.length - live.length
  if (archived) { const note = document.createElement('small'); note.textContent = `${archived} archived`; peek.append(note) }
  badgeHost.append(badge); host.append(peek)
  if (waitingThreadEntries() && waiting.length) {
    entries = document.createElement('div'); entries.className = 'kbn-thread-subentries'
    entries.append(...waiting.slice(0, 2).map(c => threadRow(c, open)))
    if (waiting.length > 2) {
      const more = document.createElement('button'); more.type = 'button'; more.className = 'kbn-thread-more'
      more.textContent = `+ ${waiting.length - 2} more`
      more.addEventListener('click', event => { event.stopPropagation(); open(card) }); entries.append(more)
    }
    host.insertBefore(entries, peek)
  }
  paint(false)
}

const THREAD_REVEAL = 'thread-reveal'
const THREAD_COLLAPSE = 'thread-collapse'
const familyOf = (el: Element | null): HTMLElement | null => el?.closest<HTMLElement>('.kbn-thread-family') ?? null

/** Expand the family holding `row`, so a selection inside it can be drawn. */
export function revealThreadFamily(row: Element): void {
  if (row.closest('.kbn-thread-peek[hidden]')) familyOf(row)?.dispatchEvent(new Event(THREAD_REVEAL))
}

/** Collapse the expanded family around `from`, focusing its badge; the family host, or null when none was open. */
export function collapseThreadFamily(from: Element | null): HTMLElement | null {
  const family = familyOf(from)
  const peek = family?.querySelector<HTMLElement>(':scope > .kbn-thread-peek')
  if (!family || !peek || peek.hidden) return null
  family.dispatchEvent(new Event(THREAD_COLLAPSE))
  return family
}

/** The family's own card: the host itself, or a seat's chip. */
export function threadFamilyCard(family: HTMLElement): HTMLElement | null {
  return family.matches('[data-card-uid]') ? family : family.querySelector<HTMLElement>(':scope > [data-card-uid]')
}

/** Tab order within a family (card, badge, the rows drawn now); null at either end, where the Desk's column order resumes. */
export function threadFamilyTab(active: HTMLElement, backwards: boolean): HTMLElement | null {
  const family = familyOf(active)
  if (!family) return null
  const own = threadFamilyCard(family)
  const controls = [...family.querySelectorAll<HTMLElement>('.kbn-thread-badge, .kbn-thread-row, .kbn-thread-more')]
    .filter(el => !el.closest('[hidden]') && familyOf(el) === family)
  const stops = own ? [own, ...controls] : controls
  const at = stops.findIndex(stop => stop === active || (stop !== own && stop.contains(active)))
  const index = at >= 0 ? at : own?.contains(active) ? 0 : -1
  if (index < 0) return null
  const next = stops[index + (backwards ? -1 : 1)]
  if (next && !next.hasAttribute('tabindex') && next.tabIndex < 0) next.tabIndex = -1
  return next ?? null
}
