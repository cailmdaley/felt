import type { ThreadMarks } from '../family/model.js'
import { getDaemonJson } from '../daemonApi.js'
import { ThrottledRead } from '../throttledRead.js'

const REFRESH_MS = 120_000

/**
 * Each thread's launches and commits over the board's reach, as the daemon
 * joins them (`GET /api/v1/board/marks`), read only while a family's view asks.
 * Until the first answer the reach is zero: nothing is known to lie within it.
 */
export class FamilyActivity {
  private marks = new Map<string, ThreadMarks>()
  private reachMs = 0
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
