// Rules the desk depends on, pinned in both hemispheres.
//
// `npm test` runs this file twice — TZ=America/Los_Angeles and TZ=Europe/Paris
// — because the snooze rules turn on CIVIL DAYS and the classic failure is a
// negative-offset zone reading UTC midnight as the previous evening. Every due
// here is therefore built FROM the reference instant with `isoDayLocal`, never
// written as a literal date: a hardcoded `2026-08-12` would name a different
// day either side of the Atlantic and the test would only be checking one.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildDependents,
  cardDragArms,
  queueMemberNote,
  queueRowGesture,
  chainTail,
  classifyFiber,
  cycleMembership,
  cycleSpan,
  dueBouncesFromResting,
  effectiveHorizon,
  humanizeCron,
  inStackHotZone,
  intersectRects,
  isCycleFiber,
  lensCycles,
  queueDropIndex,
  queuedBehind,
  queuedChipLabel,
  reorderQueueWrites,
  restingUntil,
  stackZoneOffered,
  unqueueRowWrites,
  stackClaimsDrop,
  stackDropVerdict,
  upcomingCycleDropTargets,
} from './KanbanRules.js'
import type { CycleDropCandidate, StackCandidate } from './KanbanRules.js'
import type { Fiber } from './KanbanFiber.js'
import { mapFeltJsonToFiber } from './KanbanFiber.js'
import type { CompositeEntry, CompositeFeed } from './KanbanComposite.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { buildKanbanResponseFromComposite, cardFromCompositeEntry, deriveCycleLens, isSleepingOnSchedule, restingCards } from './KanbanReadModel.js'
import {
  clusterStashCards,
  findCardById,
  formatLaunchDay,
  KanbanSurfaceRenderer,
  phasePillLabel,
  sortDatedByReturn,
  splitStashByReturn,
  unsettledDependents,
} from './KanbanSurfaces.js'
import { chromeRestartDirective, chromeRestartNeeded, sessionWindow } from './FiberDetailModal.js'
import { isoDayLocal } from './civilDay.js'
import { humanizeIdleAge } from './utils.js'

const NOW = Date.parse('2026-08-08T15:30:00Z')
const DAY = 86_400_000
const dayFromNow = (n: number): string => isoDayLocal(NOW + n * DAY)
const at0 = new Date(NOW - 30 * DAY).toISOString()

describe('Chrome axis changes', () => {
  it('restarts a live worker when the setting changes', () => {
    expect(chromeRestartNeeded({ runningWorker: 'shuttle-fiber' }, false, true)).toBe(true)
    expect(chromeRestartNeeded({ runningWorker: 'shuttle-fiber' }, true, false)).toBe(true)
  })

  it('does not restart a dormant worker or an unchanged setting', () => {
    expect(chromeRestartNeeded({}, false, true)).toBe(false)
    expect(chromeRestartNeeded({ runningWorker: 'shuttle-fiber' }, true, true)).toBe(false)
  })

  it('gives the replacement worker a short Chrome-specific directive', () => {
    expect(chromeRestartDirective(true)).toBe('This session was resumed to give you Chrome.')
    expect(chromeRestartDirective(false)).toBe('This session was restarted with Chrome disabled.')
  })
})

