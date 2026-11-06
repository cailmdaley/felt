export interface TranscriptHitFiber { id: string; name: string }

/** A session's best message, as grouped `shuttle transcript search --json` reports it. */
export interface TranscriptHit {
  session: string
  harness: string
  project: string
  path: string
  line: number
  timestamp: string
  role: string
  score: number
  matches: number
  snippet: string
  fibers: TranscriptHitFiber[]
}

export interface TranscriptSearchResult {
  query: string
  index?: { sessions?: number; messages?: number; updated_at?: string }
  hits: TranscriptHit[]
  errors: string[]
}

export interface SearchFilters {
  session?: readonly string[]
  fiber?: string
  since?: string
  harness?: string
  limit?: number
}

function text(value: unknown): string { return typeof value === 'string' ? value : '' }

function hitFrom(raw: unknown): TranscriptHit | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const session = text(row.session)
  if (!session) return null
  const fibers = Array.isArray(row.fibers)
    ? row.fibers.flatMap((fiber): TranscriptHitFiber[] => {
      const entry = fiber as Record<string, unknown> | null
      return entry && text(entry.id) ? [{ id: text(entry.id), name: text(entry.name) }] : []
    })
    : []
  return {
    session,
    harness: text(row.harness),
    project: text(row.project),
    path: text(row.path),
    line: typeof row.line === 'number' ? row.line : 0,
    timestamp: text(row.timestamp),
    role: text(row.role),
    score: typeof row.score === 'number' ? row.score : 0,
    matches: typeof row.matches === 'number' ? row.matches : 1,
    snippet: text(row.snippet),
    fibers,
  }
}

/** Ask the daemon's `/api/v1/transcripts/search`; throws an `Error` whose message is the daemon's own. */
export async function searchTranscripts(
  shuttleBase: string,
  query: string,
  filters: SearchFilters = {},
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<TranscriptSearchResult> {
  const params = new URLSearchParams({ q: query })
  for (const session of filters.session ?? []) params.append('session', session)
  if (filters.fiber) params.set('fiber', filters.fiber)
  if (filters.since) params.set('since', filters.since)
  if (filters.harness) params.set('harness', filters.harness)
  if (filters.limit) params.set('limit', String(filters.limit))
  const send = options.fetch ?? ((input, init) => fetch(input, init))
  const response = await send(`${shuttleBase.replace(/\/$/, '')}/api/v1/transcripts/search?${params}`, { signal: options.signal })
  let body: unknown = null
  try { body = await response.json() } catch { /* not JSON */ }
  const doc = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (!response.ok) {
    const detail = text(doc.detail).split('\n')[0]
    throw new Error(text(doc.error) ? `${text(doc.error)}${detail ? ` — ${detail}` : ''}` : `search failed (${response.status})`)
  }
  if (!Array.isArray(doc.hits)) throw new Error('search answered without hits')
  const index = doc.index && typeof doc.index === 'object' ? doc.index as TranscriptSearchResult['index'] : undefined
  return {
    query: text(doc.query) || query,
    index,
    hits: doc.hits.map(hitFrom).filter((hit): hit is TranscriptHit => hit !== null),
    errors: Array.isArray(doc.errors) ? doc.errors.map(String) : [],
  }
}

/** A snippet's «matched» spans as alternating plain and matched pieces. */
export function snippetPieces(snippet: string): Array<{ text: string; hit: boolean }> {
  const pieces: Array<{ text: string; hit: boolean }> = []
  for (const [index, part] of snippet.split(/[«»]/).entries()) {
    if (part) pieces.push({ text: part, hit: index % 2 === 1 })
  }
  return pieces
}

/** The last path segment of a session's directory. */
export function projectName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? ''
}

/** Where a hit sits in its file, for the reader who has to go and find it by hand. */
export function hitLocation(hit: Pick<TranscriptHit, 'path' | 'line'>): string {
  return hit.line > 0 ? `${hit.path}:${hit.line}` : hit.path
}
