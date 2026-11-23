import type { ShuttleClient } from '../client.js'
import { kindWord, roleOf, slugOf } from '../model.js'
import type { ShuttlePostItem } from '../types.js'
import { button, flag, part } from './dom.js'
import { createFilePreview } from './filePreview.js'
import { createTime } from './time.js'

export interface PostOptions {
  now: number
  /** It follows a line of the same thread closely (`groupPosts`): a skin may drop its head. */
  grouped?: boolean
  /** Opens the thread; given it, the author is a button. */
  onOpen?(item: ShuttlePostItem): void
  /** Clears the line; given it, the head ends in a `clear` button. */
  onClear?(item: ShuttlePostItem): void
  /** Draws the line's words; plain text by default. Return a node for rendered Markdown. */
  renderText?(text: string): Node | string
  /** Draws the files the line carries, as `createFilePreview` rows. */
  client?: ShuttleClient
}

/**
 * One line a thread addressed to the human, `<article data-slot="shuttle-post">`:
 * a `head` with its `author` (the thread's slug), `role`, `kind` (only for a
 * question, a close or a block), `age` and optional `clear`; its `body`; and
 * its `files`. The root carries `data-kind`, `data-fiber`, and the flags
 * `data-waiting` and `data-grouped`.
 */
export function createPost(item: ShuttlePostItem, { now, grouped = false, onOpen, onClear, renderText, client }: PostOptions): HTMLElement {
  const slug = slugOf(item.fiber), office = roleOf(item.fiber), kind = kindWord(item)
  const post = part('article', 'shuttle-post')
  post.dataset.kind = item.kind
  post.dataset.fiber = item.fiber.fiber.uid ?? item.fiber.fiber.id
  flag(post, 'waiting', !!item.waiting)
  flag(post, 'grouped', grouped)
  post.setAttribute('aria-label', [slug, kind].filter(Boolean).join(' '))
  const head = part('header', 'head')
  head.append(onOpen ? button('author', slug, () => onOpen(item)) : part('span', 'author', slug))
  if (office && office !== slug) head.append(part('span', 'role', office))
  if (kind) head.append(part('span', 'kind', kind))
  const age = part('span', 'age')
  age.append(createTime(item.at, now))
  head.append(age)
  if (onClear) {
    const clear = button('clear', '✓', () => onClear(item))
    clear.setAttribute('aria-label', `Clear ${slug}’s line`)
    head.append(clear)
  }
  const body = part('div', 'body')
  if (item.text) body.append(renderText ? renderText(item.text) : item.text)
  post.append(head, body)
  if (item.files?.length && client) {
    const files = part('div', 'files')
    for (const file of item.files) files.append(createFilePreview(file, client, { origin: item.fiber.origin, now }))
    post.append(files)
  }
  return post
}
