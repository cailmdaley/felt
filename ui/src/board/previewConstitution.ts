/**
 * The constitution in the preview: its body (Desired State, Status, …)
 * rendered as the reader renders it, below the gallery. The files it embeds
 * (`:::{embed}`) are handed to the gallery, where they stand beside what the
 * fiber sent, rather than drawn here.
 *
 * The body is read from the owning daemon only when a preview opens, once per
 * card within a minute, so running the pointer down a column of drafts does
 * not read each one again.
 */

import type { KanbanCard } from './KanbanTypes.js'
import { readFiber } from './workspace/fiberSource.js'
import { renderFiberMarkdown, installBodyFileLinks } from './workspace/FiberProse.js'
import { installWikilinks } from './wikilinks.js'
import { docKey, parseDocKey, type DocKey } from './workspace/documents.js'
import type { FiberSend } from './fiberSends.js'
import { basename } from './utils.js'
import './prose.css'

/** How long a read body answers for its card. */
export const BODY_FRESH_MS = 60_000

type BodyReader = (card: KanbanCard) => Promise<string>

const cache = new Map<string, { at: number; body: Promise<string> }>()

const cardKey = (card: KanbanCard): string => `${card.originId}\u0000${card.id}`

/** The card's body, from the cache while fresh, or read once for every asker. */
export function cardBody(card: KanbanCard, read: BodyReader, now = Date.now()): Promise<string> {
  const key = cardKey(card)
  const hit = cache.get(key)
  if (hit && now - hit.at < BODY_FRESH_MS) return hit.body
  const body = read(card)
  cache.set(key, { at: now, body })
  // A failed read is not remembered: the next preview asks again.
  body.catch(() => { if (cache.get(key)?.body === body) cache.delete(key) })
  return body
}

/** Forget every cached body (tests). */
export function clearCardBodies(): void { cache.clear() }

export interface ConstitutionOptions {
  shuttleBase: string
  openDocument: (key: DocKey) => void
  openFiber: (id: string) => void
  /** The files the body embeds, as the reader resolves them, once it is read. */
  onEmbeds?: (embeds: FiberSend[]) => void
  /** Reads the card's body; the owner-routed fiber read by default. */
  read?: BodyReader
}

/** A body's embeds as documents of the card's own host, resolved against its folder. */
export function embedSends(card: KanbanCard, paths: readonly string[]): FiberSend[] {
  const out: FiberSend[] = []
  for (const path of paths) {
    const key = docKey(card.originId, path, card.originId, card.fiberDir)
    const parsed = parseDocKey(key)
    if (!parsed || out.some(send => send.key === key)) continue
    out.push({ key, fullPath: parsed.path, basename: basename(parsed.path), timestamp: 0, owner: parsed.owner, embedded: true })
  }
  return out
}

export function buildPreviewConstitution(card: KanbanCard, o: ConstitutionOptions): { el: HTMLElement; dispose: () => void } {
  const el = document.createElement('section')
  el.className = 'kbn-preview-body'
  el.setAttribute('aria-label', 'Constitution')
  const waiting = document.createElement('p')
  waiting.className = 'kbn-preview-body-note'
  waiting.textContent = 'Reading the constitution…'
  el.append(waiting)

  let live = true
  const read = o.read ?? ((c: KanbanCard) => readFiber(o.shuttleBase, c.id, c.originId).then(entry => entry.fiber.body ?? ''))
  cardBody(card, read).then(
    (body) => { if (live) paint(body) },
    () => { if (live) waiting.textContent = `Couldn't read the constitution from ${card.originId}. Open the card to read it.` },
  )

  function paint(body: string): void {
    if (!body.trim()) {
      waiting.textContent = 'The constitution has no body yet.'
      return
    }
    const { html, attachments } = renderFiberMarkdown(body, '', card)
    const prose = document.createElement('div')
    prose.className = 'kbn-detail-prose kbn-preview-prose'
    prose.innerHTML = html
    // The renderer emits same-origin byte routes; a board served apart from
    // its daemon reads them through the configured base.
    if (o.shuttleBase) {
      for (const node of prose.querySelectorAll<HTMLElement>('a[href],img[src]')) {
        const attr = node.tagName === 'IMG' ? 'src' : 'href'
        const url = node.getAttribute(attr)
        if (url?.startsWith('/api/v1/file?')) node.setAttribute(attr, o.shuttleBase + url)
      }
    }
    const open = (path: string): void => o.openDocument(docKey(card.originId, path, card.originId, card.fiberDir))
    installBodyFileLinks(prose, open)
    void installWikilinks(prose, { shuttleBase: o.shuttleBase, onOpen: o.openFiber })

    el.replaceChildren(prose)
    if (attachments.length) o.onEmbeds?.(embedSends(card, attachments.map(a => a.path)))
  }

  return { el, dispose: () => { live = false } }
}
