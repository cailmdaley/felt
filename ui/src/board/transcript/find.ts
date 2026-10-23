import type { Turn } from './model.js'

/** One message a query matched: a turn's prompt, or one of its agent texts. */
export interface Match {
  turn: number
  /** The step index of an agent text; absent for the turn's prompt. */
  step?: number
  /** When the message was recorded, where the record carries it. */
  at?: number
}

/** The words a query asks for: whitespace-separated, case-folded, duplicates dropped. */
export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]
}

/** A message matches when every term appears in it, as the index requires. */
export function containsAll(text: string, terms: readonly string[]): boolean {
  if (!terms.length) return false
  const folded = text.toLowerCase()
  return terms.every((term) => folded.includes(term))
}

/** Every message of `turns` that holds all of `terms`, in the order they were said. */
export function findMatches(turns: readonly Turn[], terms: readonly string[]): Match[] {
  const found: Match[] = []
  if (!terms.length) return found
  for (const turn of turns) {
    if (turn.prompt && containsAll(turn.prompt.text, terms)) {
      found.push({ turn: turn.index, ...(turn.prompt.at === undefined ? {} : { at: turn.prompt.at }) })
    }
    turn.steps.forEach((step, index) => {
      if (step.kind === 'text' && containsAll(step.text, terms)) {
        found.push({ turn: turn.index, step: index, ...(step.at === undefined ? {} : { at: step.at }) })
      }
    })
  }
  return found
}

/** The match nearest `time` in the clock; the first when there is no time to go by. */
export function nearestMatch(matches: readonly Match[], time: number | undefined): number {
  if (!matches.length) return -1
  if (time === undefined) return 0
  let best = 0
  let gap = Infinity
  matches.forEach((match, index) => {
    if (match.at === undefined) return
    const distance = Math.abs(match.at - time)
    if (distance < gap) { gap = distance; best = index }
  })
  return best
}

/** A regular expression that finds any of `terms`, or null when there are none. */
export function termPattern(terms: readonly string[]): RegExp | null {
  if (!terms.length) return null
  const alternatives = [...terms].sort((a, b) => b.length - a.length).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(alternatives.join('|'), 'gi')
}

/**
 * Wrap every occurrence of `pattern` under `root` in a `<mark>`. Text nodes
 * are split in place, so the markup around them is untouched.
 */
export function markTerms(root: HTMLElement, pattern: RegExp, className: string): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  let count = 0
  for (const node of nodes) {
    const text = node.data
    pattern.lastIndex = 0
    const pieces: Array<string | HTMLElement> = []
    let from = 0
    for (let hit = pattern.exec(text); hit; hit = pattern.exec(text)) {
      if (!hit[0]) { pattern.lastIndex++; continue }
      if (hit.index > from) pieces.push(text.slice(from, hit.index))
      const mark = document.createElement('mark')
      mark.className = className
      mark.textContent = hit[0]
      pieces.push(mark)
      from = hit.index + hit[0].length
      count++
    }
    if (!pieces.length) continue
    if (from < text.length) pieces.push(text.slice(from))
    node.replaceWith(...pieces)
  }
  return count
}

/** Undo `markTerms`: each mark gives its words back to the text around it. */
export function unmark(root: HTMLElement, className: string): void {
  const marks = root.querySelectorAll<HTMLElement>(`mark.${className}`)
  if (!marks.length) return
  for (const mark of marks) mark.replaceWith(document.createTextNode(mark.textContent ?? ''))
  root.normalize()
}

// ── The cross-transcript search route ─────────────────────────────────────

export interface TranscriptHitFiber { id: string; name: string }

/** One message the host's index matched, as `shuttle transcript search --json` reports it. */
export interface TranscriptHit {
  session: string
  harness: string
  project: string
  path: string
  line: number
  timestamp: string
  role: string
  score: number
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

// ── Reading a hit ─────────────────────────────────────────────────────────

/** A snippet's «matched» spans as alternating plain and matched pieces. */
export function snippetPieces(snippet: string): Array<{ text: string; hit: boolean }> {
  const pieces: Array<{ text: string; hit: boolean }> = []
  for (const [index, part] of snippet.split(/[«»]/).entries()) {
    if (part) pieces.push({ text: part, hit: index % 2 === 1 })
  }
  return pieces
}

/** The words a snippet matched, to carry into the open transcript. */
export function snippetTerms(snippet: string): string[] {
  return queryTerms(snippetPieces(snippet).filter((piece) => piece.hit).map((piece) => piece.text).join(' '))
}

/** `3d ago`, `5h ago`, `just now`: the age of an instant at a glance. */
export function ago(ms: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 60) return `${days}d ago`
  return `${Math.round(days / 30)}mo ago`
}

/** The last path segment of a session's directory. */
export function projectName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? ''
}

/** Where a hit sits in its file, for the reader who has to go and find it by hand. */
export function hitLocation(hit: Pick<TranscriptHit, 'path' | 'line'>): string {
  return hit.line > 0 ? `${hit.path}:${hit.line}` : hit.path
}
