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

/** What a card is waiting on the human for: an ask, a close awaiting review, or the Desk's Your turn. */
export type WaitKind = 'ask' | 'review' | 'turn'

/**
 * One worker's line in a channel: its ask, review note or latest outcome.
 * `kind` is set when it waits on the human.
 */
export interface Message {
  card: KanbanCard
  kind?: WaitKind
  text: string
  at: number
}

/**
 * One channel: an office and every top-level constitution holding it, or a
 * top-level constitution with no office, together with all their live threads.
 */
export interface Channel {
  /** `role:<office>`, or `fiber:<uid>` for a top-level constitution without one. */
  key: string
  /** The office's charter name, else its slug; the constitution's name without one. */
  name: string
  /** Whose tapestry is pinned and who a reply goes to by default: the office's seat, else its most recently active top-level. */
  seat: KanbanCard
  /** Oldest first, as a channel reads: the newest at the bottom. */
  messages: Message[]
  /** When the newest wait began, or 0 when nothing waits. */
  newest: number
  /** Something waits on the human and it has not been set aside. */
  waiting: boolean
  /** It waits, and its newest wait is older than {@link COLD_MS}. */
  cold: boolean
  pinned: boolean
  /** Listed in the rail: waiting, or pinned. */
  listed: boolean
  /** Files the channel's constitutions sent within the board's reach, newest first. */
  files: SentFile[]
  held: HeldSpeech[]
}

/** A channel whose newest wait is older than this goes to the gone-cold shelf. */
export const COLD_MS = 3 * 86_400_000

/** The dismissal record that sets a channel aside until something newer waits in it. */
export const setAsideKey = (channel: Pick<Channel, 'key' | 'newest'>): string => `office:${channel.key}:${channel.newest}`
/** The dismissal record that unpins a channel: every pin up to `at` stops counting. */
export const unpinKey = (key: string, at: number): string => `pin:${key}:${at}`

/** Constitutions a channel speaks for: everything not archived. */
const LIVE: readonly ThreadState[] = ['waiting', 'to-review', 'with-orchestrator', 'working', 'drafts', 'roles', 'resting']
const fiberOf = (card: KanbanCard): string => card.uid ?? card.id
const instant = (...values: Array<string | number | undefined>): number =>
  values.map(value => typeof value === 'number' ? value : Date.parse(value ?? '')).find(Number.isFinite) ?? 0
const lastActive = (card: KanbanCard): number => instant(card.lastActivityAt, card.closedAt, card.createdAt)
/** The office a role names: its first path segment. */
export const officeOf = (role: string | undefined): string => role?.split('/')[0] ?? ''

/**
 * What a card is waiting on the human for, if anything. Your turn reads the
 * Desk's own `threadState` (In flight split by `turnOf`), so the two can
 * never disagree; an ask counts on any active card.
 */
export function waitingOn(card: KanbanCard): Message | undefined {
  const state = threadState(card)
  if (card.ask && card.status === 'active') return { kind: 'ask', card, text: card.ask.text, at: instant(card.ask.at, card.lastActivityAt, card.dispatchedAt, card.createdAt) }
  if (state === 'to-review') return { kind: 'review', card, text: card.reviewMark?.note || card.outcome || '', at: instant(card.closedAt, card.reviewMark?.at, card.createdAt) }
  if (state !== 'waiting') return undefined
  const turn = turnOf(card)
  // What the worker has to say is its outcome; only a turn that could not start says why.
  const text = card.outcome || (turn.turn === 'blocked' ? turn.detail : '')
  return { kind: turn.turn === 'question' ? 'ask' : 'turn', card, text, at: instant(turn.since, card.lastActivityAt, card.dispatchedAt, card.createdAt) }
}

/**
 * Every channel the board holds, the listed ones first: the waiting ones,
 * newest wait first, then the pinned quiet ones, then the waiting ones gone
 * cold. A card's top-level constitution is its topmost ancestor among every
 * card the board holds, archived ones included, and the top-level's office
 * names the channel, whatever office a thread under it holds. A pin counts
 * until a later unpin.
 */
