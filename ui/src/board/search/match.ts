/**
 * The board's search, the pure half: what matches a query, in what order.
 *
 * TWO HALVES, TWO CLOCKS. The board already holds every card the composite feed
 * served, the channels its cards make, what the family board said in its reach
 * and the fleet's sent documents, all in memory on this page. Matching those
 * costs nothing and must not wait for the network, so the local matchers here
 * run on every keystroke. What the board does NOT hold is the BODY of every
 * constitution: that is a `felt ls --body` away, behind `GET /api/v1/search`
 * (daemon/lib/shuttle_web/controllers/search_controller.ex), debounced and
 * merged in when it lands. A list is therefore always current on names and a
 * beat behind on bodies, which is the right way round: a name match is what
 * you usually meant, and it appears instantly.
 *
 * ON THE BOARD vs IN THE RECORD. A local hit is a card the board holds, which a
 * pick can reach. A record-only hit is a fiber the record holds but this board
 * is not showing (a constitution closed long before the board's reach, most
 * often); the route names no owner, so it can be named and excerpted but not
 * opened. `onBoard` carries that difference.
 *
 * RANK is one scale across both halves, and it is mirrored in the controller so
 * the two lists interleave rather than clumping by origin:
 *
 *   0 exact name or id · 1 name prefix · 2 name substring ·
 *   3 id substring · 4 outcome · 5 body
 */

import { getDaemonJson } from '../daemonApi.js'
import { toPerson, type Entry } from '../channels.js'
import type { BoardRecord } from '../boardFeed.js'

/** Which field the query was found in. Ordered by the rank they imply. */
export type MatchField = 'name' | 'id' | 'outcome' | 'body'

export interface SearchHit<C = unknown> {
  /** The fiber's slug id. */
  id: string
  name: string
  where: MatchField[]
  /** The matched text with a little of its surroundings; body/outcome hits only. */
  excerpt: string | null
  rank: number
  /** True when this fiber is a card the board is holding. */
  onBoard: boolean
  /** The board's card for it, when it holds one. */
  card?: C
  /** Present for record hits: `closed`, `open`, … Shown as the hit's register. */
  status: string | null
}

/** One row of `GET /api/v1/search`. */
interface SearchWireHit {
  id?: unknown
  name?: unknown
  status?: unknown
  where?: unknown
  excerpt?: unknown
  rank?: unknown
}

/** A query as the matchers compare it: trimmed and lowercased. */
export const needleOf = (query: string): string => query.trim().toLowerCase()

/** Whether `text` holds the needle, ignoring case; an empty needle holds nowhere. */
export const holds = (text: string | undefined, needle: string): boolean => !!needle && !!text && text.toLowerCase().includes(needle)

/** The rank a name/id match earns. Mirrors `rank/4` in the controller. */
export function rankOf(where: MatchField[], name: string, id: string, needle: string): number {
  const n = name.toLowerCase()
  if (n === needle || id.toLowerCase() === needle) return 0
  if (n.startsWith(needle)) return 1
  if (where.includes('name')) return 2
  if (where.includes('id')) return 3
  if (where.includes('outcome')) return 4
  return 5
}

/** Name/id matches over the cards the board is already holding, each carrying its card. */
export function localHits<C extends { id: string; name: string }>(cards: readonly C[], query: string): SearchHit<C>[] {
  const needle = needleOf(query)
  if (!needle) return []
  const hits: SearchHit<C>[] = []
  const seen = new Set<string>()
  for (const card of cards) {
    if (!card.id || seen.has(card.id)) continue
    const where: MatchField[] = []
    if (holds(card.name, needle)) where.push('name')
    if (holds(card.id, needle)) where.push('id')
    if (where.length === 0) continue
    seen.add(card.id)
    hits.push({ id: card.id, name: card.name || card.id, where, excerpt: null, rank: rankOf(where, card.name, card.id, needle), onBoard: true, card, status: null })
  }
  return sortHits(hits)
}

/** Read the daemon's answer into hits. Unknown shapes are dropped, not thrown. */
export function parseSearchResponse(payload: unknown): SearchHit[] {
  const rows = (payload as { results?: unknown })?.results
  if (!Array.isArray(rows)) return []
  const out: SearchHit[] = []
  for (const row of rows as SearchWireHit[]) {
    const id = typeof row?.id === 'string' ? row.id : ''
    if (!id) continue
    const where = Array.isArray(row.where)
      ? row.where.filter((w): w is MatchField => w === 'name' || w === 'id' || w === 'outcome' || w === 'body')
      : []
    out.push({
      id,
      name: typeof row.name === 'string' && row.name ? row.name : id,
      where,
      excerpt: typeof row.excerpt === 'string' && row.excerpt ? row.excerpt : null,
      rank: typeof row.rank === 'number' ? row.rank : 5,
      // Corrected by `mergeHits` against the cards actually on the board.
      onBoard: false,
      status: typeof row.status === 'string' && row.status ? row.status : null,
    })
  }
  return out
}

