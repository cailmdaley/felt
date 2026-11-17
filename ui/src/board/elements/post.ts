import { fiberOf, officeOf, type Item } from '../channels.js'
import { slug } from '../threadOutline.js'
import { threadState } from '../threads.js'
import { renderMarkdown } from '../utils.js'
import { timeEl } from './time.js'
import './post.css'

export interface PostParts {
  now: number
  /** Its thread's state dot, which opens the thread's view. */
  dot: HTMLElement
  /** Opens the thread's view, as choosing the post does. */
  open(): void
  /** It follows a line of the same thread within {@link GROUP_MS}: it drops its head, its age shown on hover. */
  grouped?: boolean
  /** Its clear, at the head's end, when it has one. */
  clear?: HTMLElement
  /** Its files, below its words. */
  previews?: HTMLElement
}

/** Lines of one thread closer together than this group under one head. */
export const GROUP_MS = 5 * 60_000

/** What a line asks of the human, when it asks anything: a question, a close (for review, or closed) or a block. A post or a send says nothing the stream does not. */
export const kindWord = (item: Item): string =>
  item.kind === 'close' ? threadState(item.card) === 'to-review' ? 'for review' : 'closed' : { ask: 'asks', post: '', file: '', blocked: 'blocked' }[item.kind]

/** Whether `item` follows `before` in its group: the same thread less than {@link GROUP_MS} later, asking nothing a head would have to say. */
export const groups = (before: Item | undefined, item: Item): boolean =>
  !!before && fiberOf(before.card) === fiberOf(item.card) && item.at - before.at < GROUP_MS && !kindWord(item)

const el = (tag: string, className: string, text?: string): HTMLElement => {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * One line a thread addressed to the human: its state dot; a head with the
 * thread's slug (in its line's colour), its office when that is not its slug,
 * what it asks of the human when it asks anything, and its age; its words as
 * Markdown; and the files it carries. A line grouped under the one before it
 * drops its head, its age shown on hover. Choosing the post, outside its
 * buttons and previews, opens the thread's view.
 */
export function post(item: Item, { now, dot, open, grouped = false, clear, previews }: PostParts): HTMLLIElement {
  const { card } = item, kind = kindWord(item), name = slug(card), office = officeOf(card.shuttleRole)
  const row = document.createElement('li')
  row.className = 'kbn-ch-item'
  row.dataset.kind = item.kind
  row.dataset.slug = name
  if (item.line) row.dataset.line = item.line
  row.dataset.fiber = fiberOf(card)
  row.toggleAttribute('data-waiting', item.waiting)
  row.toggleAttribute('data-grouped', grouped)
  const who = el('button', 'kbn-ch-who', name) as HTMLButtonElement
  who.type = 'button'
  who.addEventListener('click', open)
  who.dataset.item = `item:${item.id}`
  who.title = `Open ${card.name}`
  const age = timeEl(item.at, now, 'kbn-ch-age')
  const head = el('div', 'kbn-ch-item-head')
  who.setAttribute('aria-label', [name, kind].filter(Boolean).join(' '))
  head.append(who, ...office && office !== name ? [el('span', 'kbn-ch-role', office)] : [], ...kind ? [el('span', 'kbn-ch-kind', kind)] : [], age)
  if (clear) head.append(clear)
  const body = el('div', 'kbn-ch-item-body')
  body.append(head)
  if (item.text) {
    const text = el('div', 'kbn-ch-item-text')
    text.innerHTML = renderMarkdown(item.text)
    body.append(text)
  }
  if (previews) body.append(previews)
  row.append(dot, body)
  // The whole post opens the view, save its buttons, its previews and a selection.
  row.addEventListener('click', event => {
    if ((event.target as Element).closest('button, a, .uf') || getSelection()?.toString()) return
    open()
  })
  return row
}
