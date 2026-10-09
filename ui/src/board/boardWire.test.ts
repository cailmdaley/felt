// What the board GESTURES put on the wire.
//
// The rules tests (boardRules.test.ts) pin the pure decisions; these pin the
// HTTP those decisions compose into. Two gestures on the board are
// multi-step or conditional, and each one is a composition no single pure
// function holds:
//
//   • Resting drop — the due-preservation policy, whose whole protocol is the
//     PRESENCE OF A KEY in the JSON body: absent leaves the date, `null`
//     clears it.
//   • The fiber controls' due editor — one `/felt-edit` carrying a bare civil
//     day, never an instant.
//
// So the assertion here is always the REQUEST: url, method, and the parsed
// body, in call order. Nothing reaches into the classes' state; a test that
// re-derived the payload from its own copy of the rule would pin nothing.
//
// `npm test` pins TZ=America/Los_Angeles, and the due fixtures are built so a
// negative-offset zone FAILS if anyone reintroduces a `new Date(due)` round
// trip on the write side. See civilDay.ts, whose properties carry the same
// law across every zone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import { Dock } from './workspace/Dock.js'
import { dueCivilDay, isoDayLocal } from './civilDay.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { card as baseCard, response } from './testFixtures.js'

// ── The harness ──────────────────────────────────────────────────────────────

const BASE = 'http://daemon.test:4000'
const DAY = 86_400_000

interface WireCall {
  url: string
  method: string
  body: Record<string, unknown> | undefined
}

interface Wire {
  /** Every call, in the order it was made. */
  calls: WireCall[]
  /** The write plane only — the GET poll that trails every gesture is chrome. */
  writes: () => WireCall[]
  /** Bodies posted to one endpoint, in order. */
  bodiesTo: (path: string) => Array<Record<string, unknown>>
  /** Fail the next response for a path (the error branches stay honest). */
  fail: (path: string, status?: number, text?: string) => void
  /** Fail the nth matching request (one-based), after earlier requests succeed. */
  failOnNth: (path: string, nth: number, status?: number, text?: string) => void
  /** Resolve once the gesture's trailing refetch has landed. */
  settled: () => Promise<void>
}

/**
 * Replace global `fetch` with a recorder.
 *
 * Every gesture under test ends in `fetchAndRender()` — a GET of the composite
 * feed — so that GET is also the quiescence signal `settled()` waits for. The
 * default response is a 200 with `{}`, which `parseCompositeFeed` accepts as an
 * empty feed, so the trailing refetch renders nothing and asks for nothing more.
 */
function installWire(): Wire {
  const calls: WireCall[] = []
  const failures = new Map<string, { remaining: number; status: number; text: string }>()

  const respond = (url: string): Response => {
    for (const [path, f] of failures) {
      if (url.includes(path)) {
        if (f.remaining > 0) {
          f.remaining -= 1
          continue
        }
        failures.delete(path)
        return {
          ok: false,
          status: f.status,
          json: async () => ({ error: f.text }),
          text: async () => f.text,
        } as unknown as Response
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    } as unknown as Response
  }

  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const raw = init?.body
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
    })
    return respond(url)
  })
  globalThis.fetch = mock as unknown as typeof fetch

  return {
    calls,
    writes: () => calls.filter((c) => c.method !== 'GET'),
    bodiesTo: (path) =>
      calls.filter((c) => c.url.includes(path) && c.body !== undefined).map((c) => c.body!),
    fail: (path, status = 500, text = 'boom') => failures.set(path, { remaining: 0, status, text }),
    failOnNth: (path, nth, status = 500, text = 'boom') => {
      if (!Number.isInteger(nth) || nth < 1) throw new Error('nth must be a positive integer')
      failures.set(path, { remaining: nth - 1, status, text })
    },
    settled: async () => {
      await vi.waitFor(() => {
        const last = calls.at(-1)
        expect(last?.url).toContain('/api/v1/fibers/composite')
      })
    },
  }
}

/**
 * The classes reach for `window` for timers (`announce`, `showBanner`, the
 * "Saved" fade). Under vitest's node environment there is no window, so the
 * timer call would throw INSIDE the try block and be mistaken for a failed
 * write. Node's own globals are a faithful stand-in for the two things
 * actually used here, so alias rather than mock. Nothing under test touches
 * `document`: every render path returns early while unmounted.
 */
