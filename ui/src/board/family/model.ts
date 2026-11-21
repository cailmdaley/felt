import type { KanbanCard } from '../KanbanTypes.js'

export interface ThreadMarks { launches: number[]; commits: number[] }
export interface MapFile { key: string; name: string; at: number; unread: boolean; caption?: string }
/** The facts about a thread that do not live on its card. */
export interface MapFeeds {
  marks(card: KanbanCard): ThreadMarks | undefined
  /** How far back the marks reach, in ms: archived work moved within it stays on the map. */
  reach(): number
  /** The thread's sent files, newest first. */
  files(card: KanbanCard): MapFile[]
}
