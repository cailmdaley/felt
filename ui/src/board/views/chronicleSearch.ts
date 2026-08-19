/**
 * The Chronicle's search — the pure half.
 *
 * TWO HALVES, TWO CLOCKS. The board already holds every card the composite feed
 * served: ids and names, in memory, on this page. Matching those costs nothing
 * and must not wait for the network, so {@link localHits} runs on every
 * keystroke. What the board does NOT hold is the BODY of every constitution —
 * that is a `felt ls --body` away, behind `GET /api/v1/search` (see
 * lib/shuttle_web/controllers/search_controller.ex), debounced and merged in
 * when it lands. The list you are reading is therefore always current on names
 * and a beat behind on bodies, which is the right way round: a name match is
 * what you usually meant, and it appears instantly.
 *
 * ON THE BOARD vs IN THE RECORD. A local hit is a card the chronicle can draw —
 * clicking it jumps to its lifeline. A remote-only hit is a fiber the record
 * holds but this board is not showing (a constitution closed long before the
 * drawn window, most often), so it can be named and excerpted but not jumped
 * to. `onBoard` carries that difference and the UI renders it, rather than
 * offering a click that silently does nothing.
 *
 * RANK is one scale across both halves, and it is mirrored in the controller so
 * the two lists interleave rather than clumping by origin:
 *
 *   0 exact name or id · 1 name prefix · 2 name substring ·
 *   3 id substring · 4 outcome · 5 body
 */

/** Which field the query was found in. Ordered by the rank they imply. */
export type MatchField = 'name' | 'id' | 'outcome' | 'body'

export interface SearchHit {
  /** The fiber's slug id — the same id `ctx.openCard` and a row's `cardId` use. */
  id: string
  name: string
  where: MatchField[]
  /** The matched text with a little of its surroundings; body/outcome hits only. */
  excerpt: string | null
  rank: number
  /** True when this fiber is a card the board is holding — i.e. jumpable. */
  onBoard: boolean
  /** Present for record hits: `closed`, `open`, … Shown as the hit's register. */
  status: string | null
}

/** One row of `GET /api/v1/search`. */
export interface SearchWireHit {
  id?: unknown
  name?: unknown
  status?: unknown
  where?: unknown
  excerpt?: unknown
  rank?: unknown
}

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

/**
 * Name/id matches over the cards the board is already holding. No network, no
 * debounce — this is what makes the first keystroke feel like a filter rather
 * than a query.
 */
export function localHits(
  cards: ReadonlyArray<{ id: string; name: string }>,
  query: string,
): SearchHit[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []

  const hits: SearchHit[] = []
  const seen = new Set<string>()
  for (const card of cards) {
    if (!card.id || seen.has(card.id)) continue
    const where: MatchField[] = []
    if (card.name.toLowerCase().includes(needle)) where.push('name')
    if (card.id.toLowerCase().includes(needle)) where.push('id')
    if (where.length === 0) continue
    seen.add(card.id)
    hits.push({
      id: card.id,
      name: card.name || card.id,
      where,
      excerpt: null,
      rank: rankOf(where, card.name, card.id, needle),
      onBoard: true,
      status: null,
    })
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
      ? (row.where.filter(
          (w): w is MatchField => w === 'name' || w === 'id' || w === 'outcome' || w === 'body',
        ) as MatchField[])
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
 * A fiber found by both is ONE row: the local half owns `onBoard` (it is the
 * only half that knows what the board is drawing) and the better rank, while
 * the record half contributes the excerpt — which is the whole reason a body
 * match is worth showing. Ties break alphabetically, so the order is stable
 * across the two renders a search does.
 */
export function mergeHits(
  local: readonly SearchHit[],
  remote: readonly SearchHit[],
  boardIds: ReadonlySet<string>,
  limit = 25,
): SearchHit[] {
  const byId = new Map<string, SearchHit>()
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
      byId.set(hit.id, { ...hit, onBoard: boardIds.has(hit.id) })
    }
  }

  return sortHits([...byId.values()]).slice(0, limit)
}

function unionFields(a: readonly MatchField[], b: readonly MatchField[]): MatchField[] {
  const order: MatchField[] = ['name', 'id', 'outcome', 'body']
  return order.filter((f) => a.includes(f) || b.includes(f))
}

function sortHits(hits: SearchHit[]): SearchHit[] {
  return hits.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank
    // A jumpable hit above an unreachable one at equal rank: the click that
    // does something should be the one nearer the cursor.
    if (a.onBoard !== b.onBoard) return a.onBoard ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/** Fetch the record half. Errors answer `[]` — the local half still stands. */
export async function fetchRecordHits(
  shuttleBase: string,
  query: string,
  limit = 25,
): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) })
  const res = await fetch(`${shuttleBase}/api/v1/search?${params.toString()}`)
  if (!res.ok) throw new Error(`${res.status}`)
  return parseSearchResponse(await res.json())
}