function installWindowStub(): () => void {
  const had = 'window' in globalThis
  if (!had) {
    ;(globalThis as unknown as { window: unknown }).window = globalThis
  }
  return () => {
    if (!had) delete (globalThis as unknown as { window?: unknown }).window
  }
}

/** A minimally-real card. Every gesture reads `id`/`originId`/`status`. */
function card(over: Partial<KanbanCard> = {}): KanbanCard {
  return baseCard({
    id: 'fiber-1',
    name: 'A card',
    path: '/store/fiber-1.md',
    createdAt: '2026-08-01T09:00:00Z',
    // Nothing under test reads this — the write side asks `storedHorizon` —
    // but it is a required field, so keep the two consistent rather than
    // minting a card that could not come off the classifier.
    effectiveHorizon: over.storedHorizon ?? 'now',
    ...over,
  })
}

/**
 * A KanbanModal with no DOM. `mount()` is never called, so `container`, `body`
 * and `deskEl` stay null and every render/banner/announce path returns early —
 * the network halves run in full. `shuttleBase` is passed so the constructor
 * never reaches `window.location`.
 */
function makeBoard(): KanbanModal {
  return new KanbanModal({ shuttleBase: BASE })
}

/** Reach a private network half. The gesture composition IS the unit under
 *  test, and it has no public name; nothing is re-implemented here. */
type Private = {
  lastResponse: KanbanResponse | null
  applyResponse: (r: KanbanResponse) => void
  announce: (message: string) => void
  stackQueueRow: (
    fiberId: string,
    plan: { writes: Array<{ fiberId: string; newDep: string }>; protectedIds: string[] },
  ) => Promise<void>
  showBanner: (message: string, kind: 'error' | 'info') => void
  transition: (c: KanbanCard, target: 'tempered' | 'composted') => void
  setSurface: (c: KanbanCard, h: 'now' | 'stashed', o?: { cold?: boolean; due?: string | null }) => void
  livePatch: (
    c: KanbanCard,
    changes: Record<string, unknown>,
    statusEl: HTMLElement,
    errorEl: HTMLElement,
  ) => Promise<boolean>
}
const asPrivate = <T>(o: T): Private => o as unknown as Private

/** Duck-typed stand-ins for the status/error elements `livePatch` paints. */
function fakeEl(): HTMLElement {
  return {
    textContent: '',
    style: { display: '' },
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
  } as unknown as HTMLElement
}

let wire: Wire
let restoreWindow: () => void
const realFetch = globalThis.fetch

beforeEach(() => {
  restoreWindow = installWindowStub()
  wire = installWire()
})

afterEach(() => {
  globalThis.fetch = realFetch
  restoreWindow()
})

// Dues relative to the real clock, in the runner's zone — never a literal
// date, which would name a different civil day either side of the Atlantic.
const dayFromNow = (n: number): string => isoDayLocal(Date.now() + n * DAY)
/** How felt serializes a civil day it parsed on a UTC machine. */
const asStoredUtc = (day: string): string => `${day}T00:00:00Z`
/** …and on a machine that was in Paris. Same civil day, different encoding. */
const asStoredParis = (day: string): string => `${day}T00:00:00+02:00`

// ── Pin: unqueue, reshape, pause, then stop ─────────────────────────────────────────────────

