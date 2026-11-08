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
    out.push(file)
  }
  return out
}
