import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { deskColumn } from './deskColumn.js'
import { turnOf } from './turn.js'

export type ThreadState = 'waiting' | 'to-review' | 'working' | 'drafts' | 'roles' | 'resting' | 'archived'
export type ThreadSummary = NonNullable<KanbanCard['threadSummary']>
export const THREAD_LABEL: Record<ThreadState, string> = {
  waiting: 'Waiting', 'to-review': 'To review', working: 'Working', drafts: 'Drafts', roles: 'Roles', resting: 'Resting', archived: 'Archived',
}
const STATE_ORDER: readonly ThreadState[] = ['waiting', 'to-review', 'working', 'drafts', 'roles', 'resting', 'archived']
/**
 * A thread's state: the Desk column it would sit in (`deskColumn`), with
 * In flight split by `turnOf` into Waiting (the human's move) and Working
 * (the worker's, including an armed thread whose worker has not started).
 * A verdict archives; a standing thread asleep on its cron rests; a seat at
 * rest is among the Roles. Every thread surface (rail, peek, sub-entries,
 * mention chips) reads this.
 */
export function threadState(card: KanbanCard): ThreadState {
  switch (deskColumn(card)) {
    case 'tempered': case 'composted': return 'archived'
    case 'awaitingReview': return 'to-review'
    case 'inFlight': return turnOf(card).yours ? 'waiting' : 'working'
    case 'drafts': return 'drafts'
    case 'roles': return 'roles'
    default: return 'resting'
  }
}
/**
 * The Desk column a family's most urgent thread asks for; undefined when
 * nothing in it is work. Drafts are ideas, not work: they count on the badge
 * but never pull a root onto the Desk.
 */
export function familyColumn(summary: KanbanCard['threadSummary']): 'inFlight' | 'awaitingReview' | undefined {
  if (!summary) return undefined
  if (summary.waiting || summary.working) return 'inFlight'
  if (summary.toReview) return 'awaitingReview'
  return undefined
}

/** A thread's identity: a wire edge names a path, and the same path can live on several hosts. */
export const threadKey = (card: Pick<KanbanCard, 'originId' | 'feltStore' | 'id'>): string =>
  `${card.originId}\u0000${card.feltStore ?? ''}\u0000${card.id}`
const EMPTY: ThreadSummary = Object.freeze({ unfinished: 0, waiting: 0, working: 0, toReview: 0, drafts: 0, archived: 0 })
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
  /** A fiber id is a ULID, one fiber on every host: each id's first copy stands for its others. */
  private readonly firstOf = new Map<string, string>()

  constructor(cards: readonly KanbanCard[]) {
    builds++
    const byId = new Map<string, KanbanCard[]>()
    for (const card of cards) {
      const key = threadKey(card)
      if (this.cards.has(key)) continue
      this.cards.set(key, card)
      if (!this.firstOf.has(card.id)) this.firstOf.set(card.id, key)
      if (!card.isCycle) byId.set(card.id, [...(byId.get(card.id) ?? []), card])
    }
    // The graph has one node per fiber, its first copy; every copy reads it.
    for (const key of new Set(this.firstOf.values())) this.states.set(key, threadState(this.cards.get(key)!))
    // Every candidate sharing an id is the same fiber, so a stamped thread always
    // resolves: the copy in its own store, else the copy served by its owning
    // host, else the first.
    for (const key of this.states.keys()) {
      const card = this.cards.get(key)!
      if (!card.orchestrator) continue
      const candidates = byId.get(card.orchestrator) ?? []
      const owner = candidates.find(c => c.originId === card.originId && c.feltStore === card.feltStore)
        ?? candidates.find(c => !!c.shuttleHost && c.originId === c.shuttleHost)
        ?? candidates[0]
      if (owner && owner.id !== card.id) this.parents.set(key, owner)
    }
    this.breakCycles()
    for (const [key, owner] of this.parents) {
      const ownerKey = this.key(owner)
      const list = this.kids.get(ownerKey)
      if (list) list.push(this.cards.get(key)!)
      else this.kids.set(ownerKey, [this.cards.get(key)!])
    }
    this.summarize()
  }

  /** A malformed feed can name a loop; the edge that closes it is dropped, so every walk ends. */
  private breakCycles(): void {
    const done = new Set<string>()
    for (const start of this.states.keys()) {
      const path = new Set<string>()
      let key: string | undefined = start
      while (key !== undefined && !done.has(key) && !path.has(key)) {
        path.add(key)
        const owner = this.parents.get(key)
        const next = owner ? this.key(owner) : undefined
        if (next !== undefined && path.has(next)) { this.parents.delete(key); break }
        key = next
      }
      for (const visited of path) done.add(visited)
    }
  }

  /** Pre-order from the roots, then reversed: every child is summed before its parent. */
  private summarize(): void {
    const order: string[] = []
    const pending = [...this.states.keys()].filter(key => !this.parents.has(key))
    while (pending.length) {
      const key = pending.pop()!
      order.push(key)
      for (const child of this.kids.get(key) ?? []) pending.push(this.key(child))
    }
    for (let n = order.length - 1; n >= 0; n--) {
      const key = order[n]
      const children = this.kids.get(key)
      if (!children) continue
      const sum = { ...EMPTY }
      for (const child of children) {
        const childKey = this.key(child), below = this.sums.get(childKey) ?? EMPTY
        sum.unfinished += below.unfinished; sum.waiting += below.waiting; sum.working += below.working
        sum.toReview += below.toReview; sum.drafts += below.drafts; sum.archived += below.archived
        const state = this.states.get(childKey)!
        if (state === 'archived') sum.archived++
        else {
          sum.unfinished++
          if (state === 'waiting') sum.waiting++
          else if (state === 'working') sum.working++
          else if (state === 'to-review') sum.toReview++
          else if (state === 'drafts') sum.drafts++
        }
      }
      this.sums.set(key, sum)
    }
  }

  /** The index's own copy of a card, which may be fresher than a caller's. */
  card(card: KanbanCard): KanbanCard { return this.cards.get(threadKey(card)) ?? this.cards.get(this.key(card)) ?? card }
  parentOf(card: KanbanCard): KanbanCard | undefined { return this.parents.get(this.key(card)) }
  /** The fiber's node, whichever host's copy asks. */
  private key(card: Pick<KanbanCard, 'originId' | 'feltStore' | 'id'>): string { return this.firstOf.get(card.id) ?? threadKey(card) }
  /** A thread whose orchestrator is named but not on the board. */
  isOrphan(card: KanbanCard): boolean { return !!card.orchestrator && !this.parents.has(this.key(card)) }
  /** Direct threads, in feed order. */
  children(card: KanbanCard): readonly KanbanCard[] { return this.kids.get(this.key(card)) ?? [] }
  /** Every descendant, in tree order. */
  subtree(card: KanbanCard): KanbanCard[] {
    const result: KanbanCard[] = []
    const pending = [...this.children(card)].reverse()
    while (pending.length) {
      const next = pending.pop()!
      result.push(next)
      const below = this.kids.get(this.key(next))
      if (below) for (let n = below.length - 1; n >= 0; n--) pending.push(below[n])
    }
    return result
  }
  summary(card: KanbanCard): ThreadSummary { return this.sums.get(this.key(card)) ?? EMPTY }
  /** Descendants, archived included. */
  size(card: KanbanCard): number { const s = this.summary(card); return s.unfinished + s.archived }
  state(card: KanbanCard): ThreadState { return this.states.get(this.key(card)) ?? threadState(card) }
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
