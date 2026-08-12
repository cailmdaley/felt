import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildSessionIndex,
  createTemporalFetchers,
  isOriginStale,
  lookupSession,
  lookupTmux,
  parseCommits,
  parseSessions,
  staleOrigins,
  type SessionRecord,
} from './TemporalData.js'

/**
 * The narration fetcher's WIRE FORM. The views' side of the contract is
 * unchanged (inclusive civil days in, commits out) — what these cover is the
 * transport underneath it, which moved from the daemon's civil-day params to
 * timezone-free instants so the daemon's zone can no longer shift a browser's
 * window. The suite runs twice, under America/Los_Angeles and Europe/Paris, so
 * the local-midnight resolution is exercised in two zones on every run.
 */

interface FetchCall {
  url: string
  params: URLSearchParams
}

/** Stub `fetch`, recording each URL. `respond` shapes the reply. */
function captureFetch(respond: () => Response): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push({ url, params: new URL(url, 'http://daemon.test').searchParams })
    return respond()
  })
  return calls
}

const ok = (body: unknown) => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

/** Reply per URL substring: the composite path and the plain path answer
 *  differently, which is the whole subject of the fallback tests. */
function routedFetch(routes: Array<[match: string, respond: () => Response]>): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push({ url, params: new URL(url, 'http://daemon.test').searchParams })
    for (const [match, respond] of routes) if (url.includes(match)) return respond()
    return new Response('', { status: 404 })
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── The session ledger ──────────────────────────────────────────────────────
//
// The ledger is the JOIN: a recorded fiber↔session pairing, which is a fact
// rather than an inference and outlives the session that made it.
// `buildSessionIndex` is the shared shape Chronicle, Day and Week consume, so
// its edges are worth pinning precisely.

function rec(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    at: 1_000,
    fiber: 'work/a/run',
    uid: '01KVBR4J9EZGYPJ07734SY90P1',
    session: 'sess-1',
    harness: 'claude-code',
    host: 'ada',
    tmux: 'run-01KVBR4J9EZGYPJ07734SY90P1-shuttle',
    kind: 'dispatch',
    ...over,
  }
}

describe('buildSessionIndex', () => {
  it('indexes a pairing under both its tmux name and its session uuid', () => {
    const { byTmux, bySession } = buildSessionIndex([rec()])
    expect(byTmux.get('run-01KVBR4J9EZGYPJ07734SY90P1-shuttle'))
      .toEqual({
        fiber: 'work/a/run',
        uid: '01KVBR4J9EZGYPJ07734SY90P1',
        // The pairing carries its own session and host: a hover asks a HOST
        // for a SESSION's transcript, and both halves have to survive the join.
        session: 'sess-1',
        host: 'ada',
      })
    expect(bySession.get('sess-1')?.fiber).toBe('work/a/run')
  })

  it('last record wins — a resume supersedes the dispatch it followed', () => {
    const index = buildSessionIndex([
      rec({ at: 1_000, fiber: 'work/old', kind: 'dispatch' }),
      rec({ at: 2_000, fiber: 'work/new', kind: 'resume' }),
    ])
    expect(index.bySession.get('sess-1')?.fiber).toBe('work/new')
    expect(index.byTmux.get('run-01KVBR4J9EZGYPJ07734SY90P1-shuttle')?.fiber).toBe('work/new')
  })

  it('orders by `at`, not by array position', () => {
    // A cross-host view merges several daemons' ledgers, and a merged array is
    // not globally sorted. The newest pairing must still win.
    const index = buildSessionIndex([
      rec({ at: 5_000, fiber: 'work/newest' }),
      rec({ at: 2_000, fiber: 'work/older' }),
    ])
    expect(index.bySession.get('sess-1')?.fiber).toBe('work/newest')
  })

  it('keeps a tmux-less record out of byTmux but in bySession', () => {
    // A session with no terminal is a real thing the ledger records — absent
    // from one map, not dropped from both.
    const index = buildSessionIndex([rec({ tmux: null, session: 'headless' })])
    expect(index.bySession.get('headless')?.fiber).toBe('work/a/run')
    expect([...index.byTmux.keys()]).toEqual([])
  })

  it('carries a null uid through rather than inventing one', () => {
    const index = buildSessionIndex([rec({ uid: null, tmux: 'pi-2f9c41' })])
    expect(index.byTmux.get('pi-2f9c41')).toEqual({
      fiber: 'work/a/run',
      uid: null,
      session: 'sess-1',
      host: 'ada',
    })
  })

  it('keeps distinct sessions on the same fiber separate', () => {
    const index = buildSessionIndex([
      rec({ session: 's1', tmux: 't1', at: 1 }),
      rec({ session: 's2', tmux: 't2', at: 2 }),
    ])
    expect(index.bySession.size).toBe(2)
    // Two names, each written three times: bare, host-scoped, and the
    // "some host owns this name" marker.
    expect(index.byTmux.size).toBe(6)
  })

  it('is empty for an empty ledger', () => {
    const index = buildSessionIndex([])
    expect(index.byTmux.size).toBe(0)
    expect(index.bySession.size).toBe(0)
  })
})

