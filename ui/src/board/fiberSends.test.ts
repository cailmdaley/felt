import { afterEach, describe, expect, it, vi } from 'vitest'
import { FiberSends, SEND_REFRESH_MS, newestReport, sendsByFiber, withEmbeds, type FiberSend } from './fiberSends.js'
import type { ShelfFile } from './views/shelfData.js'
import { card } from './testFixtures.js'

const file = (fullPath: string, uid: string | undefined, timestamp: number, extra: Partial<ShelfFile> = {}): ShelfFile =>
  ({ fullPath, basename: fullPath.split('/').pop()!, timestamp, uid, ...extra })

describe('sendsByFiber', () => {
  const files = [
    file('/a/old.html', 'A', 1), file('/a/new.png', 'A', 3), file('/a/chains.tar.gz', 'A', 9),
    file('/a/old.html', 'A', 4),
    file('/b/notes.pdf', 'B', 2),
    file('/loose/report.html', undefined, 5),
    file('/session/report.html', 'sess-1', 6, { sessionId: 'sess-1' }),
  ]

  it('lists each fiber\'s files newest first, a re-sent file at its latest send', () => {
    const map = sendsByFiber(files)
    expect([...map.keys()].sort()).toEqual(['A', 'B'])
    expect(map.get('A')!.map(f => [f.fullPath, f.timestamp])).toEqual([['/a/chains.tar.gz', 9], ['/a/old.html', 4], ['/a/new.png', 3]])
  })

  it('stands a fiber on its newest drawable file, never a receipt', () => {
    expect(newestReport(sendsByFiber(files).get('A')!)?.fullPath).toBe('/a/old.html')
    expect(newestReport([file('/x.tar.gz', 'X', 1)])).toBeUndefined()
  })
})

