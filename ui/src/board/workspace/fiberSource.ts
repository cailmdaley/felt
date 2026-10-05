import { parseCompositeFeed, type CompositeEntry } from '../KanbanComposite.js'
import { fiberDocUrl } from '../utils.js'

export type FiberReadMode = 'pinned' | 'discover'

/** Pinned reads select a source; discovery lets that source resolve a fiber's owner. */
export async function readFiber(shuttleBase: string, id: string, owner: string, signal?: AbortSignal, mode: FiberReadMode = 'pinned'): Promise<CompositeEntry> {
  const response = await fetch(`${fiberDocUrl(shuttleBase, id)}?body=true&origin=${encodeURIComponent(owner)}${mode === 'pinned' ? '&routed=1' : ''}`,
    { cache: 'no-store', signal: signal ?? AbortSignal.timeout(25000) })
  if (!response.ok) throw new Error(response.status === 404 ? `Fiber not found on ${owner}` : `${owner} is unreachable`)
  const body: unknown = await response.json()
  const feed = parseCompositeFeed(body)
  const raw = (body && typeof body === 'object' ? body : {}) as { fibers?: Array<{ origin?: unknown; path?: unknown; felt_store?: unknown }>; origins?: unknown }
  const entry = feed.entries[0]
  if (!entry) throw new Error(Array.isArray(raw.fibers) && raw.fibers.length === 0 ? `Fiber not found on ${owner}` : `${owner} is unreachable`)
  if (mode === 'pinned') return { ...entry, origin: owner }
  const rowOrigin = raw.fibers?.find(row => row?.path === entry.path && row?.felt_store === entry.feltStore)?.origin
  // Single-document relays preserve the serving daemon's envelope verbatim.
  // A composite envelope names its hub, not the source of an unstamped row.
  const source = typeof rowOrigin === 'string' && rowOrigin ? rowOrigin
    : raw.origins === undefined && feed.host ? feed.host : owner
  return { ...entry, origin: source }
}
