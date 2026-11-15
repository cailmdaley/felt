import type { KanbanCard } from './KanbanTypes.js'
import type { SentFile } from './sentFiles.js'
import { cardNamed, threadState, type ThreadState } from './threads.js'

/** Lines a worker said with `shuttle say` while its card was out of view (`GET /api/v1/speak`). */
export interface HeldSpeech {
  fiber_id: string
  name: string
  n: number
  first: string
  at?: number | null
}

/** Something in an office blocked on the human: a pending ask, or a close awaiting his review. */
export interface Block {
  kind: 'ask' | 'review'
  card: KanbanCard
  text: string
  at: number
}

/**
 * One office with something blocked on the human. `key` is `role:<slug>` for
 * an office, else `fiber:<uid>` of the root constitution the blocked work
 * hangs from.
 */
export interface Office {
  key: string
  name: string
  /** The office's seat (or, without an office, its root constitution), when the board holds it. */
  seat?: KanbanCard
  /** Oldest first: the head of the letter is what has waited longest. */
  blocks: Block[]
  /** When the oldest block began: how long the office has waited. */
  since: number
  /** When the newest block began; an office set aside returns once something blocks after it. */
  newest: number
  /** The office's other live constitutions, for the strip of states. */
  threads: KanbanCard[]
  /** Files sent from the office's constitutions within the board's reach, newest first. */
  files: SentFile[]
  held: HeldSpeech[]
}

/** The dismissal record that sets an office aside until something newer blocks in it. */
export const setAsideKey = (office: Pick<Office, 'key' | 'newest'>): string => `office:${office.key}:${office.newest}`

/** Thread states the strip shows: work going on, not work at rest or archived. */
const LIVE: ReadonlySet<ThreadState> = new Set(['waiting', 'working', 'to-review', 'with-orchestrator', 'drafts'])
const fiberOf = (card: KanbanCard): string => card.uid ?? card.id

/**
 * The offices blocked on the human, longest-waiting first. A constitution's
 * office is its role (the composite serves the office a top-level `role`
 * names as `shuttle.role`), else its nearest ancestor's, else its root
 * constitution. `names` maps an office's slug to its charter's name.
 */
export function composeAudience(input: {
  cards: readonly KanbanCard[]
  parentOf: (card: KanbanCard) => KanbanCard | undefined
  names: ReadonlyMap<string, string>
  files: readonly SentFile[]
  held: readonly HeldSpeech[]
  dismissed: readonly string[]
  now: number
  reachMs: number
}): Office[] {
  const { cards, parentOf, names, files, held, dismissed, now, reachMs } = input
  const offices = new Map<KanbanCard, string>()
  const officeOf = (card: KanbanCard): string => {
    let key = offices.get(card)
    if (key) return key
    const parent = card.shuttleRole ? undefined : parentOf(card)
    key = card.shuttleRole ? `role:${card.shuttleRole}` : parent ? officeOf(parent) : `fiber:${fiberOf(card)}`
    offices.set(card, key)
    return key
  }
  const seen = new Set<string>()
  const members = new Map<string, KanbanCard[]>()
  for (const card of cards) {
    const identity = `${fiberOf(card)}\0${card.originId}`
    if (card.deskSection || card.isCycle || seen.has(identity)) continue
    seen.add(identity)
    const key = officeOf(card)
    members.set(key, [...(members.get(key) ?? []), card])
  }
  const setAside = new Map<string, number>()
  for (const record of dismissed) {
    const match = /^office:(.+):(\d+)$/.exec(record)
    if (match) setAside.set(match[1], Math.max(setAside.get(match[1]) ?? 0, Number(match[2])))
  }
  const audience: Office[] = []
  for (const [key, list] of members) {
    const blocks: Block[] = []
    for (const card of list) {
      if (card.ask && card.status === 'active') blocks.push({ kind: 'ask', card, text: card.ask.text, at: Date.parse(card.ask.at) })
      if (threadState(card) === 'to-review') blocks.push({ kind: 'review', card, text: card.reviewMark?.note || card.outcome || '', at: Date.parse(card.closedAt ?? card.reviewMark?.at ?? '') })
    }
    const timed = blocks.filter(block => Number.isFinite(block.at)).sort((a, b) => a.at - b.at)
    if (!timed.length) continue
    const newest = timed.at(-1)!.at
    if ((setAside.get(key) ?? -Infinity) >= newest) continue
    const blocked = new Set(timed.map(block => block.card))
    const slug = key.startsWith('role:') ? key.slice(5) : ''
    const root = slug ? undefined : list.find(card => `fiber:${fiberOf(card)}` === key)
    audience.push({
      key,
      name: slug ? names.get(slug) ?? slug : root?.name ?? timed[0].card.name,
      seat: slug ? list.find(card => card.shuttleSeat && card.shuttleRole === slug) : root,
      blocks: timed,
      since: timed[0].at,
      newest,
      threads: list.filter(card => !blocked.has(card) && LIVE.has(threadState(card))),
      files: files.filter(file => file.uid && file.timestamp >= now - reachMs && cardNamed(list, file.uid, file.host ?? ''))
        .sort((a, b) => b.timestamp - a.timestamp),
      held: held.filter(line => list.some(card => card.uid === line.fiber_id || card.id === line.fiber_id)),
    })
  }
  return audience.sort((a, b) => a.since - b.since || a.key.localeCompare(b.key))
}
