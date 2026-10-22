import { hasLiveWorker, type KanbanCard, type KanbanResponse } from './KanbanTypes.js'
import { leftQueues } from './KanbanRules.js'
import { turnOf } from './turn.js'

export type ThreadState = 'waiting-cail' | 'to-review' | 'working' | 'drafts' | 'resting' | 'archived'
export type ThreadSummary = NonNullable<KanbanCard['threadSummary']>
export const THREAD_LABEL: Record<ThreadState, string> = {
  'waiting-cail': 'Waiting', 'to-review': 'To review', working: 'Working', drafts: 'Drafts', resting: 'Resting', archived: 'Archived',
}
const STATE_ORDER: readonly ThreadState[] = ['waiting-cail', 'to-review', 'working', 'drafts', 'resting', 'archived']
/**
 * A thread's state, read the way the Desk reads a card: a verdict archives,
 * a close awaits review, and a live worker puts the card In flight whatever
 * its status (as `classifyFiber` does), where `turnOf` decides Waiting from
 * Working. Only an open constitution with no live worker is a draft, or
 * resting when put down.
 */
export function threadState(card: KanbanCard): ThreadState {
  if (leftQueues(card)) return 'archived'
  if (card.status === 'closed') return 'to-review'
  const live = hasLiveWorker(card)
  if (card.status === 'open' && !live) return card.effectiveHorizon === 'stashed' ? 'resting' : 'drafts'
  if (turnOf(card).yours) return 'waiting-cail'
  if (live && !card.originStale) return 'working'
  return 'resting'
}
/**
 * The Desk column a family's most urgent thread asks for; undefined when
 * nothing in it is work. Drafts are ideas, not work: they count on the badge
 * but never pull a root onto the Desk.
 */
export function familyColumn(summary: KanbanCard['threadSummary']): 'inFlight' | 'awaitingReview' | undefined {
  if (!summary) return undefined
  if (summary.waitingOnCail || summary.working) return 'inFlight'
  if (summary.toReview) return 'awaitingReview'
  return undefined
}

/** A thread's identity: a wire edge names a path, and the same path can live on several hosts. */
export const threadKey = (card: Pick<KanbanCard, 'originId' | 'feltStore' | 'id'>): string =>
  `${card.originId}\u0000${card.feltStore ?? ''}\u0000${card.id}`
const EMPTY: ThreadSummary = Object.freeze({ unfinished: 0, waitingOnCail: 0, working: 0, toReview: 0, drafts: 0, archived: 0 })
let builds = 0
/** How many indexes have been built in this page — the scale tests' witness that nothing rebuilds per card. */
export function threadIndexBuilds(): number { return builds }

/**
 * The containment forest of one board response, built once: each card's
 * resolved orchestrator, its children in feed order, its state, and its
 * descendants' counts, summed bottom-up. Every thread surface reads this
 * rather than re-deriving the graph.
 */
export class ThreadIndex {
  private readonly cards = new Map<string, KanbanCard>()
  private readonly parents = new Map<string, KanbanCard>()
  private readonly kids = new Map<string, KanbanCard[]>()
  private readonly states = new Map<string, ThreadState>()
  private readonly sums = new Map<string, ThreadSummary>()

  constructor(cards: readonly KanbanCard[]) {
    builds++
    const byId = new Map<string, KanbanCard[]>()
    for (const card of cards) {
      const key = threadKey(card)
      if (this.cards.has(key)) continue
      this.cards.set(key, card)
      this.states.set(key, threadState(card))
      if (!card.isCycle) byId.set(card.id, [...(byId.get(card.id) ?? []), card])
    }
    // Same-store matches win; an ambiguous foreign path is never guessed.
    for (const [key, card] of this.cards) {
      if (!card.orchestrator) continue
      const candidates = byId.get(card.orchestrator) ?? []
      const owner = candidates.find(c => c.originId === card.originId && c.feltStore === card.feltStore)
        ?? (candidates.length === 1 ? candidates[0] : undefined)
      if (owner && owner !== card) this.parents.set(key, owner)
    }
    this.breakCycles()
    for (const [key, owner] of this.parents) {
      const ownerKey = threadKey(owner)
      const list = this.kids.get(ownerKey)
      if (list) list.push(this.cards.get(key)!)
      else this.kids.set(ownerKey, [this.cards.get(key)!])
    }
    this.summarize()
  }

