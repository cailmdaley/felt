import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { ascByKey, instantMs } from './civilDay.js'

export type ThreadState = 'in-flight' | 'to-review' | 'with-orchestrator' | 'drafts' | 'roles' | 'resting' | 'archived'

export const THREAD_LABEL: Record<ThreadState, string> = {
  'in-flight': 'In flight', 'to-review': 'To review', 'with-orchestrator': 'With orchestrator', drafts: 'Drafts', roles: 'Roles', resting: 'Resting', archived: 'Archived',
}
/**
 * Where a thread stands in its lifecycle: its served column, with a closed
 * thread its orchestrator reviews (With orchestrator) told apart from one
 * awaiting the human's review (To review). A verdict archives; a standing
 * thread asleep on its cron rests; a seat at rest is among the Roles. It says
 * nothing of whether the thread waits on the human or works: that is
 * `attentionOf`'s. The family tree shelves threads by it, and the daemon's
 * roster (`Shuttle.Threads.thread_state/4`) starts from the same column.
 */
export function threadState(card: KanbanCard): ThreadState {
  switch (card.column) {
    case 'tempered': case 'composted': return 'archived'
    case 'awaitingReview': return 'to-review'
    case 'orchestratorReview': return 'with-orchestrator'
    case 'inFlight': return 'in-flight'
    case 'drafts': return 'drafts'
    case 'roles': return 'roles'
    case 'resting': return 'resting'
  }
}
/** A thread's identity: a wire edge names a path, and the same path can live on several hosts. */
export const threadKey = (card: Pick<KanbanCard, 'originId' | 'feltStore' | 'id'>): string =>
  `${card.originId}\u0000${card.feltStore ?? ''}\u0000${card.id}`
/** The card of a fiber a host names: that host's copy, else the fiber's one row, which a mirror's uid still reaches. */
export const cardNamed = <T extends Pick<KanbanCard, 'originId' | 'id' | 'uid'>>(cards: readonly T[], id: string, origin: string): T | undefined =>
  cards.find(card => (card.uid === id || card.id === id) && card.originId === origin) ?? cards.find(card => card.uid === id)
let builds = 0
/** How many indexes have been built in this page — the scale tests' witness that nothing rebuilds per card. */
export function threadIndexBuilds(): number { return builds }

/**
 * The containment forest of one board response, built once: each card's
 * resolved orchestrator, its children in feed order, and its state. Every
 * thread surface reads this rather than re-deriving the graph.
 */
export class ThreadIndex {
  private readonly cards = new Map<string, KanbanCard>()
  private readonly parents = new Map<string, KanbanCard>()
  private readonly kids = new Map<string, KanbanCard[]>()
  private readonly states = new Map<string, ThreadState>()
  /** A UID proves mirrored identity; without it, host/store/path stays distinct. */
  private readonly firstOf = new Map<string, string>()