describe('effectiveHorizon — snooze is due + stashed, composed', () => {
  it('rests a stashed card whose due is still ahead', () => {
    const h = effectiveHorizon({ horizon: 'stashed', due: dayFromNow(3) }, NOW)
    expect(h.effectiveHorizon).toBe('stashed')
    expect(h.drifted).toBe(false)
  })

  it('leaves a plain future-dated card on the desk — a due alone never exiles', () => {
    // The control for the case above: without a stored horizon the same due is
    // just a date the card wears. Only an explicit snooze takes it off the
    // desk. (The regression this pins: such cards resolved to a `soon` surface
    // that no longer had anywhere to render, so they vanished from the Desk.)
    const h = effectiveHorizon({ due: dayFromNow(3) }, NOW)
    expect(h.effectiveHorizon).toBe('now')
    expect(h.drifted).toBe(false)
  })

  it('reads a legacy `horizon: soon` as no horizon at all', () => {
    // The surface it named is gone; the card belongs on the desk with its date.
    const h = effectiveHorizon({ horizon: 'soon', due: dayFromNow(3) }, NOW)
    expect(h.effectiveHorizon).toBe('now')
    expect(h.storedHorizon).toBeUndefined()
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

// What a drag into Resting does with a `due:` it was not handed. The gesture
// PRESERVES the date — deleting what the human wrote was the bug — except for
// the one date that cannot survive the trip.
describe('dueBouncesFromResting', () => {
  it('STASH PRESERVES A FUTURE DUE — the snooze that comes back on its own', () => {
    // The Croatia case: a card due in October, dropped into Resting in August.
    // False here means setSurface leaves the `due:` alone, so the card rests as
    // `horizon: stashed` + a future date and the drift branch returns it on the
    // day. This is the whole point of the rule.
    expect(dueBouncesFromResting(dayFromNow(1), NOW)).toBe(false)
    expect(dueBouncesFromResting(dayFromNow(49), NOW)).toBe(false)
  })

  it('STASH DROPS A STALE DUE — it would land the card straight back on the desk', () => {
    // Today counts as stale: `effectiveHorizon` promotes on `due <= today`, so
    // keeping either of these would put the card back in Drafts on the next
    // poll and the drag would read as ignored.
    expect(dueBouncesFromResting(dayFromNow(0), NOW)).toBe(true)
    expect(dueBouncesFromResting(dayFromNow(-3), NOW)).toBe(true)
  })

  it('has nothing to say about a card with no date', () => {
    expect(dueBouncesFromResting(undefined, NOW)).toBe(false)
  })

  it('judges the civil day the due NAMES, through felt\'s midnight storage', () => {
    // The hemisphere trap: tomorrow written at midnight in any offset is still
    // tomorrow, and must survive the stash in both TZs this file runs under.
    for (const offset of ['Z', '+02:00', '-07:00']) {
      expect(dueBouncesFromResting(`${dayFromNow(1)}T00:00:00${offset}`, NOW)).toBe(false)
      expect(dueBouncesFromResting(`${dayFromNow(-1)}T00:00:00${offset}`, NOW)).toBe(true)
    }
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
    expect(phasePillLabel('attention', NOW - 4 * 60_000, NOW)).toBe('☞︎ needs you')
    expect(phasePillLabel('attention', NOW - 90 * 60_000, NOW)).toBe('☞︎ needs you · 1h')
  })

  it('falls back to the bare label with no activity stamp', () => {
    expect(phasePillLabel('waiting', undefined, NOW)).toBe('⏸ waiting')
    expect(phasePillLabel('dispatched', NOW - DAY, NOW)).toBe('▸ dispatched')
  })
})

describe('a mirrored fiber renders as ONE card', () => {
  // Shape taken from the real board: 245 rows for 240 fibers, five of them
  // served by both the laptop and `kelvin` out of the same git-synced store.
  const mirrored = (origin: string, over: Partial<Fiber> = {}): CompositeEntry => ({
    origin,
    feltStore: `/store/${origin}`,
    path: '.felt/science/unions/final-push.md',
    fiber: {
      id: 'science/unions/final-push',
      uid: '01KTCA2D1FGAJNHX5WKQ34BSZF',
      name: 'Final push',
      status: 'open',
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

  it('lands a future-dated draft in Drafts, not off the board', () => {
    // The Desk regression: a fresh draft with `due: <future>` routed to a
    // planning surface with no permanent home and showed up nowhere.
    const feed = feedWith(
      [mirrored('laptop', { due: dayFromNow(21) })],
      { laptop: { kind: 'local', stale: false } },
    )
    const resp = buildKanbanResponseFromComposite(feed, { nowMs: NOW })
    expect(resp.now.drafts.map((c) => c.id)).toEqual(['science/unions/final-push'])
    expect(resp.now.drafts[0].due).toBeDefined()
    expect(resp.stash).toHaveLength(0)
    expect(resp.timeline.futureDated).toHaveLength(0)
  })

  it('still rests a SNOOZED draft — stashed plus the same future due', () => {
    const feed = feedWith(
      [mirrored('laptop', { horizon: 'stashed', due: dayFromNow(21) })],
      { laptop: { kind: 'local', stale: false } },
    )
    const resp = buildKanbanResponseFromComposite(feed, { nowMs: NOW })
    expect(resp.now.drafts).toHaveLength(0)
    expect(resp.stash.map((c) => c.id)).toEqual(['science/unions/final-push'])
  })

  it('keeps the LOCAL row when a remote mirrors it', () => {
    const feed = feedWith(
      [mirrored('kelvin'), mirrored('laptop')],
      { laptop: { kind: 'local', stale: false }, kelvin: { kind: 'remote', stale: false } },
    )
    const cards = drafts(feed)
    expect(cards).toHaveLength(1)
    expect(cards[0].originId).toBe('laptop')
    expect(cards[0].mirroredOrigins).toEqual(['kelvin'])
  })

  it('keeps the local row even when the remote copy is newer', () => {
    // Writes go to the host that owns it, and its liveness is first-hand.
    const feed = feedWith(
      [
        mirrored('kelvin', { modifiedAt: new Date(NOW).toISOString() }),
        mirrored('laptop', { modifiedAt: new Date(NOW - 10 * DAY).toISOString() }),
      ],
      { laptop: { kind: 'local', stale: false }, kelvin: { kind: 'remote', stale: false } },
    )
    expect(drafts(feed)[0].originId).toBe('laptop')
  })

  it('prefers a FRESH remote over a stale one when neither is local', () => {
    // The defect this kills: under a stale remote one twin dimmed and refused
    // drag while the other looked fine, so which card you grabbed decided
    // whether the gesture worked.
    const feed = feedWith(
      [mirrored('basalt'), mirrored('kelvin')],
      {
        laptop: { kind: 'local', stale: false },
        basalt: { kind: 'remote', stale: true },
        kelvin: { kind: 'remote', stale: false },
      },
    )
    const cards = drafts(feed)
    expect(cards).toHaveLength(1)
    expect(cards[0].originId).toBe('kelvin')
  })

  it('falls back to the newest modifiedAt among equals', () => {
    const feed = feedWith(
      [
        mirrored('basalt', { modifiedAt: new Date(NOW - 5 * DAY).toISOString() }),
        mirrored('talus', { modifiedAt: new Date(NOW - 1 * DAY).toISOString() }),
      ],
      {
        laptop: { kind: 'local', stale: false },
        basalt: { kind: 'remote', stale: false },
        talus: { kind: 'remote', stale: false },
      },
    )
    expect(drafts(feed)[0].originId).toBe('talus')
  })

  it('is stable whichever order the feed lists them in', () => {
    const origins = {
      laptop: { kind: 'local' as const, stale: false },
      kelvin: { kind: 'remote' as const, stale: false },
    }
    const a = drafts(feedWith([mirrored('laptop'), mirrored('kelvin')], origins))
    const b = drafts(feedWith([mirrored('kelvin'), mirrored('laptop')], origins))
    expect(a[0].originId).toBe(b[0].originId)
    expect(a[0].mirroredOrigins).toEqual(b[0].mirroredOrigins)
  })

  it('collapses on the slug when a row predates uids', () => {
    const feed = feedWith(
      [mirrored('kelvin', { uid: undefined }), mirrored('laptop', { uid: undefined })],
      { laptop: { kind: 'local', stale: false }, kelvin: { kind: 'remote', stale: false } },
    )
    expect(drafts(feed)).toHaveLength(1)
  })

  describe('an OWNED fiber answers only through its owner', () => {
    // The defect: a fiber owned by `kelvin` but mirrored into the laptop's
    // git-synced store. The mirror won the card on local-first precedence, and
    // a mirror can neither observe the tmux worker (the card landed In flight
    // with no `▸ aloft` pill — no way to join a session running fine) nor be
    // written to (`originId` addressed the mirror, so transitions went there).
    // The daemon stopped serving these rows in 5669fc7; this is the board-side
    // half of the same rule, and what protects it during a mixed-version fleet.
    const inFlight = (feed: CompositeFeed): KanbanCard[] =>
      buildKanbanResponseFromComposite(feed, { nowMs: NOW }).now.inFlight
    const owned = (origin: string, over: Partial<CompositeEntry> = {}): CompositeEntry => ({
      ...mirrored(origin, { status: 'active', shuttleHost: 'kelvin' }),
      ...over,
    })
    const origins = {
      laptop: { kind: 'local' as const, stale: false },
      kelvin: { kind: 'remote' as const, stale: false },
    }

    it('gives the OWNER row the card — writes route by originId', () => {
      // Ownership outranks locality: the laptop's git mirror of a kelvin-owned
      // fiber is a copy nobody edits through the board (every write is
      // owner-routed) and nobody can observe. Letting it win made `originId`
      // address the mirror.
      const feed = feedWith([owned('kelvin'), owned('laptop')], origins)
      const cards = inFlight(feed)
      expect(cards).toHaveLength(1)
      expect(cards[0].originId).toBe('kelvin')
      expect(cards[0].mirroredOrigins).toEqual(['laptop'])
    })

    it('keeps the owner row even when it is STALE — waiting beats a fresh mirror', () => {
      const feed = feedWith([owned('kelvin'), owned('laptop')], {
        laptop: { kind: 'local', stale: false },
        kelvin: { kind: 'remote', stale: true },
      })
      expect(inFlight(feed)[0].originId).toBe('kelvin')
    })

    it('carries the owner’s worker onto the card it won', () => {
      const feed = feedWith(
        [
          owned('kelvin', {
            runtime: { tmuxSession: 'final-push-01K-shuttle', phase: 'attention', lastActivityAt: NOW },
          }),
          owned('laptop'),
        ],
        origins,
      )
      const cards = inFlight(feed)
      expect(cards).toHaveLength(1)
      expect(cards[0].originId).toBe('kelvin')
      expect(cards[0].runningWorker).toBe('final-push-01K-shuttle')
      expect(cards[0].runtimePhase).toBe('attention')
      expect(cards[0].shuttleHost).toBe('kelvin')
    })

    it('carries the owner’s boot-quarantine hold too', () => {
      const feed = feedWith(
        [owned('kelvin', { held: true, heldSince: NOW - 60_000 }), owned('laptop')],
        origins,
      )
      const cards = inFlight(feed)
      expect(cards[0].held).toBe(true)
      expect(cards[0].heldSince).toBe(NOW - 60_000)
    })

    it('drops a NON-owner row’s liveness rather than believing it', () => {
      // A leaked mirror row (pre-5669fc7 daemon, renamed host) claiming a
      // worker would have the board offering to open — and to kill — a session
      // that host does not run. If the owner is absent from the feed entirely,
      // the card reads worker-less; that is the truth available.
      const feed = feedWith(
        [owned('laptop', { runtime: { tmuxSession: 'ghost-shuttle', phase: 'working' } })],
        origins,
      )
      const cards = inFlight(feed)
      expect(cards[0].originId).toBe('laptop')
      expect(cards[0].runningWorker).toBeUndefined()
    })

    it('leaves an OWNERLESS mirrored fiber on the old local-first rule', () => {
      // No `shuttle.host` means no owner to defer to — a plain due-card or
      // cycle roots equally in every store, and has no liveness to lose.
      const feed = feedWith([mirrored('kelvin'), mirrored('laptop')], origins)
      expect(drafts(feed)[0].originId).toBe('laptop')
    })
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
    // The case the operator named: "science 6" → "science/unions 3" + "science/spt3g 3".
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

  describe('splitStashByReturn — the watch list vs. the already-scheduled', () => {
    it('sorts a bare snooze into dated, a plain rester into undated', () => {
      const snoozed = { ...restingCard('project/snoozed'), due: dayFromNow(3) }
      const forgettable = restingCard('project/forgettable')
      const { undated, dated } = splitStashByReturn([snoozed, forgettable])
      expect(undated.map((c) => c.id)).toEqual(['project/forgettable'])
      expect(dated.map((c) => c.id)).toEqual(['project/snoozed'])
    })

    it('counts a standing role asleep on its cron as dated even with no due', () => {
      const sleeping: KanbanCard = {
        ...restingCard('roles/sleeper'),
        shuttleKind: 'standing',
        status: 'active',
        runningWorker: undefined,
      }
      const { undated, dated } = splitStashByReturn([sleeping])
      expect(undated).toEqual([])
      expect(dated.map((c) => c.id)).toEqual(['roles/sleeper'])
    })

    it('loses nothing across the split', () => {
      const cards = [
        restingCard('a'),
        { ...restingCard('b'), due: dayFromNow(1) },
        restingCard('c'),
      ]
      const { undated, dated } = splitStashByReturn(cards)
      expect([...undated, ...dated].map((c) => c.id).sort()).toEqual(['a', 'b', 'c'])
    })
  })

  describe('sortDatedByReturn — soonest return first', () => {
    it('orders clusters and the cards within them by ascending return date', () => {
      const later = { ...restingCard('proj/later'), due: dayFromNow(10) }
      const soon = { ...restingCard('other/soon'), due: dayFromNow(1) }
      const clusters = sortDatedByReturn(clusterStashCards([later, soon]))
      expect(clusters.flatMap((c) => c.cards.map((card) => card.id))).toEqual(['other/soon', 'proj/later'])
    })

    it('sorts a sleeping role by its next cron launch, not createdAt', () => {
      const withinCluster = [
        { ...restingCard('proj/a'), due: dayFromNow(5) },
        { ...restingCard('proj/b'), due: dayFromNow(2) },
      ]
      const clusters = sortDatedByReturn(clusterStashCards(withinCluster))
      expect(clusters[0].cards.map((c) => c.id)).toEqual(['proj/b', 'proj/a'])
    })
  })
})

describe('renderPinnedSection — the launcher band never pages', () => {
  // THE BUG THIS PINS: the band used to cap itself to two rows and hide the
  // rest of a busy pinned set behind a "+N more" cycler. A launcher's whole
  // point is muscle memory — a role should sit in the same place every visit
  // — and a click tax to reach page 2 broke exactly that. The row cap is now
  // on the person doing the pinning, not on the strip: every pinned role
  // renders, however many rows that takes.
  //
  // No jsdom in this repo, so a minimal fake element stands in — just enough
  // of the DOM surface (className/classList, append, querySelector[All]) for
  // `renderPinnedSection` and `renderPinnedChip` to run and be inspected.
  class FakeEl {
    readonly tagName: string
    private _className = ''
    readonly children: FakeEl[] = []
    readonly dataset: Record<string, string> = {}
    readonly style: Record<string, string> = {}
    textContent = ''
    title = ''
    draggable = false

    constructor(tagName: string) {
      this.tagName = tagName
    }

    get className(): string {
      return this._className
    }
    set className(value: string) {
      this._className = value
    }

    readonly classList = {
      add: (...names: string[]): void => {
        const set = new Set(this._className.split(' ').filter(Boolean))
        for (const n of names) set.add(n)
        this._className = [...set].join(' ')
      },
      remove: (...names: string[]): void => {
        const set = new Set(this._className.split(' ').filter(Boolean))
        for (const n of names) set.delete(n)
        this._className = [...set].join(' ')
      },
      contains: (name: string): boolean => this._className.split(' ').includes(name),
    }

    setAttribute(): void {}
    addEventListener(): void {}
    append(...nodes: FakeEl[]): void {
      this.children.push(...nodes)
    }

    private matches(selector: string): boolean {
      return selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : this.tagName === selector
    }
    querySelectorAll(selector: string): FakeEl[] {
      const out: FakeEl[] = []
      const walk = (el: FakeEl): void => {
        for (const child of el.children) {
          if (child.matches(selector)) out.push(child)
          walk(child)
        }
      }
      walk(this)
      return out
    }
    querySelector(selector: string): FakeEl | null {
      return this.querySelectorAll(selector)[0] ?? null
    }
  }

  afterEach(() => vi.unstubAllGlobals())

  const renderer = (): KanbanSurfaceRenderer => {
    vi.stubGlobal('document', { createElement: (tag: string) => new FakeEl(tag) })
    return new KanbanSurfaceRenderer({
      getDragSourceId: () => null,
      setDragSourceId: () => {},
      getLastResponse: () => null,
      stopDragAutoScroll: () => {},
      transition: () => {},
      setSurface: () => {},
      pin: () => {},
      openDetail: () => {},
      onRefresh: () => {},
    })
  }

  const pinnedCard = (id: string): KanbanCard => ({
    id,
    name: id.split('/').pop() ?? id,
    path: `.felt/${id}.md`,
    originId: 'local',
    status: 'active',
    createdAt: new Date(NOW).toISOString(),
    dependsOnSatisfied: true,
    effectiveHorizon: 'now',
    drifted: false,
    isCycle: false,
    cycleStart: null,
    shuttleKind: 'pinned',
  })

  it('renders every pinned chip — no pager, however many roles', () => {
    const cards = Array.from({ length: 14 }, (_, i) => pinnedCard(`roles/role-${i}`))
    const section = renderer().renderPinnedSection(cards, {})
    const row = section.querySelector('.kbn-pinned-row')
    expect(row).not.toBeNull()
    expect(row!.querySelectorAll('.kbn-pin-chip')).toHaveLength(14)
    expect(row!.querySelector('.kbn-pin-more')).toBeNull()
    expect(section.querySelector('.kbn-tl-pager')).toBeNull()
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
        ...resp.timeline.past, ...resp.timeline.futureDated,
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

describe('the cycle lens — membership is derived, never assigned', () => {
  const asFeltWrites = (day: string): string => `${day}T00:00:00Z`

  // A span we are living in: opened three days ago, closes in ten.
  const span = cycleSpan(
    { start: asFeltWrites(dayFromNow(-3)), due: asFeltWrites(dayFromNow(10)) },
    NOW,
  )!

  describe('cycleMembership', () => {
    it('admits a fiber whose due falls inside the span', () => {
      expect(cycleMembership({ due: asFeltWrites(dayFromNow(4)) }, span, NOW)).toBe('due')
    })

    it('admits both edges — the span is inclusive', () => {
      expect(cycleMembership({ due: asFeltWrites(dayFromNow(-3)) }, span, NOW)).toBe('due')
      expect(cycleMembership({ due: asFeltWrites(dayFromNow(10)) }, span, NOW)).toBe('due')
    })

    it('refuses a due one day outside either edge', () => {
      expect(cycleMembership({ due: asFeltWrites(dayFromNow(-4)) }, span, NOW)).toBeNull()
      expect(cycleMembership({ due: asFeltWrites(dayFromNow(11)) }, span, NOW)).toBeNull()
    })

    it('admits work in flight now — the chapter we are living in claims it', () => {
      expect(cycleMembership({ inFlight: true }, span, NOW)).toBe('in-flight')
    })

    it('does NOT let in-flight work claim a chapter that has not opened', () => {
      const ahead = cycleSpan(
        { start: asFeltWrites(dayFromNow(20)), due: asFeltWrites(dayFromNow(30)) },
        NOW,
      )!
      expect(cycleMembership({ inFlight: true }, ahead, NOW)).toBeNull()
      // …but a due inside it still does. In-flight is about now; a due is not.
      expect(cycleMembership({ inFlight: true, due: asFeltWrites(dayFromNow(25)) }, ahead, NOW)).toBe('due')
    })

    it('is null for a dateless fiber sitting at rest — a non-member', () => {
      expect(cycleMembership({}, span, NOW)).toBeNull()
      expect(cycleMembership({ inFlight: false, due: undefined }, span, NOW)).toBeNull()
    })

    it('has the activity rung ready for the day a caller can supply it', () => {
      // The Desk never fills `workedDays` — the days live in the temporal feeds
      // it does not fetch — so this rung is dark there and live here.
      expect(cycleMembership({ workedDays: [dayFromNow(-1)] }, span, NOW)).toBe('worked')
      expect(cycleMembership({ workedDays: [dayFromNow(-40)] }, span, NOW)).toBeNull()
      expect(cycleMembership({ workedDays: [] }, span, NOW)).toBeNull()
    })
  })

  describe('lensCycles — which chapters the Desk offers', () => {
    const c = (over: Partial<CycleDropCandidate>): CycleDropCandidate =>
      ({ id: 'cycles/x', name: 'X', cycleStart: null, ...over })

    it('offers the running chapter and the ones ahead, earliest first', () => {
      const chips = lensCycles([
        c({ id: 'cycles/next', name: 'Next', cycleStart: dayFromNow(20), due: asFeltWrites(dayFromNow(40)) }),
        c({ id: 'cycles/now', name: 'Now', cycleStart: dayFromNow(-3), due: asFeltWrites(dayFromNow(10)) }),
      ], NOW)
      expect(chips.map((k) => k.id)).toEqual(['cycles/now', 'cycles/next'])
      expect(chips[0].running).toBe(true)
      expect(chips[1].running).toBe(false)
    })

    it('drops a chapter that has already closed', () => {
      const chips = lensCycles([
        c({ cycleStart: dayFromNow(-60), due: asFeltWrites(dayFromNow(-30)) }),
      ], NOW)
      expect(chips).toEqual([])
    })

    it('admits a due-only cycle, which the drop-target rule refuses', () => {
      // A lens needs no opening day to snooze to — a one-day span filters fine.
      const bare = [c({ id: 'cycles/deadline', name: 'Deadline', due: asFeltWrites(dayFromNow(5)) })]
      expect(lensCycles(bare, NOW).map((k) => k.id)).toEqual(['cycles/deadline'])
      expect(upcomingCycleDropTargets(bare, NOW)).toEqual([])
    })

    it('has nothing to say about a cycle with no dates at all', () => {
      expect(lensCycles([c({})], NOW)).toEqual([])
    })
  })

  describe('deriveCycleLens — what the Desk draws differently', () => {
    const card = (over: Partial<KanbanCard>): KanbanCard => ({
      id: 'work/a',
      name: 'A',
      path: 'work/a.md',
      originId: 'here',
      status: 'active',
      createdAt: at0,
      dependsOnSatisfied: true,
      effectiveHorizon: 'now',
      drifted: false,
      isCycle: false,
      cycleStart: null,
      ...over,
    })

    const board = (over: Partial<KanbanResponse> = {}): KanbanResponse => ({
      feltHost: 'here',
      now: { drafts: [], inFlight: [], awaitingReview: [] },
      timeline: { past: [], futureDated: [] },
      stash: [],
      pinned: [],
      cycles: [card({
        id: 'cycles/now', name: 'Now', isCycle: true,
        cycleStart: dayFromNow(-3), due: asFeltWrites(dayFromNow(10)),
      })],
      totals: {
        drafts: 0, inFlight: 0, awaitingReview: 0,
        past: 0, futureDated: 0, stash: 0, pinned: 0,
      },
      temperedTotal: 0,
      staleness: {},
      generatedAt: NOW,
      ...over,
    })

    it('claims the due-in-span and the in-flight, and leaves the rest alone', () => {
      const lens = deriveCycleLens(board({
        now: {
          drafts: [
            card({ id: 'work/due', due: asFeltWrites(dayFromNow(2)) }),
            card({ id: 'work/later', due: asFeltWrites(dayFromNow(60)) }),
            card({ id: 'work/undated' }),
          ],
          inFlight: [card({ id: 'work/aloft', runningWorker: 'sess' })],
          awaitingReview: [],
        },
      }), 'cycles/now', NOW)!
      expect([...lens.memberIds].sort()).toEqual(['work/aloft', 'work/due'])
      expect(lens.ghosts).toEqual([])
      expect(lens.count).toBe(2)
      expect(lens.name).toBe('Now')
    })

    it('conjures a resting member as a ghost in the column it would sit in', () => {
      const resting = card({
        id: 'work/snoozed',
        status: 'open',
        due: asFeltWrites(dayFromNow(5)),
        storedHorizon: 'stashed',
        effectiveHorizon: 'stashed',
      })
      const lens = deriveCycleLens(board({ stash: [resting] }), 'cycles/now', NOW)!
      expect(lens.ghosts.map((g) => [g.card.id, g.column])).toEqual([['work/snoozed', 'drafts']])
      expect(lens.memberIds.has('work/snoozed')).toBe(true)
      expect(lens.count).toBe(1)
    })

    it('leaves a resting card that is due outside the span alone', () => {
      const lens = deriveCycleLens(board({
        stash: [card({ id: 'work/far', effectiveHorizon: 'stashed', due: asFeltWrites(dayFromNow(90)) })],
      }), 'cycles/now', NOW)!
      expect(lens.ghosts).toEqual([])
      expect(lens.count).toBe(0)
    })

    it('is null with no lens asked for, and null for a cycle the feed has lost', () => {
      expect(deriveCycleLens(board(), null, NOW)).toBeNull()
      expect(deriveCycleLens(board(), 'cycles/vanished', NOW)).toBeNull()
      expect(deriveCycleLens(null, 'cycles/now', NOW)).toBeNull()
    })

    it('is null for a cycle with no dates — there is no span to look through', () => {
      const dateless = board({
        cycles: [card({ id: 'cycles/vague', name: 'Vague', isCycle: true })],
      })
      expect(deriveCycleLens(dateless, 'cycles/vague', NOW)).toBeNull()
    })
  })
})

describe('Resting holds standing roles asleep between runs', () => {
  // The hole this closes: `classifyFiber` calls an armed standing role
  // `scheduled` and the read model files it on the timeline surface. The Desk
  // stopped drawing a timeline, so `finances/cc-bills-monthly` — armed, monthly,
  // perfectly healthy — was on no surface a human could see.
  const role = (over: Partial<Fiber> = {}): CompositeEntry => ({
    origin: 'laptop',
    feltStore: '/store/laptop',
    path: '.felt/finances/cc-bills-monthly.md',
    fiber: {
      id: 'finances/cc-bills-monthly',
      name: 'CC bills',
      status: 'active',
      createdAt: at0,
      hasShuttleBlock: true,
      shuttleKind: 'standing',
      shuttleSchedule: { expr: '0 9 12 * *', tz: 'UTC' },
      ...over,
    },
  })
  const boardOf = (entries: CompositeEntry[]): KanbanResponse =>
    buildKanbanResponseFromComposite(
      { host: 'laptop', entries, origins: { laptop: { kind: 'local', stale: false, fiberCount: entries.length } } },
      { nowMs: NOW },
    )

  it('draws an armed standing role in Resting, with a next launch to show', () => {
    const resp = boardOf([role()])
    const resting = restingCards(resp)
    expect(resting.map((c) => c.id)).toEqual(['finances/cc-bills-monthly'])
    expect(isSleepingOnSchedule(resting[0])).toBe(true)
    // The day the chip names comes from the cron, and it is a real instant.
    expect(resting[0].nextLaunchAt).toBeDefined()
    expect(formatLaunchDay(resting[0].nextLaunchAt!)).not.toBe('')
    // And it is nowhere on the desk — Resting is its only home.
    expect(resp.now.drafts).toEqual([])
    expect(resp.now.inFlight).toEqual([])
    expect(resp.now.awaitingReview).toEqual([])
  })

  it('keeps snoozed work and sleeping roles in the same region, told apart', () => {
    const snoozed: CompositeEntry = {
      origin: 'laptop',
      feltStore: '/store/laptop',
      path: '.felt/work/later.md',
      fiber: {
        id: 'work/later', name: 'Later', status: 'open',
        createdAt: at0, hasShuttleBlock: true, shuttleKind: 'oneshot',
        horizon: 'stashed', due: dayFromNow(6),
      },
    }
    const resting = restingCards(boardOf([role(), snoozed]))
    expect(resting.map((c) => c.id).sort()).toEqual(['finances/cc-bills-monthly', 'work/later'])
    const bySleep = Object.fromEntries(resting.map((c) => [c.id, isSleepingOnSchedule(c)]))
    expect(bySleep).toEqual({ 'finances/cc-bills-monthly': true, 'work/later': false })
  })

  it('sends a RUNNING standing role to In flight, not to Resting', () => {
    // Live work is activity worth showing on the desk; the liveness branch of
    // classifyFiber already owns this and Resting must not double-claim it.
    const resp = buildKanbanResponseFromComposite(
      {
        host: 'laptop',
        entries: [{ ...role(), runtime: { tmuxSession: 'shuttle-cc', phase: 'running' } }],
        origins: { laptop: { kind: 'local', stale: false, fiberCount: 1 } },
      },
      { nowMs: NOW },
    )
    expect(resp.now.inFlight.map((c) => c.id)).toEqual(['finances/cc-bills-monthly'])
    expect(restingCards(resp)).toEqual([])
  })

  it('leaves a CLOSED standing role in Awaiting review — it wants a verdict, not a nap', () => {
    // What the daemon actually does (shuttle standing-roles reference): a
    // standing role's run ends `status:closed` + untempered, which IS the
    // awaiting-review state, and `felt shuttle accept` re-arms it to `active`.
    // So a closed role is not parked — it is holding a work product for you —
    // and drawing it asleep in Resting would hide the one thing it needs.
    const resp = boardOf([role({ status: 'closed', outcome: 'Paid 3 bills' })])
    expect(resp.now.awaitingReview.map((c) => c.id)).toEqual(['finances/cc-bills-monthly'])
    expect(restingCards(resp)).toEqual([])
  })

  it('leaves a PAUSED standing role in Drafts, where pause put it', () => {
    // `felt shuttle pause` writes status:open and preserves the schedule. An
    // open role is not armed, so it has no next launch to sleep until.
    const resp = boardOf([role({ status: 'open' })])
    expect(resp.now.drafts.map((c) => c.id)).toEqual(['finances/cc-bills-monthly'])
    expect(restingCards(resp)).toEqual([])
    expect(resp.now.drafts[0].nextLaunchAt).toBeUndefined()
    expect(isSleepingOnSchedule(resp.now.drafts[0])).toBe(false)
  })

  it('files a far-off role in the SAME list as an imminent one', () => {
    // The collapse, stated: how far away a role's next firing is decides
    // nothing. A yearly role (next run ~5 months out, past any strip) and a
    // daily one (tomorrow) land in one `timeline.futureDated`, because the
    // board draws them identically — one Resting region, one chip apiece.
    const resp = boardOf([
      role({ shuttleSchedule: { expr: '0 9 1 1 *', tz: 'UTC' } }),
      role({ id: 'work/standup', name: 'Standup', shuttleSchedule: { expr: '0 9 * * *', tz: 'UTC' } }),
    ])
    expect(resp.timeline.futureDated.map((c) => c.id).sort())
      .toEqual(['finances/cc-bills-monthly', 'work/standup'])
    expect(restingCards(resp).map((c) => c.id).sort())
      .toEqual(['finances/cc-bills-monthly', 'work/standup'])
    expect(resp.totals.futureDated).toBe(2)
  })

  it('resolves a far-off role by id, so the drag it accepts is not a no-op', () => {
    // Anything DRAWN must be FINDABLE — `findCardById` is what every drag
    // handler resolves through, and the yearly role is exactly the card the old
    // two-list split rendered in Resting and then failed to resolve.
    const resp = boardOf([role({ shuttleSchedule: { expr: '0 9 1 1 *', tz: 'UTC' } })])
    expect(findCardById(resp, 'finances/cc-bills-monthly')?.id).toBe('finances/cc-bills-monthly')
  })
})

// ─── SEQUENCE GATING ──────────────────────────────────────────────────────
//
// `depends_on:` read as a queue: the head is on the desk, everything behind it
// rests until the head is tempered. Every rule here is a pure derivation, so
// each test states a feed and reads a surface — there is no gate to set and
// none to clear.

describe('the sequence gate', () => {
  const seqFeed = (...fibers: Fiber[]): CompositeFeed => ({
    host: 'here',
    entries: fibers.map((fiber) => ({
      origin: 'here',
      feltStore: '/store',
      path: `.felt/${fiber.id}.md`,
      fiber,
    })),
    origins: { here: { kind: 'local', stale: false, fiberCount: fibers.length } },
  })
  const step = (id: string, over: Partial<Fiber> = {}): Fiber => ({
    id,
    name: id,
    status: 'open',
    createdAt: at0,
    hasShuttleBlock: true,
    shuttleKind: 'oneshot',
    ...over,
  })
  const board = (...fibers: Fiber[]): KanbanResponse =>
    buildKanbanResponseFromComposite(seqFeed(...fibers), { nowMs: NOW })

  it('rests a card whose dependency is not tempered yet', () => {
    const resp = board(step('a'), step('b', { dependsOn: ['a'] }))
    expect(resp.now.drafts.map((c) => c.id)).toEqual(['a'])
    expect(resp.stash.map((c) => c.id)).toEqual(['b'])
    expect(resp.stash[0].depGated).toBe(true)
    expect(resp.stash[0].dependsOnBlocking).toEqual(['a'])
  })

  it('releases the card the moment the dependency tempers — no stored state', () => {
    const resp = board(
      step('a', { status: 'closed', tempered: true, closedAt: at0 }),
      step('b', { dependsOn: ['a'] }),
    )
    expect(resp.now.drafts.map((c) => c.id)).toEqual(['b'])
    expect(resp.stash).toHaveLength(0)
    expect(resp.now.drafts[0].depGated).toBeFalsy()
  })

  it('a COMPOSTED dependency still gates — only tempering is a verdict that unlocks', () => {
    const resp = board(
      step('a', { status: 'closed', tempered: false, closedAt: at0 }),
      step('b', { dependsOn: ['a'] }),
    )
    expect(resp.stash.map((c) => c.id)).toEqual(['b'])
  })

  it('gates an armed oneshot the same way it gates a draft', () => {
    const resp = board(step('a'), step('b', { status: 'active', dependsOn: ['a'] }))
    expect(resp.now.inFlight).toHaveLength(0)
    expect(resp.stash.map((c) => c.id)).toEqual(['b'])
  })

  it('never rests a card with a LIVE WORKER, whatever its deps say', () => {
    const feed = seqFeed(step('a'), step('b', { status: 'active', dependsOn: ['a'] }))
    feed.entries[1].runtime = { tmuxSession: 'shuttle-b' }
    const resp = buildKanbanResponseFromComposite(feed, { nowMs: NOW })
    expect(resp.now.inFlight.map((c) => c.id)).toEqual(['b'])
    expect(resp.stash).toHaveLength(0)
  })

  it('RESTS an awaiting-review card whose dep has not tempered — the queue hides it from the board', () => {
    const resp = board(step('a'), step('b', { status: 'closed', closedAt: at0, dependsOn: ['a'] }))
    expect(resp.now.awaitingReview).toHaveLength(0)
    expect(resp.stash.map((c) => c.id)).toEqual(['b'])
    expect(resp.stash[0].depGated).toBe(true)
    expect(resp.stash[0].status).toBe('closed')
    expect(resp.stash[0].dependsOnBlocking).toEqual(['a'])
  })

  it('an awaiting-review card returns to Awaiting review the moment its dep tempers', () => {
    const resp = board(
      step('a', { status: 'closed', tempered: true, closedAt: at0 }),
      step('b', { status: 'closed', closedAt: at0, dependsOn: ['a'] }),
    )
    expect(resp.now.awaitingReview.map((c) => c.id)).toEqual(['b'])
    expect(resp.stash).toHaveLength(0)
    expect(resp.now.awaitingReview[0].depGated).toBeFalsy()
  })

  it('never rests a card that already has a VERDICT — tempered and composted are history', () => {
    const resp = board(
      step('a'),
      step('t', { status: 'closed', tempered: true, closedAt: at0, dependsOn: ['a'] }),
      step('c', { status: 'closed', tempered: false, closedAt: at0, dependsOn: ['a'] }),
    )
    expect(resp.stash).toHaveLength(0)
    expect(resp.timeline.past.map((c) => c.id).sort()).toEqual(['c', 't'])
  })

  it('never rests an awaiting-review card with a LIVE WORKER', () => {
    const feed = seqFeed(step('a'), step('b', { status: 'closed', closedAt: at0, dependsOn: ['a'] }))
    feed.entries[1].runtime = { tmuxSession: 'shuttle-b' }
    const resp = buildKanbanResponseFromComposite(feed, { nowMs: NOW })
    expect(resp.stash).toHaveLength(0)
    expect([...resp.now.inFlight, ...resp.now.awaitingReview].map((c) => c.id)).toContain('b')
  })

  it('FAILS OPEN on a dep id nothing resolves to, and says so on the card', () => {
    const resp = board(step('b', { dependsOn: ['typo/nope'] }))
    expect(resp.now.drafts.map((c) => c.id)).toEqual(['b'])
    expect(resp.stash).toHaveLength(0)
    expect(resp.now.drafts[0].dependsOnUnresolved).toEqual(['typo/nope'])
    expect(resp.now.drafts[0].dependsOnSatisfied).toBe(true)
  })

  it('gates on the resolvable dep even when a second one dangles', () => {
    const resp = board(step('a'), step('b', { dependsOn: ['a', 'typo/nope'] }))
    expect(resp.stash.map((c) => c.id)).toEqual(['b'])
    expect(resp.stash[0].dependsOnBlocking).toEqual(['a'])
    expect(resp.stash[0].dependsOnUnresolved).toEqual(['typo/nope'])
  })

  it('fails open on the LONE-CARD path, where there is no feed to resolve against', () => {
    // `cardFromCompositeEntry` resolves against an empty map: every dep is
    // unresolved there, and an unresolved dep must never hide a card.
    const card = cardFromCompositeEntry(
      { origin: 'here', feltStore: '/store', path: '.felt/b.md', fiber: step('b', { dependsOn: ['a'] }) },
      NOW,
    )
    expect(card.dependsOnSatisfied).toBe(true)
    expect(card.depGated).toBeFalsy()
    expect(card.dependsOnUnresolved).toBeUndefined()
  })

  it('composes with horizon:stashed — a card that is both rests exactly once', () => {
    const resp = board(step('a'), step('b', { dependsOn: ['a'], horizon: 'stashed' }))
    expect(resp.stash.map((c) => c.id)).toEqual(['b'])
    expect(resp.stash[0].effectiveHorizon).toBe('stashed')
    expect(resp.stash[0].depGated).toBe(true)
  })

  it('an explicit stash still rests once its dep tempers — the two reasons are independent', () => {
    const resp = board(
      step('a', { status: 'closed', tempered: true, closedAt: at0 }),
      step('b', { dependsOn: ['a'], horizon: 'stashed' }),
    )
    expect(resp.stash.map((c) => c.id)).toEqual(['b'])
    expect(resp.stash[0].depGated).toBeFalsy()
  })

  it('a due: that has arrived does NOT lift the gate — a date cannot temper work', () => {
    const resp = board(step('a'), step('b', { dependsOn: ['a'], due: dayFromNow(-1) }))
    expect(resp.stash.map((c) => c.id)).toEqual(['b'])
  })

  it('keeps a gated card FINDABLE, so its drag out of Resting is not a no-op', () => {
    const resp = board(step('a'), step('b', { dependsOn: ['a'] }))
    expect(findCardById(resp, 'b')?.depGated).toBe(true)
  })

  it('resolves a dep written as a UID, where the poller and the checker resolve one', () => {
    // The UI used to index by path id alone, so `depends_on: <ulid>` read as
    // unresolved — fail-open, so the card sat cheerfully on the desk with a
    // spurious warning while the daemon silently refused to launch it. The two
    // sides must agree about what a dependency IS before they can agree about
    // whether it is met.
    const uid = '01KTCA2D1FGAJNHX5WKQ34BSZF'
    const gated = board(step('a', { uid }), step('b', { dependsOn: [uid] }))
    expect(gated.stash.map((c) => c.id)).toEqual(['b'])
    expect(gated.stash[0].dependsOnUnresolved).toBeUndefined()

    const released = board(
      step('a', { uid, status: 'closed', tempered: true, closedAt: at0 }),
      step('b', { dependsOn: [uid.toLowerCase()] }),
    )
    expect(released.now.drafts.map((c) => c.id)).toEqual(['b'])
  })

  it('a JUDGED card keeps its unsatisfied dep on the record without being held by it', () => {
    // A verdict ends the card's claim on attention, so the gate lets go even
    // though the edge is still unsatisfied — the record of what this work was
    // waiting on when it finished survives, inert.
    const resp = board(
      step('a'),
      step('b', { status: 'closed', tempered: false, closedAt: at0, dependsOn: ['a'] }),
    )
    const card = resp.timeline.past.find((c) => c.id === 'b')!
    expect(card.dependsOnSatisfied).toBe(false)
    expect(card.depGated).toBeFalsy()
    expect(resp.stash).toHaveLength(0)
  })

  it('reads a SCALAR depends_on and remembers the shape the gesture may rewrite', () => {
    expect(mapFeltJsonToFiber({ id: 'b', name: 'b', status: 'open', depends_on: 'a' }))
      .toMatchObject({ dependsOn: ['a'], dependsOnShape: 'scalar' })
    expect(mapFeltJsonToFiber({ id: 'b', name: 'b', status: 'open', depends_on: [{ id: 'a' }] }))
      .toMatchObject({ dependsOn: ['a'], dependsOnShape: 'list' })
    expect(mapFeltJsonToFiber({ id: 'b', name: 'b', status: 'open' })?.dependsOnShape)
      .toBeUndefined()
  })
})

describe('chains, tails and the drop that authors them', () => {
  const edges = (...pairs: [string, string[]][]): Map<string, string[]> =>
    buildDependents(pairs.map(([id, dependsOn]) => ({ id, dependsOn })))
  // A←B←C: B waits on A, C waits on B.
  const chain = edges(['a', []], ['b', ['a']], ['c', ['b']])
  const card = (id: string, over: Partial<StackCandidate> = {}): StackCandidate =>
    ({ id, status: 'open', ...over })

  it('reverses the forward edges, deterministically ordered', () => {
    const fanOut = edges(['a', []], ['z', ['a']], ['b', ['a']])
    expect(fanOut.get('a')).toEqual(['b', 'z'])
  })

  it('counts the WHOLE chain behind a head, in chain order', () => {
    expect(queuedBehind('a', chain)).toEqual(['b', 'c'])
    expect(queuedBehind('b', chain)).toEqual(['c'])
    expect(queuedBehind('c', chain)).toEqual([])
  })

  it('resolves the tail transitively, so a drop APPENDS instead of forking', () => {
    expect(chainTail('a', chain)).toBe('c')
    expect(chainTail('c', chain)).toBe('c')
    expect(chainTail('lonely', chain)).toBe('lonely')
  })

  it('survives a cycle in hand-written frontmatter rather than hanging on it', () => {
    const loop = edges(['a', ['b']], ['b', ['a']])
    expect(queuedBehind('a', loop)).toEqual(['b'])
    expect(chainTail('a', loop)).toBe('b')
  })

  it('stacks a dropped card onto the chain TAIL, not the card under the cursor', () => {
    expect(stackDropVerdict(card('d'), card('a'), chain)).toEqual({ ok: true, tail: 'c' })
  })

  it('refuses a drop that would close a loop', () => {
    expect(stackDropVerdict(card('a'), card('c'), chain).ok).toBe(false)
    expect(stackDropVerdict(card('a'), card('a'), chain).ok).toBe(false)
  })

  it('refuses to rewrite a hand-written depends_on LIST', () => {
    expect(stackDropVerdict(card('d', { dependsOnShape: 'list' }), card('a'), chain).ok).toBe(false)
    expect(stackDropVerdict(card('d', { dependsOnShape: 'scalar' }), card('a'), chain).ok).toBe(true)
  })

  it('refuses the sources a sequence position would be dead frontmatter on', () => {
    // A CLOSED source is not among them: see 'who may be stacked, and behind
    // what' — only a tempered TAIL is refused on lifecycle grounds.
    expect(stackDropVerdict(card('d', { shuttleKind: 'standing' }), card('a'), chain).ok).toBe(false)
    expect(stackDropVerdict(card('d', { shuttleKind: 'pinned' }), card('a'), chain).ok).toBe(false)
    expect(stackDropVerdict(card('d', { isCycle: true }), card('a'), chain).ok).toBe(false)
    expect(stackDropVerdict(card('d'), card('a', { isCycle: true }), chain).ok).toBe(false)
  })

  it('refuses the FAN-IN loop, because the edge is written to the TAIL', () => {
    // X waits on both T and S. Dropping S onto T resolves the tail to X, so
    // the edge would be S → X — and X already waits on S. Nothing about T
    // said so, which is why the cycle test has to run against the tail.
    const fanIn = edges(['t', []], ['s', []], ['x', ['t', 's']])
    expect(chainTail('t', fanIn)).toBe('x')
    expect(stackDropVerdict(card('s'), card('t'), fanIn)).toEqual({
      ok: false,
      reason: 'that would make a loop',
    })
  })

  it('refuses a drop that would rewrite the edge the card already has', () => {
    const v = stackDropVerdict(card('c', { dependsOn: ['b'] }), card('b'), chain)
    expect(v.ok).toBe(false)
    // CODED, so the hover can say it: this is a no-op, not a loop.
    expect(v.ok === false && v.code).toBe('alreadyQueued')
  })

  it('names the ALREADY-QUEUED refusal instead of calling it a loop', () => {
    // The live shape: 'b' waits on 'a', so dropping 'b' onto 'a' resolves the
    // tail to 'b' itself. Mechanically a self-edge; to the human, a card that
    // is already exactly where they are trying to put it.
    const v = stackDropVerdict(card('b', { dependsOn: ['a'] }), card('a'), chain)
    expect(v).toEqual({
      ok: false,
      code: 'alreadyQueued',
      reason: 'it is already queued behind this one',
    })
    // Deeper in the chain, too: 'c' waits on 'b' waits on 'a'.
    const deep = stackDropVerdict(card('c', { dependsOn: ['b'] }), card('a'), chain)
    expect(deep.ok === false && deep.code).toBe('alreadyQueued')
    // And a genuine loop is still a genuine loop (see the fan-in above).
  })
})

/** A minimal card, for tests that care only about ids, status and deps. */
const queueCard = (id: string, over: Partial<KanbanCard> = {}): KanbanCard => ({
  id,
  name: id,
  path: `.felt/${id}.md`,
  originId: 'local',
  status: 'open',
  createdAt: at0,
  dependsOnSatisfied: true,
  effectiveHorizon: 'now',
  drifted: false,
  isCycle: false,
  cycleStart: null,
  ...over,
})

/** A board response holding exactly these cards: open ones on Drafts, closed
 *  ones on the past lane. Enough for the graph builders, which read every list
 *  `boardCards` collects. */
const queueResp = (...cards: KanbanCard[]): KanbanResponse => ({
  feltHost: 'here',
  now: { drafts: cards.filter((c) => c.status === 'open'), inFlight: [], awaitingReview: [] },
  timeline: { past: cards.filter((c) => c.status === 'closed'), futureDated: [] },
  stash: [],
  pinned: [],
  cycles: [],
  totals: { drafts: 0, inFlight: 0, awaitingReview: 0, past: 0, futureDated: 0, stash: 0, pinned: 0 },
  temperedTotal: 0,
  staleness: {},
  generatedAt: NOW,
})

describe('who may be stacked, and behind what', () => {
  // ONE lifecycle refusal, and it is TEMPERED — the only verdict that
  // satisfies a dependency, and so the only state that cannot hold a card
  // behind it. Everything else may be stacked on and stacked behind.
  // Refusing on `closed` was over-restriction, and it did something
  // startling: a draft dragged onto an awaiting-review card fell through to
  // the column and got transitioned to awaiting review itself.
  const edges = (...pairs: [string, string[]][]): Map<string, string[]> =>
    buildDependents(pairs.map(([id, dependsOn]) => ({ id, dependsOn })))
  const c = (id: string, over: Partial<StackCandidate> = {}): StackCandidate =>
    ({ id, status: 'open', ...over })
  const awaiting = (id: string): StackCandidate => c(id, { status: 'closed' })
  const temperedCard = (id: string): StackCandidate =>
    c(id, { status: 'closed', tempered: true })
  const compostedCard = (id: string): StackCandidate =>
    c(id, { status: 'closed', tempered: false })
  const none = new Map<string, string[]>()

  it('stacks a draft behind an AWAITING-REVIEW card', () => {
    expect(stackDropVerdict(c('d'), awaiting('a'), none)).toEqual({ ok: true, tail: 'a' })
  })

  it('refuses a TEMPERED target — the dep would be satisfied the moment it is written', () => {
    expect(stackDropVerdict(c('d'), temperedCard('a'), none).ok).toBe(false)
  })

  it('ALLOWS a composted target — a dep on abandoned work is still unsatisfied', () => {
    expect(stackDropVerdict(c('d'), compostedCard('a'), none)).toEqual({ ok: true, tail: 'a' })
  })

  it('lets an AWAITING-REVIEW card be the source — it queues for when it reopens', () => {
    expect(stackDropVerdict(awaiting('d'), c('a'), none)).toEqual({ ok: true, tail: 'a' })
  })

  it('does not care what the SOURCE lifecycle is — any card may be queued', () => {
    expect(stackDropVerdict(temperedCard('d'), c('a'), none)).toEqual({ ok: true, tail: 'a' })
    expect(stackDropVerdict(compostedCard('d'), c('a'), none)).toEqual({ ok: true, tail: 'a' })
  })

  it('appends BEHIND an awaiting-review tail rather than skipping it', () => {
    // a ← b, and b is awaiting review. Dropping d onto a must land behind b.
    const chain = edges(['a', []], ['b', ['a']])
    const lookup = (id: string): StackCandidate | undefined =>
      id === 'b' ? awaiting('b') : undefined
    expect(stackDropVerdict(c('d'), c('a'), chain, lookup)).toEqual({ ok: true, tail: 'b' })
  })

  it('refuses a TEMPERED tail reached through the chain', () => {
    const chain = edges(['a', []], ['b', ['a']])
    const lookup = (id: string): StackCandidate | undefined =>
      id === 'b' ? temperedCard('b') : undefined
    expect(stackDropVerdict(c('d'), c('a'), chain, lookup).ok).toBe(false)
  })

  it('still refuses a source already queued behind, through an awaiting-review member', () => {
    const chain = edges(['a', []], ['b', ['a']])
    expect(stackDropVerdict(awaiting('b'), c('a'), chain).ok).toBe(false)
  })

  it('keeps a closed-but-unaccepted follower IN the graph — chip and chain alike', () => {
    const resp = queueResp(
      queueCard('a'),
      queueCard('b', { status: 'closed', closedAt: at0, dependsOn: ['a'] }),
    )
    // The live gap this replaced: the chain saw 'b' (so a drop onto 'a'
    // refused) while the chip did not (so 'a' wore nothing). One graph now.
    expect(queuedBehind('a', unsettledDependents(resp))).toEqual(['b'])
    expect(chainTail('a', unsettledDependents(resp))).toBe('b')
  })

  it('drops a TEMPERED member from the chain graph — an accepted card ends the queue', () => {
    const resp = queueResp(
      queueCard('a'),
      queueCard('b', { status: 'closed', tempered: true, closedAt: at0, dependsOn: ['a'] }),
      queueCard('x', { status: 'closed', tempered: false, closedAt: at0, dependsOn: ['a'] }),
    )
    // `b` is gone from the graph; the composted `x` is still a chain member.
    expect(chainTail('a', unsettledDependents(resp))).toBe('x')
  })
})

describe('reordering the queue rewires the chain', () => {
  // The queue is stored as one `depends_on:` per member pointing at whoever
  // comes before it. "Move row 3 to the top" is therefore not a position
  // anyone can write — it is a handful of edges, and only the ones that
  // actually changed should be written.
  it('moves a middle member to the front, rewiring only what moved', () => {
    // head ← a ← b ← c becomes head ← b ← a ← c. Every one of the three has a
    // new predecessor (c's was b, and is now a), so all three are written —
    // "minimal" means "changed", not "few".
    expect(reorderQueueWrites('head', ['a', 'b', 'c'], 1, 0)).toEqual([
      { fiberId: 'b', newDep: 'head' },
      { fiberId: 'a', newDep: 'b' },
      { fiberId: 'c', newDep: 'a' },
    ])
  })

  it('moves the front member to the back', () => {
    // head ← a ← b ← c becomes head ← b ← c ← a. `c` keeps its predecessor
    // `b` and is NOT written — that is the minimality that matters.
    expect(reorderQueueWrites('head', ['a', 'b', 'c'], 0, 2)).toEqual([
      { fiberId: 'b', newDep: 'head' },
      { fiberId: 'a', newDep: 'c' },
    ])
  })

  it('writes NOTHING for a move that changes no predecessor', () => {
    expect(reorderQueueWrites('head', ['a', 'b', 'c'], 1, 1)).toEqual([])
    expect(reorderQueueWrites('head', ['a', 'b', 'c'], -1, 0)).toEqual([])
    expect(reorderQueueWrites('head', ['a', 'b', 'c'], 0, 9)).toEqual([])
  })

  it('has no reorder to make in a queue of one', () => {
    expect(reorderQueueWrites('head', ['a'], 0, 0)).toEqual([])
    expect(reorderQueueWrites('head', [], 0, 0)).toEqual([])
  })

  it('turns the gap the human aimed at into the index the rewiring wants', () => {
    // Dropping row 0 into the gap below row 2 (insertAt 3) lands it at index 2
    // once it has been lifted out; gaps above the row are unaffected.
    expect(queueDropIndex(0, 3)).toBe(2)
    expect(queueDropIndex(2, 0)).toBe(0)
    expect(queueDropIndex(1, 1)).toBe(1)
  })
})

describe('a card the board could see but never hit', () => {
  // The live report: one card in Awaiting review — closed with no verdict,
  // horizon:stashed, a past due, owned by a foreign host (candide) whose
  // origin reads stale, rendering bottommost in its column — never showed the
  // plum hot zone, while every card above it did.
  //
  // This reproduces its exact shape and walks the whole decision. Every
  // field-based gate passes, which is the point of keeping the test: the card
  // was never refused, it was UNREACHABLE — the hot zone was measured on its
  // layout box while the scrolling column showed only its top edge.
  const feed: CompositeFeed = {
    host: 'dapmcw68',
    entries: [
      {
        origin: 'local',
        feltStore: '/store',
        path: '.felt/draft.md',
        fiber: {
          id: 'local/draft', name: 'A local draft', status: 'open',
          createdAt: at0, hasShuttleBlock: true, shuttleKind: 'oneshot',
        },
      },
      {
        origin: 'remote-candide',
        feltStore: '/candide/store',
        path: '.felt/smokescreen.md',
        fiber: {
          id: 'smokescreen/replan', uid: '01KX6YH5ZYRQRN1Y7CZA7VR9DE',
          name: 'Execute the Smokescreen-fork replan', status: 'closed',
          createdAt: at0, closedAt: at0,
          horizon: 'stashed', due: dayFromNow(-2),
          hasShuttleBlock: true, shuttleKind: 'oneshot', shuttleHost: 'candide',
        },
      },
    ],
    origins: {
      local: { kind: 'local', stale: false, fiberCount: 1 },
      'remote-candide': { kind: 'remote', stale: true, fiberCount: 1 },
    },
  }

  it('lands on Awaiting review despite the stashed horizon and the past due', () => {
    const resp = buildKanbanResponseFromComposite(feed, { nowMs: NOW })
    expect(resp.now.awaitingReview.map((c) => c.id)).toEqual(['smokescreen/replan'])
    expect(resp.stash).toEqual([])
  })

  it('is findable, stale origin and foreign host and all', () => {
    const resp = buildKanbanResponseFromComposite(feed, { nowMs: NOW })
    expect(findCardById(resp, 'smokescreen/replan')?.shuttleHost).toBe('candide')
    expect(resp.staleness['remote-candide'].status).toBe('stale')
  })

  it('is a LEGAL stack target — no gate refuses it', () => {
    const resp = buildKanbanResponseFromComposite(feed, { nowMs: NOW })
    const target = findCardById(resp, 'smokescreen/replan')!
    const source = findCardById(resp, 'local/draft')!
    expect(
      stackDropVerdict(source, target, unsettledDependents(resp), (id) =>
        findCardById(resp, id) ?? undefined),
    ).toEqual({ ok: true, tail: 'smokescreen/replan' })
  })
})

describe('the hot zone is measured on what you can SEE', () => {
  const card = { left: 0, top: 100, width: 200, height: 200 }

  it('intersects a box with what its scroller shows', () => {
    // The column shows only the card's top 40px.
    expect(intersectRects(card, { left: 0, top: 0, width: 200, height: 140 }))
      .toEqual({ left: 0, top: 100, width: 200, height: 40 })
  })

  it('returns null for a box scrolled entirely out of view', () => {
    expect(intersectRects(card, { left: 0, top: 0, width: 200, height: 100 })).toBeNull()
    expect(intersectRects(card, { left: 400, top: 100, width: 200, height: 200 })).toBeNull()
  })

  it('keeps a usable zone in the sliver a clipped card still shows', () => {
    // Measured on the full box, the middle band is 160..240 — entirely below
    // the fold at 140, so no reachable point is in the zone. Measured on the
    // visible strip, the zone is the middle of 100..140 and can be hit.
    const visible = intersectRects(card, { left: 0, top: 0, width: 200, height: 140 })!
    expect(inStackHotZone(card, { x: 100, y: 120 })).toBe(false)
    expect(inStackHotZone(visible, { x: 100, y: 120 })).toBe(true)
  })

  it('still refuses a point outside the visible strip', () => {
    const visible = intersectRects(card, { left: 0, top: 0, width: 200, height: 140 })!
    expect(inStackHotZone(visible, { x: 100, y: 200 })).toBe(false)
  })
})

describe('a card claims a drop only when it really is a stack', () => {
  // The invariant this protects: every lifecycle drag that worked before
  // sequences existed still works when released over a card. A card that
  // claimed every drop landing on it would turn "drag to In flight" into
  // "stack behind that one" — a different thing than the one you aimed at.
  //
  // The claim decision is tested as the pure function it was extracted into.
  // The board's own test harness stubs `document` with a fake element whose
  // `addEventListener` is a no-op (there is no jsdom in this suite), so a true
  // event-propagation test is not available here.
  const rect = { left: 0, top: 0, width: 100, height: 100 }
  const ok = { ok: true, tail: 'a' } as const
  const no = { ok: false, reason: 'nope' } as const

  it('marks the inner zone and only the inner zone', () => {
    // 60% of a 100x100 box: the inner square from 20 to 80 on both axes.
    expect(inStackHotZone(rect, { x: 50, y: 50 })).toBe(true)
    expect(inStackHotZone(rect, { x: 25, y: 75 })).toBe(true)
    expect(inStackHotZone(rect, { x: 15, y: 50 })).toBe(false)
    expect(inStackHotZone(rect, { x: 50, y: 95 })).toBe(false)
    expect(inStackHotZone(rect, { x: 0, y: 0 })).toBe(false)
    expect(inStackHotZone({ left: 0, top: 0, width: 0, height: 0 }, { x: 0, y: 0 })).toBe(false)
  })

  it('claims a legal stack released in the hot zone', () => {
    expect(stackClaimsDrop(ok, true)).toBe(true)
  })

  it('lets a legal stack released on the OUTER band fall through to the column', () => {
    expect(stackClaimsDrop(ok, false)).toBe(false)
  })

  it('NEVER claims a refused stack — the column keeps the gesture it always had', () => {
    expect(stackClaimsDrop(no, true)).toBe(false)
    expect(stackClaimsDrop(no, false)).toBe(false)
  })

  it('claims nothing when there is no verdict to make', () => {
    expect(stackClaimsDrop(null, true)).toBe(false)
  })
})

describe('the queue counts every follower a dependency still holds', () => {
  it('drops the TEMPERED follower and keeps the composted one', () => {
    const resp = queueResp(
      queueCard('a'),
      queueCard('b', { status: 'closed', tempered: true, closedAt: at0, dependsOn: ['a'] }),
      queueCard('c', { status: 'closed', tempered: false, closedAt: at0, dependsOn: ['a'] }),
    )
    // 'b' is accepted, so nothing waits on it any more; 'c' is composted, and a
    // dep on composted work is still unsatisfied.
    expect(queuedBehind('a', unsettledDependents(resp))).toEqual(['c'])
  })

  it('counts the waiting and the awaiting-review followers together', () => {
    const resp = queueResp(
      queueCard('a'),
      queueCard('b', { status: 'closed', tempered: true, closedAt: at0, dependsOn: ['a'] }),
      queueCard('d', { dependsOn: ['a'] }),
      queueCard('e', { status: 'closed', closedAt: at0, dependsOn: ['a'] }),
    )
    expect(queuedBehind('a', unsettledDependents(resp))).toEqual(['d', 'e'])
  })

  it('names each member by how it sits; the chip only counts', () => {
    const waiting = queueCard('d')
    const review = queueCard('e', { status: 'closed', closedAt: at0 })
    const composted = queueCard('f', { status: 'closed', tempered: false, closedAt: at0 })
    expect(queueMemberNote(waiting)).toBe(null)
    expect(queueMemberNote(review)).toBe('awaiting review')
    expect(queueMemberNote(composted)).toBe('composted')

    // The chip counts, and only counts — how each member sits is the peek
    // list's job, per row, so the desk stays readable at a glance.
    expect(queuedChipLabel(2)).toBe('+2 queued')
    expect(queuedChipLabel(1)).toBe('+1 queued')
  })
})

describe('a card must be substantially on screen to be aimed at', () => {
  // The accidental-stack report: a card at the fold of a scrolling column shows
  // a 20px sliver, and the hot zone — measured on what you can SEE — turned
  // that sliver into a hair-trigger stack target sitting exactly where people
  // aim when they mean "drop this at the bottom of the column".
  it('offers no zone on a sliver, however tall the card really is', () => {
    expect(stackZoneOffered(186, 20)).toBe(false)
    expect(stackZoneOffered(186, 26)).toBe(false)
    expect(stackZoneOffered(186, 40)).toBe(false)
  })

  it('offers a zone once enough of the card is showing', () => {
    expect(stackZoneOffered(186, 98)).toBe(true)
    expect(stackZoneOffered(186, 186)).toBe(true)
  })

  it('scales with the card, so a SHORT card is not held to a tall one’s bar', () => {
    // Two fifths of a short card is under the pixel floor, so the floor wins.
    expect(stackZoneOffered(60, 30)).toBe(false)
    expect(stackZoneOffered(60, 50)).toBe(true)
    // …and for a tall card the fraction is what bites, not the floor.
    expect(stackZoneOffered(400, 60)).toBe(false)
  })

  it('offers nothing for a card with no visible height at all', () => {
    expect(stackZoneOffered(186, 0)).toBe(false)
    expect(stackZoneOffered(0, 0)).toBe(false)
  })
})

describe('dwell arms a card the zone cannot', () => {
  const ok = { ok: true, tail: 'a' } as const
  const no = { ok: false, reason: 'nope' } as const

  it('arms on dwell even when the pointer is nowhere near the zone', () => {
    // The board shifts ~60px the moment a card is picked up (the drag horizon
    // materializes), so the middle you aimed at is not the middle any more.
    // Resting on the card says what aiming could not.
    expect(stackClaimsDrop(ok, false, true)).toBe(true)
  })

  it('still arms immediately in the zone, without waiting', () => {
    expect(stackClaimsDrop(ok, true, false)).toBe(true)
  })

  it('never arms a refused stack, dwell or no dwell', () => {
    expect(stackClaimsDrop(no, false, true)).toBe(false)
    expect(stackClaimsDrop(no, true, true)).toBe(false)
    expect(stackClaimsDrop(null, false, true)).toBe(false)
  })

  it('does not arm a card merely passed over', () => {
    expect(stackClaimsDrop(ok, false, false)).toBe(false)
  })
})

describe('taking a row out of the queue closes the chain', () => {
  // head ← a ← b ← c. Drag `b`'s row onto the board: b leaves, and c — which
  // was behind b — is handed to a. Without that, c waits forever on a card
  // that no longer waits for anything.
  const queue = ['a', 'b', 'c']

  it('rewires the successor to the departing row’s predecessor', () => {
    expect(unqueueRowWrites('head', queue, 1)).toEqual([{ fiberId: 'c', newDep: 'a' }])
  })

  it('hands the successor to the HEAD when the first row leaves', () => {
    expect(unqueueRowWrites('head', queue, 0)).toEqual([{ fiberId: 'b', newDep: 'head' }])
  })

  it('writes nothing when the LAST row leaves — nobody was behind it', () => {
    expect(unqueueRowWrites('head', queue, 2)).toEqual([])
    expect(unqueueRowWrites('head', ['only'], 0)).toEqual([])
  })

  it('never writes the departing row itself — clearing it is the gesture', () => {
    for (const i of [0, 1, 2]) {
      expect(unqueueRowWrites('head', queue, i).map((w) => w.fiberId)).not.toContain(queue[i])
    }
  })

  it('ignores an index that names no row', () => {
    expect(unqueueRowWrites('head', queue, -1)).toEqual([])
    expect(unqueueRowWrites('head', queue, 3)).toEqual([])
    expect(unqueueRowWrites('head', [], 0)).toEqual([])
  })
})

describe('a row drag and a card drag can never both be in flight', () => {
  // The regression this pins: on the Resting surface the peek list overflowed
  // its cluster item and painted its rows BEHIND the item's own title, so a
  // press aimed at a queued line landed on the item — whose draggable armed the
  // CARD drag. Dragging a purple line then moved the fiber it hangs off, which
  // is the opposite of what the gesture says. The layout is fixed; this is the
  // rule that keeps the mix-up impossible even if the layout drifts again.
  it('arms an ordinary card drag', () => {
    expect(cardDragArms({ rowDragInFlight: false, startedInsidePeekList: false })).toBe(true)
  })

  it('refuses while a peek-list row is already being dragged', () => {
    expect(cardDragArms({ rowDragInFlight: true, startedInsidePeekList: false })).toBe(false)
  })

  it('refuses a gesture that began anywhere inside a peek list', () => {
    // Its rows handle their own drags; the chip and the padding are near-misses
    // on a row, and a near-miss must do nothing rather than move the head.
    expect(cardDragArms({ rowDragInFlight: false, startedInsidePeekList: true })).toBe(false)
    expect(cardDragArms({ rowDragInFlight: true, startedInsidePeekList: true })).toBe(false)
  })
})

describe('a queued row asks only about itself', () => {
  // The regression this pins: taking a row OUT of a queue used to be gated on
  // the queue being REORDERABLE, which is a much narrower permission — it
  // wanted two or more members and every member of the chain scalar-shaped. So
  // a head card with exactly one card queued behind it had no draggable rows at
  // all, and one hand-written `depends_on:` anywhere in a chain froze every
  // other row in it. The rows simply did not move, and said nothing about why.
  const base = {
    shape: 'scalar' as const,
    queueLength: 3,
    chainAllScalar: true,
    canReorder: true,
    canUnqueue: true,
  }

  it('offers both gestures on an ordinary scalar chain', () => {
    const g = queueRowGesture(base)
    expect(g.draggable).toBe(true)
    expect(g.reorderable).toBe(true)
    expect(g.hint).toMatch(/reorder/i)
  })

  it('still drags the only row in a queue of one', () => {
    // Nothing to reorder against, but "take it out" is untouched by that.
    const g = queueRowGesture({ ...base, queueLength: 1 })
    expect(g.draggable).toBe(true)
    expect(g.reorderable).toBe(false)
    expect(g.hint).toMatch(/out of the queue/i)
  })

  it('still drags a scalar row in a chain someone hand-wrote elsewhere', () => {
    // The chain cannot be REORDERED — that would rewrite the hand-written
    // member — but this row's own edge is ours to clear.
    const g = queueRowGesture({ ...base, chainAllScalar: false })
    expect(g.draggable).toBe(true)
    expect(g.reorderable).toBe(false)
  })

  it('refuses only the row whose OWN depends_on is a list, and says why', () => {
    const g = queueRowGesture({ ...base, shape: 'list' })
    expect(g.draggable).toBe(false)
    expect(g.reorderable).toBe(false)
    // A silent refusal reads as a broken board; the row has to say it.
    expect(g.hint).toMatch(/hand-written depends_on/i)
  })

  it('drags a row whose shape is not yet known', () => {
    // Unqueueing only ever UNSETS the row's own key, so an absent shape is no
    // reason to withhold the gesture.
    expect(queueRowGesture({ ...base, shape: undefined }).draggable).toBe(true)
  })

  it('takes no view on the head card, its column, or whose daemon owns it', () => {
    // The signature is the proof: there is no parameter to pass any of it in.
    // A remote-owned row drags like any other — `/felt-edit` forwards the write
    // to the owning daemon — and an owner that is genuinely dead fails that
    // forward and is reported then, by name.
    expect(Object.keys(base).sort()).toEqual([
      'canReorder',
      'canUnqueue',
      'chainAllScalar',
      'queueLength',
      'shape',
    ])
  })

  it('goes inert, with a reason, when no sequence handler is wired', () => {
    const g = queueRowGesture({ ...base, canReorder: false, canUnqueue: false })
    expect(g.draggable).toBe(false)
    expect(g.hint).toMatch(/read-only/i)
  })

  it('still drags when only the unqueue handler is wired', () => {
    const g = queueRowGesture({ ...base, canReorder: false })
    expect(g.draggable).toBe(true)
    expect(g.reorderable).toBe(false)
  })
})
