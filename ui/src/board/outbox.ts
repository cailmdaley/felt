import type { KanbanCard } from './KanbanTypes.js'
import type { SentFile } from './sentFiles.js'
import { cardNamed, threadState, type ThreadState } from './threads.js'
import { turnOf } from './turn.js'

/** Lines a worker said with `shuttle say` while its card was out of view (`GET /api/v1/speak`). */
export interface HeldSpeech {
  fiber_id: string
  name: string
  n: number
  first: string
  at?: number | null
}

/**
 * One card waiting on the human: an outstanding ask, a close awaiting his
 * review, or the Desk's Your turn (a worker idle, blocked or stopped on a
 * prompt at the end of its turn).
 */
export interface Waiting {
  kind: 'ask' | 'review' | 'turn'
  card: KanbanCard
  text: string
  /** When the wait began. */
  at: number
}

/**
 * One orchestrator's channel: a top-level constitution (no live ancestor)
 * and every live constitution under it, listed while anything in it waits
 * on the human.
 */
export interface Channel {
  /** The orchestrator's fiber uid (its id when felt gave it none). */
  key: string
  root: KanbanCard
  /** Its role's charter name, when the board has the charter and it is not the orchestrator's own. */
  role?: string
  /** Newest first. */
  waiting: Waiting[]
  /** When the newest wait began: the channel's place in the order, and what a set-aside is measured against. */
  newest: number
  /** Nothing has begun waiting in it for {@link COLD_MS}. */
  cold: boolean
  /** The family's other live constitutions, the orchestrator excepted, in state order. */
  threads: KanbanCard[]
  /** Files the family sent within the board's reach, newest first. */
  files: SentFile[]
  held: HeldSpeech[]
}

/** A channel whose newest wait is older than this goes to the gone-cold shelf. */
export const COLD_MS = 3 * 86_400_000

/** The dismissal record that sets a channel aside until something newer waits in it. */
export const setAsideKey = (channel: Pick<Channel, 'key' | 'newest'>): string => `office:fiber:${channel.key}:${channel.newest}`

/** Thread states the quiet list shows: work going on, not work at rest or archived. */
const LIVE: readonly ThreadState[] = ['waiting', 'to-review', 'with-orchestrator', 'working', 'drafts']
const fiberOf = (card: KanbanCard): string => card.uid ?? card.id
const instant = (...values: Array<string | number | undefined>): number =>
  values.map(value => typeof value === 'number' ? value : Date.parse(value ?? '')).find(Number.isFinite) ?? 0

/**
 * What a card is waiting on the human for, if anything. Your turn reads the
 * Desk's own `threadState` (In flight split by `turnOf`), so the two can
 * never disagree; an ask counts on any active card.
 */
export function waitingOn(card: KanbanCard): Waiting | undefined {
  const state = threadState(card)
  if (card.ask && card.status === 'active') return { kind: 'ask', card, text: card.ask.text, at: instant(card.ask.at) }
  if (state === 'to-review') return { kind: 'review', card, text: card.reviewMark?.note || card.outcome || '', at: instant(card.closedAt, card.reviewMark?.at, card.createdAt) }
  if (state !== 'waiting') return undefined
  const turn = turnOf(card)
  return { kind: turn.turn === 'question' ? 'ask' : 'turn', card, text: card.outcome || turn.detail, at: instant(turn.since, card.lastActivityAt, card.dispatchedAt, card.createdAt) }
}

/**
 * The channels waiting on the human, newest wait first; the cold ones fall
 * to the end by that same order. A card's channel is its topmost ancestor
 * reached through live (unarchived) constitutions.
 */
export function composeChannels(input: {
  cards: readonly KanbanCard[]
  parentOf: (card: KanbanCard) => KanbanCard | undefined
  names: ReadonlyMap<string, string>
  files: readonly SentFile[]
  held: readonly HeldSpeech[]
  dismissed: readonly string[]
  now: number
  reachMs: number
}): Channel[] {
  const { cards, parentOf, names, files, held, dismissed, now, reachMs } = input
  const roots = new Map<KanbanCard, KanbanCard>()
  const rootOf = (card: KanbanCard): KanbanCard => {
    let root = roots.get(card)
    if (root) return root
    const parent = parentOf(card)
    root = parent && threadState(parent) !== 'archived' ? rootOf(parent) : card
    roots.set(card, root)
    return root
  }
  const seen = new Set<string>()
  const families = new Map<string, { root: KanbanCard; members: KanbanCard[] }>()
  for (const card of cards) {
    // A uid names one fiber whichever host serves a copy of it.
    if (card.deskSection || card.isCycle || seen.has(fiberOf(card))) continue
    seen.add(fiberOf(card))
    const root = rootOf(card), key = fiberOf(root)
    const family = families.get(key) ?? families.set(key, { root, members: [] }).get(key)!
    family.members.push(card)
  }
  const setAside = new Map<string, number>()
  for (const record of dismissed) {
    const match = /^office:fiber:(.+):(\d+)$/.exec(record)
    if (match) setAside.set(match[1], Math.max(setAside.get(match[1]) ?? 0, Number(match[2])))
  }
  const channels: Channel[] = []
  for (const [key, { root, members }] of families) {
    const waiting = members.flatMap(card => waitingOn(card) ?? []).sort((a, b) => b.at - a.at)
    if (!waiting.length) continue
    const newest = waiting[0].at
    if ((setAside.get(key) ?? -Infinity) >= newest) continue
    const waits = new Set(waiting.map(item => item.card))
    const rank = (card: KanbanCard): number => LIVE.indexOf(threadState(card))
    channels.push({
      key,
      root,
      role: [names.get(root.shuttleRole ?? '')].find(name => name && name !== root.name),
      waiting,
      newest,
      cold: now - newest > COLD_MS,
      threads: members.filter(card => fiberOf(card) !== key && !waits.has(card) && rank(card) >= 0)
        .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)),
      files: files.filter(file => file.uid && file.timestamp >= now - reachMs && cardNamed(members, file.uid, file.host ?? ''))
        .sort((a, b) => b.timestamp - a.timestamp),
      held: held.filter(line => members.some(card => card.uid === line.fiber_id || card.id === line.fiber_id)),
    })
  }
  return channels.sort((a, b) => b.newest - a.newest || a.key.localeCompare(b.key))
}
