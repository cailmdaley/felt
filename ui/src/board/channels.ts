import { hasLiveWorker, type KanbanCard } from './KanbanTypes.js'
import { clearable, lastActive, wantOf, type Waits } from './attention.js'
import { arrived, type BoardRecord } from './boardFeed.js'
import { latestSends, type SentFile } from './sentFiles.js'
import { slug } from './threadOutline.js'
import { cardNamed } from './threads.js'

/**
 * One channel: the constitutions speaking in a named channel (`shuttle.channel`,
 * a thread inheriting its nearest ancestor's), else an office's top-levels and
 * their threads, else one top-level constitution with its threads.
 */
export interface Channel {
  /** `channel:<shuttle.channel, lowercased>`, `role:<office slug>` for an office's top-levels, or `fiber:<uid>` for a lone top-level. */
  key: string
  /** The office slug for a seatless office, otherwise the chair's slug. */
  name: string
  /** The office's charter name for a seatless office, otherwise the chair's full name. */
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
/** The dismissal record that clears one line of a stream ({@link lineIds}) at `at`, until a later {@link unclearLineKey}. */
export const clearLineKey = (id: string, at: number): string => `line:${at}:${id}`
/** The dismissal record that brings a cleared line back: every clear of it up to `at` stops counting. */
export const unclearLineKey = (id: string, at: number): string => `unline:${at}:${id}`

/** A send's id: the line it is in the stream, whichever item it is drawn in. */
export const sendId = (file: SentFile): string => `file:${file.host ?? ''}:${file.fullPath}:${file.timestamp}`
/** The lines a clear of an item takes, one record each: every send of a file item, else the item itself. */
export const lineIds = (item: Item): string[] => item.sends?.map(sendId) ?? [item.id]

/** The lines cleared by hand, by id, with when: each whose newest clear is newer than its newest undo. */
export function clearedLines(dismissed: readonly string[]): Map<string, number> {
  const latest = { line: new Map<string, number>(), unline: new Map<string, number>() }
  for (const record of dismissed) {
    const match = /^(line|unline):(\d+):(.+)$/.exec(record)
    if (!match) continue
    const into = latest[match[1] as 'line' | 'unline']
    into.set(match[3], Math.max(into.get(match[3]) ?? 0, Number(match[2])))
  }
  return new Map([...latest.line].filter(([id, at]) => at > (latest.unline.get(id) ?? -Infinity)))
}

/** Constitutions a channel speaks for: everything without a verdict. */
const live = (card: KanbanCard): boolean => card.column !== 'tempered' && card.column !== 'composted'
export const fiberOf = (card: KanbanCard): string => card.uid ?? card.id
/** The office a role names: its first path segment. */
export const officeOf = (role: string | undefined): string => role?.split('/')[0] ?? ''

/**
 * Every channel the board holds, the chaired ones first, each shelf by name.
 * A seatless office's channel is written as its office; every other channel
 * uses its chair's slug. A card speaks in its own `shuttle.channel`, else its orchestrator's, else
 * that of the nearest card filed above it; without one anywhere above it, its
 * top-level constitution's office names the channel (the named channel that
 * shares the office's charter name, when there is one), else that top-level
 * is a channel of its own. Something in it waits when a member waits on the
 * human (`wantOf`). A pin counts until
 * a later unpin; a hide counts until a later show or a later wait.
 */
export function composeChannels(input: {
  cards: readonly KanbanCard[]
  parentOf: (card: KanbanCard) => KanbanCard | undefined
  names: ReadonlyMap<string, string>
  dismissed: readonly string[]
  /** Pinned channel keys, each with its latest pin. */
  pinned: ReadonlyMap<string, number>
  /** What waits on the human ({@link BoardFeed.waiting}). */
  waits: Waits
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
  const seen = new Set<string>()
  const groups = new Map<string, { members: KanbanCard[]; everyone: KanbanCard[] }>()
  for (const card of cards) {
    // A uid names one fiber whichever host serves a copy of it.
    if (card.isCycle || seen.has(fiberOf(card))) continue
    seen.add(fiberOf(card))
    const key = keyOf(card)
    const group = groups.get(key) ?? groups.set(key, { members: [], everyone: [] }).get(key)!
    group.everyone.push(card)
    if (live(card)) group.members.push(card)
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
  // The eldest, so a channel keeps its name however its members' activity moves.
  const eldest = (list: KanbanCard[]): KanbanCard | undefined =>
    [...list].sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0) || a.id.localeCompare(b.id))[0]
  const channels: Channel[] = []
  for (const [key, { members, everyone }] of groups) {
    if (!members.length) continue
    const inside = (card: KanbanCard): KanbanCard[] => {
      const above: KanbanCard[] = []
      for (let parent = parentOf(card); parent && keyOf(parent) === key; parent = parentOf(parent)) above.push(parent)
      return above
    }
    // The chair is the topmost seat, a standing one only when no other is; without a seat, a top-level; the eldest of those it finds.
    const seats = members.filter(card => card.shuttleSeat && !inside(card).some(above => above.shuttleSeat))
    const heads = members.filter(card => !inside(card).length)
    const seat = eldest(seats.filter(card => card.shuttleKind !== 'standing')) ?? eldest(seats) ?? eldest(heads) ?? eldest(members)!
    const newest = Math.max(0, ...members.map(card => wantOf(card, input.waits)?.at ?? 0))
    const active = Math.max(0, ...members.map(lastActive))
    const isPinned = (pinned.get(key) ?? -Infinity) > since('pin', key)
    const waiting = newest > 0
    const hidden = since('hide', key) > Math.max(since('show', key), newest) ? since('hide', key) : 0
    const office = key.startsWith('role:') && !seats.length ? key.slice(5) : ''
    channels.push({
      key, name: office || slug(seat), title: office ? officeName(office) : seat.name, chaired: !key.startsWith('fiber:'), seat, members, everyone,
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

/** Something a worker addressed to the human: a question, a post, a close, files sent to them, or a turn that could not start. */
export interface Item {
  kind: 'ask' | 'post' | 'close' | 'file' | 'blocked'
  id: string
  card: KanbanCard
  /** When it was said, by its writer's clock: its place in the stream. */
  at: number
  /** When it reached this daemon: what is new to the reader. */
  arrived: number
  /** The question, the post, a close's review note, or the files' captions; empty for a closing post (the card's outcome) and for files sent without one. */
  text: string
  /** Its files, a path sent more than once at its newest send. */
  files: SentFile[]
  /** A file item's sends not cleared, oldest first, a path sent twice in it each time: what its clear names. */
  sends?: SentFile[]
  /** It waits on the human now. */
  waiting: boolean
  /** A waiting post's line, which the human may clear by hand. */
  clears?: string
  /** The life of its thread it was said in, when the stream draws that life as a line. */
  line?: string
}
/** How a thread's life ended: closed, tempered, discarded, or put to rest. */
export type Ending = 'closed' | 'tempered' | 'discarded' | 'rested'
/**
 * A station on a thread's line, between the items: where a life of the
 * thread starts, a handoff along it (a tick), or where it ends. `line` names
 * the life, `<fiber>:<n>`, which the thread's items on it share.
 */
export interface Station { kind: 'station'; id: string; card: KanbanCard; at: number; what: 'start' | 'tick' | 'end'; end?: Ending; line: string }
export type Entry = Item | Station

/** A close's verdict as the line's terminus. */
const ending = (verdict: string | undefined): Ending => verdict === 'tempered' || verdict === 'discarded' ? verdict : 'closed'
/** Where an entry stands among others at the same time: a start before what it says, an end after. */
const RANK: Readonly<Record<string, number>> = { start: 0, tick: 1, item: 2, end: 3 }
const rank = (entry: Entry): number => RANK[entry.kind === 'station' ? entry.what : 'item']

/** The board records that are a fiber's lines, by the item each makes. */
const LINES: Readonly<Record<string, Item['kind']>> = { asked: 'ask', post: 'post', closed: 'close' }

/**
 * A channel's stream, oldest first. Its items are the posts, questions and
 * closes addressed to the human (each carrying the files it attached) and the
 * files sent to the human on their own, every send a line and a worker's
 * sends close together one item. A post, question or close waits
 * when the board says it does (`waits`); a member that waits with no such
 * line drawn (an open question, a harness prompt, a turn that could not
 * start, a close for the human's review) is its own waiting item. Every item
 * in the board's reach is drawn, as a channel in Slack holds every message,
 * save those the human cleared by hand.
 *
 * Between the items, each thread's lives within the board's reach as
 * stations: a life starts at a launch (`launches`) while none is running, is
 * ticked where it was handed off, and ends at its last close before the next
 * start, its terminus shaped by that close's verdict (a close, a mark for the
 * human's review, then a temper are one tempered end), or at a rest while it
 * runs (a seat or a standing run between runs, a stashed constitution). A launch inside a running life (a resume, a restart) adds
 * nothing. A life whose start is out of reach runs in from the stream's top,
 * as does the life of a thread that said something in reach with none of
 * those there, unless it is closed or at rest; one still running runs out at
 * its foot. An item said within a life is on its
 * line.
 */
export function composeStream(input: {
  channel: Channel
  records: readonly BoardRecord[]
  files: readonly SentFile[]
  /** What waits on the human ({@link BoardFeed.waiting}). */
  waits: Waits
  launches: (card: KanbanCard) => readonly number[]
  /** The lines the human cleared by hand ({@link clearedLines}), by id: none is drawn, and a file item shows only the sends not among them. */
  cleared: ReadonlyMap<string, number>
  now: number
  reachMs: number
}): Entry[] {
  const { channel, records, files, waits, launches, cleared, now, reachMs } = input
  const reach = now - reachMs
  const named = new Map<string, KanbanCard>()
  for (const card of channel.everyone) for (const ref of [card.uid, card.id]) if (ref && !named.has(ref)) named.set(ref, card)
  const items = new Map<string, Item[]>()
  const say = (item: Item): Item => {
    const list = items.get(fiberOf(item.card)) ?? items.set(fiberOf(item.card), []).get(fiberOf(item.card))!
    list.push(item)
    return item
  }
  // What each thread's line is made of: its launches, handoffs and closes, by fiber.
  const events = new Map<string, LifeEvent[]>()
  const event = (card: KanbanCard, at: number, what: LifeEvent['what'], id: string, verdict?: string): void => {
    const list = events.get(fiberOf(card)) ?? events.set(fiberOf(card), []).get(fiberOf(card))!
    list.push({ at, what, id, verdict })
  }
  // A file a line attached is that line's, not a send of its own: the send of it nearest the line in time.
  const claimed = new Set<SentFile>()
  const attached = (record: BoardRecord): SentFile[] => (record.files ?? []).map(path => {
    const distance = (file: SentFile): number => Math.abs(file.timestamp - record.timestamp)
    const send = files.filter(file => file.fullPath === path && file.uid === record.fiber && distance(file) <= BURST_MS)
      .reduce<SentFile | undefined>((near, file) => near && distance(near) <= distance(file) ? near : file, undefined)
    if (send) claimed.add(send)
    return send ?? { fullPath: path, basename: path.split('/').pop() ?? path, uid: record.fiber, timestamp: record.timestamp }
  })
  for (const record of records) {
    const card = record.fiber ? named.get(record.fiber) : undefined
    if (!card || record.timestamp < reach) continue
    const files = attached(record), kind = LINES[record.kind]
    if (record.kind === 'handed_off') event(card, record.timestamp, 'tick', record.id)
    if (record.kind === 'closed') event(card, record.timestamp, 'close', record.id, record.verdict)
    if (record.kind === 'rested') event(card, record.timestamp, 'rest', record.id)
    if (kind && toPerson(record.to)) {
      const text = record.text?.trim() ?? ''
      // A line waits as what its card wants of the human: an open ask stands before a post it made since.
      const want = wantOf(card, waits)
      const waiting = want?.line?.id === record.id
      say({ kind, id: record.id, card, at: record.timestamp, arrived: arrived(record), text: kind === 'close' && text === card.outcome?.trim() ? '' : text, files, waiting, ...waiting && clearable(want) ? { clears: fiberOf(card) } : {} })
    }
  }
  for (const card of channel.everyone) {
    for (const at of launches(card)) if (at >= reach) event(card, at, 'launch', `started:${fiberOf(card)}:${at}`)
    const want = wantOf(card, waits)
    if (!want || items.get(fiberOf(card))?.some(item => item.waiting)) continue
    const kind = ({ ask: 'ask', review: 'close', post: 'post', blocked: 'blocked' } as const)[want.kind]
    const text = want.kind === 'review' ? card.reviewMark?.note ?? '' : want.text
    say({ kind, id: `${want.kind}:${fiberOf(card)}:${want.at}`, card, at: want.at, arrived: want.at, text, files: [], waiting: true, ...clearable(want) ? { clears: fiberOf(card) } : {} })
  }
  // Every send is a line; a worker's sends this close together are one item.
  const sends = files.filter(file => file.timestamp >= reach && file.uid && !claimed.has(file)).sort((a, b) => a.timestamp - b.timestamp)
  for (const file of sends) {
    const card = cardNamed(channel.everyone, file.uid!, file.host ?? '')
    if (!card) continue
    const burst = items.get(fiberOf(card))?.filter(item => item.kind === 'file' && file.timestamp - item.files.at(-1)!.timestamp <= BURST_MS).at(-1)
    if (burst) burst.files.push(file)
    else say({ kind: 'file', id: '', card, at: file.timestamp, arrived: file.timestamp, text: '', files: [file], waiting: false })
  }
  // A clear names each line it took: a file item holds the sends not cleared, named by its first, shows a path sent twice among them at its newest, and goes when none is left.
  const stream: Entry[] = []
  for (const list of items.values()) for (const item of list) {
    if (item.kind === 'file') {
      item.sends = item.files.filter(file => !cleared.has(sendId(file)))
      if (!item.sends.length) continue
      item.files = latestSends(item.sends, file => `${file.host ?? ''}\u0000${file.fullPath}`)
      item.id = sendId(item.sends[0])
      item.at = item.arrived = item.files.at(-1)!.timestamp
      item.text = [...new Set(item.files.flatMap(file => file.caption?.trim() || []))].join(' · ')
    } else if (cleared.has(item.id)) continue
    stream.push(item)
  }
  for (const card of channel.everyone) {
    const lives = livesOf(card, events.get(fiberOf(card)) ?? [])
    // Something said in reach, cleared or not, and no launch, handoff, rest or close there: a life begun before the reach, running unless it has stopped since.
    if (!lives.length && card.status !== 'closed' && card.column !== 'resting' && card.column !== 'roles' && items.has(fiberOf(card))) {
      lives.push({ line: `${fiberOf(card)}:0`, from: -Infinity, to: Infinity, stations: [] })
    }
    stream.push(...lives.flatMap(life => life.stations))
    for (const item of stream) {
      if (item.kind === 'station' || item.card !== card) continue
      const life = lives.find(each => each.from <= item.at && item.at <= each.to)
      if (life) item.line = life.line
    }
  }
  // At one instant, one thread's earlier life comes before its later one: its end, then the next start.
  const life = (entry: Entry): number => Number(entry.line?.slice(entry.line.lastIndexOf(':') + 1) ?? 0)
  return stream.sort((a, b) => a.at - b.at || (a.card === b.card ? life(a) - life(b) : 0) || rank(a) - rank(b) || a.id.localeCompare(b.id))
}

/** The threads running in a channel now: each with a live worker, once per fiber. */
export function runningIn(channel: Channel): KanbanCard[] {
  return [...new Map(channel.everyone.filter(hasLiveWorker).map(card => [fiberOf(card), card])).values()]
}

/** What a thread's line is made of: a launch, a handoff, a close (with its verdict), or a rest. */
interface LifeEvent { at: number; what: 'launch' | 'tick' | 'close' | 'rest'; id: string; verdict?: string }

/** A thread's lives, oldest first: each its stations and the span its items fall in. */
function livesOf(card: KanbanCard, events: readonly LifeEvent[]): Array<{ line: string; from: number; to: number; stations: Station[] }> {
  const lives: Array<{ line: string; from: number; to: number; stations: Station[] }> = []
  let open: (typeof lives)[number] | undefined
  const begin = (from: number, start?: { at: number; id: string }): (typeof lives)[number] => {
    const line = `${fiberOf(card)}:${lives.length}`
    const life = { line, from, to: Infinity, stations: start ? [{ kind: 'station' as const, id: start.id, card, at: start.at, what: 'start' as const, line }] : [] }
    lives.push(life)
    return life
  }
  // A close or a rest and a launch at one instant: the end comes before the launch starts the next.
  const order = { close: 0, rest: 0, launch: 1, tick: 2 }
  for (const event of [...events].sort((a, b) => a.at - b.at || order[a.what] - order[b.what])) {
    if (event.what === 'launch') { open ??= begin(event.at, event); continue }
    const last = lives.at(-1)
    if (event.what === 'tick') {
      // A handoff with no life running: the life began out of reach.
      if (!open && !last) open = begin(-Infinity)
      if (open) open.stations.push({ kind: 'station', id: event.id, card, at: event.at, what: 'tick', line: open.line })
      continue
    }
    const end = event.what === 'rest' ? 'rested' : ending(event.verdict)
    if (open) {
      open.to = event.at
      open.stations.push({ kind: 'station', id: event.id, card, at: event.at, what: 'end', end, line: open.line })
      open = undefined
    } else if (last) {
      // A rest with no life running ends nothing: the life ended already keeps its end.
      if (event.what === 'rest') continue
      // A close after the close (a mark for review, a verdict): the same end, moved to it and shaped as it says.
      Object.assign(last.stations.at(-1)!, { id: event.id, at: event.at, end })
      last.to = event.at
    } else {
      const life = begin(-Infinity)
      life.to = event.at
      life.stations.push({ kind: 'station', id: event.id, card, at: event.at, what: 'end', end, line: life.line })
    }
  }
  return lives
}
