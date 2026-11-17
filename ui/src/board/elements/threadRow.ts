import { attentionOf, quietWord, wantOf, type Waits } from '../attention.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { stateDot } from '../stateDot.js'
import { slug } from '../threadOutline.js'
import { renderMarkdown } from '../utils.js'
import { runGlance, runWords } from '../workspace/runWords.js'
import './threadRow.css'

export interface ThreadRowOptions {
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
export function threadRow(card: KanbanCard, { waits, now, open, deep = false }: ThreadRowOptions): HTMLElement {
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
