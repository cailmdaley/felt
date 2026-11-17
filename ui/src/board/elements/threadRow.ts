import { ago } from '../civilDay.js'
import { attentionOf, lastActive, quietWord, wantOf, type Waits } from '../attention.js'
import { officeOf } from '../channels.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { stateDot, stateMark } from '../stateDot.js'
import { TURN_WORD, turnOf } from '../turn.js'
import { slug } from '../threadOutline.js'
import { renderMarkdown } from '../utils.js'
import { runGlance, runWords } from '../workspace/runWords.js'
import './threadRow.css'

export interface OvThreadRowOptions {
  waits: Waits
  now: number
  /** Opens the thread's view, as a click on the row or its dot does. */
  open(card: KanbanCard): void
  /** Drawn under the row of a thread above it, because it waits on the human. */
  deep?: boolean
}

const el = (tag: string, className: string, text?: string): HTMLElement => {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Its run at a glance, light; the whole of it on hover. */
export function runTime(card: KanbanCard, now: number): HTMLElement {
  const glance = el('span', 'ov-time', runGlance(card, now))
  glance.title = runWords(card, now)
  return glance
}

/**
 * A thread as one row: its dot, slug and run, then what it wants when it
 * waits on the human, or its faint word when quiet, and the chevron that says
 * it opens. A `deep` thread, drawn below a row above it, waits and says so.
 */
export function ovThreadRow(card: KanbanCard, { waits, now, open, deep = false }: OvThreadRowOptions): HTMLElement {
  const row = el('div', deep ? 'ov-thread ov-deep' : 'ov-thread'), want = wantOf(card, waits), attention = attentionOf(card, waits)
  row.tabIndex = 0
  row.setAttribute('role', 'treeitem')
  row.dataset.fiber = card.uid ?? card.id
  row.title = card.name
  row.addEventListener('click', () => open(card))
  row.dataset.attention = attention
  const chevron = el('span', 'ov-open', '›')
  chevron.setAttribute('aria-hidden', 'true')
  const word = want ? el('span', 'ov-want') : el('span', 'ov-word', attention === 'quiet' ? quietWord(card) : '')
  if (want) { word.innerHTML = renderMarkdown(want.text); word.title = word.textContent?.replace(/\s+/g, ' ').trim() ?? '' }
  row.append(stateDot(card, waits, () => open(card)), el('span', 'ov-slug', deep ? `↳ ${slug(card)}` : slug(card)), runTime(card, now), word, chevron)
  return row
}

/** How much of a thread row shows: all of it on one line, or its dot, slug and role where its doing is shown beside it. */
export type ThreadDensity = 'line' | 'chip'

export interface ThreadRowOptions {
  waits: Waits
  now: number
  density?: ThreadDensity
  /** The last thing it said, and when ({@link Workspace.said}). */
  said?: { text: string; at: number }
  /** Opens its view, as a click on the row or its dot does; without it the row is drawn still, for a control that holds it to own the press. */
  open?(card: KanbanCard): void
  /** Its line's colour, one of six, where it has a line. */
  hue?: string
}

/** Markdown as one line of plain text. */
const plain = (markdown: string): string => {
  const box = document.createElement('div')
  box.innerHTML = renderMarkdown(markdown)
  return box.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

/**
 * What a thread is doing, in a line, and since when: what it wants of the
 * human, else what it last said, else its faint word or its turn's word
 * since it was last active.
 */
export function doing(card: KanbanCard, waits: Waits, said?: { text: string; at: number }): { text: string; at: number } {
  const want = wantOf(card, waits)
  if (want) return { text: plain(want.text), at: want.at > 1 ? want.at : lastActive(card) }
  if (said?.text.trim()) return { text: plain(said.text), at: said.at }
  return { text: (attentionOf(card, waits) === 'quiet' && quietWord(card)) || TURN_WORD[turnOf(card).turn], at: lastActive(card) }
}

/**
 * A constitution or thread as one row, the same wherever the board lists
 * one: its state dot, its slug (in its line's colour where it has one), its
 * office when that is not its slug, what it is doing and when it last spoke.
 * The chip density keeps the dot, slug and office.
 */
export function threadRow(card: KanbanCard, { waits, now, density = 'line', said, open, hue }: ThreadRowOptions): HTMLElement {
  const row = el('div', 'thread-row')
  row.dataset.density = density
  row.dataset.attention = attentionOf(card, waits)
  row.dataset.fiber = card.uid ?? card.id
  if (hue) row.dataset.hue = hue
  row.title = card.name
  const name = slug(card), office = officeOf(card.shuttleRole)
  row.append(open ? stateDot(card, waits, open) : stateMark(card, waits), el('span', 'thread-row-slug', name))
  if (office && office !== name) row.append(el('span', 'thread-row-role', office))
  if (density === 'line') {
    const { text, at } = doing(card, waits, said)
    const what = el('span', 'thread-row-doing', text)
    what.title = text
    const age = el('span', 'thread-row-age', at ? ago(at, now) : '')
    if (at) age.dataset.at = String(at)
    row.append(what, age)
  }
  if (open) row.addEventListener('click', () => open(card))
  return row
}
