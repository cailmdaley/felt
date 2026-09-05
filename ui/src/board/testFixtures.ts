/**
 * Shared fixture builders for the board test suite.
 *
 * Not itself a test file — vitest's include glob only matches `*.test.ts` /
 * `*.spec.ts`, and nothing outside a test file imports this, so it never
 * enters the production bundle's build graph either.
 */
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { surfaceTotals } from './KanbanReadModel.js'
import { buildTimelineDays } from './KanbanSurfaces.js'
import { civilDayToLocalDate } from './civilDay.js'
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
    dependsOnSatisfied: true,
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
    pinned: [],
    cycles: [],
    temperedTotal: 0,
    staleness: {},
    generatedAt: 0,
    ...over,
  }
  return { ...base, totals: over.totals ?? surfaceTotals(base) }
}

// The real Chronicle column layout: 28 back, 14 forward, today fixed at a
// known LOCAL day. Built from the production helper so the fixture is the same
// shape in both zones `npm test` pins.
export const WINDOW_DAYS = buildTimelineDays(28, 14, new Date(2026, 6, 15))
export const DAY_INDEX = new Map(WINDOW_DAYS.map((d, i) => [d.iso, i]))
export const TODAY_IDX = WINDOW_DAYS.findIndex((d) => d.isToday)
export const TODAY_DAY = WINDOW_DAYS[TODAY_IDX].iso

/** An INSTANT at local noon on a civil day — safely inside that day's column
 *  in any zone, unlike a midnight that a DST shift can push over the edge. */
export function noonOf(dayISO: string): string {
  const d = civilDayToLocalDate(dayISO)
  if (!d) throw new Error(`not a civil day: ${dayISO}`)
  d.setHours(12, 0, 0, 0)
  return d.toISOString()
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

/** A civil day N days from today, by index into the fixed window. */
export function dayAt(offset: number): string {
  const day = WINDOW_DAYS[TODAY_IDX + offset]
  if (!day) throw new Error(`offset ${offset} outside fixture window`)
  return day.iso
}
