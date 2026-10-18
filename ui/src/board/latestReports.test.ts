import { afterEach, describe, expect, it, vi } from 'vitest'
import { LatestReports, REPORT_REFRESH_MS, newestByFiber } from './latestReports.js'
import type { ShelfFile } from './views/shelfData.js'
import { card } from './testFixtures.js'

const file = (fullPath: string, uid: string | undefined, timestamp: number, extra: Partial<ShelfFile> = {}): ShelfFile =>
  ({ fullPath, basename: fullPath.split('/').pop()!, timestamp, uid, ...extra })

describe('newestByFiber', () => {
  it('keeps the newest drawable file each fiber sent', () => {
    const map = newestByFiber([
      file('/a/old.html', 'A', 1), file('/a/new.png', 'A', 3), file('/a/chains.tar.gz', 'A', 9),
      file('/b/notes.pdf', 'B', 2),
      file('/loose/report.html', undefined, 5),
      file('/session/report.html', 'sess-1', 6, { sessionId: 'sess-1' }),
    ])
    expect([...map.keys()].sort()).toEqual(['A', 'B'])
    expect(map.get('A')?.fullPath).toBe('/a/new.png')
  })
})

describe('LatestReports', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const feed = (files: unknown[]) => vi.fn(async () => new Response(JSON.stringify({ files, origins: {} })))

  it('answers by uid, then id, with the byte owner resolved against the card\'s host', async () => {
    vi.stubGlobal('fetch', feed([
      { fullPath: '/r/report.html', timestamp: 10, uid: 'ULID-1' },
      { fullPath: '/r/plot.png', timestamp: 11, uid: 'work/by-id', host: 'cluster' },
    ]))
    const reports = new LatestReports('http://daemon', () => {})
    await reports.refresh(1_000_000)
    expect(reports.get(card({ id: 'work/x', uid: 'ULID-1', originId: 'laptop' }))).toEqual({ fullPath: '/r/report.html', basename: 'report.html', timestamp: 10, owner: 'laptop' })
    expect(reports.get(card({ id: 'work/by-id', originId: 'laptop' }))?.owner).toBe('cluster')
    expect(reports.get(card({ id: 'none' }))).toBeUndefined()
  })

  it('reads the fleet at most once a minute, and says so only when an answer changes', async () => {
    const fetcher = feed([{ fullPath: '/r/report.html', timestamp: 10, uid: 'A' }])
    vi.stubGlobal('fetch', fetcher)
    const onChange = vi.fn()
    const reports = new LatestReports('http://daemon', onChange)
    await reports.refresh(0)
    await reports.refresh(REPORT_REFRESH_MS - 1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String((fetcher.mock.calls[0] as unknown[])[0])).toMatch(/^http:\/\/daemon\/api\/v1\/sent-files\/all\/composite\?since_ms=/)
    expect(onChange).toHaveBeenCalledTimes(1)
    await reports.refresh(REPORT_REFRESH_MS)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('keeps the last answer when the feed fails', async () => {
    vi.stubGlobal('fetch', feed([{ fullPath: '/r/report.html', timestamp: 10, uid: 'A' }]))
    const reports = new LatestReports('http://daemon', () => {})
    await reports.refresh(0)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    await reports.refresh(REPORT_REFRESH_MS)
    expect(reports.get(card({ id: 'A' }))?.fullPath).toBe('/r/report.html')
  })
})
