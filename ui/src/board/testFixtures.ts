/**
 * Shared fixture builders for the board test suite.
 *
 * Not itself a test file — vitest's include glob only matches `*.test.ts` /
 * `*.spec.ts`, and nothing outside a test file imports this, so it never
 * enters the production bundle's build graph either.
 */
import { expect, vi } from 'vitest'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { WIRE_COLUMN, type CompositeEntry, type CompositeFeed } from './KanbanComposite.js'
import type { Turn } from './turn.js'
import { ownerColumn, ownerTurn, stampLifecycle } from '../../harness/ownerLifecycle.js'
import { ownerRow, type LifeState } from '../../harness/lifecycleModel.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { cardFromCompositeEntry } from './KanbanReadModel.js'
import { buildKanbanResponseFromComposite, surfaceTotals, type BuildKanbanResponseOptions } from './KanbanReadModel.js'
import { buildTimelineDays } from './KanbanSurfaces.js'
import { civilDayAt, hostZone } from './civilDay.js'
import type { VoiceStatus } from './voice.js'
import type { Conversations } from './conversationOpening.js'
import type { CommitRecord, SessionPairing } from './views/TemporalData.js'

const realSetTimeout = globalThis.setTimeout

/**
 * Resolves after one real task turn, captured at import so fake timers never
 * intercept it: every pending microtask chain (fetch mocks, Response bodies,
 * queued writes) has run to completion, and so have tasks already due, such as
 * jsdom's history traversals. Counting `await Promise.resolve()` ticks is not a
 * portable wait: reading a Response body takes twice as many microtasks on
 * Node 22 as on Node 26.
 */
export const settle = (): Promise<void> => new Promise(resolve => { realSetTimeout(resolve, 0) })

export function voiceStatus(over: Partial<VoiceStatus> = {}): VoiceStatus {
  return { available: true, enabled: false, muted: false, follow: true, system_audio: false, sources: ['desktop', 'phone'], source: 'desktop', launch: null, state: 'off', target: null, last: null, error: null, ...over }
}

/**
 * A minimally-real KanbanCard: every field the type requires, with an
 * id-derived name and path. Per-suite defaults ride in via `over`, which is
 * spread LAST so a caller's override always wins. Its `column` and `turn` are
 * the ones its owner would serve for the fields given (`ownerLifecycle`), a
 * stashed horizon read as a rest; a caller that changes those fields on a
 * built card changes the served pair with them.
 */
