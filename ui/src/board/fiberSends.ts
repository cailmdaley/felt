/**
 * What each fiber sent: the files a Desk row marks (its newest report) and its
 * preview lays out as a gallery (everything it sent, newest first).
 *
 * One fleet read (`/api/v1/sent-files/all/composite`) answers for every card at
 * once, so the Desk never asks per card. Reads are throttled: a file arriving
 * is worth knowing within a minute, not within a poll.
 */

import { normalizeShelfFiles, shelfKind, type ShelfFile } from './views/shelfData.js'
import { docKey, parseDocKey, type DocKey } from './workspace/documents.js'
import type { KanbanCard } from './KanbanTypes.js'

/** A sent file resolved to the host that holds its bytes. */
export interface FiberSend {
  /** The document's key in the reader, where it is opened and marked seen. */
  key: DocKey
  fullPath: string
  basename: string
  timestamp: number
  /** The daemon holding the bytes, as `/api/v1/file` wants it. */
  owner: string
}

/** How far back a sent file still counts. */
export const SEND_WINDOW_MS = 30 * 86_400_000
/** The least time between two fleet reads. */
export const SEND_REFRESH_MS = 60_000

/**
 * Each sending fiber's files, newest first, one entry per document: a file
 * sent again counts at its latest send. Session-only sends (no fiber) belong
 * to no card.
 */
export function sendsByFiber(files: readonly ShelfFile[]): Map<string, ShelfFile[]> {
  const latest = new Map<string, ShelfFile>()
  for (const file of files) {
    if (!file.uid || file.uid === file.sessionId) continue
    const identity = `${file.uid}\u0000${file.host ?? ''}\u0000${file.fullPath}`
    const prior = latest.get(identity)
    if (!prior || file.timestamp > prior.timestamp) latest.set(identity, file)
  }
  const out = new Map<string, ShelfFile[]>()
  for (const file of latest.values()) {
    const list = out.get(file.uid!)
    if (list) list.push(file)
    else out.set(file.uid!, [file])
  }
  for (const list of out.values()) list.sort((a, b) => b.timestamp - a.timestamp || a.fullPath.localeCompare(b.fullPath))
  return out
}

/**
 * The file that stands for a fiber on its row: its newest drawable one. A
 * tarball or a binary is a receipt, not something a thumbnail can show.
 */
export function newestReport(files: readonly ShelfFile[]): ShelfFile | undefined {
  return files.find(file => shelfKind(file.fullPath) !== 'opaque')
}

export class FiberSends {
  private byFiber = new Map<string, ShelfFile[]>()
  private readAt = -Infinity
  private inflight: Promise<void> | null = null
  private readonly base: string
  private readonly onChange: () => void

  constructor(shuttleBase: string, onChange: () => void) {
    this.base = shuttleBase
    this.onChange = onChange
  }

  /** The newest report `card` sent. */
  latest(card: KanbanCard): FiberSend | undefined {
    const file = newestReport(this.filesOf(card))
    return file ? resolve(card, file) : undefined
  }

  /** Everything `card` sent, newest first. */
  all(card: KanbanCard): FiberSend[] {
    return this.filesOf(card).flatMap(file => resolve(card, file) ?? [])
  }

  /** Keyed by the card's uid or, failing that, its id. */
  private filesOf(card: KanbanCard): ShelfFile[] {
    return (card.uid ? this.byFiber.get(card.uid) : undefined) ?? this.byFiber.get(card.id) ?? []
  }

  /** Read the fleet feed unless a read is in flight or happened within the throttle. */
  refresh(nowMs = Date.now()): Promise<void> {
    if (this.inflight) return this.inflight
    if (nowMs - this.readAt < SEND_REFRESH_MS) return Promise.resolve()
    this.readAt = nowMs
    this.inflight = (async () => {
      try {
        const since = Math.floor(nowMs - SEND_WINDOW_MS)
        const res = await fetch(`${this.base}/api/v1/sent-files/all/composite?since_ms=${since}`, { cache: 'no-store' })
        if (!res.ok) return
        const next = sendsByFiber(normalizeShelfFiles(await res.json()))
        if (!sameSends(this.byFiber, next)) {
          this.byFiber = next
          this.onChange()
        }
      } catch {
        // The marks and the gallery are conveniences: an unreachable feed leaves the last answer standing.
      } finally {
        this.inflight = null
      }
    })()
    return this.inflight
  }
}

function resolve(card: KanbanCard, file: ShelfFile): FiberSend | undefined {
  const key = docKey(file.host ?? '', file.fullPath, card.originId, card.fiberDir)
  const parsed = parseDocKey(key)
  if (!parsed) return undefined
  return { key, fullPath: parsed.path, basename: file.basename, timestamp: file.timestamp, owner: parsed.owner }
}

function sameSends(a: Map<string, ShelfFile[]>, b: Map<string, ShelfFile[]>): boolean {
  if (a.size !== b.size) return false
  for (const [uid, files] of a) {
    const other = b.get(uid)
    if (!other || other.length !== files.length) return false
    for (let i = 0; i < files.length; i++) {
      const x = files[i], y = other[i]
      if (x.fullPath !== y.fullPath || x.timestamp !== y.timestamp || x.host !== y.host) return false
    }
  }
  return true
}
