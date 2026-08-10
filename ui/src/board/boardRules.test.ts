// Rules the desk depends on, pinned in both hemispheres.
//
// `npm test` runs this file twice — TZ=America/Los_Angeles and TZ=Europe/Paris
// — because the snooze rules turn on CIVIL DAYS and the classic failure is a
// negative-offset zone reading UTC midnight as the previous evening. Every due
// here is therefore built FROM the reference instant with `isoDayLocal`, never
// written as a literal date: a hardcoded `2026-08-12` would name a different
// day either side of the Atlantic and the test would only be checking one.

import { describe, expect, it } from 'vitest'
import {
  classifyFiber,
  cycleSpan,
  effectiveHorizon,
  humanizeCron,
  isCycleFiber,
  restingUntil,
  upcomingCycleDropTargets,
} from './KanbanRules.js'
import type { CycleDropCandidate } from './KanbanRules.js'
import type { Fiber } from './KanbanFiber.js'
import type { CompositeEntry, CompositeFeed } from './KanbanComposite.js'
import type { KanbanCard } from './KanbanTypes.js'
import { buildKanbanResponseFromComposite } from './KanbanReadModel.js'
import { clusterStashCards, humanizeIdleAge, phasePillLabel } from './KanbanSurfaces.js'
import { sessionWindow } from './FiberDetailModal.js'
import { isoDayLocal } from './civilDay.js'

const NOW = Date.parse('2026-08-08T15:30:00Z')
const DAY = 86_400_000
const dayFromNow = (n: number): string => isoDayLocal(NOW + n * DAY)
const at0 = new Date(NOW - 30 * DAY).toISOString()

describe('effectiveHorizon — snooze is due + stashed, composed', () => {
  it('rests a stashed card whose due is still ahead', () => {
    const h = effectiveHorizon({ horizon: 'stashed', due: dayFromNow(3) }, NOW)
    expect(h.effectiveHorizon).toBe('stashed')
    expect(h.drifted).toBe(false)
  })

  it('keeps a plain future-dated card on the timeline, not in Resting', () => {
    // The control for the case above: without a stored horizon the same due
    // means "scheduled", and scheduling has always been `soon`.
    expect(effectiveHorizon({ due: dayFromNow(3) }, NOW).effectiveHorizon).toBe('soon')
  })

  it('DRIFT OVERRIDES STASHED — the day arrives and the card returns to the desk', () => {
    // Snooze's return ticket. Without this the card would rest forever holding
    // a date nobody reads, and snooze would be a black hole.
    const today = effectiveHorizon({ horizon: 'stashed', due: dayFromNow(0) }, NOW)
    expect(today.effectiveHorizon).toBe('now')
    expect(today.drifted).toBe(true)

    const overdue = effectiveHorizon({ horizon: 'stashed', due: dayFromNow(-2) }, NOW)
    expect(overdue.effectiveHorizon).toBe('now')
    expect(overdue.drifted).toBe(true)
  })

  it('wakes on the civil day the due NAMES, through felt\'s midnight storage', () => {
    // felt serializes a `due:` as a timestamp at midnight in whatever offset
    // wrote it. Both of these name tomorrow's date as a civil day, so both must
    // still be resting — reading either as an instant loses a day somewhere.
    for (const offset of ['Z', '+02:00', '-07:00']) {
      const due = `${dayFromNow(1)}T00:00:00${offset}`
      expect(effectiveHorizon({ horizon: 'stashed', due }, NOW).effectiveHorizon).toBe('stashed')
    }
  })

  it('leaves a dateless rest resting', () => {
    expect(effectiveHorizon({ horizon: 'stashed' }, NOW).effectiveHorizon).toBe('stashed')
  })
})

describe('restingUntil', () => {
  it('names the wake day for a snoozed card', () => {
    expect(restingUntil({ horizon: 'stashed', due: dayFromNow(4) }, NOW)).toBe(dayFromNow(4))
  })

  it('is undefined for a dateless rest and for a card the drift already woke', () => {
    expect(restingUntil({ horizon: 'stashed' }, NOW)).toBeUndefined()
    expect(restingUntil({ horizon: 'stashed', due: dayFromNow(-1) }, NOW)).toBeUndefined()
  })

  it('is undefined for a scheduled card — that one is on the timeline, not resting', () => {
    expect(restingUntil({ due: dayFromNow(2) }, NOW)).toBeUndefined()
  })
})

