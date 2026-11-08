import { afterEach, describe, expect, it, vi } from 'vitest'
import { FiberSends, SEND_REFRESH_MS, sendsByFiber } from './fiberSends.js'
import type { SentFile } from './sentFiles.js'
import { card } from './testFixtures.js'

const file = (fullPath: string, uid: string | undefined, timestamp: number, extra: Partial<SentFile> = {}): SentFile =>
  ({ fullPath, basename: fullPath.split('/').pop()!, timestamp, uid, ...extra })

describe('sendsByFiber', () => {
  const files = [
    file('/a/old.html', 'A', 1), file('/a/new.png', 'A', 3), file('/a/chains.tar.gz', 'A', 9),
    file('/a/old.html', 'A', 4), file('/b/notes.pdf', 'B', 2),
    file('/loose/report.html', undefined, 5), file('/session/report.html', 'sess-1', 6, { sessionId: 'sess-1' }),
  ]
  it('lists each fiber’s files newest first, a re-sent file at its latest send', () => {
    const map = sendsByFiber(files)
    expect([...map.keys()].sort()).toEqual(['A', 'B'])
    expect(map.get('A')!.map(f => [f.fullPath, f.timestamp])).toEqual([['/a/chains.tar.gz', 9], ['/a/old.html', 4], ['/a/new.png', 3]])
  })
})

describe('FiberSends', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const feed = (files: unknown[]) => vi.fn(async () => new Response(JSON.stringify({ files, origins: {} })))
  it('answers by uid, then id, with the byte owner resolved against the card’s host', async () => {
    vi.stubGlobal('fetch', feed([
      { fullPath: '/r/report.html', timestamp: 10, uid: 'ULID-1' },
      { fullPath: '/r/plot.png', timestamp: 11, uid: 'work/by-id', host: 'cluster' },
    ]))
    const reports = new FiberSends('http://daemon')
    await reports.refresh(1_000_000)
    expect(reports.sends(card({ id: 'work/x', uid: 'ULID-1', originId: 'laptop' }))).toEqual([{ key: 'laptop:/r/report.html', fullPath: '/r/report.html', basename: 'report.html', timestamp: 10, owner: 'laptop' }])
    expect(reports.sends(card({ id: 'work/by-id', originId: 'laptop' }))[0]?.owner).toBe('cluster')
    expect(reports.sends(card({ id: 'none' }))).toEqual([])
  })
  it('reads the fleet at most once a minute, and says so only when an answer changes', async () => {
    const fetcher = feed([{ fullPath: '/r/report.html', timestamp: 10, uid: 'A' }])
    vi.stubGlobal('fetch', fetcher)
    const onChange = vi.fn()
    const reports = new FiberSends('http://daemon')
    reports.subscribe(onChange)
    await reports.refresh(0)
    await reports.refresh(SEND_REFRESH_MS - 1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    // The window's start is quantized, so an unchanged feed keeps one URL and revalidates.
    expect(String((fetcher.mock.calls[0] as unknown[])[0])).toMatch(/^http:\/\/daemon\/api\/v1\/sent-files\/all\/composite\?since_ms=\d+$/)
    expect(onChange).toHaveBeenCalledTimes(1)
    await reports.refresh(SEND_REFRESH_MS)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledTimes(1)
  })
  it('keeps the last answer when the feed fails', async () => {
    vi.stubGlobal('fetch', feed([{ fullPath: '/r/report.html', timestamp: 10, uid: 'A' }]))
    const reports = new FiberSends('http://daemon')
    await reports.refresh(0)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    await reports.refresh(SEND_REFRESH_MS)
    expect(reports.sends(card({ id: 'A' }))[0]?.fullPath).toBe('/r/report.html')
  })
})
