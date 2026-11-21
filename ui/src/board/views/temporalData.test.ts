import { describe, expect, it } from 'vitest'
import { isOriginStale, parseSessions } from './TemporalData.js'

describe('parseSessions', () => {
  const empty = { host: '', records: [], origins: {} }

  it('drops a line missing fiber, session, or a known kind', () => {
    const body = {
      host: 'ada',
      records: [
        { at: 1, fiber: 'work/a', session: 's1', kind: 'dispatch' },
        { at: 2, fiber: '', session: 's2', kind: 'dispatch' },
        { at: 3, fiber: 'work/c', session: '  ', kind: 'claim' },
        { at: 4, fiber: 'work/d', session: 's4', kind: 'invented' },
        { at: 5, fiber: 'work/e', session: 's5' },
        'not an object',
      ],
    }
    const out = parseSessions(body, empty)
    expect(out.host).toBe('ada')
    expect(out.records.map((r) => r.session)).toEqual(['s1'])
  })

  it('reads optional role provenance without a collaborator', () => {
    const records = parseSessions({ records: [
      { at: 1, fiber: 'work/a', session: 's1', kind: 'dispatch', role: 'surveyor', collaborator: 'sol' },
      { at: 2, fiber: 'work/a', session: 's2', kind: 'claim', role: '' },
      { at: 3, fiber: 'work/b', session: 's3', kind: 'resume' },
    ] }, empty).records
    expect(records[0].role).toBe('surveyor')
    expect(records[0]).not.toHaveProperty('collaborator')
    expect(records[1]).not.toHaveProperty('role')
    expect(records[2]).not.toHaveProperty('role')
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

  it('reads per-origin freshness and synthesizes the local origin', () => {
    const out = parseSessions({
      host: 'ada',
      records: [],
      origins: { bob: { kind: 'remote', stale: true, last_error: 'timeout' } },
    }, empty)
    expect(isOriginStale(out.origins!, 'bob')).toBe(true)
    expect(isOriginStale(out.origins!, 'ada')).toBe(false)
    expect(isOriginStale(out.origins!, 'unknown')).toBe(false)
    expect(isOriginStale(out.origins!, null)).toBe(false)
  })
})
