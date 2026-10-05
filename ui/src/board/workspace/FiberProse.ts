import type { KanbanCard } from '../KanbanTypes.js'
import { extractEmbeds } from '../attachments.js'
import { basename, renderMarkdown } from '../utils.js'
import { installWikilinks } from '../wikilinks.js'
import '../prose.css'
import './fiber-prose.css'
import type { Channel, DocKey, WorkspaceDocument } from './documents.js'
import { fiberPageKicker } from './fiberPageState.js'

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
      if (link.dataset.wsReference || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
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
    controls?: HTMLElement
    onSelect: (key: DocKey) => void
    onFiber: (id: string) => void
    onFile: (path: string, title?: string) => void
  },
): HTMLElement {
  const scroller = document.createElement('div')
  scroller.className = 'ws-prose-scroll'
  const article = document.createElement('article')
  article.className = 'ws-prose ws-fiber-prose kbn-detail-prose'
  article.dataset.part = 'prose'
  const header = document.createElement('header')
  header.className = 'ws-prose-header'
  header.dataset.part = 'fiber-header'
  if (card.status) {
    const status = document.createElement('span')
    status.className = 'ws-prose-status'
    status.textContent = fiberPageKicker(card)
    header.append(status)
  }
  const title = document.createElement('h1')
  title.textContent = channel.name
  title.dataset.part = 'fiber-title'
  const outcome = document.createElement('div')
  outcome.innerHTML = ledeHtml(channel.outcome ?? card.outcome ?? '')
  const contents = document.createElement('nav')
  contents.className = 'ws-prose-contents'
  contents.setAttribute('aria-label', 'Document kinds')
  const files = channel.documents.filter(doc => doc.kind !== 'fiber')
  if (files.length) {
    const total = document.createElement('span')
    total.textContent = `${channel.documents.length} pages`
    contents.append(total)
    const groups: Array<[WorkspaceDocument['kind'], string, string]> = [['html', 'report', 'reports'], ['audio', 'audio', 'audio'], ['pdf', 'PDF', 'PDF'], ['image', 'image', 'images'], ['video', 'video', 'videos'], ['text', 'text', 'texts'], ['other', 'file', 'files']]
    for (const [kind, singular, plural] of groups) {
      const documents = files.filter(doc => doc.kind === kind)
      if (!documents.length) continue
      const newest = [...documents].sort((a, b) => {
        const time = (doc: WorkspaceDocument) => Math.max(0, ...doc.provenance.flatMap(p => p.kind === 'sent' && Number.isFinite(p.time) ? [p.time] : []), Date.parse(doc.modifiedAt ?? '') || 0)
        return time(b) - time(a) || channel.documents.indexOf(a) - channel.documents.indexOf(b)
      })[0]
      const select = document.createElement('button')
      select.type = 'button'
      select.textContent = `${documents.length} ${documents.length === 1 ? singular : plural}`
      select.addEventListener('click', () => opts.onSelect(newest.key))
      contents.append(select)
    }
  }
  const body = document.createElement('div')
  body.className = 'ws-prose-body'
  body.innerHTML = renderFiberMarkdown(channel.body, '', {
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
  article.append(header, title, outcome, ...(files.length ? [contents] : []), ...(opts.controls ? [opts.controls] : []), body)
  scroller.append(article)
  return scroller
}