describe('humanizeIdleAge', () => {
  it('reads one unit, coarsening as it grows', () => {
    expect(humanizeIdleAge(0)).toBe('0m')
    expect(humanizeIdleAge(45_000)).toBe('0m')          // no seconds, ever
    expect(humanizeIdleAge(12 * 60_000)).toBe('12m')
    expect(humanizeIdleAge(59 * 60_000)).toBe('59m')
    expect(humanizeIdleAge(60 * 60_000)).toBe('1h')
    expect(humanizeIdleAge(3 * 3_600_000 + 40 * 60_000)).toBe('3h')
    expect(humanizeIdleAge(23 * 3_600_000)).toBe('23h')
    expect(humanizeIdleAge(2 * DAY + 5 * 3_600_000)).toBe('2d')
  })

  it('never renders a negative or absent age as anything but 0m', () => {
    expect(humanizeIdleAge(-5_000)).toBe('0m')
    expect(humanizeIdleAge(undefined)).toBe('0m')
    expect(humanizeIdleAge(Number.NaN)).toBe('0m')
  })
})

describe('phasePillLabel', () => {
  it('always clocks a waiting worker', () => {
    expect(phasePillLabel('waiting', NOW - 12 * 60_000, NOW)).toBe('⏸ waiting · 12m')
    expect(phasePillLabel('waiting', NOW - 3 * 3_600_000, NOW)).toBe('⏸ waiting · 3h')
    expect(phasePillLabel('waiting', NOW - 2 * DAY, NOW)).toBe('⏸ waiting · 2d')
  })

  it('clocks attention only once it has gone an hour unanswered', () => {
    expect(phasePillLabel('attention', NOW - 4 * 60_000, NOW)).toBe('☞︎ needs you now')
    expect(phasePillLabel('attention', NOW - 90 * 60_000, NOW)).toBe('☞︎ needs you now · 1h')
  })

  it('falls back to the bare label with no activity stamp', () => {
    expect(phasePillLabel('waiting', undefined, NOW)).toBe('⏸ waiting')
    expect(phasePillLabel('dispatched', NOW - DAY, NOW)).toBe('▸ dispatched')
  })
})

describe('a mirrored fiber renders as ONE card', () => {
  // Shape taken from the real board: 245 rows for 240 fibers, five of them
  // served by both the laptop and `candide` out of the same git-synced store.
  const mirrored = (origin: string, over: Partial<Fiber> = {}): CompositeEntry => ({
    origin,
    feltStore: `/store/${origin}`,
    path: '.felt/science/unions/final-push.md',
    fiber: {
      id: 'science/unions/final-push',
      uid: '01KTCA2D1FGAJNHX5WKQ34BSZF',
      name: 'Final push',
      status: 'open',
      kind: 'task',
      priority: 2,
      createdAt: at0,
      hasShuttleBlock: true,
      shuttleKind: 'oneshot',
      ...over,
    },
  })
  const feedWith = (
    entries: CompositeEntry[],
    origins: Record<string, { kind: 'local' | 'remote'; stale: boolean }>,
  ): CompositeFeed => ({
    host: 'laptop',
    entries,
    origins: Object.fromEntries(
      Object.entries(origins).map(([k, v]) => [k, { ...v, fiberCount: 1 }]),
    ),
  })

  const drafts = (feed: CompositeFeed): KanbanCard[] =>
    buildKanbanResponseFromComposite(feed, { nowMs: NOW }).now.drafts

  it('keeps the LOCAL row when a remote mirrors it', () => {
    const feed = feedWith(
      [mirrored('candide'), mirrored('laptop')],
      { laptop: { kind: 'local', stale: false }, candide: { kind: 'remote', stale: false } },
    )
    const cards = drafts(feed)
    expect(cards).toHaveLength(1)
    expect(cards[0].originId).toBe('laptop')
    expect(cards[0].mirroredOrigins).toEqual(['candide'])
  })

  it('keeps the local row even when the remote copy is newer', () => {
    // Writes go to the host that owns it, and its liveness is first-hand.
    const feed = feedWith(
      [
        mirrored('candide', { modifiedAt: new Date(NOW).toISOString() }),
        mirrored('laptop', { modifiedAt: new Date(NOW - 10 * DAY).toISOString() }),
      ],
      { laptop: { kind: 'local', stale: false }, candide: { kind: 'remote', stale: false } },
    )
    expect(drafts(feed)[0].originId).toBe('laptop')
  })

  it('prefers a FRESH remote over a stale one when neither is local', () => {
    // The defect this kills: under a stale remote one twin dimmed and refused
    // drag while the other looked fine, so which card you grabbed decided
    // whether the gesture worked.
    const feed = feedWith(
      [mirrored('cineca'), mirrored('candide')],
      {
        laptop: { kind: 'local', stale: false },
        cineca: { kind: 'remote', stale: true },
        candide: { kind: 'remote', stale: false },
      },
    )
    const cards = drafts(feed)
    expect(cards).toHaveLength(1)
    expect(cards[0].originId).toBe('candide')
  })

  it('falls back to the newest modifiedAt among equals', () => {
    const feed = feedWith(
      [
        mirrored('cineca', { modifiedAt: new Date(NOW - 5 * DAY).toISOString() }),
        mirrored('nibi', { modifiedAt: new Date(NOW - 1 * DAY).toISOString() }),
      ],
      {
        laptop: { kind: 'local', stale: false },
        cineca: { kind: 'remote', stale: false },
        nibi: { kind: 'remote', stale: false },
      },
    )
    expect(drafts(feed)[0].originId).toBe('nibi')
  })

  it('is stable whichever order the feed lists them in', () => {
    const origins = {
      laptop: { kind: 'local' as const, stale: false },
      candide: { kind: 'remote' as const, stale: false },
    }
    const a = drafts(feedWith([mirrored('laptop'), mirrored('candide')], origins))
    const b = drafts(feedWith([mirrored('candide'), mirrored('laptop')], origins))
    expect(a[0].originId).toBe(b[0].originId)
    expect(a[0].mirroredOrigins).toEqual(b[0].mirroredOrigins)
  })

  it('collapses on the slug when a row predates uids', () => {
    const feed = feedWith(
      [mirrored('candide', { uid: undefined }), mirrored('laptop', { uid: undefined })],
      { laptop: { kind: 'local', stale: false }, candide: { kind: 'remote', stale: false } },
    )
    expect(drafts(feed)).toHaveLength(1)
  })

  it('never merges two genuinely different fibers', () => {
    const feed = feedWith(
      [
        mirrored('laptop'),
        mirrored('laptop', { id: 'science/unions/other', uid: '01KVR8EWRJX78ZQ6P1MSHMB37F', name: 'Other' }),
      ],
      { laptop: { kind: 'local', stale: false } },
    )
    const cards = drafts(feed)
    expect(cards).toHaveLength(2)
    expect(cards.every((c) => c.mirroredOrigins === undefined)).toBe(true)
  })
})