describe('stackQueueRow — repair the old chain before moving the row', () => {
  it.each([1, 2, 3])('keeps a valid partial graph and does not move the source when write %i fails', async (failedWrite) => {
    const source = card({ id: 'queued-source', dependsOn: ['review-head'], dependsOnShape: 'scalar' })
    const firstChild = card({ id: 'queued-child-a', dependsOn: [source.id], dependsOnShape: 'scalar' })
    const secondChild = card({ id: 'queued-child-b', dependsOn: [source.id], dependsOnShape: 'scalar' })
    const target = card({ id: 'in-flight-target', status: 'active' })
    const board = asPrivate(makeBoard())
    board.lastResponse = response({
      folded: [source, firstChild, secondChild],
      now: { drafts: [], inFlight: [target], awaitingReview: [] },
    })
    const banner = vi.spyOn(board, 'showBanner')
    wire.failOnNth('/api/v1/felt-edit', failedWrite, 500, `write ${failedWrite} refused`)

    const planWrites = [
      { fiberId: firstChild.id, newDep: 'review-head' },
      { fiberId: secondChild.id, newDep: 'review-head' },
      { fiberId: source.id, newDep: target.id },
    ]
    await board.stackQueueRow(source.id, {
      writes: planWrites,
      protectedIds: [],
    })
    await wire.settled()

    expect(wire.bodiesTo('/api/v1/felt-edit')).toEqual(planWrites.slice(0, failedWrite).map((write) => {
      const origin = write.fiberId === firstChild.id ? firstChild.originId
        : write.fiberId === secondChild.id ? secondChild.originId : source.originId
      return { fiber_id: write.fiberId, origin, set: { depends_on: write.newDep } }
    }))
    const resultingParent = new Map([
      [source.id, 'review-head'],
      [firstChild.id, source.id],
      [secondChild.id, source.id],
    ])
    for (const write of planWrites.slice(0, failedWrite - 1)) resultingParent.set(write.fiberId, write.newDep)
    expect(resultingParent.get(source.id)).toBe('review-head')
    for (const id of [source.id, firstChild.id, secondChild.id]) {
      const seen = new Set<string>()
      let cursor: string | undefined = id
      while (cursor && resultingParent.has(cursor)) {
        expect(seen.has(cursor), `partial graph remains acyclic from ${id}`).toBe(false)
        seen.add(cursor)
        cursor = resultingParent.get(cursor)
      }
    }
    expect(resultingParent.size).toBe(3)
    expect(banner).toHaveBeenCalledWith(expect.stringContaining(`write ${failedWrite} refused`), 'error')
    expect(wire.bodiesTo('/api/v1/lifecycle')).toEqual([])
  })

  it.each(['missing-child', 'list-source'] as const)('preflights %s before any write', async (caseName) => {
    const source = card({
      id: 'queued-source',
      dependsOn: caseName === 'list-source' ? ['review-head', 'hand-edge'] : ['review-head'],
      dependsOnShape: caseName === 'list-source' ? 'list' : 'scalar',
    })
    const target = card({ id: 'in-flight-target', status: 'active' })
    const child = caseName === 'missing-child'
      ? null
      : card({ id: 'queued-child', dependsOn: [source.id], dependsOnShape: 'scalar' })
    const board = asPrivate(makeBoard())
    board.lastResponse = response({
      folded: [source, ...(child ? [child] : [])],
      now: { drafts: [], inFlight: [target], awaitingReview: [] },
    })
    const banner = vi.spyOn(board, 'showBanner')
    const writes = caseName === 'missing-child'
      ? [{ fiberId: 'missing-child', newDep: 'review-head' }, { fiberId: source.id, newDep: target.id }]
      : [{ fiberId: source.id, newDep: target.id }]

    await board.stackQueueRow(source.id, { writes, protectedIds: [] })
    if (caseName === 'missing-child') await wire.settled()

    expect(wire.writes()).toEqual([])
    expect(banner).toHaveBeenCalledWith(
      expect.stringMatching(caseName === 'missing-child' ? /no longer on the board/ : /hand-written depends_on list/),
      caseName === 'missing-child' ? 'error' : 'info',
    )
  })
})

// ── The Resting drop: a due survives, unless it would bounce ─────────────────

