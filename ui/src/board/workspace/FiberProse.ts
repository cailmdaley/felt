import type { KanbanCard } from '../KanbanTypes.js'
import { extractEmbeds } from '../attachments.js'
import { basename, renderMarkdown } from '../utils.js'
import { installWikilinks } from '../wikilinks.js'
import type { Channel, DocKey } from './documents.js'

/** The outcome as the reading surface's lede, including math and references. */
export function ledeHtml(outcome: string): string {
  return outcome.trim()
    ? `<div class="kbn-detail-lede">${renderMarkdown(outcome, { wikilinks: true })}</div>`
    : ''
}

/** Fiber prose and its declarations share one markdown interpretation. */
export function renderFiberMarkdown(body: string, outcome: string, card: KanbanCard) {
  const extracted = extractEmbeds(body)
  return {
    attachments: extracted.attachments,
    html: ledeHtml(outcome) + renderMarkdown(extracted.body, {
      basePath: card.fiberDir,
      originId: card.originId,
      projectDir: card.shuttleProjectDir,
      wikilinks: true,
    }),
  }
}

/** Prefer the fiber directory; use the project directory only after a failed HEAD. */
export async function settleBodyFileLink(link: HTMLAnchorElement): Promise<void> {
  const altUrl = link.dataset.fileUrlAlt
  const altPath = link.dataset.filePathAlt
  const primary = link.getAttribute('href')
  if (!altUrl || !altPath || !primary) return
  try {
    if ((await fetch(primary, { method: 'HEAD' })).ok) return
  } catch {
    return
  }
  link.href = altUrl
  link.dataset.filePath = altPath
  link.title = `Open ${basename(altPath)} in the viewer`
}

/** Plain clicks open the local reader; modified clicks retain browser navigation. */
export function installBodyFileLinks(
  prose: HTMLElement,
  onFile: (path: string, title?: string) => void,
): void {
  for (const link of prose.querySelectorAll<HTMLAnchorElement>('a[data-file-path]')) {
    const path = link.dataset.filePath
    if (!path) continue
    link.title = `Open ${basename(path)} in the viewer`
    link.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      onFile(link.dataset.filePath ?? path, link.textContent?.trim() || undefined)
    })
    void settleBodyFileLink(link)
  }
}

export function buildFiberProse(
  card: KanbanCard,
  channel: Channel,
  opts: {
    shuttleBase: string
    onSelect: (key: DocKey) => void
    onFiber: (id: string) => void
    onFile: (path: string, title?: string) => void
  },
): HTMLElement {
  const scroller = document.createElement('div')
  scroller.className = 'ws-prose-scroll'
  const article = document.createElement('article')
  article.className = 'ws-prose ws-fiber-prose kbn-detail-prose'
  const header = document.createElement('header')
  header.className = 'ws-prose-header'
  for (const [name, value] of [
    ['status', card.status],
    ['agent', card.shuttleAgent],
    ['host', channel.owner],
  ]) {
    if (!value) continue
    const span = document.createElement('span')
    span.className = `ws-prose-${name}`
    span.textContent = value
    header.append(span)
  }
  const title = document.createElement('h1')
  title.textContent = channel.name
  const body = document.createElement('div')
  body.className = 'ws-prose-body'
  body.innerHTML = renderFiberMarkdown(channel.body, channel.outcome ?? card.outcome ?? '', {
    ...card, originId: channel.owner,
  }).html
  // The shared markdown renderer emits same-origin byte routes. A workspace
  // served separately from the daemon still uses the configured daemon base.
  if (opts.shuttleBase) {
    for (const el of body.querySelectorAll<HTMLElement>('a[href],img[src]')) {
      const attr = el.tagName === 'IMG' ? 'src' : 'href'
      const url = el.getAttribute(attr)
      if (url?.startsWith('/api/v1/file?')) el.setAttribute(attr, opts.shuttleBase + url)
      if (el.dataset.fileUrlAlt?.startsWith('/api/v1/file?')) {
        el.dataset.fileUrlAlt = opts.shuttleBase + el.dataset.fileUrlAlt
      }
    }
  }
  installBodyFileLinks(body, opts.onFile)
  void installWikilinks(body, { shuttleBase: opts.shuttleBase, onOpen: opts.onFiber })
  article.append(header, title, body)

  const files = channel.documents.map((doc, index) => ({ doc, index })).filter(({ doc }) => doc.kind !== 'fiber')
  if (files.length) {
    const heading = document.createElement('h2')
    heading.textContent = 'In this channel'
    const list = document.createElement('ul')
    list.className = 'ws-prose-documents'
    for (const { doc, index } of files) {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = channel.labels[index] ?? doc.name
      button.title = `${doc.owner}:${doc.path}`
      button.addEventListener('click', () => opts.onSelect(doc.key))
      item.append(button)
      list.append(item)
    }
    article.append(heading, list)
  }
  scroller.append(article)
  return scroller
}
