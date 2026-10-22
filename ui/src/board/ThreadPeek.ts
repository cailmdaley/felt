import type { KanbanCard } from './KanbanTypes.js'
import { THREAD_LABEL, threadKey, type ThreadIndex, type ThreadState } from './threads.js'
import { waitingThreadEntries } from './threadPreferences.js'
import { LastReplies, ThreadWhisper } from './threadReply.js'
import { turnOf } from './turn.js'
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
  row.classList.toggle('kbn-thread-pinned', isPinned(card))
  row.addEventListener('click', event => { event.stopPropagation(); open(card) })
  row.addEventListener('pointerdown', event => event.stopPropagation())
  return row
}

/** The tag that keeps a thread drawn under its root card on the Desk, on every device. */
export const PINNED_TAG = 'pinned'
export const isPinned = (card: Pick<KanbanCard, 'tags'>): boolean => card.tags?.includes(PINNED_TAG) ?? false
/** Asks the board to pin (`pinned: true`) or unpin a thread; bubbles from the control that asked. */
export const THREAD_PIN = 'shuttle-thread-pin'
export interface ThreadPinRequest { card: KanbanCard; pinned: boolean }
export function requestThreadPin(from: EventTarget, card: KanbanCard): void {
  from.dispatchEvent(new CustomEvent<ThreadPinRequest>(THREAD_PIN, { bubbles: true, composed: true, detail: { card, pinned: !isPinned(card) } }))
}