describe('what the board admits — a shuttle block, or a cycle', () => {
  // The policy: if it is a to-do, it becomes a shuttled thing. A bare `due:`
  // is a date, not a commitment the Desk can act on, so it is promoted rather
  // than shown. The daemon's feed is deliberately wider (it runs a
  // `--has-field due` walk); this is where the board narrows it.
  const row = (over: Partial<Fiber>): CompositeEntry => ({
    origin: 'laptop',
    feltStore: '/store/laptop',
    path: '.felt/x.md',
    fiber: {
      id: 'science/x',
      uid: '01KTCA2D1FGAJNHX5WKQ34BSZG',
      name: 'X',
      status: 'open',
      kind: 'task',
      priority: 2,
      createdAt: at0,
      ...over,
    },
  })
  const boardOf = (entries: CompositeEntry[]) =>
    buildKanbanResponseFromComposite(
      { host: 'laptop', entries, origins: { laptop: { kind: 'local', stale: false, fiberCount: entries.length } } },
      { nowMs: NOW },
    )

  const everywhere = (board: ReturnType<typeof boardOf>): KanbanCard[] => [
    ...board.now.drafts,
    ...board.now.inFlight,
    ...board.now.awaitingReview,
    ...board.timeline.past,
    ...board.timeline.futureDated,
    ...board.timeline.anytimeSoon,
    ...board.stash,
    ...board.pinned,
  ]

  it('turns away an open fiber whose only claim is a due date', () => {
    // It carries a real, future due — the strongest case the old third
    // admission clause had — and it appears on no surface, ribbon included.
    expect(everywhere(boardOf([row({ due: dayFromNow(2) })]))).toEqual([])
  })

  it('admits the same fiber the moment it carries a shuttle block', () => {
    const board = boardOf([
      row({ due: dayFromNow(2), hasShuttleBlock: true, shuttleKind: 'oneshot' }),
    ])
    expect(everywhere(board).map((c) => c.id)).toEqual(['science/x'])
  })

  it('still admits a cycle, which carries neither block nor due', () => {
    // Open-ended on purpose: a `start:` and nothing else is a legitimate band,
    // and the Chronicle must keep drawing it.
    const board = boardOf([row({ id: 'cycles/autumn', tags: ['cycle'], start: dayFromNow(-10) })])
    expect(board.cycles).toHaveLength(1)
    // ...and it reaches the Chronicle without ever touching a Desk column.
    expect(everywhere(board)).toEqual([])
  })
})

