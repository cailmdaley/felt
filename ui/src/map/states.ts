import { hash } from './layout.js'
import type { CityInput, CityState, TerrainBundle } from './types.js'

/**
 * One map from the daemon's Desk column and turn to the atlas's six city
 * states. Urgent human turns (`question`, `blocked`, or an active `ask`)
 * light a lighthouse (`ask`); closed work waiting on a human verdict renders
 * as a calm review pavilion (`review`); an idle live worker that asked nothing
 * stays `working`. A constitution with no live row falls back to its document.
 */
export const STATES: readonly CityState[] = ['working', 'ask', 'review', 'resting', 'draft', 'closed']

export interface CityStateInput {
  column?: string | null
  turn?: string | null
  status?: string | null
  horizon?: string | null
  kind?: string | null
  ask?: unknown
}

function hasActiveAsk(ask: unknown): boolean {
  if (typeof ask === 'string') return ask.trim() !== ''
  if (ask && typeof ask === 'object' && 'text' in ask) {
    const text = (ask as { text?: unknown }).text
    return typeof text === 'string' && text.trim() !== ''
  }
  return false
}

export function cityState({ column, turn, status, horizon, kind, ask }: CityStateInput): CityState {
  if (column) {
    if (column === 'tempered' || column === 'discarded' || column === 'composted') return 'closed'
    if (turn === 'question' || turn === 'blocked' || (status === 'active' && hasActiveAsk(ask))) return 'ask'
    if (column === 'awaiting_review') return 'review'
    if (column === 'in_flight') return 'working'
    if (column === 'drafts') return 'draft'
    return 'resting'
  }
  if (status === 'closed') return 'closed'
  if (status === 'active' && hasActiveAsk(ask)) return 'ask'
  if (horizon === 'stashed' || kind === 'standing' || status === 'active') return 'resting'
  return 'draft'
}

/** Curated cartographic dot palette for deterministic host coloring. */
const HOST_PALETTE = [
  '#b66643',
  '#5a8f9b',
  '#728764',
  '#8c799c',
  '#b0954b',
  '#6a91aa',
  '#9e6b78',
  '#5e8c7a',
  '#a67c52',
  '#788baf',
] as const

/** Deterministic harmonious dot color for any host identifier. */
export function hostColor(host: string | undefined): string {
  if (!host) return '#8b9e91'
  return HOST_PALETTE[Math.floor(hash(host) * HOST_PALETTE.length) % HOST_PALETTE.length]
}

/** Sorted list of distinct hosts appearing in terrain origins or cities. */
export function collectHosts(bundle: Pick<TerrainBundle, 'origins' | 'cities'>): string[] {
  const hosts = new Set<string>()
  if (bundle.origins) {
    for (const h of Object.keys(bundle.origins)) {
      if (h) hosts.add(h)
    }
  }
  for (const c of bundle.cities) {
    const h = c.origin || c.host
    if (h) hosts.add(h)
  }
  return [...hosts].sort((a, b) => a.localeCompare(b))
}

interface RawSnapshotRecord {
  uid?: string
  id?: string
  fiber_id?: string
  nid?: string
  state?: string
  column?: string
  turn?: string
  status?: string
  horizon?: string
  tempered?: boolean
  host?: string
  origin?: string
  outcome?: string
  rex_session?: string
  session?: string
  ask?: unknown
  shuttle?: { kind?: string; host?: string; ask?: unknown }
  runtime?: { state?: string; rex_session?: string }
  fiber?: {
    id?: string
    uid?: string
    status?: string
    horizon?: string
    outcome?: string
    shuttle?: { kind?: string; host?: string; ask?: unknown }
  }
}

export interface SnapshotMergeResult {
  cities: CityInput[]
  matched: number
  changed: boolean
  origins?: Record<string, { stale?: boolean; fibers?: number }>
}

