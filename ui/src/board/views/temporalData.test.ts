import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildSessionIndex,
  civilDaysToInstants,
  createTemporalFetchers,
  parseSessions,
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('narration wire form', () => {
  it('sends from_ms/to_ms and never the civil-day params', async () => {
    const calls = captureFetch(ok({ commits: [] }))
    await createTemporalFetchers('').narration('2026-08-06', '2026-08-06')

    expect(calls).toHaveLength(1)
    const { params } = calls[0]
    expect(params.has('from_ms')).toBe(true)
    expect(params.has('to_ms')).toBe(true)
    // The legacy pair must be absent, not merely ignored: the daemon selects
    // the instant form on the PRESENCE of either instant key, so sending both
    // pairs would work by luck rather than by contract.
    expect(params.has('from')).toBe(false)
    expect(params.has('to')).toBe(false)
    // Integers, not floats or exponent notation — the daemon parses strictly.
    expect(params.get('from_ms')).toMatch(/^\d+$/)
    expect(params.get('to_ms')).toMatch(/^\d+$/)
  })

  it('resolves the pair to local midnight through local end-of-day', async () => {
    const calls = captureFetch(ok({ commits: [] }))
    await createTemporalFetchers('').narration('2026-08-06', '2026-08-08')

    const fromMs = Number(calls[0].params.get('from_ms'))
    const toMs = Number(calls[0].params.get('to_ms'))
    const from = new Date(fromMs)
    const to = new Date(toMs)

    expect([from.getFullYear(), from.getMonth() + 1, from.getDate()]).toEqual([2026, 8, 6])
    expect([from.getHours(), from.getMinutes(), from.getSeconds()]).toEqual([0, 0, 0])
    // `to` is INCLUSIVE, so the window reaches the end of the 8th rather than
    // stopping at its start.
    expect([to.getFullYear(), to.getMonth() + 1, to.getDate()]).toEqual([2026, 8, 8])
    expect([to.getHours(), to.getMinutes(), to.getSeconds()]).toEqual([23, 59, 59])
  })

  it('asks for a single day as that whole day, not a zero-width window', async () => {
    // The bug this shape exists to prevent: DayView calls narration(day, day),
    // and an instant window read as two identical points returns nothing.
    const calls = captureFetch(ok({ commits: [] }))
    await createTemporalFetchers('').narration('2026-08-06', '2026-08-06')

    const width = Number(calls[0].params.get('to_ms')) - Number(calls[0].params.get('from_ms'))
    // 23, 24 or 25 hours depending on DST, minus the final millisecond.
    expect(width).toBeGreaterThanOrEqual(23 * 3_600_000 - 1)
    expect(width).toBeLessThanOrEqual(25 * 3_600_000)
  })

  it('degrades a 404 to an empty result without throwing', async () => {
    captureFetch(() => new Response('', { status: 404 }))
    await expect(createTemporalFetchers('').narration('2026-08-06', '2026-08-06'))
      .resolves.toEqual({ commits: [] })
  })

  it('caches on the civil-day pair, so a repeat asks the daemon once', async () => {
    const calls = captureFetch(ok({ commits: [{ iso: '2026-08-06T09:00:00Z', subject: 'a: b' }] }))
    const fetchers = createTemporalFetchers('')
    const first = await fetchers.narration('2026-08-06', '2026-08-06')
    const second = await fetchers.narration('2026-08-06', '2026-08-06')

    expect(calls).toHaveLength(1)
    expect(second).toEqual(first)
    expect(first.commits).toHaveLength(1)
  })

  it('resolves an unreadable day to empty without reaching the daemon', async () => {
    const calls = captureFetch(ok({ commits: [] }))
    await expect(createTemporalFetchers('').narration('not-a-day', '2026-08-06'))
      .resolves.toEqual({ commits: [] })
    expect(calls).toHaveLength(0)
  })
})

describe('civilDaysToInstants', () => {
  it('reads the leading day off a full ISO timestamp', () => {
    const span = civilDaysToInstants('2026-08-06T13:45:00Z', '2026-08-06T22:10:00Z')
    expect(span).not.toBeNull()
    expect(new Date(span!.fromMs).getDate()).toBe(6)
    expect(new Date(span!.fromMs).getHours()).toBe(0)
  })

  it('is null when either end carries no civil day', () => {
    expect(civilDaysToInstants('rubbish', '2026-08-06')).toBeNull()
    expect(civilDaysToInstants('2026-08-06', '')).toBeNull()
  })

  it('leaves an inverted pair inverted, for the daemon to refuse', () => {
    const span = civilDaysToInstants('2026-08-08', '2026-08-06')
    expect(span).not.toBeNull()
    expect(span!.fromMs).toBeGreaterThan(span!.toMs)
  })
})

// ── Session ledger → join index ──────────────────────────────────────────────
//
// The ledger is JOIN RUNG 0: a recorded fiber↔session pairing, which beats
// every name-derived rung because it is a fact rather than an inference and it
// outlives the session. `buildSessionIndex` is the shared shape both Chronicle
// and Day consume, so its edges are worth pinning precisely.

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
      .toEqual({ fiber: 'work/a/run', uid: '01KVBR4J9EZGYPJ07734SY90P1' })
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
    expect(index.byTmux.get('pi-2f9c41')).toEqual({ fiber: 'work/a/run', uid: null })
  })

  it('keeps distinct sessions on the same fiber separate', () => {
    const index = buildSessionIndex([
      rec({ session: 's1', tmux: 't1', at: 1 }),
      rec({ session: 's2', tmux: 't2', at: 2 }),
    ])
    expect(index.bySession.size).toBe(2)
    expect(index.byTmux.size).toBe(2)
  })

  it('is empty for an empty ledger', () => {
    const index = buildSessionIndex([])
    expect(index.byTmux.size).toBe(0)
    expect(index.bySession.size).toBe(0)
  })
})

describe('parseSessions', () => {
  const empty = { host: '', records: [] }

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
    expect(parseSessions({ records: 'nope' }, empty)).toEqual(empty)
  })
})

describe('sessions fetcher', () => {
  it('sends since_ms and degrades a 404 to an empty ledger', async () => {
    const calls = captureFetch(() => new Response('', { status: 404 }))
    const out = await createTemporalFetchers('').sessions(1_700_000_000_000)
    expect(calls[0].params.get('since_ms')).toBe('1700000000000')
    expect(out).toEqual({ host: '', records: [] })
  })

  it('caches on the bound, so a repeat asks once', async () => {
    const calls = captureFetch(ok({ host: 'ada', records: [] }))
    const f = createTemporalFetchers('')
    await f.sessions(0)
    await f.sessions(0)
    expect(calls).toHaveLength(1)
  })
})
