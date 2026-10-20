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
  /** Named by the fiber's body (`:::{embed}`); `timestamp` is 0 unless it was also sent. */
  embedded?: boolean
}

/**
 * The gallery's files: what the body embeds first, in the body's order — the
 * author's own deliverables — then everything else sent, newest first. An
 * embedded file that was also sent is one item, carrying its send's time.
 */
export function withEmbeds(sends: readonly FiberSend[], embeds: readonly FiberSend[]): FiberSend[] {
  const sent = new Map(sends.map(send => [send.key, send]))
  const lead = embeds.map(embed => {
    const match = sent.get(embed.key)
    return match ? { ...match, embedded: true } : embed
  })
  const led = new Set(lead.map(send => send.key))
  return [...lead, ...sends.filter(send => !led.has(send.key))]
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
  private readVersion = 0
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

  /** Clear sent receipts from every stream host represented on this fiber. */
  async clear(card: KanbanCard): Promise<void> {
    const uid = card.uid
    if (!uid) throw new Error('Cannot clear sends without a canonical fiber UID')
    const hosts = [...new Set(this.filesOf(card).map(file => file.host ?? card.originId).filter(Boolean))]
    if (!hosts.length) return
    const results = await Promise.allSettled(hosts.map(async origin => {
      const response = await fetch(`${this.base}/api/v1/sent-files/clear`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid, origin }),
      })
      if (!response.ok) throw new Error(`Could not clear sent files on ${origin} (${response.status})`)
    }))
    const clearedHosts = hosts.filter((_host, i) => results[i].status === 'fulfilled')
    await this.refresh(Date.now(), true, clearedHosts)
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }

  /** Dismiss one path on the stream host represented by its gallery tile. */
  async dismiss(card: KanbanCard, send: FiberSend): Promise<void> {
    if (!card.uid) throw new Error('Cannot dismiss a send without a canonical fiber UID')
    const response = await fetch(`${this.base}/api/v1/sent-files/clear`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid: card.uid, origin: send.owner, path: send.fullPath }),
    })
    if (!response.ok) throw new Error(`Could not dismiss sent file on ${send.owner} (${response.status})`)
    await this.refresh(Date.now(), true, [send.owner])
  }

  /** Read the fleet feed unless a read is in flight or happened within the throttle. */
  refresh(nowMs = Date.now(), force = false, clearedHosts: readonly string[] = []): Promise<void> {
    if (this.inflight) {
      if (!force) return this.inflight
      // A pre-clear read may complete after the clear; prevent its snapshot from winning.
      this.readVersion++
      this.inflight = null
    }
    if (!force && nowMs - this.readAt < SEND_REFRESH_MS) return Promise.resolve()
    this.readAt = nowMs
    const version = ++this.readVersion
    let request!: Promise<void>
    request = (async () => {
      try {
        const since = Math.floor(nowMs - SEND_WINDOW_MS)
        const res = await fetch(`${this.base}/api/v1/sent-files/all/composite?since_ms=${since}`, { cache: 'no-store' })
        if (!res.ok) throw new Error('Sent-files feed unavailable')
        const raw = await res.json()
        if (!raw || !Array.isArray(raw.files)) throw new Error('Invalid sent-files feed')
        for (const host of clearedHosts) {
          const origin = raw.origins?.[host]
          if (origin?.stale || origin?.last_error) throw new Error('Cleared host feed is not refreshed')
        }
        const next = sendsByFiber(normalizeShelfFiles(raw))
        if (version !== this.readVersion) return
        if (!sameSends(this.byFiber, next)) {
          this.byFiber = next
          this.onChange()
        }
      } catch {
        // Keep the last answer, but let the next poll retry a failed read.
        if (version === this.readVersion) this.readAt = -Infinity
        if (force) throw new Error('The clear request finished, but the sent-files feed could not refresh. Retrying on the next poll.')
      } finally {
        if (this.inflight === request) this.inflight = null
      }
    })()
    this.inflight = request
    return request
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
