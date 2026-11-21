/**
 * Session ledger parsing for the board's cross-host session history
 * (`/api/v1/sessions/composite`).
 */

/**
 * One origin's freshness, matching the fibers composite's `origins` block
 * (`CompositeOrigin` in KanbanComposite.ts).
 */
interface TemporalOrigin {
  kind: 'local' | 'remote'
  stale: boolean
  lastPolledAt?: string
  lastError?: string
}

/** Origin name (host id) → its freshness. */
export type TemporalOrigins = Record<string, TemporalOrigin>

/**
 * One line of a host's session ledger — a fiber↔session pairing and its
 * provenance, as `Shuttle.SessionLedger` wrote it.
 */
export interface SessionRecord {
  at: number
  fiber: string
  uid: string | null
  session: string
  harness: string | null
  host: string | null
  tmux: string | null
  kind: 'dispatch' | 'claim' | 'resume'
  /** The agent id the session was dispatched as, on ledger lines that name one. */
  agent?: string
  /** The office this session's constitution names. */
  role?: string
}

export interface SessionsResult {
  host: string
  records: SessionRecord[]
  origins?: TemporalOrigins
}

/**
 * Is `origin`'s data stale, by name? Unknown names read fresh.
 */
export function isOriginStale(origins: TemporalOrigins, host: string | null): boolean {
  if (!host) return false
  return origins[host]?.stale === true
}

const SESSION_KINDS = new Set<SessionRecord['kind']>(['dispatch', 'claim', 'resume'])

/**
 * Coerce a wire body into a SessionsResult, dropping malformed lines.
 *
 * A line without `fiber`, `session` or a known `kind` is dropped rather than
 * repaired. Blank strings count as absent.
 */
export function parseSessions(body: unknown, fallback: SessionsResult): SessionsResult {
  if (!isRecord(body)) return fallback
  const host = typeof body.host === 'string' ? body.host : fallback.host
  const raw = Array.isArray(body.records) ? body.records : []
  const records: SessionRecord[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const fiber = text(entry.fiber)
    const session = text(entry.session)
    const kind = text(entry.kind)
    if (!fiber || !session) continue
    if (!kind || !SESSION_KINDS.has(kind as SessionRecord['kind'])) continue
    records.push({
      at: typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0,
      fiber,
      uid: text(entry.uid),
      session,
      harness: text(entry.harness),
      host: text(entry.host) ?? (host || null),
      tmux: text(entry.tmux),
      kind: kind as SessionRecord['kind'],
      ...(text(entry.agent) ? { agent: text(entry.agent)! } : {}),
      ...(text(entry.role) ? { role: text(entry.role)! } : {}),
    })
  }
  return { host, records, origins: parseOrigins(body.origins, host) }
}

function parseOrigins(value: unknown, localHost: string): TemporalOrigins {
  const out: TemporalOrigins = {}
  if (isRecord(value)) {
    for (const [name, raw] of Object.entries(value)) {
      if (!isRecord(raw)) continue
      const origin: TemporalOrigin = {
        kind: raw.kind === 'local' ? 'local' : 'remote',
        stale: raw.stale === true,
      }
      const polled = text(raw.last_polled_at)
      const error = text(raw.last_error)
      if (polled) origin.lastPolledAt = polled
      if (error) origin.lastError = error
      out[name] = origin
    }
  }
  if (localHost && !out[localHost]) out[localHost] = { kind: 'local', stale: false }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
