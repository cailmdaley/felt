import { ago } from '../civilDay.js'
import { fiberOf, type Item } from '../channels.js'
import { slug } from '../threadOutline.js'
import { threadState } from '../threads.js'
import { renderMarkdown } from '../utils.js'
import './post.css'

export interface PostParts {
  now: number
  /** Its thread's state dot, which opens the thread's view. */
  dot: HTMLElement
  /** Opens the thread's view, as choosing the post does. */
  open(): void
  /** Its clear, at the head's end, when it has one. */
  clear?: HTMLElement
  /** Its files, below its words. */
  previews?: HTMLElement
}

/** What a post says before its words. */
export const kindWord = (item: Item): string =>
  item.kind === 'close' ? threadState(item.card) === 'to-review' ? 'for review' : 'closed' : { ask: 'asks', post: 'posted', file: 'sent', blocked: 'blocked' }[item.kind]

const el = (tag: string, className: string, text?: string): HTMLElement => {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * One thing a thread addressed to the human: its state dot, who, what kind
 * and when, its one line, and the files it carries. Choosing the post,
 * outside its buttons and previews, opens the thread's view.
 */
export function post(item: Item, { now, dot, open, clear, previews }: PostParts): HTMLLIElement {
  const { card } = item
  const row = document.createElement('li')
  row.className = 'kbn-ch-item'
  row.dataset.kind = item.kind
  row.dataset.slug = slug(card)
  if (item.line) row.dataset.line = item.line
  row.dataset.fiber = fiberOf(card)
  row.toggleAttribute('data-waiting', item.waiting)
  // On a line, the line says whose it is: the post names its kind, its slug shown only where the line is named on it.
  const lined = !!item.line
  const who = el('button', 'kbn-ch-who', lined ? '' : slug(card)) as HTMLButtonElement
  who.type = 'button'
  who.addEventListener('click', open)
  who.dataset.item = `item:${item.id}`
  who.title = `Open ${card.name}`
  who.toggleAttribute('data-lined', lined)
  if (lined) {
    who.setAttribute('aria-label', `${slug(card)} ${kindWord(item)}`)
    who.append(el('span', 'kbn-ch-who-slug', slug(card)), el('span', 'kbn-ch-kind', kindWord(item)))
  }
  const age = el('span', 'kbn-ch-age', ago(item.at, now))
  age.dataset.at = String(item.at)
  const head = el('div', 'kbn-ch-item-head')
  head.append(who, ...lined ? [] : [el('span', 'kbn-ch-kind', kindWord(item))], age)
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