describe('parseSessions', () => {
  const empty = { host: '', records: [], origins: {} }

  it('drops a line missing fiber, session, or a known kind', () => {
    const body = {
      host: 'ada',
      records: [
        { at: 1, fiber: 'work/a', session: 's1', kind: 'dispatch' },
        { at: 2, fiber: '', session: 's2', kind: 'dispatch' },      // blank fiber
        { at: 3, fiber: 'work/c', session: '  ', kind: 'claim' },   // blank session
        { at: 4, fiber: 'work/d', session: 's4', kind: 'invented' },// unknown kind
        { at: 5, fiber: 'work/e', session: 's5' },                  // no kind
        'not an object',
      ],
    }
    const out = parseSessions(body, empty)
    expect(out.host).toBe('ada')
    expect(out.records.map((r) => r.session)).toEqual(['s1'])
  })

  it('treats blank optional fields as absent rather than empty strings', () => {
    const out = parseSessions(
      { host: 'ada', records: [{ at: 1, fiber: 'work/a', session: 's1', kind: 'claim', tmux: '   ', uid: '', harness: null }] },
      empty,
    )
    expect(out.records[0]).toMatchObject({ tmux: null, uid: null, harness: null })
  })

  it('falls back on a body that is not a ledger', () => {
    expect(parseSessions(null, empty)).toEqual(empty)
    expect(parseSessions({ records: 'nope' }, empty)).toEqual({ host: '', records: [], origins: {} })
  })
})

describe('sessions fetcher', () => {
  it('sends since_ms and degrades a 404 to an empty ledger', async () => {
    const calls = captureFetch(() => new Response('', { status: 404 }))
    const out = await createTemporalFetchers('').sessions(1_700_000_000_000)
    expect(calls[0].params.get('since_ms')).toBe('1700000000000')
    expect(out).toEqual({ host: '', records: [], origins: {} })
  })

  it('caches on the bound, so a repeat asks once', async () => {
    const calls = captureFetch(ok({ host: 'ada', records: [] }))
    const f = createTemporalFetchers('')
    await f.sessions(0)
    await f.sessions(0)
    expect(calls).toHaveLength(1)
  })
})

// ── Cross-host composites ────────────────────────────────────────────────────
//
// Every feed is asked for cross-host first and degrades to the single-host
// route on a 404. What these pin is the pair of promises the views rest on: an
// item always knows its host, and an origins block is always present — so no
// view has to know which route answered.