const EXPLICIT_STATE_MAP: Record<string, CityState> = {
  Working: 'working',
  Asking: 'ask',
  Review: 'review',
  'For the human': 'review',
  Resting: 'resting',
  Settled: 'closed',
  asking: 'ask',
  review: 'review',
  awaiting_review: 'review',
  running: 'working',
  working: 'working',
  ask: 'ask',
  resting: 'resting',
  closed: 'closed',
  draft: 'draft',
}

/**
 * Enrich the terrain bundle's allowlisted cities with live composite state.
 * Preserves `column + turn` priority via {@link cityState} so asking/waiting
 * workers remain lit as lighthouses even when `runtime.state === 'running'`.
 */
export function mergeCompositeSnapshot(
  cities: readonly CityInput[],
  snapshot: unknown,
): SnapshotMergeResult {
  const obj = (snapshot && typeof snapshot === 'object' ? snapshot : null) as Record<string, unknown> | null
  const rows = Array.isArray(snapshot)
    ? snapshot
    : obj?.nodes ?? obj?.fibers ?? obj?.entries ?? obj?.eligible
  if (!Array.isArray(rows)) throw new Error('Unrecognized snapshot shape')

  const index = new Map<string, RawSnapshotRecord>()
  for (const raw of rows as RawSnapshotRecord[]) {
    const r: RawSnapshotRecord = raw.fiber
      ? { ...raw.fiber, ...raw, uid: raw.uid || raw.fiber.uid || raw.fiber.id }
      : raw
    for (const key of [r.uid, r.id, r.fiber_id, r.nid]) {
      if (key) index.set(key, r)
    }
  }

  let matched = 0
  let changed = false
  const updated = cities.map((n): CityInput => {
    const slashIdx = n.id.indexOf('/')
    const stripped = slashIdx > 0 ? n.id.slice(slashIdx + 1) : n.id
    const r = (n.uid ? index.get(n.uid) : undefined) ?? index.get(n.id) ?? index.get(stripped)
    if (!r) return n
    matched++
    const shuttle = r.shuttle ?? r.fiber?.shuttle ?? {}
    const explicitState = r.state ? EXPLICIT_STATE_MAP[r.state] : undefined
    let derived: string
    if (r.column) {
      derived = cityState({
        column: r.column,
        turn: r.turn,
        status: r.status ?? r.fiber?.status ?? n.status,
        horizon: r.horizon ?? r.fiber?.horizon,
        kind: shuttle.kind ?? n.kind,
        ask: r.ask ?? shuttle.ask,
      })
    } else if (explicitState) {
      derived = explicitState
    } else if (r.runtime?.state === 'running') {
      derived = 'working'
    } else {
      derived = n.state
    }
    const tempered =
      r.column === 'discarded' || r.column === 'composted' || r.tempered === false
        ? false
        : (r.tempered ?? n.tempered ?? true)

    const nextUid = r.uid || n.uid
    const nextColumn = r.column || n.column
    const nextTurn = r.turn || n.turn
    const nextHost = r.origin || r.host || shuttle.host || n.host
    const nextOrigin = r.origin || n.origin || n.host
    const nextOutcome = r.fiber?.outcome || r.outcome || n.outcome
    const nextRexSession = r.rex_session || r.runtime?.rex_session || r.session || n.rexSession

    if (
      nextUid !== n.uid ||
      derived !== n.state ||
      nextColumn !== n.column ||
      nextTurn !== n.turn ||
      tempered !== n.tempered ||
      nextHost !== n.host ||
      nextOrigin !== n.origin ||
      nextOutcome !== n.outcome ||
      nextRexSession !== n.rexSession
    ) {
      changed = true
    }

    return {
      ...n,
      uid: nextUid,
      state: derived,
      column: nextColumn,
      turn: nextTurn,
      tempered,
      host: nextHost,
      origin: nextOrigin,
      outcome: nextOutcome,
      rexSession: nextRexSession,
    }
  })

  const origins =
    obj?.origins && typeof obj.origins === 'object' && !Array.isArray(obj.origins)
      ? (obj.origins as Record<string, { stale?: boolean; fibers?: number }>)
      : undefined

  return { cities: updated, matched, changed, origins }
}
