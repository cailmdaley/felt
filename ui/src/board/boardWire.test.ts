// What the board GESTURES put on the wire.
//
// The rules tests (boardRules.test.ts) pin the pure decisions; these pin the
// HTTP those decisions compose into. Two gestures on the board are
// multi-step or conditional, and each one is a composition no single pure
// function holds:
//
//   • Resting drop — one `/lifecycle` rest whose `until` is the day dropped
//     on, or absent so rest keeps a future due and clears an arrived one.
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
  fetchAndRender: () => Promise<void>
  transition: (c: KanbanCard, target: 'tempered' | 'composted' | 'inFlight') => void
  setSurface: (c: KanbanCard, h: 'now' | 'stashed', o?: { due?: string | null }) => void
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

// ── The Resting drop: one rest, carrying a day or nothing ────────────────────

describe('setSurface → commitSurface — a Resting drop is one rest', () => {
  const restOf = (fiber: string, extra: Record<string, unknown> = {}) => [{
    url: `${BASE}/api/v1/lifecycle`, method: 'POST',
    body: { action: 'rest', fiber, origin: 'local', ...extra },
  }]

  it('rests a card dated in the future without naming a day — rest keeps it', async () => {
    const c = card({ due: asStoredUtc(dayFromNow(30)) })
    asPrivate(makeBoard()).setSurface(c, 'stashed', {})
    await wire.settled()
    expect(wire.writes()).toEqual(restOf('fiber-1'))
  })

  it('preserves a future due stored in a NON-UTC offset too', async () => {
    // Same civil day, written on a machine at +02:00. Read as an instant this
    // is a different day, and a west-coast runner could classify it as past.
    const c = card({ due: asStoredParis(dayFromNow(30)) })
    const board = asPrivate(makeBoard())
    const banner = vi.spyOn(board, 'showBanner')
    board.setSurface(c, 'stashed', {})
    await wire.settled()
    expect(wire.writes()).toEqual(restOf('fiber-1'))
    expect(banner).not.toHaveBeenCalled()
  })

  it.each([
    ['already past', -5],
    ['dated TODAY', 0],
  ])('reports the cleared due when it is %s — rest clears it', async (_label, offset) => {
    // Today is the boundary a `new Date(due)` round trip gets wrong in a
    // negative-offset zone.
    const c = card({ due: asStoredUtc(dayFromNow(offset)) })
    const board = asPrivate(makeBoard())
    const banner = vi.spyOn(board, 'showBanner')
    board.setSurface(c, 'stashed', {})
    await wire.settled()
    expect(wire.writes()).toEqual(restOf('fiber-1'))
    expect(banner).toHaveBeenCalledWith(expect.stringMatching(/already past.*cleared/), 'info')
  })

  it('sends an explicit day verbatim as until — the day-cell drop wins over both rules', async () => {
    const target = dayFromNow(9)
    const c = card({ due: asStoredUtc(dayFromNow(-5)) }) // a stale due it overrides
    asPrivate(makeBoard()).setSurface(c, 'stashed', { due: target })
    await wire.settled()
    // Bare `YYYY-MM-DD`, byte for byte — not an ISO instant, not re-parsed.
    expect(wire.writes()).toEqual(restOf('fiber-1', { until: target }))
  })

  it('writes NOTHING when the drop names the day the card already wears', async () => {
    // The card carries felt's serialization; the day column supplies the bare
    // civil day. As strings those differ, so a string compare would run a real
    // write (and flicker) for a no-op.
    const day = dayFromNow(4)
    const c = card({ due: asStoredUtc(day), storedHorizon: 'stashed' })
    asPrivate(makeBoard()).setSurface(c, 'stashed', { due: day })

    await new Promise((r) => setTimeout(r, 20))
    expect(wire.calls).toEqual([])
  })

  it('reopens a closed card as a draft when dropped on a future day', async () => {
    const due = dayFromNow(7)
    asPrivate(makeBoard()).setSurface(card({ status: 'closed' }), 'now', { due })
    await wire.settled()
    expect(wire.bodiesTo('/api/v1/transition')).toEqual([
      { fiber_id: 'fiber-1', origin: 'local', target: 'drafts' },
    ])
    expect(wire.bodiesTo('/api/v1/felt-edit')[0]).toMatchObject({ due })
  })

  it('adds a future day to live work without killing or changing its lifecycle', async () => {
    const due = dayFromNow(7)
    asPrivate(makeBoard()).setSurface(card({
      status: 'active', workerState: 'running', tmuxSession: 'live-worker',
    }), 'now', { due })
    await wire.settled()
    expect(wire.writes()).toEqual([{
      url: `${BASE}/api/v1/felt-edit`, method: 'POST',
      body: { fiber_id: 'fiber-1', origin: 'local', due },
    }])
  })

  it('redates a resting card through rest until', async () => {
    const due = dayFromNow(7)
    asPrivate(makeBoard()).setSurface(card({ status: 'open', storedHorizon: 'stashed' }), 'stashed', { due })
    await wire.settled()
    expect(wire.writes()).toEqual(restOf('fiber-1', { until: due }))
  })

  it('redates a resting card that waits on a blocker without replacing it', async () => {
    const due = dayFromNow(7)
    const c = card({ status: 'open', storedHorizon: 'stashed', shuttleBlockedOn: 'u-blocker' })
    asPrivate(makeBoard()).setSurface(c, 'stashed', { due })
    await wire.settled()
    expect(wire.writes()).toEqual([{
      url: `${BASE}/api/v1/felt-edit`, method: 'POST',
      body: { fiber_id: 'fiber-1', origin: 'local', due },
    }])
  })

  it('banners a refused rest', async () => {
    const board = asPrivate(makeBoard())
    const banner = vi.spyOn(board, 'showBanner')
    wire.fail('/api/v1/lifecycle')
    board.setSurface(card({ status: 'closed' }), 'stashed', { due: dayFromNow(7) })
    await wire.settled()
    expect(banner).toHaveBeenCalledWith(expect.stringMatching(/Couldn't move.*Resting/), 'error')
  })

  it.each([
    ['an active card', { id: 'active-1', status: 'active' as const, due: asStoredUtc(dayFromNow(30)) }],
    // Lifecycle placement wins over the planning field: an active oneshot is
    // In flight even when a previous stash left `horizon: stashed` behind.
    ['an active card whose stale horizon says stashed', {
      id: 'active-1', status: 'active' as const, shuttleKind: 'oneshot' as const,
      workerState: 'running' as const, tmuxSession: 'tmux-active-stashed',
      storedHorizon: 'stashed' as const, effectiveHorizon: 'stashed' as const,
    }],
    // An open card can still have a live worker after a force dispatch while
    // its old horizon remains stashed; the worker wins the classifier.
    ['an open stashed card whose worker is live', {
      id: 'active-1', status: 'open' as const, shuttleKind: 'oneshot' as const,
      workerState: 'running' as const, tmuxSession: 'tmux-open-stashed-live',
      storedHorizon: 'stashed' as const, effectiveHorizon: 'stashed' as const,
    }],
    // Rest clears a verdict itself.
    ['a card that carries a verdict', { id: 'active-1', status: 'closed' as const, tempered: true }],
  ])('rests %s in one write; rest stops its worker in the owning Poller', async (_label, over) => {
    asPrivate(makeBoard()).setSurface(card(over), 'stashed', {})
    await wire.settled()
    expect(wire.writes()).toEqual(restOf('active-1'))
  })

  it('does not stop a blocked launch that has no live worker', async () => {
    const c = card({
      id: 'app-blocked-1',
      status: 'open',
      shuttleKind: 'oneshot',
      runtimePhase: 'blocked',
      launchError: 'turn/start could not be confirmed',
      storedHorizon: 'stashed',
      effectiveHorizon: 'stashed',
    })
    asPrivate(makeBoard()).setSurface(c, 'stashed', {})
    await new Promise((r) => setTimeout(r, 20))
    expect(wire.writes()).toEqual([])
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

describe('optimistic response cache coherence', () => {
  it('holds polls while a stashed surface gesture is still writing', async () => {
    const c = card()
    let finish!: (value: Response) => void
    const reads = vi.fn()
    globalThis.fetch = vi.fn(async input => {
      if (String(input).includes('/lifecycle')) return new Promise<Response>(resolve => { finish = resolve })
      if (String(input).includes('/fibers/composite')) reads()
      return Response.json({})
    }) as typeof fetch
    const board = asPrivate(makeBoard())
    board.applyResponse(response({ now: { drafts: [c], inFlight: [], awaitingReview: [] } }))
    board.setSurface(c, 'stashed')
    await board.fetchAndRender()
    expect(reads).not.toHaveBeenCalled()
    expect(board.lastResponse?.stash.map(card => card.id)).toContain(c.id)
    finish(Response.json({}))
    await vi.waitFor(() => expect(reads).toHaveBeenCalledOnce())
  })

  it.each([1, 2])('reconciles refused launches unconditionally after all %s gestures settle', async count => {
    const cards = Array.from({ length: count }, (_, i) => card({ id: `task-${i}`, shuttleProjectDir: '/work' }))
    const feed = { host: 'local', fibers: cards.map(c => ({
      origin: 'local', felt_store: '/store', path: c.path,
      fiber: { id: c.id, name: c.name, status: 'open', shuttle: { kind: 'oneshot', project_dir: '/work' } },
    })) }
    const replies: Array<(res: Response) => void> = []
    const reads: Headers[] = []
    globalThis.fetch = vi.fn(async (input, init) => {
      if (String(input).includes('/fibers/composite')) {
        const headers = new Headers(init?.headers)
        reads.push(headers)
        return headers.get('If-None-Match') === '"same"'
          ? new Response(null, { status: 304 })
          : Response.json(feed, { headers: { ETag: '"same"' } })
      }
      if (String(input).includes('/dispatch')) return new Promise<Response>(resolve => replies.push(resolve))
      return Response.json({})
    }) as typeof fetch
    const board = asPrivate(makeBoard())
    const failed = new Promise<void>(resolve => {
      vi.spyOn(board, 'showBanner').mockImplementation(() => resolve())
    })
    await board.fetchAndRender()
    for (const c of cards) board.transition(c, 'inFlight')
    await vi.waitFor(() => expect(replies).toHaveLength(count))
    expect(board.lastResponse?.now.inFlight).toHaveLength(count)
    replies[0](Response.json({ error: 'refused' }, { status: 422 }))
    if (count === 2) {
      // A completed gesture must not erase the other one's outstanding paint.
      await failed
      expect(reads).toHaveLength(1)
      expect(board.lastResponse?.now.inFlight).toHaveLength(2)
      replies[1](Response.json({ error: 'refused' }, { status: 422 }))
    }
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    expect(reads[1].has('If-None-Match')).toBe(false)
    await vi.waitFor(() => expect(board.lastResponse?.now.drafts).toHaveLength(count))
    expect(board.lastResponse?.now.inFlight).toHaveLength(0)
  })
})

describe('verdicts stop workers before changing the card lifecycle', () => {
  it('confirms then stops a worker before tempering', async () => {
    const c = card({
      id: 'app-verdict-1',
      status: 'active',
      shuttleKind: 'oneshot',
      workerState: 'running',
      tmuxSession: 'worker-shuttle',
      shuttleHost: 'worker-host',
    })
    const board = asPrivate(makeBoard())
    board.lastResponse = response({ now: { drafts: [], inFlight: [c], awaitingReview: [] } })
    ;(window as unknown as { confirm: (message: string) => boolean }).confirm = vi.fn(() => true)

    board.transition(c, 'tempered')
    await wire.settled()

    expect(wire.writes().map((w) => [w.url, w.body])).toEqual([
      [`${BASE}/api/v1/kill`, { fiber_id: 'app-verdict-1', origin: 'worker-host' }],
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
