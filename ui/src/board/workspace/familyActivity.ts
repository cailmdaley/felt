import type { ThreadMarks } from '../family/model.js'
import { getDaemonJson } from '../daemonApi.js'
import { ThrottledRead } from '../throttledRead.js'

const REFRESH_MS = 120_000
const DEFAULT_REACH_MS = 14 * 86_400_000

/**
 * Each thread's launches and commits over the board's reach, as the daemon
 * joins them (`GET /api/v1/board/marks`), read only while a family's view asks.
 * Until the first answer the reach is the daemon's default retention
 * (`Shuttle.Board.retention_ms/0`), so recent archived work is drawn from the
 * first paint and through a failing read.
 */
export class FamilyActivity {
  private marks = new Map<string, ThreadMarks>()
  private reachMs = DEFAULT_REACH_MS
  private readonly base: string
  private readonly onChange: () => void
  private readonly reader = new ThrottledRead(REFRESH_MS, () => this.read())
  constructor(base: string, onChange: () => void) { this.base = base; this.onChange = onChange }
  of(uid: string): ThreadMarks | undefined { return this.marks.get(uid) }
  /** How far back the marks reach, in ms. */
  reach(): number { return this.reachMs }
  refresh(now = Date.now()): void { void this.reader.run(false, now) }
  private async read(): Promise<void> {
    const { marks, reach_ms: reach } = await getDaemonJson<{ marks?: unknown; reach_ms?: unknown }>(`${this.base}/api/v1/board/marks`, 'Thread marks unavailable', { cache: 'no-store' })
    if (typeof marks !== 'object' || marks === null || typeof reach !== 'number') throw new Error('Thread marks malformed')
    this.marks = new Map(Object.entries(marks as Record<string, ThreadMarks>))
    this.reachMs = reach
    this.onChange()
  }
}
