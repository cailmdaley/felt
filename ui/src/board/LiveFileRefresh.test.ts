import { afterEach, describe, expect, it, vi } from 'vitest'

import { LIVE_FILE_POLL_INTERVAL_MS, LiveFileRefresh } from './LiveFileRefresh.js'
import { peek, resetDocumentResources } from './documentResources.js'
import { resetLanes } from './requestLanes.js'

function response(status: number, body = '', headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    text: vi.fn(async () => body),
  } as unknown as Response
}

function harness(fetchFile: typeof fetch) {
  let now = 0
  let visible = true
  let visibilityListener: (() => void) | null = null
  const schedule = vi.fn((callback: () => void) => {
    return callback as unknown as ReturnType<typeof globalThis.setInterval>
  })
  const cancel = vi.fn()
  const poller = new LiveFileRefresh({
    fetch: fetchFile,
    now: () => now,
    isVisible: () => visible,
    setInterval: schedule as unknown as typeof globalThis.setInterval,
    clearInterval: cancel as unknown as typeof globalThis.clearInterval,
    onVisibilityChange: (listener) => {
      visibilityListener = listener
      return () => { visibilityListener = null }
    },
  })
  return {
    poller,
    setNow: (value: number) => { now = value },
    setVisible: (value: boolean) => { visible = value },
    visibilityChanged: () => visibilityListener?.(),
    schedule,
    cancel,
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
}

afterEach(() => vi.restoreAllMocks())

describe('LiveFileRefresh', () => {
  it.each([304, 200])('signals recovery after an error and unchanged %s without redelivering bytes', async (status) => {
    const etag = 'W/"sha256-' + 'a'.repeat(64) + '"'
    const fetchFile = vi.fn().mockResolvedValueOnce(response(200, 'same', { etag }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(response(status, status === 200 ? 'same' : '', { etag }))
    const h = harness(fetchFile as typeof fetch)
    const content = vi.fn(), error = vi.fn(), recover = vi.fn()
    const stop = h.poller.watch('/same', content, error, { onRecover: recover })
    await settle()
    expect(recover).not.toHaveBeenCalled()
    h.setNow(LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(error).toHaveBeenCalledOnce()
    h.setNow(3 * LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(recover).toHaveBeenCalledOnce()
    expect(content).toHaveBeenCalledOnce()
    expect(fetchFile).toHaveBeenNthCalledWith(3, '/same', expect.objectContaining({ headers: { 'If-None-Match': etag } }))
    h.setNow(4 * LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(recover).toHaveBeenCalledOnce()
    stop()
  })

  it('loads an inactive preview once, even while slow, without joining periodic polling', async () => {
    let finish!: (value: Response) => void
    const fetchFile = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve }))
    const h = harness(fetchFile as typeof fetch)
    const content = vi.fn()
    const stop = h.poller.watch('/preview', content, vi.fn(), { active: false, loadOnce: true })
    expect(fetchFile).toHaveBeenCalledOnce()
    h.setNow(4 * LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(fetchFile).toHaveBeenCalledOnce()
    finish(response(200, 'preview'))
    await settle()
    expect(content).toHaveBeenCalledWith('preview')
    h.setNow(8 * LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(fetchFile).toHaveBeenCalledOnce()
    stop()
  })

  it('never retries an unreachable inactive preview on the periodic clock', async () => {
    const fetchFile = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(response(200, 'online'))
    const h = harness(fetchFile as typeof fetch)
    const content = vi.fn(), error = vi.fn()
    const stop = h.poller.watch('/preview', content, error, { active: false, loadOnce: true })
    await settle()
    expect(error).toHaveBeenCalledOnce()
    h.setNow(100 * LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(fetchFile).toHaveBeenCalledOnce()
    await stop.loadOnce()
    expect(content).toHaveBeenCalledWith('online')
    await h.poller.pollNow()
    expect(fetchFile).toHaveBeenCalledTimes(2)
    await stop.resume()
    expect(fetchFile).toHaveBeenCalledTimes(3)
    h.setNow(101 * LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(fetchFile).toHaveBeenCalledTimes(4)
    stop()
  })

  it('shares an in-flight read with an inactive preview and does not render later updates into it', async () => {
    let finish!: (value: Response) => void
    const fetchFile = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve })).mockResolvedValue(response(200, 'next'))
    const h = harness(fetchFile as typeof fetch)
    const active = vi.fn(), preview = vi.fn()
    const stopActive = h.poller.watch('/same', active)
    const stopPreview = h.poller.watch('/same', preview, vi.fn(), { active: false, loadOnce: true })
    expect(fetchFile).toHaveBeenCalledOnce()
    finish(response(200, 'first'))
    await settle()
    expect(preview).toHaveBeenCalledWith('first')
    expect(fetchFile).toHaveBeenCalledOnce()
    h.setNow(LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(active).toHaveBeenLastCalledWith('next')
    expect(preview).toHaveBeenCalledOnce()
    stopActive(); stopPreview()
  })

  it('cancels a parked preview and can retry its initial read without activating it', async () => {
    const fetchFile = vi.fn().mockImplementationOnce((_url, opts) => new Promise<Response>((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })).mockResolvedValue(response(200, 'preview'))
    const h = harness(fetchFile as typeof fetch)
    const content = vi.fn(), error = vi.fn()
    const stop = h.poller.watch('/preview', content, error, { active: false, loadOnce: true })
    stop.suspend()
    await stop.loadOnce()
    expect(fetchFile).toHaveBeenCalledTimes(2)
    expect(error).not.toHaveBeenCalled()
    expect(content).toHaveBeenCalledWith('preview')
    h.setNow(10 * LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(fetchFile).toHaveBeenCalledTimes(2)
    stop()
  })

  it('polls immediately and pauses while the page is hidden', async () => {
    const fetchFile = vi.fn(async () => response(200, 'first')) as unknown as typeof fetch
    const h = harness(fetchFile)
    const stop = h.poller.watch('/api/v1/file?path=%2Freport.html', vi.fn())
    await settle()
    expect(fetchFile).toHaveBeenCalledTimes(1)
    expect(h.schedule).toHaveBeenCalledWith(expect.any(Function), LIVE_FILE_POLL_INTERVAL_MS)

    h.setNow(LIVE_FILE_POLL_INTERVAL_MS)
    h.setVisible(false)
    await h.poller.pollNow()
    expect(fetchFile).toHaveBeenCalledTimes(1)

    h.setVisible(true)
    h.visibilityChanged()
    await settle()
    expect(fetchFile).toHaveBeenCalledTimes(2)
    stop()
    expect(h.cancel).toHaveBeenCalledTimes(1)
  })

  it('revalidates the browser copy on the first read, then uses ETag and does not render a 304 again', async () => {
    const unchanged = response(304, '', { etag: 'W/"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' })
    const fetchFile = vi.fn()
      .mockResolvedValueOnce(response(200, 'report', { etag: 'W/"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' }))
      .mockResolvedValueOnce(unchanged) as unknown as typeof fetch
    const h = harness(fetchFile)
    const onContent = vi.fn()
    const stop = h.poller.watch('/file?path=%2Freport.html', onContent)
    await settle()
    h.setNow(LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()

    expect(fetchFile).toHaveBeenNthCalledWith(1, '/file?path=%2Freport.html', expect.objectContaining({ cache: 'no-cache', headers: {} }))
    expect(fetchFile).toHaveBeenNthCalledWith(2, '/file?path=%2Freport.html', expect.objectContaining({
      cache: 'no-store',
      headers: { 'If-None-Match': 'W/"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' },
    }))
    expect(unchanged.text).not.toHaveBeenCalled()
    expect(onContent).toHaveBeenCalledTimes(1)
    stop()
  })

  it('shares a URL and polls unconditionally, comparing bodies, when the owner offers no digest ETag', async () => {
    const lastModified = 'Tue, 01 Jan 2030 00:00:00 GMT'
    const legacyEtag = '"1735689600-6"'
    const fetchFile = vi.fn()
      .mockResolvedValueOnce(response(200, 'report', { 'last-modified': lastModified, etag: legacyEtag }))
      .mockResolvedValueOnce(response(200, 'report', { 'last-modified': lastModified, etag: legacyEtag }))
      .mockResolvedValueOnce(response(200, 'rewrite', { 'last-modified': lastModified, etag: legacyEtag })) as unknown as typeof fetch
    const h = harness(fetchFile)
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = h.poller.watch('/file?path=%2Freport.txt', first)
    const stopSecond = h.poller.watch('/file?path=%2Freport.txt', second)
    await settle()

    expect(fetchFile).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledWith('report')
    expect(second).toHaveBeenCalledWith('report')

    h.setNow(LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(fetchFile).toHaveBeenNthCalledWith(2, '/file?path=%2Freport.txt', expect.objectContaining({ headers: {} }))
    expect(first).toHaveBeenCalledTimes(1)

    h.setNow(2 * LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(first).toHaveBeenLastCalledWith('rewrite')
    expect(second).toHaveBeenLastCalledWith('rewrite')
    stopFirst()
    stopSecond()
  })

  it('hash-compares 200 responses from older daemons and renders only changed content', async () => {
    const fetchFile = vi.fn()
      .mockResolvedValueOnce(response(200, 'same body'))
      .mockResolvedValueOnce(response(200, 'same body'))
      .mockResolvedValueOnce(response(200, 'new body')) as unknown as typeof fetch
    const h = harness(fetchFile)
    const onContent = vi.fn()
    const stop = h.poller.watch('/file?path=%2Freport.md', onContent)
    await settle()
    expect(onContent).toHaveBeenCalledTimes(1)
    expect(onContent).toHaveBeenCalledWith('same body')

    h.setNow(LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(onContent).toHaveBeenCalledTimes(1)

    h.setNow(2 * LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(onContent).toHaveBeenNthCalledWith(2, 'new body')
    stop()
  })

  it('honors a forced refresh during an in-flight conditional GET', async () => {
    let finishConditional!: (value: Response) => void
    const fetchFile = vi.fn()
      .mockResolvedValueOnce(response(200, 'old', { etag: 'W/"sha256-0000000000000000000000000000000000000000000000000000000000000000"' }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        finishConditional = resolve
      }))
      .mockResolvedValueOnce(response(200, 'new', { etag: 'W/"sha256-1111111111111111111111111111111111111111111111111111111111111111"' }))
    const h = harness(fetchFile as typeof fetch)
    const onContent = vi.fn()
    const stop = h.poller.watch('/file', onContent)
    await settle()

    h.setNow(LIVE_FILE_POLL_INTERVAL_MS)
    const conditional = h.poller.pollNow()
    const forced = h.poller.refresh('/file')
    finishConditional(response(304))
    await Promise.all([conditional, forced])

    expect(fetchFile).toHaveBeenCalledTimes(3)
    expect(onContent).toHaveBeenLastCalledWith('new')
    stop()
  })

  it('backs off after errors and resumes after the retry delay', async () => {
    const fetchFile = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response(200, 'back online')) as unknown as typeof fetch
    const h = harness(fetchFile)
    const onContent = vi.fn()
    const onError = vi.fn()
    const stop = h.poller.watch('/file?path=%2Freport.txt', onContent, onError)
    await settle()
    expect(onError).toHaveBeenCalledTimes(1)

    h.setNow(LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(fetchFile).toHaveBeenCalledTimes(1)
    h.setNow(2 * LIVE_FILE_POLL_INTERVAL_MS - 1)
    await h.poller.pollNow()
    expect(fetchFile).toHaveBeenCalledTimes(1)

    h.setNow(2 * LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(fetchFile).toHaveBeenCalledTimes(2)
    expect(onContent).toHaveBeenCalledTimes(1)
    expect(onContent).toHaveBeenCalledWith('back online')
    stop()
  })
})

describe('LiveFileRefresh over the document cache', () => {
  afterEach(() => { resetDocumentResources(); resetLanes(); vi.unstubAllGlobals() })

  it('moves a preview read still waiting in the queue up when its page is selected', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const order: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (src: string) => {
      order.push(src)
      if (src.includes('busy')) await gate
      return new Response(src, { headers: { ETag: 'W/"sha256-' + 'b'.repeat(64) + '"' } })
    }))
    const busy = [peek('/api/v1/file?path=/busy-a'), peek('/api/v1/file?path=/busy-b')]
    const poller = new LiveFileRefresh({ setInterval: (() => 0) as unknown as typeof globalThis.setInterval, clearInterval: () => {}, onVisibilityChange: () => () => {} })
    const content = vi.fn()
    const src = '/api/v1/file?path=/next.html'
    const stop = poller.watch(src, content, vi.fn(), { active: false, loadOnce: true })
    await stop.resume()
    expect(content).toHaveBeenCalledWith(src)
    expect(order).toEqual(['/api/v1/file?path=/busy-a', '/api/v1/file?path=/busy-b', src])
    release(); await Promise.all(busy)
    stop()
  })
})
