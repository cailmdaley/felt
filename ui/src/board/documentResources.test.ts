import { afterEach, describe, expect, it, vi } from 'vitest'
import { PEEK_PRIORITY, peekDocument, resetDocumentResources } from './documentResources.js'
import { resetLanes } from './requestLanes.js'

const body = (text: string, etag = 'W/"sha256-a"') => new Response(new TextEncoder().encode(text), { status: 206, headers: { ETag: etag } })
afterEach(() => { resetDocumentResources(); resetLanes(); vi.unstubAllGlobals() })

describe('shared document peeks', () => {
  it('reads one document once for the probe, a thumbnail and a hover asking together', async () => {
    const fetcher = vi.fn(async () => body('<title>Report</title>'))
    vi.stubGlobal('fetch', fetcher)
    const peeks = await Promise.all([
      peekDocument('/file?path=/r.html', PEEK_PRIORITY.title),
      peekDocument('/file?path=/r.html', PEEK_PRIORITY.thumbnail),
      peekDocument('/file?path=/r.html', PEEK_PRIORITY.thumbnail),
    ])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith('/file?path=/r.html', expect.objectContaining({ headers: { Range: 'bytes=0-65535' } }))
    expect(new Set(peeks).size).toBe(1)
    expect(new TextDecoder().decode(peeks[0]!.bytes)).toBe('<title>Report</title>')
    expect(peeks[0]!.etag).toBe('W/"sha256-a"')
    // A later render reuses the settled peek; a moved document reads fresh.
    await peekDocument('/file?path=/r.html')
    expect(fetcher).toHaveBeenCalledTimes(1)
    await peekDocument('/file?path=/r.html', PEEK_PRIORITY.title, { fresh: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher).toHaveBeenLastCalledWith('/file?path=/r.html', expect.objectContaining({ cache: 'no-cache' }))
    expect(await peekDocument('/file?path=/r.html', PEEK_PRIORITY.title, { now: Date.now() + 31_000 })).not.toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('serves the selected page before titles and thumbnails, and does not keep a failed read', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    vi.stubGlobal('fetch', vi.fn(async (src: string) => {
      order.push(src)
      if (src === '/busy-a' || src === '/busy-b') await gate
      return src === '/missing' ? new Response('', { status: 404 }) : body(src)
    }))
    // Two quiet slots over HTTP/1.1: fill them, then queue in the wrong order.
    const busy = [peekDocument('/busy-a'), peekDocument('/busy-b')]
    const queued = [peekDocument('/thumb', PEEK_PRIORITY.thumbnail), peekDocument('/title', PEEK_PRIORITY.title), peekDocument('/page', PEEK_PRIORITY.selected)]
    release()
    await Promise.all([...busy, ...queued])
    expect(order.slice(2)).toEqual(['/page', '/title', '/thumb'])
    expect(await peekDocument('/missing')).toBeNull()
    await peekDocument('/missing')
    expect(order.filter(src => src === '/missing')).toHaveLength(2)
  })
})
