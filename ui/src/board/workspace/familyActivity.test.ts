import { afterEach, describe, expect, it, vi } from 'vitest'
import { FamilyActivity } from './familyActivity.js'

describe('reading the daemon’s thread marks', () => {
  const answer = (body: unknown, ok = true): Response => ({ ok, json: async () => body }) as Response
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve))
  const reach = 7 * 86_400_000
  afterEach(() => { vi.unstubAllGlobals() })

  it('serves the marks and reach it read, and throttles the next read', async () => {
    const fetcher = vi.fn(async (_url: string) => answer({ reach_ms: reach, marks: { a: { launches: [5], commits: [6] } } }))
    vi.stubGlobal('fetch', fetcher)
    const onChange = vi.fn(), activity = new FamilyActivity('http://d', onChange)
    // Before any answer, the daemon's default retention, not zero.
    expect(activity.reach()).toBe(14 * 86_400_000)
    activity.refresh(1000)
    await settle()
    expect(fetcher.mock.calls[0][0]).toBe('http://d/api/v1/board/marks')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(activity.of('a')).toEqual({ launches: [5], commits: [6] })
    expect(activity.reach()).toBe(reach)
    activity.refresh(2000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('treats an answer with no marks as a failed read: nothing changes, and the next refresh retries', async () => {
    let body: unknown = {}
    vi.stubGlobal('fetch', vi.fn(async () => answer(body)))
    const onChange = vi.fn(), activity = new FamilyActivity('', onChange)
    activity.refresh(1000)
    await settle()
    expect(onChange).not.toHaveBeenCalled()
    body = { reach_ms: reach, marks: { a: { launches: [5], commits: [] } } }
    activity.refresh(1001)
    await settle()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(activity.of('a')?.launches).toEqual([5])
  })
  it('keeps the last answer through a refused read', async () => {
    const fetcher = vi.fn(async () => answer({ reach_ms: reach, marks: { a: { launches: [5], commits: [] } } }))
    vi.stubGlobal('fetch', fetcher)
    const activity = new FamilyActivity('', vi.fn())
    activity.refresh(1000)
    await settle()
    fetcher.mockImplementation(async () => answer({}, false))
    activity.refresh(1_000_000)
    await settle()
    expect(activity.of('a')?.launches).toEqual([5])
  })
})
