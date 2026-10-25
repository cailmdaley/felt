import { hasLiveWorker, type KanbanCard } from '../KanbanTypes.js'
import { threadState } from '../threads.js'

/** Presentation groups shared by the rail and the phone sheet. */
export const THREAD_GROUPS = [
  ['waiting', 'Waiting'], ['to-review', 'To review'], ['working', 'Working'], ['armed', 'Armed'],
  ['drafts', 'Drafts'], ['resting', 'Resting'], ['archived', 'Archived'],
] as const
export function threadGroup(card: KanbanCard): string {
  const state = threadState(card)
  if (state === 'working' && !hasLiveWorker(card)) return 'armed'
  return state === 'roles' ? 'resting' : state
}