/**
 * One list out of the two halves.
 *
 * A fiber found by both is ONE row: the local half owns its card and the better
 * rank, while the record half contributes the excerpt, which is the whole
 * reason a body match is worth showing. A record hit the board holds takes its
 * card from `board`. Ties break alphabetically, so the order is stable across
 * the two renders a search does.
 */
export function mergeHits<C>(
  local: readonly SearchHit<C>[],
  remote: readonly SearchHit[],
  board: ReadonlyMap<string, C>,
  limit = 25,
): SearchHit<C>[] {
  const byId = new Map<string, SearchHit<C>>()
  for (const hit of local) byId.set(hit.id, { ...hit, onBoard: true })
  for (const hit of remote) {
    const held = byId.get(hit.id)
    if (held) {
      byId.set(hit.id, {
        ...held,
        rank: Math.min(held.rank, hit.rank),
        where: unionFields(held.where, hit.where),
        excerpt: held.excerpt ?? hit.excerpt,
        status: held.status ?? hit.status,
      })
    } else {
      const card = board.get(hit.id)
      byId.set(hit.id, { ...hit, card, onBoard: card !== undefined })
    }
  }
  return sortHits([...byId.values()]).slice(0, limit)
}

function unionFields(a: readonly MatchField[], b: readonly MatchField[]): MatchField[] {
  const order: MatchField[] = ['name', 'id', 'outcome', 'body']
  return order.filter((f) => a.includes(f) || b.includes(f))
}

function sortHits<C>(hits: SearchHit<C>[]): SearchHit<C>[] {
  return hits.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank
    // A reachable hit above an unreachable one at equal rank: the pick that
    // does something should be the one nearer the cursor.
    if (a.onBoard !== b.onBoard) return a.onBoard ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/** Fetch the record half. Rejects on a failed request; the caller keeps the local half standing. */
export async function fetchRecordHits(shuttleBase: string, query: string, limit = 25, signal?: AbortSignal): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) })
  return parseSearchResponse(await getDaemonJson(`${shuttleBase}/api/v1/search?${params}`, 'Search failed', signal ? { signal } : undefined))
}

/** A channel as the matchers read it. */
interface Searchable { key: string; name: string; title: string; members: ReadonlyArray<{ name: string; path: string }> }

/** A channel answers to its key, its name, its chair's title and its members' names and paths. */
export function channelMatches(channel: Searchable, needle: string): boolean {
  return [channel.key.slice(channel.key.indexOf(':') + 1), channel.name, channel.title, ...channel.members.flatMap(card => [card.name, card.path])].some(text => holds(text, needle))
}

/** The channels a query finds, the tighter match first: by name (exact, then prefix, then anywhere), then the chair's title, then a member. */
export function channelHits<C extends Searchable>(channels: readonly C[], query: string): C[] {
  const needle = needleOf(query)
  if (!needle) return []
  const rank = (channel: C): number => {
    const name = channel.name.toLowerCase()
    return name === needle ? 0 : name.startsWith(needle) ? 1 : holds(name, needle) ? 2 : holds(channel.title, needle) ? 3 : 4
  }
  return channels.filter(channel => channelMatches(channel, needle))
    .map(channel => ({ channel, rank: rank(channel) }))
    .sort((a, b) => a.rank - b.rank || a.channel.name.localeCompare(b.channel.name))
    .map(({ channel }) => channel)
}

/** The board records a channel draws as lines to the human: a post, a question or a close, addressed to the person, with words. */
const SAID_KINDS = new Set(['post', 'asked', 'closed'])
export const isSaid = (record: BoardRecord): boolean => SAID_KINDS.has(record.kind) && toPerson(record.to) && !!record.text?.trim()

export interface SaidHit<C> { record: BoardRecord; card: C; excerpt: string }

