import type { KanbanCard } from './KanbanTypes.js'
import { threadKey, type ThreadIndex, type ThreadState } from './threads.js'
import { threadRow } from './ThreadPeek.js'
import { turnOf } from './turn.js'
import { rowLabel, sectionOutline, type OutlineRow } from './threadOutline.js'
import { workerPlateFacts } from './workspace/workerPlate.js'
import './deskFrontier.css'

const FOLDS_KEY = 'shuttle.desk.folds'
/** The browser's folds by thread, true for shut; this page's own where the browser keeps none. */
let folds: Record<string, boolean> = {}
/** A node's fold in one section: a family's root heads several. */
const foldKey = (card: KanbanCard, state: ThreadState): string => `${threadKey(card)}\u0000${state}`
function shut(card: KanbanCard, state: ThreadState): boolean | undefined {
  try { folds = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '{}') as Record<string, boolean> } catch { /* this page's folds stand */ }
  return folds[foldKey(card, state)]
}
function setShut(card: KanbanCard, state: ThreadState, value: boolean): void {
  shut(card, state)
  folds[foldKey(card, state)] = value
  try { localStorage.setItem(FOLDS_KEY, JSON.stringify(folds)) } catch { /* the fold lasts this page only */ }
}

/** Sections that need the human stand open; the rest stay folded until a hand opens them. */
const OPEN: ReadonlySet<ThreadState> = new Set(['waiting', 'to-review'])
const COUNT_WORD: Partial<Record<ThreadState, [string, string]>> = { waiting: ['needs you', 'need you'], 'to-review': ['to review', 'to review'], working: ['working', 'working'] }

/**
 * A Desk row and the threads it holds in its section, shared by desktop and
 * phone, named by its slug with its name in the tooltip. A row is a family's root, in its own state's section and heading
 * each section of work its threads stand in (`frontier`, `headers`). Beneath
 * it hang the family's threads in that section, each under its nearest shown
 * ancestor and named by its slug path from there (`sectionOutline`).
 * The count's caret folds them all, and every thread with threads of its own
 * folds on its own caret, each remembered per browser.
 */
export function installFrontierDetails(host: HTMLElement, end: HTMLElement, card: KanbanCard, index: ThreadIndex, open: (card: KanbanCard) => void, now = Date.now()): void {
  const self = index.card(card), state = card.deskSection ?? index.state(self)
  // A root heading a section its own state is not in keeps its own mark, faintly.
  host.classList.toggle('kbn-card-header', !!card.deskSection)
  if (card.deskSection) host.dataset.deskSection = card.deskSection
  const title = host.querySelector<HTMLElement>('.kbn-card-name, .kbn-cluster-item-title')
  if (title) { title.textContent = rowLabel(index, self); title.title = card.name }
  const outline = sectionOutline(index, self, state)
  const { elapsed } = workerPlateFacts(card, now)
  const age = (): void => {
    if (!elapsed) return
    const el = document.createElement('span'); el.className = 'kbn-row-elapsed'; el.textContent = elapsed
    end.prepend(el)
  }
  if (!outline.length) { age(); return }
  const count = document.createElement('button'); count.type = 'button'; count.className = 'kbn-thread-count'
  const label = document.createElement('span'), words = COUNT_WORD[state] ?? ['thread', 'threads']
  label.className = OPEN.has(state) ? 'kbn-count-needs' : state === 'working' ? 'kbn-count-working' : 'kbn-count-quiet'
  label.textContent = `${outline.length} ${words[outline.length === 1 ? 0 : 1]}`
  if (outline.some(row => turnOf(row.card).turn === 'question')) label.dataset.asks = ''
  const caret = document.createElement('span'); caret.className = 'kbn-thread-caret'; caret.setAttribute('aria-hidden', 'true')
  count.append(label, caret)
  count.title = `${label.textContent} beneath this row`
  end.prepend(count)
  age()

  const list = document.createElement('div'); list.className = 'kbn-desk-threads'
  list.setAttribute('role', 'group'); list.setAttribute('aria-label', `Threads of ${card.name}`)
  // The threads are their own nodes: nothing on them reaches the row's click, drag, selection or long press.
  for (const type of ['click', 'pointerdown', 'mousedown', 'touchstart'] as const) list.addEventListener(type, event => event.stopPropagation())
  list.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation() })
  list.addEventListener('dragstart', event => { event.preventDefault(); event.stopPropagation() })
  const isOpen = (node: KanbanCard): boolean => { const value = shut(node, state); return value === undefined ? OPEN.has(state) : !value }
  const parents = new Set(outline.map(row => threadKey(row.parent)))
  const draw = (): void => {
    const active = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement.dataset.threadFocus : undefined
    const opened = isOpen(self)
    count.setAttribute('aria-expanded', String(opened))
    count.setAttribute('aria-label', `${count.title}; ${opened ? 'fold' : 'unfold'} them`)
    const visible = new Set<string>(opened ? [threadKey(self)] : [])
    const rows: HTMLElement[] = []
    for (const row of outline) {
      if (!visible.has(threadKey(row.parent))) continue
      const fold = parents.has(threadKey(row.card)) ? isOpen(row.card) : null
      if (fold) visible.add(threadKey(row.card))
      rows.push(threadLine(row, fold, state, index, open, now, draw))
    }
    list.replaceChildren(...rows)
    list.hidden = !rows.length
    if (active) [...list.querySelectorAll<HTMLElement>('[data-thread-focus]')].find(el => el.dataset.threadFocus === active)?.focus({ preventScroll: true })
  }
  count.addEventListener('click', event => { event.stopPropagation(); setShut(self, state, isOpen(self)); draw() })
  draw()
  host.append(list)
}

/** One thread in a row's outline: its caret when it holds threads, its dot, its slug path and its age. */
function threadLine({ card, depth, path }: OutlineRow, fold: boolean | null, state: ThreadState, index: ThreadIndex, open: (card: KanbanCard) => void, now: number, redraw: () => void): HTMLElement {
  const row = threadRow(card, index, open), key = threadKey(card)
  row.querySelector('.kbn-thread-name')!.textContent = path
  row.dataset.fiberId = card.id
  row.title = card.name
  row.style.setProperty('--ws-thread-depth', String(depth)); row.dataset.depth = String(depth)
  row.dataset.threadFocus = JSON.stringify(['row', key])
  row.setAttribute('aria-level', String(depth + 1))
  row.setAttribute('aria-label', `${card.name}, ${turnOf(card).word}`)
  const caret = document.createElement(fold === null ? 'span' : 'button'); caret.className = 'kbn-thread-fold'
  if (fold !== null) {
    const button = caret as HTMLButtonElement
    button.type = 'button'
    button.dataset.threadFocus = JSON.stringify(['fold', key])
    button.setAttribute('aria-expanded', String(fold))
    button.setAttribute('aria-label', `${fold ? 'Fold' : 'Unfold'} the threads of ${card.name}`)
    button.addEventListener('click', event => { event.stopPropagation(); setShut(card, state, fold); redraw() })
    button.addEventListener('pointerdown', event => event.stopPropagation())
  }
  row.prepend(caret)
  const { elapsed } = workerPlateFacts(card, now)
  if (elapsed) { const age = document.createElement('span'); age.className = 'kbn-row-elapsed'; age.textContent = elapsed; row.append(age) }
  return row
}
