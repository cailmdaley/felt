import { getDaemonJson, postDaemonJson } from './daemonApi.js'

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

/**
 * The line a fiber waits on the human with: its record's id and time, and,
 * once its family's records hold it, its kind (`post`, `asked` or `closed`),
 * its words and the files it attached.
 */
export interface Wait { id: string; at: number; kind?: string; text?: string; files?: string[] }

/** When a record reached this daemon: its arrival, for a remote one, else its time. */
export const arrived = (record: BoardRecord): number => record.received_at ?? record.timestamp

/** One family's records, read a window at a time; `failed` while its last read did not answer. */
interface Family { records: Map<string, BoardRecord>; cursor: number; pending: boolean; failed: boolean }

/** A family's slot, empty, reaching back over the board's reach. */
const fresh = (reachMs: number): Family => ({ records: new Map(), cursor: Date.now() - reachMs + OVERLAP_MS, pending: false, failed: false })

/** Each read of a family asks again for this much before the newest record it holds, so a record written late is not missed. */
const OVERLAP_MS = 60_000

/**
 * The family board's records, by family (each named by its top-level's uid),
 * over the board's reach, and what waits on the human across the whole board:
 * what the Desk, Channels and a constitution's view read of what a family
 * said. `read` asks each family for what arrived since the newest record it
 * holds; `readBoard` asks once for every family's at once (what Find searches
 * across the board). Every answer also says, for the whole board, each fiber's line to the
 * human that nothing has handled (a post, a question or a close). `clear`
 * handles a line by hand. A listener hears a family whose records changed, or
 * a change in what waits.
 */
export class BoardFeed {
  /** How far back the board keeps records, as the daemon last said. */
  reachMs = 14 * 86_400_000
  private readonly families = new Map<string, Family>()
  /** Every family's records together, as `readBoard` reads them. */
  private board: Family | null = null
  /** The line each fiber addressed to the human and they have not handled, over the board's whole reach, as the newest read said. */
  private lines = new Map<string, Wait>()
  /** Each fiber's line the human cleared here, by its time: it stays handled whatever a read already under way says. */
  private readonly cleared = new Map<string, number>()
  /** Each fiber's newest undone clear written here: a clear after it must reach past it, or the undo voids it too. */
  private readonly undone = new Map<string, number>()
  /** `lines`, less what was cleared here, each with its record once a family holds it. */
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
  /** Every family's records, as the last `readBoard` left them. */
  boardRecords(): BoardRecord[] { return [...this.board?.records.values() ?? []] }
  /** Each fiber whose line to the human waits on them, by uid. */
  get waiting(): ReadonlyMap<string, Wait> { return this.waits }
  /** Whether a family's last read did not answer. */
  failed(uid: string): boolean { return !!this.families.get(uid)?.failed }

  /** A record some family holds. */
  private record(id: string): BoardRecord | undefined {
    for (const family of [...this.families.values(), ...this.board ? [this.board] : []]) {
      const record = family.records.get(id)
      if (record) return record
    }
    return undefined
  }
  /** Draws `waits` again from the lines and the records; says whether what waits changed. */
  private settle(): boolean {
    const waits = new Map<string, Wait>()
    for (const [uid, line] of this.lines) {
      if ((this.cleared.get(uid) ?? -Infinity) >= line.at) continue
      const record = this.record(line.id)
      waits.set(uid, record ? { ...line, kind: record.kind, text: record.text, files: record.files } : line)
    }
    const changed = waits.size !== this.waits.size || [...waits].some(([uid, wait]) => this.waits.get(uid)?.id !== wait.id || this.waits.get(uid)?.kind !== wait.kind)
    this.waits = waits
    return changed
  }

  /**
   * The human handles a fiber's line by hand: it stops waiting here at once,
   * and the daemon is told (a `clear:<uid>:<ms>` dismissal at the line's time,
   * which handles that line and no later one). Answers the time it cleared to,
   * which {@link unclear} takes back. A refused write waits again, and throws.
   */
  async clear(uid: string): Promise<number | undefined> {
    const line = this.waits.get(uid)
    if (!line) return undefined
    const at = Math.max(line.at, (this.undone.get(uid) ?? -1) + 1)
    const before = this.cleared.get(uid)
    this.cleared.set(uid, at)
    this.settle()
    this.changed()
    try {
      await postDaemonJson(this.base, '/api/v1/channels/dismiss', { key: `clear:${uid}:${at}`, fiber: uid }, 'Clear failed')
    } catch (error) {
      if (before === undefined) this.cleared.delete(uid)
      else this.cleared.set(uid, before)
      this.settle()
      this.changed()
      throw error
    }
    return at
  }

  /**
   * Takes back a clear made here (its time, as {@link clear} answered): the
   * line waits again at once, and the daemon is told (an `unclear:<uid>:<ms>`
   * dismissal, which voids every clear up to it). A refused write stays
   * cleared, and throws.
   */
  async unclear(uid: string, at: number): Promise<void> {
    if (this.cleared.get(uid) !== at) return
    this.cleared.delete(uid)
    this.settle()
    this.changed()
    try {
      await postDaemonJson(this.base, '/api/v1/channels/dismiss', { key: `unclear:${uid}:${at}`, fiber: uid }, 'Undo failed')
      this.undone.set(uid, at)
    } catch (error) {
      this.cleared.set(uid, at)
      this.settle()
      this.changed()
      throw error
    }
  }

  read(uids: Iterable<string>): void {
    for (const uid of new Set(uids)) {
      const family = this.families.get(uid) ?? this.families.set(uid, fresh(this.reachMs)).get(uid)!
      this.pull(family, `fiber=${encodeURIComponent(uid)}`)
    }
  }

  /** Every family's records in one read (`all=true`), from the newest the board slot holds. */
  readBoard(): void {
    this.pull(this.board ??= fresh(this.reachMs), 'all=true')
  }

  /** Reads what arrived for `family` since the newest record it holds, `which` naming it to the daemon. */
  private pull(family: Family, which: string): void {
    if (family.pending) return
    family.pending = true
    void getDaemonJson<{ family?: unknown; records?: BoardRecord[]; reach_ms?: number; waiting?: Record<string, Wait> }>(`${this.base}/api/v1/board/family?${which}&since_ms=${family.cursor - OVERLAP_MS}`).then(body => {
      if (typeof body.reach_ms === 'number') this.reachMs = body.reach_ms
      const failed = family.failed, reach = Date.now() - this.reachMs
      let moved = false
      // Every read the daemon resolves answers for the whole board, so the newest such answer stands; a family it could not resolve says nothing of the rest. The whole board's read always resolves.
      if (body.family != null || family === this.board) this.lines = new Map(Object.entries(body.waiting ?? {}))
      family.failed = false
      for (const record of body.records ?? []) {
        moved ||= !family.records.has(record.id)
        family.records.set(record.id, record)
        family.cursor = Math.max(family.cursor, arrived(record))
      }
      // What fell out of the board's reach leaves with it.
      for (const [id, record] of family.records) if (arrived(record) < reach) { family.records.delete(id); moved = true }
      if (this.settle() || moved || failed) this.changed()
    }, () => {
      if (family.failed) return
      family.failed = true
      this.changed()
    }).finally(() => { family.pending = false })
  }
}
