import type { KanbanCard } from '../KanbanTypes.js'
import { extractEmbeds } from '../attachments.js'
import { basename, renderMarkdown } from '../utils.js'
import { installWikilinks } from '../wikilinks.js'
import { head, RESOURCE_PRIORITY } from '../documentResources.js'
import '../prose.css'
import './fiber-prose.css'
import type { Channel } from './documents.js'
import { buildRoleLedger, charterId, roleSlug } from './RolePage.js'

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
 * The office for the status line, left of the worker pill: the role
 * is a wikilink to its charter (`roles/<slug>`, or `<mount>/roles/<slug>`),
 * live when the index names one and plain text otherwise.
 */
function roleChip(slug: string | undefined, person: string | undefined, opts: { shuttleBase: string; onFiber: (id: string) => void }): HTMLElement | null {
  if (!slug) return null
  const el = document.createElement('span')
  el.className = 'ws-fiber-roles'
  el.dataset.part = 'roles'
  el.setAttribute('role', 'group')
  el.setAttribute('aria-label', 'Role')
  const role = document.createElement('span')
  role.className = 'ws-fiber-role'
  const link = document.createElement('a')
  link.className = 'kbn-wikilink'
  link.dataset.fiber = `roles/${slug}`
  link.dataset.wikilinkRaw = slug
  link.textContent = slug
  role.append(link)
  // The person responsible, unless the role is only that person's own desk.
  if (person && person !== slug) {
    const who = document.createElement('span')
    who.className = 'ws-fiber-role-person'
    who.textContent = ` · ${person}`
    role.append(who)
  }
  el.append(role)
  void installWikilinks(el, { shuttleBase: opts.shuttleBase, onOpen: opts.onFiber, resolve: (_, index) => charterId(slug, index.map(row => row.id)) })
  return el
}

export function buildFiberProse(
  card: KanbanCard,
  channel: Channel,
  opts: {
    shuttleBase: string
    onFiber: (id: string) => void
    onFile: (path: string, title?: string) => void
    /** On a role charter, the constitutions assigned to the office in Desk order. */
    holds?: KanbanCard[]
    onCard?: (card: KanbanCard) => void
    /** Drawn under its own row on a constitution's page, which already shows its name and outcome. */
    embedded?: boolean
  },
): HTMLElement {
  const scroller = document.createElement('div')
  scroller.className = 'ws-prose-scroll'
  const article = document.createElement('article')
  article.className = 'ws-prose ws-fiber-prose kbn-detail-prose'
  article.dataset.part = 'prose'
  // The title line: the name, then its office beside it. Unfolded under its
  // own row, the row already names the fiber and says what it came to, so
  // only the office stays.
  const header = document.createElement('header')
  header.className = 'ws-prose-header'
  header.dataset.part = 'fiber-header'
  if (!opts.embedded) {
    const title = document.createElement('h1')
    title.textContent = channel.name
    title.dataset.part = 'fiber-title'
    header.append(title)
  }
  // An office named like the fiber itself would only say the name twice.
  const kebab = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const roles = card.shuttleRole && kebab(card.shuttleRole) !== kebab(channel.name) ? roleChip(card.shuttleRole, card.shuttlePerson, opts) : null
  if (roles) header.append(roles)
  const outcome = document.createElement('div')
  const outcomeText = opts.embedded ? '' : channel.outcome ?? card.outcome ?? ''
  outcome.innerHTML = ledeHtml(outcomeText)
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
  const slug = roleSlug(card)
  const ledger = slug ? buildRoleLedger(opts.holds ?? [], { onCard: opts.onCard ?? (() => {}) }) : null
  article.append(...(header.childElementCount ? [header] : []), ...(outcomeText.trim() ? [outcome] : []), ...(ledger ? [ledger] : []), body)
  scroller.append(article)
  return scroller
}