describe('Resting clusters split when they overflow', () => {
  // Ordering inside a cluster is by createdAt desc, so give each card a
  // distinct instant to keep assertions stable. The clustering itself is
  // path-only, so these are TZ-independent.
  let tick = 0
  const at = (): string => new Date(NOW - (tick += 60_000)).toISOString()
  const restingCard = (id: string, cold = false): KanbanCard => ({
    id,
    name: id.split('/').pop() ?? id,
    path: `.felt/${id}.md`,
    originId: 'local',
    status: 'open',
    createdAt: at(),
    dependsOnSatisfied: true,
    effectiveHorizon: 'stashed',
    drifted: false,
    isCycle: false,
    cycleStart: null,
    ...(cold ? { cold: true } : {}),
  })
  const keysOf = (cards: KanbanCard[]): Array<[string, number]> =>
    clusterStashCards(cards).map((c) => [c.key, c.cards.length])

  it('leaves a cluster of four alone', () => {
    const cards = ['science/unions/a', 'science/unions/b', 'science/spt3g/c', 'science/spt3g/d']
      .map((id) => restingCard(id))
    expect(keysOf(cards)).toEqual([['science', 4]])
  })

  it('splits six across two subdirectories into two clusters', () => {
    // The case Cail named: "science 6" → "science/unions 3" + "science/spt3g 3".
    const cards = [
      'science/unions/a', 'science/unions/b', 'science/unions/c',
      'science/spt3g/d', 'science/spt3g/e', 'science/spt3g/f',
    ].map((id) => restingCard(id))
    const keys = keysOf(cards)
    expect(keys).toHaveLength(2)
    expect(new Map(keys)).toEqual(new Map([['science/unions', 3], ['science/spt3g', 3]]))
  })

  it('keeps descending until nothing exceeds four', () => {
    // science/unions still holds 5 after one split, so it splits again.
    const cards = [
      'science/unions/sp/a', 'science/unions/sp/b', 'science/unions/sp/c',
      'science/unions/shear/d', 'science/unions/shear/e',
      'science/spt3g/f',
    ].map((id) => restingCard(id))
    const keys = new Map(keysOf(cards))
    expect(keys).toEqual(new Map([
      ['science/unions/sp', 3],
      ['science/unions/shear', 2],
      ['science/spt3g', 1],
    ]))
  })

  it('DEGENERATE CASE: six leaves in one folder stay one cluster', () => {
    // Every card's next segment IS its own name, so descending would make six
    // clusters of one — six headings that say nothing. The group stays whole
    // and the renderer caps it; this is the case the leaf-slug rule exists for.
    const cards = ['a/x1', 'a/x2', 'a/x3', 'a/x4', 'a/x5', 'a/x6'].map((id) => restingCard(id))
    expect(keysOf(cards)).toEqual([['a', 6]])
  })

  it('does not strand a card that has no deeper segment', () => {
    const cards = [
      'science/loose',
      'science/unions/a', 'science/unions/b', 'science/unions/c',
      'science/unions/d', 'science/unions/e',
    ].map((id) => restingCard(id))
    const keys = new Map(keysOf(cards))
    expect(keys).toEqual(new Map([['science', 1], ['science/unions', 5]]))
    // Every card still appears exactly once, wherever it landed.
    expect(clusterStashCards(cards).flatMap((c) => c.cards)).toHaveLength(6)
  })

  it('never mixes warm and cold in one cluster, and sorts cold last', () => {
    const cards = [
      restingCard('science/unions/a'), restingCard('science/unions/b'),
      restingCard('science/unions/c'), restingCard('science/unions/d'),
      restingCard('science/unions/e', true), restingCard('science/unions/f', true),
    ]
    const clusters = clusterStashCards(cards)
    for (const c of clusters) {
      const warmth = new Set(c.cards.map((card) => card.cold === true))
      expect(warmth.size, `cluster ${c.key} mixes warm and cold`).toBe(1)
    }
    expect(clusters.map((c) => c.cold)).toEqual([...clusters.map((c) => c.cold)].sort())
    // Four warm + two cold: neither side is over the cap, so neither splits —
    // the split runs per warmth, not over the pooled six.
    expect(new Map(clusters.map((c) => [`${c.key}:${c.cold}`, c.cards.length])))
      .toEqual(new Map([['science:false', 4], ['science:true', 2]]))
  })

  it('keeps top-level cards under their own name', () => {
    expect(keysOf([restingCard('solo')])).toEqual([['solo', 1]])
  })

  it('loses nothing, whatever the shape', () => {
    const ids = [
      'a/x1', 'a/x2', 'a/x3', 'a/x4', 'a/x5',
      'b/deep/one', 'b/deep/two', 'b/deep/three', 'b/deep/four', 'b/deep/five',
      'b/shallow', 'solo',
    ]
    const clusters = clusterStashCards(ids.map((id) => restingCard(id)))
    expect(clusters.flatMap((c) => c.cards.map((card) => card.id)).sort()).toEqual([...ids].sort())
  })
})

