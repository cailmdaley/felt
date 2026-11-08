/**
 * The fleet's sent files over the last thirty days, from one throttled read of
 * the sent-files composite. The Desk's report marks, the Board's contact sheet
 * and the family map all draw from this one store; none reads the feed itself.
 */
import { normalizeSentFiles, type SentFile } from './sentFiles.js'
import { DAY_MS } from './civilDay.js'
import { docKey, parseDocKey, type DocKey } from './workspace/documents.js'
import { readComposite, windowStart } from './daemonApi.js'
import { ThrottledRead } from './throttledRead.js'
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
export const SEND_WINDOW_MS = 30 * DAY_MS
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
  /** Every sent file the window's read returned, in the feed's order. */
  files: readonly SentFile[] = []
  /** The hosts the feed's origins block names, as of the last read that named any. */
  hosts: readonly string[] = []
  /** Whether the last read failed; `files` is then the last good answer. */
  failed = false
  private byFiber = new Map<string, SentFile[]>()
  private readonly listeners = new Set<() => void>()
  private readonly reader: ThrottledRead
  private readonly base: string
  private readonly window: number

  /** `window` is how far back a read reaches; `intervalMs` the least time between reads. */
  constructor(base: string, opts: { window?: number; intervalMs?: number } = {}) {
    this.base = base
    this.window = opts.window ?? SEND_WINDOW_MS
    this.reader = new ThrottledRead(opts.intervalMs ?? SEND_REFRESH_MS, () => this.read())
  }

  /** Call `listener` whenever the files or the read's health change; returns its removal. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private of(card: KanbanCard): SentFile[] {
    return (card.uid ? this.byFiber.get(card.uid) : undefined) ?? this.byFiber.get(card.id) ?? []
  }
  /** This fiber's sent files, newest first. */
  sends(card: KanbanCard): FiberSend[] {
    return this.of(card).flatMap(file => resolve(card, file) ?? [])
  }

  /** Read at most once per interval; a failed read keeps the last answer and retries at the next ask. */
  refresh(nowMs = Date.now()): Promise<void> {
    return this.reader.run(false, nowMs)
  }

  private async read(): Promise<void> {
    try {
      const raw = await readComposite(this.base, 'sent-files/all', { since_ms: windowStart(Date.now(), this.window) })
      if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { files?: unknown }).files)) throw new Error('Invalid sent-files feed')
      const files = normalizeSentFiles(raw).filter(file => Number.isFinite(file.timestamp) && file.timestamp > 0)
      const origins = (raw as { origins?: unknown }).origins
      const hosts = origins && typeof origins === 'object' && !Array.isArray(origins) ? Object.keys(origins) : []
      const moved = this.failed || !sameFiles(this.files, files) || (hosts.length > 0 && hosts.join('\n') !== this.hosts.join('\n'))
      this.failed = false
      if (!moved) return
      this.files = files
      if (hosts.length) this.hosts = hosts
      this.byFiber = sendsByFiber(files)
      this.notify()
    } catch (error) {
      if (!this.failed) { this.failed = true; this.notify() }
      throw error
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

function resolve(card: KanbanCard, file: SentFile): FiberSend | undefined {
  const key = docKey(file.host ?? '', file.fullPath, card.originId, card.fiberDir)
  const parsed = parseDocKey(key)
  if (!parsed) return undefined
  return { key, fullPath: file.fullPath, basename: file.basename, timestamp: file.timestamp, owner: parsed.owner }
}

function sameFiles(a: readonly SentFile[], b: readonly SentFile[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i]
    if (x.fullPath !== y.fullPath || x.timestamp !== y.timestamp || x.host !== y.host || x.uid !== y.uid || x.sessionId !== y.sessionId) return false
  }
  return true
}
