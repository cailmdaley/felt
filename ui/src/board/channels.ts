import type { KanbanCard } from './KanbanTypes.js'
import type { SentFile } from './sentFiles.js'
import { cardNamed, threadState, type ThreadState } from './threads.js'
import { turnOf } from './turn.js'

/**
 * One family-board record as `GET /api/v1/board/family` serves it. `fiber` is
 * the record's subject; `by` and `to` are who spoke and who it was for.
 */
export interface BoardRecord {
  id: string
  kind: string
  timestamp: number
  /** A remote record's first arrival at this daemon. */
  received_at?: number
  fiber?: string
  by?: { fiber?: string; session?: string; label?: string }
  to?: { fiber?: string; session?: string; label?: string }
  text?: string
  verdict?: string
  /** The absolute paths a post attaches, each also a sent file. */
  files?: string[]
  originName?: string
}

/**
 * What a message is: a worker's post, ask, review, Your turn or close; a hand-off
 * or another lifecycle line; a file sent on its own; the chair's tapestry; the
 * human's reply; or one worker writing to another.
 */
export type MessageKind = 'post' | 'ask' | 'review' | 'turn' | 'closed' | 'handed_off' | 'event' | 'file' | 'tapestry' | 'reply' | 'chat'

/** One item of a channel's stream, or of a worker's thread. */
export interface Message {
  id: string
  /** The worker whose thread it belongs to: who said it, or whom the human said it to. */
  card: KanbanCard
  /** Another worker that wrote it to `card`. */
  from?: KanbanCard
  /** The human said it. */
  human: boolean
  kind: MessageKind
  text: string
  at: number
  files: SentFile[]
  /** It waits on the human now. */
  waiting: boolean
  /** It belongs in its worker's thread only, not the channel's stream. */
  quiet: boolean
  /** Who wrote it from outside the fleet, when neither a worker nor the human. */
  label?: string
  /** A tapestry's page and title. */
  path?: string
  title?: string
}

/** A chair's tapestry, collapsed to its title and lede. */
export interface Tapestry { path: string; at: number; title: string; lede: string }

/**
 * One channel: the constitutions speaking in a named channel (`shuttle.channel`,
 * a thread inheriting its nearest ancestor's), else an office's top-levels and
 * their threads, else one top-level constitution with its threads.
 */
export interface Channel {
  /** `channel:<name, lowercased>` — a `shuttle.channel` or an office's charter name — or `fiber:<uid>` for a lone top-level. */
  key: string
  /** The channel's name; an office's charter name before any ` · ` gloss; the constitution's name. */
  name: string
  /** The name in full, a charter's gloss included. */
  title: string
  /** Named or an office's: drawn above the lone constitutions. */
  chaired: boolean
  /** Its chair: whose tapestry it carries and who a reply in it goes to. */
  seat: KanbanCard
  /** Every live constitution in it. */
  members: KanbanCard[]
  /** Every constitution in it, archived ones too, for resolving what they said. */
  everyone: KanbanCard[]
  /** The uids of the families its live members belong to, each family's top-level. */
  families: string[]
  /** When the newest wait began, or 0 when nothing waits. */
  newest: number
  /** Something waits on the human and it has not been set aside. */
  waiting: boolean
  /** Its members' latest activity. */
  active: number
  pinned: boolean
  /** When it was taken out of the rail, nothing having begun waiting in it since; 0 when it is not hidden. */
  hidden: number
  /** In the rail: not hidden, and waiting, pinned, or opened or active within {@link RECENT_MS}. */
  listed: boolean
}

/** A channel opened or active within this long stays in the rail. */
export const RECENT_MS = 7 * 86_400_000
/** A file sent this close to a worker's message is attached to it. */
export const ATTACH_MS = 10 * 60_000

/** The dismissal record that clears a channel's waiting mark until something newer waits in it. */
export const setAsideKey = (channel: Pick<Channel, 'key' | 'newest'>): string => `office:${channel.key}:${channel.newest}`
/** The dismissal record that unpins a channel: every pin up to `at` stops counting. */
export const unpinKey = (key: string, at: number): string => `pin:${key}:${at}`
/** The dismissal record that takes a channel out of the rail at `at`, until something begins waiting in it later. */
export const hideKey = (key: string, at: number): string => `hide:${key}:${at}`
/** The dismissal record that brings a hidden channel back: every hide up to `at` stops counting. */
export const showKey = (key: string, at: number): string => `show:${key}:${at}`

