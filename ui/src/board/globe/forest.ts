/** The board's cards as the forest `assign` places: projects, families and threads, by persistent id. */
import type { KanbanCard } from '../KanbanTypes.js'
import { ATTENTION, familyModel, type MapFeeds, type MapThread } from '../family/model.js'
import { threadKey, type ThreadIndex } from '../threads.js'
import type { Band, FamilySeed, ProjectSeed, ThreadSeed } from './assign.js'

export interface Forest {
  projects: ProjectSeed[]
  /** Every thread, by its persistent id. */
  threads: Map<string, MapThread>
  /** Asking threads, most urgent first. */
  asks: MapThread[]
  /** Archived threads, by persistent id. */
  settled: Set<string>
}

export const persistentId = (card: KanbanCard): string => card.uid ?? threadKey(card)
export const projectOf = (card: KanbanCard): string => card.id.split('/')[0]
/** The second segment of an id with a third: a family's place within its project, when its path names one. */
const areaOf = (card: KanbanCard): string | undefined => { const parts = card.id.split('/'); return parts.length > 2 ? parts[1] : undefined }

const inFlight = (thread: MapThread): boolean => thread.standing === 'still' || (ATTENTION as readonly string[]).includes(thread.standing)
const isSettled = (thread: MapThread, index: ThreadIndex): boolean => index.state(thread.card) === 'archived'

function bandOf(all: readonly MapThread[], index: ThreadIndex): Band {
  if (all.some(inFlight)) return 'flying'
  return all.every(thread => isSettled(thread, index)) ? 'settled' : 'resting'
}

export function forestOf(index: ThreadIndex, cards: readonly KanbanCard[], feeds: MapFeeds, now: number): Forest {
  const threads = new Map<string, MapThread>(), byProject = new Map<string, { name: string; families: FamilySeed[] }>()
  const seen = new Set<string>(), asks: MapThread[] = [], settled = new Set<string>()
  for (const card of cards) {
    const root = index.card(card)
    if (card.isCycle || index.parentOf(root) || seen.has(persistentId(root))) continue
    seen.add(persistentId(root))
    const model = familyModel(index, root, root, feeds, now)
    const seed = (thread: MapThread): ThreadSeed => {
      threads.set(persistentId(thread.card), thread)
      if (isSettled(thread, index)) settled.add(persistentId(thread.card))
      const kids = thread.children.map(key => seed(model.threads.get(key)!))
      return { key: persistentId(thread.card), weight: thread.weight, born: thread.born, live: !isSettled(thread, index) || kids.some(kid => kid.live), kids, files: thread.files.map(file => file.key) }
    }
    const name = projectOf(root)
    const project = byProject.get(name) ?? { name, families: [] }
    byProject.set(name, project)
    project.families.push({ band: bandOf([...model.threads.values()], index), root: seed(model.root), area: areaOf(root) })
    asks.push(...model.attention.filter(thread => thread.standing !== 'working'))
  }
  const urgency = (thread: MapThread): number => (ATTENTION as readonly string[]).indexOf(thread.standing)
  asks.sort((a, b) => urgency(a) - urgency(b) || b.lastMove - a.lastMove)
  return { projects: [...byProject.values()], threads, asks, settled }
}

