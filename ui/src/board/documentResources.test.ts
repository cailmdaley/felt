import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bytes, fact, fetchDocument, head, peek, peekVersion, recallText, resetDocumentResources, resourceKey, RESOURCE_DEADLINE_MS, RESOURCE_FRESH_MS, RESOURCE_TEXT_BUDGET,
  RESOURCE_PRIORITY, text, type ResourcePriority,
} from './documentResources.js'
import { resetLanes } from './requestLanes.js'
import { normalizeAbsolutePath } from './workspace/documents.js'

const body = (text: string, etag = 'W/"sha256-a"', status = 206) => new Response(new TextEncoder().encode(text), { status, headers: { ETag: etag } })
const header = (init: unknown, name: string): string | null => new Headers((init as RequestInit | undefined)?.headers).get(name)
afterEach(() => { resetDocumentResources(); resetLanes(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('document keys', () => {
  const segment = fc.oneof(fc.constantFrom('.', '..', '', 'a', 'b c', '~x', 'ü'), fc.stringMatching(/^[a-z0-9._-]{1,6}$/))
  const spelling = fc.array(segment, { minLength: 1, maxLength: 8 }).map(parts => `/${parts.join('/')}`)
  const owner = fc.constantFrom('local', 'umber-workstation', 'basalt-login-02')

  it('names one document by owner and normalised path, whichever route and spelling asks', () => {
    fc.assert(fc.property(owner, spelling, (host, path) => {
      const key = `${host}:${normalizeAbsolutePath(path)}`
      const query = `path=${encodeURIComponent(path)}${host === 'local' ? '' : `&origin=${encodeURIComponent(host)}`}`
      expect(resourceKey(`http://d:4000/api/v1/file?${query}`)).toBe(key)
      expect(resourceKey(`/api/v1/file-info?${query}`)).toBe(key)
      const assetPath = normalizeAbsolutePath(path).split('/').map(encodeURIComponent).join('/')
      expect(resourceKey(`/api/v1/file-assets/${encodeURIComponent(host)}${assetPath}`)).toBe(key)
    }))
  })

  it('keeps an explicit owner distinct from the local daemon', () => {
    expect(resourceKey('/api/v1/file?path=%2Fa')).toBe('local:/a')
    expect(resourceKey('/api/v1/file?path=%2Fa&origin=umber')).toBe('umber:/a')
  })
})

describe('the request queue', () => {
  it('serves background reads neighbours, titles, thumbnails, durations, in arrival order within each', async () => {
    const priorities = fc.constantFrom<ResourcePriority>(1, 2, 3, 4)
    await fc.assert(fc.asyncProperty(fc.array(priorities, { minLength: 1, maxLength: 12 }), async ranks => {
      resetDocumentResources(); resetLanes()
      const order: string[] = []
      let release!: () => void
      const gate = new Promise<void>(r => { release = r })
      vi.stubGlobal('fetch', vi.fn(async (src: string) => {
        order.push(src)
        if (src.includes('busy')) await gate
        return body(src)
      }))
      // Two quiet slots over HTTP/1.1: fill them, then queue in arrival order.
      const busy = [peek('/api/v1/file?path=/busy-a'), peek('/api/v1/file?path=/busy-b')]
      const queued = ranks.map((rank, i) => peek(`/api/v1/file?path=/doc-${i}`, rank))
      release()
      await Promise.all([...busy, ...queued])
      const expected = ranks.map((rank, i) => ({ rank, i })).sort((a, b) => a.rank - b.rank || a.i - b.i).map(({ i }) => `/api/v1/file?path=/doc-${i}`)
      expect(order.slice(2)).toEqual(expected)
    }), { numRuns: 40 })
  })

  it('reads the selected page in the foreground, past a full background lane', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const order: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (src: string) => { order.push(src); if (src.includes('busy')) await gate; return body(src) }))
    const busy = [peek('/api/v1/file?path=/busy-a'), peek('/api/v1/file?path=/busy-b'), peek('/api/v1/file?path=/title')]
    await peek('/api/v1/file?path=/page', RESOURCE_PRIORITY.selected)
    expect(order).toEqual(['/api/v1/file?path=/busy-a', '/api/v1/file?path=/busy-b', '/api/v1/file?path=/page'])
    release(); await Promise.all(busy)
  })

  it('moves a waiting read up when the selected page asks for it, and cancels one every asker abandoned', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const order: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (src: string) => { order.push(src); if (src.includes('busy')) await gate; return body(src) }))
    const busy = [peek('/api/v1/file?path=/busy-a'), peek('/api/v1/file?path=/busy-b')]
    const thumbnail = new AbortController()
    const abandoned = peek('/api/v1/file?path=/hovered', RESOURCE_PRIORITY.thumbnail, { signal: thumbnail.signal })
    const title = peek('/api/v1/file?path=/song', RESOURCE_PRIORITY.duration)
    const selected = peek('/api/v1/file?path=/song', RESOURCE_PRIORITY.selected)
    expect(await selected).not.toBeNull()
    expect(await title).toBe(await selected)
    thumbnail.abort()
    expect(await abandoned).toBeNull()
    release(); await Promise.all(busy)
    expect(order).toEqual(['/api/v1/file?path=/busy-a', '/api/v1/file?path=/busy-b', '/api/v1/file?path=/song'])
  })

  it('frees a lane slot when an owner stalls after its headers, mid-body', async () => {
    vi.useFakeTimers()
    // Headers arrive at once; the body never finishes, and errors only when the request is aborted.
    const stalled = (init?: RequestInit): Response => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('<h1>')); init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason)) },
    }), { headers: { ETag: 'W/"sha256-s"' } })
    const fetcher = vi.fn(async (src: string, init?: RequestInit) => src.includes('stalled') ? stalled(init) : new Response(JSON.stringify({ exists: true, size: 1, modified_at: 1 })))
    vi.stubGlobal('fetch', fetcher)
    const reads = [text('/api/v1/file?path=/stalled-a.html', RESOURCE_PRIORITY.neighbour), bytes('/api/v1/file?path=/stalled-b.wav', RESOURCE_PRIORITY.neighbour, { maxBytes: 1e6 })]
    await vi.advanceTimersByTimeAsync(0)
    const waiting = head('/api/v1/file?path=/fine')
    await vi.advanceTimersByTimeAsync(RESOURCE_DEADLINE_MS - 1)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(await Promise.all(reads)).toEqual([null, null])
    expect(await waiting).toMatchObject({ exists: true })
  })

  it('frees a lane slot when an owner hangs past the deadline', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn((src: string, init?: RequestInit) => src.includes('hung')
      ? new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
      : Promise.resolve(new Response(JSON.stringify({ exists: true, size: 3, modified_at: 1 }))))
    vi.stubGlobal('fetch', fetcher)
    const hung = [head('/api/v1/file?path=/hung-a'), peek('/api/v1/file?path=/hung-b')]
    const waiting = head('/api/v1/file?path=/fine')
    await vi.advanceTimersByTimeAsync(RESOURCE_DEADLINE_MS - 1)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(await Promise.all(hung)).toEqual([null, null])
    expect(await waiting).toMatchObject({ exists: true, size: 3 })
  })
})

