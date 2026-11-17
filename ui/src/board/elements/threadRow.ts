import { attentionOf, lastActive, quietWord, wantOf, type Waits } from '../attention.js'
import { officeOf } from '../channels.js'
import { instantMs } from '../civilDay.js'
import { hasLiveWorker, type KanbanCard } from '../KanbanTypes.js'
import { stateDot, stateMark } from '../stateDot.js'
import { TURN_WORD, turnOf } from '../turn.js'
import { slug } from '../threadOutline.js'
import { renderMarkdown } from '../utils.js'
import { timeEl } from './time.js'
import './threadRow.css'

const el = (tag: string, className: string, text?: string): HTMLElement => {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
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
 * What a thread is doing, in a line, and when that was said: what it wants
 * of the human; else what it last said, when its live worker said it since
 * its launch; else the newer of the last thing it said and its outcome
 * (timed by its file's last write, which a lifecycle write moves); else its
 * faint word when quiet, or its turn's word, timed from its launch while it
 * works and from when it last moved otherwise.
 */
export function doing(card: KanbanCard, waits: Waits, said?: { text: string; at: number }): { text: string; at: number } {
  const want = wantOf(card, waits)
  if (want) return { text: plain(want.text), at: want.at > 1 ? want.at : lastActive(card) }
  const spoken = said?.text.trim() ? said : undefined
  const since = hasLiveWorker(card) ? instantMs(card.dispatchedAt) : undefined
  if (spoken && since !== undefined && spoken.at >= since) return { text: plain(spoken.text), at: spoken.at }
  const outcome = card.outcome?.trim() ? { text: card.outcome, at: instantMs(card.modifiedAt) ?? lastActive(card) } : undefined
  const latest = [spoken, outcome].filter(each => each !== undefined).sort((a, b) => b.at - a.at)[0]
  if (latest) return { text: plain(latest.text), at: latest.at }
  return { text: (attentionOf(card, waits) === 'quiet' && quietWord(card)) || TURN_WORD[turnOf(card).turn], at: since ?? lastActive(card) }
}

/**
 * A constitution or thread as one row, the same wherever the board lists
 * one: its state dot, its slug (in its line's colour where it has one), its
 * office when that is not its slug, what it is doing and when that was said;
 * the doing's whole text is its tooltip.
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
    row.title = `${card.name} — ${text}`
    row.append(el('span', 'thread-row-doing', text), timeEl(at, now, 'thread-row-age'))
  }
  if (open) row.addEventListener('click', () => open(card))
  return row
}