/** Constitutions a channel speaks for: everything not archived. */
const LIVE: readonly ThreadState[] = ['waiting', 'to-review', 'with-orchestrator', 'working', 'drafts', 'roles', 'resting']
export const fiberOf = (card: KanbanCard): string => card.uid ?? card.id
export const sameFiber = (a: KanbanCard, b: KanbanCard): boolean => fiberOf(a) === fiberOf(b)
/** The first of `values` that names a real instant, else 0 (no time is known). */
const instant = (...values: Array<string | number | undefined>): number =>
  values.map(value => typeof value === 'number' ? value : Date.parse(value ?? '')).find(value => Number.isFinite(value) && value > 0) ?? 0
/** A card's last update: its worker's latest event or its file's last write, whichever is later. */
const lastActive = (card: KanbanCard): number =>
  Math.max(instant(card.lastActivityAt), instant(card.modifiedAt)) || instant(card.closedAt, card.createdAt)
/** The office a role names: its first path segment. */
export const officeOf = (role: string | undefined): string => role?.split('/')[0] ?? ''

/**
 * When a card began waiting on the human, or 0 when it does not: an ask on an
 * active card, a close awaiting review, or the Desk's Your turn (`threadState`,
 * so the two never disagree). A wait whose time is unknown is 1.
 */
export function waitsSince(card: KanbanCard): number {
  if (card.ask && card.status === 'active') return instant(card.ask.at, card.lastActivityAt, card.dispatchedAt, card.modifiedAt, card.createdAt) || 1
  const state = threadState(card)
  if (state === 'to-review') return instant(card.closedAt, card.reviewMark?.at, card.modifiedAt, card.createdAt) || 1
  if (state !== 'waiting') return 0
  return instant(turnOf(card).since, card.lastActivityAt, card.dispatchedAt, card.modifiedAt, card.createdAt) || 1
}

/**
 * Every channel the board holds, the chaired ones first, each shelf by name.
 * A card speaks in its own `shuttle.channel`, else its nearest ancestor's;
 * without one anywhere above it, its top-level constitution's office names
 * the channel, else that top-level is a channel of its own. A pin counts
 * until a later unpin; a set-aside clears the waiting mark until a later wait;
 * a hide counts until a later show or a later wait.
 */
