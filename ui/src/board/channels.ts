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
  /** Who the daemon says wrote it: a member's path, a label, or a session. */
  actor?: string
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
  /** When it was written, by its writer's clock: its place in the stream. */
  at: number
  /** When it reached this daemon: what is new to the reader. */
  arrived: number
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

/** A constitution's tapestry, collapsed to its title, its lede and the address of its first figure. */
export interface Tapestry { path: string; at: number; title: string; lede: string; figure?: string }

/**
 * One channel: the constitutions speaking in a named channel (`shuttle.channel`,
 * a thread inheriting its nearest ancestor's), else an office's top-levels and
 * their threads, else one top-level constitution with its threads.
 */
export interface Channel {
  /** `channel:<shuttle.channel, lowercased>`, `role:<office slug>` for an office's top-levels, or `fiber:<uid>` for a lone top-level. */
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

/** The record that clears a worker's line in its channel: the line stays out while its message is no newer than `at`. */
export const clearKey = (uid: string, at: number): string => `clear:${uid}:${at}`
/** The record that undoes a clear: every clear of the thread up to `at` stops counting. */
export const unclearKey = (uid: string, at: number): string => `unclear:${uid}:${at}`
/** Each thread's newest clear and newest undo, by fiber uid, from the board's dismissal records. */
export type Clears = ReadonlyMap<string, { clear: number; unclear: number }>
export function clearsOf(records: readonly string[]): Clears {
  const clears = new Map<string, { clear: number; unclear: number }>()
  for (const record of records) {
    const match = /^(clear|unclear):(.+):(\d+)$/.exec(record)
    if (!match) continue
    const entry = clears.get(match[2]) ?? clears.set(match[2], { clear: -Infinity, unclear: -Infinity }).get(match[2])!
    const kind = match[1] as 'clear' | 'unclear'
    entry[kind] = Math.max(entry[kind], Number(match[3]))
  }
  return clears
}
/** The time a thread's line stands cleared to, or -Infinity: its newest clear, unless an undo as new voids it. */
export const clearedTo = (clears: Clears, uid: string): number => {
  const entry = clears.get(uid)
  return entry && entry.clear > entry.unclear ? entry.clear : -Infinity
}

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
 * When a card began waiting on the human, or 0 when it does not. Waiting is
 * something addressed to the human that they have not handled: an ask on an
 * active card, or a close awaiting their review. A worker idle at the end of
 * its turn waits on no one. A wait whose time is unknown is 1.
 */
export function waitsSince(card: KanbanCard): number {
  if (card.ask && card.status === 'active') return instant(card.ask.at, card.lastActivityAt, card.dispatchedAt, card.modifiedAt, card.createdAt) || 1
  if (threadState(card) === 'to-review') return instant(card.closedAt, card.reviewMark?.at, card.modifiedAt, card.createdAt) || 1
  return 0
}

/**
 * Every channel the board holds, the chaired ones first, each shelf by name.
 * A card speaks in its own `shuttle.channel`, else its orchestrator's, else
 * that of the nearest card filed above it; without one anywhere above it, its
 * top-level constitution's office names the channel (the named channel that
 * shares the office's charter name, when there is one), else that top-level
 * is a channel of its own. A pin counts
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
  const byId = new Map<string, KanbanCard>()
  for (const card of cards) if (!byId.has(card.id)) byId.set(card.id, card)
  // Without an orchestrator, the nearest card filed above it: closed ancestors are not orchestrators, but they still name a channel.
  const filedUnder = (card: KanbanCard): KanbanCard | undefined => {
    for (let id = card.id; id.includes('/');) {
      id = id.slice(0, id.lastIndexOf('/'))
      const above = byId.get(id)
      if (above) return above
    }
    return undefined
  }
  const channelOf = (card: KanbanCard): string | null => {
    if (named.has(card)) return named.get(card)!
    named.set(card, null)
    const above = parentOf(card) ?? filedUnder(card)
    const name = card.shuttleChannel ?? (above ? channelOf(above) : null)
    named.set(card, name)
    return name
  }
  const officeName = (office: string): string => names.get(office) ?? office
  // An office's channel merges into the named channel that shares its charter's name.
  const keyOf = (card: KanbanCard): string => {
    const name = channelOf(card)
    if (name) return `channel:${name.toLowerCase()}`
    const office = officeOf(topOf(card).shuttleRole)
    if (!office) return `fiber:${fiberOf(topOf(card))}`
    const merged = `channel:${officeName(office).split(' · ')[0].toLowerCase()}`
    return channelNames.has(merged) ? merged : `role:${office}`
  }
  const channelNames = new Set(cards.flatMap(card => { const name = channelOf(card); return name ? [`channel:${name.toLowerCase()}`] : [] }))
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
    if (!titles.has(key) || channelOf(card)) titles.set(key, channelOf(card) ?? (office ? officeName(office) : ''))
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

/** A line the human sent through the daemon (from the board, the Dock or `shuttle dispatch --message`): its record is keyed by the line's `human-…` id. */
export const BOARD_LINE = 'brd-human-'
/** Consecutive messages from one sender this close together are one run, named once. */
export const RUN_MS = 10 * 60_000

/** Who wrote `ref` (a session URI) when no fiber answers for it: the host it ran on. */
const sessionHost = (ref: string | undefined): string | undefined => /^shuttle:\/\/([^/]+)\//.exec(ref ?? '')?.[1]

/**
 * Everything a channel's constitutions said, oldest first: the family board's
 * records about its members, what their cards wait on that the board does not
 * hold, the files they sent (attached to a message close in time, a burst of
 * them one message, else their own), and the chair's tapestry. A message
 * marked `quiet` belongs in its worker's thread only: the human's lines other
 * than those sent from the board to the chair, workers writing to each other,
 * and every lifecycle line (a close that waits on the human's review is a
 * review, and speaks).
 */
export function composeMessages(input: {
  channel: Channel
  records: readonly BoardRecord[]
  files: readonly SentFile[]
  /** Every card on the board, for naming a sender from another channel. */
  cards?: readonly KanbanCard[]
  tapestry?: Tapestry | null
  now: number
  reachMs: number
}): Message[] {
  const { channel, records, files, cards = channel.everyone, tapestry, now, reachMs } = input
  const lookup = (list: readonly KanbanCard[]): Map<string, KanbanCard> => {
    const named = new Map<string, KanbanCard>()
    for (const card of list) for (const ref of [card.uid, card.id]) if (ref && !named.has(ref)) named.set(ref, card)
    return named
  }
  const members = lookup(channel.everyone), everyone = lookup(cards)
  const cardOf = (ref: string | undefined): KanbanCard | undefined => ref ? members.get(ref) : undefined
  const messages: Message[] = []
  const said = (card: KanbanCard, kind: MessageKind, text: string, at: number, over: Partial<Message> = {}): Message => {
    const message: Message = { id: `${kind}:${fiberOf(card)}:${at}`, card, human: false, kind, text, at, arrived: at, files: [], waiting: false, quiet: false, ...over }
    messages.push(message)
    return message
  }
  const reach = now - reachMs
  // Each send is one file, named by its host, path and time; the newest send of a path stands for the others.
  const sends = new Map<string, SentFile>()
  for (const file of files) {
    if (file.timestamp < reach || !file.uid) continue
    const key = `${file.host ?? ''}:${file.fullPath}`
    if ((sends.get(key)?.timestamp ?? -Infinity) < file.timestamp) sends.set(key, file)
  }
  for (const record of records) {
    const card = cardOf(record.fiber)
    if (!card) continue
    const by = record.by ?? {}, text = record.text?.trim() ?? ''
    const base = { id: record.id, arrived: record.received_at ?? record.timestamp }
    // The human's board line is a channel line when it went to the chair; any other stays in its thread.
    const yours = { ...base, human: true, quiet: !(record.id.startsWith(BOARD_LINE) && sameFiber(card, channel.seat)) }
    switch (record.kind) {
      case 'post': {
        // A post claims the send of each file it attaches, unless that path was sent again since.
        const attached = (record.files ?? []).map(path => {
          const key = `${record.originName ?? ''}:${path}`, send = sends.get(key)
          if (send && send.timestamp <= record.timestamp + ATTACH_MS) { sends.delete(key); return send }
          return { fullPath: path, basename: path.split('/').pop() ?? path, timestamp: record.timestamp, uid: fiberOf(card), host: record.originName }
        })
        said(card, 'post', text, record.timestamp, { ...base, files: attached })
        break
      }
      case 'asked':
        said(card, 'ask', text, record.timestamp, base)
        break
      case 'closed':
        said(card, 'closed', record.verdict ?? '', record.timestamp, { ...base, quiet: true })
        break
      case 'handed_off':
        said(card, 'handed_off', '', record.timestamp, { ...base, quiet: true })
        break
      case 'message': {
        const from = by.fiber ? members.get(by.fiber) ?? everyone.get(by.fiber) : undefined
        const label = from ? undefined : by.label ?? (by.fiber ? record.actor : undefined) ?? (sessionHost(by.session) ? `a session on ${sessionHost(by.session)}` : 'another session')
        said(card, 'chat', text, record.timestamp, { ...base, quiet: true, from, label })
        break
      }
      case 'human':
        // Lines typed or spoken in the worker's own terminal belong to that conversation, which Rex shows; the board keeps the ones sent from it.
        if (record.id.startsWith(BOARD_LINE)) said(card, 'reply', text, record.timestamp, yours)
        break
      case 'answered': {
        // The human's answer is recorded with the question it answers.
        const answer = !by.fiber && !by.session && by.label ? /\s—\sA:\s([\s\S]*)$/.exec(text)?.[1] : undefined
        if (answer) said(card, 'reply', answer, record.timestamp, yours)
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
    // A worker stopped at the end of its turn says why when it said so; that waits on no one.
    if (state === 'waiting' && turn.turn === 'blocked' && turn.detail) said(card, 'turn', turn.detail, instant(turn.since, card.lastActivityAt, card.modifiedAt, card.createdAt) || 1)
  }
  const speaking: readonly MessageKind[] = ['post', 'ask', 'review', 'turn']
  for (const file of [...sends.values()].sort((a, b) => b.timestamp - a.timestamp)) {
    const card = cardNamed(channel.everyone, file.uid!, file.host ?? '')
    if (!card) continue
    const near = messages.filter(message => message.card === card && !message.quiet && speaking.includes(message.kind) && Math.abs(message.at - file.timestamp) <= ATTACH_MS)
      .sort((a, b) => Math.abs(a.at - file.timestamp) - Math.abs(b.at - file.timestamp))[0]
    // A burst of files sent together is one message: newest first here, so each joins the burst begun after it.
    const burst = near ?? messages.find(message => message.card === card && message.kind === 'file' && message.files[0].timestamp - file.timestamp <= ATTACH_MS)
    if (burst) burst.files.unshift(file)
    else said(card, 'file', '', file.timestamp, { id: `file:${file.host ?? ''}:${file.fullPath}:${file.timestamp}`, files: [file] })
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
  if (waitsSince(card)) return 'waiting'
  if (state === 'archived' || card.status === 'closed') return 'closed'
  return state === 'working' || turnOf(card).busy ? 'working' : 'resting'
}

/**
 * One line of a channel's stream, with its thread's size and latest time when
 * it stands for a worker, and whether anything in that thread waits on the human.
 */
export interface Line {
  message: Message
  replies: number
  last: number
  waiting: boolean
  /**
   * What its ✓ does: `temper` signs off a close awaiting review, `clear`
   * acknowledges anything else; none while an ask waits, nor on the human's lines.
   */
  act?: 'clear' | 'temper'
  /** Cleared: its message is no newer than its thread's standing clear. */
  cleared?: boolean
}

/** What a worker says to the human, as distinct from lifecycle lines and what others say to it. */
const SPEAKING: readonly MessageKind[] = ['post', 'ask', 'review', 'turn', 'file', 'tapestry']

/**
 * A channel's stream, as Slack keeps a channel short: every worker, its chair
 * included, one line, the latest thing it said (a send of its own tapestry
 * page counting as that tapestry), marked waiting when something of its waits
 * on the human, with its thread's size and latest time; and the human's lines
 * to the chair. Oldest first, by each line's time. A worker that has said
 * nothing is not in it. A line its ✓ would clear is marked cleared while its
 * message is no newer than its thread's standing clear.
 */
export function channelLines(messages: readonly Message[], clears: Clears = new Map()): Line[] {
  const lines: Line[] = []
  const workers = new Map<string, KanbanCard>()
  for (const message of messages) {
    if (message.quiet) continue
    // The human's own words to the chair stand in the channel; every thread, the chair's included, shows only its latest.
    if (message.human) lines.push({ message, replies: 0, last: message.at, waiting: message.waiting })
    else workers.set(fiberOf(message.card), message.card)
  }
  for (const card of workers.values()) {
    const thread = threadOf(messages, card)
    const said = thread.filter(message => message.card === card && !message.human && !message.quiet && SPEAKING.includes(message.kind))
    // A send of the worker's own tapestry page is that tapestry again, not a message of its own.
    const tapestry = said.filter(message => message.kind === 'tapestry').at(-1)
    const latest = said.filter(message => !(tapestry && message.kind === 'file' && message.files.length > 0
      && message.files.every(file => file.fullPath === tapestry.path || file.fullPath.endsWith('/tapestry.html')))).at(-1)
    if (!latest) continue
    const open = said.filter(message => message.waiting)
    const act = open.some(message => message.kind === 'ask') ? undefined : open.some(message => message.kind === 'review') ? 'temper' : 'clear'
    lines.push({
      message: latest, replies: thread.length - 1, last: Math.max(...thread.map(message => message.at)), waiting: open.length > 0,
      act, cleared: act === 'clear' && latest.at <= clearedTo(clears, fiberOf(card)),
    })
  }
  return lines.sort((a, b) => a.message.at - b.message.at || a.message.id.localeCompare(b.message.id))
}

/**
 * Whether `message` continues the run `previous` began: the same sender, said
 * within {@link RUN_MS}, so its sender is not named again.
 */
export function continues(previous: Message | undefined, message: Message): boolean {
  if (!previous || message.at - previous.at > RUN_MS) return false
  const sender = (each: Message): string => each.human ? 'human' : each.from ? fiberOf(each.from) : each.label ?? fiberOf(each.card)
  return sender(previous) === sender(message)
}