describe('cycles — a named span of time, not work', () => {
  // felt round-trips `start:` exactly as it does `due:`: authored as a bare
  // civil day, re-emitted as midnight-Z. Verified against a real store, and
  // reproduced here, because reading either as an instant loses a day west of
  // Greenwich — the whole reason both go through `dueCivilDay`.
  const asFeltWrites = (day: string): string => `${day}T00:00:00Z`

  const cycle = (over: Partial<Fiber> = {}): Fiber => ({
    id: 'cycles/autumn',
    name: 'Autumn',
    status: 'open',
    kind: 'task',
    priority: 2,
    createdAt: at0,
    tags: ['cycle'],
    ...over,
  })

  describe('isCycleFiber', () => {
    it('reads the tag, whatever its casing or padding', () => {
      expect(isCycleFiber({ tags: ['cycle'] })).toBe(true)
      expect(isCycleFiber({ tags: ['Cycle'] })).toBe(true)
      expect(isCycleFiber({ tags: [' cycle '] })).toBe(true)
      expect(isCycleFiber({ tags: ['planning', 'cycle'] })).toBe(true)
    })

    it('is not fooled by a tag that merely contains it', () => {
      expect(isCycleFiber({ tags: ['cycles'] })).toBe(false)
      expect(isCycleFiber({ tags: ['life-cycle'] })).toBe(false)
      expect(isCycleFiber({ tags: [] })).toBe(false)
      expect(isCycleFiber({})).toBe(false)
    })
  })

  describe('classifyFiber keeps cycles off every lifecycle column', () => {
    // The load-bearing claim: no combination of status, verdict, liveness or a
    // stray shuttle block can put a cycle on the desk. One "Autumn 2026" in
    // Drafts teaches the human to distrust the column.
    const lifecycleShapes: Array<[string, Fiber]> = [
      ['open, no block', cycle({ status: 'open' })],
      ['active, no block', cycle({ status: 'active' })],
      ['closed, no verdict', cycle({ status: 'closed' })],
      ['closed and tempered', cycle({ status: 'closed', tempered: true })],
      ['closed and composted', cycle({ status: 'closed', tempered: false })],
      ['carrying a shuttle block', cycle({ status: 'active', hasShuttleBlock: true, shuttleKind: 'oneshot' })],
      ['a pinned-kind block', cycle({ status: 'active', hasShuttleBlock: true, shuttleKind: 'pinned' })],
      ['a standing block', cycle({ status: 'active', hasShuttleBlock: true, shuttleKind: 'standing' })],
      ['with a past due', cycle({ due: asFeltWrites(dayFromNow(-30)) })],
    ]
    for (const [label, fiber] of lifecycleShapes) {
      it(`routes to cycles: ${label}`, () => {
        expect(classifyFiber(fiber)).toBe('cycles')
      })
    }

    it('routes to cycles even with a live worker — liveness overrides everything ELSE', () => {
      expect(classifyFiber(cycle({ hasShuttleBlock: true }), { runningWorker: true })).toBe('cycles')
    })

    it('leaves ordinary work exactly where it was', () => {
      const work = { ...cycle({ tags: ['planning'] }), hasShuttleBlock: true, status: 'active' }
      expect(classifyFiber(work)).toBe('inFlight')
    })
  })

  describe('cycleSpan', () => {
    it('takes both edges as written', () => {
      const span = cycleSpan(
        { start: asFeltWrites('2026-09-01'), due: asFeltWrites('2026-09-30') },
        NOW,
      )
      expect(span).toEqual({ start: '2026-09-01', end: '2026-09-30', openEnded: false })
    })

    it('reads a bare civil day the same as felt\'s midnight-Z form', () => {
      expect(cycleSpan({ start: '2026-09-01', due: '2026-09-30' }, NOW))
        .toEqual(cycleSpan({ start: asFeltWrites('2026-09-01'), due: asFeltWrites('2026-09-30') }, NOW))
    })

    it('survives an offset that is not Z — a cycle authored in Paris', () => {
      // The bug this guards: read as an instant, `+02:00` midnight is the
      // previous evening in UTC and the band would start a day early.
      expect(cycleSpan({ start: '2026-09-01T00:00:00+02:00', due: '2026-09-30T00:00:00+02:00' }, NOW))
        .toEqual({ start: '2026-09-01', end: '2026-09-30', openEnded: false })
    })

    it('makes a due with no start a ONE-DAY span', () => {
      expect(cycleSpan({ due: asFeltWrites('2026-09-30') }, NOW))
        .toEqual({ start: '2026-09-30', end: '2026-09-30', openEnded: false })
    })

    it('runs a start with no due to today, and says it is open-ended', () => {
      const span = cycleSpan({ start: asFeltWrites('2026-08-01') }, NOW)
      expect(span).toEqual({ start: '2026-08-01', end: isoDayLocal(NOW), openEnded: true })
    })

    it('is null when the human named no dates at all', () => {
      expect(cycleSpan({}, NOW)).toBeNull()
      expect(cycleSpan({ start: 'not a date', due: '' }, NOW)).toBeNull()
    })

    it('reports a backwards span as written rather than silently swapping it', () => {
      // Their typo to see and fix. Swapping would hide it forever.
      expect(cycleSpan({ start: asFeltWrites('2026-09-30'), due: asFeltWrites('2026-09-01') }, NOW))
        .toEqual({ start: '2026-09-30', end: '2026-09-01', openEnded: false })
    })
  })

  describe('upcomingCycleDropTargets — the chapters the drag horizon offers', () => {
    const cycle = (
      id: string,
      cycleStart: string | null,
      due?: string,
    ): CycleDropCandidate => ({ id, name: id, cycleStart, due })

    it('offers a future cycle at its own opening day', () => {
      const targets = upcomingCycleDropTargets(
        [cycle('autumn', dayFromNow(10), dayFromNow(40))],
        NOW,
      )
      expect(targets).toHaveLength(1)
      expect(targets[0]).toMatchObject({
        id: 'autumn',
        start: dayFromNow(10),
        end: dayFromNow(40),
        running: false,
        dropDay: dayFromNow(10),
      })
    })

    it('clamps a running cycle to TOMORROW — later this chapter, never a backdate', () => {
      const targets = upcomingCycleDropTargets(
        [cycle('summer', dayFromNow(-10), dayFromNow(10))],
        NOW,
      )
      expect(targets[0]).toMatchObject({ running: true, dropDay: dayFromNow(1) })
    })

    it('clamps a cycle opening TODAY too — today means "onto the desk", not a snooze', () => {
      const targets = upcomingCycleDropTargets([cycle('opens-now', dayFromNow(0))], NOW)
      expect(targets[0]).toMatchObject({ running: true, dropDay: dayFromNow(1) })
    })

    it('drops a cycle that has already closed', () => {
      expect(upcomingCycleDropTargets(
        [cycle('spring', dayFromNow(-40), dayFromNow(-1))],
        NOW,
      )).toEqual([])
    })

    it('keeps a cycle closing TODAY — the chapter is still open', () => {
      const targets = upcomingCycleDropTargets(
        [cycle('closing', dayFromNow(-10), dayFromNow(0))],
        NOW,
      )
      expect(targets.map((t) => t.id)).toEqual(['closing'])
    })

    it('keeps an open-ended cycle, running, and says so', () => {
      const targets = upcomingCycleDropTargets([cycle('ongoing', dayFromNow(-3))], NOW)
      expect(targets[0]).toMatchObject({
        openEnded: true,
        running: true,
        end: dayFromNow(0),
        dropDay: dayFromNow(1),
      })
    })

    it('is not a target without a start — a bare due is a deadline, not a chapter', () => {
      expect(upcomingCycleDropTargets([cycle('deadline', null, dayFromNow(5))], NOW)).toEqual([])
    })

    it('reads felt\'s midnight-Z start the same as a bare civil day', () => {
      const bare = upcomingCycleDropTargets([cycle('c', dayFromNow(4))], NOW)
      const written = upcomingCycleDropTargets(
        [cycle('c', asFeltWrites(dayFromNow(4)))],
        NOW,
      )
      expect(written).toEqual(bare)
    })

    it('orders by start, so the strip reads as the calendar does', () => {
      const targets = upcomingCycleDropTargets([
        cycle('third', dayFromNow(20)),
        cycle('first', dayFromNow(-2), dayFromNow(3)),
        cycle('second', dayFromNow(5)),
      ], NOW)
      expect(targets.map((t) => t.id)).toEqual(['first', 'second', 'third'])
    })

    it('offers nothing when there are no cycles at all', () => {
      expect(upcomingCycleDropTargets([], NOW)).toEqual([])
    })
  })

  describe('the assembled response', () => {
    const feedOf = (...fibers: Fiber[]): CompositeFeed => ({
      host: 'here',
      entries: fibers.map((fiber) => ({
        origin: 'here',
        feltStore: '/store',
        path: `.felt/${fiber.id}.md`,
        fiber,
      })),
      origins: { here: { kind: 'local', stale: false, fiberCount: fibers.length } },
    })

    const work = (over: Partial<Fiber> = {}): Fiber => ({
      id: 'work/thing',
      name: 'A thing',
      status: 'open',
      kind: 'task',
      priority: 2,
      createdAt: at0,
      hasShuttleBlock: true,
      shuttleKind: 'oneshot',
      ...over,
    })

    it('admits a cycle that has no shuttle block and no due — the open-ended case', () => {
      // The `due`-or-shuttle admission test would drop this row, and an
      // open-ended cycle is a band the views must still draw.
      const resp = buildKanbanResponseFromComposite(
        feedOf(cycle({ start: asFeltWrites('2026-08-01'), due: undefined })),
        { nowMs: NOW },
      )
      expect(resp.cycles.map((c) => c.id)).toEqual(['cycles/autumn'])
    })

    it('puts cycles on their own surface and NOWHERE else', () => {
      const resp = buildKanbanResponseFromComposite(
        feedOf(cycle({ start: asFeltWrites('2026-08-01'), due: asFeltWrites('2026-08-31') }), work()),
        { nowMs: NOW },
      )
      expect(resp.cycles).toHaveLength(1)
      const everywhereElse = [
        ...resp.now.drafts, ...resp.now.inFlight, ...resp.now.awaitingReview,
        ...resp.timeline.past, ...resp.timeline.futureDated, ...resp.timeline.anytimeSoon,
        ...resp.stash, ...resp.pinned,
      ]
      expect(everywhereElse.some((c) => c.isCycle)).toBe(false)
      expect(everywhereElse.map((c) => c.id)).toEqual(['work/thing'])
    })

    it('never counts a cycle in a column total', () => {
      const withoutCycles = buildKanbanResponseFromComposite(feedOf(work()), { nowMs: NOW })
      const withCycles = buildKanbanResponseFromComposite(
        feedOf(
          work(),
          cycle({ id: 'cycles/a', start: asFeltWrites('2026-08-01') }),
          cycle({ id: 'cycles/b', due: asFeltWrites('2026-08-20') }),
        ),
        { nowMs: NOW },
      )
      expect(withCycles.totals).toEqual(withoutCycles.totals)
      expect(withCycles.cycles).toHaveLength(2)
    })

    it('carries the contract fields the views read', () => {
      const resp = buildKanbanResponseFromComposite(
        feedOf(cycle({ start: asFeltWrites('2026-09-01'), due: asFeltWrites('2026-09-30') })),
        { nowMs: NOW },
      )
      const card = resp.cycles[0]
      expect(card.isCycle).toBe(true)
      expect(card.cycleStart).toBe('2026-09-01')  // bare civil day, already normalized
      expect(card.due).toBe(asFeltWrites('2026-09-30'))
    })

    it('leaves cycleStart null on a cycle with no start, and on ordinary work', () => {
      const resp = buildKanbanResponseFromComposite(
        feedOf(cycle({ due: asFeltWrites('2026-09-30') }), work({ due: asFeltWrites('2026-09-30') })),
        { nowMs: NOW },
      )
      expect(resp.cycles[0].cycleStart).toBeNull()
      const workCard = [...resp.now.drafts, ...resp.timeline.futureDated].find((c) => c.id === 'work/thing')
      expect(workCard?.isCycle).toBe(false)
      expect(workCard?.cycleStart).toBeNull()
    })

    it('orders the bands earliest first', () => {
      const resp = buildKanbanResponseFromComposite(
        feedOf(
          cycle({ id: 'cycles/late', start: asFeltWrites('2026-11-01') }),
          cycle({ id: 'cycles/early', start: asFeltWrites('2026-09-01') }),
          cycle({ id: 'cycles/mid', start: asFeltWrites('2026-10-01') }),
        ),
        { nowMs: NOW },
      )
      expect(resp.cycles.map((c) => c.id)).toEqual(['cycles/early', 'cycles/mid', 'cycles/late'])
    })
  })
})

