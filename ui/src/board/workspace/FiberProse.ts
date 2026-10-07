import type { KanbanCard } from '../KanbanTypes.js'
import { extractEmbeds } from '../attachments.js'
import { basename, renderMarkdown } from '../utils.js'
import { installWikilinks } from '../wikilinks.js'
import { head, RESOURCE_PRIORITY } from '../documentResources.js'
import '../prose.css'
import './fiber-prose.css'
import type { Channel } from './documents.js'
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

/** Prefer the fiber directory; use the project directory only when the cache finds no file there. */
export async function settleBodyFileLink(link: HTMLAnchorElement): Promise<void> {
  const altUrl = link.dataset.fileUrlAlt
  const altPath = link.dataset.filePathAlt
  const primary = link.getAttribute('href')
  if (!altUrl || !altPath || !primary) return
  const info = await head(primary, RESOURCE_PRIORITY.title)
  // An owner that cannot answer leaves the link where it points.
  if (!info || info.exists) return
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

/**
 * The roster's roles for the status line, left of the worker pill: each role
 * is a wikilink to its fiber `roles/<slug>`, live when the index names that
 * exact id and plain text otherwise.
 */
function rosterRoles(roles: string[], opts: { shuttleBase: string; onFiber: (id: string) => void }): HTMLElement | null {
  if (roles.length === 0) return null
  const el = document.createElement('span')
  el.className = 'ws-fiber-roles'
  el.dataset.part = 'roles'
  el.setAttribute('role', 'group')
  el.setAttribute('aria-label', roles.length === 1 ? 'Role' : 'Roles')
  for (const slug of roles) {
    const role = document.createElement('span')
    role.className = 'ws-fiber-role'
    const link = document.createElement('a')
    link.className = 'kbn-wikilink'
    link.dataset.fiber = `roles/${slug}`
    link.dataset.wikilinkRaw = slug
    link.textContent = slug
    role.append(link)
    el.append(role)
  }
  void installWikilinks(el, { shuttleBase: opts.shuttleBase, onOpen: opts.onFiber, exact: true })
  return el
}

export function buildFiberProse(
  card: KanbanCard,
  channel: Channel,
  opts: {
    shuttleBase: string
    controls?: HTMLElement
    /** The status line's acts (worker pill, Temper, Discard), owned by the control band. */
    acts?: HTMLElement
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
  const roles = rosterRoles(card.roles ?? [], opts)
  if (roles) header.append(roles)
  if (opts.acts) header.append(opts.acts)
  const title = document.createElement('h1')
  title.textContent = channel.name
  title.dataset.part = 'fiber-title'
  const outcome = document.createElement('div')
  outcome.innerHTML = ledeHtml(channel.outcome ?? card.outcome ?? '')
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
  article.append(header, title, outcome, ...(opts.controls ? [opts.controls] : []), body)
  scroller.append(article)
  return scroller
}
