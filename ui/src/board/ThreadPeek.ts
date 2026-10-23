import type { KanbanCard } from './KanbanTypes.js'
import { THREAD_LABEL, threadKey, waitingWords, type ThreadIndex, type ThreadState } from './threads.js'
import { waitingThreadEntries } from './threadPreferences.js'
import { LastReplies, ThreadWhisper } from './threadReply.js'
import { untilOf } from './blockedOn.js'
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
  const waiting = waitingNote(card); if (waiting) name.after(waiting)
  row.classList.toggle('kbn-thread-pinned', isPinned(card))
  row.addEventListener('click', event => { event.stopPropagation(); open(card) })
  row.addEventListener('pointerdown', event => event.stopPropagation())
  return row
}

/** What waits for a constitution's next worker, muted beside its name; null when nothing does. */
export function waitingNote(card: Pick<KanbanCard, 'pendingResults'>): HTMLElement | null {
  const n = card.pendingResults ?? 0
  if (n <= 0) return null
  const el = document.createElement('span'); el.className = 'kbn-waiting'
  el.textContent = `${n} waiting`
  el.title = waitingWords(n)
  return el
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

/** The states an opened family draws by default: the live work. The others fold behind one quiet line each, in the order given. */
const FOLDED_STATES = ['drafts', 'roles', 'resting'] as const satisfies readonly ThreadState[]
type FoldedState = typeof FOLDED_STATES[number]
const FOLD_WORDS: Record<FoldedState, [string, string]> = { drafts: ['draft', 'drafts'], roles: ['role', 'roles'], resting: ['resting', 'resting'] }
const isFolded = (state: ThreadState): state is FoldedState => (FOLDED_STATES as readonly ThreadState[]).includes(state)
/** Lines an opened tree draws before it says "all N threads →": past this it scrolls inside its cap. */
export const TREE_LINES_IN_VIEW = 12
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

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
/** The badge in words: how many threads, then how many wait on a review, in the review's verdigris; reviews alone when they are all there is. */
export function badgeWords(threads: number, reviews: number): HTMLElement[] {
  const part = (text: string, kind: string): HTMLElement => { const el = document.createElement('span'); el.className = `kbn-thread-badge-${kind}`; el.textContent = text; return el }
  const count = part(plural(threads, 'thread'), 'count'), review = part(plural(reviews, 'review'), 'review')
  if (!reviews) return [count]
  if (reviews === threads) return [review]
  return [count, part(' · ', 'sep'), review]
}

/** How a branch ranks in an opened tree, by its most urgent thread: the rail's order. */
const BRANCH_RANK: Partial<Record<ThreadState, number>> = { waiting: 0, 'to-review': 1 }
const BRANCH_RANK_REST = 2

/** The word an opened tree's line carries at its end, for the states that are the reader's to act on. */
const STATE_TAGS: Partial<Record<ThreadState, string>> = { waiting: 'waiting', 'to-review': 'review' }

/** The last pointer press, so a click's focus does not raise the whisper a keyboard's focus does. */
let pressedAt = 0
/**
 * One thread as one line of the tree: its branches, its state mark and its
 * name. What it last said waits in the whisper, under the pointer or the
 * keyboard's focus; the pin sits at the line's end.
 */
export function treeLine(card: KanbanCard, index: ThreadIndex, open: (card: KanbanCard) => void, focus: string, cells: readonly TreeGuide[], whisper?: ThreadWhisper, tagged = false): HTMLElement {
  const state = index.state(card)
  const item = document.createElement('div'); item.className = 'kbn-thread-item kbn-tree-line'
  const row = document.createElement('button')
  row.type = 'button'; row.className = 'kbn-thread-row'; row.dataset.threadState = state; row.dataset.threadFocus = focus
  // The Desk keyboard's identity: a drawn line is a stop in its column.
  row.dataset.cardUid = card.uid ?? card.id; row.dataset.cardOrigin = card.originId
  row.setAttribute('aria-label', `${card.name}, ${THREAD_LABEL[state].toLowerCase()}`)
  const name = document.createElement('span'); name.className = 'kbn-thread-name'; name.textContent = card.name
  row.append(mark(markOf(card, state)), name)
  const waiting = waitingNote(card); if (waiting) row.append(waiting)
  // The two states that ask something of the reader say so in a word at the line's end; the rest keep their mark alone.
  const tag = tagged ? STATE_TAGS[state] : undefined
  if (tag) { const el = document.createElement('span'); el.className = 'kbn-tree-tag'; el.dataset.tag = state; el.textContent = tag; el.setAttribute('aria-hidden', 'true'); row.append(el) }
  row.classList.toggle('kbn-thread-pinned', isPinned(card))
  row.addEventListener('click', event => { event.stopPropagation(); whisper?.hide(); open(card) })
  row.addEventListener('pointerdown', event => { pressedAt = Date.now(); event.stopPropagation() })
  if (whisper) {
    const until = untilOf(card, index)
    row.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') whisper.show(row, card, state, 260, until) })
    row.addEventListener('pointerleave', () => whisper.hide(row))
    row.addEventListener('focus', () => { if (Date.now() - pressedAt > 600) whisper.show(row, card, state, 0, until) })
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
  private readonly unfolded = new Set<string>()
  readonly whisper: ThreadWhisper
  constructor(replies?: LastReplies) { this.whisper = new ThreadWhisper(replies) }
  isOpen(card: KanbanCard): boolean { return this.open.has(threadKey(card)) }
  set(card: KanbanCard, open: boolean): void {
    if (open) this.open.add(threadKey(card))
    else this.open.delete(threadKey(card))
  }
  /** Whether a family's quiet threads of `state` are unfolded into its tree. */
  isUnfolded(card: KanbanCard, state: ThreadState): boolean { return this.unfolded.has(JSON.stringify([threadKey(card), state])) }
  setUnfolded(card: KanbanCard, state: ThreadState, unfolded: boolean): void {
    const key = JSON.stringify([threadKey(card), state])
    if (unfolded) this.unfolded.add(key)
    else this.unfolded.delete(key)
  }
}

/**
 * The badge, and the family drawn as a tree under the card. At rest the
 * tree is pruned to its sub-entries (pinned threads, then the first waiting
 * ones), each a stub off the card. Opened, it draws the live work (waiting,
 * working, to review) with the ancestors that hold it, siblings ordered by
 * state, in a capped box that scrolls. Waiting and review lines carry their
 * state as a word at their end. Drafts and resting threads fold behind one
 * quiet line beneath the tree, each count unfolding in place, beside the way
 * to the whole family. Archived threads are not drawn: their live
 * descendants hang from the nearest live ancestor, and the line counts them.
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
  badge.append(...badgeWords(live.length, review.length))
  badge.classList.toggle('kbn-thread-badge-waiting', waiting.length > 0)
  badge.title = `${live.length} unfinished threads · ${waiting.length} waiting · ${review.length} to review`
  badge.setAttribute('aria-label', badge.title)
  const peek = document.createElement('div'); peek.className = 'kbn-thread-peek kbn-thread-tree'; peek.hidden = true
  peek.setAttribute('role', 'group'); peek.setAttribute('aria-label', `Threads of ${card.name}`)
  const body = document.createElement('div'); body.className = 'kbn-thread-tree-body'
  const foot = document.createElement('div'); foot.className = 'kbn-thread-tree-foot'
  peek.append(body, foot)

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
  const folded = new Map<FoldedState, number>()
  for (const c of live) { const state = index.state(c); if (isFolded(state)) folded.set(state, (folded.get(state) ?? 0) + 1) }
  // A thread is drawn when its state is live work or unfolded, or when it holds a thread that is drawn.
  const drawn = new Map<KanbanCard, boolean>()
  const isDrawn = (c: KanbanCard): boolean => {
    let shown = drawn.get(c)
    if (shown === undefined) {
      const state = index.state(c)
      shown = !isFolded(state) || families.isUnfolded(card, state)
      shown = liveChildren(c).map(isDrawn).some(Boolean) || shown
      drawn.set(c, shown)
    }
    return shown
  }
  // A branch ranks by the most urgent thread anywhere in it, so the tree reads in the rail's order: waiting, then to review, then the rest.
  const urgency = new Map<KanbanCard, number>()
  const branchUrgency = (c: KanbanCard): number => {
    let rank = urgency.get(c)
    if (rank === undefined) {
      rank = Math.min(BRANCH_RANK[index.state(c)] ?? BRANCH_RANK_REST, ...liveChildren(c).map(branchUrgency))
      urgency.set(c, rank)
    }
    return rank
  }
  let lineCount = 0
  const grow = (parent: KanbanCard, above: readonly TreeGuide[]): void => {
    // A stable sort: within a rank, siblings keep their tree order.
    const lines = liveChildren(parent).filter(isDrawn).sort((a, b) => branchUrgency(a) - branchUrgency(b))
    lines.forEach((line, n) => {
      const last = n === lines.length - 1
      body.append(treeLine(line, index, open, focusId('thread', threadKey(line)), [...above, last ? 'elbow' : 'tee'], whisper, true))
      lineCount++
      grow(line, [...above, last ? 'gap' : 'pipe'])
    })
  }
  const draw = (): void => {
    drawn.clear(); lineCount = 0; body.replaceChildren(); foot.replaceChildren()
    grow(card, [])
    // One line beneath the tree: what it folds away, each group a count that unfolds in place, then the way to the whole family.
    const archived = descendants.length - live.length
    const more: Array<HTMLElement | string> = []
    for (const [state, count] of folded) {
      const unfolded = families.isUnfolded(card, state)
      const fold = document.createElement('button'); fold.type = 'button'; fold.className = 'kbn-thread-more kbn-thread-fold'
      fold.dataset.threadFocus = focusId('fold', state)
      fold.setAttribute('aria-expanded', String(unfolded))
      fold.textContent = `${count} ${FOLD_WORDS[state][count === 1 ? 0 : 1]}`
      fold.title = `${unfolded ? 'Fold' : 'Show'} the ${FOLD_WORDS[state][1]} threads in the tree`
      fold.addEventListener('click', event => {
        event.stopPropagation()
        families.setUnfolded(card, state, !unfolded)
        whisper.hide(); draw()
        restoreThreadFocus(peek, fold.dataset.threadFocus)
      })
      more.push(fold)
    }
    if (archived) { const note = document.createElement('small'); note.className = 'kbn-tree-archived'; note.textContent = `${archived} archived`; more.push(note) }
    if (more.length) {
      const line = document.createElement('span'); line.className = 'kbn-thread-tree-more'
      line.append('More: ', ...more.flatMap((part, n) => n ? [' · ', part] : [part]))
      foot.append(line)
    }
    // The whole family lives in the constitution's own view; the Desk offers it once the tree no longer shows it at a glance.
    if (lineCount < live.length || lineCount > TREE_LINES_IN_VIEW) {
      const all = document.createElement('button'); all.type = 'button'; all.className = 'kbn-thread-more kbn-thread-all'
      all.dataset.threadFocus = focusId('all')
      all.textContent = 'Open family →'
      all.title = `Open ${card.name} with all ${live.length} threads`
      all.addEventListener('click', event => { event.stopPropagation(); whisper.hide(); open(card) })
      foot.append(all)
    }
    foot.hidden = !foot.childElementCount
  }
  draw()
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