export function composeChannels(input: {
  cards: readonly KanbanCard[]
  parentOf: (card: KanbanCard) => KanbanCard | undefined
  names: ReadonlyMap<string, string>
  files: readonly SentFile[]
  held: readonly HeldSpeech[]
  dismissed: readonly string[]
  /** Pinned channel keys, each with its latest pin. */
  pinned: ReadonlyMap<string, number>
  now: number
  reachMs: number
}): Channel[] {
  const { cards, parentOf, names, files, held, dismissed, pinned, now, reachMs } = input
  const tops = new Map<KanbanCard, KanbanCard>()
  const topOf = (card: KanbanCard): KanbanCard => {
    let top = tops.get(card)
    if (top) return top
    const parent = parentOf(card)
    top = parent ? topOf(parent) : card
    tops.set(card, top)
    return top
  }
  const seen = new Set<string>()
  const groups = new Map<string, { top: KanbanCard; members: KanbanCard[] }>()
  for (const card of cards) {
    // A uid names one fiber whichever host serves a copy of it.
    if (card.deskSection || card.isCycle || seen.has(fiberOf(card)) || !LIVE.includes(threadState(card))) continue
    seen.add(fiberOf(card))
    const top = topOf(card), office = officeOf(top.shuttleRole)
    const key = office ? `role:${office}` : `fiber:${fiberOf(top)}`
    const group = groups.get(key) ?? groups.set(key, { top, members: [] }).get(key)!
    group.members.push(card)
  }
  // `office:<key>:<ms>` sets a channel aside until something waits after <ms>; `pin:<key>:<ms>` unpins the pins up to <ms>.
  const setAside = new Map<string, number>(), unpinned = new Map<string, number>()
  for (const record of dismissed) {
    const match = /^(office|pin):(.+):(\d+)$/.exec(record)
    const into = match?.[1] === 'office' ? setAside : unpinned
    if (match) into.set(match[2], Math.max(into.get(match[2]) ?? 0, Number(match[3])))
  }
  const channels: Channel[] = []
  const recent = (list: KanbanCard[]): KanbanCard | undefined => [...list].sort((a, b) => lastActive(b) - lastActive(a))[0]
  for (const [key, { top, members }] of groups) {
    const office = key.startsWith('role:') ? key.slice(5) : ''
    const tops = members.filter(card => fiberOf(topOf(card)) === fiberOf(card))
    // A family whose top-level is archived has no seat of its own: its most recently active member stands for it.
    const seat = tops.find(card => card.shuttleSeat) ?? recent(tops) ?? recent(members)!
    const pin = pinned.get(key) ?? -Infinity, isPinned = pin > (unpinned.get(key) ?? -Infinity)
    const sent = files.filter(file => file.uid && file.timestamp >= now - reachMs && cardNamed(members, file.uid, file.host ?? ''))
      .sort((a, b) => b.timestamp - a.timestamp)
    const spoken = held.filter(line => members.some(card => card.uid === line.fiber_id || card.id === line.fiber_id))
    const said = (card: KanbanCard): boolean => sent.some(file => cardNamed([card], file.uid ?? '', file.host ?? ''))
      || spoken.some(line => line.fiber_id === card.uid || line.fiber_id === card.id)
    const messages = members.flatMap<Message>(card => waitingOn(card)
      ?? (card.outcome || said(card) ? [{ card, text: card.outcome ?? '', at: lastActive(card) }] : []))
      .sort((a, b) => a.at - b.at)
    const newest = Math.max(0, ...messages.filter(message => message.kind).map(message => message.at))
    const waiting = newest > 0 && (setAside.get(key) ?? -Infinity) < newest
    channels.push({
      key,
      name: office ? names.get(office) ?? office : top.name,
      seat,
      messages,
      newest,
      waiting,
      cold: waiting && now - newest > COLD_MS,
      pinned: isPinned,
      listed: waiting || isPinned,
      files: sent,
      held: spoken,
    })
  }
  const shelf = (channel: Channel): number => !channel.listed ? 3 : channel.cold ? 2 : channel.waiting ? 0 : 1
  return channels.sort((a, b) => shelf(a) - shelf(b) || b.newest - a.newest || a.name.localeCompare(b.name))
}
