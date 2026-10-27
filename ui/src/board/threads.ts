import { hasLiveWorker, type KanbanCard, type KanbanResponse } from './KanbanTypes.js'
import { deskColumn } from './deskColumn.js'
import { turnOf } from './turn.js'

export type ThreadState = 'waiting' | 'to-review' | 'working' | 'drafts' | 'roles' | 'resting' | 'archived'
export type ThreadSummary = NonNullable<KanbanCard['threadSummary']>
/** What waits for a constitution's next worker, in full, as the launch roster and `shuttle threads` say it. */
export const waitingWords = (n: number): string => `${n} waiting for its next worker`

export const THREAD_LABEL: Record<ThreadState, string> = {
  waiting: 'Waiting', 'to-review': 'To review', working: 'Working', drafts: 'Drafts', roles: 'Roles', resting: 'Resting', archived: 'Archived',
}
/**
 * What a family needs from the human, most urgent first. Its one Desk row
 * sits where the most urgent need anywhere in the tree puts it.
 */
export type FamilyNeed = 'yours' | 'review' | 'working'
const FAMILY_NEEDS: readonly FamilyNeed[] = ['yours', 'review', 'working']
/** Each need as the row's tail words it: `2 working · 1 to review`. */
export const NEED_WORD: Readonly<Record<FamilyNeed, string>> = { yours: 'waiting', review: 'to review', working: 'working' }
export interface Family {
  root: KanbanCard
  /** The row: the node that set the family's column, the root when the tree is quiet. */
  lead: KanbanCard
  /** The family's most urgent need, or null when the tree asks nothing and the root rests where it rests. */
  need: FamilyNeed | null
  /** Every node sharing a need of the human's, lead first; the lead alone for Working and a quiet tree. */
  askers: KanbanCard[]
  /** Nodes elsewhere in the tree by need, the row's own need counted only for Working's other workers. */
  others: Record<FamilyNeed, number>
}
const STATE_ORDER: readonly ThreadState[] = ['waiting', 'to-review', 'working', 'drafts', 'roles', 'resting', 'archived']
/**
 * A thread's state: the Desk column it would sit in (`deskColumn`), with
 * In flight split by `turnOf` into Waiting (the human's move) and Working
 * (the worker's, including an armed thread whose worker has not started).
 * A verdict archives; a standing thread asleep on its cron rests; a seat at
 * rest is among the Roles. The rail and mention chips read this.
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
  private readonly ancestryTitles = new Map<string, string>()
  private readonly sums = new Map<string, ThreadSummary>()
  private readonly families = new Map<string, Family>()
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
    this.summarize()
    this.gather()
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

  /**
   * One family per tree, placed by what the whole tree needs from the human:
   * Your turn, then a verdict, then a live worker; a quiet tree is its root.
   * Every node of the tree reads the same family.
   */
  private gather(): void {
    for (const rootKey of this.states.keys()) {
      if (this.parents.has(rootKey)) continue
      const root = this.cards.get(rootKey)!
      const nodes = [root, ...this.subtree(root)]
      const needs = nodes.map(node => this.need(node))
      const need = FAMILY_NEEDS.find(n => needs.includes(n)) ?? null
      const askers = need ? nodes.filter((_, n) => needs[n] === need) : [root]
      // A question leads Your turn, as it leads the band; tree order otherwise.
      if (need === 'yours') askers.sort((a, b) => Number(turnOf(b).turn === 'question') - Number(turnOf(a).turn === 'question'))
      const lead = need === 'working' && needs[0] !== 'working' && this.state(root) === 'working' && !root.held ? root : askers[0]
      const others: Record<FamilyNeed, number> = { yours: 0, review: 0, working: 0 }
      for (const n of needs) if (n && n !== need) others[n]++
      // Working asks nothing of the human: its other workers are a count, not lines.
      const shown = need === 'working' ? [lead] : askers
      if (need === 'working') others.working = askers.filter(card => card !== lead).length
      const family: Family = { root, lead, need, askers: shown, others }
      for (const node of nodes) this.families.set(this.key(node), family)
    }
  }
  /** What one node asks of the human, if anything: an armed thread without a worker asks nothing. */
  private need(card: KanbanCard): FamilyNeed | null {
    const state = this.state(card)
    if (state === 'waiting') return 'yours'
    if (state === 'to-review') return 'review'
    return state === 'working' && hasLiveWorker(card) ? 'working' : null
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
  summary(card: KanbanCard): ThreadSummary { return this.sums.get(this.key(card)) ?? EMPTY }
  /** The family a node belongs to: its tree's root, the row that stands for it, and who in it is asking. */
  family(card: KanbanCard): Family {
    return this.families.get(this.key(card)) ?? { root: card, lead: card, need: null, askers: [card], others: { yours: 0, review: 0, working: 0 } }
  }
  /** The Desk's rows: each family's lead, once, in root order. */
  frontier(): KanbanCard[] {
    const rows: KanbanCard[] = []
    for (const key of this.states.keys()) if (!this.parents.has(key)) rows.push(this.families.get(key)!.lead)
    return rows
  }
  /** Cached parent-chain tooltips keep deep rail rendering linear in graph reads. */
  ancestryTitle(card: KanbanCard): string {
    const key = this.key(card)
    if (this.ancestryTitles.has(key)) return this.ancestryTitles.get(key)!
    const chain: KanbanCard[] = []
    let next: KanbanCard | undefined = card
    while (next && !this.ancestryTitles.has(this.key(next))) {
      chain.push(next); next = this.parentOf(next)
    }
    while (chain.length) {
      const child = chain.pop()!, parent = this.parentOf(child)
      const prefix = parent ? this.ancestryTitles.get(this.key(parent)) : ''
      this.ancestryTitles.set(this.key(child), parent ? `${prefix ? `${prefix} › ` : ''}${parent.name}` : '')
    }
    return this.ancestryTitles.get(key)!
  }
  /** Known ancestry is navigable; missing ancestry is only a path, never a guessed identity. */
  ancestry(card: KanbanCard): Array<{ name: string; card?: KanbanCard }> {
    const ancestors: KanbanCard[] = []
    for (let parent = this.parentOf(card); parent; parent = this.parentOf(parent)) ancestors.unshift(parent)
    const first = ancestors[0] ?? card
    const missing = this.isOrphan(first) ? first.id.split('/').slice(0, -1).map(name => ({ name })) : []
    return [...missing, ...ancestors.map(card => ({ name: card.name, card }))]
  }
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