export function card(over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard {
  const fiber = {
    status: over.status ?? 'open',
    tempered: over.tempered,
    horizon: over.effectiveHorizon === 'stashed' ? 'stashed' : undefined,
    shuttle: {
      kind: over.shuttleKind ?? 'oneshot', seat: over.shuttleSeat, role: over.shuttleRole, ask: over.ask,
      runtime: { dispatched_at: over.dispatchedAt },
    },
  }
  const runtime = over.workerState === undefined ? undefined
    : { state: over.workerState, phase: over.runtimePhase, launch_error: over.launchError, started_at: over.workerStartedAt }
  return {
    name: over.name ?? over.id,
    path: `.felt/${over.id}.md`,
    originId: 'local',
    status: 'open',
    // A cycle carries no constitution its owner would stamp.
    column: over.isCycle ? 'drafts' : WIRE_COLUMN[ownerColumn(fiber, runtime !== undefined)],
    turn: over.isCycle ? 'none' : ownerTurn(fiber, runtime, over.launchError) as Turn,
    createdAt: '2026-01-01T09:00:00Z',
    effectiveHorizon: 'now',
    drifted: false,
    // Required on KanbanCard since the cycles contract landed; a plain card is
    // not a cycle, and `over` overrides for the ones that are.
    isCycle: false,
    cycleStart: null,
    ...over,
  }
}

/** A feed body as its owners serve it: each constitution row carries its column and turn. */
export function servedFeed<T extends object>(body: T, nowMs = Date.now()): T {
  const fibers = (body as { fibers?: unknown }).fibers
  return Array.isArray(fibers) ? { ...body, fibers: fibers.map(row => stampLifecycle(row, nowMs)) } : body
}

/** A composite row before its owner stamps it. */
export type FeedRow = Omit<CompositeEntry, 'column' | 'turn'> & Partial<Pick<CompositeEntry, 'column' | 'turn'>>
/** A composite feed of rows before their owners stamp them. */
export type FeedOf = Omit<CompositeFeed, 'entries'> & { entries: FeedRow[] }

/** The board one feed builds, each row as its owner serves it. */
export function boardFrom(feed: FeedOf, opts: BuildKanbanResponseOptions = {}): KanbanResponse {
  return buildKanbanResponseFromComposite({ ...feed, entries: feed.entries.map(e => served(e, opts.nowMs)) }, opts)
}

/** A parsed composite entry as its owner serves it, unless it states its own column and turn. */
export function served(entry: FeedRow, nowMs = Date.now()): CompositeEntry {
  const f = entry.fiber
  const fiber = {
    status: f.status, tempered: f.tempered, horizon: f.horizon, due: f.due,
    shuttle: f.hasShuttleBlock ? {
      kind: f.shuttleKind, seat: f.shuttleSeat, role: f.shuttleRole, ask: f.shuttleAsk,
      runtime: { dispatched_at: f.shuttleDispatchedAt },
    } : undefined,
  }
  const r = entry.runtime
  const runtime = r && { state: r.state, phase: r.phase, launch_error: r.launchError, started_at: r.startedAt }
  return {
    column: WIRE_COLUMN[ownerColumn(fiber, runtime !== undefined, nowMs)],
    turn: ownerTurn(fiber, runtime, entry.dispatchError, nowMs) as Turn,
    ...entry,
  }
}

/**
 * A KanbanResponse holding whatever surfaces it is handed. `totals` is derived
 * with the production helper — the wire's own invariant — unless a caller
 * states one.
 */
export function response(over: Partial<KanbanResponse> = {}): KanbanResponse {
  const base: Omit<KanbanResponse, 'totals'> = {
    feltHost: 'local',
    now: { drafts: [], inFlight: [], awaitingReview: [] },
    timeline: { past: [], futureDated: [] },
    stash: [],
    roles: [],

    cycles: [],
    staleness: {},
    generatedAt: 0,
    ...over,
  }
  return { ...base, totals: over.totals ?? surfaceTotals(base) }
}

/** A complete owner-addressed `shuttle show` feed envelope for reader tests. */
export function ownerFiberResponse(options: {
  owner: string
  id: string
  uid?: string
  name: string
  body: string
  outcome?: string
  status?: string
  path?: string
  store?: string
  dir?: string
}): Record<string, unknown> {
  const path = options.path ?? `.felt/${options.id}/${options.id.split('/').at(-1)}.md`
  const store = options.store ?? `/stores/${options.owner}`
  return {
    host: options.owner,
    generated_at: '2026-10-05T00:00:00Z',
    fibers: [{
      origin: options.owner,
      felt_store: store,
      path,
      dir: options.dir ?? `${store}/.felt/${options.id}`,
      fiber: {
        id: options.id,
        uid: options.uid ?? options.id,
        name: options.name,
        status: options.status ?? 'closed',
        created_at: '2026-01-01T09:00:00Z',
        body: options.body,
        outcome: options.outcome ?? '',
        shuttle: { kind: 'oneshot', host: options.owner, agent: 'codex-sol' },
      },
    }],
    origins: { [options.owner]: { kind: 'local', stale: false, fiber_count: 1 } },
  }
}

// The real Chronicle column layout: 28 back, 14 forward, today fixed at a
// known civil day. Built from the production helper, which needs no zone.
export const WINDOW_DAYS = buildTimelineDays(28, 14, '2026-07-15')
export const DAY_INDEX = new Map(WINDOW_DAYS.map((d, i) => [d.iso, i]))
export const TODAY_IDX = WINDOW_DAYS.findIndex((d) => d.isToday)
export const TODAY_DAY = WINDOW_DAYS[TODAY_IDX].iso

/** An INSTANT at noon on a civil day in the host zone — safely inside that
 *  day's column, unlike a midnight that a DST shift can push over the edge. */
export function noonOf(dayISO: string): string {
  const ms = civilDayAt(dayISO, 12)
  if (ms === undefined) throw new Error(`not a civil day: ${dayISO}`)
  return new Date(ms).toISOString()
}

/**
 * The pinned-zone guard for the workspace's suite, which is the one part of
 * the board still reading the ambient zone through `Date` (it sits outside
 * `civilDay.ts`'s reach; see `ui/test/zoneReads.test.ts`). `npm test` pins
 * TZ=America/Los_Angeles, a negative-offset DST zone, so a test that calls
 * this fails loudly when run unpinned rather than passing vacuously. Every
 * other suite passes its zone explicitly and calls nothing of the kind.
 */
export function expectPinnedZone(): void {
  expect(hostZone().id, 'run via `npm test` — the zone is what this suite tests').toBe('America/Los_Angeles')
}

/** One ledger commit. Only what the joins and the totals read is worth
 *  overriding; the rest is the shape the wire always carries. */
export function commit(
  over: Partial<CommitRecord> & Pick<CommitRecord, 'sha'>,
): CommitRecord {
  return {
    at: 0,
    subject: 'work: a thing',
    repo: null,
    files: 1,
    insertions: 0,
    deletions: 0,
    session: 's-1',
    tmux: null,
    cwd: null,
    host: null,
    ...over,
  }
}

/** A session ledger keyed the way `lookupSession` reads it. */
export function pairings(
  ...rows: { session: string; fiber: string; uid?: string | null; host?: string | null }[]
): Map<string, SessionPairing> {
  return new Map(
    rows.map((r) => [
      r.session,
      { fiber: r.fiber, uid: r.uid ?? null, session: r.session, host: r.host ?? null },
    ]),
  )
}

export interface FetchCall {
  url: string
  params: URLSearchParams
}

/** Stub `fetch`, recording each URL. `respond` shapes the reply. */
export function captureFetch(respond: () => Response): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push({ url, params: new URL(url, 'http://daemon.test').searchParams })
    return respond()
  })
  return calls
}

export const ok = (body: unknown) => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

/** A civil day N days from today, by index into the fixed window. */
export function dayAt(offset: number): string {
  const day = WINDOW_DAYS[TODAY_IDX + offset]
  if (!day) throw new Error(`offset ${offset} outside fixture window`)
  return day.iso
}

/** A surface's conversations as one mock: the explicit open calls it with the card, a click's reach with the card and true. */
export const conversations = (converse: (card: KanbanCard, click?: true) => unknown = () => false): Conversations =>
  ({ open: found => !!converse(found), reach: async found => !!converse(found, true) })

/** The card the board builds from the row the owner serves for a lifecycle model state. */
export function modelCard(s: LifeState, id = 'model/fiber', nowMs = Date.parse('2026-11-09T12:00:00Z')): KanbanCard {
  const feed = parseCompositeFeed({ host: 'model-host', fibers: [ownerRow(id, s, nowMs)] })
  return cardFromCompositeEntry(feed.entries[0], nowMs)
}
