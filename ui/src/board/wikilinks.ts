/**
 * wikilinks — turning a fiber body's `[[…]]` references into openable cards.
 *
 * A fiber body cites its neighbours the way felt does, in double brackets:
 * `[[ai-futures/application/interview/slides]]`. Those citations were dead
 * text on the reading surface; here they become the reading surface's own
 * navigation — click one and the fiber it names opens as another card beside
 * this one, itself carrying live wikilinks, so a body's references are a path
 * you can walk rather than ids to copy out.
 *
 * Two halves, split so the string half stays pure:
 *
 *   `renderMarkdown` (utils.ts) emits every `[[…]]` as an INERT anchor — it has
 *   no fiber index and cannot know what resolves. `installWikilinks` runs over
 *   the rendered DOM once the index is in hand and decides: a target that names
 *   a real fiber becomes a live link, and one that names nothing is restored to
 *   the literal `[[…]]` text it was written as. So an unresolvable reference
 *   reads exactly as it always did, and no click ever opens a broken card.
 *
 * The index is `GET /api/v1/fibers` (ids + names, a few hundred rows), fetched
 * once per daemon base and shared — the parent picker already pays for it.
 */

import { fetchFiberIndex } from './fiberSearch.js'

export interface FiberIndexEntry {
  id: string
  name: string
}

/** One in-flight/settled index fetch per daemon base, shared by every panel.
 *  A failed fetch is dropped so the next reader retries rather than inheriting
 *  a permanently empty index (which would make every wikilink inert). */
const indexCache = new Map<string, Promise<FiberIndexEntry[]>>()

export function fiberIndex(shuttleBase: string): Promise<FiberIndexEntry[]> {
  const hit = indexCache.get(shuttleBase)
  if (hit) return hit
  const p = fetchFiberIndex(shuttleBase).catch((e: unknown) => {
    indexCache.delete(shuttleBase)
    throw e
  })
  indexCache.set(shuttleBase, p)
  return p
}

/** Test seam — lets a test install an index without a daemon. */
export function primeFiberIndex(shuttleBase: string, rows: FiberIndexEntry[]): void {
  indexCache.set(shuttleBase, Promise.resolve(rows))
}

/**
 * What fiber does a wikilink's text name?
 *
 * Fiber bodies cite each other by slug, so an exact id is the first and by far
 * the commonest case. The rest is deliberately conservative — a wikilink is
 * prose, and guessing wrong sends the reader to the wrong fiber, which is worse
 * than leaving the text inert:
 *
 *   1. exact id, then case-insensitively;
 *   2. a UNIQUE trailing path segment match — `[[shear_2d]]` for
 *      `science/unions/shear_2d`, which is how a body refers to a sibling;
 *   3. a UNIQUE exact `name:` match, for a body that cites a fiber by title.
 *
 * Ambiguity resolves to nothing. Two fibers ending `…/triage` mean the writer
 * has to say which, and an inert `[[triage]]` says so honestly.
 */
export function resolveWikilink(target: string, index: FiberIndexEntry[]): string | null {
  const raw = target.trim().replace(/^\/+|\/+$/g, '')
  if (!raw) return null

  for (const row of index) if (row.id === raw) return row.id

  const lower = raw.toLowerCase()
  const ciId = index.filter((r) => r.id.toLowerCase() === lower)
  if (ciId.length === 1) return ciId[0].id

  if (!raw.includes('/')) {
    const bySegment = index.filter((r) => r.id.toLowerCase().endsWith('/' + lower))
    if (bySegment.length === 1) return bySegment[0].id
  } else {
    const bySuffix = index.filter((r) => r.id.toLowerCase().endsWith('/' + lower))
    if (bySuffix.length === 1) return bySuffix[0].id
  }

  const byName = index.filter((r) => r.name.toLowerCase() === lower)
  if (byName.length === 1) return byName[0].id

  return null
}

/**
 * Resolve every `[[…]]` anchor rendered under `root`, in place.
 *
 * Resolvable → `.kbn-wikilink-live`, a fiber id on `data-fiber`, and a click
 * that hands the id to `onOpen`. Unresolvable → replaced by a text node
 * carrying the source text, so the paragraph reads as it did before wikilinks
 * existed. Idempotent: a second pass over the same DOM finds nothing to do.
 */
export async function installWikilinks(
  root: HTMLElement,
  opts: {
    shuttleBase: string
    onOpen: (fiberId: string) => void
    /** Guard against a panel that closed (or re-rendered) while we awaited. */
    stillCurrent?: () => boolean
  },
): Promise<void> {
  const links = Array.from(root.querySelectorAll<HTMLAnchorElement>('a.kbn-wikilink'))
  if (links.length === 0) return

  let index: FiberIndexEntry[]
  try {
    index = await fiberIndex(opts.shuttleBase)
  } catch {
    // No index, no resolution — leave every reference as literal text rather
    // than offering links that cannot be trusted to open anything.
    for (const a of links) deaden(a)
    return
  }
  if (opts.stillCurrent && !opts.stillCurrent()) return

  for (const a of links) {
    const target = a.dataset.fiber ?? ''
    const id = resolveWikilink(target, index)
    if (!id) {
      deaden(a)
      continue
    }
    a.dataset.fiber = id
    a.classList.add('kbn-wikilink-live')
    a.setAttribute('role', 'link')
    a.setAttribute('tabindex', '0')
    a.title = id
    a.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      opts.onOpen(id)
    })
    a.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      opts.onOpen(id)
    })
  }
}

/** Put a reference that names no fiber back the way it was written. */
function deaden(a: HTMLAnchorElement): void {
  const raw = a.dataset.wikilinkRaw ?? `[[${a.textContent ?? ''}]]`
  a.replaceWith(document.createTextNode(raw))
}
