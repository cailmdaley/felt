// Rules the desk depends on, in civil days that hold in any zone.
//
// The snooze rules turn on CIVIL DAYS, and the classic failure is a
// negative-offset zone reading UTC midnight as the previous evening — which is
// why `npm test` pins TZ=America/Los_Angeles. Every due here is built FROM the
// reference instant with `isoDayLocal`, never written as a literal date: a
// hardcoded `2026-08-12` would name a different day either side of the
// Atlantic, so the file holds in whatever zone it runs.

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  cycleSpan,
  effectiveHorizon,
  isCycleFiber,
} from './KanbanRules.js'
import type { Fiber } from './KanbanFiber.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { boardFrom, type FeedOf, type FeedRow } from './testFixtures.js'
import { isSleepingOnSchedule } from './KanbanReadModel.js'
import { sessionWindow, stripFacts } from './workspace/Dock.js'
import { civilDayAt, isoDayLocal, shiftCivilDay } from '../sdk/civilDay.js'

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

  it('leaves a plain future-dated card on the desk — a due alone never exiles', () => {
    // The control for the case above: without a stored horizon the same due is
    // just a date the card wears. Only an explicit snooze takes it off the
    // desk. (Resolved to any other surface, such a card would have nowhere to
    // render and would vanish from the Desk.)
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

describe('a mirrored fiber renders as ONE card', () => {
  // Shape taken from the real board: 245 rows for 240 fibers, five of them
  // served by both the laptop and `kelvin` out of the same git-synced store.
  const mirrored = (origin: string, over: Partial<Fiber> = {}): FeedRow => ({
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
    entries: FeedRow[],
    origins: Record<string, { kind: 'local' | 'remote'; stale: boolean }>,
  ): FeedOf => ({
    host: 'laptop',
    entries,
    origins: Object.fromEntries(
      Object.entries(origins).map(([k, v]) => [k, { ...v, fiberCount: 1 }]),
    ),
  })

  const drafts = (feed: FeedOf): KanbanCard[] =>
    boardFrom(feed, { nowMs: NOW }).now.drafts

  it('lands a future-dated draft in Drafts, not off the board', () => {
    // The Desk regression: a fresh draft with `due: <future>` routed to a
    // planning surface with no permanent home and showed up nowhere.
    const feed = feedWith(
      [mirrored('laptop', { due: dayFromNow(21) })],
      { laptop: { kind: 'local', stale: false } },
    )
    const resp = boardFrom(feed, { nowMs: NOW })
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
    const resp = boardFrom(feed, { nowMs: NOW })
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

  it('keeps host-local paths distinct when rows have no uid proving a mirror', () => {
    const feed = feedWith(
      [mirrored('kelvin', { uid: undefined }), mirrored('laptop', { uid: undefined })],
      { laptop: { kind: 'local', stale: false }, kelvin: { kind: 'remote', stale: false } },
    )
    expect(drafts(feed).map((c) => c.originId)).toEqual(['kelvin', 'laptop'])
  })

  describe('an OWNED fiber answers only through its owner', () => {
    // The defect: a fiber owned by `kelvin` but mirrored into the laptop's
    // git-synced store. The mirror won the card on local-first precedence, and
    // a mirror can neither observe the tmux worker (the card landed In flight
    // with no `▸ aloft` pill — no way to join a session running fine) nor be
    // written to (`originId` addressed the mirror, so transitions went there).
    // The daemon stopped serving these rows in 5669fc7; this is the board-side
    // half of the same rule, and what protects it during a mixed-version fleet.
    const inFlight = (feed: FeedOf): KanbanCard[] =>
      boardFrom(feed, { nowMs: NOW }).now.inFlight
    const owned = (origin: string, over: Partial<FeedRow> = {}): FeedRow => ({
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
            runtime: { state: 'running', tmuxSession: 'final-push-01K-shuttle', phase: 'attention', phaseSince: NOW },
          }),
          owned('laptop'),
        ],
        origins,
      )
      const cards = inFlight(feed)
      expect(cards).toHaveLength(1)
      expect(cards[0].originId).toBe('kelvin')
      expect(cards[0].tmuxSession).toBe('final-push-01K-shuttle')
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
        [owned('laptop', { runtime: { state: 'running', tmuxSession: 'ghost-shuttle', phase: 'working' } })],
        origins,
      )
      const cards = inFlight(feed)
      expect(cards[0].originId).toBe('laptop')
      expect(cards[0].tmuxSession).toBeUndefined()
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
  const row = (over: Partial<Fiber>): FeedRow => ({
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
  const boardOf = (entries: FeedRow[]) =>
    boardFrom(
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
    // Open-ended on purpose: a `start:` and nothing else is a valid cycle span.
    const board = boardOf([row({ id: 'cycles/autumn', tags: ['cycle'], start: dayFromNow(-10) })])
    expect(board.cycles).toHaveLength(1)
    // ...and it lands in `cycles` without ever touching a Desk column.
    expect(everywhere(board)).toEqual([])
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

  describe('the read model keeps cycles off every lifecycle column', () => {
    // The load-bearing claim: no combination of status, verdict, liveness or a
    // stray shuttle block — and so no column its owner serves — can put a
    // cycle on the desk. One "Autumn 2026" in Drafts teaches the human to
    // distrust the column.
    const boardOfOne = (fiber: Fiber, live: boolean) => boardFrom({
      host: 'here',
      entries: [{ origin: 'here', feltStore: '/store', path: `.felt/${fiber.id}.md`, fiber,
        runtime: live ? { state: 'running', tmuxSession: 't' } : undefined }],
      origins: { here: { kind: 'local', stale: false, fiberCount: 1 } },
    }, { nowMs: NOW })

    it('files every lifecycle shape among the cycles, a live worker included', () => {
      fc.assert(fc.property(
        fc.record({
          status: fc.constantFrom('open', 'active', 'closed'),
          tempered: fc.constantFrom(undefined, true, false),
          hasShuttleBlock: fc.boolean(),
          shuttleKind: fc.constantFrom(undefined, 'oneshot', 'standing'),
          due: fc.constantFrom(undefined, -30, 0, 30).map(days => days === undefined ? undefined : asFeltWrites(dayFromNow(days))),
        }, { requiredKeys: ['status'] }),
        fc.boolean(),
        (shape, live) => {
          const resp = boardOfOne(cycle(shape as Partial<Fiber>), live)
          expect(resp.cycles.map(c => c.id)).toEqual(['cycles/autumn'])
          expect(Object.values(resp.totals).every(n => n === 0)).toBe(true)
        },
      ), { numRuns: 200, seed: 0x5eed })
    })

    it('leaves ordinary work exactly where it was', () => {
      const work = { ...cycle({ tags: ['planning'] }), hasShuttleBlock: true, status: 'active' }
      expect(boardOfOne(work, false).now.inFlight.map(c => c.id)).toEqual(['cycles/autumn'])
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

  describe('the assembled response', () => {
    const feedOf = (...fibers: Fiber[]): FeedOf => ({
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
      const resp = boardFrom(
        feedOf(cycle({ start: asFeltWrites('2026-08-01'), due: undefined })),
        { nowMs: NOW },
      )
      expect(resp.cycles.map((c) => c.id)).toEqual(['cycles/autumn'])
    })

    it('puts cycles on their own surface and NOWHERE else', () => {
      const resp = boardFrom(
        feedOf(cycle({ start: asFeltWrites('2026-08-01'), due: asFeltWrites('2026-08-31') }), work()),
        { nowMs: NOW },
      )
      expect(resp.cycles).toHaveLength(1)
      const everywhereElse = [
        ...resp.now.drafts, ...resp.now.inFlight, ...resp.now.awaitingReview,
        ...resp.timeline.past, ...resp.timeline.futureDated,
        ...resp.stash,
      ]
      expect(everywhereElse.some((c) => c.isCycle)).toBe(false)
      expect(everywhereElse.map((c) => c.id)).toEqual(['work/thing'])
    })

    it('never counts a cycle in a column total', () => {
      const withoutCycles = boardFrom(feedOf(work()), { nowMs: NOW })
      const withCycles = boardFrom(
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
      const resp = boardFrom(
        feedOf(cycle({ start: asFeltWrites('2026-09-01'), due: asFeltWrites('2026-09-30') })),
        { nowMs: NOW },
      )
      const card = resp.cycles[0]
      expect(card.isCycle).toBe(true)
      expect(card.cycleStart).toBe('2026-09-01')  // bare civil day, already normalized
      expect(card.due).toBe(asFeltWrites('2026-09-30'))
    })

    it('leaves cycleStart null on a cycle with no start, and on ordinary work', () => {
      const resp = boardFrom(
        feedOf(cycle({ due: asFeltWrites('2026-09-30') }), work({ due: asFeltWrites('2026-09-30') })),
        { nowMs: NOW },
      )
      expect(resp.cycles[0].cycleStart).toBeNull()
      const workCard = [...resp.now.drafts, ...resp.timeline.futureDated].find((c) => c.id === 'work/thing')
      expect(workCard?.isCycle).toBe(false)
      expect(workCard?.cycleStart).toBeNull()
    })

    it('orders the bands earliest first', () => {
      const resp = boardFrom(
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
  const BARE = /^\d{2}:\d{2} → \d{2}:\d{2} · /
  const DATED = /^[A-Za-z]{3}\.? ?\d{1,2} \d{2}:\d{2} → /
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
    expect(w?.text).toMatch(/· 3h 30m$/)
    expect(w?.state).toBe('clean')
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
    // Anchored to 22:00 in the host zone so the +4h handoff lands on the next
    // civil day in whatever zone the suite runs in.
    const startMs = civilDayAt(shiftCivilDay(isoDayLocal(NOW), -3), 22)!
    const w = sessionWindow(
      {
        dispatchedAt: new Date(startMs).toISOString(),
        handedOffAt: new Date(startMs + 4 * 3_600_000).toISOString(),
      },
      NOW,
    )
    expect(isoDayLocal(startMs + 4 * 3_600_000)).not.toBe(isoDayLocal(startMs))
    expect(w?.text).toMatch(/→ [A-Za-z]{3}\.? ?\d{1,2} \d{2}:\d{2} · 4h 0m$/)
  })

  it('says when a live worker launched, as an age with its clock time on hover, and claims no clean exit', () => {
    const w = sessionWindow(
      { dispatchedAt: at(-20 * 60_000), workerState: 'running' },
      NOW,
    )
    expect([w?.text, w?.at]).toStrictEqual(['launched ', NOW - 20 * 60_000])
    expect(w?.title).toMatch(/\d{2}:\d{2}/)
    expect(w?.state).toBe('running')
  })

  it('refuses a handoff stamp older than the dispatch — that is the PREVIOUS run', () => {
    // The real shape seen in the loom: a stale `handed_off_at` left over from an
    // earlier run. Reading it as this run's would print a negative span under a
    // verdigris check.
    const w = sessionWindow(
      { dispatchedAt: at(-2 * 3_600_000), handedOffAt: at(-6 * 3_600_000) },
      NOW,
    )
    expect(w?.text).toMatch(/· no handoff$/)
    expect(w?.state).toBe('unclean')
    expect(w?.text).not.toMatch(/-\d/)
  })
})

describe('stripFacts — the drawer strip as a reading of the card', () => {
  const card = (patch: Partial<KanbanCard>): KanbanCard => ({
    id: 'work/spectra/null-tests', uid: 'U', name: 'Null tests', path: '', fiberDir: '', feltStore: '',
    originId: 'h', status: 'active', column: 'inFlight', turn: 'none', outcome: '', tags: [], createdAt: at0,
    effectiveHorizon: 'now', drifted: false, isCycle: false, cycleStart: null,
    ...patch,
  })

  it('names the agent and its effort, and places the work as host:dir', () => {
    const f = stripFacts(card({
      shuttleKind: 'oneshot', shuttleAgent: 'claude-fable', shuttleEffort: 'medium',
      shuttleHost: 'ada-workstation', shuttleProjectDir: '/home/ada/dev/spectra',
    }), NOW)
    expect(f.actor).toEqual({ text: 'claude-fable', agent: true })
    expect(f.effort).toBe('medium')
    expect(f.place?.text).toBe('ada-workstation:~/dev/spectra')
    expect(f.place?.title).toBe('ada-workstation:/home/ada/dev/spectra')
    // A one-shot is the default shape; saying so would be noise.
    expect(f.cadence).toBeUndefined()
  })

  it("says `me` for a card with no shuttle block, as the board card does", () => {
    const f = stripFacts(card({ due: dayFromNow(3) }), NOW)
    expect(f.actor).toEqual({ text: 'me', agent: false })
    expect(f.effort).toBeUndefined()
    expect(f.due).toBeDefined()
  })

  it('speaks a standing cron and keeps the expression on the hover', () => {
    const f = stripFacts(card({
      shuttleKind: 'standing', shuttleAgent: 'claude-opus',
      shuttleSchedule: '0 9 * * 1-5', shuttleTz: 'Europe/Paris', scheduleText: 'weekdays 9:00', due: dayFromNow(2),
    }), NOW)
    expect(f.cadence).toEqual({ text: 'weekdays 9:00', title: 'cron: 0 9 * * 1-5 (Europe/Paris)' })
    // A standing constitution is placed by its cron — its due is never read.
    expect(f.due).toBeUndefined()
  })

  it('says nothing of a one-shot\'s cadence, and keeps its due', () => {
    const f = stripFacts(card({ shuttleKind: 'oneshot', shuttleAgent: 'claude-opus', due: dayFromNow(2) }), NOW)
    expect(f.cadence).toBeUndefined()
    expect(f.due).toBeDefined()
  })

  it('carries the chrome flag only when it is on', () => {
    expect(stripFacts(card({ shuttleAgent: 'claude-opus', shuttleChrome: true }), NOW).chrome).toBe(true)
    expect(stripFacts(card({ shuttleAgent: 'claude-opus' }), NOW).chrome).toBe(false)
  })
})

describe('Resting holds standing constitutions asleep between runs', () => {
  // An armed standing constitution between firings rests, and the read model
  // files it on the timeline surface, which the Desk does not draw; without the
  // Resting join `ops/monthly-report` — armed, monthly, perfectly healthy —
  // would be on no surface a human could see.
  const role = (over: Partial<Fiber> = {}): FeedRow => ({
    origin: 'laptop',
    feltStore: '/store/laptop',
    path: '.felt/ops/monthly-report.md',
    fiber: {
      id: 'ops/monthly-report',
      name: 'CC bills',
      status: 'active',
      createdAt: at0,
      hasShuttleBlock: true,
      shuttleKind: 'standing',
      shuttleSchedule: { expr: '0 9 12 * *', tz: 'UTC' },
      shuttleNextDue: '2026-08-12T09:00:00Z',
      ...over,
    },
  })
  const boardOf = (entries: FeedRow[]): KanbanResponse =>
    boardFrom(
      { host: 'laptop', entries, origins: { laptop: { kind: 'local', stale: false, fiberCount: entries.length } } },
      { nowMs: NOW },
    )
  const restingCards = (resp: KanbanResponse): KanbanCard[] => [...resp.stash, ...resp.timeline.futureDated]

  it('draws an armed standing constitution in Resting, with a next launch to show', () => {
    const resp = boardOf([role()])
    const resting = restingCards(resp)
    expect(resting.map((c) => c.id)).toEqual(['ops/monthly-report'])
    expect(isSleepingOnSchedule(resting[0])).toBe(true)
    // The day it next runs comes from the cron.
    expect(resting[0].nextLaunchAt).toBeDefined()
    // And it is nowhere on the desk — Resting is its only home.
    expect(resp.now.drafts).toEqual([])
    expect(resp.now.inFlight).toEqual([])
    expect(resp.now.awaitingReview).toEqual([])
  })

  it('keeps snoozed work and sleeping roles in the same region, told apart', () => {
    const snoozed: FeedRow = {
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
    expect(resting.map((c) => c.id).sort()).toEqual(['ops/monthly-report', 'work/later'])
    const bySleep = Object.fromEntries(resting.map((c) => [c.id, isSleepingOnSchedule(c)]))
    expect(bySleep).toEqual({ 'ops/monthly-report': true, 'work/later': false })
  })

  it('sends a RUNNING standing constitution to In flight, not to Resting', () => {
    // Live work is activity worth showing on the desk; its owner serves it In
    // flight, and Resting must not double-claim it.
    const resp = boardFrom(
      {
        host: 'laptop',
        entries: [{ ...role(), runtime: { state: 'running', tmuxSession: 'shuttle-cc', phase: 'running' } }],
        origins: { laptop: { kind: 'local', stale: false, fiberCount: 1 } },
      },
      { nowMs: NOW },
    )
    expect(resp.now.inFlight.map((c) => c.id)).toEqual(['ops/monthly-report'])
    expect(restingCards(resp)).toEqual([])
  })

  it('draws a PAUSED standing constitution in Resting, saying it is paused and its schedule', () => {
    // Pause writes status:open + horizon:stashed and keeps the schedule. An
    // open role is not armed: no next launch, and no `due:` wakes it.
    const resp = boardOf([role({ status: 'open', horizon: 'stashed', due: dayFromNow(-2), shuttleScheduleText: 'monthly on the 12th at 09:00' })])
    expect(resp.now.drafts).toEqual([])
    expect(resp.stash.map((c) => c.id)).toEqual(['ops/monthly-report'])
    const paused = resp.stash[0]
    expect(paused.nextLaunchAt).toBeUndefined()
    expect(isSleepingOnSchedule(paused)).toBe(false)
  })

  it('serves an armed standing constitution whose run asked something In flight, as a question', () => {
    // The run's review is its own ask: the human's turn, like any asking card.
    const resp = boardOf([role({ shuttleAsk: { text: 'Pay the electricity bill now?', at: at0 } })])
    expect(resp.now.inFlight.map((c) => c.id)).toEqual(['ops/monthly-report'])
    expect(resp.now.inFlight[0].turn).toBe('question')
    expect(restingCards(resp)).toEqual([])
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
      .toEqual(['ops/monthly-report', 'work/standup'])
    expect(restingCards(resp).map((c) => c.id).sort())
      .toEqual(['ops/monthly-report', 'work/standup'])
    expect(resp.totals.futureDated).toBe(2)
  })


})