export function composeChannels(input: {
  cards: readonly KanbanCard[]
  parentOf: (card: KanbanCard) => KanbanCard | undefined
  names: ReadonlyMap<string, string>
  dismissed: readonly string[]
  /** Pinned channel keys, each with its latest pin. */
  pinned: ReadonlyMap<string, number>
  /** When the reader last opened each channel. */
  opened: (key: string) => number
  now: number
}): Channel[] {
  const { cards, parentOf, names, dismissed, pinned, opened, now } = input
  const tops = new Map<KanbanCard, KanbanCard>(), named = new Map<KanbanCard, string | null>()
  const topOf = (card: KanbanCard): KanbanCard => {
    let top = tops.get(card)
    if (top) return top
    const parent = parentOf(card)
    top = parent ? topOf(parent) : card
    tops.set(card, top)
    return top
  }
  const channelOf = (card: KanbanCard): string | null => {
    if (named.has(card)) return named.get(card)!
    const parent = parentOf(card)
    const name = card.shuttleChannel ?? (parent ? channelOf(parent) : null)
    named.set(card, name)
    return name
  }
  // A channel is keyed by its name, so an office whose charter shares a channel's name speaks in that channel.
  const nameOf = (card: KanbanCard): string | null => {
    const name = channelOf(card)
    if (name) return name
    const office = officeOf(topOf(card).shuttleRole)
    return office ? (names.get(office) ?? office).split(' · ')[0] : null
  }
  const keyOf = (card: KanbanCard): string => {
    const name = nameOf(card)
    return name ? `channel:${name.toLowerCase()}` : `fiber:${fiberOf(topOf(card))}`
  }
  const titles = new Map<string, string>()
  const seen = new Set<string>()
  const groups = new Map<string, { members: KanbanCard[]; everyone: KanbanCard[] }>()
  for (const card of cards) {
    // A uid names one fiber whichever host serves a copy of it.
    if (card.deskSection || card.isCycle || seen.has(fiberOf(card))) continue
    seen.add(fiberOf(card))
    const key = keyOf(card)
    // A channel's own spelling wins over an office's.
    const office = officeOf(topOf(card).shuttleRole)
    if (!titles.has(key) || channelOf(card)) titles.set(key, channelOf(card) ?? (office ? names.get(office) ?? office : ''))
    const group = groups.get(key) ?? groups.set(key, { members: [], everyone: [] }).get(key)!
    group.everyone.push(card)
    if (LIVE.includes(threadState(card))) group.members.push(card)
  }
  // `office:<key>:<ms>` clears a channel's waiting mark until something waits after <ms>; `pin:<key>:<ms>` unpins the pins up to <ms>;
  // `hide:<key>:<ms>` takes it out of the rail until something waits after <ms>; `show:<key>:<ms>` voids the hides up to <ms>.
  const latest: Record<string, Map<string, number>> = { office: new Map(), pin: new Map(), hide: new Map(), show: new Map() }
  for (const record of dismissed) {
    const match = /^(office|pin|hide|show):(.+):(\d+)$/.exec(record)
    const into = match && latest[match[1]]
    if (into) into.set(match[2], Math.max(into.get(match[2]) ?? 0, Number(match[3])))
  }
  const since = (kind: string, key: string): number => latest[kind].get(key) ?? -Infinity
  const recent = (list: KanbanCard[]): KanbanCard | undefined => [...list].sort((a, b) => lastActive(b) - lastActive(a))[0]
  const channels: Channel[] = []
  for (const [key, { members, everyone }] of groups) {
    if (!members.length) continue
    const inside = (card: KanbanCard): KanbanCard[] => {
      const above: KanbanCard[] = []
      for (let parent = parentOf(card); parent && keyOf(parent) === key; parent = parentOf(parent)) above.push(parent)
      return above
    }
    // The chair is the topmost seat, a standing one only when no other is; without a seat, the most recently active top-level.
    const seats = members.filter(card => card.shuttleSeat && !inside(card).some(above => above.shuttleSeat))
    const heads = members.filter(card => !inside(card).length)
    const seat = recent(seats.filter(card => card.shuttleKind !== 'standing')) ?? recent(seats) ?? recent(heads) ?? recent(members)!
    const newest = Math.max(0, ...members.map(waitsSince))
    const active = Math.max(0, ...members.map(lastActive))
    const isPinned = (pinned.get(key) ?? -Infinity) > since('pin', key)
    const waiting = newest > 0 && since('office', key) < newest
    const hidden = since('hide', key) > Math.max(since('show', key), newest) ? since('hide', key) : 0
    const title = titles.get(key) || seat.name
    channels.push({
      key, name: title.split(' · ')[0], title, chaired: !key.startsWith('fiber:'), seat, members, everyone,
      families: [...new Set(members.map(card => fiberOf(topOf(card))))],
      newest, waiting, active, pinned: isPinned, hidden,
      listed: !hidden && (waiting || isPinned || now - Math.max(active, opened(key)) <= RECENT_MS),
    })
  }
  return channels.sort((a, b) => Number(b.chaired) - Number(a.chaired) || a.name.localeCompare(b.name))
}

/**
 * Every channel in the human's order: those the order does not name first, as
 * given, then the order's.
 */
export function arranged(channels: readonly Channel[], order: readonly string[]): Channel[] {
  const place = new Map(order.map((key, index) => [key, index]))
  const rank = (channel: Channel): number => place.get(channel.key) ?? -1
  return [...channels].sort((a, b) => rank(a) - rank(b))
}

/** The rail's order: what waits on the human first, the newest wait first, then everything else in the human's order. */
export function railOrder(channels: readonly Channel[], order: readonly string[]): Channel[] {
  const all = arranged(channels, order)
  return [...all.filter(channel => channel.waiting).sort((a, b) => b.newest - a.newest), ...all.filter(channel => !channel.waiting)]
}

