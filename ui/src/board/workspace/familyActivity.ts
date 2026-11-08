import { MAP_WINDOW_MS, type ThreadMarks } from '../family/model.js'
import { readComposite, windowStart } from '../daemonApi.js'
import { ThrottledRead } from '../throttledRead.js'

const REFRESH_MS = 120_000
/** Resumes this close together in this number are the daemon coming back, not work. */
const BURST_MS = 120_000, BURST_SIZE = 3

export interface SessionMark { uid?: string; kind?: string; at: number; session?: string; tmux?: string }
export interface CommitMark { at: number; session?: string; tmux?: string }

/**
 * Each thread's launches and commits. A burst of resumes is a daemon restart
 * reopening its workers, so it marks nothing; commits join their thread by
 * session, else by terminal name.
 */
export function threadMarks(sessions: readonly SessionMark[], commits: readonly CommitMark[]): Map<string, ThreadMarks> {
  const bursts = new Map<number, number>()
  const bucket = (at: number): number => Math.floor(at / BURST_MS)
  for (const row of sessions) if (row.kind === 'resume') bursts.set(bucket(row.at), (bursts.get(bucket(row.at)) ?? 0) + 1)
  const marks = new Map<string, ThreadMarks>(), owners = new Map<string, string>()
  const of = (uid: string): ThreadMarks => {
    let row = marks.get(uid)
    if (!row) marks.set(uid, row = { launches: [], commits: [] })
    return row
  }
  for (const row of sessions) {
    if (!row.uid) continue
    if (row.session) owners.set(row.session, row.uid)
    if (row.tmux) owners.set(row.tmux, row.uid)
    if (row.kind !== 'resume' || (bursts.get(bucket(row.at)) ?? 0) < BURST_SIZE) of(row.uid).launches.push(row.at)
  }
  for (const row of commits) {
    const uid = (row.session ? owners.get(row.session) : undefined) ?? (row.tmux ? owners.get(row.tmux) : undefined)
    if (uid) of(uid).commits.push(row.at)
  }
  return marks
}

/** The fleet's recent launches and commits, read only while a family's view asks. */
export class FamilyActivity {
  private marks = new Map<string, ThreadMarks>()
  private readonly base: string
  private readonly onChange: () => void
  private readonly reader = new ThrottledRead(REFRESH_MS, () => this.read())
  constructor(base: string, onChange: () => void) { this.base = base; this.onChange = onChange }
  of(uid: string): ThreadMarks | undefined { return this.marks.get(uid) }
  refresh(now = Date.now()): void { void this.reader.run(false, now) }
  private async read(): Promise<void> {
    const query = { since_ms: windowStart(Date.now(), MAP_WINDOW_MS) }
    const records = async (feed: 'sessions' | 'commits'): Promise<never[]> => {
      const { records } = await readComposite(this.base, feed, query) as { records?: unknown }
      if (!Array.isArray(records)) throw new Error(`${feed} feed malformed`)
      return records as never[]
    }
    const [sessions, commits] = await Promise.all([records('sessions'), records('commits')])
    this.marks = threadMarks(sessions, commits)
    this.onChange()
  }
}
