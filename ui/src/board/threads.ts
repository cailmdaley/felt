import { hasLiveWorker, type KanbanCard } from './KanbanTypes.js'
import { leftQueues } from './KanbanRules.js'
import { turnOf } from './turn.js'

export type ThreadState = 'waiting-cail' | 'waiting' | 'working' | 'resting' | 'archived'
export const THREAD_LABEL: Record<ThreadState, string> = {
  'waiting-cail': 'Waiting on Cail', waiting: 'Waiting', working: 'Working', resting: 'Resting', archived: 'Archived',
}
export function threadState(card: KanbanCard): ThreadState {
  if (leftQueues(card)) return 'archived'
  if (card.status === 'closed' || turnOf(card).yours) return 'waiting-cail'
  if (card.held || card.dependsOn?.length) return 'waiting'
  if (hasLiveWorker(card) || (card.status === 'active' && card.shuttleKind !== 'standing')) return 'working'
  return 'resting'
}
export function compareThreads(a: KanbanCard, b: KanbanCard): number {
  const order: ThreadState[] = ['waiting-cail', 'waiting', 'working', 'resting', 'archived']
  return order.indexOf(threadState(a)) - order.indexOf(threadState(b)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
}
/** A wire edge names a path, not a machine: threads can run on another host.
 * Same-store matches win; an ambiguous foreign path is never guessed. */
export function orchestratorOf(card: KanbanCard, cards: readonly KanbanCard[]): KanbanCard | undefined {
  if (!card.orchestrator) return undefined
  const candidates = cards.filter(c => c.id === card.orchestrator && !c.isCycle)
  return candidates.find(c => c.originId === card.originId && c.feltStore === card.feltStore)
    ?? (candidates.length === 1 ? candidates[0] : undefined)
}
export function threadChildren(parent: KanbanCard, cards: readonly KanbanCard[]): KanbanCard[] {
  return cards.filter(c => orchestratorOf(c, cards) === parent).sort(compareThreads)
}
/** Iterative traversal keeps deep trees finite, including malformed cyclic feeds. */
export function threadSubtree(parent: KanbanCard, cards: readonly KanbanCard[]): KanbanCard[] {
  const children = new Map<KanbanCard, KanbanCard[]>()
  for (const card of cards) {
    const owner = orchestratorOf(card, cards)
    if (owner) children.set(owner, [...(children.get(owner) ?? []), card])
  }
  const seen = new Set<KanbanCard>([parent]), result: KanbanCard[] = []
  const pending = [...(children.get(parent) ?? [])]
  while (pending.length) {
    const card = pending.pop()!
    if (seen.has(card)) continue
    seen.add(card); result.push(card)
    pending.push(...(children.get(card) ?? []))
  }
  return result.sort(compareThreads)
}
export function threadSummary(parent: KanbanCard, cards: readonly KanbanCard[]): NonNullable<KanbanCard['threadSummary']> {
  const descendants = threadSubtree(parent, cards)
  const archived = descendants.filter(c => threadState(c) === 'archived').length
  return { unfinished: descendants.length - archived, waitingOnCail: descendants.filter(c => threadState(c) === 'waiting-cail').length, archived }
}
