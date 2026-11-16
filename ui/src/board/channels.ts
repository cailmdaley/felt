import type { KanbanCard } from './KanbanTypes.js'
import { arrived, type BoardFeed, type BoardRecord } from './boardFeed.js'
import type { SentFile } from './sentFiles.js'
import { slug } from './threadOutline.js'
import { cardNamed, threadState, type ThreadState } from './threads.js'

/**
 * One channel: the constitutions speaking in a named channel (`shuttle.channel`,
 * a thread inheriting its nearest ancestor's), else an office's top-levels and
 * their threads, else one top-level constitution with its threads.
 */
export interface Channel {
  /** `channel:<shuttle.channel, lowercased>`, `role:<office slug>` for an office's top-levels, or `fiber:<uid>` for a lone top-level. */
  key: string
  /** The channel's name; an office's charter name before any ` · ` gloss; a lone constitution's slug. */
  name: string
  /** The name in full: a charter's gloss included, a lone constitution's own name. */
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
  /** Something in it waits on the human. */
  waiting: boolean
  /** Its members' latest activity. */
  active: number
  pinned: boolean
  /** When it was taken out of the rail, nothing having begun waiting in it since; 0 when it is not hidden. */
  hidden: number
  /** In the rail: not hidden, and waiting, pinned, or active within {@link RECENT_MS}. */
  listed: boolean
}

/** How a channel is written, as Slack writes one: a chaired channel's name lowercased, its spaces hyphens; a lone constitution's slug as it is. */
export const handle = (channel: Pick<Channel, 'name' | 'chaired'>): string =>
  channel.chaired ? channel.name.toLowerCase().replace(/\s+/g, '-') : channel.name

/** A channel active within this long stays in the rail. */
export const RECENT_MS = 7 * 86_400_000
/** Files a worker sends this close together are one item. */
export const BURST_MS = 10 * 60_000

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
 * is a channel of its own. Something in it waits when a card waits
 * (`waitsSince`) or `waiting` names a member's question or close. A pin counts until
 * a later unpin; a hide counts until a later show or a later wait.
 */
