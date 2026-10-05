import { parseCompositeFeed, type CompositeEntry } from '../KanbanComposite.js'
import { fiberDocUrl } from '../utils.js'

/** Read any fiber, independently of Desk admission, on the requested owner. */
export async function readFiber(shuttleBase: string, id: string, owner: string, signal?: AbortSignal): Promise<CompositeEntry> {
  const response = await fetch(`${fiberDocUrl(shuttleBase, id)}?body=true&origin=${encodeURIComponent(owner)}`,
    { cache: 'no-store', signal: signal ?? AbortSignal.timeout(25000) })
  if (!response.ok) throw new Error(response.status === 404 ? `Fiber not found on ${owner}` : `${owner} is unreachable`)
  const entry = parseCompositeFeed(await response.json()).entries[0]
  if (!entry) throw new Error(`Fiber not found on ${owner}`)
  // A proxied envelope can name the composing host; the requested owner owns the read.
  return { ...entry, origin: owner }
}
