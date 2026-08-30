/**
 * The sent-files trail — what a worker pushed with `SendUserFile`.
 *
 * A leaf module: shape and pure transforms only, no DOM and no fetch, so the
 * detail panel (which opens the trail in its accordion) and the Day page
 * (which shows the day's slice of it as chips) read the same records the same
 * way rather than growing two dialects of "a sent file".
 */

/**
 * One sent deliverable on a card's trail. `fullPath` is the absolute path the
 * `/api/v1/file` route reads; `sessionId` is the worker session that pushed it
 * (display-only). `timestamp` is epoch milliseconds — `felt hook event` writes
 * `UnixMilli`.
 */
export interface SentFile {
  fullPath: string
  basename: string
  timestamp: number
  sessionId?: string
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
      typeof stamp === 'number'
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

/**
 * Stable identity for the sent-files trail. A repeated path with a newer
 * timestamp is a new delivery, even though it remains one row after the
 * endpoint's path deduplication.
 */
export function sentFilesRevision(files: readonly SentFile[]): string {
  return JSON.stringify(files.map((file) => [file.fullPath, file.timestamp, file.sessionId ?? '']))
}

/**
 * The files this fiber sent inside one window — half-open `[startMs, endMs)`,
 * the same convention the day's rail uses, so a send at 06:00 belongs to the
 * day that opens then and not to the one that just closed. Newest-first, and
 * disambiguated AFTER the filter so the labels describe the set actually
 * shown (two same-named files, only one of them today's, reads as one plain
 * name).
 */
export function sentFilesInWindow(
  files: readonly SentFile[],
  startMs: number,
  endMs: number,
): SentFile[] {
  const inside = files.filter((f) => f.timestamp >= startMs && f.timestamp < endMs)
  inside.sort((a, b) => b.timestamp - a.timestamp)
  return disambiguateBasenames(inside)
}

/**
 * Make every file in a trail nameable. When a basename (the path's last
 * segment) collides, walk up the path one parent segment at a time, prefixing
 * `parent-…/basename` (joined by `/`) until every colliding file's label is
 * distinct (e.g. `morning-post/report.html` vs `standalone-kanban/report.html`).
 * Files whose basename is already unique keep the bare name. The full path stays
 * available as the row/header `title` tooltip. Returns a new array; inputs are
 * not mutated (recency order is preserved).
 */
export function disambiguateBasenames(files: readonly SentFile[]): SentFile[] {
  const tail = (p: string) => p.split('/').filter(Boolean)
  const byBase = new Map<string, SentFile[]>()
  for (const f of files) {
    const base = tail(f.fullPath).pop() ?? f.fullPath
    ;(byBase.get(base) ?? byBase.set(base, []).get(base)!).push(f)
  }
  const labelFor = new Map<string, string>()
  for (const [base, group] of byBase) {
    if (group.length === 1) {
      labelFor.set(group[0].fullPath, base)
      continue
    }
    // Collision: extend each label leftward until all are distinct (or we run
    // out of parent segments — then the fullest path stands in).
    const segs = group.map((f) => tail(f.fullPath))
    let depth = 1
    const maxDepth = Math.max(...segs.map((s) => s.length))
    while (depth < maxDepth) {
      depth += 1
      const labels = segs.map((s) => s.slice(-depth).join('/'))
      if (new Set(labels).size === group.length) break
    }
    group.forEach((f, i) => labelFor.set(f.fullPath, segs[i].slice(-depth).join('/')))
  }
  return files.map((f) => ({ ...f, basename: labelFor.get(f.fullPath) ?? f.basename }))
}