export function composeChannels(input: {
  cards: readonly KanbanCard[]
  parentOf: (card: KanbanCard) => KanbanCard | undefined
  names: ReadonlyMap<string, string>
  dismissed: readonly string[]
  /** Pinned channel keys, each with its latest pin. */
  pinned: ReadonlyMap<string, number>
  /** When each fiber's question or close began waiting on the human ({@link BoardFeed.waiting}). */
  waiting: ReadonlyMap<string, { at: number }>
  now: number
}): Channel[] {
  const { cards, parentOf, names, dismissed, pinned, now } = input
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
  // `pin:<key>:<ms>` unpins the pins up to <ms>; `hide:<key>:<ms>` takes it out of the rail until something waits after <ms>;
  // `show:<key>:<ms>` voids the hides up to <ms>.
  const latest: Record<string, Map<string, number>> = { pin: new Map(), hide: new Map(), show: new Map() }
  for (const record of dismissed) {
    const match = /^(pin|hide|show):(.+):(\d+)$/.exec(record)
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
    const newest = Math.max(0, ...members.map(card => Math.max(waitsSince(card), input.waiting.get(fiberOf(card))?.at ?? 0)))
    const active = Math.max(0, ...members.map(lastActive))
    const isPinned = (pinned.get(key) ?? -Infinity) > since('pin', key)
    const waiting = newest > 0
    const hidden = since('hide', key) > Math.max(since('show', key), newest) ? since('hide', key) : 0
    const title = titles.get(key) || seat.name
    channels.push({
      key, name: key.startsWith('fiber:') ? slug(seat) : title.split(' · ')[0], title, chaired: !key.startsWith('fiber:'), seat, members, everyone,
      families: [...new Set(members.map(card => fiberOf(topOf(card))))],
      newest, waiting, active, pinned: isPinned, hidden,
      listed: !hidden && (waiting || isPinned || now - active <= RECENT_MS),
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

/** Who a line is for, when it is a person: a label with no fiber or session. */
export const toPerson = (to: BoardRecord['to']): boolean => !!to?.label && !to.fiber && !to.session

/** Something a worker addressed to the human: a question, a post, a close, or files sent to them. */
export interface Item {
  kind: 'ask' | 'post' | 'close' | 'file'
  id: string
  card: KanbanCard
  /** When it was said, by its writer's clock: its place in the stream. */
  at: number
  /** When it reached this daemon: what is new to the reader. */
  arrived: number
  /** The question, the post, a close's review note, or the files' captions; empty for a closing post (the card's outcome) and for files sent without one. */
  text: string
  files: SentFile[]
  /** It waits on the human now. */
  waiting: boolean
}
/** A thread started, closed or handed off: a small mark between the items. */
export interface Mark { kind: 'mark'; id: string; card: KanbanCard; at: number; what: 'started' | 'closed' | 'handed off' }
export type Entry = Item | Mark

/** The board records that are a fiber's lines, by the item each makes. */
const LINES: Readonly<Record<string, Item['kind']>> = { asked: 'ask', post: 'post', closed: 'close' }

/**
 * A channel's stream, oldest first. Its items are the posts, questions and
 * closes addressed to the human (each carrying the files it attached) and the
 * files sent to the human on their own, each path at its newest send and a
 * worker's sends close together one item. A question or close waits when
 * `waiting` names it, a post never; a card that waits with no such line (an
 * open question, a close for the human's review) is its own waiting item. Each worker shows
 * once: the item that waits, else its latest. Between the items, a mark for
 * every thread started (`launches`), handed off, or closed to anyone but the
 * human, within the board's reach.
 */
export function composeStream(input: {
  channel: Channel
  records: readonly BoardRecord[]
  files: readonly SentFile[]
  /** The question or close each fiber waits on the human with ({@link BoardFeed.waiting}). */
  waiting: ReadonlyMap<string, { id: string }>
  launches: (card: KanbanCard) => readonly number[]
  now: number
  reachMs: number
}): Entry[] {
  const { channel, records, files, waiting, launches, now, reachMs } = input
  const reach = now - reachMs
  const named = new Map<string, KanbanCard>()
  for (const card of channel.everyone) for (const ref of [card.uid, card.id]) if (ref && !named.has(ref)) named.set(ref, card)
  const items = new Map<string, Item[]>(), marks: Mark[] = []
  const say = (item: Item): Item => {
    const list = items.get(fiberOf(item.card)) ?? items.set(fiberOf(item.card), []).get(fiberOf(item.card))!
    list.push(item)
    return item
  }
  const mark = (card: KanbanCard, what: Mark['what'], at: number, id: string): void => { marks.push({ kind: 'mark', id, card, at, what }) }
  // A file a line attached is that line's, not a send of its own.
  const claimed = new Set<SentFile>()
  const attached = (record: BoardRecord): SentFile[] => (record.files ?? []).map(path => {
    const send = files.find(file => file.fullPath === path && file.uid === record.fiber && Math.abs(file.timestamp - record.timestamp) <= BURST_MS)
    if (send) claimed.add(send)
    return send ?? { fullPath: path, basename: path.split('/').pop() ?? path, uid: record.fiber, timestamp: record.timestamp }
  })
  for (const record of records) {
    const card = record.fiber ? named.get(record.fiber) : undefined
    if (!card || record.timestamp < reach) continue
    const files = attached(record), kind = LINES[record.kind]
    if (record.kind === 'handed_off') mark(card, 'handed off', record.timestamp, record.id)
    else if (kind && toPerson(record.to)) {
      const text = record.text?.trim() ?? ''
      say({ kind, id: record.id, card, at: record.timestamp, arrived: arrived(record), text: kind === 'close' && text === card.outcome?.trim() ? '' : text, files, waiting: waiting.get(fiberOf(card))?.id === record.id })
    } else if (kind === 'close') mark(card, 'closed', record.timestamp, record.id)
  }
  for (const card of channel.everyone) {
    for (const at of launches(card)) if (at >= reach) mark(card, 'started', at, `started:${fiberOf(card)}:${at}`)
    const at = waitsSince(card)
    if (!at || items.get(fiberOf(card))?.some(item => item.waiting)) continue
    if (card.ask && card.status === 'active') say({ kind: 'ask', id: `ask:${fiberOf(card)}`, card, at, arrived: at, text: card.ask.text, files: [], waiting: true })
    else say({ kind: 'close', id: `review:${fiberOf(card)}:${at}`, card, at, arrived: at, text: card.reviewMark?.note ?? '', files: [], waiting: true })
  }
  // Each path at its newest send; a worker's sends this close together are one item.
  const sends = new Map<string, SentFile>()
  for (const file of files) {
    if (file.timestamp < reach || !file.uid || claimed.has(file)) continue
    const key = `${file.host ?? ''}:${file.fullPath}`
    if ((sends.get(key)?.timestamp ?? -Infinity) < file.timestamp) sends.set(key, file)
  }
  for (const file of [...sends.values()].sort((a, b) => a.timestamp - b.timestamp)) {
    const card = cardNamed(channel.everyone, file.uid!, file.host ?? '')
    if (!card) continue
    const burst = items.get(fiberOf(card))?.find(item => item.kind === 'file' && file.timestamp - item.files.at(-1)!.timestamp <= BURST_MS)
    if (burst) { burst.files.push(file); burst.at = burst.arrived = file.timestamp }
    else say({ kind: 'file', id: `file:${file.host ?? ''}:${file.fullPath}:${file.timestamp}`, card, at: file.timestamp, arrived: file.timestamp, text: '', files: [file], waiting: false })
  }
  const stream: Entry[] = marks
  for (const list of items.values()) {
    for (const item of list) if (item.kind === 'file') item.text = [...new Set(item.files.flatMap(file => file.caption?.trim() || []))].join(' · ')
    const latest = [...list].sort((a, b) => a.at - b.at)
    stream.push(latest.filter(item => item.waiting).at(-1) ?? latest.at(-1)!)
  }
  return stream.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}