describe('shared reads', () => {
  it('reads one document once for the probe, a thumbnail and a hover asking together', async () => {
    const fetcher = vi.fn(async (_src: string, _init?: RequestInit) => body('<title>Report</title>'))
    vi.stubGlobal('fetch', fetcher)
    const src = '/api/v1/file?path=%2Fr.html'
    const peeks = await Promise.all([
      peek(src, RESOURCE_PRIORITY.title),
      peek(src, RESOURCE_PRIORITY.thumbnail),
      peek('/api/v1/file?path=%2F.%2Fr.html', RESOURCE_PRIORITY.thumbnail),
    ])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(header(fetcher.mock.calls[0][1], 'Range')).toBe('bytes=0-65535')
    expect(new Set(peeks).size).toBe(1)
    expect(new TextDecoder().decode(peeks[0]!.bytes)).toBe('<title>Report</title>')
    expect(peeks[0]!.etag).toBe('W/"sha256-a"')
    await peek(src)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('revalidates a settled peek by its ETag, so an unchanged document costs a 304', async () => {
    const fetcher = vi.fn(async (_src: string, init?: RequestInit) => header(init, 'If-None-Match') ? new Response(null, { status: 304 }) : body('ID3'))
    vi.stubGlobal('fetch', fetcher)
    const src = '/api/v1/file?path=%2Fa.mp3'
    const first = await peek(src)
    expect(await peek(src, RESOURCE_PRIORITY.title, { now: Date.now() + RESOURCE_FRESH_MS + 1 })).toBe(first)
    expect(header(fetcher.mock.calls[1][1], 'If-None-Match')).toBe('W/"sha256-a"')
    expect(await peek(src, RESOURCE_PRIORITY.title, { fresh: true })).toBe(first)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(await peek(src, RESOURCE_PRIORITY.duration, { stale: true, now: Date.now() + 10 * RESOURCE_FRESH_MS })).toBe(first)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('never lets a stat validator vouch for bytes: it re-reads the range and versions facts by content', async () => {
    let content = 'ID3-a'
    const fetcher = vi.fn(async (_src: string, init?: RequestInit) => header(init, 'If-None-Match')
      ? new Response(null, { status: 304 })
      : body(content, 'W/"stat-1790000000-5-42"'))
    vi.stubGlobal('fetch', fetcher)
    const src = '/api/v1/file?path=%2Ftake.wav'
    const first = (await peek(src))!
    content = 'ID3-b'
    const later = (await peek(src, RESOURCE_PRIORITY.title, { now: Date.now() + RESOURCE_FRESH_MS + 1 }))!
    expect(header(fetcher.mock.calls[1][1], 'If-None-Match')).toBeNull()
    expect(new TextDecoder().decode(later.bytes)).toBe('ID3-b')
    expect(peekVersion(later)).not.toBe(peekVersion(first))
    const digest = { bytes: new Uint8Array([1]), etag: 'W/"sha256-a"' }
    expect(peekVersion(digest)).toBe('W/"sha256-a"')
  })

  it('keeps a missing document as an answer while fresh, but not a failed read', async () => {
    const fetcher = vi.fn(async (src: string) => new Response('', { status: src.includes('missing') ? 404 : 503 }))
    vi.stubGlobal('fetch', fetcher)
    expect(await peek('/api/v1/file?path=/missing')).toBeNull()
    expect(await peek('/api/v1/file?path=/missing')).toBeNull()
    expect(await text('/api/v1/file?path=/missing')).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await peek('/api/v1/file?path=/missing', RESOURCE_PRIORITY.title, { now: Date.now() + RESOURCE_FRESH_MS + 1 })).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(await peek('/api/v1/file?path=/failing')).toBeNull()
    expect(await peek('/api/v1/file?path=/failing')).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('answers a peek and a thumbnail from the text a page read, and revalidates it once stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const fetcher = vi.fn(async (_src: string, init?: RequestInit) => header(init, 'If-None-Match') === 'W/"sha256-b"' ? new Response(null, { status: 304 }) : body('# Field note\n', 'W/"sha256-b"', 200))
    vi.stubGlobal('fetch', fetcher)
    const src = '/api/v1/file?path=%2Fbrief.md'
    const page = await fetchDocument(src, { cache: 'no-cache' })
    expect(await page.text()).toBe('# Field note\n')
    expect(recallText(src)).toEqual({ text: '# Field note\n', etag: 'W/"sha256-b"' })
    expect(new TextDecoder().decode((await peek(src))!.bytes)).toBe('# Field note\n')
    expect((await text(src))!.text).toBe('# Field note\n')
    expect(fetcher).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + RESOURCE_FRESH_MS + 1)
    expect((await text(src))!.text).toBe('# Field note\n')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(header(fetcher.mock.calls[1][1], 'If-None-Match')).toBe('W/"sha256-b"')
  })

  it('takes the text of a short document from the title peek that read all of it', async () => {
    const fetcher = vi.fn(async () => new Response(new TextEncoder().encode('# Short'), { status: 206, headers: { ETag: 'W/"sha256-d"', 'Content-Range': 'bytes 0-6/7' } }))
    vi.stubGlobal('fetch', fetcher)
    const src = '/api/v1/file?path=%2Fshort.md'
    const title = peek(src)
    expect(await text(src)).toEqual({ text: '# Short', etag: 'W/"sha256-d"' })
    await title
    expect(recallText(src)).toEqual({ text: '# Short', etag: 'W/"sha256-d"' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('moves a queued neighbour read up when its page is selected, reading it once', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const order: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (src: string) => { order.push(src); if (src.includes('busy')) await gate; return body(src, 'W/"sha256-n"', 200) }))
    const busy = [peek('/api/v1/file?path=/busy-a'), peek('/api/v1/file?path=/busy-b')]
    const src = '/api/v1/file?path=/next.html'
    const neighbour = fetchDocument(src, { cache: 'no-cache', rank: RESOURCE_PRIORITY.neighbour })
    const selected = await fetchDocument(src, { cache: 'no-store' })
    expect(await selected.text()).toBe(src)
    expect(order).toEqual(['/api/v1/file?path=/busy-a', '/api/v1/file?path=/busy-b', src])
    release(); await Promise.all([...busy, neighbour])
    expect(order.filter(url => url === src)).toHaveLength(1)
  })

  it('answers a selected page from a thumbnail read already in flight, 304 when its validator matches', async () => {
    let finish!: (response: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>(r => { finish = r }))
    vi.stubGlobal('fetch', fetcher)
    const src = '/api/v1/file?path=%2Freport.html'
    const thumbnail = text(src, RESOURCE_PRIORITY.thumbnail)
    await Promise.resolve(); await Promise.resolve()
    const page = fetchDocument(src, { cache: 'no-cache' })
    const poll = fetchDocument(src, { cache: 'no-store', headers: { 'If-None-Match': 'W/"sha256-r"' } })
    finish(body('<h1>Report</h1>', 'W/"sha256-r"', 200))
    const [answer, unchanged] = await Promise.all([page, poll])
    expect([answer.status, await answer.text(), answer.headers.get('ETag')]).toEqual([200, '<h1>Report</h1>', 'W/"sha256-r"'])
    expect(unchanged.status).toBe(304)
    expect((await thumbnail)!.text).toBe('<h1>Report</h1>')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not hold a body larger than the whole text budget, nor evict others for it', async () => {
    const huge = 'x'.repeat(RESOURCE_TEXT_BUDGET + 1)
    vi.stubGlobal('fetch', vi.fn(async (src: string) => new Response(src.includes('huge') ? huge : 'small', { headers: { ETag: 'W/"sha256-h"' } })))
    await (await fetchDocument('/api/v1/file?path=/small.md', { cache: 'no-cache' })).text()
    const response = await fetchDocument('/api/v1/file?path=/huge.html', { cache: 'no-cache' })
    expect((await response.text()).length).toBe(huge.length)
    expect(recallText('/api/v1/file?path=/huge.html')).toBeUndefined()
    expect(recallText('/api/v1/file?path=/small.md')?.text).toBe('small')
  })

  it('lifts the background deadline once the selected page joins or promotes a slow read', async () => {
    vi.useFakeTimers()
    const finishes: Array<() => void> = []
    // Headers at once; the body trickles until finished, and errors only if aborted.
    const fetcher = vi.fn(async (src: string, init?: RequestInit) => src.includes('busy')
      ? new Promise<Response>(() => {})
      : new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('<h1>Slow'))
          finishes.push(() => { controller.enqueue(new TextEncoder().encode('</h1>')); controller.close() })
          init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason))
        },
      }), { headers: { ETag: 'W/"sha256-slow"' } }))
    vi.stubGlobal('fetch', fetcher)
    // Started as a neighbour, then joined by its page.
    const started = '/api/v1/file?path=/started.html'
    const neighbour = fetchDocument(started, { cache: 'no-cache', rank: RESOURCE_PRIORITY.neighbour })
    await vi.advanceTimersByTimeAsync(0)
    const page = fetchDocument(started, { cache: 'no-store' })
    // Queued behind a full lane as a thumbnail, then promoted by its page.
    const busy = [peek('/api/v1/file?path=/busy-a'), peek('/api/v1/file?path=/busy-b')]
    const waiting = '/api/v1/file?path=/waiting.html'
    const thumbnail = text(waiting, RESOURCE_PRIORITY.thumbnail)
    await vi.advanceTimersByTimeAsync(0)
    const promoted = fetchDocument(waiting, { cache: 'no-store' })
    await vi.advanceTimersByTimeAsync(RESOURCE_DEADLINE_MS + 1000)
    finishes.forEach(finish => finish())
    expect(await (await page).text()).toBe('<h1>Slow</h1>')
    expect(await (await neighbour).text()).toBe('<h1>Slow</h1>')
    expect(await (await promoted).text()).toBe('<h1>Slow</h1>')
    expect((await thumbnail)!.text).toBe('<h1>Slow</h1>')
    expect(fetcher.mock.calls.filter(([src]) => !src.includes('busy'))).toHaveLength(2)
    void busy
  })

  it('keeps a joined read the shape each asker expects, even for a body too large to hold', async () => {
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { finish = r })))
    const huge = 'y'.repeat(RESOURCE_TEXT_BUDGET + 1)
    const src = '/api/v1/file?path=/huge.html'
    const page = fetchDocument(src, { cache: 'no-cache', rank: RESOURCE_PRIORITY.neighbour })
    await Promise.resolve()
    const thumbnail = text(src, RESOURCE_PRIORITY.thumbnail, { fresh: true })
    const joiner = fetchDocument(src, { cache: 'no-store' })
    finish(new Response(huge, { headers: { ETag: 'W/"sha256-y"' } }))
    const body = await thumbnail
    expect(typeof body?.text).toBe('string')
    expect(body!.text.length).toBe(huge.length)
    expect((await (await joiner).text()).length).toBe(huge.length)
    expect((await (await page).text()).length).toBe(huge.length)
  })

  it('lets a thumbnail join a page read already in flight', async () => {
    let finish!: (response: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>(r => { finish = r }))
    vi.stubGlobal('fetch', fetcher)
    const src = '/api/v1/file?path=%2Freport.html'
    const page = fetchDocument(src, { cache: 'no-cache' })
    const thumbnail = text(src)
    finish(body('<h1>Report</h1>', 'W/"sha256-c"', 200))
    await page
    expect((await thumbnail)!.text).toBe('<h1>Report</h1>')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('heads a document through the owner metadata route, with mtime and size as its validator', async () => {
    const fetcher = vi.fn(async (src: string) => new Response(JSON.stringify(src.includes('gone') ? { exists: false } : { exists: true, size: 12, modified_at: 1_700_000_000 })))
    vi.stubGlobal('fetch', fetcher)
    expect(await head('/api/v1/file?path=%2Fa.pdf&origin=candide')).toEqual({ exists: true, size: 12, modifiedAt: '2023-11-14T22:13:20.000Z', validator: '2023-11-14T22:13:20.000Z|12' })
    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/file-info?path=%2Fa.pdf&origin=candide')
    expect(await head('/api/v1/file?path=%2Fgone.pdf')).toEqual({ exists: false })
    await head('/api/v1/file?path=%2Fa.pdf&origin=candide')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('derived facts', () => {
  it('computes a fact once per validator and again when the document moves', async () => {
    const compute = vi.fn(async () => 42)
    const src = '/api/v1/file?path=%2Ft.wav'
    expect(await Promise.all([fact(src, 'duration', 'v1', compute), fact(src, 'duration', 'v1', compute)])).toEqual([42, 42])
    expect(compute).toHaveBeenCalledTimes(1)
    await fact(src, 'duration', 'v2', compute)
    expect(compute).toHaveBeenCalledTimes(2)
  })

  it('does not keep a fact that could not be computed', async () => {
    const compute = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(3)
    const src = '/api/v1/file?path=%2Ft.ogg'
    expect(await fact(src, 'duration', 'v1', compute)).toBeNull()
    expect(await fact(src, 'duration', 'v1', compute)).toBe(3)
  })
})
