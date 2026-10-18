/**
 * The newest report each fiber sent — what a Desk row marks and its preview
 * shows as a thumbnail.
 *
 * One fleet read (`/api/v1/sent-files/all/composite`) answers for every card at
 * once, so the Desk never asks per card. Reads are throttled: a report arriving
 * is worth knowing within a minute, not within a poll.
 */

import { normalizeShelfFiles, shelfKind, type ShelfFile } from './views/shelfData.js'
import { docKey, parseDocKey } from './workspace/documents.js'
import type { KanbanCard } from './KanbanTypes.js'

/** A sent file resolved to the host that holds its bytes. */
export interface LatestReport {
  fullPath: string
  basename: string
  timestamp: number
  /** The daemon holding the bytes, as `/api/v1/file` wants it. */
  owner: string
}

/** How far back a report still counts as a fiber's latest. */
export const REPORT_WINDOW_MS = 30 * 86_400_000
/** The least time between two fleet reads. */
export const REPORT_REFRESH_MS = 60_000

/**
 * Newest drawable file per sending fiber. A tarball or a binary is a receipt,
 * not something a thumbnail can show, so it never stands for the fiber.
 */
export function newestByFiber(files: readonly ShelfFile[]): Map<string, ShelfFile> {
  const out = new Map<string, ShelfFile>()
  for (const file of files) {
    if (!file.uid || file.uid === file.sessionId) continue
    if (shelfKind(file.fullPath) === 'opaque') continue
    const prior = out.get(file.uid)
    if (!prior || file.timestamp > prior.timestamp) out.set(file.uid, file)
  }
  return out
}

export class LatestReports {
  private byFiber = new Map<string, ShelfFile>()
  private readAt = -Infinity
  private inflight: Promise<void> | null = null
  private readonly base: string
  private readonly onChange: () => void

  constructor(shuttleBase: string, onChange: () => void) {
    this.base = shuttleBase
    this.onChange = onChange
  }

  /** The newest report `card` sent, keyed by its uid or, failing that, its id. */
  get(card: KanbanCard): LatestReport | undefined {
    const file = (card.uid ? this.byFiber.get(card.uid) : undefined) ?? this.byFiber.get(card.id)
    if (!file) return undefined
    const parsed = parseDocKey(docKey(file.host ?? '', file.fullPath, card.originId, card.fiberDir))
    if (!parsed) return undefined
    return { fullPath: parsed.path, basename: file.basename, timestamp: file.timestamp, owner: parsed.owner }
  }

  /** Read the fleet feed unless a read is in flight or happened within the throttle. */
  refresh(nowMs = Date.now()): Promise<void> {
    if (this.inflight) return this.inflight
    if (nowMs - this.readAt < REPORT_REFRESH_MS) return Promise.resolve()
    this.readAt = nowMs
    this.inflight = (async () => {
      try {
        const since = Math.floor(nowMs - REPORT_WINDOW_MS)
        const res = await fetch(`${this.base}/api/v1/sent-files/all/composite?since_ms=${since}`, { cache: 'no-store' })
        if (!res.ok) return
        const next = newestByFiber(normalizeShelfFiles(await res.json()))
        if (!sameReports(this.byFiber, next)) {
          this.byFiber = next
          this.onChange()
        }
      } catch {
        // The mark is a convenience: an unreachable feed leaves the last answer standing.
      } finally {
        this.inflight = null
      }
    })()
    return this.inflight
  }
}

function sameReports(a: Map<string, ShelfFile>, b: Map<string, ShelfFile>): boolean {
  if (a.size !== b.size) return false
  for (const [uid, file] of a) {
    const other = b.get(uid)
    if (!other || other.fullPath !== file.fullPath || other.timestamp !== file.timestamp || other.host !== file.host) return false
  }
  return true
}
