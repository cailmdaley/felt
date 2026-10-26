/**
 * The sent-files trail — what a worker pushed with `SendUserFile`.
 *
 * A leaf module: shape and pure transforms only, no DOM and no fetch, so every
 * Board surface that shows sent files reads the same records rather than
 * growing separate dialects of "a sent file".
 */

/**
 * One sent deliverable on a card's trail. `fullPath` is the absolute path the
 * `/api/v1/file` route reads; `sessionId` is the worker session that pushed it
 * (display-only). `timestamp` is epoch milliseconds — `shuttle hook event` writes
 * `UnixMilli`.
 */
export interface SentFile {
  fullPath: string
  basename: string
  timestamp: number
  sessionId?: string
}

/** One send call, grouped from its per-path receipts for a conversation row. */
export interface SentFileSend {
  id: string
  sessionId: string
  files: SentFile[]
  timestamp?: number
}

/**
 * Coerce whatever `/api/v1/sent-files` returned into records this UI can use.
 *
 * The endpoint passes the hook event's `timestamp` through verbatim, so an
 * older writer's ISO string arrives where a number is expected; a record with
 * no usable path is dropped rather than drawn as a chip that opens nothing.
 */
export function normalizeSentFiles(raw: unknown): SentFile[] {
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
    out.push({
      fullPath,
      basename:
        typeof rec.basename === 'string' && rec.basename
          ? rec.basename
          : (fullPath.split('/').filter(Boolean).pop() ?? fullPath),
      timestamp,
      sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : undefined,
    })
  }
  return out
}

/** Group the fiber's receipts into sends made by one native session. */
export function sentFileSends(files: readonly SentFile[], sessionId: string): SentFileSend[] {
  const groups = new Map<string, SentFileSend>()
  for (const file of files) {
    if (file.sessionId !== sessionId) continue
    const timestamp = file.timestamp > 0 ? file.timestamp : undefined
    const key = timestamp === undefined
      ? `${sessionId}:unknown:${file.fullPath}`
      : `${sessionId}:${timestamp}`
    let send = groups.get(key)
    if (!send) {
      send = {
        id: key,
        sessionId,
        files: [],
        ...(timestamp === undefined ? {} : { timestamp }),
      }
      groups.set(key, send)
    }
    if (!send.files.some((item) => item.fullPath === file.fullPath)) send.files.push(file)
  }
  return [...groups.values()]
    .map((send) => ({
      ...send,
      files: [...send.files].sort((a, b) => a.basename.localeCompare(b.basename) || a.fullPath.localeCompare(b.fullPath)),
    }))
    .sort((a, b) => (a.timestamp ?? Number.POSITIVE_INFINITY) - (b.timestamp ?? Number.POSITIVE_INFINITY) || a.id.localeCompare(b.id))
}
