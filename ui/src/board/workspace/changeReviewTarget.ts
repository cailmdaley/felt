import { hasLiveWorker, type KanbanCard } from '../KanbanTypes.js'
import { normalizeAbsolutePath, type WorkspaceDocument } from './documents.js'

type ReviewCard = Pick<KanbanCard, 'id' | 'originId' | 'fiberDir' | 'workerState'>
/** A link's channel does not own its target file or its review conversation. */
export function changeReviewTarget<T extends ReviewCard>(source: Pick<WorkspaceDocument, 'owner' | 'path'>, cards: T[]) {
  const path = normalizeAbsolutePath(source.path), directory = path.slice(0, path.lastIndexOf('/')) || '/'
  const card = cards.find(card => card.originId === source.owner && card.fiberDir && normalizeAbsolutePath(card.fiberDir) === directory)
  return card ? { card, label: `${card.id} on ${card.originId}`, live: hasLiveWorker(card) } : undefined
}