describe('sessionWindow', () => {
  // The rendered clock is the READER's local time, so these assert on shape,
  // not on digits — a fixed "12:01" would only ever be right in one zone.
  const BARE = /^dispatched \d{2}:\d{2}/
  const DATED = /^dispatched [A-Za-z]{3}\.? ?\d{1,2} \d{2}:\d{2}/
  const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()

  it('is nothing at all for a fiber that never ran', () => {
    expect(sessionWindow({}, NOW)).toBeNull()
    expect(sessionWindow({ handedOffAt: at(-3_600_000) }, NOW)).toBeNull()
  })

  it("leaves today's run bare — a date on every line is noise", () => {
    const w = sessionWindow(
      { dispatchedAt: at(-5 * 3_600_000), handedOffAt: at(-90 * 60_000) },
      NOW,
    )
    expect(w?.text).toMatch(BARE)
    expect(w?.text).toContain('3h 30m')
    expect(w?.clean).toBe(true)
  })

  it('dates a run from another day, so it cannot read as today', () => {
    const w = sessionWindow(
      { dispatchedAt: at(-4 * DAY), handedOffAt: at(-4 * DAY + 2 * 3_600_000) },
      NOW,
    )
    expect(w?.text).toMatch(DATED)
    expect(w?.text).toContain('2h 0m')
  })

  it('dates the handoff too when the run crossed midnight', () => {
    // Anchored to local 22:00 so the +4h handoff lands on the next civil day in
    // whatever zone the suite runs in.
    const start = new Date(NOW)
    start.setDate(start.getDate() - 3)
    start.setHours(22, 0, 0, 0)
    const startMs = start.getTime()
    const w = sessionWindow(
      {
        dispatchedAt: new Date(startMs).toISOString(),
        handedOffAt: new Date(startMs + 4 * 3_600_000).toISOString(),
      },
      NOW,
    )
    expect(isoDayLocal(startMs + 4 * 3_600_000)).not.toBe(isoDayLocal(startMs))
    expect(w?.text).toMatch(/handed off [A-Za-z]{3}\.? ?\d{1,2} \d{2}:\d{2}/)
    expect(w?.text).toContain('4h 0m')
  })

  it('says aloft for a live worker, and claims no clean exit', () => {
    const w = sessionWindow(
      { dispatchedAt: at(-20 * 60_000), runningWorker: 'a-shuttle' },
      NOW,
    )
    expect(w?.text).toMatch(/· aloft$/)
    expect(w?.clean).toBe(false)
  })

  it('refuses a handoff stamp older than the dispatch — that is the PREVIOUS run', () => {
    // The real shape seen in the loom: a stale `handed_off_at` left over from an
    // earlier run. Reading it as this run's would print a negative span under a
    // teal check.
    const w = sessionWindow(
      { dispatchedAt: at(-2 * 3_600_000), handedOffAt: at(-6 * 3_600_000) },
      NOW,
    )
    expect(w?.text).toMatch(/· no clean handoff$/)
    expect(w?.clean).toBe(false)
    expect(w?.text).not.toMatch(/-\d/)
  })
})

describe('humanizeCron', () => {
  it('says the cadences a person says', () => {
    expect(humanizeCron('0 9 * * 1-5')).toBe('weekdays 9:00')
    expect(humanizeCron('30 6 * * *')).toBe('daily 6:30')
    expect(humanizeCron('0 8 * * 1')).toBe('Mon 8:00')
    expect(humanizeCron('15 20 * * 0,6')).toBe('weekends 20:15')
    expect(humanizeCron('0 7 * * 1,3,5')).toBe('Mon, Wed, Fri 7:00')
  })

  it('stays silent rather than lie about a schedule it cannot say', () => {
    expect(humanizeCron('*/15 * * * *')).toBeUndefined()   // many hours
    expect(humanizeCron('0 9 1 * *')).toBeUndefined()      // day-of-month
    expect(humanizeCron('0 9 * 3 *')).toBeUndefined()      // one month only
    expect(humanizeCron('not a cron')).toBeUndefined()
    expect(humanizeCron('')).toBeUndefined()
    expect(humanizeCron(undefined)).toBeUndefined()
  })
})