/** What was said that holds the query, newest first, each record once and only from a fiber the board holds. */
export function saidHits<C>(records: readonly BoardRecord[], cardOf: (uid: string) => C | undefined, query: string): SaidHit<C>[] {
  const needle = needleOf(query)
  if (!needle) return []
  const hits: SaidHit<C>[] = []
  const seen = new Set<string>()
  for (const record of records) {
    if (seen.has(record.id) || !isSaid(record) || !holds(record.text, needle)) continue
    const card = record.fiber ? cardOf(record.fiber) : undefined
    if (card === undefined) continue
    seen.add(record.id)
    hits.push({ record, card, excerpt: excerpt(record.text!, needle) })
  }
  return hits.sort((a, b) => b.record.timestamp - a.record.timestamp || a.record.id.localeCompare(b.record.id))
}

/** A sent document as the matchers read it. */
interface Document { card: { name: string }; receipt: { key: string; basename: string; fullPath: string } }

/** Sent documents answering to the query by basename, path, declared title or their fiber's name, in the order given. */
export function documentHits<D extends Document>(documents: readonly D[], titleOf: (key: string) => string | undefined, query: string): D[] {
  const needle = needleOf(query)
  if (!needle) return []
  return documents.filter(({ card, receipt }) => [receipt.basename, receipt.fullPath, titleOf(receipt.key), card.name].some(text => holds(text, needle)))
}

/**
 * The words around the first place `needle` stands in `text`, on one line,
 * about `room` characters long and cut at word edges, with an ellipsis where
 * it was cut. Text without the needle is cut from its start.
 */
export function excerpt(text: string, needle: string, room = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= room) return flat
  const at = Math.max(0, flat.toLowerCase().indexOf(needle))
  let from = Math.max(0, at - Math.floor((room - needle.length) / 3))
  let to = Math.min(flat.length, from + room)
  from = Math.max(0, to - room)
  if (from > 0) { const space = flat.indexOf(' ', from); if (space >= 0 && space < at) from = space + 1 }
  if (to < flat.length) { const space = flat.lastIndexOf(' ', to); if (space > at + needle.length) to = space }
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`
}

/** `text` as alternating plain and matched pieces, every place the needle stands matched, case kept. */
export function pieces(text: string, needle: string): Array<{ text: string; hit: boolean }> {
  if (!needle) return text ? [{ text, hit: false }] : []
  const out: Array<{ text: string; hit: boolean }> = []
  const lower = text.toLowerCase()
  let from = 0
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
    if (at > from) out.push({ text: text.slice(from, at), hit: false })
    out.push({ text: text.slice(at, at + needle.length), hit: true })
    from = at + needle.length
  }
  if (from < text.length) out.push({ text: text.slice(from), hit: false })
  return out
}

/** Whether a stream row answers to the needle: a line by its words and its files' names and captions; a thread's start by the thread's name or slug. */
export function entryMatches(entry: Entry, needle: string): boolean {
  if (!needle) return false
  if (entry.kind === 'station') return entry.what === 'start' && [entry.card.name, entry.card.id.split('/').pop()].some(text => holds(text, needle))
  return holds(entry.text, needle) || entry.files.some(file => holds(file.basename, needle) || holds(file.caption, needle))
}

/** A stream folded to what a query finds. */
export interface Folded {
  /** The rows still drawn, oldest first: every match, and the start and end of each life a matched line is on, so its thread is drawn whole. */
  entries: Entry[]
  /** How many rows are folded away before each drawn row, and (the last) after the last of them. */
  gaps: number[]
  /** The ids of the drawn rows that match. */
  hits: Set<string>
}

/** Folds a channel's stream to the rows that answer to `query`. */
export function foldStream(stream: readonly Entry[], query: string): Folded {
  const needle = needleOf(query)
  const hits = new Set(stream.filter(entry => entryMatches(entry, needle)).map(entry => entry.id))
  const lines = new Set(stream.filter(entry => hits.has(entry.id) && entry.line).map(entry => entry.line!))
  const entries: Entry[] = [], gaps: number[] = []
  let gap = 0
  for (const entry of stream) {
    const shape = entry.kind === 'station' && entry.what !== 'tick' && !!entry.line && lines.has(entry.line)
    if (!hits.has(entry.id) && !shape) { gap++; continue }
    entries.push(entry)
    gaps.push(gap)
    gap = 0
  }
  gaps.push(gap)
  return { entries, gaps, hits }
}

/** The drawn rows that match, in stream order: what ↑ and ↓ step between. */
export const matchedRows = (folded: Folded): Entry[] => folded.entries.filter(entry => folded.hits.has(entry.id))

