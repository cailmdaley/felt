import { describe, expect, it } from 'vitest'

import type { Fiber } from './KanbanFiber.js'
import {
  byCardIdentity,
  byClosedAtDesc,
  byCreatedAtDesc,
  byDueAtAsc,
  dedupeMirroredRows,
} from './KanbanReadModel.js'
import { deskOrder } from './deskOrdering.js'
import { ThreadIndex } from './threads.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { dueCivilDay, instantMs } from '../sdk/civilDay.js'
import { boardFrom, card, served, type FeedOf, type FeedRow } from './testFixtures.js'

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

function entry(id: string, over: Partial<Fiber> = {}, origin = 'alpha'): FeedRow {
  return {
    origin, feltStore: '/store', path: `${id}.md`,
    fiber: {
      id, uid: `uid-${id}`, name: 'Identical name', status: 'open', createdAt: NEW,
      hasShuttleBlock: true, shuttleKind: 'oneshot', shuttleHost: origin, ...over,
    },
  }
}

function feed(entries: FeedRow[], seed = 0): FeedOf {
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
    stash: identities(r.stash),
  }
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
})

describe('the composite Desk is independent of entry and origin order', () => {
  const dates = [NEW, SAME, OLD, '', 'not a date', '2026-02-30T09:00:00Z']
  const entries = ['draft', 'review', 'tempered', 'discarded', 'rest', 'flight'].flatMap((lane) =>
    dates.map((createdAt, i) => {
      const origin = i % 2 ? 'beta' : 'alpha'
      const e = entry(`${lane}/${i}`, {
        createdAt,
        status: ['review', 'tempered', 'discarded'].includes(lane) ? 'closed' : lane === 'flight' ? 'active' : 'open',
        tempered: lane === 'tempered' ? true : lane === 'discarded' ? false : undefined,
        closedAt: ['review', 'tempered', 'discarded'].includes(lane) ? createdAt : undefined,
        shuttleKind: 'oneshot',
        horizon: lane === 'rest' ? 'stashed' : undefined,
      }, origin)
      if (lane === 'flight') e.runtime = { state: 'running', phase: i % 2 ? 'working' : 'waiting', phaseSince: NOW - i * 1000 }
      return e
    }),
  )
  entries.push(
    entry('shared/local-id', { uid: 'distinct-a' }, 'alpha'),
    entry('shared/local-id', { uid: 'distinct-b' }, 'beta'),
    entry('old/local-id', { uid: undefined }, 'alpha'),
    entry('old/local-id', { uid: undefined }, 'beta'),
    entry('future/early', { status: 'active', shuttleKind: 'standing', shuttleSchedule: { expr: '0 9 * * *', tz: 'UTC' }, shuttleNextDue: '2026-10-06T09:00:00Z' }),
    entry('future/late', { status: 'active', shuttleKind: 'standing', shuttleSchedule: { expr: '0 19 * * *', tz: 'UTC' }, shuttleNextDue: '2026-10-05T19:00:00Z' }),
  )

  it('keeps every lane stable, duplicates visible, independent of recency', () => {
    const baseline = boardFrom(feed(entries), { nowMs: NOW })
    expect(baseline.now.drafts.filter((c) => c.id === 'shared/local-id')).toHaveLength(2)
    expect(baseline.now.drafts.filter((c) => c.id === 'old/local-id')).toHaveLength(2)
    expect(ids(baseline.timeline.futureDated)).toEqual(['future/late', 'future/early'])
    for (let seed = 1; seed <= 40; seed++) {
      const result = boardFrom(feed(entries, seed), { nowMs: NOW })
      expect(surfaceOrder(result)).toEqual(surfaceOrder(baseline))
    }
  })

  it('ignores edits, file timestamps and runtime age; a genuinely newer draft inserts once at the top', () => {
    const before = boardFrom(feed(entries), { nowMs: NOW })
    const edited = entries.map((e) => ({
      ...e,
      fiber: { ...e.fiber, modifiedAt: '2026-10-05T23:59:59Z', body: 'Edited body', name: 'Renamed' },
      runtime: e.runtime ? { ...e.runtime, lastActivityAt: NOW + 10_000 } : undefined,
    }))
    const after = boardFrom(feed(edited, 39), { nowMs: NOW + 10_000 })
    expect(surfaceOrder(after)).toEqual(surfaceOrder(before))
    const added = boardFrom(feed([
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
      const rows = dedupeMirroredRows(shuffledFeed.entries.map(e => served(e)), { ...shuffledFeed, entries: [] })
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
    expect(dedupeMirroredRows(entries.map(e => served(e)), { ...feed(entries), entries: [] })[0].origin).toBe('beta')
  })
})

describe('the Desk: every family once, in the section its members put it in', () => {
  const at = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString()
  const node = (id: string, over: Partial<KanbanCard> = {}): KanbanCard =>
    card({ id, uid: id, shuttleKind: 'oneshot', orchestrator: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : undefined, createdAt: at(600), ...over })
  // cmbx waits twice, three levels down, and works besides; pipe only works; notes rest; plan is a draft; done was tempered.
  const cards = [
    node('cmbx', { status: 'active', workerState: 'running', runtimePhase: 'working', lastActivityAt: NOW - 60_000 }),
    node('cmbx/kappa', { status: 'active', workerState: 'running', runtimePhase: 'working' }),
    node('cmbx/kappa/beam', { status: 'active', workerState: 'running', runtimePhase: 'waiting' }),
    node('cmbx/kappa/beam/mask', { status: 'active', ask: { text: 'Which threshold?', at: at(5) } }),
    node('cmbx/kappa/beam/cov', { status: 'closed', closedAt: at(30) }),
    node('pipe', { status: 'active', workerState: 'running', runtimePhase: 'waiting', lastActivityAt: NOW - 120_000 }),
    node('notes', { status: 'open', effectiveHorizon: 'stashed', modifiedAt: at(10) }),
    node('plan', { status: 'open', modifiedAt: at(20) }),
    node('done', { status: 'closed', tempered: true, closedAt: at(1) }),
  ]
  const index = new ThreadIndex(cards)

  const sections = (order: ReturnType<typeof deskOrder>) => Object.fromEntries(Object.entries(order.sections).map(([section, families]) => [section, families.map(family => family.root.id)]))

  it('draws each family once, where its members put it, with every waiting member at any depth, the newest first', () => {
    const order = deskOrder(index, new Map())
    expect(sections(order)).toStrictEqual({ waiting: ['cmbx'], working: ['pipe'], review: [], drafts: ['plan'], resting: ['notes'], roles: [] })
    const [cmbx] = order.sections.waiting
    expect(cmbx.waits.map(wait => [wait.card.id, wait.want.kind, wait.want.text])).toStrictEqual([
      ['cmbx/kappa/beam/mask', 'ask', 'Which threshold?'],
      ['cmbx/kappa/beam/cov', 'review', 'for review'],
    ])
    // The idle worker asked nothing: it works.
    expect(cmbx.working).toBe(3)
  })

  it('moves a family to Waiting on you for a post the board names, and orders that section by its newest wait', () => {
    const order = deskOrder(index, new Map([['pipe', { id: 'p', at: NOW - 60_000, kind: 'post', text: 'Read this.' }]]))
    expect(order.sections.waiting.map(family => family.root.id)).toStrictEqual(['pipe', 'cmbx'])
    expect(order.sections.working).toStrictEqual([])
  })

  it('puts a family whose only wants are reviews in Awaiting review, even while it works', () => {
    const graph = new ThreadIndex([
      ...cards,
      node('paper', { status: 'closed', closedAt: at(3) }),
      node('survey', { status: 'active', workerState: 'running', runtimePhase: 'working' }),
      node('survey/psf', { status: 'closed', closedAt: at(8), reviewMark: { note: 'Worth your look.', at: at(8) } }),
    ])
    const order = deskOrder(graph, new Map())
    expect(order.sections.review.map(family => family.root.id)).toStrictEqual(['paper', 'survey'])
    expect(order.sections.review[1].waits.map(wait => [wait.card.id, wait.want.text])).toStrictEqual([['survey/psf', 'Worth your look.']])
  })

  it('shelves a quiet family by its top-level: drafts and held launches, rests, seats and standing schedules by name', () => {
    const graph = new ThreadIndex([
      node('held', { status: 'active', held: true }),
      node('watch', { status: 'open', shuttleKind: 'standing', effectiveHorizon: 'stashed' }),
      node('digest', { status: 'active', shuttleKind: 'standing' }),
      node('referee', { status: 'open', shuttleSeat: true, shuttleRole: 'referee' }),
      node('later', { status: 'open', effectiveHorizon: 'stashed' }),
    ])
    expect(sections(deskOrder(graph, new Map()))).toStrictEqual({ waiting: [], working: [], review: [], drafts: ['held'], resting: ['later'], roles: ['digest', 'referee', 'watch'] })
  })

  it('keeps a top-level with a verdict off the Desk unless something in it still waits or works', () => {
    expect(deskOrder(index, new Map()).rows.map(row => row.id)).not.toContain('done')
    const under = new ThreadIndex([...cards, node('done/late', { status: 'active', workerState: 'running', runtimePhase: 'working' })])
    expect(deskOrder(under, new Map()).sections.working.map(family => family.root.id)).toContain('done')
  })

  it('walks the reader through each family\'s top-level, then its waiting members, section by section', () => {
    const order = deskOrder(index, new Map())
    expect(order.rows.map(row => [row.id, order.placements.get(JSON.stringify([row.originId, row.uid]))?.group])).toStrictEqual([
      ['cmbx', 'Waiting on you'], ['cmbx/kappa/beam/mask', 'Waiting on you'], ['cmbx/kappa/beam/cov', 'Waiting on you'],
      ['pipe', 'Working'], ['plan', 'Drafts'], ['notes', 'Resting'],
    ])
  })
})
