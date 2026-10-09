import { describe, expect, it } from 'vitest'
import type { CompositeEntry, CompositeFeed } from './KanbanComposite.js'
import type { Fiber } from './KanbanFiber.js'
import {
  buildKanbanResponseFromComposite,
  byCardIdentity,
  byClosedAtDesc,
  byCreatedAtDesc,
  byDueAtAsc,
  byInFlightBand,
  dedupeMirroredRows,
  inFlightBand,
} from './KanbanReadModel.js'
import { buildDependents, queuedBehind } from './KanbanRules.js'
import { clusterStashCards, sortDatedByReturn, splitStashByReturn } from './KanbanSurfaces.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { dueCivilDay, instantMs } from './civilDay.js'
import { card } from './testFixtures.js'

const NOW = Date.parse('2026-10-05T12:00:00Z')
const NEW = '2026-10-04T09:00:00-07:00'
const SAME = '2026-10-04T18:00:00+02:00'
const OLD = '2026-10-03T18:00:00+02:00'

/** Seeded Fisher–Yates: exercise many entry and origin permutations reproducibly. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const j = seed % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

const identity = (c: KanbanCard): string => `${c.uid ?? ''}@${c.originId}:${c.id}`
const ids = (cards: KanbanCard[]): string[] => cards.map((c) => c.id)
const identities = (cards: KanbanCard[]): string[] => cards.map(identity)

function entry(id: string, over: Partial<Fiber> = {}, origin = 'alpha'): CompositeEntry {
  return {
    origin, feltStore: '/store', path: `${id}.md`,
    fiber: {
      id, uid: `uid-${id}`, name: 'Identical name', status: 'open', createdAt: NEW,
      hasShuttleBlock: true, shuttleKind: 'oneshot', shuttleHost: origin, ...over,
    },
  }
}

function feed(entries: CompositeEntry[], seed = 0): CompositeFeed {
  return {
    host: 'desk', entries: shuffled(entries, seed),
    origins: Object.fromEntries(shuffled(['desk', 'alpha', 'beta', 'gamma'], seed + 17).map((origin) => [
      origin, { kind: origin === 'desk' ? 'local' as const : 'remote' as const, stale: false, fiberCount: 1 },
    ])),
  }
}

function surfaceOrder(r: KanbanResponse): unknown {
  return {
    drafts: identities(r.now.drafts), inFlight: identities(r.now.inFlight), review: identities(r.now.awaitingReview),
    past: identities(r.timeline.past), future: identities(r.timeline.futureDated),
    pinned: identities(r.pinned), stash: identities(r.stash), folded: identities(r.folded),
  }
}

function clusterOrder(cards: KanbanCard[], dated = false): unknown {
  const clusters = clusterStashCards(cards)
  return (dated ? sortDatedByReturn(clusters) : clusters)
    .map((c) => ({ key: c.key, cold: c.cold, cards: identities(c.cards) }))
}

describe('Desk comparators', () => {
  const cards = [
    card({ id: 'old', uid: 'a', createdAt: OLD }),
    card({ id: 'same/b', uid: 'b', createdAt: SAME }),
    card({ id: 'same/a', uid: 'a', createdAt: NEW }),
    card({ id: 'missing', uid: 'a', createdAt: '' }),
    card({ id: 'invalid', uid: 'b', createdAt: 'not a date' }),
    card({ id: 'overflow', uid: 'c', createdAt: '2026-02-30T09:00:00Z' }),
  ].map((c) => ({ ...c, name: 'Identical name' }))

  it('uses uid, then origin, then id rather than name, locale or arrival order', () => {
    const ties = [
      card({ id: 'duplicate', uid: 'b', originId: 'alpha' }),
      card({ id: 'z', uid: 'a', originId: 'beta' }),
      card({ id: 'z', uid: 'a', originId: 'alpha' }),
      card({ id: 'a', uid: 'a', originId: 'alpha' }),
      card({ id: 'duplicate', uid: 'a', originId: 'alpha' }),
    ]
    const expected = ['a@alpha:a', 'a@alpha:duplicate', 'a@alpha:z', 'a@beta:z', 'b@alpha:duplicate']
    for (let seed = 1; seed <= 40; seed++) {
      expect(identities(shuffled(ties, seed).sort(byCardIdentity))).toEqual(expected)
      expect(identities(shuffled(ties, seed).sort(byCreatedAtDesc))).toEqual(expected)
    }
  })

  it('orders creation instants newest-first, with equal offset dates tied and invalid/missing last', () => {
    for (let seed = 1; seed <= 40; seed++) {
      expect(ids(shuffled(cards, seed).sort(byCreatedAtDesc)))
        .toEqual(['same/a', 'same/b', 'old', 'missing', 'invalid', 'overflow'])
    }
  })

  it('uses closed time with valid creation fallback, then identity, without another recency tie', () => {
    const closed = [
      card({ id: 'new-close', uid: 'a', createdAt: OLD, closedAt: NEW }),
      card({ id: 'new-create', uid: 'b', createdAt: SAME }),
      card({ id: 'invalid-close', uid: 'c', createdAt: SAME, closedAt: 'malformed' }),
      card({ id: 'old-close', createdAt: NEW, closedAt: OLD }),
      card({ id: 'invalid-both', uid: 'b', createdAt: 'bad', closedAt: 'bad' }),
      card({ id: 'missing-both', uid: 'a', createdAt: '' }),
    ]
    for (let seed = 1; seed <= 40; seed++) {
      expect(ids(shuffled(closed, seed).sort(byClosedAtDesc)))
        .toEqual(['new-close', 'new-create', 'invalid-close', 'old-close', 'missing-both', 'invalid-both'])
    }
  })

  it('orders future dates soonest-first, with invalid and missing keys last', () => {
    const future = [
      card({ id: 'instant-a', uid: 'a', nextLaunchAt: NEW }),
      card({ id: 'instant-b', uid: 'b', nextLaunchAt: SAME }),
      card({ id: 'day', due: '2026-10-04T00:00:00+02:00' }),
      card({ id: 'missing', uid: 'a' }),
      card({ id: 'invalid', uid: 'b', nextLaunchAt: 'bad' }),
      card({ id: 'overflow', uid: 'c', due: '2026-02-30' }),
    ]
    for (let seed = 1; seed <= 40; seed++) {
      expect(ids(shuffled(future, seed).sort(byDueAtAsc)))
        .toEqual(['day', 'instant-a', 'instant-b', 'missing', 'invalid', 'overflow'])
    }
    expect(instantMs('2026-02-30T09:00:00Z')).toBeUndefined()
    expect(dueCivilDay('2026-02-30T00:00:00+02:00')).toBeUndefined()
    expect(dueCivilDay('2026-13-01')).toBeUndefined()
    expect(dueCivilDay('2024-02-29')).toBe('2024-02-29')
  })

  it('keeps one creation order within each In flight band regardless of phase or activity age', () => {
    const workers = [
      card({ id: 'waiting-new', runtimePhase: 'waiting', createdAt: NEW, lastActivityAt: NOW }),
      card({ id: 'attention-old', runtimePhase: 'attention', createdAt: OLD, lastActivityAt: 1 }),
      card({ id: 'working-new', runtimePhase: 'working', createdAt: NEW, lastActivityAt: 1 }),
      card({ id: 'unobserved-old', createdAt: OLD, status: 'active' }),
    ]
    const expected = ['waiting-new', 'attention-old', 'working-new', 'unobserved-old']
    for (let seed = 1; seed <= 40; seed++) {
      expect(ids(shuffled(workers, seed).sort(byInFlightBand))).toEqual(expected)
      const changed = workers.map((c) => ({
        ...c, lastActivityAt: seed * 100,
        runtimePhase: inFlightBand(c) === 'stalled' ? (seed % 2 ? 'blocked' : 'waiting') : 'retrying',
      }))
      expect(ids(shuffled(changed, seed).sort(byInFlightBand))).toEqual(expected)
    }
    workers[2].runtimePhase = 'waiting'
    expect(ids(workers.sort(byInFlightBand)))
      .toEqual(['waiting-new', 'working-new', 'attention-old', 'unobserved-old'])
  })
})

describe('the composite Desk is independent of entry and origin order', () => {
  const dates = [NEW, SAME, OLD, '', 'not a date', '2026-02-30T09:00:00Z']
  const entries = ['draft', 'review', 'tempered', 'discarded', 'pinned', 'rest', 'flight'].flatMap((lane) =>
    dates.map((createdAt, i) => {
      const origin = i % 2 ? 'beta' : 'alpha'
      const e = entry(`${lane}/${i}`, {
        createdAt,
        status: ['review', 'tempered', 'discarded'].includes(lane) ? 'closed' : lane === 'flight' ? 'active' : 'open',
        tempered: lane === 'tempered' ? true : lane === 'discarded' ? false : undefined,
        closedAt: ['review', 'tempered', 'discarded'].includes(lane) ? createdAt : undefined,
        shuttleKind: lane === 'pinned' ? 'pinned' : 'oneshot',
        horizon: lane === 'rest' ? 'stashed' : undefined,
      }, origin)
      if (lane === 'flight') e.runtime = { state: 'running', phase: i % 2 ? 'working' : 'waiting', lastActivityAt: NOW - i * 1000 }
      return e
    }),
  )
  entries.push(
    entry('shared/local-id', { uid: 'distinct-a' }, 'alpha'),
    entry('shared/local-id', { uid: 'distinct-b' }, 'beta'),
    entry('old/local-id', { uid: undefined }, 'alpha'),
    entry('old/local-id', { uid: undefined }, 'beta'),
    entry('queue/head', { createdAt: OLD }),
    entry('queue/next', { createdAt: '', dependsOn: ['queue/head'], dependsOnShape: 'scalar' }),
    entry('queue/last', { createdAt: NEW, dependsOn: ['queue/next'], dependsOnShape: 'scalar' }),
    entry('future/early', { status: 'active', shuttleKind: 'standing', shuttleSchedule: { expr: '0 9 * * *', tz: 'UTC' } }),
    entry('future/late', { status: 'active', shuttleKind: 'standing', shuttleSchedule: { expr: '0 19 * * *', tz: 'UTC' } }),
  )

  it('keeps every lane stable, duplicates visible, and dependency order independent of recency', () => {
    const baseline = buildKanbanResponseFromComposite(feed(entries), { nowMs: NOW })
    expect(baseline.now.drafts.filter((c) => c.id === 'shared/local-id')).toHaveLength(2)
    expect(baseline.now.drafts.filter((c) => c.id === 'old/local-id')).toHaveLength(2)
    expect(ids(baseline.pinned)).toEqual(['pinned/0', 'pinned/1', 'pinned/2', 'pinned/3', 'pinned/4', 'pinned/5'])
    expect(ids(baseline.timeline.futureDated)).toEqual(['future/late', 'future/early'])
    for (let seed = 1; seed <= 40; seed++) {
      const result = buildKanbanResponseFromComposite(feed(entries, seed), { nowMs: NOW })
      expect(surfaceOrder(result)).toEqual(surfaceOrder(baseline))
      expect(queuedBehind('queue/head', buildDependents([...result.now.drafts, ...result.folded])))
        .toEqual(['queue/next', 'queue/last'])
    }
  })

  it('ignores edits, file timestamps and runtime age; a genuinely newer draft inserts once at the top', () => {
    const before = buildKanbanResponseFromComposite(feed(entries), { nowMs: NOW })
    const edited = entries.map((e) => ({
      ...e,
      fiber: { ...e.fiber, modifiedAt: '2026-10-05T23:59:59Z', body: 'Edited body', name: 'Renamed' },
      runtime: e.runtime ? { ...e.runtime, lastActivityAt: NOW + 10_000 } : undefined,
    }))
    const after = buildKanbanResponseFromComposite(feed(edited, 39), { nowMs: NOW + 10_000 })
    expect(surfaceOrder(after)).toEqual(surfaceOrder(before))
    const added = buildKanbanResponseFromComposite(feed([
      ...edited, entry('brand-new', { createdAt: '2026-10-05T13:00:00Z' }),
    ], 40), { nowMs: NOW + 10_000 })
    expect(ids(added.now.drafts)).toEqual(['brand-new', ...ids(before.now.drafts)])
  })
})

describe('mirrored row survivor determinism', () => {
  it.each([
    [NEW, SAME, NEW],
    [undefined, 'bad', '2026-02-30T00:00:00Z'],
  ])('uses origin after tied valid or absent/invalid modified times: %j', (alpha, beta, gamma) => {
    const entries = [
      entry('mirror', { uid: 'same', shuttleHost: undefined, modifiedAt: alpha }, 'alpha'),
      entry('mirror', { uid: 'same', shuttleHost: undefined, modifiedAt: beta }, 'beta'),
      entry('mirror', { uid: 'same', shuttleHost: undefined, modifiedAt: gamma }, 'gamma'),
    ]
    for (let seed = 1; seed <= 40; seed++) {
      const shuffledFeed = feed(entries, seed)
      const rows = dedupeMirroredRows(shuffledFeed.entries, shuffledFeed)
      expect(rows).toHaveLength(1)
      expect(rows[0].origin).toBe('alpha')
      expect(rows[0].mirroredOrigins).toEqual(['beta', 'gamma'])
    }
  })

  it('prefers a valid pre-epoch modification over an invalid key, not a synthetic 1970 date', () => {
    const entries = [
      entry('mirror', { uid: 'same', shuttleHost: undefined, modifiedAt: 'bad' }, 'alpha'),
      entry('mirror', { uid: 'same', shuttleHost: undefined, modifiedAt: '1969-01-01T00:00:00Z' }, 'beta'),
    ]
    expect(dedupeMirroredRows(entries, feed(entries))[0].origin).toBe('beta')
  })
})

describe('Resting group order', () => {
  const resting = [
    card({ id: 'warm-a/new', uid: 'a', createdAt: NEW }),
    card({ id: 'warm-a/equal', uid: 'b', createdAt: SAME }),
    card({ id: 'warm-a/old', uid: 'c', createdAt: OLD }),
    card({ id: 'warm-b/new', uid: 'd', createdAt: NEW }),
    card({ id: 'warm-c/missing', uid: 'e', createdAt: '' }),
    card({ id: 'warm-c/invalid', uid: 'f', createdAt: 'bad' }),
    card({ id: 'cold-a/new', uid: 'g', createdAt: NEW, cold: true }),
  ]

  it('keeps warm before cold, newest-created within each cluster and identity ties across clusters', () => {
    const baseline = clusterOrder(resting)
    expect(clusterStashCards(resting).map((c) => c.key)).toEqual(['warm-a', 'warm-b', 'warm-c', 'cold-a'])
    expect(ids(clusterStashCards(resting)[0].cards)).toEqual(['warm-a/new', 'warm-a/equal', 'warm-a/old'])
    for (let seed = 1; seed <= 40; seed++) expect(clusterOrder(shuffled(resting, seed))).toEqual(baseline)
  })

  it('keeps dated warm before cold, then earliest return, then creation within equal-return groups', () => {
    const dated = resting.map((c) => ({
      ...c, due: c.cold ? '2026-10-06' : c.id.startsWith('warm-a') ? '2026-10-08T00:00:00+02:00'
        : c.id.startsWith('warm-b') ? '2026-10-07' : 'bad',
    }))
    const baseline = clusterOrder(dated, true)
    expect(sortDatedByReturn(clusterStashCards(dated)).map((c) => c.key))
      .toEqual(['warm-b', 'warm-a', 'warm-c', 'cold-a'])
    for (let seed = 1; seed <= 40; seed++) expect(clusterOrder(shuffled(dated, seed), true)).toEqual(baseline)
    const groups = splitStashByReturn([...resting, ...dated])
    expect(groups.undated).toHaveLength(resting.length)
    expect(groups.dated).toHaveLength(dated.length)
  })

  it('orders distinct returns within a cluster, creation breaks tied return instants', () => {
    const dated = [
      card({ id: 'project/old-soon', uid: 'a', createdAt: OLD, due: '2026-10-07' }),
      card({ id: 'project/new-soon', uid: 'b', createdAt: NEW, due: '2026-10-07T00:00:00+02:00' }),
      card({ id: 'project/new-later', uid: 'c', createdAt: NEW, due: '2026-10-08' }),
      card({ id: 'project/invalid', uid: 'd', due: 'bad' }),
      card({ id: 'project/cold', uid: 'e', due: '2026-10-06', cold: true }),
      card({ id: 'project/cron', uid: 'f', shuttleKind: 'standing', status: 'active',
        nextLaunchAt: '2026-10-06T22:00:00-07:00' }),
    ]
    // The cron is before Oct 7's local midnight in Los Angeles, after it in Paris.
    const expectedWarm = new Date(2026, 9, 7).getTime() < Date.parse(dated[5].nextLaunchAt!)
      ? ['project/new-soon', 'project/old-soon', 'project/cron', 'project/new-later', 'project/invalid']
      : ['project/cron', 'project/new-soon', 'project/old-soon', 'project/new-later', 'project/invalid']
    for (let seed = 1; seed <= 40; seed++) {
      const clusters = sortDatedByReturn(clusterStashCards(shuffled(dated, seed)))
      expect(ids(clusters[0].cards)).toEqual(expectedWarm)
      expect(ids(clusters[1].cards)).toEqual(['project/cold'])
    }
  })
})
