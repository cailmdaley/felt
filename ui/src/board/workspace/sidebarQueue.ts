import { buildDependents, foldHeadId, queuedBehind, type FoldNode } from '../KanbanRules.js'
import { FOLDABLE_HEAD_COLUMNS } from '../KanbanReadModel.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { fiberPageColumn } from './fiberPageState.js'

/** Resolve the reader's full collection with Desk's dependency and fold semantics. */
export function sidebarQueue(cards: readonly KanbanCard[]) {
  const byId = new Map<string, KanbanCard>()
  for (const card of cards) {
    byId.set(card.id, card)
    if (card.uid) byId.set(card.uid.toLowerCase(), card)
  }
  const resolve = (id: string): KanbanCard | undefined => byId.get(id) ?? byId.get(id.toLowerCase())
  const nodes = new Map<string, FoldNode>()
  for (const card of cards) {
    const column = fiberPageColumn(card)
    nodes.set(card.id, {
      id: card.id,
      dependsOn: (card.dependsOn?.length ? card.dependsOn : card.foldedUnder ? [card.foldedUnder] : []).map(id => resolve(id)?.id ?? id),
      foldable: column === 'resting' || FOLDABLE_HEAD_COLUMNS.has(column),
    })
  }
  const dependents = buildDependents([...nodes.values()])
  const head = (card: KanbanCard): string | undefined => {
    if (card.foldedUnder) return resolve(card.foldedUnder)?.id ?? card.foldedUnder
    const node = nodes.get(card.id)
    return node && foldHeadId(node, id => nodes.get(id))
  }
  return {
    head,
    folded: (card: KanbanCard): boolean => head(card) !== undefined,
    members(card: KanbanCard): KanbanCard[] {
      return queuedBehind(card.id, dependents).flatMap(id => {
        const member = resolve(id)
        return member ? [member] : []
      })
    },
  }
}