describe('FiberSends', () => {
  it('dismisses only the selected path on its stream host and replaces the snapshot', async () => {
    const target = card({ id: 'work/a', uid: 'uid', originId: 'owner' })
    const files = [
      { fullPath: '/a.html', timestamp: 1, uid: 'uid', host: 'host-a' },
      { fullPath: '/a.html', timestamp: 2, uid: 'uid', host: 'host-b' },
      { fullPath: '/b.html', timestamp: 3, uid: 'uid', host: 'host-a' },
    ]
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ files, origins: {} })))
      .mockResolvedValueOnce(new Response('{"ok":true}'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: files.slice(1), origins: {} })))
    vi.stubGlobal('fetch', fetcher)
    const reports = new FiberSends('http://daemon', () => {})
    await reports.refresh()
    const selected = reports.all(target).find(send => send.owner === 'host-a' && send.fullPath === '/a.html')!
    await reports.dismiss(target, selected)
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ uid: 'uid', origin: 'host-a', path: '/a.html' })
    expect(fetcher.mock.calls.filter((args: unknown[]) => String(args[0]).endsWith('/clear'))).toHaveLength(1)
    expect(reports.all(target).map(send => send.key)).toEqual(['host-a:/b.html', 'host-b:/a.html'])
  })

  it('preserves the exact receipt path when the document key normalizes it', async () => {
    const target = card({ id: 'work/a', uid: 'uid', originId: 'host' })
    const exact = '/tmp/missing/../report.html'
    const files = [exact, '/tmp/report.html'].map(fullPath => ({ fullPath, timestamp: 1, uid: 'uid', host: 'host' }))
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ files })))
      .mockResolvedValueOnce(new Response('{"ok":true}'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: files.slice(1), origins: {} })))
    vi.stubGlobal('fetch', fetcher)
    const reports = new FiberSends('', () => {})
    await reports.refresh()
    const selected = reports.all(target).find(send => send.fullPath === exact)!
    expect(selected.key).toBe('host:/tmp/report.html')
    await reports.dismiss(target, selected)
    expect(JSON.parse(fetcher.mock.calls[1][1].body).path).toBe(exact)
    expect(reports.all(target).map(send => send.fullPath)).toEqual(['/tmp/report.html'])
  })

  it('retains the snapshot when dismissal fails', async () => {
    const target = card({ id: 'work/a', uid: 'uid', originId: 'host' })
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ fullPath: '/a.html', timestamp: 1, uid: 'uid', host: 'host' }] })))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
    vi.stubGlobal('fetch', fetcher)
    const reports = new FiberSends('', () => {})
    await reports.refresh()
    await expect(reports.dismiss(target, reports.all(target)[0])).rejects.toThrow('503')
    expect(reports.all(target)).toHaveLength(1)
  })

  afterEach(() => { vi.unstubAllGlobals() })

  const feed = (files: unknown[]) => vi.fn(async () => new Response(JSON.stringify({ files, origins: {} })))

  it('answers by uid, then id, with the byte owner resolved against the card\'s host', async () => {
    vi.stubGlobal('fetch', feed([
      { fullPath: '/r/report.html', timestamp: 10, uid: 'ULID-1' },
      { fullPath: '/r/plot.png', timestamp: 11, uid: 'work/by-id', host: 'cluster' },
    ]))
    const reports = new FiberSends('http://daemon', () => {})
    await reports.refresh(1_000_000)
    expect(reports.latest(card({ id: 'work/x', uid: 'ULID-1', originId: 'laptop' }))).toEqual({ key: 'laptop:/r/report.html', fullPath: '/r/report.html', basename: 'report.html', timestamp: 10, owner: 'laptop' })
    expect(reports.latest(card({ id: 'work/by-id', originId: 'laptop' }))?.owner).toBe('cluster')
    expect(reports.latest(card({ id: 'none' }))).toBeUndefined()
    expect(reports.all(card({ id: 'none' }))).toEqual([])
  })

  it('answers everything a fiber sent, newest first, with receipts included', async () => {
    vi.stubGlobal('fetch', feed([
      { fullPath: '/r/report.html', timestamp: 10, uid: 'A' },
      { fullPath: '/r/chains.tar.gz', timestamp: 12, uid: 'A' },
      { fullPath: '/r/plot.png', timestamp: 11, uid: 'A', host: 'cluster' },
    ]))
    const reports = new FiberSends('http://daemon', () => {})
    await reports.refresh(1_000_000)
    expect(reports.all(card({ id: 'A', originId: 'laptop' })).map(s => s.key)).toEqual(['laptop:/r/chains.tar.gz', 'cluster:/r/plot.png', 'laptop:/r/report.html'])
    expect(reports.latest(card({ id: 'A', originId: 'laptop' }))?.basename).toBe('plot.png')
  })

  it('reads the fleet at most once a minute, and says so only when an answer changes', async () => {
    const fetcher = feed([{ fullPath: '/r/report.html', timestamp: 10, uid: 'A' }])
    vi.stubGlobal('fetch', fetcher)
    const onChange = vi.fn()
    const reports = new FiberSends('http://daemon', onChange)
    await reports.refresh(0)
    await reports.refresh(SEND_REFRESH_MS - 1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String((fetcher.mock.calls[0] as unknown[])[0])).toMatch(/^http:\/\/daemon\/api\/v1\/sent-files\/all\/composite\?since_ms=/)
    expect(onChange).toHaveBeenCalledTimes(1)
    await reports.refresh(SEND_REFRESH_MS)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('clears each stream host with the canonical uid and forces a fresh feed despite an in-flight stale read', async () => {
    let finishOld!: (response: Response) => void
    let reads = 0
    const stale = { files: [
      { fullPath: '/a.html', timestamp: 1, uid: 'canonical-uid', host: 'host-a' },
      { fullPath: '/b.html', timestamp: 2, uid: 'canonical-uid', host: 'host-b' },
    ], origins: {} }
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void init
      const url = String(input)
      if (url.includes('/clear')) return Promise.resolve(new Response('{"ok":true}'))
      reads++
      if (reads === 2) return new Promise<Response>(resolve => { finishOld = resolve })
      return Promise.resolve(new Response(JSON.stringify(reads === 1 ? stale : { files: [], origins: {} })))
    })
    vi.stubGlobal('fetch', fetcher)
    const reports = new FiberSends('http://daemon', () => {})
    await reports.refresh(1_000_000)
    const cardA = card({ id: 'work/slug', uid: 'canonical-uid', originId: 'owner' })
    const oldRead = reports.refresh(1_060_000)
    await Promise.resolve()
    await reports.clear(cardA)
    finishOld(new Response(JSON.stringify(stale)))
    await oldRead
    const clears = fetcher.mock.calls.filter(([url]) => String(url).includes('/clear'))
    expect(clears.map(([url, init]) => [String(url), JSON.parse(String(init?.body))]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      ['http://daemon/api/v1/sent-files/clear', { uid: 'canonical-uid', origin: 'host-a' }],
      ['http://daemon/api/v1/sent-files/clear', { uid: 'canonical-uid', origin: 'host-b' }],
    ])
    expect(reports.all(cardA)).toEqual([])
  })

  it('refreshes partial multi-host clears and reports the failed host', async () => {
    let cleared = false
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/clear')) {
        const { origin } = JSON.parse(String(init?.body))
        if (origin === 'host-b') return new Response('', { status: 503 })
        cleared = true
        return new Response('{"ok":true}')
      }
      return new Response(JSON.stringify({ files: [
        ...(!cleared ? [{ fullPath: '/a.html', timestamp: 1, uid: 'uid', host: 'host-a' }] : []),
        { fullPath: '/b.html', timestamp: 2, uid: 'uid', host: 'host-b' },
      ], origins: {} }))
    }))
    const reports = new FiberSends('http://daemon', () => {})
    const target = card({ id: 'work/a', uid: 'uid', originId: 'host-a' })
    await reports.refresh(0)
    await expect(reports.clear(target)).rejects.toThrow('host-b (503)')
    expect(reports.all(target).map(send => send.fullPath)).toEqual(['/b.html'])
  })

  it.each(['unavailable', 'pending-remote'])('reports a %s post-clear feed and retries without throttling', async mode => {
    const target = card({ id: 'work/a', uid: 'uid', originId: 'host' })
    const initial = { files: [{ fullPath: '/a.html', timestamp: 1, uid: 'uid', host: 'host' }], origins: {} }
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(initial)))
      .mockResolvedValueOnce(new Response('{"ok":true}'))
      .mockResolvedValueOnce(mode === 'unavailable' ? new Response('', { status: 503 })
        : new Response(JSON.stringify({ ...initial, origins: { host: { kind: 'remote', last_error: 'refresh_required' } } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [], origins: {} })))
    vi.stubGlobal('fetch', fetcher)
    const reports = new FiberSends('http://daemon', () => {})
    await reports.refresh()
    await expect(reports.clear(target)).rejects.toThrow('feed could not refresh')
    expect(reports.all(target)).toHaveLength(1)
    await reports.refresh()
    expect(reports.all(target)).toStrictEqual([])
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('surfaces non-success clear responses as errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).includes('/clear')
      ? new Response('', { status: 503 })
      : new Response(JSON.stringify({ files: [{ fullPath: '/a.html', timestamp: 1, uid: 'uid', host: 'host' }], origins: {} }))))
    const reports = new FiberSends('http://daemon', () => {})
    await reports.refresh(0)
    await expect(reports.clear(card({ id: 'uid', uid: 'uid', originId: 'owner' }))).rejects.toThrow('503')
  })

  it('keeps the last answer when the feed fails', async () => {
    vi.stubGlobal('fetch', feed([{ fullPath: '/r/report.html', timestamp: 10, uid: 'A' }]))
    const reports = new FiberSends('http://daemon', () => {})
    await reports.refresh(0)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    await reports.refresh(SEND_REFRESH_MS)
    expect(reports.latest(card({ id: 'A' }))?.fullPath).toBe('/r/report.html')
  })
})

describe('withEmbeds', () => {
  const doc = (path: string, timestamp: number, embedded?: boolean): FiberSend =>
    ({ key: `h:${path}`, fullPath: path, basename: path.split('/').pop()!, timestamp, owner: 'h', ...(embedded ? { embedded } : {}) })

  it('leads with the body\'s embeds in their order, then the rest sent, one item per document', () => {
    const sends = [doc('/f/plot.png', 30), doc('/f/report.html', 20), doc('/f/notes.pdf', 10)]
    const embeds = [doc('/f/summary.html', 0, true), doc('/f/report.html', 0, true)]
    expect(withEmbeds(sends, embeds).map(s => [s.basename, s.timestamp, !!s.embedded])).toEqual([
      ['summary.html', 0, true], ['report.html', 20, true], ['plot.png', 30, false], ['notes.pdf', 10, false],
    ])
  })
})
