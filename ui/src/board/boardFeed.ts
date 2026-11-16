import { getDaemonJson } from './daemonApi.js'

/**
 * One family-board record as `GET /api/v1/board/family` serves it. `fiber` is
 * the record's subject; `by` and `to` are who spoke and who it was for.
 */
export interface BoardRecord {
  id: string
  kind: string
  timestamp: number
  /** A remote record's first arrival at this daemon. */
  received_at?: number
  fiber?: string
  by?: { fiber?: string; session?: string; label?: string }
  to?: { fiber?: string; session?: string; label?: string }
  text?: string
  verdict?: string
  /** Who the daemon says wrote it: a member's path, a label, or a session. */
  actor?: string
  /** The absolute paths a post attaches, each also a sent file. */
  files?: string[]
  originName?: string
}

/** The line a fiber waits on the human with: its record's id and time. */
export interface Wait { id: string; at: number }

/** When a record reached this daemon: its arrival, for a remote one, else its time. */
export const arrived = (record: BoardRecord): number => record.received_at ?? record.timestamp

/** One family's records, read a window at a time; `failed` while its last read did not answer. */
interface Family { records: Map<string, BoardRecord>; cursor: number; pending: boolean; failed: boolean }

/** Each read of a family asks again for this much before the newest record it holds, so a record written late is not missed. */
const OVERLAP_MS = 60_000
/** The lines that wait on the human: a question, or a close for their review. A post addressed to them is news, never a wait. */
const WAITS = new Set(['asked', 'closed'])

/**
 * The family board's records, by family (each named by its top-level's uid),
 * over the board's reach: what Channels and a constitution's view read of
 * what a family said. `read` asks each family for what arrived since the
 * newest record it holds; a listener hears a family whose records or whose
 * waits changed.
 */
export class BoardFeed {
  /** How far back the board keeps records, as the daemon last said. */
  reachMs = 14 * 86_400_000
  private readonly families = new Map<string, Family>()
  /** The line each fiber addressed to the human and they have not handled, over the board's whole reach, as the newest read said. */
  private lines = new Map<string, Wait>()
  /** Of those, each fiber's question or close, once its family's records hold it. */
  private waits = new Map<string, Wait>()
  private readonly base: string
  private readonly listeners = new Set<() => void>()
  constructor(base: string) { this.base = base }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private changed(): void { for (const listener of this.listeners) listener() }

  /** The records the families hold, a record two of them share once. */
  records(uids: Iterable<string>): BoardRecord[] {
    const all = new Map<string, BoardRecord>()
    for (const uid of uids) for (const record of this.families.get(uid)?.records.values() ?? []) all.set(record.id, record)
    return [...all.values()]
  }
  /** Each fiber whose question or close waits on the human, by uid. */
  get waiting(): ReadonlyMap<string, Wait> { return this.waits }
  /** Each fiber whose line to the human stands unhandled, a post included, by uid: whose family to read to learn whether it waits. */
  get unhandled(): ReadonlyMap<string, Wait> { return this.lines }
  /** Whether a family's last read did not answer. */
  failed(uid: string): boolean { return !!this.families.get(uid)?.failed }

  /** The kind of a record some family holds. */
  private kind(id: string): string | undefined {
    for (const family of this.families.values()) {
      const record = family.records.get(id)
      if (record) return record.kind
    }
    return undefined
  }

  read(uids: Iterable<string>): void {
    for (const uid of new Set(uids)) {
      const family = this.families.get(uid) ?? this.families.set(uid, { records: new Map(), cursor: Date.now() - this.reachMs + OVERLAP_MS, pending: false, failed: false }).get(uid)!
      if (family.pending) continue
      family.pending = true
      void getDaemonJson<{ records?: BoardRecord[]; reach_ms?: number; waiting?: Record<string, Wait> }>(`${this.base}/api/v1/board/family?fiber=${encodeURIComponent(uid)}&since_ms=${family.cursor - OVERLAP_MS}`).then(body => {
        if (typeof body.reach_ms === 'number') this.reachMs = body.reach_ms
        const failed = family.failed, reach = Date.now() - this.reachMs
        let moved = false
        // Every read answers for the whole board, so the newest answer stands.
        this.lines = new Map(Object.entries(body.waiting ?? {}))
        family.failed = false
        for (const record of body.records ?? []) {
          moved ||= !family.records.has(record.id)
          family.records.set(record.id, record)
          family.cursor = Math.max(family.cursor, arrived(record))
        }
        // What fell out of the board's reach leaves with it.
        for (const [id, record] of family.records) if (arrived(record) < reach) { family.records.delete(id); moved = true }
        const waits = new Map([...this.lines].filter(([, wait]) => WAITS.has(this.kind(wait.id) ?? '')))
        const waited = waits.size !== this.waits.size || [...waits].some(([uid, wait]) => this.waits.get(uid)?.id !== wait.id)
        this.waits = waits
        if (moved || failed || waited) this.changed()
      }, () => {
        if (family.failed) return
        family.failed = true
        this.changed()
      }).finally(() => { family.pending = false })
    }
  }
}
