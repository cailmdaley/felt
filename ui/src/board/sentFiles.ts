/**
 * The sent-files trail — what a worker pushed with `SendUserFile`.
 *
 * A leaf module: shape and pure transforms only, no DOM and no fetch, so every
 * Board surface that shows sent files reads the same records rather than
 * growing separate dialects of "a sent file".
 */

/**
 * One sent deliverable. `fullPath` is the absolute path the `/api/v1/file`
 * route reads; `sessionId` is the worker session that pushed it
 * (display-only). `timestamp` is epoch milliseconds — `shuttle hook event`
 * writes `UnixMilli`. `uid` is the fiber that sent it and `host` the daemon
 * holding the bytes; either may be absent from an unattributed receipt.
 */
export interface SentFile {
  fullPath: string
  basename: string
  timestamp: number
  sessionId?: string
  uid?: string
  host?: string | null
  /** Why it was sent, when its send said. */
  caption?: string
}

/**
 * Coerce a sent-files body (`{files: [...]}`) into records this UI can use.
 *
 * The endpoint passes the hook event's `timestamp` through verbatim, so an
 * ISO string can arrive where a number is expected; a record with no usable
 * path is dropped rather than drawn as a chip that opens nothing.
 */
export function normalizeSentFiles(body: unknown): SentFile[] {
  const raw = body && typeof body === 'object' ? (body as { files?: unknown }).files : undefined
  if (!Array.isArray(raw)) return []
  const out: SentFile[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const fullPath = typeof rec.fullPath === 'string' ? rec.fullPath : ''
    if (!fullPath) continue
    const stamp = rec.timestamp
    const timestamp =
      typeof stamp === 'number' && Number.isFinite(stamp)
        ? stamp
        : typeof stamp === 'string'
          ? Date.parse(stamp) || 0
          : 0
    const file: SentFile = {
      fullPath,
      basename:
        typeof rec.basename === 'string' && rec.basename
          ? rec.basename
          : (fullPath.split('/').filter(Boolean).pop() ?? fullPath),
      timestamp,
      sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : undefined,
    }
    if (typeof rec.uid === 'string' && rec.uid) file.uid = rec.uid
    if (typeof rec.host === 'string' && rec.host) file.host = rec.host
    if (typeof rec.caption === 'string' && rec.caption.trim()) file.caption = rec.caption.trim()
    out.push(file)
  }
  return out
}

/**
 * Each identity's newest send, oldest first. Its caption is the newest send's,
 * else the latest caption an earlier send of it gave: a file sent again
 * without a caption keeps the last it was given.
 */
export function latestSends(files: readonly SentFile[], identity: (file: SentFile) => string): SentFile[] {
  const latest = new Map<string, SentFile>(), said = new Map<string, SentFile>()
  for (const file of files) {
    const id = identity(file), prior = latest.get(id), told = said.get(id)
    if (!prior || file.timestamp > prior.timestamp) latest.set(id, file)
    if (file.caption && (!told || file.timestamp > told.timestamp)) said.set(id, file)
  }
  return [...latest].map(([id, file]) => file.caption || !said.has(id) ? file : { ...file, caption: said.get(id)!.caption })
    .sort((a, b) => a.timestamp - b.timestamp)
}
