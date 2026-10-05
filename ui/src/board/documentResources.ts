import { inLane } from './requestLanes.js'

/**
 * One reader of a document's bytes for every surface that only needs its
 * head: the title probe, overview and preview thumbnails, and the listening
 * page. A peek is the first 64 KiB of `/file`, read once however many
 * surfaces ask at the same time, and kept briefly so a render pass, a hover
 * and a thumbnail share it. Peeks wait in the quiet request lane, ordered by
 * what they serve.
 *
 * This is the seed of the workspace's document resource cache: whole-body
 * reads (`LiveFileRefresh`) and metadata belong here next.
 */
export const PEEK_BYTES = 65536
/** What a peek serves, most urgent first. */
export const PEEK_PRIORITY = { selected: 0, neighbour: 1, title: 2, thumbnail: 3, duration: 4 } as const
export type PeekPriority = typeof PEEK_PRIORITY[keyof typeof PEEK_PRIORITY]
export interface Peek { bytes: Uint8Array; etag?: string }

/** A settled peek answers again for this long; after it, the HTTP cache revalidates. */
const PEEK_TTL_MS = 30_000
const PEEK_LIMIT = 200
const settled = new Map<string, { peek: Peek; at: number }>()
const inFlight = new Map<string, Promise<Peek | null>>()

/** The first 64 KiB of `src`, shared by concurrent callers; null when the owner cannot answer. */
export function peekDocument(src: string, priority: PeekPriority = PEEK_PRIORITY.title, options: { fresh?: boolean; now?: number } = {}): Promise<Peek | null> {
  // A caller that knows the document moved asks for a fresh read.
  if (!options.fresh) {
    const hit = settled.get(src)
    if (hit && (options.now ?? Date.now()) - hit.at < PEEK_TTL_MS) return Promise.resolve(hit.peek)
    const pending = inFlight.get(src)
    if (pending) return pending
  }
  const read = inLane('quiet', () => readHead(src, priority <= PEEK_PRIORITY.title ? 'high' : 'auto', options.fresh ? 'no-cache' : 'default'), { rank: priority })
    .catch(() => null)
    .then(peek => {
      if (inFlight.get(src) === read) inFlight.delete(src)
      if (peek) {
        settled.delete(src)
        settled.set(src, { peek, at: Date.now() })
        if (settled.size > PEEK_LIMIT) settled.delete(settled.keys().next().value!)
      }
      return peek
    })
  inFlight.set(src, read)
  return read
}

/** Native viewers own their byte streams; a peek stops after 64 KiB even if Range is ignored. */
async function readHead(src: string, priority: RequestPriority, cache: RequestCache): Promise<Peek | null> {
  const response = await fetch(src, { priority, cache, headers: { Range: `bytes=0-${PEEK_BYTES - 1}` } })
  if (!response.ok || !response.body) return null
  const reader = response.body.getReader()
  const bytes = new Uint8Array(PEEK_BYTES)
  let length = 0
  try {
    while (length < bytes.length) {
      const chunk = await reader.read()
      if (chunk.done) break
      const part = chunk.value.subarray(0, bytes.length - length)
      bytes.set(part, length); length += part.length
    }
  } finally { await reader.cancel() }
  return { bytes: bytes.subarray(0, length), etag: response.headers.get('ETag') ?? undefined }
}

/** Test support. */
export function resetDocumentResources(): void {
  settled.clear(); inFlight.clear()
}