describe('composite routing', () => {
  it('asks the composite first and reads its hosts and origins', async () => {
    const calls = routedFetch([
      ['/activity/composite', ok({
        host: 'ada',
        from_ms: 0,
        to_ms: 60_000,
        buckets: [
          { m: 0, s: 'run-shuttle', cwd: '/w', k: 'agent', n: 2 },
          { m: 0, s: 'run-shuttle', cwd: '/w', k: 'agent', n: 1, host: 'bob' },
        ],
        origins: {
          ada: { kind: 'local', stale: false },
          bob: {
            kind: 'remote',
            stale: true,
            last_polled_at: '2026-08-09T08:00:00Z',
            last_error: 'timeout',
            window: { from_ms: 0, to_ms: 30_000 },
          },
        },
      })],
    ])

    const out = await createTemporalFetchers('').activity(0, 60_000)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/activity/composite')
    // An unstamped bucket belongs to the daemon that served the response.
    expect(out.buckets.map((b) => b.host)).toEqual(['ada', 'bob'])
    expect(out.origins?.bob).toEqual({
      kind: 'remote',
      stale: true,
      lastPolledAt: '2026-08-09T08:00:00Z',
      lastError: 'timeout',
      window: { fromMs: 0, toMs: 30_000 },
    })
    expect(isOriginStale(out.origins ?? {}, 'bob')).toBe(true)
    expect(isOriginStale(out.origins ?? {}, 'ada')).toBe(false)
    expect(staleOrigins(out.origins ?? {})).toEqual(['bob'])
  })

  it('falls back to the plain route on a composite 404, then stops probing', async () => {
    // An older daemon has no composite. It must keep working, and it must not
    // pay a wasted round trip on every window for the rest of the session.
    const calls = routedFetch([
      ['/sessions/composite', () => new Response('', { status: 404 })],
      ['/sessions', ok({ host: 'ada', records: [
        { at: 1, fiber: 'work/a', session: 's1', kind: 'dispatch', tmux: 't1' },
      ] })],
    ])
    const fetchers = createTemporalFetchers('')

    const first = await fetchers.sessions(0)
    const second = await fetchers.sessions(1)

    expect(calls.map((c) => c.url.includes('composite'))).toEqual([true, false, false])
    // The single-host route carries no host per record; the response's own host
    // fills in, so the join key is scoped either way.
    expect(first.records[0].host).toBe('ada')
    expect(first.origins).toEqual({ ada: { kind: 'local', stale: false } })
    expect(second.records).toHaveLength(1)
  })

  it('keeps probing the composite after a 5xx — that is not an old daemon', async () => {
    // Latching on anything but a 404 would strand a whole fleet on single-host
    // data until the board reloads.
    const calls = routedFetch([
      ['/commits/composite', () => new Response('', { status: 503 })],
    ])
    const fetchers = createTemporalFetchers('')

    await expect(fetchers.commits(0, 1)).resolves.toEqual({ host: '', records: [], origins: {} })
    await fetchers.commits(2, 3)

    expect(calls.every((c) => c.url.includes('composite'))).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('degrades one feed without degrading the others', async () => {
    const calls = routedFetch([
      ['/activity/composite', () => new Response('', { status: 404 })],
      ['/activity', ok({ host: 'ada', from_ms: 0, to_ms: 1, buckets: [] })],
      ['/sessions/composite', ok({ host: 'ada', records: [], origins: {} })],
    ])
    const fetchers = createTemporalFetchers('')

    await fetchers.activity(0, 1)
    await fetchers.sessions(0)

    expect(calls.map((c) => c.url)).toEqual([
      '/api/v1/activity/composite?from_ms=0&to_ms=1',
      '/api/v1/activity?from_ms=0&to_ms=1',
      '/api/v1/sessions/composite?since_ms=0',
    ])
  })

  it('synthesizes a local origin when a response carries no block', async () => {
    routedFetch([['/commits', ok({ host: 'ada', records: [
      { at: 1, sha: 'a'.repeat(40), subject: 'a: b', session: 's', insertions: 1, deletions: 0, files: 1 },
    ] })]])
    const out = await createTemporalFetchers('').commits(0, 10)

    expect(out.origins).toEqual({ ada: { kind: 'local', stale: false } })
    expect(out.records[0].host).toBe('ada')
  })
})

describe('cross-host tmux join', () => {
  // Two daemons can each run a session called `run-shuttle`, on different
  // fibers. Flat-keyed, whichever ledger line landed last would claim both
  // hosts' minutes; scoped, each host reads its own.
  const index = buildSessionIndex([
    rec({ at: 1_000, host: 'ada', tmux: 'run-shuttle', session: 's-ada', fiber: 'work/ada' }),
    rec({ at: 2_000, host: 'bob', tmux: 'run-shuttle', session: 's-bob', fiber: 'work/bob' }),
  ])

  it('resolves each host to its own pairing', () => {
    expect(lookupTmux(index.byTmux, 'ada', 'run-shuttle')?.fiber).toBe('work/ada')
    expect(lookupTmux(index.byTmux, 'bob', 'run-shuttle')?.fiber).toBe('work/bob')
  })

  it('falls back to the bare name only when the host is unknown', () => {
    // Last pairing wins on the bare key — a guess, and reached only by a bucket
    // that refuses to say where it ran.
    expect(lookupTmux(index.byTmux, null, 'run-shuttle')?.fiber).toBe('work/bob')
  })

  it('refuses another host\'s pairing for a host with no entry of its own', () => {
    // `carl` also runs `run-shuttle`, but nothing has paired it. Borrowing
    // ada's or bob's pairing would put carl's minutes on someone else's fiber.
    expect(lookupTmux(index.byTmux, 'carl', 'run-shuttle')).toBeUndefined()
  })

  it('falls back for a host that has no scoped entry', () => {
    // A ledger line written before host stamping still joins.
    const older = buildSessionIndex([rec({ host: null, tmux: 'solo' })])
    expect(lookupTmux(older.byTmux, 'ada', 'solo')?.fiber).toBe('work/a/run')
  })

  it('is undefined for a nameless session', () => {
    expect(lookupTmux(index.byTmux, 'ada', null)).toBeUndefined()
  })
})

// ── The commit ledger ────────────────────────────────────────────────────────

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

describe('the commits wire form', () => {
  it('reads the composite first, sending both instants', async () => {
    const calls = captureFetch(ok({ host: 'ada', records: [], origins: {} }))
    const result = await createTemporalFetchers('').commits(1_000, 9_000)
    expect(calls[0].url).toContain('/api/v1/commits/composite')
    expect(calls[0].params.get('since_ms')).toBe('1000')
    expect(calls[0].params.get('until_ms')).toBe('9000')
    expect(result.records).toEqual([])
  })

  it('falls back to the plain route ONCE when the composite is absent', async () => {
    const calls = routedFetch([
      ['/commits?', ok({ host: 'ada', records: [], origins: {} })],
    ])
    const fetchers = createTemporalFetchers('')
    await fetchers.commits(1, 2)
    await fetchers.commits(3, 4)
    // Probe, fallback, then the second window goes straight to the plain route.
    expect(calls.map((c) => c.url.includes('composite'))).toEqual([true, false, false])
  })

  it('degrades to an empty ledger rather than rejecting', async () => {
    captureFetch(() => new Response('nonsense', { status: 500 }))
    await expect(createTemporalFetchers('').commits(1, 2)).resolves.toEqual({
      host: '',
      records: [],
      origins: {},
    })
  })
})

describe('parseCommits', () => {
  const empty = { host: '', records: [], origins: {} }
  const wire = (over: Record<string, unknown> = {}) => ({
    at: 1_786_203_000_000,
    kind: 'commit',
    sha: SHA_A,
    subject: 'felt: wrote it down',
    repo: '/home/ada/dev/felt',
    files: 3,
    insertions: 42,
    deletions: 7,
    session: 'sess-1',
    tmux: 'run-shuttle',
    cwd: '/home/ada/dev/felt',
    host: 'ada',
    ...over,
  })

  it('reads a whole record off the wire', () => {
    const { records } = parseCommits({ host: 'ada', records: [wire()] }, empty)
    expect(records).toEqual([
      {
        at: 1_786_203_000_000,
        sha: SHA_A,
        subject: 'felt: wrote it down',
        repo: '/home/ada/dev/felt',
        files: 3,
        insertions: 42,
        deletions: 7,
        session: 'sess-1',
        tmux: 'run-shuttle',
        cwd: '/home/ada/dev/felt',
        host: 'ada',
      },
    ])
  })

  it('drops a record with no readable sha — an identity is what dedupe needs', () => {
    const { records } = parseCommits(
      { host: 'ada', records: [wire({ sha: null }), wire({ sha: 'abc123' }), wire()] },
      empty,
    )
    expect(records.map((r) => r.sha)).toEqual([SHA_A])
  })

  it('lower-cases a sha, so two spellings of one commit are one commit', () => {
    const { records } = parseCommits(
      { host: 'ada', records: [wire({ sha: SHA_A.toUpperCase() })] },
      empty,
    )
    expect(records[0].sha).toBe(SHA_A)
  })

  it('keeps an empty subject but drops a missing one', () => {
    const { records } = parseCommits(
      { host: 'ada', records: [wire({ subject: '' }), wire({ sha: SHA_B, subject: 7 })] },
      empty,
    )
    expect(records.map((r) => r.subject)).toEqual([''])
  })

  it('drops a record announcing some other kind', () => {
    const { records } = parseCommits(
      { host: 'ada', records: [wire({ kind: 'push' }), wire({ kind: null })] },
      empty,
    )
    expect(records).toHaveLength(1)
  })

  it('reads a missing count as zero, never as NaN', () => {
    const { records } = parseCommits(
      { host: 'ada', records: [wire({ files: null, insertions: 'lots', deletions: undefined })] },
      empty,
    )
    expect(records[0]).toMatchObject({ files: 0, insertions: 0, deletions: 0 })
  })

  it('stamps an unstamped record with the response host', () => {
    const { records } = parseCommits({ host: 'ada', records: [wire({ host: null })] }, empty)
    expect(records[0].host).toBe('ada')
  })

  it('synthesizes a local origin when the body carries no block', () => {
    const { origins } = parseCommits({ host: 'ada', records: [] }, empty)
    expect(origins).toEqual({ ada: { kind: 'local', stale: false } })
  })

  it('falls back whole on a body that is not a ledger', () => {
    expect(parseCommits('nope', empty)).toBe(empty)
    expect(parseCommits({ host: 'ada', records: 'nope' }, empty).records).toEqual([])
  })
})

describe('lookupSession', () => {
  const index = buildSessionIndex([
    rec({ session: 'sess-ada', tmux: 'run-shuttle', host: 'ada' }),
    rec({ session: 'sess-loose', tmux: null, host: null, fiber: 'work/loose' }),
  ])

  it('resolves a session id to its pairing', () => {
    expect(lookupSession(index.bySession, 'ada', 'sess-ada')?.fiber).toBe('work/a/run')
  })

  it('refuses a pairing recorded on another host', () => {
    expect(lookupSession(index.bySession, 'cineca', 'sess-ada')).toBeUndefined()
  })

  it('reads past a difference of case in the host name', () => {
    expect(lookupSession(index.bySession, 'ADA', 'sess-ada')?.fiber).toBe('work/a/run')
  })

  it('falls back to the id alone when either side says nothing', () => {
    // An asker that cannot say where it ran, and a ledger line written before
    // host stamping: both are the pre-fleet case, and both still join.
    expect(lookupSession(index.bySession, null, 'sess-ada')?.fiber).toBe('work/a/run')
    expect(lookupSession(index.bySession, 'cineca', 'sess-loose')?.fiber).toBe('work/loose')
  })

  it('is undefined for no session and for an unknown one', () => {
    expect(lookupSession(index.bySession, 'ada', null)).toBeUndefined()
    expect(lookupSession(index.bySession, 'ada', 'sess-nope')).toBeUndefined()
  })
})
