import type { KanbanCard } from './KanbanTypes.js'
import { THREAD_LABEL, threadKey, type ThreadIndex } from './threads.js'
import { waitingThreadEntries } from './threadPreferences.js'
import './threads.css'

export function threadRow(card: KanbanCard, index: ThreadIndex, open: (card: KanbanCard) => void): HTMLButtonElement {
  const state = index.state(card)
  const row = document.createElement('button')
  row.type = 'button'; row.className = 'kbn-thread-row'; row.dataset.threadState = state
  // The Desk keyboard's identity: an expanded row is a stop in its column.
  row.dataset.cardUid = card.uid ?? card.id; row.dataset.cardOrigin = card.originId
  row.title = card.ask?.text ?? card.outcome ?? card.id
  const name = document.createElement('span'); name.className = 'kbn-thread-name'; name.textContent = card.name
  const label = document.createElement('small'); label.textContent = THREAD_LABEL[state]
  const outcome = document.createElement('span'); outcome.className = 'kbn-thread-outcome'
  outcome.textContent = card.ask?.text ?? card.outcome ?? ''
  row.append(name, label, outcome)
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

/** Rows a peek group draws before the rest fold into "+ N more", which opens the root and its rail. */
export const PEEK_ROWS = 5
function moreButton(count: number, focus: string, open: () => void): HTMLButtonElement {
  const more = document.createElement('button'); more.type = 'button'; more.className = 'kbn-thread-more'
  more.textContent = `+ ${count} more`; more.dataset.threadFocus = focus
  more.addEventListener('click', event => { event.stopPropagation(); open() })
  return more
}

/**
 * Which families are open, kept by the renderer across Desk repaints, which
 * rebuild every card. A family opens on its badge or from the keyboard and
 * stays open until folded.
 */
export class ThreadFamilies {
  private readonly open = new Set<string>()
  isOpen(card: KanbanCard): boolean { return this.open.has(threadKey(card)) }
  set(card: KanbanCard, open: boolean): void {
    if (open) this.open.add(threadKey(card))
    else this.open.delete(threadKey(card))
  }
}

export function installThreadPeek(host: HTMLElement, badgeHost: HTMLElement, card: KanbanCard, index: ThreadIndex, open: (card: KanbanCard) => void, families = new ThreadFamilies()): void {
  // Archived threads alone draw nothing here; the rail keeps them.
  if (!index.summary(card).unfinished) return
  const family = threadKey(card)
  const focusId = (...parts: string[]): string => JSON.stringify([family, ...parts])
  const descendants = index.subtree(card).sort(index.compare)
  host.classList.add('kbn-thread-family')
  const badge = document.createElement('button'); badge.type = 'button'; badge.className = 'kbn-thread-badge'
  const live = descendants.filter(c => index.state(c) !== 'archived')
  const waiting = live.filter(c => index.state(c) === 'waiting')
  const review = live.filter(c => index.state(c) === 'to-review')
  badge.textContent = `⑂ ${live.length}${review.length ? ` · ${review.length} to review` : ''}`
  badge.classList.toggle('kbn-thread-badge-waiting', waiting.length > 0)
  badge.title = `${live.length} unfinished threads · ${waiting.length} waiting · ${review.length} to review`
  badge.setAttribute('aria-label', badge.title)
  const peek = document.createElement('div'); peek.className = 'kbn-thread-peek'; peek.hidden = true
  // Sub-entries are the first waiting rows, drawn under the card at rest.
  // Expanded, they stay put and the list continues below them, so no thread
  // is drawn twice.
  const entryRows = waitingThreadEntries() ? waiting.slice(0, 2) : []
  let entriesMore: HTMLElement | undefined
  const paint = (expanded: boolean): void => {
    peek.hidden = !expanded; badge.setAttribute('aria-expanded', String(expanded))
    if (entriesMore) entriesMore.hidden = expanded
    families.set(card, expanded)
  }
  badge.dataset.threadFocus = focusId('badge')
  badge.addEventListener('click', event => { event.stopPropagation(); paint(peek.hidden) })
  host.addEventListener(THREAD_REVEAL, () => paint(true))
  host.addEventListener(THREAD_COLLAPSE, () => { paint(false); badge.focus({ preventScroll: true }) })
  peek.addEventListener('pointerdown', event => event.stopPropagation())
  // The peek's own padding is not the card: a click that misses a row opens nothing.
  peek.addEventListener('click', event => event.stopPropagation())
  peek.draggable = true
  peek.addEventListener('dragstart', event => { event.preventDefault(); event.stopPropagation() })
  for (const [label, members] of [
    ['Waiting', waiting.slice(entryRows.length)],
    ['To review', review],
    ['Working', live.filter(c => index.state(c) === 'working')],
    ['Drafts', live.filter(c => index.state(c) === 'drafts')],
    ['Roles', live.filter(c => index.state(c) === 'roles')],
    ['Resting', live.filter(c => index.state(c) === 'resting')],
  ] as const) {
    if (!members.length) continue
    // Waiting rows below the sub-entries continue their list, unheaded.
    if (label !== 'Waiting' || !entryRows.length) { const heading = document.createElement('h4'); heading.textContent = label; peek.append(heading) }
    peek.append(...members.slice(0, PEEK_ROWS).map(c => { const row = threadRow(c, index, open); row.dataset.threadFocus = focusId('peek', threadKey(c)); return row }))
    if (members.length > PEEK_ROWS) peek.append(moreButton(members.length - PEEK_ROWS, focusId('peek-more', label), () => open(card)))
  }
  const archived = descendants.length - live.length
  if (archived) { const note = document.createElement('small'); note.textContent = `${archived} archived`; peek.append(note) }
  badgeHost.append(badge); host.append(peek)
  if (entryRows.length) {
    const entries = document.createElement('div'); entries.className = 'kbn-thread-subentries'
    entries.append(...entryRows.map(c => { const row = threadRow(c, index, open); row.dataset.threadFocus = focusId('entry', threadKey(c)); return row }))
    if (waiting.length > entryRows.length) { entriesMore = moreButton(waiting.length - entryRows.length, focusId('more'), () => open(card)); entries.append(entriesMore) }
    host.insertBefore(entries, peek)
  }
  paint(families.isOpen(card))
}

/** The thread control holding focus inside `root`, by identity, to restore after a repaint. */
export function threadFocusIn(root: HTMLElement): string | undefined {
  const active = document.activeElement
  return active instanceof HTMLElement && root.contains(active) && active.matches('.kbn-thread-family [data-thread-focus]') ? active.dataset.threadFocus : undefined
}
export function restoreThreadFocus(root: HTMLElement, id: string | undefined): void {
  if (!id) return
  const target = [...root.querySelectorAll<HTMLElement>('[data-thread-focus]')].find(el => el.dataset.threadFocus === id && !el.closest('[hidden]'))
  target?.focus({ preventScroll: true })
}

const THREAD_REVEAL = 'thread-reveal'
const THREAD_COLLAPSE = 'thread-collapse'
const familyOf = (el: Element | null): HTMLElement | null => el?.closest<HTMLElement>('.kbn-thread-family') ?? null

/** Expand the family holding `row`, so a selection inside it can be drawn. */
export function revealThreadFamily(row: Element): void {
  if (row.closest('.kbn-thread-peek[hidden]')) familyOf(row)?.dispatchEvent(new Event(THREAD_REVEAL))
}

/** Expand the folded family whose own card is `row`; false when `row` heads no folded family. */
export function expandThreadFamily(row: Element | null): boolean {
  const family = familyOf(row)
  const peek = family?.querySelector<HTMLElement>(':scope > .kbn-thread-peek')
  if (!family || !peek?.hidden || threadFamilyCard(family) !== row) return false
  family.dispatchEvent(new Event(THREAD_REVEAL))
  return true
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