const PIN_PATH = 'M9.5 1.5 14.5 6.5 12.6 7.1 10.4 9.3 10.6 12.6 9.4 13.8 6.6 11 3.2 14.4 1.6 14.4 1.6 12.8 5 9.4 2.2 6.6 3.4 5.4 6.7 5.6 8.9 3.4Z'
/** A thread row with its pin control beside it: the row opens the thread, the pin toggles its `pinned` tag. */
export function threadItem(card: KanbanCard, index: ThreadIndex, open: (card: KanbanCard) => void, focus: string): HTMLElement {
  const item = document.createElement('div'); item.className = 'kbn-thread-item'
  const row = threadRow(card, index, open); row.dataset.threadFocus = focus
  const pinned = isPinned(card)
  const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'kbn-thread-pin'
  pin.dataset.threadFocus = JSON.stringify([focus, 'pin'])
  pin.setAttribute('aria-pressed', String(pinned))
  pin.title = pinned ? `Unpin ${card.name}` : `Pin ${card.name} under its card`
  pin.setAttribute('aria-label', pin.title)
  pin.tabIndex = -1
  pin.innerHTML = `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="${PIN_PATH}"/></svg>`
  pin.addEventListener('click', event => { event.stopPropagation(); requestThreadPin(pin, card) })
  pin.addEventListener('pointerdown', event => event.stopPropagation())
  item.append(row, pin)
  return item
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

/** Lines one state draws among a set of siblings before the rest fold into "+ N more", which opens the root and its rail. */
export const PEEK_ROWS = 5
/** Waiting threads drawn as sub-entries before the rest fold into "+ N more"; pinned threads are never folded. */
export const ENTRY_WAITING_ROWS = 2

/**
 * One cell of a line's drawn branches, as `tree` draws them: an ancestor's
 * line running on (`pipe`) or ended (`gap`), then the line's own joint, a
 * sibling still to come (`tee`) or the last (`elbow`).
 */
export type TreeGuide = 'pipe' | 'gap' | 'tee' | 'elbow'
function guides(cells: readonly TreeGuide[]): HTMLElement {
  const el = document.createElement('span'); el.className = 'kbn-tree-guides'; el.setAttribute('aria-hidden', 'true')
  for (const cell of cells) { const g = document.createElement('i'); g.dataset.g = cell; el.append(g) }
  return el
}
/** A thread's state as a mark, in the sidebar's vocabulary: whose turn by colour, and a ring for a thread that is done or not begun. */
function markOf(card: KanbanCard, state: ThreadState): string {
  return state === 'waiting' ? (turnOf(card).turn === 'question' ? 'question' : 'idle') : state
}
function mark(kind: string): HTMLElement {
  const el = document.createElement('span'); el.className = 'kbn-tree-mark'; el.dataset.mark = kind; el.setAttribute('aria-hidden', 'true')
  return el
}

/** The last pointer press, so a click's focus does not raise the whisper a keyboard's focus does. */
let pressedAt = 0
/**
 * One thread as one line of the tree: its branches, its state mark and its
 * name. What it last said waits in the whisper, under the pointer or the
 * keyboard's focus; the pin sits at the line's end.
 */
export function treeLine(card: KanbanCard, index: ThreadIndex, open: (card: KanbanCard) => void, focus: string, cells: readonly TreeGuide[], whisper?: ThreadWhisper): HTMLElement {
  const state = index.state(card)
  const item = document.createElement('div'); item.className = 'kbn-thread-item kbn-tree-line'
  const row = document.createElement('button')
  row.type = 'button'; row.className = 'kbn-thread-row'; row.dataset.threadState = state; row.dataset.threadFocus = focus
  // The Desk keyboard's identity: a drawn line is a stop in its column.
  row.dataset.cardUid = card.uid ?? card.id; row.dataset.cardOrigin = card.originId
  row.setAttribute('aria-label', `${card.name}, ${THREAD_LABEL[state].toLowerCase()}`)
  const name = document.createElement('span'); name.className = 'kbn-thread-name'; name.textContent = card.name
  row.append(mark(markOf(card, state)), name)
  row.classList.toggle('kbn-thread-pinned', isPinned(card))
  row.addEventListener('click', event => { event.stopPropagation(); whisper?.hide(); open(card) })
  row.addEventListener('pointerdown', event => { pressedAt = Date.now(); event.stopPropagation() })
  if (whisper) {
    row.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') whisper.show(row, card, state, 260) })
    row.addEventListener('pointerleave', () => whisper.hide(row))
    row.addEventListener('focus', () => { if (Date.now() - pressedAt > 600) whisper.show(row, card, state, 0) })
    row.addEventListener('blur', () => whisper.hide(row))
  }
  const pinned = isPinned(card)
  const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'kbn-thread-pin'
  pin.dataset.threadFocus = JSON.stringify([focus, 'pin'])
  pin.setAttribute('aria-pressed', String(pinned))
  pin.title = pinned ? `Unpin ${card.name}` : `Pin ${card.name} under its card`
  pin.setAttribute('aria-label', pin.title)
  pin.tabIndex = -1
  pin.innerHTML = `<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="${PIN_PATH}"/></svg>`
  pin.addEventListener('click', event => { event.stopPropagation(); requestThreadPin(pin, card) })
  pin.addEventListener('pointerdown', event => event.stopPropagation())
  item.append(guides(cells), row, pin)
  return item
}

/** The line that stands for the threads a cap folds away; it opens the root, whose rail lists them all. */
function moreLine(count: number, focus: string, cells: readonly TreeGuide[], kind: string | null, title: string, open: () => void): HTMLElement {
  const item = document.createElement('div'); item.className = 'kbn-tree-line kbn-tree-more-line'
  const more = document.createElement('button'); more.type = 'button'; more.className = 'kbn-thread-more'
  more.dataset.threadFocus = focus; more.title = title
  if (kind) more.append(mark(kind))
  more.append(`+ ${count} more`)
  more.addEventListener('click', event => { event.stopPropagation(); open() })
  item.append(guides(cells), more)
  return item
}

/**
 * Which families are open, kept by the renderer across Desk repaints, which
 * rebuild every card, and the one whisper their lines share. A family opens
 * on its badge or from the keyboard and stays open until folded.
 */
export class ThreadFamilies {
  private readonly open = new Set<string>()
  readonly whisper: ThreadWhisper
  constructor(replies?: LastReplies) { this.whisper = new ThreadWhisper(replies) }
  isOpen(card: KanbanCard): boolean { return this.open.has(threadKey(card)) }
  set(card: KanbanCard, open: boolean): void {
    if (open) this.open.add(threadKey(card))
    else this.open.delete(threadKey(card))
  }
}

/**
 * The badge, and the family drawn as a tree under the card. At rest the
 * tree is pruned to its sub-entries (pinned threads, then the first waiting
 * ones), each a stub off the card; opened, it is the whole subtree, one line
 * a thread, siblings ordered by state. Archived threads are not drawn: their
 * live descendants hang from the nearest live ancestor, and a count closes
 * the tree.
 */
export function installThreadPeek(host: HTMLElement, badgeHost: HTMLElement, card: KanbanCard, index: ThreadIndex, open: (card: KanbanCard) => void, families = new ThreadFamilies()): void {
  // Archived threads alone draw nothing here; the rail keeps them.
  if (!index.summary(card).unfinished) return
  const family = threadKey(card)
  const focusId = (...parts: string[]): string => JSON.stringify([family, ...parts])
  const whisper = families.whisper
  const descendants = index.subtree(card)
  const isLive = (c: KanbanCard): boolean => index.state(c) !== 'archived'
  const live = descendants.filter(isLive).sort(index.compare)
  host.classList.add('kbn-thread-family')
  const badge = document.createElement('button'); badge.type = 'button'; badge.className = 'kbn-thread-badge'
  const waiting = live.filter(c => index.state(c) === 'waiting')
  const review = live.filter(c => index.state(c) === 'to-review')
  badge.textContent = `⑂ ${live.length}${!review.length ? '' : review.length === live.length ? ' to review' : ` · ${review.length} to review`}`
  badge.classList.toggle('kbn-thread-badge-waiting', waiting.length > 0)
  badge.title = `${live.length} unfinished threads · ${waiting.length} waiting · ${review.length} to review`
  badge.setAttribute('aria-label', badge.title)
  const peek = document.createElement('div'); peek.className = 'kbn-thread-peek kbn-thread-tree'; peek.hidden = true
  peek.setAttribute('role', 'group'); peek.setAttribute('aria-label', `Threads of ${card.name}`)

  let entries: HTMLElement | undefined
  const paint = (expanded: boolean): void => {
    peek.hidden = !expanded; badge.setAttribute('aria-expanded', String(expanded))
    if (entries) entries.hidden = expanded
    if (!expanded) whisper.hide()
    families.set(card, expanded)
  }
  badge.dataset.threadFocus = focusId('badge')
  badge.addEventListener('click', event => { event.stopPropagation(); paint(peek.hidden) })
  host.addEventListener(THREAD_REVEAL, () => paint(true))
  host.addEventListener(THREAD_COLLAPSE, () => { paint(false); badge.focus({ preventScroll: true }) })
  for (const tree of [peek]) {
    tree.addEventListener('pointerdown', event => event.stopPropagation())
    // The tree's own margin is not the card: a click that misses a line opens nothing.
    tree.addEventListener('click', event => event.stopPropagation())
    tree.draggable = true
    tree.addEventListener('dragstart', event => { event.preventDefault(); event.stopPropagation() })
  }

  // The live threads under `parent`, an archived thread's own drawn in its place.
  const liveChildren = (parent: KanbanCard): KanbanCard[] =>
    index.children(parent).flatMap(child => isLive(child) ? [child] : liveChildren(child)).sort(index.compare)
  const grow = (parent: KanbanCard, above: readonly TreeGuide[]): void => {
    // Each state's run of siblings draws PEEK_ROWS lines; a fold stands for two or more, never for one line it could have drawn.
    const runs = new Map<ThreadState, KanbanCard[]>()
    for (const child of liveChildren(parent)) runs.set(index.state(child), [...runs.get(index.state(child)) ?? [], child])
    const lines: Array<KanbanCard | { count: number; state: ThreadState }> = []
    for (const [state, run] of runs) {
      if (run.length <= PEEK_ROWS + 1) lines.push(...run)
      else lines.push(...run.slice(0, PEEK_ROWS), { count: run.length - PEEK_ROWS, state })
    }
    lines.forEach((line, n) => {
      const last = n === lines.length - 1
      const cells = [...above, last ? 'elbow' : 'tee'] as const
      if ('count' in line) {
        peek.append(moreLine(line.count, focusId('peek-more', threadKey(parent), line.state), cells, line.state,
          `${line.count} more ${THREAD_LABEL[line.state].toLowerCase()} — open ${card.name} for every thread`, () => open(card)))
        return
      }
      peek.append(treeLine(line, index, open, focusId('thread', threadKey(line)), cells, whisper))
      grow(line, [...above, last ? 'gap' : 'pipe'])
    })
  }
  grow(card, [])
  const archived = descendants.length - live.length
  if (archived) { const note = document.createElement('small'); note.className = 'kbn-tree-archived'; note.textContent = `${archived} archived`; peek.append(note) }
  badgeHost.append(badge); host.append(peek)

  // Sub-entries: the tree pruned to what must stay in sight, each a stub off the card.
  const pinned = live.filter(isPinned)
  const waitingUnpinned = waiting.filter(c => !isPinned(c))
  // A fold stands for two or more; one more waiting thread is drawn rather than folded.
  const waitingEntries = waitingThreadEntries() ? waitingUnpinned.slice(0, waitingUnpinned.length === ENTRY_WAITING_ROWS + 1 ? ENTRY_WAITING_ROWS + 1 : ENTRY_WAITING_ROWS) : []
  const entryRows = [...pinned, ...waitingEntries]
  if (entryRows.length) {
    entries = document.createElement('div'); entries.className = 'kbn-thread-subentries kbn-thread-tree'
    const unshown = waitingEntries.length ? waitingUnpinned.length - waitingEntries.length : 0
    entryRows.forEach((c, n) => entries!.append(treeLine(c, index, open, focusId('thread', threadKey(c)), [n === entryRows.length - 1 && !unshown ? 'elbow' : 'tee'], whisper)))
    if (unshown > 0) entries.append(moreLine(unshown, focusId('more'), ['elbow'], 'question', `${unshown} more waiting — open ${card.name} for every thread`, () => open(card)))
    entries.addEventListener('pointerdown', event => event.stopPropagation())
    entries.addEventListener('click', event => event.stopPropagation())
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
