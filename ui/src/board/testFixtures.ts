/**
 * Shared fixture builders for the board test suite.
 *
 * Not itself a test file — vitest's include glob only matches `*.test.ts` /
 * `*.spec.ts`, and nothing outside a test file imports this, so it never
 * enters the production bundle's build graph either.
 */
import type { KanbanCard } from './KanbanTypes.js'

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