/**
 * The human's order once the channels `shown` were rearranged among
 * themselves: each place they held in `order` takes the next of them, and
 * every other channel (waiting, hidden or out of the rail) keeps its place.
 */
export function reordered(order: readonly string[], shown: readonly string[]): string[] {
  const moving = new Set(shown)
  let next = 0
  return order.map(key => moving.has(key) ? shown[next++] : key)
}

/** Lifecycle lines a thread keeps, by what they say. */
const EVENT_WORDS: Readonly<Record<string, string>> = {
  rested: 'rested', cleared: 'question cleared', run_tempered: 'run tempered', unblocked: 'unblocked',
}

/**
 * Everything a channel's constitutions said, oldest first: the family board's
 * records about its members, what their cards wait on that the board does not
 * hold, the files they sent (attached to a message close in time, else their
 * own), and the chair's tapestry. A message marked `quiet` belongs in its
 * worker's thread only: the human's chat in a worker's terminal, workers
 * writing to each other, and lifecycle lines other than a close or a hand-off.
 */
export function composeMessages(input: {
  channel: Channel
  records: readonly BoardRecord[]
  files: readonly SentFile[]
  tapestry?: Tapestry | null
  now: number
  reachMs: number
}): Message[] {
  const { channel, records, files, tapestry, now, reachMs } = input
  const cardOf = (ref: string | undefined): KanbanCard | undefined =>
    ref ? channel.everyone.find(card => card.uid === ref || card.id === ref) : undefined
  const messages: Message[] = []
  const said = (card: KanbanCard, kind: MessageKind, text: string, at: number, over: Partial<Message> = {}): Message => {
    const message: Message = { id: `${kind}:${fiberOf(card)}:${at}`, card, human: false, kind, text, at, files: [], waiting: false, quiet: false, ...over }
    messages.push(message)
    return message
  }
  const attached = new Set<string>()
  for (const record of records) {
    const card = cardOf(record.fiber)
    if (!card) continue
    const by = record.by ?? {}, text = record.text?.trim() ?? ''
    // The board writes the human's replies from `human`; a worker's chat hook labels them with the human's name.
    const labelled = !by.fiber && !by.session && !!by.label
    const base = { id: record.id }
    switch (record.kind) {
      case 'post': {
        const sent = (record.files ?? []).map(path => {
          attached.add(path)
          return files.find(file => file.fullPath === path)
            ?? { fullPath: path, basename: path.split('/').pop() ?? path, timestamp: record.timestamp, uid: fiberOf(card), host: record.originName }
        })
        said(card, 'post', text, record.timestamp, { ...base, files: sent })
        break
      }
      case 'asked':
        said(card, 'ask', text, record.timestamp, base)
        break
      case 'closed':
        // A close says something to the human when it carries a verdict or waits for review (below).
        said(card, 'closed', record.verdict ?? '', record.timestamp, { ...base, quiet: !record.verdict })
        break
      case 'handed_off':
        said(card, 'handed_off', '', record.timestamp, base)
        break
      case 'message':
        if (labelled && by.label === 'human') said(card, 'reply', text, record.timestamp, { ...base, human: true })
        else said(card, 'chat', text, record.timestamp, { ...base, quiet: true, from: cardOf(by.fiber), label: labelled ? by.label : undefined })
        break
      case 'human':
        said(card, 'reply', text, record.timestamp, { ...base, human: true, quiet: true })
        break
      case 'answered': {
        // The human's answer in a worker's chat is recorded after the question it answers.
        const answer = labelled ? /\s—\sA:\s([\s\S]*)$/.exec(text)?.[1] : undefined
        if (answer) said(card, 'reply', answer, record.timestamp, { ...base, human: true })
        else said(card, 'event', 'answered', record.timestamp, { ...base, quiet: true })
        break
      }
      default:
        if (EVENT_WORDS[record.kind]) said(card, 'event', EVENT_WORDS[record.kind], record.timestamp, { ...base, quiet: true })
    }
  }
  for (const card of channel.members) {
    const mine = messages.filter(message => message.card === card && !message.human)
    // The open question is the newest ask the board holds from it, else the card's own.
    if (card.ask && card.status === 'active') {
      const asked = mine.filter(message => message.kind === 'ask').at(-1)
      if (asked) asked.waiting = true
      else said(card, 'ask', card.ask.text, waitsSince(card), { waiting: true })
    }
    const state = threadState(card)
    if (state === 'to-review') {
      const note = card.reviewMark?.note?.trim() ?? ''
      const close = mine.filter(message => message.kind === 'closed').at(-1)
      if (close) Object.assign(close, { kind: 'review', text: note, waiting: true, quiet: false })
      else said(card, 'review', note, waitsSince(card), { waiting: true })
    }
    const turn = turnOf(card)
    // Your turn is a message only when the worker said why it stopped.
    if (state === 'waiting' && turn.turn === 'blocked' && turn.detail) said(card, 'turn', turn.detail, waitsSince(card), { waiting: true })
  }
  const speaking: readonly MessageKind[] = ['post', 'ask', 'review', 'turn', 'closed']
  const seen = new Set<string>()
  for (const file of [...files].sort((a, b) => b.timestamp - a.timestamp)) {
    if (attached.has(file.fullPath) || seen.has(file.fullPath) || file.timestamp < now - reachMs || !file.uid) continue
    const card = cardNamed(channel.everyone, file.uid, file.host ?? '')
    if (!card) continue
    // A file sent again is attached once, at its newest send.
    seen.add(file.fullPath)
    const near = messages.filter(message => message.card === card && speaking.includes(message.kind) && Math.abs(message.at - file.timestamp) <= ATTACH_MS)
      .sort((a, b) => Math.abs(a.at - file.timestamp) - Math.abs(b.at - file.timestamp))[0]
    if (near) near.files.unshift(file)
    else said(card, 'file', '', file.timestamp, { id: `file:${file.fullPath}:${file.timestamp}`, files: [file] })
  }
  if (tapestry) said(channel.seat, 'tapestry', tapestry.lede, tapestry.at, { id: `tapestry:${tapestry.path}`, path: tapestry.path, title: tapestry.title })
  return messages.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}