  /** A malformed feed can name a loop; the edge that closes it is dropped, so every walk ends. */
  private breakCycles(): void {
    const done = new Set<string>()
    for (const start of this.cards.keys()) {
      const path = new Set<string>()
      let key: string | undefined = start
      while (key !== undefined && !done.has(key) && !path.has(key)) {
        path.add(key)
        const owner = this.parents.get(key)
        const next = owner ? threadKey(owner) : undefined
        if (next !== undefined && path.has(next)) { this.parents.delete(key); break }
        key = next
      }
      for (const visited of path) done.add(visited)
    }
  }

  /** Pre-order from the roots, then reversed: every child is summed before its parent. */
  private summarize(): void {
    const order: string[] = []
    const pending = [...this.cards.keys()].filter(key => !this.parents.has(key))
    while (pending.length) {
      const key = pending.pop()!
      order.push(key)
      for (const child of this.kids.get(key) ?? []) pending.push(threadKey(child))
    }
    for (let n = order.length - 1; n >= 0; n--) {
      const key = order[n]
      const children = this.kids.get(key)
      if (!children) continue
      const sum = { ...EMPTY }
      for (const child of children) {
        const childKey = threadKey(child), below = this.sums.get(childKey) ?? EMPTY
        sum.unfinished += below.unfinished; sum.waitingOnCail += below.waitingOnCail; sum.working += below.working
        sum.toReview += below.toReview; sum.drafts += below.drafts; sum.archived += below.archived
        const state = this.states.get(childKey)!
        if (state === 'archived') sum.archived++
        else {
          sum.unfinished++
          if (state === 'waiting-cail') sum.waitingOnCail++
          else if (state === 'working') sum.working++
          else if (state === 'to-review') sum.toReview++
          else if (state === 'drafts') sum.drafts++
        }
      }
      this.sums.set(key, sum)
    }
  }

  /** The index's own copy of a card, which may be fresher than a caller's. */
  card(card: KanbanCard): KanbanCard { return this.cards.get(threadKey(card)) ?? card }
  parentOf(card: KanbanCard): KanbanCard | undefined { return this.parents.get(threadKey(card)) }
  /** A thread whose orchestrator is named but not on the board. */
  isOrphan(card: KanbanCard): boolean { return !!card.orchestrator && !this.parents.has(threadKey(card)) }
  /** Direct threads, in feed order. */
  children(card: KanbanCard): readonly KanbanCard[] { return this.kids.get(threadKey(card)) ?? [] }
  /** Every descendant, in tree order. */
  subtree(card: KanbanCard): KanbanCard[] {
    const result: KanbanCard[] = []
    const pending = [...this.children(card)].reverse()
    while (pending.length) {
      const next = pending.pop()!
      result.push(next)
      const below = this.kids.get(threadKey(next))
      if (below) for (let n = below.length - 1; n >= 0; n--) pending.push(below[n])
    }
    return result
  }
  summary(card: KanbanCard): ThreadSummary { return this.sums.get(threadKey(card)) ?? EMPTY }
  /** Descendants, archived included. */
  size(card: KanbanCard): number { const s = this.summary(card); return s.unfinished + s.archived }
  state(card: KanbanCard): ThreadState { return this.states.get(threadKey(card)) ?? threadState(card) }
  /** Waiting first, then review, work, drafts, rest, archive; then name. */
  readonly compare = (a: KanbanCard, b: KanbanCard): number =>
    STATE_ORDER.indexOf(this.state(a)) - STATE_ORDER.indexOf(this.state(b)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
}

const indexes = new WeakMap<KanbanResponse, ThreadIndex>()
/** The index a response was built with, or one built now from `cards` and kept for that response. */
export function responseThreadIndex(resp: KanbanResponse, cards: () => readonly KanbanCard[]): ThreadIndex {
  let index = indexes.get(resp)
  if (!index) { index = new ThreadIndex(cards()); indexes.set(resp, index) }
  return index
}
export function adoptThreadIndex(resp: KanbanResponse, index: ThreadIndex): void { indexes.set(resp, index) }