describe('setSurface → commitSurface — the due key is the whole protocol', () => {
  it('OMITS `due` entirely when the card is dated in the future', async () => {
    // Absence of the key is what tells felt to leave the line alone. A `due:
    // undefined` would serialize away to the same JSON, but only by luck —
    // assert the key is absent from the parsed body, which is what the daemon
    // actually reads.
    const c = card({ due: asStoredUtc(dayFromNow(30)) })
    asPrivate(makeBoard()).setSurface(c, 'stashed', {})
    await wire.settled()

    const [body] = wire.bodiesTo('/api/v1/felt-edit')
    expect(Object.keys(body)).not.toContain('due')
    expect(body).toEqual({ fiber_id: 'fiber-1', origin: 'local', set: { horizon: 'stashed' }, unset: ['cold'] })
  })

  it('preserves a future due stored in a NON-UTC offset too', async () => {
    // Same civil day, written on a machine at +02:00. Read as an instant this
    // is a different day, and a west-coast runner could classify it as past.
    const c = card({ due: asStoredParis(dayFromNow(30)) })
    asPrivate(makeBoard()).setSurface(c, 'stashed', {})
    await wire.settled()

    expect(Object.keys(wire.bodiesTo('/api/v1/felt-edit')[0])).not.toContain('due')
  })

  it('CLEARS a due that is already past — it would bounce the card back', async () => {
    const c = card({ due: asStoredUtc(dayFromNow(-5)) })
    asPrivate(makeBoard()).setSurface(c, 'stashed', {})
    await wire.settled()

    expect(wire.bodiesTo('/api/v1/felt-edit')[0]).toMatchObject({ due: null })
  })

  it('CLEARS a due dated TODAY — today already reads as drifted', async () => {
    // The boundary case, and the one a `new Date(due)` round trip gets wrong
    // in a negative-offset zone: it would read today's UTC-midnight due as
    // YESTERDAY, which is still cleared, or read tomorrow's as today. Pinning
    // today keeps the edge honest in both hemispheres.
    const c = card({ due: asStoredUtc(dayFromNow(0)) })
    asPrivate(makeBoard()).setSurface(c, 'stashed', {})
    await wire.settled()

    expect(wire.bodiesTo('/api/v1/felt-edit')[0]).toMatchObject({ due: null })
  })

  it('sends an explicit day verbatim — the day-cell drop wins over both rules', async () => {
    const target = dayFromNow(9)
    const c = card({ due: asStoredUtc(dayFromNow(-5)) }) // a stale due it overrides
    asPrivate(makeBoard()).setSurface(c, 'stashed', { due: target })
    await wire.settled()

    // Bare `YYYY-MM-DD`, byte for byte — not an ISO instant, not re-parsed.
    expect(wire.bodiesTo('/api/v1/felt-edit')[0]).toEqual({
      fiber_id: 'fiber-1',
      origin: 'local',
      set: { horizon: 'stashed' },
      unset: ['cold'],
      due: target,
    })
  })

  it('sends an explicit null when the caller means "clear it"', async () => {
    const c = card({ due: asStoredUtc(dayFromNow(30)) })
    asPrivate(makeBoard()).setSurface(c, 'stashed', { due: null })
    await wire.settled()

    expect(wire.bodiesTo('/api/v1/felt-edit')[0]).toMatchObject({ due: null })
  })

  it('writes NOTHING when the drop names the day the card already wears', async () => {
    // The card carries felt's serialization; the day column supplies the bare
    // civil day. As a string compare those differ, and the board used to run a
    // real write (and flicker) for a no-op.
    const day = dayFromNow(4)
    const c = card({ due: asStoredUtc(day), storedHorizon: 'stashed' })
    asPrivate(makeBoard()).setSurface(c, 'stashed', { due: day })

    await new Promise((r) => setTimeout(r, 20))
    expect(wire.calls).toEqual([])
  })

  it('rests a non-open card BEFORE the horizon edit — the clean-exit marker rides rest', async () => {
    const c = card({ id: 'active-1', status: 'active', due: asStoredUtc(dayFromNow(30)) })
    asPrivate(makeBoard()).setSurface(c, 'stashed', {})
    await wire.settled()

    expect(wire.writes().map((w) => w.url)).toEqual([
      `${BASE}/api/v1/lifecycle`,
      `${BASE}/api/v1/felt-edit`,
    ])
    expect(wire.bodiesTo('/api/v1/lifecycle')[0]).toEqual({
      action: 'rest',
      fiber: 'active-1',
      origin: 'local',
    })
    // The rest is a lifecycle move, not a date edit — the due still survives.
    expect(Object.keys(wire.bodiesTo('/api/v1/felt-edit')[0])).not.toContain('due')
  })

  it('parks an active card whose stale horizon says stashed', async () => {
    // Lifecycle placement wins over the planning field: an active oneshot is
    // In flight even when a previous stash left `horizon: stashed` behind.
    // The drop must therefore stop and park it, rather than claiming it is
    // already in Resting.
    const c = card({
      id: 'active-stashed-1',
      status: 'active',
      shuttleKind: 'oneshot',
      workerState: 'running', tmuxSession: 'tmux-active-stashed',
      storedHorizon: 'stashed',
      effectiveHorizon: 'stashed',
    })
    asPrivate(makeBoard()).setSurface(c, 'stashed', {})
    await wire.settled()

    // rest stops the worker in the owning Poller; the board sends no /kill.
    expect(wire.writes().map((w) => w.url)).toEqual([
      `${BASE}/api/v1/lifecycle`,
      `${BASE}/api/v1/felt-edit`,
    ])
    expect(wire.bodiesTo('/api/v1/lifecycle')[0]).toEqual({
      action: 'rest',
      fiber: 'active-stashed-1',
      origin: 'local',
    })
  })

  it('parks an open card whose stale horizon says stashed while its worker is live', async () => {
    // MTG's exact shape: an open card can still have a live worker after a
    // force dispatch, while its old horizon remains stashed. The worker wins
    // the classifier, so dropping it into Resting must stop it rather than
    // claim the card is already there.
    const c = card({
      id: 'open-stashed-live-1',
      status: 'open',
      shuttleKind: 'oneshot',
      workerState: 'running', tmuxSession: 'tmux-open-stashed-live',
      storedHorizon: 'stashed',
      effectiveHorizon: 'stashed',
    })
    asPrivate(makeBoard()).setSurface(c, 'stashed', {})
    await new Promise((r) => setTimeout(r, 20))

    expect(wire.writes().map((w) => w.url)).toEqual([
      `${BASE}/api/v1/lifecycle`,
      `${BASE}/api/v1/felt-edit`,
    ])
    expect(wire.bodiesTo('/api/v1/lifecycle')[0]).toEqual({
      action: 'rest',
      fiber: 'open-stashed-live-1',
      origin: 'local',
    })
  })

  it('rests a blocked app launch — the owner stops it through its backend', async () => {
    const c = card({
      id: 'app-blocked-1',
      status: 'open',
      shuttleKind: 'oneshot',
      shuttleSurface: 'app',
      sessionUuid: '01a0be38-6c36-7cd1-aec9-53a680d1f693',
      runtimePhase: 'blocked',
      launchError: 'turn/start could not be confirmed',
      storedHorizon: 'stashed',
      effectiveHorizon: 'stashed',
    })
    asPrivate(makeBoard()).setSurface(c, 'stashed', {})
    await wire.settled()

    expect(wire.writes().map((w) => w.url)).toEqual([
      `${BASE}/api/v1/lifecycle`,
      `${BASE}/api/v1/felt-edit`,
    ])
  })

  it('reopens a card that carries a verdict as a draft — rest refuses one past review', async () => {
    const c = card({ id: 'done-1', status: 'closed', tempered: true })
    asPrivate(makeBoard()).setSurface(c, 'stashed', {})
    await wire.settled()

    expect(wire.writes().map((w) => w.url)).toEqual([
      `${BASE}/api/v1/transition`,
      `${BASE}/api/v1/felt-edit`,
    ])
    expect(wire.bodiesTo('/api/v1/lifecycle')).toEqual([])
  })

  it('unsets horizon and cold on the way back to Now, touching no due', async () => {
    const c = card({ storedHorizon: 'stashed', due: asStoredUtc(dayFromNow(30)) })
    asPrivate(makeBoard()).setSurface(c, 'now', {})
    await wire.settled()

    expect(wire.bodiesTo('/api/v1/felt-edit')[0]).toEqual({
      fiber_id: 'fiber-1',
      origin: 'local',
      unset: ['horizon', 'cold'],
    })
  })
})

