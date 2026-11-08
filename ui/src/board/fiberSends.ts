/**
 * The newest report each Desk row marks, from one throttled fleet read.
 * The Desk never reads a sent-file feed per card.
 */
import { normalizeSentFiles, type SentFile } from './sentFiles.js'
import { DAY_MS } from './civilDay.js'
import { docKey, parseDocKey, type DocKey } from './workspace/documents.js'
import type { KanbanCard } from './KanbanTypes.js'

/** A sent file resolved to the host that holds its bytes. */
export interface FiberSend {
  key: DocKey
  fullPath: string
  basename: string
  timestamp: number
  owner: string
}

/** How far back a sent file still counts. */
const SEND_WINDOW_MS = 30 * DAY_MS
/** The least time between two fleet reads. */
export const SEND_REFRESH_MS = 60_000

/** Each fiber's files, newest first, a re-send at its latest time. */
export function sendsByFiber(files: readonly SentFile[]): Map<string, SentFile[]> {
  const latest = new Map<string, SentFile>()
  for (const file of files) {
    if (!file.uid || file.uid === file.sessionId) continue
    const identity = `${file.uid}\u0000${file.host ?? ''}\u0000${file.fullPath}`
    const prior = latest.get(identity)
    if (!prior || file.timestamp > prior.timestamp) latest.set(identity, file)
  }
  const out = new Map<string, SentFile[]>()
  for (const file of latest.values()) {
    const list = out.get(file.uid!)
    if (list) list.push(file)
    else out.set(file.uid!, [file])
  }
  for (const list of out.values()) list.sort((a, b) => b.timestamp - a.timestamp || a.fullPath.localeCompare(b.fullPath))
  return out
}

export class FiberSends {
  private byFiber = new Map<string, SentFile[]>()
  private readAt = -Infinity
  private inflight: Promise<void> | null = null

  private readonly base: string
  private readonly onChange: () => void
  private readonly window: number
  /** `window` is how far back a read reaches. */
  constructor(base: string, onChange: () => void, window = SEND_WINDOW_MS) { this.base = base; this.onChange = onChange; this.window = window }

  private of(card: KanbanCard): SentFile[] {
    return (card.uid ? this.byFiber.get(card.uid) : undefined) ?? this.byFiber.get(card.id) ?? []
  }
  /** This fiber's sent files, newest first. */
  sends(card: KanbanCard): FiberSend[] {
    return this.of(card).flatMap(file => resolve(card, file) ?? [])
  }

  /** Read once per minute; failed reads retain the last answer and retry next poll. */
  refresh(nowMs = Date.now()): Promise<void> {
    if (this.inflight) return this.inflight
    if (nowMs - this.readAt < SEND_REFRESH_MS) return Promise.resolve()
    this.readAt = nowMs
    this.inflight = Promise.resolve().then(async () => {
      try {
        const since = Math.max(0, Math.floor(nowMs - this.window))
        const res = await fetch(`${this.base}/api/v1/sent-files/all/composite?since_ms=${since}`, { cache: 'no-store' })
        if (!res.ok) throw new Error('Sent-files feed unavailable')
        const raw = await res.json()
        if (!raw || !Array.isArray(raw.files)) throw new Error('Invalid sent-files feed')
        const next = sendsByFiber(normalizeSentFiles(raw))
        if (!sameSends(this.byFiber, next)) {
          this.byFiber = next
          this.onChange()
        }
      } catch {
        this.readAt = -Infinity
      } finally {
        this.inflight = null
      }
    })
    return this.inflight
  }
}

function resolve(card: KanbanCard, file: SentFile): FiberSend | undefined {
  const key = docKey(file.host ?? '', file.fullPath, card.originId, card.fiberDir)
  const parsed = parseDocKey(key)
  if (!parsed) return undefined
  return { key, fullPath: file.fullPath, basename: file.basename, timestamp: file.timestamp, owner: parsed.owner }
}

function sameSends(a: Map<string, SentFile[]>, b: Map<string, SentFile[]>): boolean {
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
