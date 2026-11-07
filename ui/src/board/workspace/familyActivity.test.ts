import { afterEach, describe, expect, it, vi } from 'vitest'
import { FamilyActivity, threadMarks } from './familyActivity.js'

it('reads a burst of resumes as a daemon restart, and marks dispatches and lone resumes', () => {
  const t = 1_000_000_020_000
  const marks = threadMarks([
    { uid: 'a', kind: 'dispatch', at: t - 600_000 },
    { uid: 'a', kind: 'resume', at: t },
    { uid: 'b', kind: 'resume', at: t + 1000 },
    { uid: 'c', kind: 'resume', at: t + 2000 },
    { uid: 'b', kind: 'resume', at: t + 3_600_000 },
  ], [])
  expect(marks.get('a')?.launches).toEqual([t - 600_000])
  expect(marks.get('b')?.launches).toEqual([t + 3_600_000])
  expect(marks.get('c')).toBeUndefined()
})
it('joins a commit to its thread by session, else by terminal, and drops one with no owner', () => {
  const marks = threadMarks([{ uid: 'a', kind: 'dispatch', at: 1, session: 's', tmux: 't' }], [{ at: 2, session: 's' }, { at: 3, tmux: 't' }, { at: 4, session: 'other' }])
  expect(marks.get('a')?.commits).toEqual([2, 3])
})

describe('reading the ledgers', () => {
  const answer = (body: unknown, ok = true): Response => ({ ok, json: async () => body }) as Response
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve))
  afterEach(() => { vi.unstubAllGlobals() })

  it('marks threads from both feeds and throttles the next read', async () => {
    const fetcher = vi.fn(async (url: string) => answer({ records: url.includes('sessions') ? [{ uid: 'a', kind: 'dispatch', at: 5, session: 's' }] : [{ at: 6, session: 's' }] }))
    vi.stubGlobal('fetch', fetcher)
    const onChange = vi.fn(), activity = new FamilyActivity('', onChange)
    activity.refresh(1000)
    await settle()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(activity.of('a')).toEqual({ launches: [5], commits: [6] })
    activity.refresh(2000)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('treats a feed with no records as a failed read: nothing changes, and the next refresh retries', async () => {
    let body: unknown = {}
    vi.stubGlobal('fetch', vi.fn(async () => answer(body)))
    const onChange = vi.fn(), activity = new FamilyActivity('', onChange)
    activity.refresh(1000)
    await settle()
    expect(onChange).not.toHaveBeenCalled()
    body = { records: [{ uid: 'a', kind: 'dispatch', at: 5 }] }
    activity.refresh(1001)
    await settle()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(activity.of('a')?.launches).toEqual([5])
  })
  it('keeps the last answer through a refused read', async () => {
    const fetcher = vi.fn(async () => answer({ records: [{ uid: 'a', kind: 'dispatch', at: 5 }] }))
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