/** A worker's thread: what it said, what was said to it, and what it wrote to others. */
export const threadOf = (messages: readonly Message[], card: KanbanCard): Message[] =>
  messages.filter(message => sameFiber(message.card, card) || (!!message.from && sameFiber(message.from, card)))

/** A worker's liveness, as its thread names it. */
export function liveness(card: KanbanCard): 'working' | 'waiting' | 'resting' | 'closed' {
  const state = threadState(card)
  if (state === 'waiting' || state === 'to-review' || (card.ask && card.status === 'active')) return 'waiting'
  if (state === 'archived' || card.status === 'closed') return 'closed'
  return state === 'working' || turnOf(card).busy ? 'working' : 'resting'
}

/** One line of a channel's stream, with its thread's size and latest time when it stands for a worker. */
export interface Line { message: Message; replies: number; last: number }

/** What a worker says to the human, as distinct from lifecycle lines and what others say to it. */
const SPEAKING: readonly MessageKind[] = ['post', 'ask', 'review', 'turn', 'file', 'tapestry']

/**
 * A channel's stream, as Slack keeps a channel short: everything its chair
 * says, and the human's replies to it, each a line; every other worker one
 * line, what waits on the human from it else the latest thing it said, with
 * its thread's size and latest time. Oldest first, by each line's time. A
 * worker that has said nothing is not in it.
 */
export function channelLines(messages: readonly Message[], channel: Channel): Line[] {
  const lines: Line[] = []
  const workers = new Map<string, KanbanCard>()
  for (const message of messages) {
    if (message.quiet) continue
    if (sameFiber(message.card, channel.seat)) lines.push({ message, replies: 0, last: message.at })
    else workers.set(fiberOf(message.card), message.card)
  }
  for (const card of workers.values()) {
    const thread = threadOf(messages, card)
    const said = thread.filter(message => message.card === card && !message.human && !message.quiet && (SPEAKING.includes(message.kind) || (message.kind === 'closed' && !!message.text)))
    const shown = said.filter(message => message.waiting).at(-1) ?? said.at(-1)
    if (shown) lines.push({ message: shown, replies: thread.length - 1, last: Math.max(...thread.map(message => message.at)) })
  }
  return lines.sort((a, b) => a.message.at - b.message.at || a.message.id.localeCompare(b.message.id))
}