  constructor(cards: readonly KanbanCard[]) {
    builds++
    const byId = new Map<string, KanbanCard[]>()
    for (const card of cards) {
      const key = threadKey(card)
      if (this.cards.has(key)) continue
      this.cards.set(key, card)
      const fid = card.uid ?? card.id
      const identity = card.uid ?? key
      if (!this.firstOf.has(identity)) this.firstOf.set(identity, key)
      if (!card.isCycle) byId.set(fid, [...(byId.get(fid) ?? []), card])
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
      if (owner && (owner.uid ?? owner.id) !== (card.uid ?? card.id)) this.parents.set(key, owner)
    }
    this.breakCycles()
    for (const [key, owner] of this.parents) {
      const ownerKey = this.key(owner)
      const list = this.kids.get(ownerKey)
      if (list) list.push(this.cards.get(key)!)
      else this.kids.set(ownerKey, [this.cards.get(key)!])
    }
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

  /** The card for a fiber named by uid, or by id when felt gave it none. */
  fiber(ref: string): KanbanCard | undefined {
    const key = this.firstOf.get(ref) ?? this.firstOf.get(ref.toUpperCase())
    return key === undefined ? [...this.cards.values()].find(card => card.id === ref) : this.cards.get(key)
  }
  /** The index's own copy of a card, which may be fresher than a caller's. */
  card(card: KanbanCard): KanbanCard { return this.cards.get(threadKey(card)) ?? this.cards.get(this.key(card)) ?? card }
  parentOf(card: KanbanCard): KanbanCard | undefined { return this.parents.get(this.key(card)) }
  /** The fiber's node, whichever host's copy asks. */
  private key(card: Pick<KanbanCard, 'originId' | 'feltStore' | 'id' | 'uid'>): string { return this.firstOf.get(card.uid ?? threadKey(card)) ?? threadKey(card) }
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
  /** The top-level constitution a node's family is named by: its topmost orchestrator, or itself. */
  rootOf(card: KanbanCard): KanbanCard {
    let root = this.card(card)
    for (let parent = this.parentOf(root); parent; parent = this.parentOf(parent)) root = parent
    return root
  }
  /** Every family's top-level: each node with no orchestrator on the board. */
  roots(): KanbanCard[] {
    return [...this.states.keys()].filter(key => !this.parents.has(key)).map(key => this.cards.get(key)!)
  }
  /** Known ancestry is navigable; missing ancestry is only a path, never a guessed identity. */
  ancestry(card: KanbanCard): Array<{ name: string; card?: KanbanCard }> {
    const ancestors: KanbanCard[] = []
    for (let parent = this.parentOf(card); parent; parent = this.parentOf(parent)) ancestors.unshift(parent)
    const first = ancestors[0] ?? card
    const missing = this.isOrphan(first) ? first.id.split('/').slice(0, -1).map(name => ({ name })) : []
    return [...missing, ...ancestors.map(card => ({ name: card.name, card }))]
  }
  state(card: KanbanCard): ThreadState { return this.states.get(this.key(card)) ?? threadState(card) }
}

export interface TreeNode { card: KanbanCard; depth: number; hasActiveDescendant: boolean; children: TreeNode[] }
/** Where a thread is drawn: in the tree while it is in play, else below it with the resting or the archived. */
type Shelf = 'tree' | 'resting' | 'archived'
function shelfOf(index: ThreadIndex, card: KanbanCard): Shelf {
  const state = index.state(card)
  return state === 'archived' ? 'archived' : state === 'resting' || state === 'roles' ? 'resting' : 'tree'
}
/** Family shape in creation order, independent of the presentation surface. */
export function threadTree(index: ThreadIndex, root: KanbanCard): TreeNode {
  const build = (card: KanbanCard, depth: number): TreeNode => {
    const sorted = [...index.children(card)].sort((a, b) => ascByKey(instantMs(a.createdAt), instantMs(b.createdAt)) || a.name.localeCompare(b.name) || threadKey(a).localeCompare(threadKey(b)))
    const children = sorted.map(child => build(child, depth + 1))
    return { card, depth, children, hasActiveDescendant: children.some(n => shelfOf(index, n.card) === 'tree' || n.hasActiveDescendant) }
  }
  return build(root, 0)
}

const indexes = new WeakMap<KanbanResponse, ThreadIndex>()
/** The index a response was built with, or one built now from `cards` and kept for that response. */
export function responseThreadIndex(resp: KanbanResponse, cards: () => readonly KanbanCard[]): ThreadIndex {
  let index = indexes.get(resp)
  if (!index) { index = new ThreadIndex(cards()); indexes.set(resp, index) }
  return index
}
export function adoptThreadIndex(resp: KanbanResponse, index: ThreadIndex): void { indexes.set(resp, index) }

const NO_THREADS = new ThreadIndex([])
/** The response's thread graph: the one the read model built, or built once from its cards. */
export function threadIndexFor(resp: KanbanResponse | null): ThreadIndex {
  return resp ? responseThreadIndex(resp, () => boardCards(resp)) : NO_THREADS
}

/** Every card the response holds, each fiber once. */
export function boardCards(resp: KanbanResponse | null): KanbanCard[] {
  if (!resp) return []
  const seen = new Set<string>()
  const out: KanbanCard[] = []
  for (const list of [
    resp.now.drafts,
    resp.now.inFlight,
    resp.now.awaitingReview,
    resp.timeline.past,
    resp.timeline.futureDated,
    resp.stash,
    resp.roles,
    resp.threads ?? [],
  ]) {
    for (const card of list) {
      // A uid names one fiber on every host; without one, a path is one host's own.
      const key = card.uid ?? `${card.originId}\u0000${card.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(card)
    }
  }
  return out
}