describe('verdicts stop app workers before changing the card lifecycle', () => {
  it('confirms then stops an app worker before tempering', async () => {
    const c = card({
      id: 'app-verdict-1',
      status: 'active',
      shuttleKind: 'oneshot',
      shuttleSurface: 'app',
      sessionUuid: '01a0be38-6c36-7cd1-aec9-53a680d1f693',
      shuttleHost: 'app-host',
    })
    const board = asPrivate(makeBoard())
    board.lastResponse = response({ now: { drafts: [], inFlight: [c], awaitingReview: [] } })
    ;(window as unknown as { confirm: (message: string) => boolean }).confirm = vi.fn(() => true)

    board.transition(c, 'tempered')
    await wire.settled()

    expect(wire.writes().map((w) => [w.url, w.body])).toEqual([
      [`${BASE}/api/v1/kill`, { fiber_id: 'app-verdict-1', origin: 'app-host' }],
      [`${BASE}/api/v1/transition`, { fiber_id: 'app-verdict-1', target: 'tempered', origin: 'local' }],
    ])
  })
})

// ── The fiber controls' due editor ────────────────────────────────────────────────

describe('Dock.livePatch — the due branch', () => {
  const makePanel = (): Dock => new Dock(BASE, () => {})

  it('posts a bare civil day to /felt-edit', async () => {
    const day = dayFromNow(21)
    const ok = await asPrivate(makePanel()).livePatch(
      card(),
      { due: day },
      fakeEl(),
      fakeEl(),
    )

    expect(ok).toBe(true)
    expect(wire.writes()).toEqual([
      {
        url: `${BASE}/api/v1/felt-edit`,
        method: 'POST',
        body: { fiber_id: 'fiber-1', origin: 'local', due: day },
      },
    ])
    // Belt and braces: an instant would have a `T` in it.
    expect(String(wire.writes()[0].body!.due)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('posts null when the date is cleared', async () => {
    await asPrivate(makePanel()).livePatch(card(), { due: null }, fakeEl(), fakeEl())

    expect(wire.writes()[0].body).toEqual({ fiber_id: 'fiber-1', origin: 'local', due: null })
  })

  it('round-trips a stored due back out as the SAME civil day', async () => {
    // The editor seeds its `<input type=date>` with `dueCivilDay(card.due)` and
    // commits whatever the input holds; re-saving an untouched field must
    // therefore hand the wire back exactly the day felt stored. Anywhere a
    // `new Date(due)` crept into that path, this loses a day west of
    // Greenwich — which is why `npm test` pins America/Los_Angeles.
    const stored = '2026-08-20T00:00:00Z'
    const c = card({ due: stored })
    const seeded = dueCivilDay(c.due) // what the date input holds on open

    await asPrivate(makePanel()).livePatch(c, { due: seeded }, fakeEl(), fakeEl())

    expect(wire.writes()[0].body!.due).toBe('2026-08-20')
  })

  it('makes no request at all when `due` is not among the changes', async () => {
    await asPrivate(makePanel()).livePatch(card(), {}, fakeEl(), fakeEl())
    expect(wire.calls).toEqual([])
  })

  it('reports failure without swallowing it', async () => {
    wire.fail('/api/v1/felt-edit', 422, 'no such fiber')
    const ok = await asPrivate(makePanel()).livePatch(card(), { due: null }, fakeEl(), fakeEl())
    expect(ok).toBe(false)
  })
})

// ── The fiber controls' kind control ──────────────────────────────────────────────
//
// The fiber page's Kind control is two-way — One-shot | Standing — and every one
// of its writes is SHAPE-ONLY: it edits a field and says nothing about now, so it
// never kills or pauses a worker.
//
// These pin the wire. The selected-segment rendering is not covered here — the
// suite has no DOM (see bodyLinks.test.ts on why the shims were removed).

describe('Dock.livePatch — the kind branch', () => {
  const makePanel = (): Dock => new Dock(BASE, () => {})
  const standing = (over: Partial<KanbanCard> = {}): KanbanCard =>
    card({
      id: 'role-1', status: 'active', shuttleKind: 'standing', shuttleAgent: 'claude',
      shuttleSchedule: '0 9 * * 1-5', shuttleTz: 'UTC', ...over,
    })

  it('One-shot on a standing card posts reshape kind=oneshot, schedule dropped', async () => {
    const ok = await asPrivate(makePanel()).livePatch(
      standing(),
      { shuttleKind: 'oneshot' },
      fakeEl(),
      fakeEl(),
    )

    expect(ok).toBe(true)
    expect(wire.writes()).toEqual([
      {
        url: `${BASE}/api/v1/lifecycle`,
        method: 'POST',
        body: { action: 'reshape', origin: 'local', fiber: 'role-1', kind: 'oneshot' },
      },
    ])
  })

  it('reshapes a RUNNING card without killing it — the panel edits a field', async () => {
    await asPrivate(makePanel()).livePatch(
      standing({ workerState: 'running', tmuxSession: 'tmux-42' }),
      { shuttleKind: 'oneshot' },
      fakeEl(),
      fakeEl(),
    )

    expect(wire.writes().map((w) => w.url)).toEqual([`${BASE}/api/v1/lifecycle`])
    expect(wire.bodiesTo('/api/v1/lifecycle').map((b) => b.action)).toEqual(['reshape'])
  })

  it('a tz-only patch PRESERVES standing — the fallback reads the card, not "oneshot"', async () => {
    await asPrivate(makePanel()).livePatch(
      standing(),
      { shuttleTz: 'Europe/Paris' },
      fakeEl(),
      fakeEl(),
    )

    expect(wire.bodiesTo('/api/v1/lifecycle')).toEqual([
      { action: 'reshape', origin: 'local', fiber: 'role-1', kind: 'standing', schedule: '0 9 * * 1-5', tz: 'Europe/Paris' },
    ])
  })

  it('reports a refused reshape without swallowing it', async () => {
    wire.fail('/api/v1/lifecycle', 422, 'no shuttle block')
    const ok = await asPrivate(makePanel()).livePatch(
      standing(),
      { shuttleKind: 'oneshot' },
      fakeEl(),
      fakeEl(),
    )
    expect(ok).toBe(false)
  })
})
