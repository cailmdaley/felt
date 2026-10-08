/**
 * Shared fixture builders for the board test suite.
 *
 * Not itself a test file — vitest's include glob only matches `*.test.ts` /
 * `*.spec.ts`, and nothing outside a test file imports this, so it never
 * enters the production bundle's build graph either.
 */
import { expect, vi } from 'vitest'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { surfaceTotals } from './KanbanReadModel.js'
import { buildTimelineDays } from './KanbanSurfaces.js'
import { civilDayAt, hostZone } from './civilDay.js'
import type { CommitRecord, SessionPairing } from './views/TemporalData.js'

/**
 * A minimally-real KanbanCard: every field the type requires, with an
 * id-derived name and path. Per-suite defaults ride in via `over`, which is
 * spread LAST so a caller's override always wins.
 */
export function card(over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard {
  return {
    name: over.name ?? over.id,
    path: `.felt/${over.id}.md`,
    originId: 'local',
    status: 'open',
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
    folded: [],
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
