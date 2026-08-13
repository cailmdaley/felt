// What the board GESTURES put on the wire.
//
// The rules tests (boardRules.test.ts) pin the pure decisions; these pin the
// HTTP those decisions compose into. Three gestures on the board are
// multi-step or conditional, and each one is a composition no single pure
// function holds:
//
//   • Pin  — "be a pinned role" AND "come to rest": `reshape` (which
//     deliberately touches no status) then `pause`, in that order.
//   • Resting drop — the due-preservation policy, whose whole protocol is the
//     PRESENCE OF A KEY in the JSON body: absent leaves the date, `null`
//     clears it.
//   • The detail panel's due editor — one `/felt-edit` carrying a bare civil
//     day, never an instant.
//
// So the assertion here is always the REQUEST: url, method, and the parsed
// body, in call order. Nothing reaches into the classes' state; a test that
// re-derived the payload from its own copy of the rule would pin nothing.
//
// `npm test` runs this file twice — TZ=America/Los_Angeles and TZ=Europe/Paris
// — and the due fixtures are built so the negative-offset pass FAILS if anyone
// reintroduces a `new Date(due)` round trip on the write side. See civilDay.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import { FiberDetailModal } from './FiberDetailModal.js'
import { dueCivilDay, isoDayLocal } from './civilDay.js'
import type { KanbanCard } from './KanbanTypes.js'

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
  const failures = new Map<string, { status: number; text: string }>()

  const respond = (url: string): Response => {
    for (const [path, f] of failures) {
      if (url.includes(path)) {
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
    fail: (path, status = 500, text = 'boom') => failures.set(path, { status, text }),
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
  return {
    id: 'fiber-1',
    name: 'A card',
    path: '/store/fiber-1.md',
    originId: 'local',
    status: 'open',
    dependsOnSatisfied: true,
    createdAt: '2026-08-01T09:00:00Z',
    // Nothing under test reads this — the write side asks `storedHorizon` —
    // but it is a required field, so keep the two consistent rather than
    // minting a card that could not come off the classifier.
    effectiveHorizon: over.storedHorizon ?? 'now',
    drifted: false,
    isCycle: false,
    cycleStart: null,
    ...over,
  }
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
  commitPin: (c: KanbanCard) => Promise<void>
  pinRole: (c: KanbanCard) => void
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

// ── Pin: reshape, then pause ─────────────────────────────────────────────────

describe('commitPin — the strip drop is two intents, said in two calls', () => {
  it('posts reshape then pause for a card that already has a shuttle block', async () => {
    const c = card({ id: 'pinme', shuttleKind: 'oneshot', shuttleAgent: 'claude' })
    await asPrivate(makeBoard()).commitPin(c)
    await wire.settled()

    // The whole contract: these two bodies, this endpoint, this order.
    expect(wire.writes().map((w) => ({ url: w.url, method: w.method, body: w.body }))).toEqual([
      {
        url: `${BASE}/api/v1/lifecycle`,
        method: 'POST',
        body: { action: 'reshape', kind: 'pinned', fiber: 'pinme', origin: 'local' },
      },
      {
        url: `${BASE}/api/v1/lifecycle`,
        method: 'POST',
        body: { action: 'pause', fiber: 'pinme', origin: 'local' },
      },
    ])
  })

  it('sends the pause even for a CLOSED source — the pause is what parks it', async () => {
    // A once-pinned card left awaiting review is re-rested by this same drag;
    // `reshape` writes no status, so without the pause it would stay closed.
    const c = card({ id: 'closed-1', status: 'closed', shuttleKind: 'pinned', tempered: undefined })
    await asPrivate(makeBoard()).commitPin(c)
    await wire.settled()

    expect(wire.bodiesTo('/api/v1/lifecycle').map((b) => b.action)).toEqual(['reshape', 'pause'])
  })

  it('kills a live worker BEFORE the reshape', async () => {
    const c = card({ id: 'running-1', shuttleKind: 'oneshot', runningWorker: 'tmux-42' })
    await asPrivate(makeBoard()).commitPin(c)
    await wire.settled()

    expect(wire.writes().map((w) => [w.url, w.body])).toEqual([
      [`${BASE}/api/v1/kill`, { fiber_id: 'running-1', origin: 'local' }],
      [`${BASE}/api/v1/lifecycle`, { action: 'reshape', kind: 'pinned', fiber: 'running-1', origin: 'local' }],
      [`${BASE}/api/v1/lifecycle`, { action: 'pause', fiber: 'running-1', origin: 'local' }],
    ])
  })

  it('never reaches the wire at all for a block-less card', async () => {
    // The gesture turns such a card away before the network: there is no host
    // or project_dir to install from, so `pinRole` banners "promote it first"
    // and returns. commitPin therefore only ever handles cards that already
    // have a block — which is why it holds no create branch. Pinning the
    // ABSENCE of traffic is what keeps that guard and that assumption honest
    // together: loosen one without the other and this fails.
    const c = card({ id: 'bare-1', shuttleHost: 'candide', shuttleProjectDir: '/home/cd/dev/felt' })
    delete (c as { shuttleKind?: unknown }).shuttleKind
    asPrivate(makeBoard()).pinRole(c)
    await new Promise((r) => setTimeout(r, 20))

    expect(wire.calls).toEqual([])
  })

  it('does not post the pause when the reshape fails', async () => {
    wire.fail('/api/v1/lifecycle', 500, 'reshape refused')
    const c = card({ shuttleKind: 'oneshot' })
    await asPrivate(makeBoard()).commitPin(c)
    await wire.settled()

    expect(wire.bodiesTo('/api/v1/lifecycle').map((b) => b.action)).toEqual(['reshape'])
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

  it('parks a non-open card as a draft BEFORE the horizon edit', async () => {
    const c = card({ id: 'active-1', status: 'active', due: asStoredUtc(dayFromNow(30)) })
    asPrivate(makeBoard()).setSurface(c, 'stashed', {})
    await wire.settled()

    expect(wire.writes().map((w) => w.url)).toEqual([
      `${BASE}/api/v1/transition`,
      `${BASE}/api/v1/felt-edit`,
    ])
    expect(wire.bodiesTo('/api/v1/transition')[0]).toEqual({
      fiber_id: 'active-1',
      target: 'drafts',
      origin: 'local',
    })
    // The park is a lifecycle move, not a date edit — the due still survives.
    expect(Object.keys(wire.bodiesTo('/api/v1/felt-edit')[0])).not.toContain('due')
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

// ── The detail panel's due editor ────────────────────────────────────────────

describe('FiberDetailModal.livePatch — the due branch', () => {
  const makePanel = (): FiberDetailModal => new FiberDetailModal(BASE, () => {})

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
    // Greenwich — so the America/Los_Angeles pass is the one that catches it.
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
